// Entry point for the Instatic manager service.
//
// The manager router strips the /addons/ prefix before dispatching here.

import type { Server } from "bun";
import { instaticService, validateDomain, validateTag, validateJobId } from "./service";
import { layout, dashboardView, newInstanceView, jobView } from "./views";
import { guardMutation, newCsrfToken, csrfCookieHeader, SECURITY_HEADERS } from "../../../lib/app-http";
import { listAvailableTags } from "./tags";
import type { SanitizedSite } from "../../../lib/snapshot-reader";

function html(body: string, csrf: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Set-Cookie": csrfCookieHeader(csrf),
      ...SECURITY_HEADERS,
    },
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...SECURITY_HEADERS },
  });
}

function sse(body: ReadableStream, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      ...SECURITY_HEADERS,
    },
  });
}

const MUTATING_VERBS = new Set(["start", "stop", "restart", "recreate", "delete", "snapshot", "update"]);

// The whole request surface, exported so the one manager process can mount it.
//
// `path` is this addon's own path, with the mount prefix already stripped by the
// router: a request for /addons/instatic/api/... arrives here as /api/... .
// Taking it as an argument rather than reading req.url is what keeps every route
// below written as though this addon owned the site, which it used to.
export async function handle(
  req: Request,
  path: string,
  updateNotice?: { current: string; latest: string } | null,
  server?: Server<unknown> | null,
): Promise<Response> {
  const method = req.method;

  // Liveness probe for systemd. No auth implications: it reports nothing about
  // instances.
  if (path === "/health") {
    return json({ ok: true, service: "instatic-manager" });
  }

  if (method === "GET" && (path === "/" || path === "/new")) {
    const csrf = newCsrfToken();
    try {
      if (path === "/") {
        const instances = await instaticService.listInstances();
        let panelSites: SanitizedSite[] = [];
        let snapshotAge = Infinity;
        let snapshotTakenAt = "";
        try {
          const { snap, ageSeconds } = instaticService.snapshot();
          panelSites = snap.sites;
          snapshotAge = ageSeconds;
          snapshotTakenAt = snap.updatedAt;
        } catch {
          // Snapshot missing or unreadable; the action binary already supplied live
          // instance data above
        }
        // The dashboard needs the registry listing too, not just /new. Without
        // it the page showed each instance's pinned tag with nothing to compare
        // it against, so a new Instatic release was invisible here and the
        // update dialog asked the operator to type a version from memory.
        const available = await listAvailableTags();
        return html(
          layout("Instatic instances",
            dashboardView(instances, await instaticService.nextPort(), snapshotAge, panelSites, available, snapshotTakenAt),
            updateNotice
          ),
          csrf
        );
      }
      const available = await listAvailableTags();
      return html(layout("New Instatic site", newInstanceView(await instaticService.nextPort(), available), updateNotice), csrf);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return html(layout("Error", `<div class="alert">${Bun.escapeHTML(msg)}</div>`, updateNotice), csrf, 500);
    }
  }

  const jobPage = path.match(/^\/jobs\/([^/]+)$/);
  if (method === "GET" && jobPage) {
    const id = validateJobId(decodeURIComponent(jobPage[1]!));
    if (!id) return new Response("Not found", { status: 404 });
    const res = await instaticService.getJob(id);
    if (!res.ok || !res.data) return new Response("Job not found", { status: 404 });
    const csrf = newCsrfToken();
    return html(layout(`Creating ${res.data.job.domain}`, jobView(res.data.job, res.data.log), updateNotice), csrf);
  }

  if (path === "/api/instances" && method === "GET") {
    return json({ ok: true, instances: await instaticService.listInstances() });
  }

  if (path === "/api/instances" && method === "POST") {
    const blocked = guardMutation(req);
    if (blocked) return blocked;

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ ok: false, error: "body must be JSON" }, 400);
    }
    const { domain: rawDomain, tag: rawTag, tls } = (body ?? {}) as Record<string, unknown>;
    const domain = validateDomain(rawDomain);
    const tag = validateTag(rawTag);
    if (!domain) return json({ ok: false, error: "domain is not a valid hostname" }, 400);
    if (!tag) return json({ ok: false, error: "tag must be an exact version such as 0.0.18" }, 400);

    const res = await instaticService.createInstance(domain, tag, tls === true, true);
    return json(res, res.ok ? 202 : 400);
  }

  if (path === "/api/jobs" && method === "GET") {
    return json({ ok: true, jobs: await instaticService.listJobs() });
  }

  const jobEvents = path.match(/^\/api\/jobs\/([^/]+)\/events$/);
  const jobApi = path.match(/^\/api\/jobs\/([^/]+)$/);
  if (method === "GET" && (jobEvents || (jobApi && req.headers.get("accept")?.includes("text/event-stream")))) {
    const rawId = (jobEvents ?? jobApi)![1]!;
    const id = validateJobId(decodeURIComponent(rawId));
    if (!id) return json({ ok: false, error: "not a valid job id" }, 400);

    const initial = await instaticService.getJob(id);
    if (!initial.ok || !initial.data) {
      return json({ ok: false, error: initial.error ?? "job not found" }, 404);
    }

    if (server && typeof server.timeout === "function") {
      try {
        server.timeout(req, 0);
      } catch {}
    }

    let timer: ReturnType<typeof setInterval> | null = null;
    let closed = false;
    let inFlight = false;

    let lastState = initial.data.job.state;
    let lastStep = initial.data.job.step;
    let lastLog = initial.data.log;

    const stream = new ReadableStream({
      start(controller) {
        try {
          controller.enqueue(`data: ${JSON.stringify({ job: initial.data!.job, log: initial.data!.log })}\n\n`);
        } catch {
          closed = true;
          return;
        }

        if (initial.data!.job.state === "done" || initial.data!.job.state === "failed") {
          closed = true;
          try { controller.close(); } catch {}
          return;
        }

        timer = setInterval(async () => {
          if (closed || inFlight) return;
          inFlight = true;
          try {
            const res = await instaticService.getJob(id);
            if (closed) return;
            if (!res.ok || !res.data) {
              closed = true;
              if (timer) clearInterval(timer);
              try {
                controller.enqueue(`event: error\ndata: ${JSON.stringify({ error: res.error ?? "job not found" })}\n\n`);
                controller.close();
              } catch {}
              return;
            }

            const { job, log } = res.data;
            if (job.state !== lastState || job.step !== lastStep || log !== lastLog) {
              lastState = job.state;
              lastStep = job.step;
              lastLog = log;
              try {
                controller.enqueue(`data: ${JSON.stringify({ job, log })}\n\n`);
              } catch {
                closed = true;
                if (timer) clearInterval(timer);
                return;
              }
            } else {
              try {
                controller.enqueue(": keepalive\n\n");
              } catch {
                closed = true;
                if (timer) clearInterval(timer);
                return;
              }
            }

            if (job.state === "done" || job.state === "failed") {
              closed = true;
              if (timer) clearInterval(timer);
              try {
                controller.close();
              } catch {}
            }
          } catch {
            // Transient read error
          } finally {
            inFlight = false;
          }
        }, 1000);
      },
      cancel() {
        closed = true;
        if (timer) clearInterval(timer);
      },
    });

    return sse(stream);
  }

  if (method === "GET" && jobApi) {
    const id = validateJobId(decodeURIComponent(jobApi[1]!));
    if (!id) return json({ ok: false, error: "not a valid job id" }, 400);
    const res = await instaticService.getJob(id);
    if (!res.ok) return json(res, 404);
    return json(res);
  }

  const m = path.match(/^\/api\/instances\/([^/]+)\/([a-z-]+)$/);
  if (m) {
    const domain = validateDomain(decodeURIComponent(m[1]!));
    const verb = m[2]!;
    if (!domain) return json({ ok: false, error: "domain is not a valid hostname" }, 400);

    if (verb === "logs" && method === "GET") {
      const res = await instaticService.getLogs(domain);
      return json(res, res.ok ? 200 : 400);
    }

    if (verb === "creation-log" && method === "GET") {
      const res = await instaticService.getInstanceCreationLog(domain);
      return json(res, res.ok ? 200 : 400);
    }

    if (MUTATING_VERBS.has(verb) && method === "POST") {
      const blocked = guardMutation(req);
      if (blocked) return blocked;

      switch (verb) {
        case "start":
        case "stop":
        case "restart":
        case "recreate": {
          const res = await instaticService.lifecycle(domain, verb);
          return json(res, res.ok ? 200 : 400);
        }
        case "snapshot": {
          const res = await instaticService.snapshotInstance(domain);
          return json(res, res.ok ? 200 : 400);
        }
        case "delete": {
          const res = await instaticService.deleteInstance(domain);
          return json(res, res.ok ? 200 : 400);
        }
        case "update": {
          let tag: string | null = null;
          try {
            tag = validateTag(((await req.json()) as Record<string, unknown>)?.tag);
          } catch {
            // fall through to the 400 below
          }
          if (!tag) return json({ ok: false, error: "tag must be an exact version such as 0.0.18" }, 400);
          const res = await instaticService.updateInstance(domain, tag);
          return json(res, res.ok ? 200 : 400);
        }
      }
    }

    return json({ ok: false, error: `unsupported ${method} on ${verb}` }, 405);
  }

  return json({ ok: false, error: "not found" }, 404);
}

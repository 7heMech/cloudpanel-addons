// Entry point for the Instatic manager service.
//
// Served at the root of its own CloudPanel reverse-proxy site (decision 2.4),
// not under a path prefix on the panel's vhost. Bound to 127.0.0.1 so the only
// route in is that site's nginx vhost, which carries the per-site security.

import { instaticService, validateDomain, validateTag } from "./service";
import { layout, dashboardView, newInstanceView } from "./views";
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

const MUTATING_VERBS = new Set(["start", "stop", "restart", "recreate", "delete", "snapshot", "update"]);

// The whole request surface, exported so the one manager process can mount it.
//
// `path` is this addon's own path, with the mount prefix already stripped by the
// router: a request for /instatic/api/... arrives here as /api/... .
// Taking it as an argument rather than reading req.url is what keeps every route
// below written as though this addon owned the site, which it used to.
export async function handle(req: Request, path: string): Promise<Response> {
  const method = req.method;

  // Liveness probe for systemd and the wrapper's health check. No auth
  // implications: it reports nothing about instances.
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
          // Snapshot missing or unreadable; fallback to wrapper live data
        }
        // The dashboard needs the registry listing too, not just /new. Without
        // it the page showed each instance's pinned tag with nothing to compare
        // it against, so a new Instatic release was invisible here and the
        // update dialog asked the operator to type a version from memory.
        const available = await listAvailableTags();
        return html(
          layout("Instatic instances",
            dashboardView(instances, await instaticService.nextPort(), snapshotAge, panelSites, available, snapshotTakenAt)),
          csrf
        );
      }
      const available = await listAvailableTags();
      return html(layout("New Instatic site", newInstanceView(await instaticService.nextPort(), available)), csrf);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return html(layout("Error", `<div class="alert">${msg.replace(/[<>&]/g, "")}</div>`), csrf, 500);
    }
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

    const res = await instaticService.createInstance(domain, tag, tls === true);
    return json(res, res.ok ? 200 : 400);
  }

  const m = path.match(/^\/api\/instances\/([^/]+)\/([a-z]+)$/);
  if (m) {
    const domain = validateDomain(decodeURIComponent(m[1]!));
    const verb = m[2]! ;
    if (!domain) return json({ ok: false, error: "domain is not a valid hostname" }, 400);

    if (verb === "logs" && method === "GET") {
      const res = await instaticService.getLogs(domain);
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

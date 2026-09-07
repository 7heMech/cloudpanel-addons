// Entry point for the Stager manager service.
//
// Served at the root of its own CloudPanel reverse-proxy site (decision 2.4),
// not under a path prefix on the panel's vhost. Bound to 127.0.0.1 so the only
// route in is that site's nginx vhost, which carries the per-site security.

import { stagerService, validateDomain, validateJobId, expandTarget } from "./service";
import { layout, jobsView, newCloneView, jobView } from "./views";
import { guardMutation, newCsrfToken, csrfCookieHeader, SECURITY_HEADERS } from "../../../lib/app-http";

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

// The whole request surface, exported so the one manager process can mount it.
//
// `path` is this addon's own path, with the mount prefix already stripped by the
// router: a request for /stager/api/... arrives here as /api/... .
// Taking it as an argument rather than reading req.url is what keeps every route
// below written as though this addon owned the site, which it used to.
export async function handle(req: Request, path: string): Promise<Response> {
  const url = new URL(req.url);
  const method = req.method;

  // Liveness probe for systemd. No auth implications: it reports nothing
  // about any site.
  if (path === "/health") {
    return json({ ok: true, service: "stager-manager" });
  }

  if (method === "GET" && path === "/") {
    const csrf = newCsrfToken();
    try {
      return html(layout("Staging clones", jobsView(await stagerService.listJobs())), csrf);
    } catch (err) {
      return html(layout("Error", errorBlock(err)), csrf, 500);
    }
  }

  // The button injected into every CloudPanel site page lands here with the
  // site it was rendered on. Nothing is trusted about it: it is validated,
  // and then the wrapper looks it up in the panel's own site table.
  if (method === "GET" && path === "/new") {
    const csrf = newCsrfToken();
    try {
      const raw = url.searchParams.get("source");
      if (!raw) {
        return html(layout("New staging site", newCloneView(null, await stagerService.listSites())), csrf);
      }
      const source = validateDomain(raw.toLowerCase());
      if (!source) {
        return html(
          layout("New staging site",
            newCloneView(null, await stagerService.listSites(), "That is not a valid hostname.")),
          csrf, 400
        );
      }
      const detail = await stagerService.describe(source);
      if (!detail.ok || !detail.data) {
        return html(
          layout("New staging site",
            newCloneView(null, await stagerService.listSites(), detail.error ?? `Cannot clone ${source}.`)),
          csrf, 400
        );
      }
      return html(layout(`Clone ${source}`, newCloneView(detail.data, [])), csrf);
    } catch (err) {
      return html(layout("Error", errorBlock(err)), csrf, 500);
    }
  }

  const jobPage = path.match(/^\/jobs\/([^/]+)$/);
  if (method === "GET" && jobPage) {
    const csrf = newCsrfToken();
    const id = validateJobId(decodeURIComponent(jobPage[1]!));
    if (!id) return html(layout("Not found", `<div class="alert">No such job.</div>`), csrf, 404);
    const res = await stagerService.getJob(id);
    if (!res.ok || !res.data) {
      return html(layout("Not found", `<div class="alert">${escapeMinimal(res.error ?? "No such job.")}</div>`), csrf, 404);
    }
    return html(layout(`Clone into ${res.data.job.target}`, jobView(res.data.job, res.data.log)), csrf);
  }

  if (method === "GET" && path === "/api/sites") {
    return json({ ok: true, sites: await stagerService.listSites() });
  }

  const jobApi = path.match(/^\/api\/jobs\/([^/]+)$/);
  if (method === "GET" && jobApi) {
    const id = validateJobId(decodeURIComponent(jobApi[1]!));
    if (!id) return json({ ok: false, error: "not a valid job id" }, 400);
    const res = await stagerService.getJob(id);
    return json(res, res.ok ? 200 : 404);
  }

  if (method === "POST" && path === "/api/clones") {
    const blocked = guardMutation(req);
    if (blocked) return blocked;

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ ok: false, error: "body must be JSON" }, 400);
    }
    const { source: rawSource, target: rawTarget, tls } = (body ?? {}) as Record<string, unknown>;

    const source = validateDomain(typeof rawSource === "string" ? rawSource.toLowerCase() : null);
    if (!source) return json({ ok: false, error: "source is not a valid hostname" }, 400);

    // The shorthand is expanded here so the wrapper only ever sees a complete
    // hostname; it must reject rather than rewrite.
    const target = validateDomain(expandTarget(typeof rawTarget === "string" ? rawTarget : "", source));
    if (!target) return json({ ok: false, error: "target is not a valid hostname" }, 400);
    if (target === source) return json({ ok: false, error: "the target is the site being cloned" }, 400);

    const res = await stagerService.startClone(source, target, tls === true);
    return json(res, res.ok ? 200 : 400);
  }

  return json({ ok: false, error: "not found" }, 404);
}

function escapeMinimal(s: string): string {
  return s.replace(/[<>&]/g, "");
}

function errorBlock(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return `<div class="alert">${escapeMinimal(msg)}</div>`;
}

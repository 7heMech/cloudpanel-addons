import { signInWindow } from "./sign-in-window";
import {
  bodyErrorResponse, clientIp, guardMutation, htmlResponse, jsonResponse, readJsonObject, newCsrfToken, safeDecodePathSegment,
} from "../../../lib/app-http";
import { jobApiRoute } from "../../../lib/job-stream";
import { validateDomain, wpToolsService } from "./service";
import { dashboardBody, dashboardView, layout } from "./views";

function json(body: unknown, status = 200): Response {
  return jsonResponse(body, { status });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function handle(
  req: Request,
  path: string,
  updateNotice?: { current: string; latest: string } | null,
  _server?: unknown,
  auth?: { user: string; roles: string[] } | null,
): Promise<Response> {
  const method = req.method;

  if (method === "GET" && path === "/health") return json({ ok: true, service: "wp-tools-manager" });

  // The link injected into CloudPanel's Sites page is on a page this addon did
  // not render, so the browser may have no CSRF cookie yet and a non-adminis-
  // trator can never get one from an addon page. This hands out that pair and
  // nothing else: no state is read, and the token is only useful to a request
  // that can also send the session cookie from this origin.
  if (method === "GET" && path === "/api/session") {
    const csrf = newCsrfToken();
    return jsonResponse({ ok: true }, { csrf });
  }

  const windowPage = /^\/sign-in\/([^/]+)$/.exec(path);
  if (method === "GET" && windowPage) {
    const domain = validateDomain(safeDecodePathSegment(windowPage[1]!));
    if (!domain) return json({ ok: false, error: "that is not a valid hostname" }, 400);
    return signInWindow(domain);
  }

  // The site pages' Domain box asks this, for every role that can open a site:
  // CloudPanel gives those pages no application to decide by. Held, as the
  // sign-in is, to the sites the caller's account has.
  if (method === "GET" && path === "/api/site-kind") {
    const domain = validateDomain(new URL(req.url).searchParams.get("domain"));
    if (!domain) return json({ ok: false, error: "that is not a valid hostname" }, 400);
    const admin = auth?.roles.includes("ROLE_ADMIN") ?? false;
    if (!admin && !auth?.user) return json({ ok: false, error: "not found" }, 404);
    const result = await wpToolsService.siteKind(domain, admin ? undefined : auth!.user);
    return json(result, result.ok ? 200 : 400);
  }

  if (method === "GET" && path === "/") {
    const csrf = newCsrfToken();
    try {
      const result = await wpToolsService.sites();
      if (!result.ok || !result.data) throw new Error(result.error ?? "the WordPress site list is unavailable");
      return htmlResponse(layout("WordPress Tools", dashboardView(result.data), updateNotice), { csrf });
    } catch (error) {
      return htmlResponse(
        layout("WordPress Tools", `<div class="alert" role="alert">${Bun.escapeHTML(errorMessage(error))}</div>`, updateNotice),
        { status: 500, csrf },
      );
    }
  }

  if (method === "GET" && path === "/api/dashboard") {
    if (!auth?.roles.includes("ROLE_ADMIN")) return json({ ok: false, error: "not found" }, 404);
    const result = await wpToolsService.sites();
    if (!result.ok || !result.data) return json(result, 400);
    return json({ ok: true, data: { html: dashboardBody(result.data), jobs: result.data.jobs } });
  }

  if (method === "GET" && path.startsWith("/api/jobs/")) {
    if (!auth?.roles.includes("ROLE_ADMIN")) return json({ ok: false, error: "not found" }, 404);
    const routed = await jobApiRoute({
      req, path, method,
      getJob: (id) => wpToolsService.getJob(id),
      watchJob: (id, handlers) => wpToolsService.watchJob(id, handlers),
    });
    if (routed) return routed;
  }

  if (method !== "POST") return json({ ok: false, error: "not found" }, 404);
  const denied = guardMutation(req);
  if (denied) return denied;

  // Reached both from this addon's own page and from the link injected into
  // CloudPanel's Sites page. This is the one route a non-administrator reaches,
  // and the only thing this side decides is whose request it is.
  if (path === "/api/sign-in") {
    let body: Record<string, unknown>;
    try {
      body = await readJsonObject(req, 4 * 1024);
    } catch (error) {
      return bodyErrorResponse(error);
    }
    const domain = validateDomain(body.domain);
    if (!domain) return json({ ok: false, error: "that is not a valid hostname" }, 400);
    const admin = auth?.roles.includes("ROLE_ADMIN") ?? false;
    if (!admin && !auth?.user) return json({ ok: false, error: "not found" }, 404);
    // The address comes from the request, never the body: the page can only
    // agree to add the one it is being answered from.
    const result = await wpToolsService.signIn(domain, {
      asUser: admin ? undefined : auth!.user,
      clientIp: clientIp(req),
      addBypass: body.addBypass === true,
      allowBasicAuth: body.allowBasicAuth === true,
    });
    return json(result, result.ok ? 200 : 400);
  }

  if (path === "/api/remove") {
    const result = await wpToolsService.remove();
    return json(result, result.ok ? 200 : 400);
  }

  if (path.startsWith("/api/mainwp-") || path.startsWith("/api/varnish-") || path === "/api/domain-link") {
    // Only sign-in and its CSRF bootstrap are exceptions to the manager's
    // administrator gate. Keep that boundary explicit here as well.
    if (!auth?.roles.includes("ROLE_ADMIN")) return json({ ok: false, error: "not found" }, 404);
    let body: Record<string, unknown>;
    // A batch connection names every site it is for.
    try { body = await readJsonObject(req, path === "/api/mainwp-connect" ? 128 * 1024 : 4 * 1024); }
    catch (error) { return bodyErrorResponse(error); }
    let result;
    if (path === "/api/mainwp-settings") {
      if (typeof body.enabled !== "boolean") return json({ ok: false, error: "enabled must be true or false" }, 400);
      if (body.remote !== undefined && body.remote !== true) return json({ ok: false, error: "remote must be true" }, 400);
      const dashboard = body.dashboard === undefined ? undefined : validateDomain(body.dashboard);
      if (dashboard === null) return json({ ok: false, error: "choose a valid Dashboard hostname" }, 400);
      result = await wpToolsService.mainwpSettings(body.enabled, dashboard, body.remote === true);
    } else if (path === "/api/varnish-settings") {
      if (typeof body.enabled !== "boolean") return json({ ok: false, error: "enabled must be true or false" }, 400);
      result = await wpToolsService.varnishSettings(body.enabled);
    } else if (path === "/api/domain-link") {
      if (typeof body.signIn !== "boolean") return json({ ok: false, error: "signIn must be true or false" }, 400);
      result = await wpToolsService.domainLinkSettings(body.signIn);
      if (!result.ok) return json(result, 400);
      // The setting is saved either way, and the page repaints with it; the
      // error says the panel's pages still show the old link.
      const rendered = await wpToolsService.renderPanelTemplates();
      if (!rendered.ok) {
        const why = rendered.error ?? "the CloudPanel templates could not be updated";
        return json({ ok: false, error: `Saved, but CloudPanel's site pages still show the old link: ${why}`, data: result.data }, 500);
      }
    } else if (path === "/api/varnish-sync") result = await wpToolsService.startJob("varnish-check");
    else if (path === "/api/mainwp-sync") result = await wpToolsService.startJob("mainwp-check");
    else if (path === "/api/varnish-install") {
      const domain = validateDomain(body.domain);
      if (!domain) return json({ ok: false, error: "that is not a valid hostname" }, 400);
      result = await wpToolsService.startJob("varnish-install", [domain]);
    } else if (path === "/api/mainwp-cleanup") {
      if (body.confirm !== true) return json({ ok: false, error: "confirm MainWP cleanup" }, 400);
      result = await wpToolsService.startJob("mainwp-cleanup", [], "mainwp");
    } else if (path === "/api/mainwp-connect") {
      const domains = Array.isArray(body.domains) ? body.domains.map(validateDomain) : [];
      if (!domains.length || domains.some((domain) => !domain)) return json({ ok: false, error: "choose the sites to connect" }, 400);
      if (body.confirm !== true) return json({ ok: false, error: "confirm the MainWP connection" }, 400);
      result = await wpToolsService.startJob("mainwp-connect", domains as string[], "connect");
    }
    return result ? json(result, result.ok ? 200 : 400) : json({ ok: false, error: "not found" }, 404);
  }

  return json({ ok: false, error: "not found" }, 404);
}

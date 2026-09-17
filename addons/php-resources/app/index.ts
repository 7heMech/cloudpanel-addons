import {
  bodyErrorResponse, guardMutation, htmlResponse, jsonResponse, newCsrfToken, readJsonObject,
  redirectResponse, safeDecodePathSegment,
} from "../../../lib/app-http";
import { embedLandingUrl } from "../../../lib/shadow-embed";
import { phpResourcesService, validateDomain } from "./service";
import { dashboardView, fragment, layout, siteView } from "./views";

function html(body: string, csrf: string, status = 200): Response {
  return htmlResponse(body, { status, csrf });
}

function json(body: unknown, status = 200): Response {
  return jsonResponse(body, { status });
}

// A fragment is the first thing an operator who came straight from a site page
// loads from this addon, so it carries the CSRF cookie its own actions echo.
function fragmentJson(body: unknown, csrf: string, status = 200): Response {
  return jsonResponse(body, { status, csrf });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorStatus(message: string): number {
  return /not found/i.test(message) ? 404 : 500;
}

export async function handle(
  req: Request,
  path: string,
  updateNotice?: { current: string; latest: string } | null,
): Promise<Response> {
  const method = req.method;
  const url = new URL(req.url);

  if (path === "/health") return json({ ok: true, service: "php-resources-manager" });

  if (method === "GET" && path === "/") {
    const csrf = newCsrfToken();
    const selected = url.searchParams.get("domain");
    // A site-scoped page belongs to the panel's site page. Send a direct visit
    // there and let the injected loader pull this page into it; ?embed=0 keeps
    // the standalone page. Deciding this needs no panel state, so it happens
    // before anything is read.
    if (selected && url.searchParams.get("embed") !== "0") {
      const target = validateDomain(selected);
      if (target) return redirectResponse(embedLandingUrl(target, "php-resources"));
    }
    try {
      if (!selected) {
        const result = await phpResourcesService.state();
        if (!result.ok || !result.data) throw new Error(result.error ?? "PHP pool settings are unavailable");
        return html(layout("PHP resources", dashboardView(result.data), updateNotice), csrf);
      }
      const domain = validateDomain(selected);
      if (!domain) return html(layout("Invalid site", '<div class="alert">That is not a valid hostname.</div>', updateNotice), csrf, 400);
      const page = await phpResourcesService.site(domain);
      return html(
        layout(`PHP resources — ${domain}`, siteView(page.site), updateNotice, page.context),
        csrf,
      );
    } catch (error) {
      const message = errorMessage(error);
      return html(layout("PHP resources", `<div class="alert" role="alert">${Bun.escapeHTML(message)}</div>`, updateNotice), csrf, errorStatus(message));
    }
  }

  // The same page as GET /?domain=, without a document around it, for the
  // loader injected into CloudPanel's site pages.
  if (method === "GET" && path === "/fragment") {
    const csrf = newCsrfToken();
    const domain = validateDomain(url.searchParams.get("domain") ?? "");
    if (!domain) return json({ ok: false, error: "that is not a valid hostname" }, 400);
    try {
      const page = await phpResourcesService.site(domain);
      return fragmentJson(fragment(`PHP resources — ${domain}`, siteView(page.site)), csrf);
    } catch (error) {
      const message = errorMessage(error);
      return json({ ok: false, error: message }, errorStatus(message));
    }
  }

  if (path === "/api/default" && method === "PUT") {
    const denied = guardMutation(req);
    if (denied) return denied;
    let body: Record<string, unknown>;
    try { body = await readJsonObject(req, 8 * 1024); } catch (error) { return bodyErrorResponse(error); }
    // null is a value here, not a missing field: it is how the page says new
    // sites should keep whatever CloudPanel gives them.
    if (body.profile !== null && (typeof body.profile !== "object" || Array.isArray(body.profile))) {
      return json({ ok: false, error: "profile must be an object or null" }, 400);
    }
    const result = await phpResourcesService.setDefault(body.profile as never);
    return json(result, result.ok ? 200 : 400);
  }

  const site = path.match(/^\/api\/sites\/([^/]+)$/);
  if (site && (method === "PUT" || method === "DELETE")) {
    const denied = guardMutation(req);
    if (denied) return denied;
    const decoded = safeDecodePathSegment(site[1]!);
    const domain = decoded === null ? null : validateDomain(decoded);
    if (!domain) return json({ ok: false, error: "invalid domain" }, 400);
    if (method === "DELETE") {
      const result = await phpResourcesService.resetSite(domain);
      return json(result, result.ok ? 200 : 400);
    }
    let body: Record<string, unknown>;
    try { body = await readJsonObject(req, 8 * 1024); } catch (error) { return bodyErrorResponse(error); }
    if (typeof body.profile !== "object" || body.profile === null || Array.isArray(body.profile)) {
      return json({ ok: false, error: "profile must be an object" }, 400);
    }
    const result = await phpResourcesService.setSite(domain, body.profile as never);
    return json(result, result.ok ? 200 : 400);
  }

  return json({ ok: false, error: "not found" }, 404);
}

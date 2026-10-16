import { bodyErrorResponse, guardMutation, htmlResponse, jsonResponse, newCsrfToken, readJsonObject, validateDomain } from "../../../lib/app-http";
import { domainsService } from "./service";
import { dashboardContent, dashboardView, layout, reviewContent } from "./views";

const routes: Record<string, string> = { "/api/connections": "save-connections", "/api/profiles": "save-profile", "/api/profiles/delete": "delete-profile", "/api/assign": "assign", "/api/default": "set-default", "/api/plan": "plan", "/api/apply": "apply", "/api/remove": "remove-records", "/api/ssl/retry": "retry-ssl" };
export async function handle(req: Request, path: string, notice?: { current: string; latest: string } | null, _server?: unknown, auth?: { user: string; roles: string[] } | null): Promise<Response> {
  if (req.method === "GET" && path === "/api/session") return jsonResponse({ ok: true }, { csrf: newCsrfToken() });
  if (req.method === "GET" && path === "/") {
    const result = await domainsService.state();
    return htmlResponse(layout("DNS & Mail", result.ok && result.data ? dashboardView(result.data) : `<div class="alert" role="alert">${Bun.escapeHTML(result.error ?? "DNS and mail state is unavailable")}</div>`, notice), { csrf: newCsrfToken(), status: result.ok ? 200 : 500 });
  }
  if (req.method === "POST") {
    const denied = guardMutation(req); if (denied) return denied;
    let body: Record<string, unknown>;
    try { body = await readJsonObject(req, 256 * 1024); } catch (error) { return bodyErrorResponse(error); }
    if (path === "/api/provision") {
      const domain = validateDomain(body.domain);
      if (!domain) return jsonResponse({ ok: false, error: "Invalid domain" }, { status: 400 });
      if (!auth?.user) return jsonResponse({ ok: false, error: "Not found" }, { status: 404 });
      const admin = auth.roles.includes("ROLE_ADMIN");
      const result = await domainsService.provision(domain, admin ? undefined : auth.user);
      if (admin && result.ok) {
        const state = await domainsService.state();
        return jsonResponse({ ...result, ...(state.ok && state.data ? { html: dashboardContent(state.data) } : {}) });
      }
      return jsonResponse(result, { status: result.ok ? 200 : 400 });
    }
    const verb = routes[path];
    if (verb) {
      const result = await domainsService.change(verb, body);
      return jsonResponse({ ...result, ...(result.ok && result.data ? { html: dashboardContent(result.data), ...(result.data.review ? { reviewHtml: reviewContent(result.data.review) } : {}) } : {}) }, { status: result.ok ? 200 : 400 });
    }
  }
  return jsonResponse({ ok: false, error: "Not found" }, { status: 404 });
}

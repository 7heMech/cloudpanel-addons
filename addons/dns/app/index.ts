import { bodyErrorResponse, guardMutation, htmlResponse, jsonResponse, newCsrfToken, readJsonObject, validateDomain } from "../../../lib/app-http";
import { dnsService } from "./service";
import { dashboardContent, dashboardView, layout } from "./views";
import type { WebVerb } from "../../../lib/gateway-protocol";

const CHANGES: Record<string, WebVerb<"dns">> = {
  "/api/check": "check",
  "/api/profiles": "save-profile",
  "/api/profiles/delete": "delete-profile",
  "/api/automatic": "set-automatic",
  "/api/zone-account": "zone-account",
  "/api/assign": "assign",
  "/api/default": "set-default",
  "/api/confirm": "confirm",
  "/api/zone": "choose-zone",
  "/api/connections": "save-connection",
  "/api/connections/remove": "remove-connection",
  "/api/mailcow": "save-mailcow",
  "/api/mailcow/remove": "remove-mailcow",
  "/api/server": "save-server",
  "/api/records/remove": "remove-records",
  "/api/records/forget": "forget-records",
  "/api/redirects": "save-redirect",
  "/api/redirects/delete": "delete-redirect",
  "/api/redirects/find": "find-redirects",
  "/api/redirects/take-over": "take-over",
};

/**
 * `/api/session` and `/api/provision` are routes a non-administrator reaches,
 * from CloudPanel's own page for a site they just created; `/api/site` is the
 * third, from the site's SSL/TLS page. The action checks that the site is
 * theirs and answers with readiness, or the zone and its nameservers, only.
 */
async function provision(req: Request, auth: { user: string; roles: string[] } | null | undefined): Promise<Response> {
  const denied = guardMutation(req);
  if (denied) return denied;
  let body: Record<string, unknown>;
  try {
    body = await readJsonObject(req, 4 * 1024);
  } catch (error) {
    return bodyErrorResponse(error);
  }
  const domain = validateDomain(body.domain);
  if (!domain) return jsonResponse({ ok: false, error: "invalid domain" }, { status: 400 });
  if (!auth?.user) return jsonResponse({ ok: false, error: "not found" }, { status: 404 });
  const admin = auth.roles.includes("ROLE_ADMIN");
  const result = await dnsService.provision(domain, { asUser: admin ? undefined : auth.user, ssl: body.ssl === true });
  if (!result.ok || !admin || body.ssl === true) return jsonResponse(result, { status: result.ok ? 200 : 400 });
  const state = await dnsService.state();
  return jsonResponse({ ...state, provision: result.data, ...(state.ok && state.data ? { html: dashboardContent(state.data) } : {}) });
}

export async function handle(
  req: Request,
  path: string,
  notice?: { current: string; latest: string } | null,
  _server?: unknown,
  auth?: { user: string; roles: string[] } | null,
): Promise<Response> {
  if (req.method === "GET" && path === "/api/session") return jsonResponse({ ok: true }, { csrf: newCsrfToken() });
  if (req.method === "POST" && path === "/api/provision") return provision(req, auth);
  if (req.method === "GET" && path === "/api/site") {
    const domain = validateDomain(new URL(req.url).searchParams.get("domain"));
    if (!domain) return jsonResponse({ ok: false, error: "invalid domain" }, { status: 400 });
    if (!auth?.user) return jsonResponse({ ok: false, error: "not found" }, { status: 404 });
    const result = await dnsService.siteStatus(domain, auth.roles.includes("ROLE_ADMIN") ? undefined : auth.user);
    return jsonResponse(result, { status: result.ok ? 200 : 400 });
  }
  if (req.method === "GET" && path === "/") {
    const csrf = newCsrfToken();
    const result = await dnsService.state();
    if (!result.ok || !result.data) {
      return htmlResponse(layout("DNS", `<div class="alert" role="alert">${Bun.escapeHTML(result.error ?? "DNS state is unavailable")}</div>`, notice), { status: 500, csrf });
    }
    return htmlResponse(layout("DNS", dashboardView(result.data), notice), { csrf });
  }
  if (req.method === "POST" && CHANGES[path]) {
    const denied = guardMutation(req);
    if (denied) return denied;
    let body: Record<string, unknown>;
    try {
      body = await readJsonObject(req, 256 * 1024);
    } catch (error) {
      return bodyErrorResponse(error);
    }
    const result = await dnsService.change(CHANGES[path]!, body);
    if (result.ok && result.data) return jsonResponse({ ...result, html: dashboardContent(result.data) });
    return jsonResponse(result, { status: 400 });
  }
  return jsonResponse({ ok: false, error: "not found" }, { status: 404 });
}

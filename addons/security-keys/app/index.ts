import {
  bodyErrorResponse, guardMutation, htmlResponse, jsonResponse, newCsrfToken, readJsonObject,
} from "../../../lib/app-http";
import { panelSessionId } from "../../../lib/sso-auth";
import { securityKeysService } from "./service";
import { dashboardView, layout } from "./views";

function json(body: unknown, status = 200): Response {
  return jsonResponse(body, { status });
}

/** The routes every panel user reaches, for their own account only. */
const OWN_ACCOUNT_ROUTES = new Set(["/api/keys", "/api/register-options", "/api/register", "/api/remove"]);

export async function handle(
  req: Request,
  path: string,
  updateNotice?: { current: string; latest: string } | null,
  _server?: unknown,
  auth?: { user: string; roles: string[] } | null,
): Promise<Response> {
  const method = req.method;
  if (method === "GET" && path === "/health") return json({ ok: true, service: "security-keys-manager" });

  if (OWN_ACCOUNT_ROUTES.has(path)) {
    // Whose keys these are is the gateway's answer from the session itself,
    // not this process's, so it is the session that is handed on.
    const sessionId = panelSessionId(req);
    if (!sessionId) return json({ ok: false, error: "not found" }, 404);
    if (method === "GET" && path === "/api/keys") {
      // The card lives on CloudPanel's Security page, which has given this
      // browser no CSRF cookie; this hands out the pair with the list.
      const result = await securityKeysService.keys(sessionId);
      return jsonResponse(result, { status: result.ok ? 200 : 400, csrf: newCsrfToken() });
    }
    if (method !== "POST") return json({ ok: false, error: "not found" }, 404);
    const denied = guardMutation(req);
    if (denied) return denied;
    if (path === "/api/register-options") {
      const result = await securityKeysService.registerOptions(sessionId);
      return json(result, result.ok ? 200 : 400);
    }
    let body: Record<string, unknown>;
    try { body = await readJsonObject(req, 32 * 1024); } catch (error) { return bodyErrorResponse(error); }
    if (path === "/api/register") {
      const response = typeof body.response === "object" && body.response !== null ? body.response as Record<string, unknown> : {};
      const result = await securityKeysService.register(sessionId, {
        challengeId: body.challengeId,
        name: body.name,
        // guardMutation has matched it to this panel; the action matches it
        // to what the browser told the key.
        origin: req.headers.get("origin"),
        clientDataJSON: response.clientDataJSON,
        attestationObject: response.attestationObject,
      });
      return json(result, result.ok ? 200 : 400);
    }
    if (typeof body.id !== "string") return json({ ok: false, error: "choose a key to remove" }, 400);
    const result = await securityKeysService.remove(sessionId, body.id);
    return json(result, result.ok ? 200 : 400);
  }

  if (!auth?.roles.includes("ROLE_ADMIN")) return json({ ok: false, error: "not found" }, 404);

  if (method === "GET" && path === "/") {
    const csrf = newCsrfToken();
    const result = await securityKeysService.users();
    if (!result.ok || !result.data) {
      return htmlResponse(
        layout("Security Keys", `<div class="alert" role="alert">${Bun.escapeHTML(result.error ?? "security keys are unavailable")}</div>`, updateNotice),
        { status: 500, csrf },
      );
    }
    return htmlResponse(layout("Security Keys", dashboardView(result.data.users), updateNotice), { csrf });
  }

  if (method === "POST" && path === "/api/revoke") {
    const denied = guardMutation(req);
    if (denied) return denied;
    let body: Record<string, unknown>;
    try { body = await readJsonObject(req, 4 * 1024); } catch (error) { return bodyErrorResponse(error); }
    if (typeof body.user !== "string" || typeof body.id !== "string") return json({ ok: false, error: "choose a key to remove" }, 400);
    const result = await securityKeysService.revoke(body.user, body.id);
    return json(result.ok && result.data ? { ...result, html: dashboardView(result.data.users) } : result, result.ok ? 200 : 400);
  }

  return json({ ok: false, error: "not found" }, 404);
}

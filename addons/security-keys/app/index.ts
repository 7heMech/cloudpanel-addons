import {
  errorBlock, guardMutation, htmlResponse, jsonResponse, newCsrfToken, readBody, readMutation,
} from "../../../lib/app-http";
import { panelSessionId } from "../../../lib/sso-auth";
import { securityKeysService, type Settings } from "./service";
import { dashboardView, layout } from "./views";

const OWN_ACCOUNT_ROUTES = new Set(["/api/keys", "/api/register-options", "/api/register", "/api/remove"]);

export async function handle(
  req: Request,
  path: string,
  updateNotice?: { current: string; latest: string } | null,
  _server?: unknown,
  auth?: { user: string; roles: string[] } | null,
): Promise<Response> {
  const method = req.method;
  if (OWN_ACCOUNT_ROUTES.has(path)) {
    // Whose keys these are is the gateway's answer from the session itself,
    // not this process's, so it is the session that is handed on.
    const sessionId = panelSessionId(req);
    if (!sessionId) return jsonResponse({ ok: false, error: "not found" }, 404);
    if (method === "GET" && path === "/api/keys") {
      // The card lives on CloudPanel's Security page, which has given this
      // browser no CSRF cookie; this hands out the pair with the list.
      const result = await securityKeysService.keys(sessionId);
      return jsonResponse(result, { status: result.ok ? 200 : 400, csrf: newCsrfToken() });
    }
    if (method !== "POST") return jsonResponse({ ok: false, error: "not found" }, 404);
    const denied = guardMutation(req);
    if (denied) return denied;
    if (path === "/api/register-options") {
      const result = await securityKeysService.registerOptions(sessionId);
      return jsonResponse(result, result.ok ? 200 : 400);
    }
    const body = await readBody(req, 32 * 1024);
    if (body instanceof Response) return body;
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
      return jsonResponse(result, result.ok ? 200 : 400);
    }
    if (typeof body.id !== "string") return jsonResponse({ ok: false, error: "choose a key to remove" }, 400);
    const result = await securityKeysService.remove(sessionId, body.id);
    return jsonResponse(result, result.ok ? 200 : 400);
  }

  if (!auth?.roles.includes("ROLE_ADMIN")) return jsonResponse({ ok: false, error: "not found" }, 404);

  if (method === "GET" && path === "/") {
    const csrf = newCsrfToken();
    const result = await securityKeysService.users();
    if (!result.ok || !result.data) {
      return htmlResponse(
        layout("Security Keys", errorBlock(result.error ?? "security keys are unavailable"), updateNotice),
        { status: 500, csrf },
      );
    }
    return htmlResponse(layout("Security Keys", dashboardView(result.data), updateNotice), { csrf });
  }

  if (method === "POST" && path === "/api/revoke") {
    const body = await readMutation(req, 4 * 1024);
    if (body instanceof Response) return body;
    if (typeof body.user !== "string" || typeof body.id !== "string") return jsonResponse({ ok: false, error: "choose a key to remove" }, 400);
    const result = await securityKeysService.revoke(body.user, body.id);
    return jsonResponse(result.ok && result.data ? { ...result, html: dashboardView(result.data) } : result, result.ok ? 200 : 400);
  }

  if (method === "POST" && path === "/api/settings") {
    const body = await readMutation(req, 4 * 1024);
    if (body instanceof Response) return body;
    if (!Array.isArray(body.roles) || typeof body.syncedPasskeys !== "boolean") {
      return jsonResponse({ ok: false, error: "roles must be a list and syncedPasskeys true or false" }, 400);
    }
    const result = await securityKeysService.settings({ roles: body.roles as Settings["roles"], syncedPasskeys: body.syncedPasskeys });
    return jsonResponse(result.ok && result.data ? { ...result, html: dashboardView(result.data) } : result, result.ok ? 200 : 400);
  }

  return jsonResponse({ ok: false, error: "not found" }, 404);
}

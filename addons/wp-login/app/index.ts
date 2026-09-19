import {
  bodyErrorResponse, guardMutation, htmlResponse, jsonResponse, readJsonObject, newCsrfToken,
} from "../../../lib/app-http";
import { validateDomain, wpLoginService } from "./service";
import { dashboardView, layout } from "./views";

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

  if (method === "GET" && path === "/health") return json({ ok: true, service: "wp-login-manager" });

  // The link injected into CloudPanel's Sites page is on a page this addon did
  // not render, so the browser may have no CSRF cookie yet and a non-adminis-
  // trator can never get one from an addon page. This hands out that pair and
  // nothing else: no state is read, and the token is only useful to a request
  // that can also send the session cookie from this origin.
  if (method === "GET" && path === "/api/session") {
    const csrf = newCsrfToken();
    return jsonResponse({ ok: true }, { csrf });
  }

  if (method === "GET" && path === "/") {
    const csrf = newCsrfToken();
    try {
      const result = await wpLoginService.sites();
      if (!result.ok || !result.data) throw new Error(result.error ?? "the WordPress site list is unavailable");
      return htmlResponse(layout("WordPress Sign-In", dashboardView(result.data.sites), updateNotice), { csrf });
    } catch (error) {
      return htmlResponse(
        layout("WordPress Sign-In", `<div class="alert" role="alert">${Bun.escapeHTML(errorMessage(error))}</div>`, updateNotice),
        { status: 500, csrf },
      );
    }
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
    const result = await wpLoginService.signIn(domain, admin ? undefined : auth!.user);
    return json(result, result.ok ? 200 : 400);
  }

  if (path === "/api/remove") {
    const result = await wpLoginService.remove();
    return json(result, result.ok ? 200 : 400);
  }

  return json({ ok: false, error: "not found" }, 404);
}

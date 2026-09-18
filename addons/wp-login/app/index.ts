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
): Promise<Response> {
  const method = req.method;

  if (method === "GET" && path === "/health") return json({ ok: true, service: "wp-login-manager" });

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
  // CloudPanel's Sites page; both are behind the same administrator gate.
  if (path === "/api/sign-in") {
    let body: Record<string, unknown>;
    try {
      body = await readJsonObject(req, 4 * 1024);
    } catch (error) {
      return bodyErrorResponse(error);
    }
    const domain = validateDomain(body.domain);
    if (!domain) return json({ ok: false, error: "that is not a valid hostname" }, 400);
    const result = await wpLoginService.signIn(domain);
    return json(result, result.ok ? 200 : 400);
  }

  if (path === "/api/remove") {
    const result = await wpLoginService.remove();
    return json(result, result.ok ? 200 : 400);
  }

  return json({ ok: false, error: "not found" }, 404);
}

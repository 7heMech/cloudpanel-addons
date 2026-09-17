import {
  bodyErrorResponse, guardMutation, htmlResponse, jsonResponse, newCsrfToken, readJsonObject,
} from "../../../lib/app-http";
import { callGatewayAction } from "../../../lib/gateway-client";
import { panelTweaksService, validateDomain } from "./service";
import { dashboardView, layout } from "./views";

function json(body: unknown, status = 200): Response {
  return jsonResponse(body, { status });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Put the login page's script back, or take it away.
 *
 * The device theme is markup in a CloudPanel template, so moving that one
 * switch means the templates have to be rendered again -- and rendering them is
 * the manager's own privileged work, not an addon's: one pass regenerates every
 * addon's block in the file from the pristine copy. The other three switches
 * are read at request time and need none of this.
 */
async function reinjectTemplates(): Promise<string | null> {
  const result = await callGatewayAction("manager", "reconcile", [], undefined, { timeout: 60_000 });
  return result.ok ? null : result.error ?? "the CloudPanel templates could not be updated";
}

export async function handle(
  req: Request,
  path: string,
  updateNotice?: { current: string; latest: string } | null,
): Promise<Response> {
  const method = req.method;

  if (method === "GET" && path === "/health") return json({ ok: true, service: "panel-tweaks-manager" });

  if (method === "GET" && path === "/") {
    const csrf = newCsrfToken();
    try {
      const result = await panelTweaksService.state();
      if (!result.ok || !result.data) throw new Error(result.error ?? "the panel tweaks state is unavailable");
      return htmlResponse(layout("Panel Tweaks", dashboardView(result.data), updateNotice), { csrf });
    } catch (error) {
      return htmlResponse(
        layout("Panel Tweaks", `<div class="alert" role="alert">${Bun.escapeHTML(errorMessage(error))}</div>`, updateNotice),
        { status: 500, csrf },
      );
    }
  }

  // What the script injected into CloudPanel's own Sites page reads: which
  // tweaks are on, and the site facts the panel's template does not carry.
  // Read-only, so no CSRF cookie is set and no mutation reaches it.
  if (method === "GET" && path === "/api/panel") {
    const result = await panelTweaksService.state();
    return json(result, result.ok ? 200 : 500);
  }

  if (method !== "POST") return json({ ok: false, error: "not found" }, 404);
  const denied = guardMutation(req);
  if (denied) return denied;

  if (path === "/api/tweaks") {
    let body: Record<string, unknown>;
    try {
      body = await readJsonObject(req, 8 * 1024);
    } catch (error) {
      return bodyErrorResponse(error);
    }
    const result = await panelTweaksService.setTweaks(body);
    if (!result.ok || !result.data) return json(result, 400);
    if (result.data.reinject) {
      const failure = await reinjectTemplates();
      // The switch is saved either way; what failed is the panel's copy of it,
      // and saying so is more use than pretending nothing moved.
      if (failure) return json({ ok: false, error: failure, data: result.data }, 500);
    }
    return json(result);
  }

  if (path === "/api/scan") {
    const result = await panelTweaksService.scan();
    return json(result, result.ok ? 200 : 400);
  }

  if (path === "/api/wp-login") {
    let body: Record<string, unknown>;
    try {
      body = await readJsonObject(req, 4 * 1024);
    } catch (error) {
      return bodyErrorResponse(error);
    }
    const domain = validateDomain(body.domain);
    if (!domain) return json({ ok: false, error: "that is not a valid hostname" }, 400);
    const result = await panelTweaksService.wpLogin(domain);
    return json(result, result.ok ? 200 : 400);
  }

  return json({ ok: false, error: "not found" }, 404);
}

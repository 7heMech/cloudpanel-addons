import {
  SECURITY_HEADERS, bodyErrorResponse, guardMutation, htmlResponse, jsonResponse, newCsrfToken,
  readJsonObject,
} from "../../../lib/app-http";
import { callGatewayAction } from "../../../lib/gateway-client";
import { panelTweaksService } from "./service";
import { previewPage } from "./preview";
import { dashboardView, layout } from "./views";

function json(body: unknown, status = 200): Response {
  return jsonResponse(body, { status });
}

// The preview is a frame inside the addon's own page, and it wears CloudPanel's
// stylesheets rather than a copy of them, so it needs the two things the shared
// policy refuses: to be framed by this origin, and to load styles from it. Read
// when a request asks for it rather than when this module is first evaluated,
// which on some import orders happens before the policy itself exists.
function previewCsp(): string {
  return (SECURITY_HEADERS["Content-Security-Policy"] ?? "")
    .replace("frame-ancestors 'none'", "frame-ancestors 'self'")
    .replace("style-src 'unsafe-inline'", "style-src 'self' 'unsafe-inline'");
}

/** What the page holding that frame needs in turn: permission to hold it. */
function pageCsp(): string {
  return (SECURITY_HEADERS["Content-Security-Policy"] ?? "").replace("default-src 'none'", "default-src 'none'; frame-src 'self'");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Put the blocks CloudPanel's own templates carry back, or take them away.
 *
 * The login theme, the two narrow-screen layouts and the row menu are markup in
 * a CloudPanel template, so moving one of those switches means the templates
 * have to be rendered again -- and rendering them is the manager's own
 * privileged work, not an addon's: one pass regenerates every addon's block in
 * the file from the pristine copy. The rest are read at request time and need
 * none of this.
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
      return htmlResponse(layout("Panel Tweaks", dashboardView(result.data), updateNotice), {
        csrf,
        headers: { "Content-Security-Policy": pageCsp() },
      });
    } catch (error) {
      return htmlResponse(
        layout("Panel Tweaks", `<div class="alert" role="alert">${Bun.escapeHTML(errorMessage(error))}</div>`, updateNotice),
        { status: 500, csrf },
      );
    }
  }

  // What the switches above it will do to CloudPanel's own Sites page. The same
  // block the templates carry, over the panel's own markup and stylesheets.
  if (method === "GET" && path === "/preview") {
    const result = await panelTweaksService.state();
    if (!result.ok || !result.data) return json(result, 500);
    return htmlResponse(previewPage(result.data), {
      headers: { "Content-Security-Policy": previewCsp(), "X-Frame-Options": "SAMEORIGIN" },
    });
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

  return json({ ok: false, error: "not found" }, 404);
}

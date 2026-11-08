import {
  contentSecurityPolicy, errorBlock, guardMutation, htmlResponse, jsonResponse, newCsrfToken, readBody,
} from "../../../lib/app-http";
import { callGatewayAction } from "../../../lib/gateway-client";
import { jobApiRoute } from "../../../lib/job-stream";
import { panelTweaksService } from "./service";
import { previewPage } from "./preview";
import { MAX_BRANDING_INPUT_BYTES } from "../branding";
import { dashboardView, layout } from "./views";

// The preview is a frame inside the addon's own page, and it wears CloudPanel's
// stylesheets rather than a copy of them, so it needs the two things the shared
// policy refuses: to be framed by this origin, and to load styles from it. Built
// when a request asks for it rather than when this module is first evaluated,
// which on some import orders happens before the policy itself exists.
function previewCsp(): string {
  return contentSecurityPolicy({ "frame-ancestors": "'self'", "style-src": "'self' 'unsafe-inline'" });
}

/** What the page holding that frame needs in turn: permission to hold it. */
function pageCsp(): string {
  return contentSecurityPolicy({ "frame-src": "'self'" });
}

/**
 * Put the blocks CloudPanel's own templates carry back, or take them away.
 *
 * The login theme, mobile layouts, row menu, automatic SSL and branding are markup in
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
  _server?: unknown,
  auth?: { user: string; roles: string[] } | null,
): Promise<Response> {
  const method = req.method;

  if (method === "GET" && path === "/") {
    const csrf = newCsrfToken();
    try {
      const [result, branding] = await Promise.all([panelTweaksService.state(), panelTweaksService.branding()]);
      if (!result.ok || !result.data) throw new Error(result.error ?? "the panel tweaks state is unavailable");
      if (!branding.ok || !branding.data) throw new Error(branding.error ?? "the branding settings are unavailable");
      const view = dashboardView(result.data, branding.data);
      return htmlResponse(layout("Panel Tweaks", view, updateNotice), {
        csrf,
        headers: { "Content-Security-Policy": pageCsp() },
      });
    } catch (error) {
      return htmlResponse(layout("Panel Tweaks", errorBlock(error), updateNotice), { status: 500, csrf });
    }
  }

  // What the switches above it will do to CloudPanel's own Sites page. The same
  // block the templates carry, over the panel's own markup and stylesheets.
  if (method === "GET" && path === "/preview") {
    const result = await panelTweaksService.state();
    if (!result.ok || !result.data) return jsonResponse(result, 500);
    return htmlResponse(previewPage(result.data), {
      headers: { "Content-Security-Policy": previewCsp(), "X-Frame-Options": "SAMEORIGIN" },
    });
  }

  // What the script injected into CloudPanel's own Sites page reads: which
  // tweaks are on, and the site facts the panel's template does not carry.
  // Read-only, so no CSRF cookie is set and no mutation reaches it.
  //
  // The page it answers is CloudPanel's own, which every panel user sees, so
  // this route is reached without ROLE_ADMIN. A session that is not an
  // administrator's is named to the action, which answers with the sites
  // CloudPanel would list for that account and no others.
  if (method === "GET" && path === "/api/panel") {
    const admin = auth?.roles.includes("ROLE_ADMIN") ?? false;
    if (!admin && !auth?.user) return jsonResponse({ ok: false, error: "not found" }, 404);
    const result = await panelTweaksService.state(admin ? undefined : auth!.user);
    if (result.ok || admin) return jsonResponse(result, result.ok ? 200 : 500);
    // Why it failed can name files and databases, which are an administrator's to read.
    console.error(`[panel-tweaks] panel data failed: ${result.error ?? "unknown error"}`);
    return jsonResponse({ ok: false, error: "Panel Tweaks is unavailable right now" }, 500);
  }

  // The measurement the page follows. Behind the manager's administrator gate,
  // as everything here is but `/api/panel`.
  if (method === "GET" && path.startsWith("/api/jobs/")) {
    const routed = await jobApiRoute({
      req, path, method,
      getJob: (id) => panelTweaksService.getJob(id),
      watchJob: (id, handlers) => panelTweaksService.watchJob(id, handlers),
    });
    if (routed) return routed;
  }

  if (method !== "POST") return jsonResponse({ ok: false, error: "not found" }, 404);
  const denied = guardMutation(req);
  if (denied) return denied;

  if (path === "/api/tweaks") {
    const body = await readBody(req, 8 * 1024);
    if (body instanceof Response) return body;
    const result = await panelTweaksService.setTweaks(body);
    if (!result.ok || !result.data) return jsonResponse(result, 400);
    if (result.data.reinject) {
      const failure = await reinjectTemplates();
      // The switch is saved either way; what failed is the panel's copy of it,
      // and saying so is more use than pretending nothing moved.
      if (failure) return jsonResponse({ ok: false, error: failure, data: result.data }, 500);
    }
    return jsonResponse(result);
  }

  if (path === "/api/branding") {
    const body = await readBody(req, MAX_BRANDING_INPUT_BYTES);
    if (body instanceof Response) return body;
    const result = await panelTweaksService.setBranding(body);
    if (!result.ok || !result.data) return jsonResponse(result, 400);
    if (result.data.reinject) {
      const failure = await reinjectTemplates();
      if (failure) return jsonResponse({ ok: false, error: failure, data: result.data }, 500);
    }
    return jsonResponse(result);
  }

  if (path === "/api/measure") {
    const result = await panelTweaksService.measure();
    return jsonResponse(result, result.ok ? 200 : 400);
  }

  return jsonResponse({ ok: false, error: "not found" }, 404);
}

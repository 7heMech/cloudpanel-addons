import { bodyErrorResponse, guardMutation, htmlResponse, jsonResponse, newCsrfToken, readJsonObject } from "../../../lib/app-http";
import { jobApiRoute } from "../../../lib/job-stream";
import { archiveService } from "./service";
import { dashboardContent, dashboardView, layout } from "./views";

const STARTS: Record<string, "archive" | "restore" | "delete"> = {
  "/api/archive": "archive",
  "/api/restore": "restore",
  "/api/delete": "delete",
};

export async function handle(
  req: Request,
  path: string,
  notice?: { current: string; latest: string } | null,
  _server?: unknown,
  auth?: { user: string; roles: string[] } | null,
): Promise<Response> {
  if (req.method === "GET" && path === "/") {
    const csrf = newCsrfToken();
    const result = await archiveService.state();
    if (!result.ok || !result.data) {
      return htmlResponse(layout("Archive Sites", `<div class="alert" role="alert">${Bun.escapeHTML(result.error ?? "The archives are unavailable")}</div>`, notice), { status: 500, csrf });
    }
    return htmlResponse(layout("Archive Sites", dashboardView(result.data), notice), { csrf });
  }
  if (req.method === "GET" && path === "/api/state") {
    const result = await archiveService.state();
    if (!result.ok || !result.data) return jsonResponse(result, { status: 400 });
    return jsonResponse({ ok: true, data: result.data, html: dashboardContent(result.data) });
  }
  if (req.method === "GET" && path.startsWith("/api/jobs/")) {
    if (!auth?.roles.includes("ROLE_ADMIN")) return jsonResponse({ ok: false, error: "not found" }, { status: 404 });
    const routed = await jobApiRoute({ req, path, method: req.method, getJob: archiveService.getJob, watchJob: archiveService.watchJob });
    if (routed) return routed;
  }
  if (req.method === "POST" && STARTS[path]) {
    const denied = guardMutation(req);
    if (denied) return denied;
    let body: Record<string, unknown>;
    try {
      body = await readJsonObject(req, 64 * 1024);
    } catch (error) {
      return bodyErrorResponse(error);
    }
    const started = await archiveService.start(STARTS[path]!, body);
    if (!started.ok) return jsonResponse(started, { status: 400 });
    const state = await archiveService.state();
    return jsonResponse({ ok: true, data: { ...started.data, state: state.data }, ...(state.ok && state.data ? { html: dashboardContent(state.data) } : {}) });
  }
  return jsonResponse({ ok: false, error: "not found" }, { status: 404 });
}

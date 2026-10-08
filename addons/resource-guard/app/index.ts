import { bodyErrorResponse, guardMutation, htmlResponse, jsonResponse, newCsrfToken, readJsonObject } from "../../../lib/app-http";
import { callGatewayAction } from "../../../lib/gateway-client";
import type { GuardState } from "../action";
import { dashboardView, layout } from "./views";

export async function handle(req: Request, path: string, notice?: { current: string; latest: string } | null): Promise<Response> {
  if (req.method === "GET" && path === "/health") return jsonResponse({ ok: true, service: "resource-guard" });
  if (req.method === "GET" && (path === "/" || path === "/api/status")) {
    const result = await callGatewayAction<GuardState>("resource-guard", "status");
    if (path === "/api/status") return jsonResponse(result, { status: result.ok ? 200 : 503 });
    const content = result.ok && result.data ? dashboardView(result.data)
      : `<div class="alert" role="alert">${Bun.escapeHTML(result.error ?? "Resource Guard status is unavailable")}</div>`;
    return htmlResponse(layout(content, notice), { csrf: newCsrfToken(), status: result.ok ? 200 : 503 });
  }
  if (req.method !== "POST" || !["/api/configure", "/api/clean"].includes(path)) return jsonResponse({ ok: false, error: "not found" }, { status: 404 });
  const denied = guardMutation(req);
  if (denied) return denied;
  try {
    const body = await readJsonObject(req, 16 * 1024);
    const result = await callGatewayAction<GuardState>("resource-guard", path === "/api/clean" ? "clean" : "configure", [], JSON.stringify(body));
    return jsonResponse(result, { status: result.ok ? 200 : 400 });
  } catch (error) { return bodyErrorResponse(error); }
}

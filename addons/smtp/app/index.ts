import { bodyErrorResponse, guardMutation, htmlResponse, jsonResponse, newCsrfToken, readJsonObject } from "../../../lib/app-http";
import { smtpService } from "./service";
import { dashboardContent, dashboardView, layout } from "./views";

export async function handle(req: Request, path: string, notice?: { current: string; latest: string } | null): Promise<Response> {
  if (req.method === "GET" && path === "/") {
    const csrf = newCsrfToken();
    const result = await smtpService.state();
    if (!result.ok || !result.data) {
      return htmlResponse(layout("SMTP Relay", `<div class="alert" role="alert">${Bun.escapeHTML(result.error ?? "SMTP state is unavailable")}</div>`, notice), { status: 500, csrf });
    }
    return htmlResponse(layout("SMTP Relay", dashboardView(result.data), notice), { csrf });
  }
  if (req.method === "GET" && path === "/api/state") {
    const result = await smtpService.state();
    return jsonResponse(result, { status: result.ok ? 200 : 500 });
  }
  if (req.method === "POST") {
    const denied = guardMutation(req);
    if (denied) return denied;
    let body: Record<string, unknown>;
    try { body = await readJsonObject(req); } catch (error) { return bodyErrorResponse(error); }
    if (path === "/api/test") {
      const result = await smtpService.test(body);
      return jsonResponse(result, { status: result.ok ? 200 : 400 });
    }
    const result = path === "/api/setup" ? await smtpService.saveSetup(body)
      : path === "/api/relay" ? await smtpService.saveRelay(body)
      : path === "/api/default" ? await smtpService.saveDefault(body)
      : path === "/api/site" ? await smtpService.saveSite(body)
      : path === "/api/site/clear" ? await smtpService.clearSite(body)
      : path === "/api/domain-relay" ? await smtpService.saveDomainRelay(body)
      : path === "/api/domain-relay/clear" ? await smtpService.clearDomainRelay(body)
      : null;
    if (result?.ok && result.data) return jsonResponse({ ...result, html: dashboardContent(result.data) });
    if (result) return jsonResponse(result, { status: 400 });
  }
  return jsonResponse({ ok: false, error: "not found" }, { status: 404 });
}

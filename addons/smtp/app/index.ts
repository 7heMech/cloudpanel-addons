import { errorBlock, htmlResponse, jsonResponse, newCsrfToken, readMutation } from "../../../lib/app-http";
import type { WebVerb } from "../../../lib/gateway-protocol";
import { smtpService } from "./service";
import { dashboardContent, dashboardView, layout } from "./views";

const CHANGES: Record<string, WebVerb<"smtp">> = {
  "/api/profiles": "save-profile",
  "/api/profiles/delete": "delete-profile",
  "/api/assign": "assign",
  "/api/default": "set-default",
  "/api/grants": "save-grants",
};

export async function handle(req: Request, path: string, notice?: { current: string; latest: string } | null): Promise<Response> {
  if (req.method === "GET" && path === "/") {
    const csrf = newCsrfToken();
    const result = await smtpService.state();
    if (!result.ok || !result.data) {
      return htmlResponse(layout("SMTP Relay", errorBlock(result.error ?? "SMTP state is unavailable"), notice), { status: 500, csrf });
    }
    return htmlResponse(layout("SMTP Relay", dashboardView(result.data), notice), { csrf });
  }
  if (req.method === "POST") {
    const body = await readMutation(req, 256 * 1024);
    if (body instanceof Response) return body;
    if (path === "/api/test") {
      const result = await smtpService.test(body);
      return jsonResponse(result, { status: result.ok ? 200 : 400 });
    }
    const verb = CHANGES[path];
    if (verb) {
      const result = await smtpService.change(verb, body);
      if (result.ok && result.data) return jsonResponse({ ...result, html: dashboardContent(result.data) });
      return jsonResponse(result, { status: 400 });
    }
  }
  return jsonResponse({ ok: false, error: "not found" }, { status: 404 });
}

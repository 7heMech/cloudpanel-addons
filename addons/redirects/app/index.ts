import { errorBlock, htmlResponse, jsonResponse, newCsrfToken, readMutation } from "../../../lib/app-http";
import type { WebVerb } from "../../../lib/gateway-protocol";
import { redirectsService } from "./service";
import { dashboardContent, dashboardView, layout } from "./views";

const CHANGES: Record<string, WebVerb<"redirects">> = {
  "/api/check": "check",
  "/api/automatic": "set-automatic",
  "/api/redirects": "save-redirect",
  "/api/redirects/delete": "delete-redirect",
  "/api/redirects/review": "review-redirect",
  "/api/redirects/find": "find-redirects",
  "/api/redirects/take-over": "take-over",
  "/api/confirm": "confirm",
  "/api/zone": "choose-zone",
  "/api/connections": "save-connection",
  "/api/connections/remove": "remove-connection",
};

export async function handle(
  req: Request,
  path: string,
  notice?: { current: string; latest: string } | null,
): Promise<Response> {
  if (req.method === "GET" && path === "/api/session") return jsonResponse({ ok: true }, { csrf: newCsrfToken() });
  if (req.method === "GET" && path === "/api/create-site-helper") {
    const result = await redirectsService.createSiteHelper();
    return jsonResponse(result, { status: result.ok ? 200 : 400 });
  }
  if (req.method === "GET" && path === "/") {
    const csrf = newCsrfToken();
    const result = await redirectsService.state();
    if (!result.ok || !result.data) {
      return htmlResponse(layout("Redirects", errorBlock(result.error ?? "Redirects state is unavailable"), notice), { status: 500, csrf });
    }
    return htmlResponse(layout("Redirects", dashboardView(result.data), notice), { csrf });
  }
  if (req.method === "POST" && CHANGES[path]) {
    const body = await readMutation(req, 256 * 1024);
    if (body instanceof Response) return body;
    const result = await redirectsService.change(CHANGES[path]!, body);
    if (result.ok && result.data) return jsonResponse({ ...result, html: dashboardContent(result.data) });
    return jsonResponse(result, { status: 400 });
  }
  return jsonResponse({ ok: false, error: "not found" }, { status: 404 });
}

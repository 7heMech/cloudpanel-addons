import { MEMORY_ERROR, memoryChange } from "../memory";
import {
  errorBlock, guardMutation, validateDomain, htmlResponse, jsonResponse, newCsrfToken, readBody,
} from "../../../lib/app-http";
import { resourceLimitsService } from "./service";
import { dashboardView, layout, siteCardHtml } from "./views";

async function change(result: Awaited<ReturnType<typeof resourceLimitsService.assign>>): Promise<Response> {
  if (!result.ok || !result.data) return jsonResponse(result, 400);
  return jsonResponse({ ...result, html: dashboardView(result.data) });
}

export async function handle(
  req: Request,
  path: string,
  updateNotice?: { current: string; latest: string } | null,
): Promise<Response> {
  const method = req.method;
  const url = new URL(req.url);

  if (method === "GET" && path === "/") {
    const csrf = newCsrfToken();
    try {
      const result = await resourceLimitsService.state();
      if (!result.ok || !result.data) throw new Error(result.error ?? "PHP pool settings are unavailable");
      return htmlResponse(layout("Resource Limits", dashboardView(result.data), updateNotice), { csrf });
    } catch (error) {
      return htmlResponse(layout("Resource Limits", errorBlock(error), updateNotice), { status: 500, csrf });
    }
  }

  // What CloudPanel's own site Settings tab shows: the limits one site ended up
  // with, as markup in the panel's classes. Read-only, so no CSRF cookie and no
  // mutation ever reaches this route.
  if (method === "GET" && path === "/site-card") {
    const domain = validateDomain(url.searchParams.get("domain") ?? "");
    if (!domain) return jsonResponse({ ok: false, error: "that is not a valid hostname" }, 400);
    const result = await resourceLimitsService.site(domain);
    if (!result.ok || !result.data) return jsonResponse({ ok: false, error: result.error ?? "unavailable" }, 404);
    return jsonResponse({ ok: true, html: siteCardHtml(result.data) });
  }

  if (method !== "POST") return jsonResponse({ ok: false, error: "not found" }, 404);
  const denied = guardMutation(req);
  if (denied) return denied;

  const body = await readBody(req, 256 * 1024);
  if (body instanceof Response) return body;

  if (path === "/api/memory") {
    const wanted = memoryChange(body);
    if (!wanted) return jsonResponse({ ok: false, error: MEMORY_ERROR }, 400);
    const saved = await resourceLimitsService.setMemory(wanted);
    if (!saved.ok) return jsonResponse(saved, 400);
    const result = await resourceLimitsService.state();
    if (!result.ok || !result.data) return jsonResponse(result, 400);
    return jsonResponse({ ...result, html: dashboardView(result.data) });
  }
  if (path === "/api/mysql-restart") {
    const restarted = await resourceLimitsService.restartMysql();
    // Refused or failed, the card is drawn again too, so it shows what MySQL is doing now.
    if (!restarted.ok) {
      const now = await resourceLimitsService.state();
      return jsonResponse({ ...restarted, data: now.ok && now.data ? { html: dashboardView(now.data) } : undefined }, 400);
    }
    const result = await resourceLimitsService.state();
    if (!result.ok || !result.data) return jsonResponse(result, 400);
    return jsonResponse({ ...result, html: dashboardView(result.data) });
  }
  if (path === "/api/categories") return change(await resourceLimitsService.saveCategory(body));
  if (path === "/api/categories/delete") return change(await resourceLimitsService.deleteCategory(body.id));
  if (path === "/api/assign") return change(await resourceLimitsService.assign(body.domains, body.categoryId));
  if (path === "/api/default") return change(await resourceLimitsService.setDefault(body.categoryId));

  return jsonResponse({ ok: false, error: "not found" }, 404);
}

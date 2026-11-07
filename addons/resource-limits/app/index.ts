import { errorMessage } from "../../../lib/errors";
import { MEMORY_ERROR, memoryChange } from "../memory";
import {
  guardMutation, htmlResponse, jsonResponse, newCsrfToken, readBody,
} from "../../../lib/app-http";
import { resourceLimitsService, validateDomain } from "./service";
import { dashboardView, layout, siteCardHtml } from "./views";

function json(body: unknown, status = 200): Response {
  return jsonResponse(body, { status });
}


/** Every change answers with the whole state, so they all reply the same way. */
async function change(result: Awaited<ReturnType<typeof resourceLimitsService.assign>>): Promise<Response> {
  if (!result.ok || !result.data) return json(result, 400);
  return json({ ...result, html: dashboardView(result.data) });
}

export async function handle(
  req: Request,
  path: string,
  updateNotice?: { current: string; latest: string } | null,
): Promise<Response> {
  const method = req.method;
  const url = new URL(req.url);

  if (path === "/health") return json({ ok: true, service: "resource-limits-manager" });

  if (method === "GET" && path === "/") {
    const csrf = newCsrfToken();
    try {
      const result = await resourceLimitsService.state();
      if (!result.ok || !result.data) throw new Error(result.error ?? "PHP pool settings are unavailable");
      return htmlResponse(layout("Resource Limits", dashboardView(result.data), updateNotice), { csrf });
    } catch (error) {
      const message = errorMessage(error);
      return htmlResponse(
        layout("Resource Limits", `<div class="alert" role="alert">${Bun.escapeHTML(message)}</div>`, updateNotice),
        { status: 500, csrf },
      );
    }
  }

  // What CloudPanel's own site Settings tab shows: the limits one site ended up
  // with, as markup in the panel's classes. Read-only, so no CSRF cookie and no
  // mutation ever reaches this route.
  if (method === "GET" && path === "/site-card") {
    const domain = validateDomain(url.searchParams.get("domain") ?? "");
    if (!domain) return json({ ok: false, error: "that is not a valid hostname" }, 400);
    const result = await resourceLimitsService.site(domain);
    if (!result.ok || !result.data) return json({ ok: false, error: result.error ?? "unavailable" }, 404);
    return json({ ok: true, html: siteCardHtml(result.data) });
  }

  if (method !== "POST") return json({ ok: false, error: "not found" }, 404);
  const denied = guardMutation(req);
  if (denied) return denied;

  const body = await readBody(req, 256 * 1024);
  if (body instanceof Response) return body;

  if (path === "/api/memory") {
    const wanted = memoryChange(body);
    if (!wanted) return json({ ok: false, error: MEMORY_ERROR }, 400);
    const saved = await resourceLimitsService.setMemory(wanted);
    if (!saved.ok) return json(saved, 400);
    const result = await resourceLimitsService.state();
    if (!result.ok || !result.data) return json(result, 400);
    return json({ ...result, html: dashboardView(result.data) });
  }
  if (path === "/api/categories") return change(await resourceLimitsService.saveCategory(body));
  if (path === "/api/categories/delete") return change(await resourceLimitsService.deleteCategory(body.id));
  if (path === "/api/assign") return change(await resourceLimitsService.assign(body.domains, body.categoryId));
  if (path === "/api/default") return change(await resourceLimitsService.setDefault(body.categoryId));

  return json({ ok: false, error: "not found" }, 404);
}

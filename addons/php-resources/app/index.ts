import {
  bodyErrorResponse, guardMutation, htmlResponse, jsonResponse, newCsrfToken, readJsonObject,
} from "../../../lib/app-http";
import { phpResourcesService, validateDomain } from "./service";
import { dashboardView, layout, siteCardHtml } from "./views";

function json(body: unknown, status = 200): Response {
  return jsonResponse(body, { status });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Every change answers with the whole state, so they all reply the same way. */
async function change(result: Awaited<ReturnType<typeof phpResourcesService.assign>>): Promise<Response> {
  return json(result, result.ok ? 200 : 400);
}

export async function handle(
  req: Request,
  path: string,
  updateNotice?: { current: string; latest: string } | null,
): Promise<Response> {
  const method = req.method;
  const url = new URL(req.url);

  if (path === "/health") return json({ ok: true, service: "php-resources-manager" });

  if (method === "GET" && path === "/") {
    const csrf = newCsrfToken();
    try {
      const result = await phpResourcesService.state();
      if (!result.ok || !result.data) throw new Error(result.error ?? "PHP pool settings are unavailable");
      return htmlResponse(layout("PHP resources", dashboardView(result.data), updateNotice), { csrf });
    } catch (error) {
      const message = errorMessage(error);
      return htmlResponse(
        layout("PHP resources", `<div class="alert" role="alert">${Bun.escapeHTML(message)}</div>`, updateNotice),
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
    const result = await phpResourcesService.site(domain);
    if (!result.ok || !result.data) return json({ ok: false, error: result.error ?? "unavailable" }, 404);
    return json({ ok: true, html: siteCardHtml(result.data) });
  }

  if (method !== "POST") return json({ ok: false, error: "not found" }, 404);
  const denied = guardMutation(req);
  if (denied) return denied;

  let body: Record<string, unknown>;
  try {
    body = await readJsonObject(req, 256 * 1024);
  } catch (error) {
    return bodyErrorResponse(error);
  }

  if (path === "/api/categories") return change(await phpResourcesService.saveCategory(body));
  if (path === "/api/categories/delete") return change(await phpResourcesService.deleteCategory(body.id));
  if (path === "/api/assign") return change(await phpResourcesService.assign(body.domains, body.categoryId));
  if (path === "/api/default") return change(await phpResourcesService.setDefault(body.categoryId));

  return json({ ok: false, error: "not found" }, 404);
}

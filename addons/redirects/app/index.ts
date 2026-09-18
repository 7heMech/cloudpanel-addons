import {
  bodyErrorResponse, guardMutation, htmlResponse, jsonResponse, newCsrfToken, readJsonObject,
} from "../../../lib/app-http";
import { redirectsService, validateDomain, type RedirectRequest } from "./service";
import { fleetView, layout, siteCardHtml } from "./views";

function json(body: unknown, status = 200): Response {
  return jsonResponse(body, { status });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function handle(
  req: Request,
  path: string,
  updateNotice?: { current: string; latest: string } | null,
): Promise<Response> {
  const url = new URL(req.url);

  if (req.method === "GET" && path === "/health") return json({ ok: true, service: "redirects-manager" });

  if (req.method === "GET" && path === "/") {
    const csrf = newCsrfToken();
    try {
      const result = await redirectsService.state();
      if (!result.ok || !result.data) throw new Error(result.error ?? "the redirects are unavailable");
      return htmlResponse(layout("Redirects", fleetView(result.data), updateNotice), { csrf });
    } catch (error) {
      return htmlResponse(
        layout("Redirects", `<div class="alert" role="alert">${Bun.escapeHTML(errorMessage(error))}</div>`, updateNotice),
        { status: 500, csrf },
      );
    }
  }

  // What CloudPanel's own site Settings tab shows: where this one site sends
  // its visitors. Read-only, and absent for a site that has no redirect, so the
  // card stays hidden everywhere else.
  if (req.method === "GET" && path === "/site-card") {
    const domain = validateDomain(url.searchParams.get("domain") ?? "");
    if (!domain) return json({ ok: false, error: "that is not a valid hostname" }, 400);
    const result = await redirectsService.state();
    if (!result.ok || !result.data) return json({ ok: false, error: result.error ?? "unavailable" }, 500);
    const redirect = result.data.redirects.find((item) => item.domain === domain);
    if (!redirect) return json({ ok: false, error: "not a redirect site" }, 404);
    return json({ ok: true, html: siteCardHtml(redirect) });
  }

  if (req.method !== "POST") return json({ ok: false, error: "not found" }, 404);
  const denied = guardMutation(req);
  if (denied) return denied;

  let body: Record<string, unknown>;
  try {
    body = await readJsonObject(req);
  } catch (error) {
    return bodyErrorResponse(error);
  }

  const domain = validateDomain(body.domain);
  if (!domain) return json({ ok: false, error: "that is not a valid hostname" }, 400);

  if (path === "/api/redirects/clear") {
    const result = await redirectsService.clear(domain);
    return json(result, result.ok ? 200 : 400);
  }
  if (path === "/api/redirects" || path === "/api/redirects/create") {
    const request = body as unknown as RedirectRequest;
    const result = path === "/api/redirects/create"
      ? await redirectsService.create(domain, request)
      : await redirectsService.set(domain, request);
    return json(result, result.ok ? 200 : 400);
  }

  return json({ ok: false, error: "not found" }, 404);
}

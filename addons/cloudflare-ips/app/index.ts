import {
  errorBlock, htmlResponse, jsonResponse, newCsrfToken, readMutation,
} from "../../../lib/app-http";
import { cloudflareService } from "./service";
import { dashboardView, layout } from "./views";


function validMutationBody(body: unknown): body is { enabled: boolean } {
  return typeof body === "object" && body !== null && typeof (body as { enabled?: unknown }).enabled === "boolean";
}

export async function handle(
  req: Request,
  path: string,
  updateNotice?: { current: string; latest: string } | null,
): Promise<Response> {
  if (req.method === "GET" && path === "/") {
    const csrf = newCsrfToken();
    try {
      const result = await cloudflareService.state();
      if (!result.ok || !result.data) throw new Error(result.error ?? "Cloudflare site state is unavailable");
      return htmlResponse(layout("Cloudflare IP Access", dashboardView(result.data), updateNotice), { csrf });
    } catch (error) {
      return htmlResponse(layout("Cloudflare IP Access", errorBlock(error), updateNotice), { status: 500, csrf });
    }
  }

  if (req.method === "GET" && path === "/api/sites") {
    const result = await cloudflareService.state();
    return jsonResponse(result.ok && result.data ? { ...result, html: dashboardView(result.data) } : result, result.ok ? 200 : 500);
  }

  if (req.method === "POST" && path === "/api/sites") {
    const body = await readMutation(req);
    if (body instanceof Response) return body;
    const values = body as { domains?: unknown; enabled?: unknown };
    if (!Array.isArray(values.domains) || values.domains.length === 0 ||
        !values.domains.every((domain: unknown) => typeof domain === "string") || typeof values.enabled !== "boolean") {
      return jsonResponse({ ok: false, error: "domains must be a non-empty string array and enabled must be boolean" }, 400);
    }
    const result = await cloudflareService.setSites(values.domains, values.enabled);
    return jsonResponse(result, result.ok ? 200 : 400);
  }

  if (req.method === "POST" && path === "/api/policy") {
    const body = await readMutation(req);
    if (body instanceof Response) return body;
    if (!validMutationBody(body)) return jsonResponse({ ok: false, error: "enabled must be boolean" }, 400);
    const result = await cloudflareService.setAutomatic(body.enabled);
    return jsonResponse(result, result.ok ? 200 : 400);
  }

  return jsonResponse({ ok: false, error: "not found" }, 404);
}

import {
  bodyErrorResponse, guardMutation, htmlResponse, jsonResponse, newCsrfToken, readJsonObject,
} from "../../../lib/app-http";
import { cloudflareService } from "./service";
import { dashboardView, layout } from "./views";

function html(body: string, csrf: string, status = 200): Response {
  return htmlResponse(body, { status, csrf });
}

function json(body: unknown, status = 200): Response {
  return jsonResponse(body, { status });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validMutationBody(body: unknown): body is { enabled: boolean } {
  return typeof body === "object" && body !== null && typeof (body as { enabled?: unknown }).enabled === "boolean";
}

export async function handle(
  req: Request,
  path: string,
  updateNotice?: { current: string; latest: string } | null,
): Promise<Response> {
  if (req.method === "GET" && path === "/health") return json({ ok: true, service: "cloudflare-ips-manager" });

  if (req.method === "GET" && path === "/") {
    const csrf = newCsrfToken();
    try {
      const result = await cloudflareService.state();
      if (!result.ok || !result.data) throw new Error(result.error ?? "Cloudflare site state is unavailable");
      return html(layout("Cloudflare IP access", dashboardView(result.data), updateNotice), csrf);
    } catch (error) {
      return html(layout("Cloudflare IP access", `<div class="alert" role="alert">${Bun.escapeHTML(errorMessage(error))}</div>`, updateNotice), csrf, 500);
    }
  }

  if (req.method === "GET" && path === "/api/sites") {
    const result = await cloudflareService.state();
    return json(result, result.ok ? 200 : 500);
  }

  if (req.method === "POST" && path === "/api/sites") {
    const denied = guardMutation(req);
    if (denied) return denied;
    let body: Record<string, unknown>;
    try { body = await readJsonObject(req); } catch (error) { return bodyErrorResponse(error); }
    const values = body as { domains?: unknown; enabled?: unknown };
    if (!Array.isArray(values.domains) || values.domains.length === 0 ||
        !values.domains.every((domain: unknown) => typeof domain === "string") || typeof values.enabled !== "boolean") {
      return json({ ok: false, error: "domains must be a non-empty string array and enabled must be boolean" }, 400);
    }
    const result = await cloudflareService.setSites(values.domains, values.enabled);
    return json(result, result.ok ? 200 : 400);
  }

  if (req.method === "POST" && path === "/api/policy") {
    const denied = guardMutation(req);
    if (denied) return denied;
    let body: Record<string, unknown>;
    try { body = await readJsonObject(req); } catch (error) { return bodyErrorResponse(error); }
    if (!validMutationBody(body)) return json({ ok: false, error: "enabled must be boolean" }, 400);
    const result = await cloudflareService.setAutomatic(body.enabled);
    return json(result, result.ok ? 200 : 400);
  }

  return json({ ok: false, error: "not found" }, 404);
}

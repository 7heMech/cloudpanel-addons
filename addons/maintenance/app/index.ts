import { isIP } from "node:net";
import { csrfCookieHeader, guardMutation, newCsrfToken, SECURITY_HEADERS } from "../../../lib/app-http";
import { fleetView, layout, siteView } from "./views";
import { maintenanceService, validateDomain } from "./service";
import { MAX_BYPASS_IPS, MAX_TEMPLATE_BYTES } from "../action";

const PREVIEW_CSP = SECURITY_HEADERS["Content-Security-Policy"] + "; frame-src 'self' blob:";

function html(body: string, csrf: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Set-Cookie": csrfCookieHeader(csrf),
      ...SECURITY_HEADERS,
      "Content-Security-Policy": PREVIEW_CSP,
    },
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...SECURITY_HEADERS },
  });
}

async function jsonBody(req: Request, maxBytes: number): Promise<Record<string, unknown>> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("request body is too large");
  const text = await req.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Error("request body is too large");
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("body must be a JSON object");
  return parsed as Record<string, unknown>;
}

function clientIp(req: Request): string {
  const candidate = (req.headers.get("x-real-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0] ?? "").trim();
  return isIP(candidate) ? candidate : "";
}

function decodedDomain(raw: string): string | null {
  try { return validateDomain(decodeURIComponent(raw)); }
  catch { return null; }
}

export async function handle(
  req: Request,
  path: string,
  updateNotice?: { current: string; latest: string } | null,
): Promise<Response> {
  const method = req.method;
  const url = new URL(req.url);

  if (path === "/health") return json({ ok: true, service: "maintenance-manager" });

  if (method === "GET" && path === "/") {
    const csrf = newCsrfToken();
    const selected = url.searchParams.get("domain");
    try {
      if (!selected) return html(layout("Maintenance Mode", fleetView(await maintenanceService.listSites()), updateNotice), csrf);
      const domain = validateDomain(selected);
      if (!domain) return html(layout("Invalid site", '<div class="alert">That is not a valid hostname.</div>', updateNotice), csrf, 400);
      const [site, template] = await Promise.all([maintenanceService.site(domain), maintenanceService.template(domain)]);
      if (!template.ok || !template.data) throw new Error(template.error ?? "maintenance template unavailable");
      return html(layout(`Maintenance — ${domain}`, siteView(site, template.data, clientIp(req)), updateNotice), csrf);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = /not found/i.test(message) ? 404 : 500;
      return html(layout("Maintenance Mode", `<div class="alert">${Bun.escapeHTML(message)}</div>`, updateNotice), csrf, status);
    }
  }

  if (method === "POST" && (path === "/api/sites/toggle" || path === "/api/toggle-all" || path === "/api/bulk-toggle")) {
    const denied = guardMutation(req);
    if (denied) return denied;
    try {
      const body = await jsonBody(req, 16 * 1024);
      if (typeof body.enabled !== "boolean") return json({ ok: false, error: "enabled must be a boolean" }, 400);
      let domains: string[] | undefined;
      if (body.domains !== undefined) {
        if (!Array.isArray(body.domains)) return json({ ok: false, error: "domains must be an array" }, 400);
        domains = [];
        for (const raw of body.domains) {
          const decoded = typeof raw === "string" ? decodedDomain(raw) : null;
          if (decoded === null) return json({ ok: false, error: `invalid domain in domains list: ${raw}` }, 400);
          domains.push(decoded);
        }
      }
      const result = await maintenanceService.setAllEnabled(body.enabled, domains);
      return json(result, 200);
    } catch (error) {
      const message = error instanceof SyntaxError ? "body must be valid JSON" : error instanceof Error ? error.message : String(error);
      return json({ ok: false, error: message }, 400);
    }
  }

  const route = path.match(/^\/api\/sites\/([^/]+)\/(toggle|template|bypasses)$/);
  if (route && ["POST", "PUT", "DELETE"].includes(method)) {
    const denied = guardMutation(req);
    if (denied) return denied;
    const domain = decodedDomain(route[1]!);
    if (!domain) return json({ ok: false, error: "invalid domain" }, 400);
    try {
      let result;
      if (route[2] === "toggle" && method === "POST") {
        const body = await jsonBody(req, 1024);
        if (typeof body.enabled !== "boolean") return json({ ok: false, error: "enabled must be a boolean" }, 400);
        result = await maintenanceService.setEnabled(domain, body.enabled);
      } else if (route[2] === "template" && method === "PUT") {
        const body = await jsonBody(req, MAX_TEMPLATE_BYTES * 6 + 1024);
        if (typeof body.html !== "string") return json({ ok: false, error: "html must be a string" }, 400);
        if (Buffer.byteLength(body.html, "utf8") > MAX_TEMPLATE_BYTES) {
          return json({ ok: false, error: `html may be at most ${MAX_TEMPLATE_BYTES} bytes` }, 400);
        }
        result = await maintenanceService.setTemplate(domain, body.html);
      } else if (route[2] === "template" && method === "DELETE") {
        result = await maintenanceService.resetTemplate(domain);
      } else if (route[2] === "bypasses" && method === "PUT") {
        const body = await jsonBody(req, 16 * 1024);
        if (!Array.isArray(body.ips) || body.ips.length > MAX_BYPASS_IPS || body.ips.some((ip) => typeof ip !== "string")) {
          return json({ ok: false, error: `ips must contain at most ${MAX_BYPASS_IPS} addresses` }, 400);
        }
        result = await maintenanceService.setBypasses(domain, body.ips as string[]);
      } else {
        return json({ ok: false, error: "method not allowed" }, 405);
      }
      return json(result, result.ok ? 200 : 400);
    } catch (error) {
      const message = error instanceof SyntaxError ? "body must be valid JSON" : error instanceof Error ? error.message : String(error);
      return json({ ok: false, error: message }, 400);
    }
  }

  return json({ ok: false, error: "not found" }, 404);
}

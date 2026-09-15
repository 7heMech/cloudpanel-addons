import { isIP } from "node:net";
import { guardMutation, newCsrfToken, withCsrfCookie, SECURITY_HEADERS } from "../../../lib/app-http";
import { fleetView, fragment, layout, siteView } from "./views";
import { embedLandingUrl } from "../../../lib/shadow-embed";
import ACE_MODE_HTML from "./ace-mode-html.js" with { type: "text" };
import { maintenanceService, validateDomain } from "./service";
import { MAX_BYPASS_IPS, MAX_TEMPLATE_BYTES } from "../action";

const PREVIEW_CSP = SECURITY_HEADERS["Content-Security-Policy"] + "; frame-src 'self' blob:";

function html(body: string, csrf: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: withCsrfCookie({
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      ...SECURITY_HEADERS,
      "Content-Security-Policy": PREVIEW_CSP,
    }, csrf),
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...SECURITY_HEADERS },
  });
}

// A fragment is the first thing an operator who came straight from a site page
// loads from this addon, so it carries the CSRF cookie its own actions echo.
function fragmentJson(body: unknown, csrf: string, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: withCsrfCookie({
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...SECURITY_HEADERS,
    }, csrf),
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

  // The Ace module the panel does not ship, matching the core that it does.
  // Immutable: it is one pinned file, and the editor asks for it on every open.
  if (method === "GET" && path === "/ace/mode-html.js") {
    return new Response(ACE_MODE_HTML, {
      headers: {
        "Content-Type": "text/javascript; charset=utf-8",
        "Cache-Control": "public, max-age=31536000, immutable",
        ...SECURITY_HEADERS,
      },
    });
  }

  if (method === "GET" && path === "/") {
    const csrf = newCsrfToken();
    const selected = url.searchParams.get("domain");
    // A site-scoped page belongs to the panel's site page. Send a direct visit
    // there and let the injected loader pull this page into it; ?embed=0 keeps
    // the standalone page. Deciding this needs no panel state, so it happens
    // before anything is read.
    if (selected && url.searchParams.get("embed") !== "0") {
      const target = validateDomain(selected);
      if (target) {
        return new Response(null, {
          status: 302,
          headers: { Location: embedLandingUrl(target, "maintenance"), "Cache-Control": "no-store", ...SECURITY_HEADERS },
        });
      }
    }
    try {
      const globalEnabled = await maintenanceService.globalStatus();
      if (!selected) return html(layout("Maintenance Mode", fleetView(await maintenanceService.listSites(), globalEnabled), updateNotice), csrf);
      const domain = validateDomain(selected);
      if (!domain) return html(layout("Invalid site", '<div class="alert">That is not a valid hostname.</div>', updateNotice), csrf, 400);
      const [page, template] = await Promise.all([maintenanceService.site(domain), maintenanceService.template(domain)]);
      if (!template.ok || !template.data) throw new Error(template.error ?? "maintenance template unavailable");
      return html(
        layout(
          `Maintenance — ${domain}`,
          siteView(page.site, template.data, clientIp(req), globalEnabled),
          updateNotice,
          page.context,
        ),
        csrf,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = /not found/i.test(message) ? 404 : 500;
      return html(layout("Maintenance Mode", `<div class="alert">${Bun.escapeHTML(message)}</div>`, updateNotice), csrf, status);
    }
  }

  // The same page as GET /?domain=, without a document around it, for the
  // loader injected into CloudPanel's site pages.
  if (method === "GET" && path === "/fragment") {
    const csrf = newCsrfToken();
    const domain = validateDomain(url.searchParams.get("domain") ?? "");
    if (!domain) return json({ ok: false, error: "that is not a valid hostname" }, 400);
    try {
      const globalEnabled = await maintenanceService.globalStatus();
      const [page, template] = await Promise.all([maintenanceService.site(domain), maintenanceService.template(domain)]);
      if (!template.ok || !template.data) throw new Error(template.error ?? "maintenance template unavailable");
      return fragmentJson(
        fragment(`Maintenance — ${domain}`, siteView(page.site, template.data, clientIp(req), globalEnabled)),
        csrf,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return json({ ok: false, error: message }, /not found/i.test(message) ? 404 : 500);
    }
  }

  if (method === "POST" && path === "/api/global-toggle") {
    const denied = guardMutation(req);
    if (denied) return denied;
    try {
      const body = await jsonBody(req, 1024);
      if (typeof body.enabled !== "boolean") return json({ ok: false, error: "enabled must be a boolean" }, 400);
      const result = await maintenanceService.setGlobalEnabled(body.enabled);
      if (!result.ok) return json({ ok: false, error: result.error ?? "failed to toggle global maintenance" }, 500);
      return json({ ok: true, data: { global: body.enabled } }, 200);
    } catch (error) {
      const message = error instanceof SyntaxError ? "body must be valid JSON" : error instanceof Error ? error.message : String(error);
      return json({ ok: false, error: message }, 400);
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

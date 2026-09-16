import { isIP } from "node:net";
import {
  SECURITY_HEADERS, bodyErrorResponse, guardMutation, htmlResponse, jsonResponse, newCsrfToken,
  policyResponse, readJsonObject, redirectResponse, safeDecodePathSegment,
} from "../../../lib/app-http";
import { fleetView, fragment, layout, siteView } from "./views";
import { embedLandingUrl } from "../../../lib/shadow-embed";
import ACE_MODE_HTML from "./ace-mode-html.js" with { type: "text" };
import { maintenanceService, validateDomain } from "./service";
import { MAX_BYPASS_IPS, MAX_TEMPLATE_BYTES } from "../action";

const PREVIEW_CSP = SECURITY_HEADERS["Content-Security-Policy"] + "; frame-src 'self' blob:";

function html(body: string, csrf: string, status = 200): Response {
  // This addon renders a template preview into a blob: iframe, which the shared
  // policy's CSP does not allow; the override is the point of passing headers.
  return htmlResponse(body, { status, csrf, headers: { "Content-Security-Policy": PREVIEW_CSP } });
}

function json(body: unknown, status = 200): Response {
  return jsonResponse(body, { status });
}

// A fragment is the first thing an operator who came straight from a site page
// loads from this addon, so it carries the CSRF cookie its own actions echo.
function fragmentJson(body: unknown, csrf: string, status = 200): Response {
  return jsonResponse(body, { status, csrf });
}

function clientIp(req: Request): string {
  const candidate = (req.headers.get("x-real-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0] ?? "").trim();
  return isIP(candidate) ? candidate : "";
}

function decodedDomain(raw: string): string | null {
  const decoded = safeDecodePathSegment(raw);
  return decoded === null ? null : validateDomain(decoded);
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
    // Immutable, content-addressed by its route: the one place a no-store
    // default is deliberately overridden rather than inherited.
    return policyResponse(ACE_MODE_HTML, "text/javascript; charset=utf-8", {
      headers: { "Cache-Control": "public, max-age=31536000, immutable" },
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
        return redirectResponse(embedLandingUrl(target, "maintenance"));
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
    let body: Record<string, unknown>;
    try { body = await readJsonObject(req, 1024); } catch (error) { return bodyErrorResponse(error); }
    if (typeof body.enabled !== "boolean") return json({ ok: false, error: "enabled must be a boolean" }, 400);
    const result = await maintenanceService.setGlobalEnabled(body.enabled);
    if (!result.ok) return json({ ok: false, error: result.error ?? "failed to toggle global maintenance" }, 500);
    return json({ ok: true, data: { global: body.enabled } }, 200);
  }

  if (method === "POST" && (path === "/api/sites/toggle" || path === "/api/toggle-all" || path === "/api/bulk-toggle")) {
    const denied = guardMutation(req);
    if (denied) return denied;
    let body: Record<string, unknown>;
    try { body = await readJsonObject(req, 16 * 1024); } catch (error) { return bodyErrorResponse(error); }
    if (typeof body.enabled !== "boolean") return json({ ok: false, error: "enabled must be a boolean" }, 400);
    let domains: string[] | undefined;
    if (body.domains !== undefined) {
      if (!Array.isArray(body.domains)) return json({ ok: false, error: "domains must be an array" }, 400);
      domains = [];
      for (const raw of body.domains as unknown[]) {
        const decoded = typeof raw === "string" ? decodedDomain(raw) : null;
        if (decoded === null) return json({ ok: false, error: `invalid domain in domains list: ${raw}` }, 400);
        domains.push(decoded);
      }
    }
    return json(await maintenanceService.setAllEnabled(body.enabled, domains), 200);
  }

  const route = path.match(/^\/api\/sites\/([^/]+)\/(toggle|template|bypasses)$/);
  if (route && ["POST", "PUT", "DELETE"].includes(method)) {
    const denied = guardMutation(req);
    if (denied) return denied;
    const domain = decodedDomain(route[1]!);
    if (!domain) return json({ ok: false, error: "invalid domain" }, 400);
    let result;
    if (route[2] === "toggle" && method === "POST") {
      let body: Record<string, unknown>;
      try { body = await readJsonObject(req, 1024); } catch (error) { return bodyErrorResponse(error); }
      if (typeof body.enabled !== "boolean") return json({ ok: false, error: "enabled must be a boolean" }, 400);
      result = await maintenanceService.setEnabled(domain, body.enabled);
    } else if (route[2] === "template" && method === "PUT") {
      let body: Record<string, unknown>;
      try { body = await readJsonObject(req, MAX_TEMPLATE_BYTES * 6 + 1024); }
      catch (error) { return bodyErrorResponse(error); }
      if (typeof body.html !== "string") return json({ ok: false, error: "html must be a string" }, 400);
      if (Buffer.byteLength(body.html, "utf8") > MAX_TEMPLATE_BYTES) {
        return json({ ok: false, error: `html may be at most ${MAX_TEMPLATE_BYTES} bytes` }, 400);
      }
      result = await maintenanceService.setTemplate(domain, body.html);
    } else if (route[2] === "template" && method === "DELETE") {
      result = await maintenanceService.resetTemplate(domain);
    } else if (route[2] === "bypasses" && method === "PUT") {
      let body: Record<string, unknown>;
      try { body = await readJsonObject(req, 16 * 1024); } catch (error) { return bodyErrorResponse(error); }
      const ips = body.ips;
      if (!Array.isArray(ips) || ips.length > MAX_BYPASS_IPS || ips.some((ip: unknown) => typeof ip !== "string")) {
        return json({ ok: false, error: `ips must contain at most ${MAX_BYPASS_IPS} addresses` }, 400);
      }
      result = await maintenanceService.setBypasses(domain, ips as string[]);
    } else {
      return json({ ok: false, error: "method not allowed" }, 405);
    }
    return json(result, result.ok ? 200 : 400);
  }

  return json({ ok: false, error: "not found" }, 404);
}

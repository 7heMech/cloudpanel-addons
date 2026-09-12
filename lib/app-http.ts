// Request guards shared by every addon's manager app.
//
// Authentication at the shared manager boundary belongs to lib/sso-auth. These
// guards protect mutating addon routes after the request has passed SSO: a
// same-origin check and a CSRF token stop cross-origin browser requests.

import { randomBytes, timingSafeEqual } from "node:crypto";

const CSRF_COOKIE = "clp_addons_csrf";
const CSRF_HEADER = "x-clp-addons-csrf";

export function newCsrfToken(): string {
  return randomBytes(32).toString("base64url");
}

function readCookie(req: Request, name: string): string | null {
  return new Bun.CookieMap(req.headers.get("cookie") ?? "").get(name);
}

function constantTimeEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  // Compare lengths first; timingSafeEqual throws on a mismatch.
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function csrfCookieHeader(token: string): string {
  // Not HttpOnly on purpose: the page's own script has to read it to echo it
  // back in the header. That is what makes the double-submit check work, and
  // it is safe because a cross-origin page cannot read another origin's cookie.
  return `${CSRF_COOKIE}=${token}; Path=/addons; SameSite=Strict; Secure`;
}

/** Returns null when the request may proceed, or a Response to send instead. */
export function guardMutation(req: Request): Response | null {
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");

  // A same-origin fetch from our own page always sends Origin. Its absence on a
  // state-changing request means something other than that page is calling.
  if (!origin) {
    return Response.json({ ok: false, error: "missing Origin header" }, { status: 403 });
  }
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return Response.json({ ok: false, error: "malformed Origin header" }, { status: 403 });
  }

  if (originUrl.protocol !== "https:" && originUrl.hostname !== "localhost" && originUrl.hostname !== "127.0.0.1") {
    return Response.json({ ok: false, error: "HTTPS Origin required" }, { status: 403 });
  }

  if (!host) {
    return Response.json({ ok: false, error: "cross-origin request refused" }, { status: 403 });
  }

  let hostUrl: URL;
  try {
    hostUrl = new URL(`https://${host}`);
  } catch {
    return Response.json({ ok: false, error: "cross-origin request refused" }, { status: 403 });
  }

  // Cross-port Origin validation:
  // Cookies share domain scope across ports (RFC 6265). A tenant website hosted on
  // the same server (e.g. port 80/443) must not be allowed to forge mutations against
  // CloudPanel on port 8443.
  //
  // Exact match covers:
  // - Host with explicit port: originUrl.host === hostUrl.host (e.g. "panel.example:8443")
  // - Host with default port: originUrl.host === hostUrl.host (e.g. "panel.example")
  //
  // If the reverse proxy stripped the :8443 port in the Host header, we accept
  // only if origin specifies :8443 and host is the bare hostname without port.
  const exactMatch = originUrl.host === hostUrl.host;
  const strippedPortProxy = hostUrl.port === "" && originUrl.port === "8443" && originUrl.hostname === hostUrl.hostname;
  if (!exactMatch && !strippedPortProxy) {
    return Response.json({ ok: false, error: "cross-origin request refused" }, { status: 403 });
  }

  const sent = req.headers.get(CSRF_HEADER);
  const cookie = readCookie(req, CSRF_COOKIE);
  if (!sent || !cookie || !constantTimeEquals(sent, cookie)) {
    // The cookie is set Secure, so a browser on plain http never stores it.
    return Response.json({
      ok: false,
      error: cookie
        ? "CSRF token mismatched; reload the page and try again"
        : "CSRF cookie missing. It is set Secure, so use the CloudPanel HTTPS URL.",
    }, { status: 403 });
  }

  return null;
}

/** Escape for interpolation into HTML text or a double-quoted attribute. */
export function esc(value: unknown): string {
  return Bun.escapeHTML(String(value));
}

/**
 * Escape for interpolation into a single-quoted JavaScript string literal.
 *
 * The `"` case is not decoration. These literals are emitted inside `onclick`
 * and friends, so the string sits within a double-quoted HTML attribute, and
 * JSON.stringify renders a quote as the two characters `\"` -- a backslash,
 * which HTML does not read, followed by a quote, which closes the attribute.
 * Escaping it as \u0022 keeps it a quote to JavaScript and nothing at all to
 * the HTML parser. No caller can reach it today, because the domain and tag
 * patterns forbid a quote, but the function is the thing that promises safety.
 */
export function escJs(value: unknown): string {
  return JSON.stringify(String(value))
    .slice(1, -1)
    .replaceAll('\\"', "\\u0022")
    .replaceAll("'", "\\'")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
}

export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
};

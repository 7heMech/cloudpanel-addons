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

/**
 * Expiry for the `/addons`-scoped cookie an older release set.
 *
 * A cookie's identity is its name, domain and path, so the panel-wide cookie
 * does not replace it: after an upgrade a browser holds both, and sends both
 * under `/addons`, longest path first. The server reads the first, which is the
 * stale one, while a page mounted in a panel route can only see the new one --
 * every action would be refused as a mismatch until the browser closed.
 * Expiring a cookie that is not there does nothing, so this is sent always.
 */
const LEGACY_CSRF_EXPIRY = `${CSRF_COOKIE}=; Path=/addons; Max-Age=0; SameSite=Strict; Secure`;

/** Response headers with the CSRF cookie set and the superseded one expired. */
export function withCsrfCookie(headers: Record<string, string>, token: string): Headers {
  const out = new Headers(headers);
  out.append("Set-Cookie", csrfCookieHeader(token));
  out.append("Set-Cookie", LEGACY_CSRF_EXPIRY);
  return out;
}

export function csrfCookieHeader(token: string): string {
  // Not HttpOnly on purpose: the page's own script has to read it to echo it
  // back in the header. That is what makes the double-submit check work, and
  // it is safe because a cross-origin page cannot read another origin's cookie.
  //
  // Path is the whole panel, not /addons: an addon page mounted into one of
  // CloudPanel's own site pages runs at that page's path, and a cookie scoped
  // to /addons is invisible to it, so every mutation from there would be
  // refused. Path scoping is not what protects this cookie -- the panel is one
  // origin, so any panel page could read it at any path -- SameSite and the
  // same-origin check are.
  return `${CSRF_COOKIE}=${token}; Path=/; SameSite=Strict; Secure`;
}

/**
 * What every response from an addon gets unless it deliberately says otherwise.
 *
 * `csrf` attaches the cookie pair `withCsrfCookie` sets: the panel-wide cookie
 * and the expiry for the `/addons`-scoped one an older release wrote.
 */
export interface ResponsePolicy {
  status?: number;
  headers?: Headers | Record<string, string> | [string, string][];
  csrf?: string;
}

/**
 * Build the headers for one response: content type, no-store, the security
 * headers, then whatever the caller asked for.
 *
 * Caller headers are merged through `new Headers(...)` rather than spread.
 * Spreading is what the addons did, and it silently produces `{}` for a Headers
 * instance and index keys for an array of pairs -- so a caller that passed
 * either would have got the defaults and quietly lost its own headers. Merging
 * last is also what lets a deliberate override through, such as Maintenance's
 * preview CSP or the year-long cache on the editor mode asset.
 */
export function policyHeaders(contentType: string | null, extra: Record<string, string> = {}): Headers {
  return buildHeaders(contentType, { headers: extra });
}

function buildHeaders(contentType: string | null, policy: ResponsePolicy): Headers {
  const headers = new Headers();
  if (contentType !== null) headers.set("Content-Type", contentType);
  headers.set("Cache-Control", "no-store");
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  // Set-Cookie is the one header a caller may legitimately send more than once,
  // and iterating a Headers instance joins its cookies into a single value that
  // `set` would then store as one. Take the rest by name and the cookies from
  // the accessor that keeps them apart.
  const extra = new Headers(policy.headers);
  for (const [name, value] of extra) {
    if (name.toLowerCase() !== "set-cookie") headers.set(name, value);
  }
  for (const cookie of extra.getSetCookie()) headers.append("Set-Cookie", cookie);
  if (policy.csrf !== undefined) {
    headers.append("Set-Cookie", csrfCookieHeader(policy.csrf));
    headers.append("Set-Cookie", LEGACY_CSRF_EXPIRY);
  }
  return headers;
}

/** A response with this project's header policy and an explicit content type. */
export function policyResponse(body: string | null, contentType: string, policy: ResponsePolicy = {}): Response {
  return new Response(body, { status: policy.status ?? 200, headers: buildHeaders(contentType, policy) });
}

export function htmlResponse(body: string, policy: ResponsePolicy = {}): Response {
  return policyResponse(body, "text/html; charset=utf-8", policy);
}

export function jsonResponse(body: unknown, policy: ResponsePolicy = {}): Response {
  return policyResponse(JSON.stringify(body), "application/json", policy);
}

/** A redirect carrying the same header policy and no body to type. */
export function redirectResponse(location: string, policy: ResponsePolicy = {}): Response {
  // Location is set on the built headers rather than folded into the caller's,
  // which would have had to flatten them into a record first and lost any
  // repeated Set-Cookie on the way.
  const headers = buildHeaders(null, policy);
  headers.set("Location", location);
  return new Response(null, { status: policy.status ?? 302, headers });
}

/**
 * A body this module refused to read, with the status that refusal deserves.
 *
 * Distinguishable from a handler's own failures on purpose: a catch-all that
 * turned an oversized body, a domain error and a server fault into the same
 * response would be telling the caller nothing.
 */
export class BodyError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "BodyError";
  }
}

/** Default ceiling for a request body. Callers with smaller limits pass them. */
export const MAX_BODY_BYTES = 64 * 1024;

/**
 * Read a request body as a JSON object, refusing anything larger than
 * `maxBytes`.
 *
 * The declared length is checked first so an oversized body can be refused
 * before a byte of it is read. That check alone is not enough: `Content-Length`
 * is absent on a chunked request and is in any case the caller's claim about
 * itself, and `await req.text()` would buffer the whole thing before anyone
 * could measure it. So the stream is counted as it arrives and abandoned the
 * moment it passes the limit.
 */
export async function readJsonObject(req: Request, maxBytes = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
  const declared = req.headers.get("content-length");
  if (declared !== null) {
    // RFC 9110 gives Content-Length as 1*DIGIT. Number() would take "0x40",
    // "1e3" and " 12 " as well, so the digits are checked before it is asked.
    if (!/^[0-9]+$/.test(declared)) throw new BodyError("malformed Content-Length", 400);
    if (Number(declared) > maxBytes) throw new BodyError("request body is too large", 413);
  }

  let text = "";
  const body = req.body;
  if (body) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) throw new BodyError("request body is too large", 413);
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      await reader.cancel().catch(() => {});
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BodyError("body must be valid JSON", 400);
  }
  // A generic type parameter here would only look like validation. What the
  // fields mean is the handler's question, and it stays there.
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BodyError("body must be a JSON object", 400);
  }
  return parsed as Record<string, unknown>;
}

/** The response a `BodyError` deserves; rethrows anything else. */
export function bodyErrorResponse(error: unknown): Response {
  if (error instanceof BodyError) return jsonResponse({ ok: false, error: error.message }, { status: error.status });
  throw error;
}

/**
 * Percent-decode one path segment, or null when the encoding is malformed.
 *
 * `decodeURIComponent` throws a URIError on a stray `%`, which a route that
 * called it directly turned into a 500 from the socket boundary rather than the
 * 400 a malformed request has earned. Anything that is not a URIError is a real
 * fault and is left to propagate.
 */
export function safeDecodePathSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch (error) {
    if (error instanceof URIError) return null;
    throw error;
  }
}

/** Returns null when the request may proceed, or a Response to send instead. */
export function guardMutation(req: Request): Response | null {
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");

  // A same-origin fetch from our own page always sends Origin. Its absence on a
  // state-changing request means something other than that page is calling.
  if (!origin) {
    return jsonResponse({ ok: false, error: "missing Origin header" }, { status: 403 });
  }
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return jsonResponse({ ok: false, error: "malformed Origin header" }, { status: 403 });
  }

  if (originUrl.protocol !== "https:" && originUrl.hostname !== "localhost" && originUrl.hostname !== "127.0.0.1") {
    return jsonResponse({ ok: false, error: "HTTPS Origin required" }, { status: 403 });
  }

  if (!host) {
    return jsonResponse({ ok: false, error: "cross-origin request refused" }, { status: 403 });
  }

  let hostUrl: URL;
  try {
    hostUrl = new URL(`https://${host}`);
  } catch {
    return jsonResponse({ ok: false, error: "cross-origin request refused" }, { status: 403 });
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
    return jsonResponse({ ok: false, error: "cross-origin request refused" }, { status: 403 });
  }

  const sent = req.headers.get(CSRF_HEADER);
  const cookie = readCookie(req, CSRF_COOKIE);
  if (!sent || !cookie || !constantTimeEquals(sent, cookie)) {
    // The cookie is set Secure, so a browser on plain http never stores it.
    return jsonResponse({
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

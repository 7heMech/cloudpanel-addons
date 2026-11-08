// These guards protect mutating addon routes after the request has passed SSO
// (lib/sso-auth): a same-origin check and a CSRF token stop cross-origin
// browser requests.

import { HOSTNAME_RE } from "./validate";
import { errorMessage } from "./errors";
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { secretEquals } from "./secret-equals";
import { normalizeMappedIpv4 } from "./ip-address";

const CSRF_COOKIE = "clp_addons_csrf";
const CSRF_HEADER = "x-clp-addons-csrf";

export function newCsrfToken(): string {
  return randomBytes(32).toString("base64url");
}

function readCookie(req: Request, name: string): string | null {
  return new Bun.CookieMap(req.headers.get("cookie") ?? "").get(name);
}

export function withCsrfCookie(headers: Record<string, string>, token: string): Headers {
  const out = new Headers(headers);
  out.append("Set-Cookie", csrfCookieHeader(token));
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

interface ResponsePolicy {
  status?: number;
  headers?: Headers | Record<string, string> | [string, string][];
  csrf?: string;
}

export function policyHeaders(contentType: string | null, extra: Record<string, string> = {}): Headers {
  return buildHeaders(contentType, { headers: extra });
}

function buildHeaders(contentType: string | null, policy: ResponsePolicy): Headers {
  const headers = new Headers();
  if (contentType !== null) headers.set("Content-Type", contentType);
  headers.set("Cache-Control", "no-store");
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  // Through `new Headers(...)`, because spreading yields `{}` for a Headers
  // instance and index keys for an array of pairs. Set-Cookie is the one header
  // a caller may legitimately send more than once, and iterating a Headers
  // instance joins its cookies into a single value that `set` would then store
  // as one.
  const extra = new Headers(policy.headers);
  for (const [name, value] of extra) {
    if (name.toLowerCase() !== "set-cookie") headers.set(name, value);
  }
  for (const cookie of extra.getSetCookie()) headers.append("Set-Cookie", cookie);
  if (policy.csrf !== undefined) {
    headers.append("Set-Cookie", csrfCookieHeader(policy.csrf));
  }
  return headers;
}

export function policyResponse(body: string | null, contentType: string, policy: ResponsePolicy | number = {}): Response {
  const options = typeof policy === "number" ? { status: policy } : policy;
  return new Response(body, { status: options.status ?? 200, headers: buildHeaders(contentType, options) });
}

export function htmlResponse(body: string, policy: ResponsePolicy | number = {}): Response {
  return policyResponse(body, "text/html; charset=utf-8", policy);
}

export function jsonResponse(body: unknown, policy: ResponsePolicy | number = {}): Response {
  return policyResponse(JSON.stringify(body), "application/json", policy);
}

export function redirectResponse(location: string, policy: ResponsePolicy = {}): Response {
  const headers = buildHeaders(null, policy);
  headers.set("Location", location);
  return new Response(null, { status: policy.status ?? 302, headers });
}

export class BodyError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "BodyError";
  }
}

export const MAX_BODY_BYTES = 64 * 1024;

export async function readBoundedText(req: Request | Response, maxBytes = MAX_BODY_BYTES): Promise<string> {
  return new TextDecoder().decode(await readBoundedBytes(req, maxBytes));
}

/**
 * `Content-Length` is absent on a chunked request and is in any case the
 * sender's claim about itself, and `req.text()` would buffer the whole body
 * before anyone could measure it, so the stream is counted as it arrives.
 */
export async function readBoundedBytes(req: Request | Response, maxBytes = MAX_BODY_BYTES): Promise<Uint8Array> {
  const declared = req.headers.get("content-length");
  if (declared !== null) {
    // RFC 9110 gives Content-Length as 1*DIGIT. Number() would take "0x40",
    // "1e3" and " 12 " as well, so the digits are checked before it is asked.
    if (!/^[0-9]+$/.test(declared)) throw new BodyError("malformed Content-Length", 400);
    if (Number(declared) > maxBytes) throw new BodyError("request body is too large", 413);
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  const body = req.body;
  if (body) {
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) throw new BodyError("request body is too large", 413);
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
  return Buffer.concat(chunks, total);
}

export async function readJsonObject(req: Request, maxBytes = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
  const text = await readBoundedText(req, maxBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BodyError("body must be valid JSON", 400);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BodyError("body must be a JSON object", 400);
  }
  return parsed as Record<string, unknown>;
}

export function bodyErrorResponse(error: unknown): Response {
  if (error instanceof BodyError) return jsonResponse({ ok: false, error: error.message }, { status: error.status });
  throw error;
}

export async function readBody(req: Request, maxBytes?: number): Promise<Record<string, unknown> | Response> {
  try {
    return await readJsonObject(req, maxBytes);
  } catch (error) {
    return bodyErrorResponse(error);
  }
}

export async function readMutation(req: Request, maxBytes?: number): Promise<Record<string, unknown> | Response> {
  return guardMutation(req) ?? await readBody(req, maxBytes);
}

/**
 * `decodeURIComponent` throws a URIError on a stray `%`, which is a malformed
 * request rather than a server fault.
 */
export function safeDecodePathSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch (error) {
    if (error instanceof URIError) return null;
    throw error;
  }
}

export function guardMutation(req: Request): Response | null {
  const denied = guardOrigin(req);
  if (denied) return denied;

  const sent = req.headers.get(CSRF_HEADER);
  const cookie = readCookie(req, CSRF_COOKIE);
  if (!sent || !cookie || !secretEquals(sent, cookie)) {
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

export function guardOrigin(req: Request): Response | null {
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

  // Cookies share domain scope across ports (RFC 6265). A tenant website hosted
  // on the same server (port 80/443) must not be allowed to forge mutations
  // against CloudPanel on port 8443. A reverse proxy may strip :8443 from Host.
  const exactMatch = originUrl.host === hostUrl.host;
  const strippedPortProxy = hostUrl.port === "" && originUrl.port === "8443" && originUrl.hostname === hostUrl.hostname;
  if (!exactMatch && !strippedPortProxy) {
    return jsonResponse({ ok: false, error: "cross-origin request refused" }, { status: 403 });
  }

  return null;
}

/**
 * The browser's address as the panel saw it, preferring the visitor address
 * Cloudflare sends. The panel's own Nginx takes forwarded addresses from any
 * peer, so this is what the browser claims rather than something proven: it
 * only decides what an operator is shown or offered. Any maintenance or basic-
 * auth bypass requires an administrator, who could add it by hand.
 */
export function clientIp(req: Request): string {
  const candidate = (req.headers.get("cf-connecting-ip") ?? req.headers.get("x-real-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0] ?? "").trim();
  return isIP(candidate) ? normalizeMappedIpv4(candidate) : "";
}

export function validateDomain(value: unknown): string | null {
  return typeof value === "string" ? validateExactDomain(value.trim().toLowerCase().replace(/\.$/, "")) : null;
}

export function validateExactDomain(value: unknown): string | null {
  return typeof value === "string" && value.length <= 253 && HOSTNAME_RE.test(value) ? value : null;
}

/** Escape for interpolation into HTML text or a double-quoted attribute. */
export function esc(value: unknown): string {
  return Bun.escapeHTML(String(value));
}

/**
 * Escape for interpolation into a single-quoted JavaScript string literal.
 * These literals are emitted inside `onclick` and friends, so the string sits
 * within a double-quoted HTML attribute, and JSON.stringify renders a quote as
 * the two characters `\"` -- a backslash, which HTML does not read, followed by
 * a quote, which closes the attribute. Escaping it as \u0022 keeps it a quote
 * to JavaScript and nothing at all to the HTML parser.
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

const CSP_DIRECTIVES = {
  "default-src": "'none'",
  "img-src": "'self' data:",
  "style-src": "'unsafe-inline'",
  "script-src": "'unsafe-inline'",
  "connect-src": "'self'",
  "form-action": "'none'",
  "frame-ancestors": "'none'",
  "base-uri": "'none'",
};

type CspDirective = keyof typeof CSP_DIRECTIVES | "frame-src";

export function contentSecurityPolicy(changes: Partial<Record<CspDirective, string>> = {}): string {
  return Object.entries({ ...CSP_DIRECTIVES, ...changes }).map(([name, sources]) => `${name} ${sources}`).join("; ");
}

export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": contentSecurityPolicy(),
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
};

export function errorBlock(error: unknown): string {
  return `<div class="alert" role="alert">${esc(errorMessage(error))}</div>`;
}

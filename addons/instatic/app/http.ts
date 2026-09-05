// Request guards.
//
// Authentication itself belongs to nginx: the addon runs as its own CloudPanel
// site with per-site security in front of it (decision 2.4), and the app binds
// 127.0.0.1 so it is not reachable except through that vhost. What nginx basic
// auth does NOT protect against is a cross-origin request from a browser that
// already holds those credentials, so mutating routes additionally require a
// same-origin check and a CSRF token.

import { randomBytes, timingSafeEqual } from "node:crypto";

const CSRF_COOKIE = "clp_addons_csrf";
const CSRF_HEADER = "x-clp-addons-csrf";

export function newCsrfToken(): string {
  return randomBytes(32).toString("base64url");
}

function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
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
  return `${CSRF_COOKIE}=${token}; Path=/; SameSite=Strict; Secure`;
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
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return Response.json({ ok: false, error: "malformed Origin header" }, { status: 403 });
  }
  if (!host || originHost !== host) {
    return Response.json({ ok: false, error: "cross-origin request refused" }, { status: 403 });
  }

  const sent = req.headers.get(CSRF_HEADER);
  const cookie = readCookie(req, CSRF_COOKIE);
  if (!sent || !cookie || !constantTimeEquals(sent, cookie)) {
    return Response.json({ ok: false, error: "CSRF token missing or mismatched" }, { status: 403 });
  }

  return null;
}

/** Escape for interpolation into HTML text or a double-quoted attribute. */
export function esc(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Escape for interpolation into a single-quoted JavaScript string literal. */
export function escJs(value: unknown): string {
  return JSON.stringify(String(value)).slice(1, -1).replaceAll("'", "\\'").replaceAll("<", "\\u003c");
}

export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
};

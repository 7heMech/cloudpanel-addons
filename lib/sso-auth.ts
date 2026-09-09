import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { HMAC_KEY_PATH, LIBEXEC_DIR } from "../cli/paths";

const execFileAsync = promisify(execFile);
const SUDO_BIN = "/usr/bin/sudo";
const SESSION_VALIDATOR = `${LIBEXEC_DIR}/clp-verify-session`;
const TOKEN_COOKIE = "clp_addons_token";
const SESSION_COOKIE = "PHPSESSID";
const TOKEN_TTL_SECONDS = 300;
const SESSION_ID_RE = /^[a-zA-Z0-9,-]+$/;
const USER_RE = /^[a-zA-Z0-9_.@-]{1,128}$/;

let cachedKey: Buffer | null | undefined;

export interface AuthenticatedRequest {
  user: string;
  setCookie?: string;
}

function readCookie(req: Request, name: string): string | null {
  return new Bun.CookieMap(req.headers.get("cookie") ?? "").get(name) || null;
}

function hmacKey(): Buffer | null {
  if (cachedKey !== undefined) return cachedKey;
  try {
    const key = readFileSync(HMAC_KEY_PATH);
    cachedKey = key.length >= 32 ? key : null;
  } catch {
    cachedKey = null;
  }
  return cachedKey;
}

function encode(value: string): string {
  return Buffer.from(value, "utf-8").toString("base64url");
}

function decode(value: string): string | null {
  try {
    return Buffer.from(value, "base64url").toString("utf-8");
  } catch {
    return null;
  }
}

function sessionFingerprint(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex");
}

function signature(payload: string, key: Buffer): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

export function issueToken(user: string, sessionId: string, now = Math.floor(Date.now() / 1000)): string | null {
  const key = hmacKey();
  if (!key || !USER_RE.test(user) || !SESSION_ID_RE.test(sessionId)) return null;
  const payload = encode(JSON.stringify({
    exp: now + TOKEN_TTL_SECONDS,
    sid: sessionFingerprint(sessionId),
    user,
  }));
  return `${payload}.${signature(payload, key)}`;
}

export function verifyToken(token: string, sessionId?: string, now = Math.floor(Date.now() / 1000)): string | null {
  const key = hmacKey();
  if (!key) return null;
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;

  const expected = Buffer.from(signature(parts[0], key));
  const received = Buffer.from(parts[1]);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null;

  const decoded = decode(parts[0]);
  if (!decoded) return null;
  try {
    const value = JSON.parse(decoded) as { exp?: unknown; sid?: unknown; user?: unknown };
    if (!Number.isSafeInteger(value.exp) || (value.exp as number) <= now) return null;
    if (typeof value.sid !== "string" || !/^[a-f0-9]{64}$/.test(value.sid)) return null;
    if (!sessionId || !SESSION_ID_RE.test(sessionId) || value.sid !== sessionFingerprint(sessionId)) return null;
    return typeof value.user === "string" && USER_RE.test(value.user) ? value.user : null;
  } catch {
    return null;
  }
}

async function verifyCloudPanelSession(sessionId: string): Promise<string | null> {
  if (!SESSION_ID_RE.test(sessionId)) return null;
  try {
    const result = await execFileAsync(SUDO_BIN, ["-n", SESSION_VALIDATOR, `--cookie=${sessionId}`], {
      timeout: 2000,
      maxBuffer: 4096,
    });
    const body = result.stdout.trim();
    if (!body) return null;
    const value = JSON.parse(body) as { valid?: unknown; user?: unknown };
    if (value.valid !== true || typeof value.user !== "string" || !USER_RE.test(value.user)) return null;
    return value.user;
  } catch {
    return null;
  }
}

function redirectToLogin(): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: "/login",
      "Cache-Control": "no-store",
    },
  });
}

export function authCookie(token: string): string {
  return `${TOKEN_COOKIE}=${token}; Path=/addons; HttpOnly; SameSite=Lax; Secure; Max-Age=${TOKEN_TTL_SECONDS}`;
}

export function resetSsoCache(): void {
  cachedKey = undefined;
}

export async function authenticateRequest(req: Request): Promise<{
  auth: AuthenticatedRequest | null;
  response?: Response;
}> {
  const sessionId = readCookie(req, SESSION_COOKIE);
  const token = readCookie(req, TOKEN_COOKIE);
  if (token) {
    const user = verifyToken(token, sessionId ?? undefined);
    if (user) return { auth: { user } };
  }

  if (!sessionId) return { auth: null, response: redirectToLogin() };
  const user = await verifyCloudPanelSession(sessionId);
  if (!user) return { auth: null, response: redirectToLogin() };

  const refreshed = issueToken(user, sessionId);
  if (!refreshed) return { auth: null, response: redirectToLogin() };
  return { auth: { user, setCookie: authCookie(refreshed) } };
}

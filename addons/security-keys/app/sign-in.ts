// The two routes the login page calls before there is a session.
//
// A passkey's signature is the credential here, and the root action checks it.
// The challenge it signs is root's, single-use and five minutes long; its id
// travels in a SameSite=Strict cookie rather than the body, so another site
// cannot finish a sign-in it did not start and land the browser in someone
// else's account.

import { bodyErrorResponse, guardOrigin, jsonResponse, readJsonObject } from "../../../lib/app-http";
import { ADDONS_BASE_PATH, mountPath } from "../../../lib/mount";
import { securityKeysService } from "./service";

/** The routes as the manager sees them, with `/addons` already taken off. */
export const SIGN_IN_PREFIX = `${mountPath("security-keys").slice(ADDONS_BASE_PATH.length)}/login/`;

const CHALLENGE_COOKIE = "clp_addons_passkey";
const COOKIE_PATH = `${mountPath("security-keys")}/login`;

function challengeCookie(value: string, maxAge: number): string {
  return `${CHALLENGE_COOKIE}=${value}; Path=${COOKIE_PATH}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
}

export async function handleSignIn(req: Request, path: string): Promise<Response | null> {
  const route = path.slice(SIGN_IN_PREFIX.length);
  if (req.method !== "POST" || (route !== "options" && route !== "verify")) return null;
  const denied = guardOrigin(req);
  if (denied) return denied;

  if (route === "options") {
    const result = await securityKeysService.loginOptions();
    if (!result.ok || !result.data) return jsonResponse({ ok: false, error: result.error ?? "sign-in is unavailable" }, { status: 503 });
    return jsonResponse(
      { ok: true, challenge: result.data.challenge },
      { headers: [["Set-Cookie", challengeCookie(result.data.challengeId, 300)]] },
    );
  }

  let body: Record<string, unknown>;
  try { body = await readJsonObject(req, 16 * 1024); } catch (error) { return bodyErrorResponse(error); }
  const challengeId = new Bun.CookieMap(req.headers.get("cookie") ?? "").get(CHALLENGE_COOKIE) ?? "";
  const response = typeof body.response === "object" && body.response !== null ? body.response as Record<string, unknown> : {};
  const result = await securityKeysService.signIn({
    challengeId,
    id: body.id,
    clientDataJSON: response.clientDataJSON,
    authenticatorData: response.authenticatorData,
    signature: response.signature,
    userHandle: response.userHandle,
  });
  const clear: [string, string][] = [["Set-Cookie", challengeCookie("", 0)]];
  if (!result.ok || !result.data) {
    return jsonResponse({ ok: false, error: result.error ?? "sign-in failed" }, { status: 400, headers: clear });
  }
  // CloudPanel's own route: it reads the token, deletes it and starts the
  // session, exactly as a password login would.
  return jsonResponse({ ok: true, redirect: `/autologin?token=${result.data.token}` }, { headers: clear });
}

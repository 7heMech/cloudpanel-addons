// Authentication for the manager, enforced by the app itself.
//
// This used to be nginx's job alone: the manager binds loopback and is reached
// through a CloudPanel site whose vhost carries Basic Auth, so the reasoning
// was that anything arriving at the app had already passed that gate. It had
// not. A TCP port on 127.0.0.1 restricts which *machine* may connect, not which
// *user*, and loopback has no permission model -- every account on the box is
// equally entitled to it. An ordinary site user was able to drive a POST
// straight into the root wrapper:
//
//   runuser -u kleros -- curl -X POST -H 'Origin: http://127.0.0.1:38080' \
//     -H 'x-clp-addons-csrf: T' -H 'Cookie: clp_addons_csrf=T' \
//     http://127.0.0.1:38080/instatic/api/instances/x/stop
//   -> 400 {"ok":false,"error":"no such container for x"}   (the wrapper's answer)
//
// The CSRF pair stops a browser on another origin; it does nothing against a
// caller who sets both headers. On a shared CloudPanel box the other accounts
// are the PHP behind each hosted site, so one vulnerable plugin reached root.
//
// So the app authenticates too, and fails closed: with no credential on disk it
// serves nothing. That ordering matters more than the check itself. The install
// used to create the site, start the service and *then* advise adding Basic
// Auth, which left a live root-equivalent API on every box whose operator did
// not follow the advice. This is a public project installed on machines we
// never see, so a control that only holds when the operator configured
// something is not a control.

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

/**
 * scrypt rather than the DES `crypt(3)` CloudPanel writes into
 * /etc/nginx/basic-auth, which truncates the password at eight characters --
 * the 64-character password on one of this box's sites has about eight
 * effective ones -- and is fast enough to brute-force offline. The credential
 * is reused from the panel where the operator set one; the *hash* is ours.
 */
const SCRYPT_N = 16384;
const KEY_LEN = 32;
const SALT_LEN = 16;

/** Anything longer is not a credential, and hashing it is free work for a stranger. */
const MAX_HEADER = 4096;

export interface AuthMaterial {
  user: string;
  salt: Buffer;
  key: Buffer;
}

/** `user:$s1$<salt-b64url>$<key-b64url>` -- one line, the whole file. */
export function formatAuth(user: string, password: string): string {
  const salt = randomBytes(SALT_LEN);
  const key = scryptSync(password, salt, KEY_LEN, { N: SCRYPT_N, r: 8, p: 1 });
  return `${user}:$s1$${salt.toString("base64url")}$${key.toString("base64url")}\n`;
}

export function parseAuth(body: string): AuthMaterial | null {
  const line = body.split("\n").find((l) => l.trim() && !l.startsWith("#"));
  if (!line) return null;
  const colon = line.indexOf(":");
  if (colon <= 0) return null;
  const user = line.slice(0, colon);
  const parts = line.slice(colon + 1).trim().split("$");
  // ["", "s1", salt, key]
  if (parts.length !== 4 || parts[1] !== "s1") return null;
  try {
    const salt = Buffer.from(parts[2]!, "base64url");
    const key = Buffer.from(parts[3]!, "base64url");
    if (salt.length !== SALT_LEN || key.length !== KEY_LEN) return null;
    return { user, salt, key };
  } catch {
    return null;
  }
}

// Re-read only when the file changes, so an operator who updates the panel's
// Basic Auth and runs `repair` takes effect without a restart, while the common
// case costs one stat rather than a scrypt of the file.
let cached: { mtimeMs: number; size: number; material: AuthMaterial | null } | null = null;

export function loadAuth(path: string): AuthMaterial | null {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(path);
  } catch {
    cached = null;
    return null;
  }
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.material;
  let material: AuthMaterial | null = null;
  try {
    material = parseAuth(readFileSync(path, "utf-8"));
  } catch {
    material = null;
  }
  cached = { mtimeMs: st.mtimeMs, size: st.size, material };
  return material;
}

/** Only for tests, which write the same path repeatedly within one mtime tick. */
export function resetAuthCache(): void {
  cached = null;
}

function unauthorized(): Response {
  return Response.json({ ok: false, error: "authentication required" }, {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="clp-addons manager", charset="UTF-8"' },
  });
}

/**
 * Returns null when the request may proceed, or the Response to send instead.
 *
 * Fails closed on a missing or unparseable credential file: 503, never 200. An
 * operator who has not finished installing gets a manager that does nothing,
 * which is the only safe reading of "no credential is configured".
 */
export function guardAuth(req: Request, path: string): Response | null {
  const material = loadAuth(path);
  if (!material) {
    return Response.json({
      ok: false,
      error: "no manager credential is configured; run `clp-addons repair` to set one",
    }, { status: 503 });
  }

  const header = req.headers.get("authorization");
  if (!header || header.length > MAX_HEADER) return unauthorized();
  const m = /^Basic\s+([A-Za-z0-9+/=]+)$/.exec(header);
  if (!m) return unauthorized();

  let decoded: string;
  try {
    decoded = Buffer.from(m[1]!, "base64").toString("utf-8");
  } catch {
    return unauthorized();
  }
  const colon = decoded.indexOf(":");
  if (colon < 0) return unauthorized();
  const user = decoded.slice(0, colon);
  const password = decoded.slice(colon + 1);

  // Derive before comparing the username, so a wrong username costs the same as
  // a wrong password and the header cannot be used to enumerate one.
  const key = scryptSync(password, material.salt, KEY_LEN, { N: SCRYPT_N, r: 8, p: 1 });
  const userOk = user.length === material.user.length &&
    timingSafeEqual(Buffer.from(user), Buffer.from(material.user));
  const keyOk = timingSafeEqual(key, material.key);
  return userOk && keyOk ? null : unauthorized();
}

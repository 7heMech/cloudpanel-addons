/**
 * Passkey sign-ins, so the gateway can tell a session a passkey opened from
 * one that skipped CloudPanel's two-factor step: CloudPanel's /autologin
 * leaves no mark of its own. See docs/decisions/terminal.md#root.
 */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openPanelDatabase } from "../../cli/panel-db";
import { writeFileAtomic } from "../../lib/atomic-write";

/** How long CloudPanel honours the sign-in token Security Keys writes. */
export const TOKEN_TTL_SECONDS = 60;
/** Older sign-ins are dropped; a session that outlives one signs in with the code for a root terminal. */
const KEEP_SECONDS = 30 * 24 * 3600;
const KEEP_PER_USER = 20;

export interface SignIn {
  user: string;
  /** The credential id of the key that signed in. */
  key: string;
  /** Unix seconds when the sign-in token was written. */
  at: number;
  /** The account's 2FA secret then, as mfaMark gives it. */
  mfa: string | null;
}

/**
 * A digest of the account's 2FA secret now, or null while 2FA is off or the
 * database cannot say.
 */
export function mfaMark(panelDb: string, user: string): string | null {
  try {
    const db = openPanelDatabase(panelDb, true);
    try {
      const row = db.query<{ mfa: unknown; mfa_secret: unknown }, [string]>(
        "SELECT mfa, mfa_secret FROM user WHERE user_name = ?",
      ).get(user);
      if (!row || Number(row.mfa) !== 1 || typeof row.mfa_secret !== "string" || !row.mfa_secret) return null;
      return createHash("sha256").update(`clp-addons passkey sign-in\0${row.mfa_secret}`).digest("hex");
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

export function signInsPath(stateDir: string): string {
  return join(stateDir, "sign-ins.json");
}

/** The recorded sign-ins, or none when the file is missing, not root's alone, or unreadable. */
export function readSignIns(stateDir: string, stateUid = 0): SignIn[] {
  let fd: number;
  try {
    fd = openSync(signInsPath(stateDir), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return [];
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.uid !== stateUid || (info.mode & 0o077) !== 0) return [];
    const stored = JSON.parse(readFileSync(fd, "utf8")) as { signIns?: unknown };
    if (!Array.isArray(stored?.signIns)) return [];
    return stored.signIns.filter((entry): entry is SignIn =>
      !!entry && typeof entry === "object" && typeof entry.user === "string" && typeof entry.key === "string"
      && Number.isSafeInteger(entry.at) && (entry.mfa === null || typeof entry.mfa === "string"));
  } catch {
    return [];
  } finally {
    closeSync(fd);
  }
}

/** Run under the store lock, before the token is written. */
export function recordSignIn(stateDir: string, stateUid: number, signIn: SignIn): void {
  const kept = readSignIns(stateDir, stateUid).filter((entry) => entry.at > signIn.at - KEEP_SECONDS);
  const others = kept.filter((entry) => entry.user !== signIn.user);
  const own = [...kept.filter((entry) => entry.user === signIn.user), signIn].slice(-KEEP_PER_USER);
  writeFileAtomic(signInsPath(stateDir), `${JSON.stringify({ signIns: [...others, ...own] })}\n`,
    { mode: 0o600, owner: { uid: stateUid, gid: process.getgid?.() ?? 0 }, createParent: true });
}

/**
 * The key a session was opened with, when CloudPanel created it while that
 * user's passkey sign-in token was valid. CloudPanel stamps a session's
 * creation time when it signs someone in, /autologin included. The sign-in
 * counts only while the account has the 2FA secret it had then (`mfa`): with
 * 2FA on, a password sign-in in the same window carries CloudPanel's marker,
 * so the unmarked session is the passkey's.
 */
export function passkeyFor(user: string, sessionCreatedAt: number, mfa: string | null, stateDir: string, stateUid = 0): string | null {
  if (mfa === null) return null;
  const match = readSignIns(stateDir, stateUid).filter((entry) =>
    entry.user === user && entry.mfa === mfa
    && entry.at <= sessionCreatedAt + 1 && sessionCreatedAt <= entry.at + TOKEN_TTL_SECONDS + 1);
  // Sign-ins with two keys in one window cannot be told apart, so neither counts.
  const keys = new Set(match.map((entry) => entry.key));
  return keys.size === 1 ? [...keys][0]! : null;
}

export interface Passkey {
  id: string;
  name: string;
}

/**
 * The keys registered to this account now, read without Security Keys' lock:
 * the store is replaced in one rename. A store that is missing, not root's
 * alone or unreadable lists none.
 */
export function accountPasskeys(stateDir: string, user: string, userId: number, stateUid = 0): Passkey[] {
  let fd: number;
  try {
    fd = openSync(join(stateDir, "credentials.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return [];
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.uid !== stateUid || (info.mode & 0o077) !== 0) return [];
    const stored = JSON.parse(readFileSync(fd, "utf8")) as { users?: Record<string, { userId?: unknown; keys?: unknown }> };
    const entry = stored?.users?.[user];
    if (!entry || entry.userId !== userId || !Array.isArray(entry.keys)) return [];
    return entry.keys.flatMap((key: { id?: unknown; name?: unknown }) =>
      typeof key?.id === "string" && typeof key.name === "string" ? [{ id: key.id, name: key.name }] : []);
  } catch {
    return [];
  } finally {
    closeSync(fd);
  }
}

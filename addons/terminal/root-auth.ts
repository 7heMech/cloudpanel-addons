import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, lstatSync, readFileSync } from "node:fs";
import { ActionFailure, failAction } from "../../lib/action";
import { errorMessage } from "../../lib/errors";
import { withFileLockSync } from "../../lib/file-lock";
import { addonConfigFile } from "../../lib/paths";
import { isTrustedDirectory } from "../../lib/trusted-file";
import { openPanelDatabase } from "../../lib/panel-db";
import { writeFileAtomic } from "../../lib/atomic-write";
import { DEFAULT_SECURITY_KEYS_PATHS, verifyTerminalKey } from "../security-keys/action";
import { accountPasskeys } from "../security-keys/sign-ins";
import { WebAuthnError } from "../security-keys/webauthn";
import { allowedGrant, ROOT_AUTH_DIR, ROOT_AUTH_LOCK, rootAuthFile, type RootAccessPaths } from "./root-access";

/** `securityKeys` is the addon's enabled marker: passkeys count only while it exists, as at sign-in. */
export const DEFAULT_ROOT_AUTH_PATHS = { dir: ROOT_AUTH_DIR, lock: ROOT_AUTH_LOCK, securityKeys: addonConfigFile("security-keys") };
interface State {
  attempts: number[];
  usedStep?: number;
  challenges: Record<string, { session: string; expires: number }>;
  tickets: Record<string, { session: string; expires: number; grant: string; method: string }>;
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
/** A code or signature that was checked and is wrong: the only failure that spends the budget. */
class WrongProof extends ActionFailure {}

/** RFC 6238, SHA-1, six digits; CloudPanel's authenticator configuration. */
export function totp(secret: string, step: number): string {
  let bits = "";
  for (const char of secret.toUpperCase().replace(/=+$/, "")) {
    const n = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(char);
    if (n < 0) failAction("Invalid authenticator configuration.");
    bits += n.toString(2).padStart(5, "0");
  }
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map(byte => parseInt(byte, 2)));
  if (!key.length) failAction("Invalid authenticator configuration.");
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", key).update(counter).digest();
  const offset = mac[19]! & 15;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, "0");
}

/** One account's attempt budget and replay protection, shared by every worker. */
function withState<T>(user: string, uid: number, now: number, storage: typeof DEFAULT_ROOT_AUTH_PATHS,
  use: (state: State, save: () => void) => T): T {
  mkdirSync(storage.dir, { recursive: true, mode: 0o700 });
  if (!isTrustedDirectory(lstatSync(storage.dir), uid, 0o077)) failAction("Terminal verification state is not root-only.");
  return withFileLockSync(storage.lock, 15, "Another terminal verification is running.", () => {
    const file = rootAuthFile(storage.dir, user);
    let state: State;
    try { state = JSON.parse(readFileSync(file, "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      state = { attempts: [], challenges: {}, tickets: {} };
    }
    state.attempts = state.attempts.filter(at => at > now - 86_400_000);
    state.challenges = Object.fromEntries(Object.entries(state.challenges).filter(([, value]) => value.expires > now));
    state.tickets = Object.fromEntries(Object.entries(state.tickets).filter(([, value]) => value.expires > now));
    const save = () => writeFileAtomic(file, JSON.stringify(state), { mode: 0o600 });
    return use(state, save);
  });
}

/**
 * CloudPanel keeps no record of the code it took at sign-in, so a phishing
 * proxy holding the session holds that code too. CloudPanel takes a code up
 * to two steps either side of its clock, so every code the session could have
 * signed in with is from no later than two steps after the one `signedIn`
 * falls in, and only a later one counts here. A code that matches one of those steps, or
 * one at or before `used`, the last step that succeeded, is not a guess, and
 * spends nothing.
 */
function verifyCode(panelDb: string, user: string, code: string, used: number, signedIn: number, now: number): number {
  if (!/^\d{6}$/.test(code)) failAction("Enter a six-digit authenticator code.");
  const db = openPanelDatabase(panelDb, true);
  try {
    const secret = db.query<{ mfa_secret: string }, [string]>("SELECT mfa_secret FROM user WHERE user_name = ?").get(user)?.mfa_secret;
    if (!secret) failAction("Authenticator configuration is unavailable.");
    const step = Math.floor(now / 30_000);
    const matched = [step - 1, step, step + 1].find(n => n >= 0 && timingSafeEqual(Buffer.from(totp(secret, n)), Buffer.from(code)));
    if (matched === undefined) throw new WrongProof("Invalid code. Try the next code.");
    if (matched <= used) failAction("This code was used already. Wait for the next code your app shows.");
    if (matched <= Math.floor(signedIn / 30_000) + 2) failAction("This code could be the one you signed in with. Wait for the next code your app shows.");
    return matched;
  } finally { db.close(); }
}

/** What the gateway says of the panel session a request came with. */
export interface PanelSessionInfo {
  /** How it signed in: see SESSION_2FA_ENV. */
  proof: string;
  /** A digest of its id, so a challenge or ticket answers only there. */
  binding: string;
  /** When the gateway first saw it signed in, if it said. */
  seen: number | null;
}

/**
 * Root-owned, serialized state: failed attempts survive worker exits and
 * tickets are single use. `consume` returns how the ticket was earned.
 */
export function rootAuth(verb: "options" | "verify" | "consume", user: string, { proof: session, binding, seen }: PanelSessionInfo,
  input: Record<string, unknown>, paths: RootAccessPaths, now = Date.now(), storage = DEFAULT_ROOT_AUTH_PATHS): unknown {
  if (!/^[a-f0-9]{64}$/.test(binding)) failAction("A verified panel session is required.");
  const grant = allowedGrant(user, paths, session);
  const fingerprint = digest(JSON.stringify(grant));
  // Pinned keys the account still has, while Security Keys is on; a ticket's consumption needs none.
  const pinnedKeys = () => {
    const held = existsSync(storage.securityKeys) ? accountPasskeys(paths.securityKeys, user, grant.id, paths.rootUid).map(key => key.id) : [];
    return grant.keys.filter(id => held.includes(id));
  };
  return withState(user, paths.rootUid, now, storage, (state, save) => {
    if (verb === "consume") {
      const id = digest(typeof input.ticket === "string" ? input.ticket : "");
      const ticket = state.tickets[id];
      if (!ticket || ticket.session !== binding || ticket.grant !== fingerprint) failAction("Verify with 2FA or a passkey before opening a root terminal.");
      delete state.tickets[id];
      save();
      return ticket.method;
    }
    // Five in five minutes, and twenty a day, so guessing never runs on unattended.
    if (state.attempts.filter(at => at > now - 300_000).length >= 5 || state.attempts.length >= 20) failAction("Too many failed verifications. Try again later.");
    if (verb === "options") {
      // A session answers one prompt at a time: a new one replaces any it left open, so cancelling and retrying never fills the cap.
      state.challenges = Object.fromEntries(Object.entries(state.challenges).filter(([, value]) => value.session !== binding));
      if (Object.keys(state.challenges).length >= 20) failAction("Too many pending prompts. Try again in five minutes.");
      const challenge = randomBytes(32).toString("base64url");
      state.challenges[challenge] = { session: binding, expires: now + 300_000 };
      save();
      return { challenge, keys: pinnedKeys() };
    }
    const challenge = typeof input.challenge === "string" ? input.challenge : "";
    const pending = state.challenges[challenge];
    if (!pending || pending.session !== binding) failAction("The verification prompt expired. Try again.");
    delete state.challenges[challenge];
    let method = "an authenticator code";
    try {
      if (typeof input.code === "string") {
        // The gateway's sighting is of this sign-in; the challenge is bound only
        // to the session id, which a later sign-in can keep, so the prompt's
        // opening (five minutes before its challenge expires) stands in only
        // without a sighting.
        const opened = pending.expires - 300_000;
        state.usedStep = verifyCode(paths.panelDb, user, input.code, state.usedStep ?? -1, seen ?? opened, now);
      }
      else {
        verifyTerminalKey({ ...DEFAULT_SECURITY_KEYS_PATHS, stateDir: paths.securityKeys, panelDb: paths.panelDb, stateUid: paths.rootUid }, user, pinnedKeys(), challenge, input, now);
        method = `passkey ${String(input.id)}`;
      }
    } catch (error) {
      const wrong = error instanceof WrongProof || error instanceof WebAuthnError;
      if (wrong) state.attempts.push(now);
      save();
      process.stderr.write(`[terminal] ${user} failed root verification: ${errorMessage(error).replace(/\s+/g, " ")}\n`);
      if (wrong || error instanceof ActionFailure) throw error;
      failAction("Verification is unavailable right now. Try again.");
    }
    const ticket = randomBytes(32).toString("base64url");
    state.tickets[digest(ticket)] = { session: binding, expires: now + 60_000, grant: fingerprint, method };
    save();
    return { ticket };
  });
}

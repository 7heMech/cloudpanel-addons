/**
 * Who may open a root shell: administrators root named from a shell with
 * `clp-addons terminal root allow`, each pinned to the account and the
 * two-factor setup it had then. See docs/decisions/terminal.md#root.
 */
import { errorMessage } from "../../lib/errors";
import { addonStateDir, CONFIG_DIR, LOCK_DIR, PANEL_DB } from "../../lib/paths";
import { createHash } from "node:crypto";
import {
  chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, type Stats,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Database } from "bun:sqlite";
import { failAction } from "../../lib/action";
import { withFileLockSync } from "../../lib/file-lock";
import { openPanelDatabase } from "../../lib/panel-db";
import { accountPasskeys } from "../security-keys/sign-ins";
import { fatal, log, requireRoot } from "../../lib/log";
import { writeFileAtomic } from "../../lib/atomic-write";
import { isTrustedDirectory, isTrustedFile } from "../../lib/trusted-file";
import { PANEL_USER_NAME_RE } from "../../lib/panel-users";

const ROOT_GRANTS_FILE = `${CONFIG_DIR}/terminal-root.json`;
const ROOT_GRANTS_LOCK = `${LOCK_DIR}/terminal-root.lock`;
const SECURITY_KEYS_DIR = addonStateDir("security-keys");
/** Root verification's per-account state: attempts, used codes, prompts and tickets (root-auth.ts). */
export const ROOT_AUTH_DIR = `${addonStateDir("terminal")}/root-auth`;
export const ROOT_AUTH_LOCK = `${LOCK_DIR}/terminal-auth.lock`;
export const rootAuthFile = (dir: string, user: string) => join(dir, `${createHash("sha256").update(user).digest("hex")}.json`);

/**
 * Root deciding again starts the account's verification afresh: a budget
 * spent by someone holding its session no longer keeps it out.
 */
export function clearRootAuth(user: string, storage = { dir: ROOT_AUTH_DIR, lock: ROOT_AUTH_LOCK }): void {
  withFileLockSync(storage.lock, 15, "a terminal verification is still running", () => rmSync(rootAuthFile(storage.dir, user), { force: true }));
}

interface RootGrant {
  user: string;
  /** CloudPanel's `user.id`: a name deleted and created again is someone else. */
  id: number;
  /** A digest of the account's 2FA secret then: 2FA set up again is not the owner's until root says so. */
  mfa: string;
  /** The Security Keys passkeys the account had then; one added later does not open a root shell. */
  keys: string[];
}

interface PanelAccount {
  id: number;
  mfa: number | null;
  mfa_secret: string | null;
  role: string | null;
  status: number | null;
}

/** The file is wrong in itself; root recovers by removing it and allowing again. */
class UntrustedGrants extends Error {}

const errno = (error: unknown) => (error as NodeJS.ErrnoException)?.code;

/**
 * The grants. Only a missing directory or file means none. A file or directory
 * root does not own alone, a link, or contents that do not parse throw
 * UntrustedGrants; other errors are thrown as they are. Either way nobody gets
 * a root shell. The file is checked and read through one descriptor.
 */
export function readRootGrants(file = ROOT_GRANTS_FILE, rootUid = 0): RootGrant[] {
  const dir = dirname(file);
  let dirInfo: Stats;
  try {
    dirInfo = lstatSync(dir);
  } catch (error) {
    if (errno(error) === "ENOENT") return [];
    throw error;
  }
  if (!isTrustedDirectory(dirInfo, rootUid)) throw new UntrustedGrants(`${dir} is not a directory only root can write`);
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (errno(error) === "ENOENT") return [];
    // O_NOFOLLOW refuses a link with ELOOP.
    if (errno(error) === "ELOOP") throw new UntrustedGrants(`${file} is not a trusted regular file`);
    throw error;
  }
  try {
    const info = fstatSync(fd);
    if (!isTrustedFile(info, rootUid)) throw new UntrustedGrants(`${file} is not a trusted regular file`);
    let stored: { users?: unknown } | null;
    try {
      stored = JSON.parse(readFileSync(fd, "utf8"));
    } catch {
      throw new UntrustedGrants(`${file} is not valid JSON`);
    }
    if (!Array.isArray(stored?.users)) throw new UntrustedGrants(`${file} has no users list`);
    return stored.users.filter((grant): grant is RootGrant =>
      !!grant && typeof grant === "object"
      && typeof grant.user === "string" && PANEL_USER_NAME_RE.test(grant.user)
      && Number.isSafeInteger(grant.id) && typeof grant.mfa === "string" && /^[0-9a-f]{64}$/.test(grant.mfa))
      .map(({ user, id, mfa, keys }) => ({ user, id, mfa, keys: Array.isArray(keys) ? keys.filter((key) => typeof key === "string") : [] }));
  } finally {
    closeSync(fd);
  }
}

function writeRootGrants(grants: RootGrant[], file = ROOT_GRANTS_FILE): void {
  // mkdir's mode is masked by root's umask, which could leave a directory
  // readRootGrants refuses, so the mode is set outright.
  const dir = dirname(file);
  if (mkdirSync(dir, { recursive: true })) chmodSync(dir, 0o755);
  // Written into a directory the reader refuses, the list would lock everyone out.
  if (!isTrustedDirectory(lstatSync(dir), 0)) fatal(`${dir} must be root's alone to hold the root terminal list: chown root:root and chmod 755 it`);
  const users = [...grants].sort((a, b) => a.user.localeCompare(b.user)).map(({ user, id, mfa, keys }) => ({ user, id, mfa, keys }));
  writeFileAtomic(file, `${JSON.stringify({ users }, null, 2)}\n`, { mode: 0o600, owner: { uid: 0, gid: 0 } });
}

function account(db: Database, user: string): PanelAccount | null {
  return db.query<PanelAccount, [string]>(
    "SELECT id, mfa, mfa_secret, role, status FROM user WHERE user_name = ?",
  ).get(user);
}

function mfaDigest(found: PanelAccount): string | null {
  if (Number(found.mfa) !== 1 || !found.mfa_secret) return null;
  return createHash("sha256").update(`clp-addons terminal root\0${found.mfa_secret}`).digest("hex");
}

/**
 * Why this grant does not open a root shell now, or null while it does.
 *
 * Any administrator can reset another's password in CloudPanel and sign in as
 * them, and while the account has no 2FA can also set it up with their own
 * phone. So a grant holds only the 2FA the owner had when root allowed it:
 * 2FA turned off and set up again needs root again.
 */
function grantProblem(db: Database, grant: RootGrant): string | null {
  const found = account(db, grant.user);
  if (!found || found.id !== grant.id) return `${grant.user} is not the account root allowed; root can run clp-addons terminal root allow ${grant.user} again`;
  if (Number(found.status) !== 1) return `${grant.user} is deactivated`;
  if (found.role !== "ROLE_ADMIN") return `${grant.user} is no longer an administrator`;
  const digest = mfaDigest(found);
  if (digest === null) return "A root terminal needs 2FA: turn it on in Account → Security, then ask root to allow you again.";
  if (digest !== grant.mfa) return `${grant.user}'s 2FA was set up again after root allowed it; root can run clp-addons terminal root allow ${grant.user} again`;
  return null;
}

/**
 * Why this sign-in does not open the grant's root shell. The account having
 * 2FA on is not enough: a session signed in before it was turned on stays
 * signed in, and never passed it.
 */
function sessionProblem(grant: RootGrant, session: string, paths: RootAccessPaths): string | null {
  if (session === "1") return null;
  if (session.startsWith("passkey:")) {
    const key = session.slice("passkey:".length);
    if (!grant.keys.includes(key)) return "This passkey was added after root allowed you: sign in with your 2FA code, or ask root to allow you again.";
    // A key removed or revoked since, perhaps because it was lost, opens nothing more.
    return accountPasskeys(paths.securityKeys, grant.user, grant.id, paths.rootUid).some((found) => found.id === key) ? null
      : "This passkey is no longer on your account: sign in with your 2FA code or another passkey to open a root terminal.";
  }
  return "This sign-in used neither your 2FA code nor a passkey: sign out and in again with one to open a root terminal.";
}

export interface RootAccessPaths {
  panelDb: string;
  grants: string;
  /** Security Keys' state, for the keys an account has now. */
  securityKeys: string;
  /** Who must own the grants file and Security Keys' state; root, except in tests. */
  rootUid: number;
}

export const DEFAULT_ROOT_ACCESS_PATHS: RootAccessPaths = { panelDb: PANEL_DB, grants: ROOT_GRANTS_FILE, securityKeys: SECURITY_KEYS_DIR, rootUid: 0 };

export interface RootAccess {
  /** False for an administrator root never allowed. */
  granted: boolean;
  /** Why one root allowed is refused now, or null while it is not. */
  problem: string | null;
  /** The problem is a read that failed, which may pass, not an answer. */
  unreadable?: true;
}

/**
 * Whether a panel user may open a root shell now, from a session whose sign-in
 * `session` describes (SESSION_2FA_ENV). Any failure refuses.
 */
export function rootAccess(panelUser: string, paths: RootAccessPaths, session: string): RootAccess {
  const { grant: _grant, ...access } = checkAccess(panelUser, paths, session);
  return access;
}

/** The grant behind a root shell this session may open now; refuses otherwise. */
export function allowedGrant(panelUser: string, paths: RootAccessPaths, session: string): RootGrant {
  const { grant, problem } = checkAccess(panelUser, paths, session);
  if (!grant || problem) failAction(problem ?? "Root has not allowed you a root shell.");
  return grant;
}

/** rootAccess with the grant it read, which holds the account's 2FA digest and so never leaves root. */
function checkAccess(panelUser: string, paths: RootAccessPaths, session: string): RootAccess & { grant?: RootGrant } {
  const failed = (what: string, error: unknown): RootAccess =>
    ({ granted: true, problem: `${what} cannot be read: ${errorMessage(error)}`, unreadable: true });
  let grant: RootGrant | undefined;
  try {
    grant = readRootGrants(paths.grants, paths.rootUid).find((candidate) => candidate.user === panelUser);
  } catch (error) {
    if (error instanceof UntrustedGrants) return { granted: true, problem: `the root terminal list cannot be trusted: ${error.message}` };
    return failed("the root terminal list", error);
  }
  if (!grant) return { granted: false, problem: null };
  let db: Database | null = null;
  try {
    db = openPanelDatabase(paths.panelDb, true);
    return { granted: true, grant, problem: grantProblem(db, grant) ?? sessionProblem(grant, session, paths) };
  } catch (error) {
    return failed("CloudPanel's user list", error);
  } finally {
    db?.close();
  }
}

export function runTerminalRootCommand(argv: string[]): void {
  const [scope, verb, user, ...extra] = argv;
  const usage = "usage: clp-addons terminal root [allow|deny <user>]";
  if (scope !== "root" || extra.length || (verb !== undefined && !["allow", "deny"].includes(verb)) || (verb && !user)) fatal(usage);
  requireRoot("terminal root");
  const read = (): RootGrant[] => {
    try {
      return readRootGrants();
    } catch (error) {
      if (!(error instanceof UntrustedGrants)) {
        fatal(`cannot read ${ROOT_GRANTS_FILE}: ${errorMessage(error)}; nobody can open a root shell until it can be`);
      }
      fatal(`${error.message}, so nobody can open a root shell. Note who it allowed, remove it with rm ${ROOT_GRANTS_FILE}, then allow them again`);
    }
  };
  // Taking a grant back never waits on CloudPanel's database.
  const withPanel = <T>(use: (db: Database) => T): T => {
    const db = openPanelDatabase(PANEL_DB, true);
    try { return use(db); } finally { db.close(); }
  };
  if (!verb) {
    const grants = read();
    if (!grants.length) return log.plain("No administrator can open a root shell.");
    withPanel((db) => { for (const grant of grants) log.plain(`${grant.user}: ${grantProblem(db, grant) ?? "can open a root shell"}`); });
    return;
  }
  // Looked up before the grants lock, so CloudPanel holding its database does not hold up other changes.
  let grant: RootGrant | null = null;
  if (verb === "allow") {
    const found = withPanel((db) => account(db, user!));
    if (!found) fatal(`CloudPanel has no user ${user}`);
    if (Number(found.status) !== 1) fatal(`${user} is deactivated`);
    if (found.role !== "ROLE_ADMIN") fatal(`${user} is not an administrator`);
    // Allowed without it, the first to set it up -- any administrator after a password reset -- would be the owner.
    const mfa = mfaDigest(found);
    if (mfa === null) fatal(`${user} has 2FA off: they turn it on in Account → Security first, then allow them`);
    // The passkeys it has now are the ones root trusts; listed so root sees whose they are.
    const keys = accountPasskeys(SECURITY_KEYS_DIR, user!, found.id);
    if (keys.length) log.plain(`Passkeys that can open it: ${keys.map((key) => key.name).join(", ")}`);
    grant = { user: user!, id: found.id, mfa, keys: keys.map((key) => key.id) };
  }
  withFileLockSync(ROOT_GRANTS_LOCK, 15, "another terminal root change is still running", () => {
    const current = read();
    const others = current.filter((candidate) => candidate.user !== user);
    if (grant) return writeRootGrants([...others, grant]);
    if (others.length === current.length) fatal(`${user} was not allowed a root shell`);
    writeRootGrants(others);
  });
  clearRootAuth(user!);
  log.ok(verb === "allow"
    ? `${user} can open a root shell from the panel, signed in with their 2FA code${grant?.keys.length ? " or one of those passkeys" : ""}`
    : `${user} cannot open a root shell; any open one closes within 15 seconds`);
}

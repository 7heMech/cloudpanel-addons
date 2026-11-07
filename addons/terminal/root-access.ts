/**
 * Who may open a root shell: administrators root named from a shell with
 * `clp-addons terminal root allow`, each pinned to the account it was then,
 * and only while that account has two-factor authentication on. See
 * docs/decisions/terminal.md#root.
 */
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, type Stats } from "node:fs";
import { dirname } from "node:path";
import type { Database } from "bun:sqlite";
import { withFileLockSync } from "../../cli/action-common";
import { openPanelDatabase } from "../../cli/panel-db";
import { CONFIG_DIR, LOCK_DIR, PANEL_DB } from "../../cli/paths";
import { fatal, log, requireRoot } from "../../cli/util";
import { writeFileAtomic } from "../../lib/atomic-write";
import { PANEL_USER_NAME_RE } from "../../lib/panel-users";

export const ROOT_GRANTS_FILE = `${CONFIG_DIR}/terminal-root.json`;
const ROOT_GRANTS_LOCK = `${LOCK_DIR}/terminal-root.lock`;

export interface RootGrant {
  user: string;
  /** CloudPanel's `user.id`: a name deleted and created again is someone else. */
  id: number;
}

interface PanelAccount {
  id: number;
  mfa: number | null;
  role: string | null;
  status: number | null;
}

/** The file is wrong in itself; root recovers by removing it and allowing again. */
export class UntrustedGrants extends Error {}

const rootsAlone = (info: Stats, rootUid: number) => info.uid === rootUid && (info.mode & 0o022) === 0;
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
  if (!dirInfo.isDirectory() || !rootsAlone(dirInfo, rootUid)) throw new UntrustedGrants(`${dir} is not a directory only root can write`);
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
    if (!info.isFile() || !rootsAlone(info, rootUid)) throw new UntrustedGrants(`${file} is not a trusted regular file`);
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
      && Number.isSafeInteger(grant.id));
  } finally {
    closeSync(fd);
  }
}

function writeRootGrants(grants: RootGrant[], file = ROOT_GRANTS_FILE): void {
  // mkdir's mode is masked by root's umask, which could leave a directory
  // readRootGrants refuses, so the mode is set outright.
  if (mkdirSync(dirname(file), { recursive: true })) chmodSync(dirname(file), 0o755);
  const users = [...grants].sort((a, b) => a.user.localeCompare(b.user)).map(({ user, id }) => ({ user, id }));
  writeFileAtomic(file, `${JSON.stringify({ users }, null, 2)}\n`, { mode: 0o600, owner: { uid: 0, gid: 0 } });
}

function account(db: Database, user: string): PanelAccount | null {
  return db.query<PanelAccount, [string]>(
    "SELECT id, mfa, role, status FROM user WHERE user_name = ?",
  ).get(user);
}

/**
 * Why this grant does not open a root shell now, or null while it does.
 *
 * Any administrator can reset another's password in CloudPanel and sign in as
 * them, but only the account itself can turn its two-factor authentication off
 * or on, so with it required a reset password alone is not enough.
 */
export function grantProblem(db: Database, grant: RootGrant): string | null {
  const found = account(db, grant.user);
  if (!found || found.id !== grant.id) return `${grant.user} is not the account root allowed; root can run clp-addons terminal root allow ${grant.user} again`;
  if (Number(found.status) !== 1) return `${grant.user} is deactivated`;
  if (found.role !== "ROLE_ADMIN") return `${grant.user} is no longer an administrator`;
  if (Number(found.mfa) !== 1) return "A root terminal needs two-factor authentication: turn it on in Account Security.";
  return null;
}

export interface RootAccessPaths {
  panelDb: string;
  grants: string;
  /** Who must own the grants file; root, except in tests. */
  rootUid: number;
}

export const DEFAULT_ROOT_ACCESS_PATHS: RootAccessPaths = { panelDb: PANEL_DB, grants: ROOT_GRANTS_FILE, rootUid: 0 };

/**
 * Whether a panel user may open a root shell now. `granted` is false for one
 * root never allowed, whose page then says nothing; `problem` says why one it
 * did allow is refused.
 */
export function rootAccess(panelUser: string, paths: RootAccessPaths = DEFAULT_ROOT_ACCESS_PATHS): { granted: boolean; problem: string | null } {
  let grant: RootGrant | undefined;
  try {
    grant = readRootGrants(paths.grants, paths.rootUid).find((candidate) => candidate.user === panelUser);
  } catch (error) {
    return { granted: true, problem: `the root shell list cannot be read: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!grant) return { granted: false, problem: null };
  let db: Database;
  try {
    db = openPanelDatabase(paths.panelDb, true);
  } catch (error) {
    return { granted: true, problem: `CloudPanel's user list cannot be read: ${error instanceof Error ? error.message : String(error)}` };
  }
  try {
    return { granted: true, problem: grantProblem(db, grant) };
  } finally {
    db.close();
  }
}

/** `clp-addons terminal root [allow|deny <user>]`, as root. */
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
        fatal(`cannot read ${ROOT_GRANTS_FILE}: ${error instanceof Error ? error.message : String(error)}; nobody can open a root shell until it can be`);
      }
      fatal(`${error.message}, so nobody can open a root shell. Note who it allowed, remove it with rm ${ROOT_GRANTS_FILE}, then allow them again`);
    }
  };
  const db = openPanelDatabase(PANEL_DB, true);
  try {
    if (!verb) {
      const grants = read();
      if (!grants.length) log.plain("No administrator can open a root shell.");
      for (const grant of grants) log.plain(`${grant.user}: ${grantProblem(db, grant) ?? "can open a root shell"}`);
      return;
    }
    withFileLockSync(ROOT_GRANTS_LOCK, 15, "another terminal root change is still running", () => {
      const others = read().filter((grant) => grant.user !== user);
      if (verb === "deny") {
        writeRootGrants(others);
        return;
      }
      const found = account(db, user!);
      if (!found) fatal(`CloudPanel has no user ${user}`);
      if (Number(found.status) !== 1) fatal(`${user} is deactivated`);
      if (found.role !== "ROLE_ADMIN") fatal(`${user} is not an administrator`);
      writeRootGrants([...others, { user: user!, id: found.id }]);
      if (Number(found.mfa) !== 1) log.warn(`${user} has two-factor authentication off; root shells open once they turn it on`);
    });
  } finally {
    db.close();
  }
  log.ok(verb === "allow"
    ? `${user} can open a root shell from the panel while their two-factor authentication is on`
    : `${user} cannot open a root shell; any open one closes within 15 seconds`);
}

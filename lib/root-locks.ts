// Addons root has locked: the gateway lets their `lock` verbs only move toward
// the safer state and the manager refuses to disable them, so only a root shell
// can weaken what they protect. See docs/decisions/security.md#root-locks.
import {
  chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, type Stats,
} from "node:fs";
import { dirname } from "node:path";
import { CONFIG_DIR, LOCK_DIR } from "./paths";
import { ADDON_VERBS, type GatewayAddon, type LockDirection } from "./gateway-protocol";
import { writeFileAtomic } from "./atomic-write";
import { isTrustedDirectory, isTrustedFile } from "./trusted-file";

export const ROOT_LOCKS_FILE = `${CONFIG_DIR}/locks.json`;
export const ROOT_LOCKS_LOCK = `${LOCK_DIR}/locks.lock`;

/** Which way a lock on its addon still lets this verb go, or null when the lock does not cover it. */
export function lockDirection(addon: string, verb: string): LockDirection | null {
  const verbs = (ADDON_VERBS as Record<string, Record<string, { lock?: unknown }>>)[addon];
  const declared = verbs && Object.hasOwn(verbs, verb) ? verbs[verb] : undefined;
  return declared?.lock === "on" || declared?.lock === "newer" ? declared.lock : null;
}

export function declaresLock(addon: string, verb: string): boolean {
  return lockDirection(addon, verb) !== null;
}

/**
 * Whether an `"on"` verb's JSON input only switches things on: an object
 * naming at least one setting, every one of them true.
 */
export function switchesOnOnly(input: string | undefined): boolean {
  if (input === undefined) return false;
  let body: unknown;
  try { body = JSON.parse(input); } catch { return false; }
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const values = Object.values(body);
  return values.length > 0 && values.every((value) => value === true);
}

/** What the web is told when a lock refuses a change. */
export function lockRefusal(addon: string): string {
  return `root has locked ${addon}; run clp-addons unlock ${addon} on the server`;
}

export const LOCKABLE_ADDONS = (Object.keys(ADDON_VERBS) as GatewayAddon[]).filter((addon) =>
  Object.keys(ADDON_VERBS[addon]).some((verb) => declaresLock(addon, verb)));

export function isLockable(addon: string): boolean {
  return (LOCKABLE_ADDONS as string[]).includes(addon);
}

const errno = (error: unknown) => (error as NodeJS.ErrnoException)?.code;

/**
 * The lock file, or with `directory` its directory, is wrong. Root recovers
 * from a bad file by removing it and locking again, and from a bad directory
 * by making it root's alone.
 */
export class UntrustedLockFile extends Error {
  constructor(message: string, readonly directory = false) { super(message); }
}

/**
 * The locked addons. Only a missing directory or file means none. A file or
 * directory root does not own alone, or one that does not parse, throws
 * UntrustedLockFile; any other error is thrown as it is. Either way the caller
 * fails closed. The file is checked and read through one descriptor.
 */
export function lockedAddons(file = ROOT_LOCKS_FILE, rootUid = 0): string[] {
  const dir = dirname(file);
  let dirInfo: Stats;
  try {
    dirInfo = lstatSync(dir);
  } catch (error) {
    if (errno(error) === "ENOENT") return [];
    throw error;
  }
  if (!isTrustedDirectory(dirInfo, rootUid)) throw new UntrustedLockFile(`${dir} is not a directory only root can write`, true);
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (errno(error) === "ENOENT") return [];
    // O_NOFOLLOW refuses a link with ELOOP.
    if (errno(error) === "ELOOP") throw new UntrustedLockFile(`${file} is not a trusted regular file`);
    throw error;
  }
  try {
    const info = fstatSync(fd);
    if (!isTrustedFile(info, rootUid)) throw new UntrustedLockFile(`${file} is not a trusted regular file`);
    let stored: { addons?: unknown } | null;
    try {
      stored = JSON.parse(readFileSync(fd, "utf8"));
    } catch {
      throw new UntrustedLockFile(`${file} is not valid JSON`);
    }
    if (!Array.isArray(stored?.addons)) throw new UntrustedLockFile(`${file} has no addons list`);
    return stored.addons.filter((addon): addon is string => typeof addon === "string");
  } finally {
    closeSync(fd);
  }
}

/** "damaged" when the lock file cannot be read or trusted, which locks every lockable addon. */
export type LockState = "unlocked" | "locked" | "damaged";

export function lockState(addon: string, file = ROOT_LOCKS_FILE, rootUid = 0): LockState {
  if (!isLockable(addon)) return "unlocked";
  try {
    return lockedAddons(file, rootUid).includes(addon) ? "locked" : "unlocked";
  } catch {
    return "damaged";
  }
}

export function addonLocked(addon: string, file = ROOT_LOCKS_FILE, rootUid = 0): boolean {
  return lockState(addon, file, rootUid) !== "unlocked";
}

export function verbLocked(addon: string, verb: string, file = ROOT_LOCKS_FILE, rootUid = 0): boolean {
  return declaresLock(addon, verb) && addonLocked(addon, file, rootUid);
}

/** Readable by the manager, which shows the locks; written by root alone. */
export function writeLockedAddons(addons: string[], file = ROOT_LOCKS_FILE, rootUid = 0): void {
  // mkdir's mode is masked by root's umask, which could leave a directory
  // lockedAddons refuses, so the mode is set outright.
  if (mkdirSync(dirname(file), { recursive: true })) chmodSync(dirname(file), 0o755);
  writeFileAtomic(file, `${JSON.stringify({ addons: [...new Set(addons)].sort() }, null, 2)}\n`,
    { mode: 0o644, owner: { uid: rootUid, gid: rootUid === 0 ? 0 : process.getgid?.() ?? 0 } });
}

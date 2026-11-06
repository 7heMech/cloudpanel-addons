// Addons root has locked: the gateway refuses their `lock` verbs and the
// manager refuses to disable them, so only a root shell can change what they
// protect. See docs/decisions/security.md#root-locks.
import { existsSync, lstatSync, readFileSync, type Stats } from "node:fs";
import { dirname } from "node:path";
import { ADDON_VERBS, type GatewayAddon } from "./gateway-protocol";
import { writeFileAtomic } from "./atomic-write";

export const ROOT_LOCKS_FILE = "/etc/clp-addons/locks.json";

/** Addons with at least one verb a lock covers. */
export const LOCKABLE_ADDONS = (Object.keys(ADDON_VERBS) as GatewayAddon[]).filter((addon) =>
  Object.values(ADDON_VERBS[addon]).some((declared) => "lock" in declared && declared.lock === true));

export function isLockable(addon: string): boolean {
  return (LOCKABLE_ADDONS as string[]).includes(addon);
}

const rootsAlone = (info: Stats, rootUid: number) => info.uid === rootUid && (info.mode & 0o022) === 0;

/**
 * The locked addons. A file, or a directory that could lose it, that root does
 * not own alone is refused, so the caller fails closed.
 */
export function lockedAddons(file = ROOT_LOCKS_FILE, rootUid = 0): string[] {
  const dir = dirname(file);
  if (!existsSync(dir)) return [];
  const dirInfo = lstatSync(dir);
  if (!dirInfo.isDirectory() || !rootsAlone(dirInfo, rootUid)) throw new Error(`${dir} is not a directory only root can write`);
  if (!existsSync(file)) return [];
  const info = lstatSync(file);
  if (!info.isFile() || !rootsAlone(info, rootUid)) throw new Error(`${file} is not a trusted regular file`);
  let stored: { addons?: unknown } | null;
  try {
    stored = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`${file} is not valid JSON`);
  }
  if (!Array.isArray(stored?.addons)) throw new Error(`${file} has no addons list`);
  return stored.addons.filter((addon): addon is string => typeof addon === "string");
}

/** Whether a verb is one root's lock on its addon withholds from the web right now. */
export function verbLocked(addon: string, verb: string, file = ROOT_LOCKS_FILE, rootUid = 0): boolean {
  const declared = (ADDON_VERBS as Record<string, Record<string, object>>)[addon]?.[verb];
  return !!declared && "lock" in declared && declared.lock === true && addonLocked(addon, file, rootUid);
}

/** Whether an addon is locked; true too when the file cannot be trusted. */
export function addonLocked(addon: string, file = ROOT_LOCKS_FILE, rootUid = 0): boolean {
  try {
    return lockedAddons(file, rootUid).includes(addon);
  } catch {
    return true;
  }
}

/** Readable by the manager, which shows the locks; written by root alone. */
export function writeLockedAddons(addons: string[], file = ROOT_LOCKS_FILE): void {
  writeFileAtomic(file, `${JSON.stringify({ addons: [...new Set(addons)].sort() }, null, 2)}\n`,
    { mode: 0o644, owner: { uid: 0, gid: 0 }, createParent: true });
}

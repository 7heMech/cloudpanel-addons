// Addons root has locked: the gateway refuses their `lock` verbs and the
// manager refuses to disable them, so only a root shell can change what they
// protect. See docs/decisions/security.md#root-locks.
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { ADDON_VERBS, type GatewayAddon } from "./gateway-protocol";
import { writeFileAtomic } from "./atomic-write";

export const ROOT_LOCKS_FILE = "/etc/clp-addons/locks.json";

/** Addons with at least one verb a lock covers. */
export const LOCKABLE_ADDONS = (Object.keys(ADDON_VERBS) as GatewayAddon[]).filter((addon) =>
  Object.values(ADDON_VERBS[addon]).some((declared) => "lock" in declared && declared.lock === true));

/** The locked addons. A file root does not own alone is refused, so the caller fails closed. */
export function lockedAddons(file = ROOT_LOCKS_FILE, rootUid = 0): string[] {
  if (!existsSync(file)) return [];
  const info = lstatSync(file);
  if (!info.isFile() || info.uid !== rootUid || (info.mode & 0o022) !== 0) throw new Error(`${file} is not a trusted regular file`);
  let stored: { addons?: unknown } | null;
  try {
    stored = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`${file} is not valid JSON`);
  }
  if (!Array.isArray(stored?.addons)) throw new Error(`${file} has no addons list`);
  return stored.addons.filter((addon): addon is string => typeof addon === "string");
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

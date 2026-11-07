// Root's side of the locks: `lock`, `unlock`, System Tweaks' `lock-settings`
// and a fresh install change the list here, one at a time. The manager only
// reads it, through lib/root-locks.ts, which loads no FFI.
import { withFileLockSync } from "./action-common";
import { ROOT_LOCKS_FILE, ROOT_LOCKS_LOCK, UntrustedLockFile, lockedAddons, writeLockedAddons } from "../lib/root-locks";

/** Tests only: a lock file and its file lock of their own, owned by them. */
export interface LockFiles {
  file: string;
  rootUid: number;
  lockFile?: string;
}

/** Why the list cannot be read, and what root does about it. */
export function lockFileProblem(error: unknown, file = ROOT_LOCKS_FILE): string {
  if (!(error instanceof UntrustedLockFile)) {
    return `cannot read ${file}: ${error instanceof Error ? error.message : String(error)}; every lockable addon counts as locked until it can be`;
  }
  return `${error.message}, so every lockable addon counts as locked. ` + (error.directory
    ? "Make it owned by root and not writable by group or others, then run this again"
    : `Note what it locked, remove it with rm ${file}, then lock those addons again`);
}

/**
 * Adds or removes one addon under the locks' file lock, after the same file and
 * directory checks every reader makes; a list it cannot trust throws, and
 * nothing is written. False when it was already so.
 */
export function changeLock(addon: string, lock: boolean, files?: LockFiles): boolean {
  const file = files?.file ?? ROOT_LOCKS_FILE;
  const rootUid = files?.rootUid ?? 0;
  return withFileLockSync(files?.lockFile ?? ROOT_LOCKS_LOCK, 15, "another lock or unlock is still running", () => {
    const current = lockedAddons(file, rootUid);
    if (lock === current.includes(addon)) return false;
    writeLockedAddons(lock ? [...current, addon] : current.filter((name) => name !== addon), file, rootUid);
    return true;
  });
}

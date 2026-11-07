/** The saved memory policy and its lifecycle, independent of PHP's category policy. */
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { errorMessage, failAction, withFileLock, withFileLockSync } from "../../cli/action-common";
import { CONFIG_DIR, LOCK_DIR, STATE_DIR } from "../../cli/paths";
import { writeFileAtomic } from "../../lib/atomic-write";
import { MEMORY_DEADLINE_MS } from "./limits";
import {
  DEFAULT_MEMORY, MEMORY_ERROR, applyMemory, memoryChange, memoryStatus, syncMemory, validMemorySettings,
  type MemoryOptions, type MemorySettings, type MemoryStatus,
} from "./memory";

export const DEFAULT_MEMORY_SETTINGS_PATHS = {
  settingsFile: `${STATE_DIR}/resource-limits/settings.json`,
  lockFile: `${LOCK_DIR}/resource-limits-settings.lock`,
  enabledConfig: `${CONFIG_DIR}/resource-limits.conf`,
  rootUid: 0,
};
export interface ResourceMemoryOptions {
  memorySettings?: Partial<typeof DEFAULT_MEMORY_SETTINGS_PATHS>;
  memory?: MemoryOptions;
}
export type ResourceMemoryState = (MemoryStatus & { settings: MemorySettings }) | { error: string };

export function readMemorySettings(options: ResourceMemoryOptions = {}): MemorySettings {
  const paths = { ...DEFAULT_MEMORY_SETTINGS_PATHS, ...options.memorySettings };
  if (!existsSync(paths.settingsFile)) return { ...DEFAULT_MEMORY };
  const info = lstatSync(paths.settingsFile);
  if (!info.isFile() || info.uid !== paths.rootUid || (info.mode & 0o022) !== 0) {
    failAction("the resource limits settings file is not a trusted regular file");
  }
  const saved = JSON.parse(readFileSync(paths.settingsFile, "utf8"));
  if (saved?.version !== 1 || !validMemorySettings(saved.memory)) failAction("invalid resource limits memory settings");
  return { ...saved.memory };
}

function writeSettings(memory: MemorySettings, options: ResourceMemoryOptions): void {
  const paths = { ...DEFAULT_MEMORY_SETTINGS_PATHS, ...options.memorySettings };
  writeFileAtomic(paths.settingsFile, `${JSON.stringify({ version: 1, memory }, null, 2)}\n`, { mode: 0o600, createParent: true });
}

export function resourceMemoryState(options: ResourceMemoryOptions = {}): ResourceMemoryState {
  try {
    const settings = readMemorySettings(options);
    return { ...memoryStatus(settings, options.memory), settings };
  } catch (error) { return { error: errorMessage(error) }; }
}

/** Save before applying so a service starting meanwhile reads the same policy. */
export async function setResourceMemory(body: Record<string, unknown>, options: ResourceMemoryOptions = {}): Promise<{ memory: MemorySettings }> {
  const change = memoryChange(body);
  if (!change) failAction(MEMORY_ERROR);
  const paths = { ...DEFAULT_MEMORY_SETTINGS_PATHS, ...options.memorySettings };
  return withFileLock(paths.lockFile, 15, "another resource limits change is still running", async () => {
    if (!existsSync(paths.enabledConfig)) failAction("Resource Limits is disabled");
    const bounded = { ...options.memory, deadline: (options.memory?.now ?? Date.now)() + MEMORY_DEADLINE_MS };
    const before = readMemorySettings(options);
    const wanted = { ...before, ...change };
    writeSettings(wanted, options);
    try { applyMemory(wanted, bounded); }
    catch (error) {
      writeSettings(before, options);
      try { applyMemory(before, bounded, false); } catch { /* repair retries */ }
      throw error;
    }
    return { memory: wanted };
  });
}

/**
 * Used by activation, repair and new-site discovery (including newly installed
 * PHP versions). With `ifIdle`, a memory change that holds the lock -- for up
 * to two minutes -- is left to apply the settings itself, rather than failing
 * the run that asked.
 */
export function restoreResourceMemory(options: ResourceMemoryOptions = {}, ifIdle = false): string[] {
  const paths = { ...DEFAULT_MEMORY_SETTINGS_PATHS, ...options.memorySettings };
  const busy = "another resource limits change is still running";
  try {
    return withFileLockSync(paths.lockFile, ifIdle ? 0 : 15, busy, () =>
      existsSync(paths.enabledConfig) ? applyMemory(readMemorySettings(options), options.memory) : []);
  } catch (error) {
    if (ifIdle && errorMessage(error) === busy) return [];
    throw error;
  }
}

/**
 * How long withdrawing waits for a change to finish. It runs once the enabled
 * record is gone, so giving up would leave the limits with nothing to retry.
 */
export const WITHDRAW_LOCK_WAIT_S = MEMORY_DEADLINE_MS / 1000 + 30;

/** Run after the enabled record is removed, so a service hook cannot put the limits back. */
export function withdrawResourceMemory(options: ResourceMemoryOptions = {}): void {
  const paths = { ...DEFAULT_MEMORY_SETTINGS_PATHS, ...options.memorySettings };
  withFileLockSync(paths.lockFile, WITHDRAW_LOCK_WAIT_S, "another resource limits change is still running", () => {
    // A late start hook may have queued cleanup just before the addon was re-enabled.
    if (existsSync(paths.enabledConfig)) return;
    applyMemory({ ...DEFAULT_MEMORY, mysql: false, redis: false, oom: false }, options.memory, false);
  });
}

/**
 * What MySQL's and Redis's start hooks run. It reads the setting without the
 * lock, which a change holds for up to two minutes: the settings file is
 * replaced in one rename, and the change saves before it applies. A change
 * saved while this applied the old settings may also have finished first, so
 * the settings are read again and, if they moved, applied once more.
 */
export function resourceLimitsMemory(kind: "mysql" | "redis", options: ResourceMemoryOptions = {}): boolean {
  const paths = { ...DEFAULT_MEMORY_SETTINGS_PATHS, ...options.memorySettings };
  if (!existsSync(paths.enabledConfig)) return false;
  const applied = readMemorySettings(options);
  let changed = syncMemory(kind, applied, options.memory);
  const latest = readMemorySettings(options);
  if (JSON.stringify(latest) !== JSON.stringify(applied)) changed = syncMemory(kind, latest, options.memory) || changed;
  // A disable may have removed its files while the hook was running.
  if (!existsSync(paths.enabledConfig)) withdrawResourceMemory(options);
  return changed;
}

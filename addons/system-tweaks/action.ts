/**
 * The privileged half of System Tweaks: server-wide settings that only root
 * can read in full or change.
 *
 * One settings file holds what the operator chose. The apt drop-in and the PHP
 * guard are what those choices put on the box, and both are rebuilt from it by
 * the repair timer, by enabling the addon, and by the action that changed it.
 */
import { existsSync, lstatSync, readFileSync } from "node:fs";
import {
  ActionFailure, emitActionError, emitActionOk, failAction, withFileLock,
} from "../../cli/action-common";
import { ROOT_UID, STATE_DIR } from "../../cli/paths";
import { reconcilePhpGuard, type PhpGuardOptions } from "../../cli/php-guard";
import { writeFileAtomic } from "../../lib/atomic-write";
import {
  DEFAULT_UPDATE_SETTINGS, UPDATE_SETTING_KEYS, applyUpdates, effectiveReboot, installUnattendedUpgrades, unattendedUpgradesInstalled, updatesStatus,
  type UpdateSettings, type UpdatesOptions, type UpdatesStatus,
} from "./updates";
import { uploadProgressStatus, type FpmUploadProgress, type UploadProgressOptions } from "./upload-progress";

const SETTINGS_VERSION = 1;
const MAX_INPUT_BYTES = 4 * 1024;

export type SystemTweaksVerb = "state" | "set-updates" | "install-updates" | "set-upload-guard";

export interface SystemTweaksSettings {
  updates: UpdateSettings;
  /** Timers this addon enabled because they were off, and disables again with the switch. */
  enabledTimers: string[];
  /** The platform's PHP upload-progress guard; false is the only opt-out there is. */
  uploadProgressGuard: boolean;
}

export interface SystemTweaksState {
  updates: UpdatesStatus;
  settings: UpdateSettings;
  uploadProgress: { guard: boolean; fpms: FpmUploadProgress[] };
}

export interface SystemTweaksPaths {
  settingsFile: string;
  lockFile: string;
  rootUid: number;
}

export const DEFAULT_SYSTEM_TWEAKS_PATHS: SystemTweaksPaths = {
  settingsFile: `${STATE_DIR}/system-tweaks/settings.json`,
  lockFile: "/run/lock/clp-addons/system-tweaks.lock",
  rootUid: ROOT_UID,
};

export interface SystemTweaksOptions {
  paths?: Partial<SystemTweaksPaths>;
  input?: string;
  emitReply?: boolean;
  processUid?: number;
  updates?: UpdatesOptions;
  uploadProgress?: UploadProgressOptions;
  phpGuard?: PhpGuardOptions;
}

function pathsFor(options: SystemTweaksOptions): SystemTweaksPaths {
  return { ...DEFAULT_SYSTEM_TWEAKS_PATHS, ...options.paths };
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function readSettings(paths: SystemTweaksPaths): SystemTweaksSettings {
  const settings: SystemTweaksSettings = {
    updates: { ...DEFAULT_UPDATE_SETTINGS },
    enabledTimers: [],
    uploadProgressGuard: true,
  };
  if (!existsSync(paths.settingsFile)) return settings;
  const info = lstatSync(paths.settingsFile);
  if (!info.isFile() || info.uid !== paths.rootUid || (info.mode & 0o022) !== 0) {
    failAction("the system tweaks settings file is not a trusted regular file");
  }
  let stored: Record<string, unknown>;
  try {
    stored = JSON.parse(readFileSync(paths.settingsFile, "utf8"));
  } catch {
    return settings;
  }
  if (stored?.version !== SETTINGS_VERSION) return settings;
  const updates = (stored.updates ?? {}) as Record<string, unknown>;
  for (const key of UPDATE_SETTING_KEYS) if (typeof updates[key] === "boolean") settings.updates[key] = updates[key];
  if (Array.isArray(stored.enabledTimers)) {
    settings.enabledTimers = stored.enabledTimers.filter((timer): timer is string =>
      timer === "apt-daily.timer" || timer === "apt-daily-upgrade.timer");
  }
  if (stored.uploadProgressGuard === false) settings.uploadProgressGuard = false;
  return settings;
}

function writeSettings(paths: SystemTweaksPaths, settings: SystemTweaksSettings): void {
  writeFileAtomic(
    paths.settingsFile,
    `${JSON.stringify({ version: SETTINGS_VERSION, ...settings }, null, 2)}\n`,
    { mode: 0o600, createParent: true },
  );
}

function guardOptions(options: SystemTweaksOptions): PhpGuardOptions {
  const paths = pathsFor(options);
  return { ...options.phpGuard, paths: { optOutSettings: paths.settingsFile, ...options.phpGuard?.paths } };
}

function stateOf(options: SystemTweaksOptions): SystemTweaksState {
  const settings = readSettings(pathsFor(options));
  return {
    updates: updatesStatus(options.updates),
    settings: settings.updates,
    uploadProgress: {
      guard: settings.uploadProgressGuard,
      fpms: uploadProgressStatus(options.uploadProgress),
    },
  };
}

async function requestBody(options: SystemTweaksOptions): Promise<Record<string, unknown>> {
  const raw = options.input !== undefined ? options.input : await Bun.stdin.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_INPUT_BYTES) failAction("the request is too large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    failAction("the request must be JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) failAction("the request must be a JSON object");
  return parsed as Record<string, unknown>;
}

async function setUpdates(options: SystemTweaksOptions): Promise<SystemTweaksState> {
  const paths = pathsFor(options);
  const body = await requestBody(options);
  await withFileLock(paths.lockFile, 15, "another system tweaks change is still running", async () => {
    const settings = readSettings(paths);
    const wanted = { ...settings.updates };
    let named = 0;
    for (const key of UPDATE_SETTING_KEYS) {
      if (body[key] === undefined) continue;
      if (typeof body[key] !== "boolean") failAction(`${key} must be true or false`);
      wanted[key] = body[key];
      named++;
    }
    if (named === 0) failAction("no setting was named");
    // The first switch-on keeps the reboot policy the box already had.
    if (wanted.enabled && !settings.updates.enabled && body.reboot === undefined) wanted.reboot = effectiveReboot(options.updates);
    const applied = applyUpdates(wanted, settings.enabledTimers, options.updates);
    writeSettings(paths, { ...settings, updates: wanted, enabledTimers: applied.enabledTimers });
  });
  return stateOf(options);
}

async function setUploadGuard(options: SystemTweaksOptions): Promise<SystemTweaksState> {
  const paths = pathsFor(options);
  const body = await requestBody(options);
  if (typeof body.enabled !== "boolean") failAction("enabled must be true or false");
  await withFileLock(paths.lockFile, 15, "another system tweaks change is still running", async () => {
    const settings = readSettings(paths);
    writeSettings(paths, { ...settings, uploadProgressGuard: body.enabled as boolean });
    try {
      reconcilePhpGuard(true, true, guardOptions(options));
    } catch (error) {
      writeSettings(paths, settings);
      throw error;
    }
  });
  return stateOf(options);
}

function parseVerb(argv: string[]): SystemTweaksVerb {
  const [rawVerb, ...rest] = argv;
  const verbs: SystemTweaksVerb[] = ["state", "set-updates", "install-updates", "set-upload-guard"];
  const verb = verbs.find((known) => known === rawVerb);
  if (!verb) failAction(`unknown system tweaks verb '${rawVerb ?? ""}'`);
  if (rest.length > 0) failAction(`unexpected argument '${rest[0]}'`);
  return verb;
}

export async function executeSystemTweaksAction(argv: string[], options: SystemTweaksOptions = {}): Promise<unknown> {
  if ((options.processUid ?? process.getuid?.()) !== 0) failAction("system tweaks actions must run as root");
  const verb = parseVerb(argv);
  if (verb === "state") return stateOf(options);
  if (verb === "set-updates") return setUpdates(options);
  if (verb === "set-upload-guard") return setUploadGuard(options);
  await withFileLock(pathsFor(options).lockFile, 15, "another system tweaks change is still running", async () =>
    installUnattendedUpgrades(options.updates));
  return stateOf(options);
}

export async function runSystemTweaksAction(argv: string[], options: SystemTweaksOptions = {}): Promise<number> {
  const emit = options.emitReply !== false;
  try {
    const data = await executeSystemTweaksAction(argv, options);
    if (emit) emitActionOk(data);
    return 0;
  } catch (error) {
    const message = reason(error);
    if (emit) emitActionError(message, error instanceof ActionFailure ? error.data : undefined, "system-tweaks");
    else process.stderr.write(`[system-tweaks] ERROR: ${message}\n`);
    return 1;
  }
}

/** The repair hook: put the apt drop-in back to the stored choice when it drifted. */
export function systemTweaksUpkeep(options: SystemTweaksOptions = {}): string | null {
  const paths = pathsFor(options);
  const settings = readSettings(paths);
  if (!settings.updates.enabled || !unattendedUpgradesInstalled(options.updates)) return null;
  const applied = applyUpdates(settings.updates, settings.enabledTimers, options.updates);
  if (applied.enabledTimers.length !== settings.enabledTimers.length) writeSettings(paths, { ...settings, enabledTimers: applied.enabledTimers });
  return applied.changed ? "automatic updates config restored" : null;
}

/** Disabling the addon takes its apt drop-in and the timers it enabled away, and keeps the choice. */
export function withdrawSystemTweaks(options: SystemTweaksOptions = {}): void {
  const paths = pathsFor(options);
  const settings = readSettings(paths);
  applyUpdates({ ...settings.updates, enabled: false }, settings.enabledTimers, options.updates);
  if (settings.enabledTimers.length) writeSettings(paths, { ...settings, enabledTimers: [] });
}

/** Enabling it again puts both back as they were chosen. */
export function restoreSystemTweaks(options: SystemTweaksOptions = {}): void {
  const paths = pathsFor(options);
  const settings = readSettings(paths);
  if (settings.updates.enabled && unattendedUpgradesInstalled(options.updates)) {
    const applied = applyUpdates(settings.updates, settings.enabledTimers, options.updates);
    writeSettings(paths, { ...settings, enabledTimers: applied.enabledTimers });
  }
  if (!settings.uploadProgressGuard) reconcilePhpGuard(true, false, guardOptions(options));
}

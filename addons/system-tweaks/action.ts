/** Root actions and lifecycle hooks for server-wide update and PHP settings. */
import { existsSync, lstatSync, readFileSync } from "node:fs";
import {
  ActionFailure, emitActionError, emitActionOk, failAction, withFileLock, withFileLockSync,
} from "../../cli/action-common";
import { ROOT_UID, STATE_DIR } from "../../cli/paths";
import { reconcilePhpGuard, type PhpGuardOptions } from "../../cli/php-guard";
import { writeFileAtomic } from "../../lib/atomic-write";
import {
  DEFAULT_UPDATE_SETTINGS, REBOOT_TIME_ERROR, UPDATE_SETTING_KEYS, applyUpdates, validRebootTime, effectiveReboot, installUnattendedUpgrades, systemRun, unattendedUpgradesInstalled, updatesStatus, withDeadline,
  type UpdateSettings, type UpdatesOptions, type UpdatesStatus,
} from "./updates";
import { INSTALL_DEADLINE_MS } from "./limits";
import { uploadProgressStatus, type FpmUploadProgress, type UploadProgressOptions } from "./upload-progress";
import { applyRealIp, realIpStatus, type RealIpOptions, type RealIpStatus } from "./real-ip";
import {
  panelPhpStatus, reconcilePanelPhp, restorePanelPhp, setPanelPhp, withdrawPanelPhp, type PanelPhpOptions, type PanelPhpStatus,
} from "./panel-php";
import { clearAbandonedTmpFiles, type TmpCleanupOptions } from "../../cli/tmp-cleanup";

const SETTINGS_VERSION = 1;
const MAX_INPUT_BYTES = 4 * 1024;

export type SystemTweaksVerb = "state" | "set-updates" | "install-updates" | "set-upload-guard" | "set-real-ip" | "set-panel-php";

export interface SystemTweaksSettings {
  updates: UpdateSettings;
  /** Timers this addon enabled because they were off, and disables again with the switch. */
  enabledTimers: string[];
  /** The platform's PHP upload-progress guard; false is the only opt-out there is. */
  uploadProgressGuard: boolean;
  /** Stop nginx.conf trusting X-Real-IP from every address. */
  blockForgedRealIp: boolean;
}

export interface SystemTweaksState {
  updates: UpdatesStatus;
  settings: UpdateSettings;
  uploadProgress: { guard: boolean; fpms: FpmUploadProgress[] };
  realIp: RealIpStatus & { blockForged: boolean };
  panelPhp: PanelPhpStatus | { error: string };
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
  realIp?: RealIpOptions;
  panelPhp?: PanelPhpOptions;
  tmpCleanup?: TmpCleanupOptions;
  now?: () => number;
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
    blockForgedRealIp: true,
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
  if (validRebootTime(updates.rebootTime)) settings.updates.rebootTime = updates.rebootTime;
  if (Array.isArray(stored.enabledTimers)) {
    settings.enabledTimers = stored.enabledTimers.filter((timer): timer is string =>
      timer === "apt-daily.timer" || timer === "apt-daily-upgrade.timer");
  }
  if (stored.uploadProgressGuard === false) settings.uploadProgressGuard = false;
  if (stored.blockForgedRealIp === false) settings.blockForgedRealIp = false;
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
    realIp: { ...realIpStatus(options.realIp), blockForged: settings.blockForgedRealIp },
    panelPhp: panelPhpOrError(options.panelPhp),
  };
}

function panelPhpOrError(options?: PanelPhpOptions): PanelPhpStatus | { error: string } {
  try { return panelPhpStatus(options); }
  catch (error) { return { error: reason(error) }; }
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
    if (body.rebootTime !== undefined) {
      if (!validRebootTime(body.rebootTime)) failAction(REBOOT_TIME_ERROR);
      wanted.rebootTime = body.rebootTime;
      named++;
    }
    if (named === 0) failAction("no setting was named");
    // The first switch-on keeps the reboot policy the box already had.
    if (wanted.enabled && !settings.updates.enabled) {
      const had = effectiveReboot(options.updates);
      if (body.reboot === undefined) wanted.reboot = had.reboot;
      if (body.rebootTime === undefined) wanted.rebootTime = had.rebootTime;
    }
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

async function setRealIp(options: SystemTweaksOptions): Promise<SystemTweaksState> {
  const paths = pathsFor(options);
  const body = await requestBody(options);
  if (typeof body.enabled !== "boolean") failAction("enabled must be true or false");
  await withFileLock(paths.lockFile, 15, "another system tweaks change is still running", async () => {
    const settings = readSettings(paths);
    applyRealIp(body.enabled as boolean, options.realIp);
    writeSettings(paths, { ...settings, blockForgedRealIp: body.enabled as boolean });
  });
  return stateOf(options);
}

async function changePanelPhp(options: SystemTweaksOptions): Promise<SystemTweaksState> {
  const body = await requestBody(options);
  if (typeof body.php !== "string") failAction("php must be a version such as 8.4, or empty for CloudPanel's own");
  await setPanelPhp(body.php, options.panelPhp);
  return stateOf(options);
}

function parseVerb(argv: string[]): SystemTweaksVerb {
  const [rawVerb, ...rest] = argv;
  const verbs: SystemTweaksVerb[] = ["state", "set-updates", "install-updates", "set-upload-guard", "set-real-ip", "set-panel-php"];
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
  if (verb === "set-real-ip") return setRealIp(options);
  if (verb === "set-panel-php") return changePanelPhp(options);
  // One deadline for the install and the state read that answers it, which the
  // gateway's timeout is sized from.
  const now = options.now ?? Date.now;
  const run = withDeadline(options.updates?.run ?? systemRun, now() + INSTALL_DEADLINE_MS, now);
  const bounded = { ...options, updates: { ...options.updates, run }, uploadProgress: { ...options.uploadProgress, run } };
  await withFileLock(pathsFor(options).lockFile, 15, "another system tweaks change is still running", async () =>
    installUnattendedUpgrades(bounded.updates));
  return stateOf(bounded);
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

function withSettingsLock<T>(options: SystemTweaksOptions, body: (paths: SystemTweaksPaths, settings: SystemTweaksSettings) => T): T {
  const paths = pathsFor(options);
  return withFileLockSync(paths.lockFile, 15, "another system tweaks change is still running", () => body(paths, readSettings(paths)));
}

/**
 * The repair hook: the box's own settings, then the panel's PHP. A version
 * that failed is not retried until its package release changes.
 */
export async function systemTweaksMaintenance(options: SystemTweaksOptions = {}): Promise<string | null> {
  const lines: string[] = [];
  const failures: string[] = [];
  try {
    const tmp = clearAbandonedTmpFiles(options.tmpCleanup);
    if (tmp) lines.push(tmp);
  } catch (error) {
    failures.push(`/tmp cleanup: ${reason(error)}`);
  }
  try {
    const upkeep = systemTweaksUpkeep(options);
    if (upkeep) lines.push(upkeep);
  } catch (error) {
    failures.push(reason(error));
  }
  try {
    const php = await reconcilePanelPhp(options.panelPhp);
    if (php) lines.push(php);
  } catch (error) {
    failures.push(`panel PHP: ${reason(error)}`);
  }
  if (failures.length) throw new Error([...failures, ...lines].join("; "));
  return lines.join("; ") || null;
}

export function systemTweaksUpkeep(options: SystemTweaksOptions = {}): string | null {
  return withSettingsLock(options, (paths, settings) => {
    const notices: string[] = [];
    if (settings.updates.enabled && unattendedUpgradesInstalled(options.updates)) {
      const applied = applyUpdates(settings.updates, settings.enabledTimers, options.updates);
      if (applied.enabledTimers.length !== settings.enabledTimers.length) writeSettings(paths, { ...settings, enabledTimers: applied.enabledTimers });
      if (applied.changed) notices.push("automatic updates config restored");
    }
    if (settings.blockForgedRealIp && applyRealIp(true, options.realIp)) notices.push("visitor-IP trust narrowed again");
    return notices.join("; ") || null;
  });
}

export function withdrawSystemTweaks(options: SystemTweaksOptions = {}): void {
  // First, because it refuses when CloudPanel's own PHP would not come back.
  withdrawPanelPhp(options.panelPhp);
  try {
    withSettingsLock(options, (paths, settings) => {
      applyUpdates({ ...settings.updates, enabled: false }, settings.enabledTimers, options.updates);
      if (settings.enabledTimers.length) writeSettings(paths, { ...settings, enabledTimers: [] });
      applyRealIp(false, options.realIp);
    });
  } catch (error) {
    // The addon stays enabled, so its panel PHP choice comes back with it.
    restorePanelPhp(options.panelPhp);
    throw error;
  }
}

export function restoreSystemTweaks(options: SystemTweaksOptions = {}): void {
  try {
    withSettingsLock(options, (paths, settings) => {
      if (settings.updates.enabled && unattendedUpgradesInstalled(options.updates)) {
        const applied = applyUpdates(settings.updates, settings.enabledTimers, options.updates);
        writeSettings(paths, { ...settings, enabledTimers: applied.enabledTimers });
      }
      if (!settings.uploadProgressGuard) reconcilePhpGuard(true, false, guardOptions(options));
      if (settings.blockForgedRealIp) applyRealIp(true, options.realIp);
    });
  } finally {
    restorePanelPhp(options.panelPhp);
  }
}

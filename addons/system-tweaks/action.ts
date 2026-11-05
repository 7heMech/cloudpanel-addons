/** Root actions and lifecycle hooks for server-wide update and PHP settings. */
import { SYSTEM_TWEAKS_VERBS } from "./verbs";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import {
  replyToAction, errorMessage, failAction, readJsonRequest, withFileLock, withFileLockSync,
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
import { applyPhpMyAdmin, phpMyAdminStatus, type PhpMyAdminOptions, type PhpMyAdminStatus } from "./phpmyadmin";
import { panelCertStatus, replacePanelCert, type PanelCertOptions, type PanelCertStatus } from "./panel-cert";
import {
  panelPhpStatus, reconcilePanelPhp, restorePanelPhp, setPanelPhp, withdrawPanelPhp, type PanelPhpOptions, type PanelPhpStatus,
} from "./panel-php";
import { log } from "../../cli/util";
import { clearAbandonedTmpFiles, type TmpCleanupOptions } from "../../cli/tmp-cleanup";
import {
  firewallStatus, setRuleProtocol, syncFirewall, type FirewallOptions, type FirewallStatus,
} from "./firewall";
import { installVhostGuard, queueVhostGuard, removeVhostGuard, vhostGuardStatus, type VhostGuardOptions } from "./vhost-guard";
import {
  fileManagerGuardStatus, installFileManagerGuard, queueFileManagerGuard, removeFileManagerGuard, type FileManagerGuardOptions,
} from "./file-manager-guard";
import { storedVhostValues, type StoredVhostValue, type VhostValuesOptions } from "./vhost-values";
import { installPoolIsolation, poolIsolationStatus, removePoolIsolation, syncPoolIsolation, type PoolIsolationOptions, type PoolIsolationStatus } from "./pool-isolation";
import { installVarnishBackends, removeVarnishBackends, sitesWithHomeLogs, sitesWithOwnLogrotate, varnishBackendsActive, type VarnishBackendOptions } from "./varnish-backend";
import {
  applyLoginJails, installLoginJailPackages, loginJailsStatus, releaseLoginJails, unban,
  type Fail2banBefore, type LoginJailOptions, type LoginJailSettings, type LoginJailsStatus,
} from "./login-jails";
import { databaseStatus, reconcileDatabaseFile, setDatabaseLoopback, type DatabaseOptions, type DatabaseStatus } from "./database";
import {
  applyClpctlGuard, clpctlGuardOrError, restoreClpctlWrapper, type ClpctlGuardOptions, type ClpctlGuardStatus,
} from "./clpctl-guard";
import {
  BACKUP_COMPRESSION_ERROR, DEFAULT_BACKUP_COMPRESSION, backupCompressionStatus, reconcileBackupCompression, validBackupCompression,
  type BackupCompressionOptions, type BackupCompressionSettings, type BackupCompressionStatus,
} from "./backup-compression";

const SETTINGS_VERSION = 1;
const MAX_INPUT_BYTES = 4 * 1024;

export type SystemTweaksVerb = keyof typeof SYSTEM_TWEAKS_VERBS;

export interface SystemTweaksSettings {
  updates: UpdateSettings;
  /** Timers this addon enabled because they were off, and disables again with the switch. */
  enabledTimers: string[];
  /** The platform's PHP upload-progress guard; false is the only opt-out there is. */
  uploadProgressGuard: boolean;
  /** Stop nginx.conf trusting X-Real-IP from every address. */
  blockForgedRealIp: boolean;
  /** Refuse panel input CloudPanel would write into a vhost unchecked, and render Varnish backends from a checked include. */
  blockVhostInjection: boolean;
  /** Let only nginx and each pool's own user connect to a site's PHP-FPM port. */
  isolatePhpPools: boolean;
  /** Keep basic auth outside phpMyAdmin and hide its example, setup and version files. */
  protectPhpMyAdmin: boolean;
  /** Refuse File Manager requests that leave the site's home, and leave its socket to clp. */
  confineFileManager: boolean;
  /** Replace CloudPanel's shared panel certificate with one generated here. */
  replacePanelCert: boolean;
  /** fail2ban jails for the panel login and for SSH. */
  loginJails: LoginJailSettings;
  /** fail2ban.service before System Tweaks first started it, which turning both jails off puts back. */
  fail2banBefore: Fail2banBefore | null;
  /** Have MySQL accept connections from this server only; off unless the operator asks, see database.ts. */
  databaseLoopback: boolean;
  /** Replace CloudPanel's clpctlWrapper with one that closes the sudo-to-root injection. */
  blockClpctlInjection: boolean;
  backupCompression: BackupCompressionSettings;
}

export interface SystemTweaksState {
  updates: UpdatesStatus;
  settings: UpdateSettings;
  uploadProgress: { guard: boolean; fpms: FpmUploadProgress[] };
  realIp: RealIpStatus & { blockForged: boolean };
  vhostGuard: { enabled: boolean; active: boolean; stored: StoredVhostValue[] | { error: string }; homeLogs: string[]; ownLogrotate: string[] };
  phpPools: PoolIsolationStatus & { enabled: boolean };
  phpMyAdmin: PhpMyAdminStatus & { enabled: boolean };
  fileManagerGuard: { enabled: boolean; active: boolean };
  panelCert: PanelCertStatus & { replace: boolean };
  clpctlGuard: ClpctlGuardStatus | { error: string };
  panelPhp: PanelPhpStatus | { error: string };
  firewall: FirewallStatus | { error: string };
  loginJails: (LoginJailsStatus & LoginJailSettings) | { error: string };
  database: (DatabaseStatus & { loopback: boolean }) | { error: string };
  backupCompression: BackupCompressionStatus;
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
  phpMyAdmin?: PhpMyAdminOptions;
  panelCert?: PanelCertOptions;
  vhostGuard?: VhostGuardOptions;
  fileManagerGuard?: FileManagerGuardOptions;
  vhostValues?: VhostValuesOptions;
  varnishBackend?: VarnishBackendOptions;
  phpPools?: PoolIsolationOptions;
  clpctlGuard?: ClpctlGuardOptions;
  panelPhp?: PanelPhpOptions;
  tmpCleanup?: TmpCleanupOptions;
  firewall?: FirewallOptions;
  loginJails?: LoginJailOptions;
  database?: DatabaseOptions;
  backupCompression?: BackupCompressionOptions;
  now?: () => number;
}

function pathsFor(options: SystemTweaksOptions): SystemTweaksPaths {
  return { ...DEFAULT_SYSTEM_TWEAKS_PATHS, ...options.paths };
}

export function readSettings(paths: SystemTweaksPaths): SystemTweaksSettings {
  const settings: SystemTweaksSettings = {
    updates: { ...DEFAULT_UPDATE_SETTINGS },
    enabledTimers: [],
    uploadProgressGuard: true,
    blockForgedRealIp: true,
    blockVhostInjection: true,
    isolatePhpPools: true,
    protectPhpMyAdmin: true,
    confineFileManager: true,
    replacePanelCert: true,
    loginJails: { panel: true, ssh: false },
    fail2banBefore: null,
    databaseLoopback: false,
    blockClpctlInjection: true,
    backupCompression: { ...DEFAULT_BACKUP_COMPRESSION },
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
  if (stored.blockVhostInjection === false) settings.blockVhostInjection = false;
  if (stored.isolatePhpPools === false) settings.isolatePhpPools = false;
  if (stored.protectPhpMyAdmin === false) settings.protectPhpMyAdmin = false;
  if (stored.confineFileManager === false) settings.confineFileManager = false;
  if (stored.replacePanelCert === false) settings.replacePanelCert = false;
  const jails = (stored.loginJails ?? {}) as Record<string, unknown>;
  if (jails.panel === false) settings.loginJails.panel = false;
  if (jails.ssh === true) settings.loginJails.ssh = true;
  const before = stored.fail2banBefore as Record<string, unknown> | null | undefined;
  if (typeof before?.enabled === "boolean" && typeof before.active === "boolean") {
    settings.fail2banBefore = { enabled: before.enabled, active: before.active };
  }
  if (stored.databaseLoopback === true) settings.databaseLoopback = true;
  if (stored.blockClpctlInjection === false) settings.blockClpctlInjection = false;
  if (validBackupCompression(stored.backupCompression)) settings.backupCompression = { ...stored.backupCompression };
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

async function stateOf(options: SystemTweaksOptions): Promise<SystemTweaksState> {
  const settings = readSettings(pathsFor(options));
  return {
    updates: updatesStatus(options.updates),
    settings: settings.updates,
    uploadProgress: {
      guard: settings.uploadProgressGuard,
      fpms: uploadProgressStatus(options.uploadProgress),
    },
    realIp: { ...realIpStatus(options.realIp), blockForged: settings.blockForgedRealIp },
    phpMyAdmin: { ...phpMyAdminStatus(options.phpMyAdmin), enabled: settings.protectPhpMyAdmin },
    panelCert: { ...panelCertStatus(options.panelCert), replace: settings.replacePanelCert },
    vhostGuard: {
      enabled: settings.blockVhostInjection,
      active: (await vhostGuardStatus(options.vhostGuard)).active && varnishBackendsActive(options.varnishBackend),
      stored: storedOrError(options.vhostValues),
      homeLogs: settings.blockVhostInjection ? sitesWithHomeLogs(options.varnishBackend) : [],
      ownLogrotate: settings.blockVhostInjection ? sitesWithOwnLogrotate(options.varnishBackend) : [],
    },
    phpPools: { enabled: settings.isolatePhpPools, ...poolIsolationStatus(options.phpPools) },
    fileManagerGuard: {
      enabled: settings.confineFileManager,
      active: (await fileManagerGuardStatus(options.fileManagerGuard)).active,
    },
    clpctlGuard: clpctlGuardOrError(settings.blockClpctlInjection, options.clpctlGuard),
    panelPhp: panelPhpOrError(options.panelPhp),
    firewall: firewallOrError(options.firewall),
    loginJails: loginJailsOrError(settings.loginJails, options.loginJails),
    database: databaseOrError(settings.databaseLoopback, options.database),
    backupCompression: backupCompressionStatus(settings.backupCompression, options.backupCompression),
  };
}

function loginJailsOrError(settings: LoginJailSettings, options?: LoginJailOptions): SystemTweaksState["loginJails"] {
  try { return { ...loginJailsStatus(options), ...settings }; }
  catch (error) { return { error: errorMessage(error) }; }
}

function databaseOrError(loopback: boolean, options?: DatabaseOptions): SystemTweaksState["database"] {
  try { return { ...databaseStatus(options), loopback }; }
  catch (error) { return { error: errorMessage(error) }; }
}

function firewallOrError(options?: FirewallOptions): FirewallStatus | { error: string } {
  try { return firewallStatus(options); }
  catch (error) { return { error: errorMessage(error) }; }
}

function storedOrError(options?: VhostValuesOptions): StoredVhostValue[] | { error: string } {
  try { return storedVhostValues(options); }
  catch (error) { return { error: errorMessage(error) }; }
}

function panelPhpOrError(options?: PanelPhpOptions): PanelPhpStatus | { error: string } {
  try { return panelPhpStatus(options); }
  catch (error) { return { error: errorMessage(error) }; }
}

function requestBody(options: SystemTweaksOptions): Promise<Record<string, unknown>> {
  return readJsonRequest(options.input, MAX_INPUT_BYTES);
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

async function setPhpMyAdmin(options: SystemTweaksOptions): Promise<SystemTweaksState> {
  const paths = pathsFor(options);
  const body = await requestBody(options);
  if (typeof body.enabled !== "boolean") failAction("enabled must be true or false");
  await withFileLock(paths.lockFile, 15, "another system tweaks change is still running", async () => {
    const settings = readSettings(paths);
    applyPhpMyAdmin(body.enabled as boolean, options.phpMyAdmin);
    writeSettings(paths, { ...settings, protectPhpMyAdmin: body.enabled as boolean });
  });
  return stateOf(options);
}

/** Off only stops the replacing: a certificate generated here stays, since the shared key is public. */
async function setPanelCert(options: SystemTweaksOptions): Promise<SystemTweaksState> {
  const paths = pathsFor(options);
  const body = await requestBody(options);
  if (typeof body.enabled !== "boolean") failAction("enabled must be true or false");
  await withFileLock(paths.lockFile, 15, "another system tweaks change is still running", async () => {
    const settings = readSettings(paths);
    if (body.enabled) replacePanelCert(options.panelCert);
    writeSettings(paths, { ...settings, replacePanelCert: body.enabled as boolean });
  });
  return stateOf(options);
}

async function setVhostGuard(options: SystemTweaksOptions): Promise<SystemTweaksState> {
  const paths = pathsFor(options);
  const body = await requestBody(options);
  if (typeof body.enabled !== "boolean") failAction("enabled must be true or false");
  await withFileLock(paths.lockFile, 15, "another system tweaks change is still running", async () => {
    const settings = readSettings(paths);
    if (body.enabled) {
      await installVhostGuard(options.vhostGuard);
      // On once the guard is, so repair finishes the includes if they fail here.
      writeSettings(paths, { ...settings, blockVhostInjection: true });
      installVarnishBackends(options.varnishBackend);
    } else {
      removeVhostGuard(options.vhostGuard);
      try {
        removeVarnishBackends(options.varnishBackend);
      } catch (error) {
        // Still on, so the guard comes back now rather than at the next repair.
        await installVhostGuard(options.vhostGuard).catch(() => queueVhostGuard(options.vhostGuard));
        throw error;
      }
      writeSettings(paths, { ...settings, blockVhostInjection: false });
    }
  });
  return stateOf(options);
}

async function setPhpPools(options: SystemTweaksOptions): Promise<SystemTweaksState> {
  const paths = pathsFor(options);
  const body = await requestBody(options);
  if (typeof body.enabled !== "boolean") failAction("enabled must be true or false");
  await withFileLock(paths.lockFile, 15, "another system tweaks change is still running", async () => {
    const settings = readSettings(paths);
    // Saved first, so a PHP-FPM reload meanwhile follows the new setting.
    writeSettings(paths, { ...settings, isolatePhpPools: body.enabled as boolean });
    try {
      if (body.enabled) installPoolIsolation(options.phpPools);
      else removePoolIsolation(options.phpPools);
    } catch (error) {
      writeSettings(paths, settings);
      throw error;
    }
  });
  return stateOf(options);
}

async function setFileManagerGuard(options: SystemTweaksOptions): Promise<SystemTweaksState> {
  const paths = pathsFor(options);
  const body = await requestBody(options);
  if (typeof body.enabled !== "boolean") failAction("enabled must be true or false");
  await withFileLock(paths.lockFile, 15, "another system tweaks change is still running", async () => {
    const settings = readSettings(paths);
    if (body.enabled) {
      await installFileManagerGuard(options.fileManagerGuard);
      writeSettings(paths, { ...settings, confineFileManager: true });
    } else {
      // Record the opt-out first, so repair never puts back a guard the
      // administrator took away; a removal that fails leaves it in place, so
      // the setting goes back to on to match.
      writeSettings(paths, { ...settings, confineFileManager: false });
      try {
        removeFileManagerGuard(options.fileManagerGuard);
      } catch (error) {
        writeSettings(paths, settings);
        throw error;
      }
    }
  });
  return stateOf(options);
}

async function setClpctlGuard(options: SystemTweaksOptions): Promise<SystemTweaksState> {
  const paths = pathsFor(options);
  const body = await requestBody(options);
  if (typeof body.enabled !== "boolean") failAction("enabled must be true or false");
  await withFileLock(paths.lockFile, 15, "another system tweaks change is still running", async () => {
    const settings = readSettings(paths);
    if (body.enabled) {
      // On whether or not the wrapper can be swapped now: a CloudPanel version
      // this release does not know leaves it paused, and repair applies it once
      // a newer clp-addons knows the version. The page shows which.
      writeSettings(paths, { ...settings, blockClpctlInjection: true });
      applyClpctlGuard(options.clpctlGuard);
    } else {
      // Record the opt-out first, then restore. A restore that fails leaves the
      // hardened wrapper in place, so the setting is rolled back to on to match.
      writeSettings(paths, { ...settings, blockClpctlInjection: false });
      try {
        restoreClpctlWrapper(options.clpctlGuard);
      } catch (error) {
        writeSettings(paths, settings);
        throw error;
      }
    }
  });
  return stateOf(options);
}

/** Applies the jails and records what fail2ban was before them; the caller holds the settings lock. */
function settleLoginJails(paths: SystemTweaksPaths, settings: SystemTweaksSettings, options: SystemTweaksOptions): boolean {
  const applied = applyLoginJails(settings.loginJails, settings.fail2banBefore, options.loginJails);
  const next = { ...settings, loginJails: { ...settings.loginJails, ssh: applied.ssh }, fail2banBefore: applied.before };
  if (JSON.stringify(next) !== JSON.stringify(readSettings(paths))) writeSettings(paths, next);
  return applied.changed;
}

async function setLoginJails(options: SystemTweaksOptions): Promise<SystemTweaksState> {
  const paths = pathsFor(options);
  const body = await requestBody(options);
  const named = (["panel", "ssh"] as const).filter((key) => body[key] !== undefined);
  if (!named.length) failAction("no jail was named");
  for (const key of named) if (typeof body[key] !== "boolean") failAction(`${key} must be true or false`);
  await withFileLock(paths.lockFile, 15, "another system tweaks change is still running", async () => {
    const settings = readSettings(paths);
    const wanted = { ...settings, loginJails: { ...settings.loginJails } };
    for (const key of named) wanted.loginJails[key] = body[key] as boolean;
    settleLoginJails(paths, wanted, options);
  });
  return stateOf(options);
}

async function setDatabase(options: SystemTweaksOptions): Promise<SystemTweaksState> {
  const paths = pathsFor(options);
  const body = await requestBody(options);
  if (typeof body.enabled !== "boolean") failAction("enabled must be true or false");
  await withFileLock(paths.lockFile, 15, "another system tweaks change is still running", async () => {
    // First, so a settings file it cannot trust stops the change before MySQL restarts.
    const settings = readSettings(paths);
    await setDatabaseLoopback(body.enabled as boolean, options.database);
    writeSettings(paths, { ...settings, databaseLoopback: body.enabled as boolean });
  });
  return stateOf(options);
}

async function setBackupCompression(options: SystemTweaksOptions): Promise<SystemTweaksState> {
  const body = await requestBody(options);
  if (!validBackupCompression(body)) failAction(BACKUP_COMPRESSION_ERROR);
  const paths = pathsFor(options);
  await withFileLock(paths.lockFile, 15, "another system tweaks change is still running", async () => {
    const settings = readSettings(paths);
    writeSettings(paths, { ...settings, backupCompression: { ...body } });
    try { reconcileBackupCompression(body, options.backupCompression); }
    catch (error) { writeSettings(paths, settings); throw error; }
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
  const verbs = Object.keys(SYSTEM_TWEAKS_VERBS) as SystemTweaksVerb[];
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
  if (verb === "set-vhost-guard") return setVhostGuard(options);
  if (verb === "set-phpmyadmin") return setPhpMyAdmin(options);
  if (verb === "set-file-manager-guard") return setFileManagerGuard(options);
  if (verb === "set-panel-cert") return setPanelCert(options);
  if (verb === "set-clpctl-guard") return setClpctlGuard(options);
  if (verb === "set-backup-compression") return setBackupCompression(options);
  if (verb === "set-panel-php") return changePanelPhp(options);
  if (verb === "set-php-pools") return setPhpPools(options);
  if (verb === "set-login-jails") return setLoginJails(options);
  if (verb === "unban") {
    unban(await requestBody(options), options.loginJails);
    return stateOf(options);
  }
  if (verb === "set-database-loopback") return setDatabase(options);
  if (verb === "firewall") return firewallStatus(options.firewall);
  if (verb === "set-firewall-protocol") {
    setRuleProtocol(await requestBody(options), options.firewall);
    return firewallStatus(options.firewall);
  }
  if (verb !== "install-updates" && verb !== "install-fail2ban") {
    verb satisfies never;
    failAction(`unknown system tweaks verb '${verb}'`);
  }
  // One deadline for the install and the state read that answers it, which the
  // gateway's timeout is sized from.
  const now = options.now ?? Date.now;
  const deadline = now() + INSTALL_DEADLINE_MS;
  if (verb === "install-fail2ban") {
    const run = withDeadline(options.loginJails?.run ?? systemRun, deadline, now, "fail2ban");
    const bounded = { ...options, loginJails: { ...options.loginJails, run } };
    await withFileLock(pathsFor(options).lockFile, 15, "another system tweaks change is still running", async () => {
      const paths = pathsFor(options);
      const settings = readSettings(paths);
      // Not there before, so not running before: switching the jails off stops and disables it.
      const before = settings.fail2banBefore ?? (missingFail2ban(bounded) ? { enabled: false, active: false } : null);
      installLoginJailPackages(bounded.loginJails);
      settleLoginJails(paths, { ...settings, fail2banBefore: before }, bounded);
    });
    return stateOf(bounded);
  }
  const run = withDeadline(options.updates?.run ?? systemRun, deadline, now);
  const bounded = { ...options, updates: { ...options.updates, run }, uploadProgress: { ...options.uploadProgress, run } };
  await withFileLock(pathsFor(options).lockFile, 15, "another system tweaks change is still running", async () =>
    installUnattendedUpgrades(bounded.updates));
  return stateOf(bounded);
}

function missingFail2ban(options: SystemTweaksOptions): boolean {
  const run = options.loginJails?.run ?? systemRun;
  return !run("dpkg-query", ["-W", "-f=${Status}", "fail2ban"]).stdout.includes("install ok installed");
}

export async function runSystemTweaksAction(argv: string[], options: SystemTweaksOptions = {}): Promise<number> {
  return replyToAction("system-tweaks", options.emitReply !== false, () => executeSystemTweaksAction(argv, options));
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
    failures.push(`/tmp cleanup: ${errorMessage(error)}`);
  }
  try {
    const upkeep = systemTweaksUpkeep(options);
    if (upkeep) lines.push(upkeep);
  } catch (error) {
    failures.push(errorMessage(error));
  }
  try {
    const phpMyAdmin = systemTweaksPhpMyAdmin(options);
    if (phpMyAdmin) lines.push(phpMyAdmin);
  } catch (error) {
    failures.push(`phpMyAdmin rules: ${errorMessage(error)}`);
  }
  try {
    const firewall = syncFirewall("apply", options.firewall);
    if (firewall) lines.push(`firewall: ${firewall}`);
  } catch (error) {
    failures.push(`firewall: ${errorMessage(error)}`);
  }
  try {
    // Read under the lock, so a switch-off running beside it is not undone.
    const paths = pathsFor(options);
    // A short wait for Panel PHP's lock, so this does not hold the page's switches behind one.
    const putBack = await withFileLock(paths.lockFile, 15, "another system tweaks change is still running", async () =>
      readSettings(paths).blockVhostInjection && await installVhostGuard({ lockWaitSeconds: 5, ...options.vhostGuard }));
    if (putBack) lines.push("vhost guard put back");
  } catch (error) {
    failures.push(`vhost guard: ${errorMessage(error)}`);
  }
  try {
    const pools = withSettingsLock(options, (_paths, settings) => settings.isolatePhpPools && installPoolIsolation(options.phpPools));
    if (pools) lines.push("PHP pool ports limited to nginx and each pool's own user");
  } catch (error) {
    failures.push(`PHP pools: ${errorMessage(error)}`);
  }
  try {
    const paths = pathsFor(options);
    const putBack = await withFileLock(paths.lockFile, 15, "another system tweaks change is still running", async () =>
      readSettings(paths).confineFileManager && await installFileManagerGuard({ lockWaitSeconds: 5, ...options.fileManagerGuard }));
    if (putBack) lines.push("File Manager guard put back");
  } catch (error) {
    failures.push(`File Manager guard: ${errorMessage(error)}`);
  }
  try {
    const cert = systemTweaksPanelCert(options);
    if (cert) lines.push(cert);
  } catch (error) {
    failures.push(`panel certificate: ${errorMessage(error)}`);
  }
  try {
    const varnish = systemTweaksVarnish(options);
    if (varnish) lines.push(varnish);
  } catch (error) {
    failures.push(`Varnish backends: ${errorMessage(error)}`);
  }
  try {
    const clpctl = systemTweaksClpctlGuard(options);
    if (clpctl) lines.push(clpctl);
  } catch (error) {
    failures.push(`clpctl wrapper guard: ${errorMessage(error)}`);
  }
  try {
    const stored = storedVhostValues(options.vhostValues);
    if (stored.length) lines.push(`stored site settings the vhost guard would refuse: ${stored.map((value) => `${value.domain} ${value.field}`).join(", ")}`);
  } catch (error) {
    failures.push(`stored site settings: ${errorMessage(error)}`);
  }
  try {
    const php = await reconcilePanelPhp(options.panelPhp);
    if (php) lines.push(php);
  } catch (error) {
    failures.push(`panel PHP: ${errorMessage(error)}`);
  }
  try {
    const changed = withSettingsLock(options, (_paths, settings) => reconcileBackupCompression(settings.backupCompression, options.backupCompression));
    if (changed) lines.push("remote backup compression reconciled");
  } catch (error) {
    failures.push(`remote backup compression: ${errorMessage(error)}`);
  }
  if (failures.length) throw new Error([...failures, ...lines].join("; "));
  return lines.join("; ") || null;
}

/** Repair's, and the fast repair's when CloudPanel rewrites its vhost. */
export function systemTweaksPhpMyAdmin(options: SystemTweaksOptions = {}): string | null {
  return withSettingsLock(options, (_paths, settings) =>
    settings.protectPhpMyAdmin && applyPhpMyAdmin(true, options.phpMyAdmin) ? "phpMyAdmin rules put back" : null);
}

/**
 * Repair's: re-apply the hardened clpctlWrapper after a CloudPanel update
 * reinstalls the original. A version this release does not know leaves the
 * wrapper in place, reported, not as a failure.
 */
export function systemTweaksClpctlGuard(options: SystemTweaksOptions = {}): string | null {
  return withSettingsLock(options, (_paths, settings) => {
    if (!settings.blockClpctlInjection) return null;
    const result = applyClpctlGuard(options.clpctlGuard);
    if (result.changed) return "clpctl wrapper guard put back";
    if (!result.active && result.reason) return `clpctl wrapper guard paused: ${result.reason}`;
    return null;
  });
}

/** Repair's and the new-site watcher's: every site's Varnish backend comes from its checked include. */
export function systemTweaksVarnish(options: SystemTweaksOptions = {}): string | null {
  return withSettingsLock(options, (_paths, settings) =>
    settings.blockVhostInjection && installVarnishBackends(options.varnishBackend) ? "Varnish backends and site nginx logs moved to root-owned paths" : null);
}

/** Repair's: CloudPanel's shared panel certificate is replaced again after an update puts it back. */
export function systemTweaksPanelCert(options: SystemTweaksOptions = {}): string | null {
  return withSettingsLock(options, (_paths, settings) => settings.replacePanelCert ? replacePanelCert(options.panelCert) : null);
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
    if (settleLoginJails(paths, settings, options)) notices.push("login jails restored");
    const database = reconcileDatabaseFile(settings.databaseLoopback, options.database);
    if (database) notices.push(database);
    return notices.join("; ") || null;
  });
}

export function withdrawSystemTweaks(options: SystemTweaksOptions = {}): void {
  // First, because it refuses when CloudPanel's own PHP would not come back.
  withdrawPanelPhp(options.panelPhp);
  try {
    withSettingsLock(options, (paths, settings) => {
      // First: it throws when our wrapper is in place but its saved original is
      // gone, and then nothing else is withdrawn, so the other protections stay.
      restoreClpctlWrapper(options.clpctlGuard);
      try {
        // Next: it refuses an edited backup command, and then the protections below stay.
        reconcileBackupCompression({ ...settings.backupCompression, enabled: false }, options.backupCompression);
        applyUpdates({ ...settings.updates, enabled: false }, settings.enabledTimers, options.updates);
        if (settings.enabledTimers.length) writeSettings(paths, { ...settings, enabledTimers: [] });
        applyRealIp(false, options.realIp);
        applyPhpMyAdmin(false, options.phpMyAdmin);
        releaseLoginJails(settings.fail2banBefore, options.loginJails);
        if (settings.fail2banBefore) writeSettings(paths, { ...readSettings(paths), fail2banBefore: null });
        reconcileDatabaseFile(false, options.database);
        try {
          removeFileManagerGuard(options.fileManagerGuard);
          removeVhostGuard(options.vhostGuard);
          try {
            removeVarnishBackends(options.varnishBackend);
          } catch (error) {
            queueVhostGuard(options.vhostGuard);
            throw error;
          }
        } catch (error) {
          // The addon stays enabled, so the File Manager guard comes back now
          // rather than at the next repair, unless it was switched off.
          if (settings.confineFileManager) queueFileManagerGuard(options.fileManagerGuard);
          throw error;
        }
        removePoolIsolation(options.phpPools);
      } catch (error) {
        // A later step failed, so deactivation does not complete and the addon
        // stays enabled. The wrapper is already back to CloudPanel's vulnerable
        // one, so put ours back, since the setting still asks for it, rather than
        // leave the box exposed until the next repair. Best effort: a failure
        // here must not hide the real one, and repair retries.
        if (settings.blockClpctlInjection) {
          try { applyClpctlGuard(options.clpctlGuard); } catch { /* repair re-applies */ }
        }
        throw error;
      }
    });
  } catch (error) {
    // The addon stays enabled, so its panel PHP choice comes back with it.
    restorePanelPhp(options.panelPhp);
    throw error;
  }
  // A firewall that cannot be put back does not keep the addon on: CloudPanel's
  // next change on its Firewall page rebuilds ufw without these rules anyway.
  try { syncFirewall("withdraw", options.firewall); }
  catch (error) { log.warn(`ufw still has UDP rules from System Tweaks: ${errorMessage(error)}`); }
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
      if (settings.protectPhpMyAdmin) applyPhpMyAdmin(true, options.phpMyAdmin);
      settleLoginJails(paths, readSettings(paths), options);
      // It inspects MySQL's units, which can be mid-restart; the guards below must still come back.
      if (settings.databaseLoopback) {
        try { reconcileDatabaseFile(true, options.database); }
        catch (error) { log.warn(`MySQL on this server only waits for the next repair: ${errorMessage(error)}`); }
      }
      if (settings.blockVhostInjection) queueVhostGuard(options.vhostGuard);
      if (settings.isolatePhpPools) installPoolIsolation(options.phpPools);
      if (settings.confineFileManager) queueFileManagerGuard(options.fileManagerGuard);
      if (settings.blockClpctlInjection) applyClpctlGuard(options.clpctlGuard);
      // It refuses once CloudPanel moves past the supported version; activation must still finish.
      try { reconcileBackupCompression(settings.backupCompression, options.backupCompression); }
      catch (error) { log.warn(`remote backup compression waits for the next repair: ${errorMessage(error)}`); }
    });
  } finally {
    restorePanelPhp(options.panelPhp);
  }
  try { systemTweaksPanelCert(options); }
  catch (error) { log.warn(`the panel's shared certificate waits for the next repair: ${errorMessage(error)}`); }
  try { syncFirewall("restore", options.firewall); }
  catch (error) { log.warn(`firewall protocols wait for the next repair: ${errorMessage(error)}`); }
}

/** What the firewall watcher runs whenever ufw's rule files change. */
export function systemTweaksFirewall(options: SystemTweaksOptions = {}): string | null {
  return syncFirewall("apply", options.firewall);
}

/**
 * What every PHP-FPM unit runs before it starts, and before and after it
 * reloads. It reads the setting without the lock: a change on the page can be
 * what reloaded PHP-FPM.
 */
export function systemTweaksPhpPools(options: SystemTweaksOptions = {}, beforeReload = false): boolean {
  const paths = pathsFor(options);
  if (!readSettings(paths).isolatePhpPools) return false;
  const changed = syncPoolIsolation(options.phpPools, beforeReload);
  // Switched off meanwhile: the switch-off may have removed the table before this loaded it.
  if (!readSettings(paths).isolatePhpPools) removePoolIsolation(options.phpPools);
  return changed;
}

/** Moves System Tweaks' firewall protocols to Firewall, after `cloudflare-ips` was renamed `firewall`. */
import { errorMessage } from "../../lib/errors";
import { addonConfigFile, addonStateDir } from "../../lib/paths";
import { existsSync, lstatSync, readFileSync, rmSync, rmdirSync } from "node:fs";
import { writeFileAtomic } from "../../lib/atomic-write";
import { withFileLockSync } from "../../lib/file-lock";
import { isTrustedFile } from "../../lib/trusted-file";
import { log } from "../../lib/log";
import { ROOT_LOCKS_FILE, ROOT_LOCKS_LOCK, UntrustedLockFile, lockedAddons, writeLockedAddons } from "../../lib/root-locks";
import { DEFAULT_CLOUDFLARE_ACTION_PATHS } from "./action";
import { DEFAULT_FIREWALL_PATHS } from "./protocols";
import { DEFAULT_VISITOR_IP_PATHS, MAPS_MARKER } from "./visitor-ip";

export const LEGACY_PROTOCOLS_FILE = `${addonStateDir("system-tweaks")}/firewall.json`;
export const LEGACY_SYSTEM_TWEAKS_SETTINGS = `${addonStateDir("system-tweaks")}/settings.json`;

interface SavedFile { path: string; text: string; mode: number; uid: number; gid: number }
function snapshot(path: string): SavedFile | null {
  if (!existsSync(path)) return null;
  const info = lstatSync(path);
  if (!isTrustedFile(info, process.getuid?.() ?? 0)) throw new Error(`refusing untrusted migration file ${path}`);
  return { path, text: readFileSync(path, "utf8"), mode: info.mode & 0o777, uid: info.uid, gid: info.gid };
}
function restore(file: SavedFile): void {
  writeFileAtomic(file.path, file.text, { mode: file.mode, owner: { uid: file.uid, gid: file.gid }, createParent: true });
}

/**
 * Returns an undo kept in memory only, or null when there was nothing to move.
 * Firewall is enabled where System Tweaks was applying a protocol, so those
 * rules keep their UDP. Enabling it then must not start Cloudflare-only on new
 * sites from a policy left behind while Cloudflare IP Access was disabled.
 * Choices System Tweaks had withdrawn arrive with the Protocol switch off, so
 * enabling Firewall does not bring them back.
 */
export function migrateFirewallProtocols(enable: () => void): (() => void) | null {
  let source: SavedFile | null;
  try {
    source = snapshot(LEGACY_PROTOCOLS_FILE);
  } catch (error) {
    log.warn(`System Tweaks' firewall protocols were not moved to Firewall: ${errorMessage(error)}`);
    return null;
  }
  if (!source) return null;
  let stored: Record<string, unknown> | null = null;
  try { stored = JSON.parse(source.text) as Record<string, unknown>; } catch { stored = null; }
  if (stored === null || typeof stored !== "object" || Array.isArray(stored)) stored = null;
  const held = (value: unknown) => value !== null && typeof value === "object" && Object.keys(value).length > 0;
  const chosen = stored?.version === 2 && (held(stored.protocols) || held(stored.managed));
  const applied = chosen && existsSync(addonConfigFile("system-tweaks")) && stored?.withdrawn !== true;

  const target = DEFAULT_FIREWALL_PATHS.stateFile;
  const targetDir = addonStateDir("firewall");
  const directoryExisted = existsSync(targetDir);
  const configPath = addonConfigFile("firewall");
  const policyPath = DEFAULT_CLOUDFLARE_ACTION_PATHS.policyFile;
  const originals = new Map<string, SavedFile | null>();
  const keep = (path: string) => { if (!originals.has(path)) originals.set(path, snapshot(path)); };
  const undo = () => {
    for (const [path, before] of [...originals].reverse()) {
      if (before) restore(before); else rmSync(path, { force: true });
    }
    if (!directoryExisted && existsSync(targetDir)) rmdirSync(targetDir);
  };
  try {
    const existing = snapshot(target);
    if (existing) {
      if (existing.text !== source.text) {
        log.warn(`System Tweaks' firewall protocols were dropped, not moved: Firewall keeps its own in ${target}`);
      }
    } else if (stored === null) {
      log.warn(`System Tweaks' firewall protocols file did not parse and was removed; System Tweaks was ignoring it`);
    } else if (chosen) {
      keep(target);
      const text = applied ? source.text : `${JSON.stringify({ ...stored, withdrawn: true, off: true }, null, 2)}\n`;
      restore({ ...source, path: target, text });
    }
    keep(source.path);
    rmSync(source.path);
    if (!existing && applied && !existsSync(configPath)) {
      const policy = snapshot(policyPath);
      // A policy that does not parse is the Firewall page's to report; the move goes ahead.
      let parsed: Record<string, unknown> | null = null;
      try { parsed = policy ? JSON.parse(policy.text) as Record<string, unknown> : null; } catch { parsed = null; }
      if (parsed?.autoEnableNewSites === true) {
        keep(policyPath);
        restore({ ...policy!, text: `${JSON.stringify({ ...parsed, autoEnableNewSites: false }, null, 2)}\n` });
        log.warn("Firewall's Enable on new sites was switched off: it was saved while Cloudflare IP Access was disabled");
      }
      keep(configPath);
      enable();
    }
    return undo;
  } catch (error) {
    undo();
    log.warn(`System Tweaks' firewall protocols were not moved to Firewall: ${errorMessage(error)}`);
    return null;
  }
}

export interface VisitorIpMigrationPaths {
  systemTweaksSettings: string;
  systemTweaksConfig: string;
  firewallConfig: string;
  firewallPolicy: string;
  firewallStateDir: string;
  visitorIpState: string;
  /** The Nginx map visitor IPs are applied with. */
  visitorIpMaps: string;
  /** Root's addon locks file, so a System Tweaks lock carries to Firewall. */
  locksFile: string;
  locksLock: string;
  rootUid: number;
}

const DEFAULT_VISITOR_IP_MIGRATION_PATHS: VisitorIpMigrationPaths = {
  systemTweaksSettings: LEGACY_SYSTEM_TWEAKS_SETTINGS,
  systemTweaksConfig: addonConfigFile("system-tweaks"),
  firewallConfig: addonConfigFile("firewall"),
  firewallPolicy: DEFAULT_CLOUDFLARE_ACTION_PATHS.policyFile,
  firewallStateDir: addonStateDir("firewall"),
  visitorIpState: DEFAULT_VISITOR_IP_PATHS.stateFile,
  visitorIpMaps: DEFAULT_VISITOR_IP_PATHS.maps,
  locksFile: ROOT_LOCKS_FILE,
  locksLock: ROOT_LOCKS_LOCK,
  rootUid: process.getuid?.() ?? 0,
};

/** System Tweaks' settings, when they parse as an object. */
function legacySettings(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/**
 * System Tweaks applied visitor IPs by default and saved the setting only once
 * an operator changed one. Its map still on disk, while Firewall is disabled
 * and has no choice of its own, is that default left behind.
 */
function appliedByDefault(p: VisitorIpMigrationPaths): boolean {
  if (!existsSync(p.systemTweaksConfig) || existsSync(p.firewallConfig) || existsSync(p.visitorIpState)) return false;
  try {
    if (!lstatSync(p.visitorIpMaps).isFile()) return false;
    return readFileSync(p.visitorIpMaps, "utf8").startsWith(`${MAPS_MARKER}\n`);
  } catch {
    return false;
  }
}

/** Whether `migrateVisitorIp` has anything to move. */
export function visitorIpMigrationPending(paths: Partial<VisitorIpMigrationPaths> = {}): boolean {
  const p = { ...DEFAULT_VISITOR_IP_MIGRATION_PATHS, ...paths };
  try {
    const stored = legacySettings(readFileSync(p.systemTweaksSettings, "utf8"));
    if (stored && Object.hasOwn(stored, "cloudflareVisitorIp")) return true;
  } catch { /* no saved settings */ }
  return appliedByDefault(p);
}

/**
 * Moves System Tweaks' `cloudflareVisitorIp` setting to Firewall, or its
 * unsaved default where System Tweaks applied it. When System Tweaks was
 * enabled with visitor IPs on and Firewall was disabled, enables Firewall with
 * `autoEnableNewSites: false` so sites behind Cloudflare keep seeing real
 * visitor IPs without turning on Cloudflare-only site rules. Returns an
 * in-memory rollback closure, or null when there was nothing to move.
 */
export function migrateVisitorIp(
  enable: () => void,
  paths: Partial<VisitorIpMigrationPaths> = {},
): (() => void) | null {
  const p = { ...DEFAULT_VISITOR_IP_MIGRATION_PATHS, ...paths };
  let source: SavedFile | null;
  try {
    source = snapshot(p.systemTweaksSettings);
  } catch (error) {
    log.warn(`System Tweaks' Cloudflare visitor IPs setting was not moved to Firewall: ${errorMessage(error)}`);
    return null;
  }
  const stored = source ? legacySettings(source.text) : null;
  const saved = stored !== null && Object.hasOwn(stored, "cloudflareVisitorIp");
  if (!saved && !appliedByDefault(p)) return null;
  const enabled = !saved || stored.cloudflareVisitorIp !== false;
  const systemTweaksOn = existsSync(p.systemTweaksConfig);
  const directoryExisted = existsSync(p.firewallStateDir);
  const originals = new Map<string, SavedFile | null>();
  let carriedLock = false;
  const keep = (path: string) => { if (!originals.has(path)) originals.set(path, snapshot(path)); };
  const undo = () => {
    if (carriedLock) {
      try {
        withFileLockSync(p.locksLock, 15, "another lock or unlock is still running", () => {
          const current = lockedAddons(p.locksFile, p.rootUid);
          if (current.includes("firewall")) {
            writeLockedAddons(current.filter((name) => name !== "firewall"), p.locksFile, p.rootUid);
          }
        });
      } catch (lockError) {
        log.warn(`Firewall lock could not be put back: ${errorMessage(lockError)}`);
      }
      carriedLock = false;
    }
    for (const [path, before] of [...originals].reverse()) {
      if (before) restore(before); else rmSync(path, { force: true });
    }
    if (!directoryExisted && existsSync(p.firewallStateDir)) {
      try { rmdirSync(p.firewallStateDir); } catch { /* non-empty */ }
    }
  };
  try {
    const existing = snapshot(p.visitorIpState);
    if (!existing) {
      keep(p.visitorIpState);
      writeFileAtomic(p.visitorIpState, `${JSON.stringify({ version: 1, enabled }, null, 2)}\n`, { mode: 0o600, createParent: true });
    }
    if (saved && source) {
      const { cloudflareVisitorIp: _dropped, ...rest } = stored;
      keep(source.path);
      restore({ ...source, text: `${JSON.stringify(rest, null, 2)}\n` });
    }

    if (!existing && enabled && systemTweaksOn && !existsSync(p.firewallConfig)) {
      const policy = snapshot(p.firewallPolicy);
      let parsed: Record<string, unknown> | null = null;
      try { parsed = policy ? JSON.parse(policy.text) as Record<string, unknown> : null; } catch { parsed = null; }
      if (parsed?.autoEnableNewSites === true) {
        keep(p.firewallPolicy);
        restore({ ...policy!, text: `${JSON.stringify({ ...parsed, autoEnableNewSites: false }, null, 2)}\n` });
        log.warn("Firewall's Enable on new sites was switched off: it was saved while Firewall was disabled");
      }
      keep(p.firewallConfig);
      enable();
    }
    // Root's System Tweaks lock used to protect set-visitor-ip. Firewall's only
    // lockable verb is set-visitor-ip, so carrying the lock to Firewall keeps
    // visitor IPs protected without freezing any other Firewall switch.
    if (existsSync(p.locksFile)) {
      try {
        withFileLockSync(p.locksLock, 15, "another lock or unlock is still running", () => {
          const current = lockedAddons(p.locksFile, p.rootUid);
          if (current.includes("system-tweaks") && !current.includes("firewall")) {
            writeLockedAddons([...current, "firewall"], p.locksFile, p.rootUid);
            carriedLock = true;
          }
        });
      } catch (lockError) {
        // A damaged lock file already fails closed for every lockable addon, including Firewall.
        if (!(lockError instanceof UntrustedLockFile)) throw lockError;
      }
    }
    return undo;
  } catch (error) {
    undo();
    log.warn(`System Tweaks' Cloudflare visitor IPs setting was not moved to Firewall: ${errorMessage(error)}`);
    return null;
  }
}

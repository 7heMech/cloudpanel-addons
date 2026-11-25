/** Moves System Tweaks' firewall protocols to Firewall, after `cloudflare-ips` was renamed `firewall`. */
import { errorMessage } from "../../lib/errors";
import { addonConfigFile, addonStateDir } from "../../lib/paths";
import { existsSync, lstatSync, readFileSync, rmSync, rmdirSync } from "node:fs";
import { writeFileAtomic } from "../../lib/atomic-write";
import { isTrustedFile } from "../../lib/trusted-file";
import { log } from "../../lib/log";
import { DEFAULT_CLOUDFLARE_ACTION_PATHS } from "./action";
import { DEFAULT_FIREWALL_PATHS } from "./protocols";
import { DEFAULT_VISITOR_IP_PATHS } from "./visitor-ip";

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
}

const DEFAULT_VISITOR_IP_MIGRATION_PATHS: VisitorIpMigrationPaths = {
  systemTweaksSettings: LEGACY_SYSTEM_TWEAKS_SETTINGS,
  systemTweaksConfig: addonConfigFile("system-tweaks"),
  firewallConfig: addonConfigFile("firewall"),
  firewallPolicy: DEFAULT_CLOUDFLARE_ACTION_PATHS.policyFile,
  firewallStateDir: addonStateDir("firewall"),
  visitorIpState: DEFAULT_VISITOR_IP_PATHS.stateFile,
};

/**
 * Moves System Tweaks' `cloudflareVisitorIp` setting to Firewall. When System
 * Tweaks was enabled with visitor IPs on and Firewall was disabled, enables
 * Firewall with `autoEnableNewSites: false` so sites behind Cloudflare keep
 * seeing real visitor IPs without turning on Cloudflare-only site rules.
 * Returns an in-memory rollback closure, or null when there was nothing to move.
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
  if (!source) return null;
  let stored: Record<string, unknown> | null = null;
  try { stored = JSON.parse(source.text) as Record<string, unknown>; } catch { stored = null; }
  if (!stored || typeof stored !== "object" || Array.isArray(stored) || !Object.hasOwn(stored, "cloudflareVisitorIp")) {
    return null;
  }
  const enabled = stored.cloudflareVisitorIp !== false;
  const systemTweaksOn = existsSync(p.systemTweaksConfig);
  const directoryExisted = existsSync(p.firewallStateDir);
  const originals = new Map<string, SavedFile | null>();
  const keep = (path: string) => { if (!originals.has(path)) originals.set(path, snapshot(path)); };
  const undo = () => {
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
      restore({ ...source, path: p.visitorIpState, text: `${JSON.stringify({ version: 1, enabled }, null, 2)}\n` });
    }
    const { cloudflareVisitorIp: _dropped, ...rest } = stored;
    keep(source.path);
    restore({ ...source, text: `${JSON.stringify(rest, null, 2)}\n` });

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
    return undo;
  } catch (error) {
    undo();
    log.warn(`System Tweaks' Cloudflare visitor IPs setting was not moved to Firewall: ${errorMessage(error)}`);
    return null;
  }
}

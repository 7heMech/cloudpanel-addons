/** Moves System Tweaks' firewall protocols to Firewall, after `cloudflare-ips` was renamed `firewall`. */
import { errorMessage } from "../../lib/errors";
import { addonConfigFile, addonStateDir, CLOUDFLARE_STATE_DIR } from "../../lib/paths";
import { existsSync, lstatSync, readFileSync, rmSync, rmdirSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import { writeFileAtomic } from "../../lib/atomic-write";
import {
  edgeDefaultsDigest, hasActiveEdgeDefaults, MAX_SKIP_IPS, SSL_LABELS, SSL_MODES, type EdgeDefaults, type SslMode,
} from "../../lib/cloudflare/edge";
import { readCloudflareConnections } from "../../lib/cloudflare/store";
import { withFileLockSync } from "../../lib/file-lock";
import { isTrustedFile } from "../../lib/trusted-file";
import { log } from "../../lib/log";
import { ROOT_LOCKS_FILE, ROOT_LOCKS_LOCK, UntrustedLockFile, lockedAddons, writeLockedAddons } from "../../lib/root-locks";
import { DEFAULT_CLOUDFLARE_ACTION_PATHS } from "./action";
import { DEFAULT_EDGE_PATHS } from "./edge";
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
  /** Whether Firewall was already enabled before earlier migrations in this pass created firewall.conf. */
  firewallWasEnabled?: boolean;
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
 * an operator changed one. Its map still on disk while Firewall has no choice
 * of its own is that default left behind, whether Firewall was already enabled
 * or not, so state and root's lock still carry over once.
 */
function appliedByDefault(p: VisitorIpMigrationPaths): boolean {
  if (!existsSync(p.systemTweaksConfig) || existsSync(p.visitorIpState)) return false;
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

    if (!existing && enabled && systemTweaksOn && !existsSync(p.firewallConfig) && p.firewallWasEnabled !== true) {
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

export interface CloudflareEdgeMigrationPaths {
  dnsPolicy: string;
  dnsConfig: string;
  cloudflareStateDir: string;
  firewallConfig: string;
  firewallPolicy: string;
  firewallStateDir: string;
  edgeConfig: string;
  visitorIpState: string;
  rootUid: number;
  /** Whether Firewall was already enabled before earlier migrations in this pass created firewall.conf. */
  firewallWasEnabled?: boolean;
  now?: () => number;
}

const DEFAULT_EDGE_MIGRATION_PATHS: CloudflareEdgeMigrationPaths = {
  dnsPolicy: join(addonStateDir("dns"), "policy.json"),
  dnsConfig: addonConfigFile("dns"),
  cloudflareStateDir: CLOUDFLARE_STATE_DIR,
  firewallConfig: addonConfigFile("firewall"),
  firewallPolicy: DEFAULT_CLOUDFLARE_ACTION_PATHS.policyFile,
  firewallStateDir: addonStateDir("firewall"),
  edgeConfig: join(DEFAULT_EDGE_PATHS.stateDir, "cloudflare-edge.json"),
  visitorIpState: DEFAULT_VISITOR_IP_PATHS.stateFile,
  rootUid: process.getuid?.() ?? 0,
};

function snapshotTrusted(path: string, expectedUid: number): SavedFile | null {
  if (!existsSync(path)) return null;
  const info = lstatSync(path);
  if (!isTrustedFile(info, expectedUid)) throw new Error(`refusing untrusted migration file ${path}`);
  return { path, text: readFileSync(path, "utf8"), mode: info.mode & 0o777, uid: info.uid, gid: info.gid };
}

function legacyProfilesWithZone(policy: Record<string, unknown> | null): Record<string, unknown>[] {
  if (!policy || !Array.isArray(policy.profiles)) return [];
  return policy.profiles.filter((entry): entry is Record<string, unknown> =>
    Boolean(entry) && typeof entry === "object" && !Array.isArray(entry) && Object.hasOwn(entry, "zone"));
}

/** Whether `migrateCloudflareEdgeFromDns` has legacy profile zone options to move. */
export function cloudflareEdgeMigrationPending(paths: Partial<CloudflareEdgeMigrationPaths> = {}): boolean {
  const p = { ...DEFAULT_EDGE_MIGRATION_PATHS, ...paths };
  try {
    const raw = legacySettings(readFileSync(p.dnsPolicy, "utf8"));
    return legacyProfilesWithZone(raw).length > 0;
  } catch {
    return false;
  }
}

/**
 * Moves Cloudflare whole-zone options (`ssl`, `alwaysHttps`, `acmeFullSsl`,
 * `webmailFullSsl`, `skipFirewallIps`) out of DNS's `policy.json` profiles
 * into Firewall's `/var/lib/clp-addons/firewall/cloudflare-edge.json`, keeping
 * live zones intact.
 *
 * - Prefers profiles assigned to sites/redirects (or the default profile),
 *   falling back to all profiles when none are assigned.
 * - If relevant profiles disagree on SSL/TLS mode or Always Use HTTPS, leaves
 *   the disagreeing setting unset (`null`), leaves approval off, and records a
 *   migration note so live zones are never silently changed.
 * - If DNS was Automatic with Cloudflare connected and unambiguous active edge
 *   options, migrates them as already approved so new zones continue without
 *   review holds; when DNS was enabled and Firewall was disabled, enables
 *   Firewall with `autoEnableNewSites: false` and visitor IPs off (unless
 *   already configured) so upgrading changes no Nginx files unexpectedly.
 */
export function migrateCloudflareEdgeFromDns(
  enable: () => void,
  paths: Partial<CloudflareEdgeMigrationPaths> = {},
): (() => void) | null {
  const p = { ...DEFAULT_EDGE_MIGRATION_PATHS, ...paths };
  let source: SavedFile | null;
  try {
    source = snapshotTrusted(p.dnsPolicy, p.rootUid);
  } catch (error) {
    throw new Error(`DNS's Cloudflare edge options were not moved to Firewall: ${errorMessage(error)}`);
  }
  if (!source) return null;
  const parsed = legacySettings(source.text);
  const profilesWithZone = legacyProfilesWithZone(parsed);
  if (!parsed || !profilesWithZone.length) return null;

  const allProfiles = (parsed.profiles as unknown[]).filter((entry): entry is Record<string, unknown> =>
    Boolean(entry) && typeof entry === "object" && !Array.isArray(entry));

  const activeIds = new Set<string>();
  if (parsed.assignments && typeof parsed.assignments === "object" && !Array.isArray(parsed.assignments)) {
    for (const entry of Object.values(parsed.assignments as Record<string, unknown>)) {
      if (typeof entry === "string" && entry) {
        activeIds.add(entry);
      } else if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        const { http, mail } = entry as { http?: unknown; mail?: unknown };
        if (typeof http === "string" && http) activeIds.add(http);
        if (typeof mail === "string" && mail) activeIds.add(mail);
      }
    }
  }
  if (Array.isArray(parsed.redirects)) {
    for (const entry of parsed.redirects) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const { profileId, mailProfileId } = entry as { profileId?: unknown; mailProfileId?: unknown };
      if (typeof profileId === "string" && profileId) activeIds.add(profileId);
      if (typeof mailProfileId === "string" && mailProfileId) activeIds.add(mailProfileId);
    }
  }
  for (const key of ["defaultProfileId", "defaultHttpProfileId", "defaultMailProfileId"] as const) {
    const value = parsed[key];
    if (typeof value === "string" && value) activeIds.add(value);
  }

  const relevant = activeIds.size > 0
    ? allProfiles.filter((profile) => typeof profile.id === "string" && activeIds.has(profile.id))
    : allProfiles;
  const chosen = relevant.length > 0 ? relevant : allProfiles;
  // On v2 policies, new profiles created after edge moved to Firewall omit `zone`;
  // do not let an unrelated zone-less v2 profile create a false disagreement beside
  // active profiles that still carry legacy `zone` blocks.
  const chosenWithZone = parsed.version === 2 ? chosen.filter((profile) => Object.hasOwn(profile, "zone")) : [];
  const effective = chosenWithZone.length > 0 ? chosenWithZone : chosen;

  // DNS's v1-to-v2 save stores a list where legacy profiles with different zone blocks folded into one profile.
  const asZone = (zone: unknown): Record<string, unknown> =>
    zone && typeof zone === "object" && !Array.isArray(zone) ? zone as Record<string, unknown> : {};
  const zoneObjects = effective.flatMap((profile) =>
    Array.isArray(profile.zone) && profile.zone.length ? profile.zone.map(asZone) : [asZone(profile.zone)]);

  const sslValues = [...new Set(zoneObjects.map((zone) => SSL_MODES.find((mode) => mode === zone.ssl) ?? null))];
  const httpsValues = [...new Set(zoneObjects.map((zone) => typeof zone.alwaysHttps === "boolean" ? zone.alwaysHttps : null))];

  const notes: string[] = [];
  let ssl: SslMode | null = null;
  if (sslValues.length === 1) ssl = sslValues[0]!;
  else if (sslValues.length > 1) {
    const labels = sslValues.map((mode) => mode ? SSL_LABELS[mode] : "Leave as it is");
    notes.push(`Legacy DNS profiles disagreed on SSL/TLS mode (${labels.join(" vs ")}), so SSL/TLS was left unchanged.`);
  }
  let alwaysHttps: boolean | null = null;
  if (httpsValues.length === 1) alwaysHttps = httpsValues[0]!;
  else if (httpsValues.length > 1) {
    const labels = httpsValues.map((value) => value === null ? "Leave as it is" : value ? "On" : "Off");
    notes.push(`Legacy DNS profiles disagreed on Always Use HTTPS (${labels.join(" vs ")}), so it was left unchanged.`);
  }

  const panelHostSet = typeof parsed.panelHost === "string" && parsed.panelHost.trim().length > 0;
  const acmeFullSsl = zoneObjects.some((zone) => zone.acmeFullSsl === true) || panelHostSet;
  const webmailFullSsl = zoneObjects.some((zone) => zone.webmailFullSsl === true);
  const allSkipIps = [...new Set(zoneObjects.flatMap((zone) =>
    Array.isArray(zone.skipFirewallIps)
      ? zone.skipFirewallIps.filter((ip): ip is string => typeof ip === "string" && isIP(ip.trim()) !== 0).map((ip) => ip.trim().toLowerCase())
      : []))]
    .sort();
  if (allSkipIps.length > MAX_SKIP_IPS) {
    throw new Error(
      `DNS's Cloudflare edge options were not moved to Firewall: selected DNS profiles contain ${allSkipIps.length} distinct WAF skip IPs, which exceeds Firewall's limit of ${MAX_SKIP_IPS}. Reduce skipFirewallIps in ${p.dnsPolicy} to at most ${MAX_SKIP_IPS} distinct IPs and retry.`,
    );
  }
  const skipFirewallIps = allSkipIps;

  const defaults: EdgeDefaults = { ssl, alwaysHttps, acmeFullSsl, webmailFullSsl, skipFirewallIps };
  const migrationNote = notes.length ? `${notes.join(" ")} Review and approve your Cloudflare edge defaults here.` : null;

  let sharedConnections = 0;
  try {
    sharedConnections = readCloudflareConnections({ stateDir: p.cloudflareStateDir, rootUid: p.rootUid }).length;
  } catch { /* ignore unreadable store */ }
  const hasCloudflare = sharedConnections > 0 || (Array.isArray(parsed.connections) && parsed.connections.length > 0);
  const approved = parsed.automatic === true && existsSync(p.dnsConfig) && hasCloudflare && hasActiveEdgeDefaults(defaults) && migrationNote === null;
  const nowIso = new Date((p.now ?? Date.now)()).toISOString();

  const directoryExisted = existsSync(p.firewallStateDir);
  const originals = new Map<string, SavedFile | null>();
  const keep = (path: string) => { if (!originals.has(path)) originals.set(path, snapshotTrusted(path, p.rootUid)); };
  const undo = () => {
    for (const [path, before] of [...originals].reverse()) {
      if (before) restore(before); else rmSync(path, { force: true });
    }
    if (!directoryExisted && existsSync(p.firewallStateDir)) {
      try { rmdirSync(p.firewallStateDir); } catch { /* non-empty */ }
    }
  };

  try {
    const existingEdge = snapshotTrusted(p.edgeConfig, p.rootUid);
    if (!existingEdge) {
      keep(p.edgeConfig);
      writeFileAtomic(p.edgeConfig, `${JSON.stringify({
        version: 1,
        defaults,
        approved,
        approvedAt: approved ? nowIso : null,
        approvedDigest: approved ? edgeDefaultsDigest(defaults) : null,
        knownZones: [],
        zoneChoices: {},
        migrationNote,
      }, null, 2)}\n`, { mode: 0o600, owner: { uid: p.rootUid, gid: process.getgid?.() ?? 0 }, createParent: true });
    }

    const cleanedProfiles = (parsed.profiles as unknown[]).map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
      const { zone: _dropped, ...rest } = entry as Record<string, unknown>;
      return rest;
    });
    keep(source.path);
    restore({ ...source, text: `${JSON.stringify({ ...parsed, profiles: cleanedProfiles }, null, 2)}\n` });

    if (!existingEdge && approved && existsSync(p.dnsConfig) && !existsSync(p.firewallConfig) && p.firewallWasEnabled !== true) {
      const policy = snapshotTrusted(p.firewallPolicy, p.rootUid);
      let fwPolicy: Record<string, unknown> | null = null;
      try { fwPolicy = policy ? legacySettings(policy.text) : null; } catch { fwPolicy = null; }
      if (fwPolicy?.autoEnableNewSites === true) {
        keep(p.firewallPolicy);
        restore({ ...policy!, text: `${JSON.stringify({ ...fwPolicy, autoEnableNewSites: false }, null, 2)}\n` });
        log.warn("Firewall's Enable on new sites was switched off: it was saved while Firewall was disabled");
      }
      if (!snapshotTrusted(p.visitorIpState, p.rootUid)) {
        keep(p.visitorIpState);
        writeFileAtomic(p.visitorIpState, `${JSON.stringify({ version: 1, enabled: false }, null, 2)}\n`, {
          mode: 0o600,
          owner: { uid: p.rootUid, gid: process.getgid?.() ?? 0 },
          createParent: true,
        });
      }
      keep(p.firewallConfig);
      enable();
    }

    return undo;
  } catch (error) {
    undo();
    throw new Error(`DNS's Cloudflare edge options were not moved to Firewall: ${errorMessage(error)}`);
  }
}

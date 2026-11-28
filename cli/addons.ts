import { addonStateDir, CONFIG_DIR, LOCK_DIR, STATE_DIR, SYSTEMD_DIR } from "../lib/paths";
import { withFileLockSync } from "../lib/file-lock";
import { migrateResourceMemory } from "../addons/resource-limits/migration";
import {
  cloudflareEdgeMigrationPending, LEGACY_PROTOCOLS_FILE, migrateCloudflareEdgeFromDns, migrateFirewallProtocols,
  migrateVisitorIp, visitorIpMigrationPending,
} from "../addons/firewall/migration";
import { legacyDnsCloudflarePending, migrateCloudflareFromDns } from "../lib/cloudflare/store";
import { migrateRedirectsFromDns, redirectsMigrationPending } from "../addons/redirects/migration";
import { upgradeSavedPolicy } from "../addons/dns/model";
import { ADDONS, ADDON_NAMES, addonEnabled } from "../addons/catalog";
import { archRefusal, type AddonSpec } from "../lib/addon-definition";
import { masterVhostHost } from "./inject";
import { type Addresses, detectAddresses } from "../addons/dns/addresses";
import { panelCustomDomain } from "../lib/panel-custom-domain";
import { panelUserUid } from "../lib/sso-auth";
import { writeConfig } from "./provision";
import { fatal, log } from "../lib/log";
import { chownSync, existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
export function resolveAddon(name: string | undefined): AddonSpec {
  const key = name ?? "";
  const spec = ADDONS[key];
  if (!spec) fatal(`unknown addon '${key}'. Available: ${ADDON_NAMES.join(", ")}`);
  return spec;
}

/** An addon to enable: refused on an architecture it does not support. */
export function resolveEnableable(name: string | undefined, arch: string = process.arch): AddonSpec {
  const spec = resolveAddon(name);
  const refusal = archRefusal(spec, arch);
  if (refusal) fatal(refusal);
  return spec;
}

const RENAMED_ADDONS: Record<string, string> = { "wp-login": "wp-tools", "php-resources": "resource-limits", "cloudflare-ips": "firewall" };
/** What the earlier version locked the moved state with, held while it moves. */
const LEGACY_LOCKS = ["cloudflare-ips.lock", "system-tweaks-firewall.lock"];

/** What a rename moved, so a failed update can hand it back to the binary it restores. */
export interface AddonRename {
  from: string;
  to: string;
  /** The old config, or null when the addon was disabled. */
  config: { text: string; uid: number; gid: number } | null;
  stateMoved: boolean;
  configCreated?: boolean;
  undo?: () => void;
}

function migrationPending(): boolean {
  if (Object.keys(RENAMED_ADDONS).some((from) =>
    existsSync(`${CONFIG_DIR}/${from}.conf`) || existsSync(`${CONFIG_DIR}/${from}.conf.new`) || existsSync(`${STATE_DIR}/${from}`))) return true;
  if (existsSync(`${addonStateDir("system-tweaks")}/memory.json`) || existsSync(LEGACY_PROTOCOLS_FILE)) return true;
  if (legacyDnsCloudflarePending() || visitorIpMigrationPending() || cloudflareEdgeMigrationPending() || redirectsMigrationPending()) return true;
  const oom = `${SYSTEMD_DIR}/nginx.service.d/zz-clp-addons-oom.conf`;
  if (existsSync(oom) && readFileSync(oom, "utf8").includes("clp-addons System Tweaks:")) return true;
  try {
    const parsed = JSON.parse(readFileSync(`${addonStateDir("system-tweaks")}/settings.json`, "utf8")) ?? {};
    return Object.hasOwn(parsed, "memory");
  } catch {
    return false;
  }
}

export function migrateOldAddonNames(quiet = false, legacyWaitSeconds = 300): AddonRename[] {
  if (!migrationPending()) {
    removeLegacyLocks();
    return [];
  }
  // Service start hooks and settings writes must see the policy on one side of
  // the transfer. A PHP Resources change the earlier version started may still
  // be applying pools; moving its policy from under it would let it write the
  // old directory back, so the move waits for it as long as such a change runs.
  return withFileLockSync(`${LOCK_DIR}/php-resources.lock`, legacyWaitSeconds, "a PHP Resources change from the earlier version is still running", () =>
    withMigrationLocks(() => migrateAddonState(quiet)));
}

/** Holds every live and legacy addon lock touched by state migrations, in `dns.lock` -> `firewall-edge.lock` -> `redirects.lock` -> `cloudflare.lock` order. */
function withMigrationLocks<T>(body: () => T): T {
  return withFileLockSync(`${LOCK_DIR}/resource-limits-settings.lock`, 15, "a resource limits change is still running", () =>
    withFileLockSync(`${LOCK_DIR}/system-tweaks.lock`, 15, "a system tweaks change is still running", () =>
      withFileLockSync(`${LOCK_DIR}/firewall-visitor-ip.lock`, 30, "another Cloudflare visitor IP change is running", () =>
        withFileLockSync(`${LOCK_DIR}/dns.lock`, 30, "another DNS change is running", () =>
          withFileLockSync(`${LOCK_DIR}/firewall-edge.lock`, 30, "another Cloudflare edge change is running", () =>
            withFileLockSync(`${LOCK_DIR}/redirects.lock`, 30, "another Redirects change is running", () =>
            withFileLockSync(`${LOCK_DIR}/cloudflare.lock`, 30, "another Cloudflare connection change is running", () =>
              withLegacyLocks(LEGACY_LOCKS, body))))))));
}

function withLegacyLocks<T>(names: string[], body: () => T): T {
  const [name, ...rest] = names;
  if (!name) return body();
  return withFileLockSync(`${LOCK_DIR}/${name}`, 30, "a change from the earlier version is still running", () => withLegacyLocks(rest, body));
}

/** Lock files hold no saved policy. Old processes are replaced by provisioning. */
function removeLegacyLocks(): void {
  for (const name of ["php-resources.lock", "system-tweaks-memory.lock", ...LEGACY_LOCKS]) rmSync(`${LOCK_DIR}/${name}`, { force: true });
}

function migrateAddonState(quiet: boolean): AddonRename[] {
  const renames: AddonRename[] = [];
  // Capture before the rename or protocol migration creates firewall.conf so unsaved visitor-IP defaults still migrate and carry root's lock.
  const firewallWasEnabled = addonEnabled(ADDONS.firewall!);
  try {
    for (const [from, to] of Object.entries(RENAMED_ADDONS)) {
      const legacyConfig = `${CONFIG_DIR}/${from}.conf`;
      const legacyState = `${STATE_DIR}/${from}`;
      if (existsSync(legacyState) && readdirSync(legacyState).length === 0) rmSync(legacyState, { recursive: true, force: true });
      // A disabled addon has no config but keeps its state for re-enabling.
      if (!existsSync(legacyConfig) && !existsSync(legacyState)) {
        rmSync(`${legacyConfig}.new`, { force: true });
        continue;
      }
      const spec = ADDONS[to]!;
      if (existsSync(legacyState) && existsSync(spec.stateDir) && readdirSync(spec.stateDir).length > 0) {
        log.warn(`${from} was not renamed: ${legacyState} and ${spec.stateDir} both hold state. ` +
          `Keep the current one under ${spec.stateDir}, remove ${legacyState}, then run 'clp-addons repair'`);
        continue;
      }
      const config = existsSync(legacyConfig)
        ? { text: readFileSync(legacyConfig, "utf8"), uid: statSync(legacyConfig).uid, gid: statSync(legacyConfig).gid }
        : null;
      const stateMoved = existsSync(legacyState);
      const configCreated = config !== null && !addonEnabled(spec);
      const renamed: AddonRename = { from, to, config, stateMoved: false, configCreated };
      renames.push(renamed);
      if (stateMoved) {
        rmSync(spec.stateDir, { recursive: true, force: true });
        renameSync(legacyState, spec.stateDir);
        renamed.stateMoved = true;
      }
      if (configCreated) writeConfig(spec, true);
      rmSync(legacyConfig, { force: true });
      rmSync(`${legacyConfig}.new`, { force: true });
      if (!quiet) log.ok(`${from} is ${to} now and was carried over`);
    }
    const undo = migrateResourceMemory(() => writeConfig(ADDONS["resource-limits"]!, true));
    if (undo) renames.push({ from: "system-tweaks", to: "resource-limits", config: null, stateMoved: false, undo });
    // After the rename, which refuses a firewall state directory that already holds anything.
    const protocols = migrateFirewallProtocols(() => writeConfig(ADDONS.firewall!, true));
    if (protocols) renames.push({ from: "system-tweaks", to: "firewall", config: null, stateMoved: false, undo: protocols });
    const visitorIp = migrateVisitorIp(() => writeConfig(ADDONS.firewall!, true), { firewallWasEnabled });
    if (visitorIp) renames.push({ from: "system-tweaks", to: "firewall", config: null, stateMoved: false, undo: visitorIp });
    const cloudflare = migrateCloudflareFromDns();
    if (cloudflare) renames.push({ from: "dns", to: "cloudflare", config: null, stateMoved: false, undo: cloudflare });
    const cloudflareEdge = migrateCloudflareEdgeFromDns(() => writeConfig(ADDONS.firewall!, true), { firewallWasEnabled });
    if (cloudflareEdge) renames.push({ from: "dns", to: "firewall", config: null, stateMoved: false, undo: cloudflareEdge });
    const redirects = migrateRedirectsFromDns(() => writeConfig(ADDONS.redirects!, true), { upgradeDnsPolicy: upgradeSavedPolicy });
    if (redirects) renames.push({ from: "dns", to: "redirects", config: null, stateMoved: false, undo: redirects });
    removeLegacyLocks();
    return renames;
  } catch (error) { restoreAddonState(renames); throw error; }
}

export function revertAddonRenames(renames: AddonRename[]): void {
  withMigrationLocks(() => restoreAddonState(renames));
}

function restoreAddonState(renames: AddonRename[]): void {
  for (const { from, to, config, stateMoved, configCreated, undo } of [...renames].reverse()) {
    if (undo) { undo(); continue; }
    const spec = ADDONS[to]!;
    if (stateMoved && existsSync(spec.stateDir) && !existsSync(`${STATE_DIR}/${from}`)) renameSync(spec.stateDir, `${STATE_DIR}/${from}`);
    if (config !== null) {
      writeFileSync(`${CONFIG_DIR}/${from}.conf`, config.text, { mode: 0o640 });
      chownSync(`${CONFIG_DIR}/${from}.conf`, config.uid, config.gid);
    }
    if (configCreated) rmSync(spec.configFile, { force: true });
    log.warn(`${to} was put back as ${from} for the earlier version`);
  }
}

export interface DashboardHost {
  /** CloudPanel's custom domain, served on 443 by the sites' Nginx. */
  customDomain?: string;
  /** A hostname in the panel's own port-8443 server block. */
  vhostHost: string | null;
  addresses: Addresses;
}

/**
 * Where the operator opens the Addons page: the custom domain when CloudPanel
 * has one, else the panel's own port 8443 by hostname or public address.
 */
export function dashboardUrlFor(host: DashboardHost): string {
  if (host.customDomain) return `https://${host.customDomain}/addons/`;
  const name = host.vhostHost ?? host.addresses.ipv4 ?? (host.addresses.ipv6 ? `[${host.addresses.ipv6}]` : null);
  return `https://${name ?? "<server-ip>"}:8443/addons/`;
}

export function dashboardUrl(): string {
  const panelUid = panelUserUid();
  return dashboardUrlFor({
    customDomain: panelCustomDomain(panelUid === null ? [0] : [0, panelUid]),
    vhostHost: masterVhostHost(),
    addresses: detectAddresses(),
  });
}

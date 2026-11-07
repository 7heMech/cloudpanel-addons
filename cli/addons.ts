// Which addons are installed, which name resolves to which, and where the
// Addons page lives. Every command needs some of this and none of it belongs
// to one of them.

import { withFileLockSync } from "../lib/file-lock";
import { migrateResourceMemory } from "../addons/resource-limits/migration";
import { ADDONS, ADDON_NAMES, addonEnabled } from "../addons/catalog";
import { type AddonSpec } from "../lib/addon-definition";
import { masterVhostHost } from "./inject";
import { CONFIG_DIR, LOCK_DIR, STATE_DIR, SYSTEMD_DIR } from "../lib/paths";
import { writeConfig } from "./provision";
import { fatal, log } from "../lib/log";
import { chownSync, existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
export function resolveAddon(name: string | undefined): AddonSpec {
  const key = name ?? "";
  const spec = ADDONS[key];
  if (!spec) fatal(`unknown addon '${key}'. Available: ${ADDON_NAMES.join(", ")}`);
  return spec;
}

/** Shipped addon ids whose saved state and enabled records move with the feature. */
const RENAMED_ADDONS: Record<string, string> = { "wp-login": "wp-tools", "php-resources": "resource-limits" };

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

/** Whether anything is left under an old name, so install, repair and update wait on no lock otherwise. */
function migrationPending(): boolean {
  if (Object.keys(RENAMED_ADDONS).some((from) =>
    existsSync(`${CONFIG_DIR}/${from}.conf`) || existsSync(`${CONFIG_DIR}/${from}.conf.new`) || existsSync(`${STATE_DIR}/${from}`))) return true;
  if (existsSync(`${STATE_DIR}/system-tweaks/memory.json`)) return true;
  const oom = `${SYSTEMD_DIR}/nginx.service.d/zz-clp-addons-oom.conf`;
  if (existsSync(oom) && readFileSync(oom, "utf8").includes("clp-addons System Tweaks:")) return true;
  try {
    return Object.hasOwn(JSON.parse(readFileSync(`${STATE_DIR}/system-tweaks/settings.json`, "utf8")) ?? {}, "memory");
  } catch {
    return false;
  }
}

export function migrateOldAddonNames(quiet = false, legacyWaitSeconds = 300): AddonRename[] {
  if (!migrationPending()) {
    // Lock files hold no saved policy. Old processes are replaced by provisioning.
    rmSync(`${LOCK_DIR}/php-resources.lock`, { force: true });
    rmSync(`${LOCK_DIR}/system-tweaks-memory.lock`, { force: true });
    return [];
  }
  // Service start hooks and settings writes must see the policy on one side of
  // the transfer. A PHP Resources change the earlier version started may still
  // be applying pools; moving its policy from under it would let it write the
  // old directory back, so the move waits for it as long as such a change runs.
  return withFileLockSync(`${LOCK_DIR}/php-resources.lock`, legacyWaitSeconds, "a PHP Resources change from the earlier version is still running", () =>
    withFileLockSync(`${LOCK_DIR}/resource-limits-settings.lock`, 15, "a resource limits change is still running", () =>
      withFileLockSync(`${LOCK_DIR}/system-tweaks.lock`, 15, "a system tweaks change is still running", () => migrateAddonState(quiet))));
}

function migrateAddonState(quiet: boolean): AddonRename[] {
  const renames: AddonRename[] = [];
  try {
    for (const [from, to] of Object.entries(RENAMED_ADDONS)) {
      const legacyConfig = `${CONFIG_DIR}/${from}.conf`;
      const legacyState = `${STATE_DIR}/${from}`;
      // An empty old state directory holds nothing to keep or to conflict with.
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
    // Lock files hold no saved policy. Old processes are replaced by provisioning.
    rmSync(`${LOCK_DIR}/php-resources.lock`, { force: true });
    rmSync(`${LOCK_DIR}/system-tweaks-memory.lock`, { force: true });
    return renames;
  } catch (error) { restoreAddonState(renames); throw error; }
}

/** Puts renamed addons back under their old names for the earlier binary a rollback restores. */
export function revertAddonRenames(renames: AddonRename[]): void {
  withFileLockSync(`${LOCK_DIR}/resource-limits-settings.lock`, 15, "a resource limits change is still running", () =>
    withFileLockSync(`${LOCK_DIR}/system-tweaks.lock`, 15, "a system tweaks change is still running", () => restoreAddonState(renames)));
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

export function dashboardUrl(): string {
  const host = masterVhostHost() ?? "<cloudpanel-host>";
  return `https://${host}/addons/`;
}

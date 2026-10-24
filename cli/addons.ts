// Which addons are installed, which name resolves to which, and where the
// Addons page lives. Every command needs some of this and none of it belongs
// to one of them.

import { ADDONS, ADDON_NAMES, type AddonSpec } from "./addon-catalog";
import { masterVhostHost } from "./inject";
import { CONFIG_DIR, STATE_DIR } from "./paths";
import { installedConfig, writeConfig } from "./provision";
import { fatal, log } from "./util";
import { chownSync, existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
export function resolveAddon(name: string | undefined): AddonSpec {
  const key = name ?? "";
  const spec = ADDONS[key];
  if (!spec) fatal(`unknown addon '${key}'. Available: ${ADDON_NAMES.join(", ")}`);
  return spec;
}

export function installedAddons(): AddonSpec[] {
  return ADDON_NAMES.map((name) => ADDONS[name]!).filter(installedConfig);
}

/**
 * `wp-login` became `wp-tools` when the addon outgrew sign-in. Its state is
 * moved rather than dropped: it holds the MainWP connections the addon made and
 * any login setting an enrollment changed for a moment. Templates follow on the
 * next render, because the injection set is read from the config files.
 */
const RENAMED_ADDONS: Record<string, string> = { "wp-login": "wp-tools" };

/** What a rename moved, so a failed update can hand it back to the binary it restores. */
export interface AddonRename {
  from: string;
  to: string;
  /** The old config, or null when the addon was disabled. */
  config: { text: string; uid: number; gid: number } | null;
  stateMoved: boolean;
}

export function migrateOldAddonNames(quiet = false): AddonRename[] {
  const renames: AddonRename[] = [];
  for (const [from, to] of Object.entries(RENAMED_ADDONS)) {
    const legacyConfig = `${CONFIG_DIR}/${from}.conf`;
    const legacyState = `${STATE_DIR}/${from}`;
    // A disabled addon has no config but keeps its state for re-enabling.
    if (!existsSync(legacyConfig) && !existsSync(legacyState)) continue;
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
    if (stateMoved) {
      rmSync(spec.stateDir, { recursive: true, force: true });
      renameSync(legacyState, spec.stateDir);
    }
    if (config !== null && !installedConfig(spec)) writeConfig(spec, true);
    rmSync(legacyConfig, { force: true });
    rmSync(`${legacyConfig}.new`, { force: true });
    renames.push({ from, to, config, stateMoved });
    if (!quiet) log.ok(`${from} is ${to} now and was carried over`);
  }
  return renames;
}

/** Puts renamed addons back under their old names for the earlier binary a rollback restores. */
export function revertAddonRenames(renames: AddonRename[]): void {
  for (const { from, to, config, stateMoved } of renames) {
    const spec = ADDONS[to]!;
    if (stateMoved && existsSync(spec.stateDir) && !existsSync(`${STATE_DIR}/${from}`)) renameSync(spec.stateDir, `${STATE_DIR}/${from}`);
    if (config !== null) {
      writeFileSync(`${CONFIG_DIR}/${from}.conf`, config.text, { mode: 0o640 });
      chownSync(`${CONFIG_DIR}/${from}.conf`, config.uid, config.gid);
    }
    rmSync(spec.configFile, { force: true });
    log.warn(`${to} was put back as ${from} for the earlier version`);
  }
}

export function dashboardUrl(): string {
  const host = masterVhostHost() ?? "<cloudpanel-host>";
  return `https://${host}/addons/`;
}

// Which addons are installed, which name resolves to which, and where the
// Addons page lives. Every command needs some of this and none of it belongs
// to one of them.

import { ADDONS, ADDON_NAMES, type AddonSpec } from "./addon-catalog";
import { masterVhostHost } from "./inject";
import { CONFIG_DIR, STATE_DIR } from "./paths";
import { installedConfig, writeConfig } from "./provision";
import { fatal, log } from "./util";
import { existsSync, rmSync } from "node:fs";
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
 * Addons that are now part of another addon.
 *
 * `login-theme` was a whole addon for one script in the login page's <head>.
 * It is a switch inside Panel Tweaks now, and a box that had it enabled
 * should come out of an update with the device theme still working rather than
 * with an addon that no longer exists. The config file is the enabled flag, so
 * moving it is the whole migration: the state directory held nothing, and the Twig
 * block goes when the templates are next rendered, because the injection set is
 * read from the config files.
 */
const ABSORBED_ADDONS: Record<string, string> = { "login-theme": "panel-tweaks" };

export function migrateAbsorbedAddons(quiet = false): void {
  for (const [from, into] of Object.entries(ABSORBED_ADDONS)) {
    const legacyConfig = `${CONFIG_DIR}/${from}.conf`;
    if (!existsSync(legacyConfig)) continue;
    const spec = ADDONS[into];
    if (spec && !installedConfig(spec)) writeConfig(spec, true);
    rmSync(legacyConfig, { force: true });
    rmSync(`${legacyConfig}.new`, { force: true });
    rmSync(`${STATE_DIR}/${from}`, { recursive: true, force: true });
    if (!quiet) log.ok(`${from} is part of ${into} now and was carried over`);
  }
}

export function dashboardUrl(): string {
  const host = masterVhostHost() ?? "<cloudpanel-host>";
  return `https://${host}/addons/`;
}

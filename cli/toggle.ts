// Enabling and disabling an addon, and the one-time platform provisioning an
// install or a first enable needs. A toggle is not an install: it applies a
// delta and keeps the addon's state.

import { installedAddons, resolveAddon } from "./addons";
import { reconcileAnchors, reconcileMaintenanceNginx, reconcileNginx } from "./reconcile";
import { removeWpLogin } from "../addons/wp-login/action";
import { type AddonSpec } from "./addon-catalog";
import { withOperationLock, withOperationLockSync } from "./operation-lock";
import {
  applyToggleUnits, ensureAuthHelperReady, ensureDirs, ensureRequiredUnits, ensureServiceUser,
  installUnits, platformProvisioned, reconcilePanelIdentity, removeLegacyInstall, removeLegacyUnits,
  removeLegacyUsers, startUnits, writeConfig,
} from "./provision";
import { fatal, log, requireRoot } from "./util";
import { rmSync } from "node:fs";
/**
 * Everything a first install has to put on the box, in the order it has to
 * happen: accounts and directories before files, files before units, units
 * before anything is started.
 *
 * Shared by `install` and by an `enable` that finds nothing provisioned. It is
 * deliberately not what a toggle runs -- re-creating the service user, probing
 * the auth helper and sweeping legacy installs are answers to "has this box
 * ever been set up", and asking that on every toggle is most of what made a
 * toggle slow.
 */
export function bootstrapProvision(specs: AddonSpec[]): void {
  ensureServiceUser();
  removeLegacyInstall();
  ensureDirs(specs, true);
  ensureAuthHelperReady();
  for (const item of specs) writeConfig(item, true);
  reconcilePanelIdentity();
  installUnits(specs);
  removeLegacyUnits(true);
  removeLegacyUsers(true);
  ensureDirs(specs);
  if (!reconcileAnchors(false)) fatal("could not safely patch the required CloudPanel templates");
  if (!reconcileMaintenanceNginx(false)) fatal("could not safely inject the Nginx maintenance check");
  if (!reconcileNginx(false)) fatal("could not safely inject the CloudPanel Nginx proxy");
  startUnits();
}

/**
 * Turn an addon that already ships in this binary on.
 *
 * This is `cmdInstall` with the download removed, because there is nothing to
 * download: `ADDONS` is compiled in and so are its injection targets. What is
 * left -- the config file, the state directory, the Twig anchors, the units --
 * is the whole of what "installed" ever meant for an individual addon.
 */
export async function applyEnable(name: string): Promise<void> {
  requireRoot("enable");
  const spec = resolveAddon(name);
  return withOperationLock(`enable ${spec.name}`, () => enableAddon(spec));
}

async function enableAddon(spec: AddonSpec): Promise<void> {
  ensureRequiredUnits(spec);
  const before = installedAddons().filter((item) => item.name !== spec.name);
  const specs = [...before, spec];

  if (!platformProvisioned()) {
    bootstrapProvision(specs);
    log.ok(`${spec.name} enabled`);
    return;
  }

  // The panel identity is what lets a site action refuse to operate on the
  // panel's own hostname, and disabling the last addon removes it. Put it back
  // before anything that could accept a site action, which is the moment this
  // addon's config file exists.
  if (before.length === 0) reconcilePanelIdentity(true, specs);
  writeConfig(spec, true);
  ensureDirs(specs);
  const changes = installUnits(specs);
  // An addon with no injection targets changes no panel markup, so there is
  // nothing to patch and nothing to purge. cloudflare-ips is the current case.
  if (spec.targets.length > 0 && !reconcileAnchors(false)) {
    fatal("could not safely patch the required CloudPanel templates");
  }
  if (spec.name === "maintenance" && !reconcileMaintenanceNginx(false, true)) {
    fatal("could not safely inject the Nginx maintenance check");
  }
  applyToggleUnits(changes);
  log.ok(`${spec.name} enabled`);
}

/**
 * The WordPress sign-in helper is a file in somebody else's site, not state in
 * this addon's own directory, so withdrawing the addon has to take it back out.
 * A failure warns rather than stops: an addon that cannot be removed because
 * one site's files moved would be worse than a helper left behind and named.
 */
export function withdrawWpLogin(): void {
  try {
    const { removed, failed } = removeWpLogin();
    if (removed > 0) log.ok(`sign-in helper removed from ${removed} site${removed === 1 ? "" : "s"}`);
    if (failed.length > 0) log.warn(`the sign-in helper is still in ${failed.join("; ")}`);
  } catch (error) {
    log.warn(`the sign-in helper could not be removed from every site: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Turn one addon off and leave everything it made behind.
 *
 * Deliberately not `cmdUninstall`: that removes the binary once the last addon
 * goes, and may remove an addon's data. Disabling withdraws the addon from the
 * panel -- its config, its units' knowledge of it, its Twig markup -- and keeps
 * its state directory, so enabling it again returns the same instances.
 */
export function applyDisable(name: string): void {
  requireRoot("disable");
  const spec = resolveAddon(name);
  withOperationLockSync(`disable ${spec.name}`, () => disableAddon(spec));
}

function disableAddon(spec: AddonSpec): void {
  const remaining = installedAddons().filter((item) => item.name !== spec.name);

  if (spec.name === "wp-login") withdrawWpLogin();
  rmSync(spec.configFile, { force: true });
  rmSync(`${spec.configFile}.new`, { force: true });
  // Reconciled after the config file is gone, so the injection set is read
  // from the state that now exists rather than described by an `exclude`
  // argument. The Twig cache is purged by the reconciler when the markup
  // actually changes; disable used to purge it a second time unconditionally.
  if (spec.targets.length > 0) reconcileAnchors(false);
  if (spec.name === "maintenance" && !reconcileMaintenanceNginx(false, false)) {
    fatal("could not safely update the Nginx maintenance check");
  }
  ensureDirs(remaining);
  // Nothing of ours may act on a site once no addon is enabled.
  if (remaining.length === 0) reconcilePanelIdentity(true, remaining);
  const changes = installUnits(remaining);
  applyToggleUnits(changes);
  log.ok(`${spec.name} disabled; its data under ${spec.stateDir} was kept`);
}

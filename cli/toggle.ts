// Enabling and disabling an addon, and the one-time platform provisioning an
// install or a first enable needs. A toggle is not an install: it applies a
// delta and keeps the addon's state.

import { enabledAddons, addonEnabled } from "../addons/catalog";
import { resolveAddon } from "./addons";
import { reconcileAnchors, reconcileNginx, reconcilePanelBlocks } from "./reconcile";
import { reconcilePhpGuard, settlePhpGuard } from "../lib/php-guard";
import { type AddonSpec } from "../lib/addon-definition";
import { withOperationLock, withOperationLockSync } from "./operation-lock";
import {
  applyToggleUnits, ensureAuthHelperReady, ensureDirs, ensureRequiredUnits, ensureServiceUser, installUnits,
  platformProvisioned, reconcilePanelIdentity, removeLegacyUnits, startUnits, writeConfig,
} from "./provision";
import { fatal, log, requireRoot } from "../lib/log";
import { rmSync } from "node:fs";
/**
 * Everything a first install has to put on the box, in the order it has to
 * happen: accounts and directories before files, files before units, units
 * before anything is started.
 *
 * Shared by `install` and by an `enable` that finds nothing provisioned. It is
 * deliberately not what a toggle runs -- re-creating the service user, probing
 * the auth helper are answers to "has this box
 * ever been set up", and asking that on every toggle is most of what made a
 * toggle slow.
 */
export function bootstrapProvision(specs: AddonSpec[]): void {
  ensureServiceUser();
  ensureDirs(specs, true);
  ensureAuthHelperReady();
  for (const item of specs) writeConfig(item, true);
  reconcilePanelIdentity();
  installUnits(specs);
  removeLegacyUnits(true);
  ensureDirs(specs);
  if (!reconcileAnchors(false)) fatal("could not safely patch the required CloudPanel templates");
  if (!reconcilePanelBlocks(false)) fatal("could not safely change CloudPanel's Nginx settings");
  if (!reconcileNginx(false)) fatal("could not safely inject the CloudPanel Nginx proxy");
  reconcilePhpGuard(true);
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
  const before = enabledAddons().filter((item) => item.name !== spec.name);
  const specs = [...before, spec];

  if (!platformProvisioned()) {
    bootstrapProvision(specs);
    spec.activate?.();
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
  if (spec.panelBlock && !spec.panelBlock.reconcile(true, false)) fatal("could not safely change CloudPanel's Nginx settings");
  applyToggleUnits(changes);
  spec.activate?.();
  log.ok(`${spec.name} enabled`);
}

/**
 * Turn one addon off and leave everything it made behind.
 *
 * Disabling withdraws the addon from the panel -- its config, its units'
 * knowledge of it, its Twig markup -- and keeps its state directory, so
 * enabling it again returns the same instances.
 */
export function applyDisable(name: string): void {
  requireRoot("disable");
  const spec = resolveAddon(name);
  withOperationLockSync(`disable ${spec.name}`, () => {
    if (!addonEnabled(spec)) return log.ok(`${spec.name} is already disabled`);
    disableAddon(spec);
  });
}

function disableAddon(spec: AddonSpec): void {
  const remaining = enabledAddons().filter((item) => item.name !== spec.name);

  spec.deactivate?.();
  const removeConfig = () => {
    rmSync(spec.configFile, { force: true });
    rmSync(`${spec.configFile}.new`, { force: true });
  };
  if (spec.withdraw) spec.withdraw(removeConfig);
  else removeConfig();
  try {
    spec.withdrawn?.();
  } catch (error) {
    // With the config gone a second disable would say it is done, and repair
    // skips a disabled addon, so the half-withdrawn addon is enabled again.
    const reason = error instanceof Error ? error.message : String(error);
    try {
      writeConfig(spec, true);
    } catch (restore) {
      fatal(`${spec.name} could not be disabled (${reason}), nor enabled again (${restore instanceof Error ? restore.message : String(restore)}). Run clp-addons enable ${spec.name}, then disable it again`);
    }
    fatal(`${spec.name} could not be disabled and is still enabled: ${reason}. Run clp-addons disable ${spec.name} again`);
  }
  // Even with no addon left the binary stays, and repair keeps the guard.
  settlePhpGuard();
  // Reconciled after the config file is gone, so the injection set is read
  // from the state that now exists rather than described by an `exclude`
  // argument. The Twig cache is purged by the reconciler when the markup
  // actually changes; disable used to purge it a second time unconditionally.
  if (spec.targets.length > 0) reconcileAnchors(false);
  if (spec.panelBlock && !spec.panelBlock.reconcile(false, false)) fatal("could not safely change CloudPanel's Nginx settings");
  ensureDirs(remaining);
  // Nothing of ours may act on a site once no addon is enabled.
  if (remaining.length === 0) reconcilePanelIdentity(true, remaining);
  const changes = installUnits(remaining);
  applyToggleUnits(changes);
  log.ok(`${spec.name} disabled; its data under ${spec.stateDir} was kept`);
}

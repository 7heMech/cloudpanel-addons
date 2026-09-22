// `clp-addons repair`.

import { installedAddons, resolveAddon, migrateAbsorbedAddons } from "./addons";
import { reconcileAnchors, reconcileMaintenanceNginx, reconcileNginx } from "./reconcile";
import { runAddonMaintenance, runManagerMaintenance } from "./maintenance";
import { withOperationLock } from "./operation-lock";
import { CLOUDFLARE_RECONCILE_TIMER, MANAGER_UNIT, SYSTEMD_DIR } from "./paths";
import {
  ensureAuthHelperReady, ensureDirs, ensureServiceUser, ensureTimerArmed, hardenBackups, installUnits,
  reconcilePanelIdentity, removeLegacyInstall, removeLegacyUnits, removeLegacyUsers, startUnits,
  unitActive, warnIfPanelSessionUnreadable, writeConfig,
} from "./provision";
import { fatal, log, parseFlags, requireRoot } from "./util";
import { existsSync } from "node:fs";
/**
 * Reconciles manager provisioning and enabled addon state, or only injected
 * CloudPanel anchors and the Nginx proxy when `--anchors-only` is supplied.
 */
export async function cmdRepair(argv: string[]): Promise<void> {
  requireRoot("repair");
  const { positional, flags } = parseFlags(argv);
  const anchorsOnly = flags["anchors-only"] === true;
  return withOperationLock(anchorsOnly ? "repair --anchors-only" : "repair", () => applyRepair(positional, flags));
}

async function applyRepair(positional: string[], flags: Record<string, string | true>): Promise<void> {
  const quiet = flags.quiet === true;
  if (flags["anchors-only"] === true) {
    // The watcher's fast path: reconcile only what this project injected into
    // panel-owned files. The Nginx proxy belongs here as much as the Twig
    // anchors do -- the vhost is owned by the panel user on the CloudPanel
    // layout, so a panel action can drop the /addons/ block at any time, and
    // waiting up to fifteen minutes for the timer would leave the manager
    // unreachable in between. Both reconcilers no-op when nothing drifted, so
    // this stays cheap enough to run on every template write during an upgrade.
    reconcileAnchors(quiet);
    if (!reconcileMaintenanceNginx(quiet)) log.err("Nginx maintenance check is not ready; run repair after checking global_settings");
    if (!reconcileNginx(quiet)) log.err("Nginx proxy is not ready; run repair after checking the master vhost");
    return;
  }
  migrateAbsorbedAddons(quiet);
  const specs = positional[0] ? [resolveAddon(positional[0])] : installedAddons();
  const all = installedAddons();
  // An installation with every addon disabled still needs its timer, its Nginx
  // proxy and the panel's Addons entry reconciled -- that is the state the page
  // offering them back is served from. Only a box with no manager at all has
  // nothing to repair.
  if (specs.length === 0 && !existsSync(`${SYSTEMD_DIR}/${MANAGER_UNIT}`)) {
    fatal("clp-addons is not installed; run install first");
  }

  ensureServiceUser(quiet);
  removeLegacyInstall(quiet);
  ensureDirs(all);
  // Unattended (timer-driven) reconciliation must not abort just because nobody is
  // currently logged into the panel; unlike install, warn and keep repairing.
  warnIfPanelSessionUnreadable();
  try {
    ensureAuthHelperReady();
  } catch (error) {
    log.warn(`panel auth helper check failed, continuing without it: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const spec of all) {
    writeConfig(spec, true);
    hardenBackups(spec, quiet);
  }
  removeLegacyUnits(quiet);
  removeLegacyUsers(quiet);
  reconcilePanelIdentity(quiet);
  const unitChanges = installUnits(all);
  ensureDirs(all);
  if (unitChanges.systemd || unitActive(MANAGER_UNIT) !== "active") startUnits();
  else {
    ensureTimerArmed("clp-addons-reconcile.timer", quiet);
    if (all.some((spec) => spec.name === "cloudflare-ips")) {
      ensureTimerArmed(CLOUDFLARE_RECONCILE_TIMER, quiet);
    }
  }
  reconcileAnchors(quiet);
  if (!reconcileMaintenanceNginx(quiet)) log.err("Nginx maintenance check is not ready; run repair after checking global_settings");
  if (!reconcileNginx(quiet)) log.err("Nginx proxy is not ready; run repair after checking the master vhost");
  // Runs after the master-vhost reconciliation above, not before: recovering
  // a carried-over vhost also does its own `nginx -t` before reloading, and
  // skips the reload if that check fails. Running prune first, while the
  // master vhost might still be broken, would leave a just-restored site
  // vhost on disk but unloaded until the next 15-minute cycle.
  await runAddonMaintenance(all);
  runManagerMaintenance();
  if (!quiet) log.ok(`repair complete (${specs.map((spec) => spec.name).join(", ") || "no addon enabled"})`);
}

// `clp-addons repair`.

import { errorMessage } from "../lib/errors";
import { enabledAddons, phpGuardOptedOut } from "../addons/catalog";
import { resolveAddon, migrateOldAddonNames } from "./addons";
import { reconcileAnchors, reconcileNginx, reconcilePanelBlocks, runAnchorWork } from "./reconcile";
import { reconcilePhpGuard } from "../lib/php-guard";
import { runAddonRepairs, runManagerRepair } from "./addon-hooks";
import { withOperationLock } from "./operation-lock";
import { conffilesReleased } from "./conffiles";
import { CERTIFICATES_PATH, FIREWALL_PATH, MANAGER_UNIT, NEW_SITES_PATH, SYSTEMD_DIR } from "../lib/paths";
import {
  ensureAuthHelperReady, ensureDirs, ensurePathWatching, ensureServiceUser, ensureTimerArmed, hardenBackups,
  installUnits, managerSocketProblem, reconcilePanelIdentity, removeLegacyUnits, startUnits,
  warnIfPanelSessionUnreadable, writeConfig,
} from "./provision";
import { unitActive } from "../lib/systemd";
import { fatal, log, requireRoot } from "../lib/log";
import { parseFlags } from "./flags";
import { existsSync } from "node:fs";
const PANEL_BLOCKS_NOT_READY = "a change to CloudPanel's Nginx settings is not ready; fix the problem above, then run repair again";

/**
 * Reconciles manager provisioning and enabled addon state, or only injected
 * CloudPanel anchors, the Nginx proxy and System Tweaks' phpMyAdmin rules,
 * backup command and SSH login message when `--anchors-only` is supplied.
 */
export async function cmdRepair(argv: string[]): Promise<void> {
  requireRoot("repair");
  const { positional, flags } = parseFlags(argv);
  const anchorsOnly = flags["anchors-only"] === true;
  return withOperationLock(anchorsOnly ? "repair --anchors-only" : "repair", () => applyRepair(positional, flags));
}

async function applyRepair(positional: string[], flags: Record<string, string | true>): Promise<void> {
  const quiet = flags.quiet === true;
  if (conffilesReleased()) {
    // An unattended upgrade has the package's own text in Nginx's conffiles;
    // `apt-hook post` runs repair once it is done.
    if (!quiet) log.warn("an unattended upgrade is running; repair waits for it to finish");
    return;
  }
  if (flags["anchors-only"] === true) {
    // The watcher's fast path: reconcile only what this project injected into
    // panel-owned files. The Nginx proxy belongs here as much as the Twig
    // anchors do -- the vhost is owned by the panel user on the CloudPanel
    // layout, so a panel action can drop the /addons/ block at any time, and
    // waiting up to fifteen minutes for the timer would leave the manager
    // unreachable in between. Both reconcilers no-op when nothing drifted, so
    // this stays cheap enough to run on every template write during an upgrade.
    reconcileAnchors(quiet);
    if (!reconcilePanelBlocks(quiet)) log.err(PANEL_BLOCKS_NOT_READY);
    if (!reconcileNginx(quiet)) log.err("Nginx proxy is not ready; run repair after checking the master vhost");
    await runAnchorWork(quiet);
    return;
  }
  try {
    // An earlier version's PHP Resources change is not waited for here; the next repair moves it.
    migrateOldAddonNames(quiet, 0);
  } catch (error) {
    // Upkeep of everything else does not wait on the move; the next repair tries it again.
    log.warn(`renamed addons were not moved yet: ${errorMessage(error)}`);
  }
  const specs = positional[0] ? [resolveAddon(positional[0])] : enabledAddons();
  const all = enabledAddons();
  // An installation with every addon disabled still needs its timer, its Nginx
  // proxy and the panel's Addons entry reconciled -- that is the state the page
  // offering them back is served from. Only a box with no manager at all has
  // nothing to repair.
  if (specs.length === 0 && !existsSync(`${SYSTEMD_DIR}/${MANAGER_UNIT}`)) {
    fatal("clp-addons is not installed; run install first");
  }

  ensureServiceUser(quiet);
  ensureDirs(all);
  // Unattended (timer-driven) reconciliation must not abort just because nobody is
  // currently logged into the panel; unlike install, warn and keep repairing.
  warnIfPanelSessionUnreadable();
  try {
    ensureAuthHelperReady();
  } catch (error) {
    log.warn(`panel auth helper check failed, continuing without it: ${errorMessage(error)}`);
  }
  for (const spec of all) {
    writeConfig(spec, true);
    hardenBackups(spec, quiet);
  }
  removeLegacyUnits(quiet);
  reconcilePanelIdentity(quiet);
  const unitChanges = installUnits(all);
  ensureDirs(all);
  if (unitChanges.systemd || unitActive(MANAGER_UNIT) !== "active" || managerSocketProblem() !== null) startUnits();
  else {
    ensureTimerArmed("clp-addons-reconcile.timer", quiet);
    if (all.some((spec) => spec.newSites)) ensurePathWatching(NEW_SITES_PATH, quiet);
    if (all.some((spec) => spec.certificates)) ensurePathWatching(CERTIFICATES_PATH, quiet);
    if (all.some((spec) => spec.firewall)) ensurePathWatching(FIREWALL_PATH, quiet);
  }
  reconcileAnchors(quiet);
  if (!reconcilePanelBlocks(quiet)) log.err(PANEL_BLOCKS_NOT_READY);
  if (!reconcileNginx(quiet)) log.err("Nginx proxy is not ready; run repair after checking the master vhost");
  reconcilePhpGuard(true, quiet, { optedOut: phpGuardOptedOut() });
  // Runs after the master-vhost reconciliation above, not before: recovering
  // a carried-over vhost also does its own `nginx -t` before reloading, and
  // skips the reload if that check fails. Running prune first, while the
  // master vhost might still be broken, would leave a just-restored site
  // vhost on disk but unloaded until the next 15-minute cycle.
  await runAddonRepairs(all);
  runManagerRepair();
  if (!quiet) log.ok(`repair complete (${specs.map((spec) => spec.name).join(", ") || "no addon enabled"})`);
}

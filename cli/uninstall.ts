// `clp-addons uninstall`.

import { requireMainwpSettled } from "../addons/wp-tools/mainwp";
import { DEFAULT_WP_TOOLS_PATHS } from "../addons/wp-tools/action";
import { withFileLockSync } from "./action-common";
import { resolveAddon } from "./addons";
import { reconcileAnchors, reconcileMaintenanceNginx, reconcileNginx } from "./reconcile";
import { reconcilePhpGuard, settlePhpGuard } from "./php-guard";
import { withdrawWpTools } from "./toggle";
import { ADDONS, ADDON_NAMES, type AddonSpec } from "./addon-catalog";
import { purgeTwigCache } from "./inject";
import { withOperationLockSync } from "./operation-lock";
import { CLI_BIN, LIBEXEC_DIR } from "./paths";
import {
  ensureDirs, installUnits, installedConfig, reconcilePanelIdentity,
  startUnits, stopUnits,
} from "./provision";
import { fatal, log, parseFlags, requireRoot, tryRun } from "./util";
import { existsSync, readdirSync, rmSync } from "node:fs";
function listInstances(spec: AddonSpec): string[] {
  if (!existsSync(spec.stateDir)) return [];
  return readdirSync(spec.stateDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(`${spec.stateDir}/${entry.name}/meta.json`))
    .map((entry) => entry.name)
    .sort();
}

export function cmdUninstall(argv: string[]): void {
  requireRoot("uninstall");
  const { positional, flags } = parseFlags(argv);
  const spec = resolveAddon(positional[0]);
  if (!installedConfig(spec)) fatal(`${spec.name} is not installed`);
  withOperationLockSync(`uninstall ${spec.name}`, () => applyUninstall(spec, flags));
}

function applyUninstall(spec: AddonSpec, flags: Record<string, string | true>): void {
  if (spec.name !== "wp-tools" || flags.yes !== true) return uninstallContents(spec, flags);
  withFileLockSync(DEFAULT_WP_TOOLS_PATHS.mainwpLockFile, 15, "a MainWP change is still running", () => {
    requireMainwpSettled(DEFAULT_WP_TOOLS_PATHS.mainwpState);
    withFileLockSync(DEFAULT_WP_TOOLS_PATHS.varnishLockFile, 15, "a WordPress Varnish change is still running", () => uninstallContents(spec, flags));
  });
}

function uninstallContents(spec: AddonSpec, flags: Record<string, string | true>): void {
  const purge = flags.purge === true;
  const instances = listInstances(spec);
  const remaining = ADDON_NAMES.filter((name) => name !== spec.name && existsSync(ADDONS[name]!.configFile));

  if (flags.yes !== true) {
    const instanceText = instances.length
      ? instances.map((name) => `  - instance ${name}${purge ? ": container and data" : " (kept)"}`).join("\n")
      : "  - no instances found";
    fatal(
      `uninstall ${spec.name}\n` +
      `  - ${CLI_BIN} action ${spec.name}\n` +
      `  - ${spec.configFile}\n` +
      `  - ${purge ? `${spec.stateDir} and its instances` : `${spec.stateDir} (kept)`}\n` +
      `${instanceText}\n` +
      "Re-run with --yes to proceed.",
    );
  }

  spec.deactivate?.();
  try {
    removeAddonFiles(spec, purge, instances, remaining);
  } catch (error) {
    // Still installed, so what deactivating withdrew goes back, and the shared
    // units the last addon's uninstall had already stopped start again.
    if (existsSync(spec.configFile)) {
      try {
        spec.activate?.();
        if (remaining.length === 0) {
          installUnits([spec]);
          startUnits();
        }
      } catch (restoreError) {
        log.warn(`${spec.name} could not be reactivated: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`);
      }
    }
    throw error;
  }
  spec.withdrawn?.();
  if (purge) rmSync(spec.stateDir, { recursive: true, force: true });

  if (remaining.length > 0) {
    ensureDirs(remaining.map((name) => ADDONS[name]!));
    reconcilePanelIdentity();
    installUnits(remaining.map((name) => ADDONS[name]!));
    startUnits();
    settlePhpGuard();
    log.ok(`${spec.name} removed; remaining addons are still available`);
    return;
  }

  reconcilePanelIdentity(true, []);
  reconcileNginx(true, false);
  reconcilePhpGuard(false, true);
  stopUnits();
  rmSync(CLI_BIN, { force: true });
  rmSync(LIBEXEC_DIR, { recursive: true, force: true });
  log.ok(`${spec.name} removed`);
}

/** Everything up to removing the config file, after which the addon is no longer installed. */
function removeAddonFiles(spec: AddonSpec, purge: boolean, instances: string[], remaining: string[]): void {
  if (!reconcileMaintenanceNginx(true, remaining.includes("maintenance"))) {
    fatal("could not safely update the Nginx maintenance check; no addon files were removed");
  }

  stopUnits(remaining.length > 0);
  reconcileAnchors(true, spec.name, remaining.length > 0);
  purgeTwigCache();
  if (purge) {
    const failed: string[] = [];
    if (spec.name === "instatic") {
      for (const domain of instances) {
        const result = tryRun(CLI_BIN, ["action", "instatic", "delete", "--domain", domain, "--confirm", domain]);
        if (!result.ok) {
          failed.push(domain);
          log.warn(`could not remove ${domain}: ${result.out}`);
        }
      }
    }
    if (failed.length > 0) {
      fatal(`could not remove ${spec.name} instances; state preserved for retry: ${failed.join(", ")}`);
    }
  }
  if (spec.name === "wp-tools") withdrawWpTools();
  // The config last: once it is gone the addon is no longer installed.
  rmSync(`${spec.configFile}.new`, { force: true });
  rmSync(spec.configFile, { force: true });
}

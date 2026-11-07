// `clp-addons self-uninstall`: removes the installation once every addon is
// disabled. Addon data stays.

import { installedAddons } from "./addons";
import { purgeTwigCache } from "./inject";
import { withOperationLockSync } from "./operation-lock";
import { CLI_BIN, LIBEXEC_DIR, STATE_DIR } from "../lib/paths";
import { reconcilePhpGuard } from "../lib/php-guard";
import { reconcilePanelIdentity, stopUnits } from "./provision";
import { reconcileAnchors, reconcileMaintenanceNginx, reconcileNginx } from "./reconcile";
import { fatal, log, requireRoot } from "../lib/log";
import { parseFlags } from "./flags";
import { rmSync } from "node:fs";

export function cmdSelfUninstall(argv: string[]): void {
  requireRoot("self-uninstall");
  const { positional, flags } = parseFlags(argv);
  if (positional.length > 0 || Object.keys(flags).some((flag) => flag !== "yes")) {
    fatal("self-uninstall takes only --yes; turn one addon off with clp-addons disable <addon>");
  }
  withOperationLockSync("uninstall", () => {
    const enabled = installedAddons().map((spec) => spec.name);
    if (enabled.length > 0) {
      fatal(`disable every addon first, on the Addons page or with: clp-addons disable ${enabled.join(" ")}`);
    }
    if (flags.yes !== true) {
      fatal(
        "self-uninstall removes\n" +
        `  - ${CLI_BIN}, its services and its CloudPanel changes\n` +
        `  - nothing in ${STATE_DIR}, where addon data is kept\n` +
        "Re-run with --yes to proceed.",
      );
    }
    // Undone while the units still run, so a failure leaves an installation
    // repair can keep whole and this can be re-run.
    if (!reconcileAnchors(true, undefined, false) || !reconcileMaintenanceNginx(true, false) || !reconcileNginx(true, false)) {
      fatal("could not undo the CloudPanel changes; clp-addons is still installed, so fix the error above and re-run");
    }
    purgeTwigCache();
    stopUnits();
    reconcilePanelIdentity(true, []);
    reconcilePhpGuard(false, true);
    rmSync(CLI_BIN, { force: true });
    rmSync(LIBEXEC_DIR, { recursive: true, force: true });
    log.ok(`clp-addons removed; addon data is kept in ${STATE_DIR}`);
  });
}

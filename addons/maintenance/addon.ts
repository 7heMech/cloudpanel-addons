import { handle } from "./app/index";
import { ensureMaintenanceData, pruneMaintenanceState, runMaintenanceAction } from "./action";
import { inspectNginxMaintenance, reconcileNginxMaintenance, releaseMaintenanceSettings } from "./nginx";
import { cmdMaintenance } from "./cli";
import { log } from "../../lib/log";
import { NGINX_GLOBAL_SETTINGS, addonStateDir } from "../../lib/paths";
import { MAINTENANCE_TARGETS } from "./inject/targets";
import type { AddonDefinition } from "../../lib/addon-definition";

export const MAINTENANCE_ADDON: AddonDefinition = {
  name: "maintenance",
  title: "Maintenance Mode",
  description: "Show a per-site maintenance page with instant toggles and IP bypasses.",
  targets: MAINTENANCE_TARGETS,
  // Nginx workers stat its flags and read its pages, without listing which sites have any.
  stateDirMode: 0o711,
  handler: handle,
  action: runMaintenanceAction,
  // A site deleted from CloudPanel leaves its state behind, and a site created
  // again under its name would otherwise come back serving the 503 page.
  panelBlock: {
    label: "Maintenance",
    reconcile: (enabled, quiet) => {
      if (enabled) ensureMaintenanceData(addonStateDir("maintenance"));
      const result = reconcileNginxMaintenance({ enabled });
      if (result.state === "ok" || (!enabled && result.state === "missing")) {
        if (result.changed && !quiet) log.ok(enabled ? "Nginx maintenance check injected and verified" : "Nginx maintenance check removed and verified");
        return true;
      }
      log.err(`Nginx maintenance check: ${result.detail ?? result.state}`);
      return false;
    },
    inspect: () => {
      const status = inspectNginxMaintenance();
      return status.state === "ok"
        ? { ok: true, text: "Site Checks Injected & Verified ✓" }
        : { ok: false, text: status.detail ?? "Needs repair" };
    },
  },
  commands: {
    maintenance: { usage: "maintenance <domain> [on|off|status]", root: true, enabledOnly: true, run: cmdMaintenance },
  },
  conffiles: [{ path: NGINX_GLOBAL_SETTINGS, marker: "# clp-addons:maintenance:start", release: () => releaseMaintenanceSettings() }],
  repair: {
    label: "maintenance state (prune)",
    run: async () => {
      const removed = pruneMaintenanceState();
      return removed.length ? `removed the state of ${removed.length} deleted site${removed.length === 1 ? "" : "s"}` : null;
    },
  },
};

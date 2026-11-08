import { handle } from "./app/index";
import { ensureMaintenanceData, pruneMaintenanceState, runMaintenanceAction } from "./action";
import { inspectNginxMaintenance, reconcileNginxMaintenance, releaseMaintenanceSettings } from "./nginx";
import { cmdMaintenance } from "./cli";
import { log } from "../../lib/log";
import { rebaselineNote } from "../../lib/panel-holds";
import { NGINX_GLOBAL_SETTINGS, addonStateDir } from "../../lib/paths";
import { MAINTENANCE_TARGETS } from "./inject/targets";
import type { AddonDefinition } from "../../lib/addon-definition";

export const MAINTENANCE_ADDON: AddonDefinition = {
  name: "maintenance",
  title: "Maintenance Mode",
  description: "Show a per-site maintenance page with instant toggles and IP bypasses.",
  changed: [{ in: "2.1.0-rc.4", note: "Bypass addresses match visitors behind Cloudflare by their own IP." }, { in: "2.1.0-rc.3", note: "An edit to /etc/nginx/global_settings pauses the maintenance check until clp-addons repair --rebaseline." }],
  targets: MAINTENANCE_TARGETS,
  // Nginx workers stat its flags and read its pages, without listing which sites have any.
  stateDirMode: 0o711,
  handler: handle,
  action: runMaintenanceAction,
  // A site deleted from CloudPanel leaves its state behind, and a site created
  // again under its name would otherwise come back serving the 503 page.
  panelBlock: {
    label: "Maintenance",
    reconcile: (enabled, quiet, accept) => {
      if (enabled) ensureMaintenanceData(addonStateDir("maintenance"));
      const result = reconcileNginxMaintenance({ enabled, accept });
      if (result.rebaselined) {
        log.ok(rebaselineNote(result.settingsPath, "its package", result.rebaselined.from, result.rebaselined.to));
      }
      if (result.state === "ok" || (!enabled && result.state === "missing")) {
        if (result.changed && !quiet) log.ok(enabled ? "Nginx maintenance check injected and verified" : "Nginx maintenance check removed and verified");
        return true;
      }
      log.err(`Nginx maintenance check: ${result.detail ?? result.state}`);
      return false;
    },
    inspect: () => {
      const status = inspectNginxMaintenance();
      if (status.state === "ok") return { ok: true, text: "Site Checks Injected & Verified ✓" };
      const refusal = status.refusal;
      return {
        ok: false,
        text: status.detail ?? "Needs repair",
        hold: refusal && {
          file: status.settingsPath, addons: ["Maintenance Mode"], reason: refusal.reason,
          package: refusal.package ?? "its package", recorded: refusal.recorded, installed: refusal.installed,
        },
      };
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

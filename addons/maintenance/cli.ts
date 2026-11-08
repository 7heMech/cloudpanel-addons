import { executeMaintenanceAction, type GlobalMaintenanceStatus, type MaintenanceStatus } from "./action";
import { errorMessage } from "../../lib/errors";
import { fatal, log } from "../../lib/log";

/** `clp-addons maintenance <domain> [on|off|status]`, for root while the addon is enabled. */
export async function cmdMaintenance(argv: string[]): Promise<void> {
  const [rawDomain, operation = "status", ...extra] = argv;
  if (!rawDomain || extra.length > 0 || !["on", "off", "status"].includes(operation)) {
    fatal("usage: clp-addons maintenance <domain> [on|off|status]");
  }
  const verb = operation === "on" ? "enable" : operation === "off" ? "disable" : "status";
  try {
    const result = await executeMaintenanceAction([verb, `--domain=${rawDomain}`]) as MaintenanceStatus;
    const global = await executeMaintenanceAction(["global-status"]) as GlobalMaintenanceStatus;
    if (operation === "status") {
      const state = result.uncovered ? "live, not covered" : result.enabled ? "maintenance (503)" : global.global ? "maintenance (503, global)" : "live";
      log.plain(`${result.domain}: ${state}`);
      log.plain(`Template: ${result.customTemplate ? "custom" : "default"}`);
      log.plain(`IP bypasses: ${result.bypasses.length ? result.bypasses.join(", ") : "none"}`);
      if (global.bypasses.length) log.plain(`Global IP bypasses: ${global.bypasses.join(", ")}`);
    } else {
      log.ok(`${result.domain}: maintenance mode ${result.enabled ? "enabled" : "disabled"}`);
      if (!result.enabled && global.global && !result.uncovered) log.warn("global maintenance is on, so the site still serves 503");
    }
    if (result.uncovered) log.warn(`Nginx does not run the maintenance check for ${result.domain} (${result.uncovered}), so visitors get the site whatever is set`);
  } catch (error) {
    fatal(errorMessage(error));
  }
}

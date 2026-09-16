import { handle } from "./app/index";
import { runMaintenanceAction } from "./action";
import { MAINTENANCE_TARGETS } from "./inject/targets";
import type { AddonDefinition } from "../../cli/addon-catalog";

export const MAINTENANCE_ADDON: AddonDefinition = {
  name: "maintenance",
  title: "Maintenance Mode",
  description: "Show a per-site maintenance page with instant toggles and IP bypasses.",
  targets: MAINTENANCE_TARGETS,
  handler: handle,
  action: runMaintenanceAction,
};

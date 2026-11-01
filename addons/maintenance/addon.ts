import { handle } from "./app/index";
import { pruneMaintenanceState, runMaintenanceAction } from "./action";
import { MAINTENANCE_TARGETS } from "./inject/targets";
import type { AddonDefinition } from "../../cli/addon-catalog";

export const MAINTENANCE_ADDON: AddonDefinition = {
  name: "maintenance",
  title: "Maintenance Mode",
  description: "Show a per-site maintenance page with instant toggles and IP bypasses.",
  preselected: true,
  targets: MAINTENANCE_TARGETS,
  handler: handle,
  action: runMaintenanceAction,
  // A site deleted from CloudPanel leaves its state behind, and a site created
  // again under its name would otherwise come back serving the 503 page.
  repair: {
    label: "maintenance state (prune)",
    run: async () => {
      const removed = pruneMaintenanceState();
      return removed.length ? `removed the state of ${removed.length} deleted site${removed.length === 1 ? "" : "s"}` : null;
    },
  },
};

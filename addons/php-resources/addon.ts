import { handle } from "./app/index";
import { executePhpResourcesAction, runPhpResourcesAction, type PhpResourcesActionOptions, type ReconcileResult } from "./action";
import { PHP_RESOURCES_TARGETS } from "./inject/targets";
import type { AddonDefinition } from "../../cli/addon-catalog";

export const PHP_RESOURCES_ADDON: AddonDefinition = {
  name: "php-resources",
  title: "PHP Resources",
  description: "Group PHP sites into categories of PHP-FPM limits, and pick the one new sites join.",
  targets: PHP_RESOURCES_TARGETS,
  handler: handle,
  action: runPhpResourcesAction,
  // Nothing else reaches a site created after the default category was chosen,
  // or a site whose pool file CloudPanel rewrote when its PHP version changed.
  // Repair is where both are noticed, which is every fifteen minutes.
  maintenance: {
    label: "php resources",
    run: async (options) => {
      const result = await executePhpResourcesAction(
        ["reconcile"],
        (options ?? {}) as PhpResourcesActionOptions,
      ) as ReconcileResult;
      if (!result.applied && !result.repaired) return null;
      return `${result.applied} new site${result.applied === 1 ? "" : "s"} categorised, ${result.repaired} restored`;
    },
  },
};

import { handle } from "./app/index";
import {
  DEFAULT_PHP_RESOURCES_ACTION_PATHS, executePhpResourcesAction, phpSiteUsers, runPhpResourcesAction,
  type PhpResourcesActionOptions, type ReconcileResult,
} from "./action";
import { PHP_RESOURCES_TARGETS } from "./inject/targets";
import { removeAbandonedTmpFiles } from "./tmp-cleanup";
import type { AddonDefinition } from "../../cli/addon-catalog";
import { log } from "../../cli/util";

function sizeText(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

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
      const actionOptions = (options ?? {}) as PhpResourcesActionOptions;
      // Before reconciling, so a site that keeps failing does not stop it.
      try {
        const users = phpSiteUsers({ ...DEFAULT_PHP_RESOURCES_ACTION_PATHS, ...actionOptions.paths });
        const { removed, bytes } = removeAbandonedTmpFiles(users);
        if (removed) log.ok(`php resources: ${removed} abandoned temp file${removed === 1 ? "" : "s"} removed from /tmp (${sizeText(bytes)})`);
      } catch (error) {
        log.warn(`php resources /tmp cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      const result = await executePhpResourcesAction(["reconcile"], actionOptions) as ReconcileResult;
      if (!result.applied && !result.repaired) return null;
      return `${result.applied} new site${result.applied === 1 ? "" : "s"} categorised, ${result.repaired} restored`;
    },
  },
};

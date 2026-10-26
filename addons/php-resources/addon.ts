import { existsSync } from "node:fs";
import { handle } from "./app/index";
import {
  DEFAULT_PHP_RESOURCES_ACTION_PATHS, executePhpResourcesAction, runPhpResourcesAction,
  type PhpResourcesActionOptions, type ReconcileResult,
} from "./action";
import { PHP_RESOURCES_TARGETS } from "./inject/targets";
import type { AddonDefinition } from "../../cli/addon-catalog";
import { clearAbandonedTmpFiles } from "../../cli/tmp-cleanup";
import { log } from "../../cli/util";

const count = (value: number, word: string) => `${value} ${word}${value === 1 ? "" : "s"}`;

export const PHP_RESOURCES_ADDON: AddonDefinition = {
  name: "php-resources",
  title: "PHP Resources",
  description: "Give groups of PHP sites the same PHP-FPM limits.",
  changed: { in: "2.0", note: "Sites first, and new sites get their limits within seconds." },
  targets: PHP_RESOURCES_TARGETS,
  handler: handle,
  action: runPhpResourcesAction,
  newSites: {
    label: "php resources",
    run: async (options) => {
      const result = await executePhpResourcesAction(["reconcile"], (options ?? {}) as PhpResourcesActionOptions) as ReconcileResult;
      return result.applied ? `${count(result.applied, "new site")} joined the default category` : null;
    },
  },
  // A site whose pool file CloudPanel rewrote when its PHP version changed, and
  // a new site whose pool file was not there yet, are noticed here.
  maintenance: {
    label: "php resources",
    run: async (options) => {
      const actionOptions = (options ?? {}) as PhpResourcesActionOptions;
      const paths = { ...DEFAULT_PHP_RESOURCES_ACTION_PATHS, ...actionOptions.paths };
      // System Tweaks clears /tmp; a box with this addon and not that one keeps the cleanup.
      if (!existsSync(paths.systemTweaksConfig)) {
        try {
          const cleared = clearAbandonedTmpFiles({ panelDb: paths.panelDb, ...actionOptions.tmpCleanup });
          if (cleared) log.ok(`php resources: ${cleared}`);
        } catch (error) {
          log.warn(`php resources /tmp cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const result = await executePhpResourcesAction(["reconcile"], actionOptions) as ReconcileResult;
      if (!result.applied && !result.repaired) return null;
      return `${result.applied} new site${result.applied === 1 ? "" : "s"} categorised, ${result.repaired} restored`;
    },
  },
};

import { restoreResourceMemory, withdrawResourceMemory } from "./memory-settings";
import { handle } from "./app/index";
import {
  DEFAULT_RESOURCE_LIMITS_ACTION_PATHS, executeResourceLimitsAction, runResourceLimitsAction,
  type ResourceLimitsActionOptions, type ReconcileResult,
} from "./action";
import { RESOURCE_LIMITS_TARGETS } from "./inject/targets";
import type { AddonDefinition } from "../../cli/addon-catalog";
import { existsSync } from "node:fs";
import { clearAbandonedTmpFiles } from "../../cli/tmp-cleanup";
import { errorMessage } from "../../cli/action-common";
import { log } from "../../cli/util";

const count = (value: number, word: string) => `${value} ${word}${value === 1 ? "" : "s"}`;

export const RESOURCE_LIMITS_ADDON: AddonDefinition = {
  name: "resource-limits",
  title: "Resource Limits",
  description: "PHP worker limits and a shared memory budget for PHP, MySQL and Redis.",
  changed: [
    { in: "2.0.1-rc.1", note: "PHP Resources is now Resource Limits. PHP categories are kept, and memory settings move here from System Tweaks." },
    { in: "2.0.1-rc.1", note: "When the server runs out of memory, the kernel now kills a site's PHP worker before MySQL or nginx. A new Memory card can also size MySQL and cap Redis to the server's RAM; both are off until you switch them on." },
  ],
  activate: () => { restoreResourceMemory(); },
  withdrawn: () => { withdrawResourceMemory(); },
  targets: RESOURCE_LIMITS_TARGETS,
  handler: handle,
  action: runResourceLimitsAction,
  newSites: {
    label: "resource limits",
    run: async (options) => {
      const actionOptions = (options ?? {}) as ResourceLimitsActionOptions;
      let memoryFailure = "";
      try { restoreResourceMemory(actionOptions, true); } catch (error) { memoryFailure = errorMessage(error); }
      const result = await executeResourceLimitsAction(["reconcile"], actionOptions) as ReconcileResult;
      if (memoryFailure) throw new Error(`memory limits: ${memoryFailure}`);
      return result.applied ? `${count(result.applied, "new site")} joined the default category` : null;
    },
  },
  // A site whose pool file CloudPanel rewrote when its PHP version changed, and
  // a new site whose pool file was not there yet, are noticed here.
  repair: {
    label: "resource limits",
    run: async (options) => {
      const actionOptions = (options ?? {}) as ResourceLimitsActionOptions;
      const paths = { ...DEFAULT_RESOURCE_LIMITS_ACTION_PATHS, ...actionOptions.paths };
      const failures: string[] = [];
      try { restoreResourceMemory(actionOptions, true); }
      catch (error) { failures.push(`memory limits: ${errorMessage(error)}`); }
      // System Tweaks clears /tmp; a box with this addon and not that one keeps the cleanup.
      if (!existsSync(paths.systemTweaksConfig)) {
        try {
          const cleared = clearAbandonedTmpFiles({ panelDb: paths.panelDb, ...actionOptions.tmpCleanup });
          if (cleared) log.ok(`resource limits: ${cleared}`);
        } catch (error) { log.warn(`resource limits /tmp cleanup failed: ${errorMessage(error)}`); }
      }
      const result = await executeResourceLimitsAction(["reconcile"], actionOptions) as ReconcileResult;
      if (failures.length) throw new Error(failures.join("; "));
      if (!result.applied && !result.repaired) return null;
      return `${result.applied} new site${result.applied === 1 ? "" : "s"} categorised, ${result.repaired} restored`;
    },
  },
};

import { resourceLimitsMemory, restoreResourceMemory, withdrawResourceMemory } from "./memory-settings";
import { handle } from "./app/index";
import {
  DEFAULT_RESOURCE_LIMITS_ACTION_PATHS, executeResourceLimitsAction, runResourceLimitsAction,
  type ResourceLimitsActionOptions, type ReconcileResult,
} from "./action";
import { RESOURCE_LIMITS_TARGETS } from "./inject/targets";
import type { AddonDefinition } from "../../lib/addon-definition";
import { existsSync } from "node:fs";
import { clearAbandonedTmpFiles } from "../../lib/tmp-cleanup";
import { errorMessage } from "../../lib/errors";
import { fatal, log } from "../../lib/log";

const count = (value: number, word: string) => `${value} ${word}${value === 1 ? "" : "s"}`;

export const RESOURCE_LIMITS_ADDON: AddonDefinition = {
  name: "resource-limits",
  title: "Resource Limits",
  description: "PHP worker limits and a shared memory budget for PHP, MySQL and Redis.",
  changed: [
    { in: "2.1.0-rc.5", note: "Pending MySQL sizes show Restart MySQL; any administrator can restart it for every site." },
    { in: "2.1.0-rc.1", note: "PHP Resources is now Resource Limits, with memory settings from System Tweaks." },
    { in: "2.1.0-rc.1", note: "Out of memory, the kernel kills PHP workers before MySQL or nginx. A Memory card can size MySQL and Redis; both start off." },
  ],
  activate: () => { restoreResourceMemory(); },
  withdrawn: () => { withdrawResourceMemory(); },
  targets: RESOURCE_LIMITS_TARGETS,
  handler: handle,
  action: runResourceLimitsAction,
  commands: {
    // MySQL's unit runs this before it starts and Redis's after; its failure does not stop either.
    "sync-memory": {
      root: true,
      run: (argv) => {
        if (argv.length !== 1 || (argv[0] !== "mysql" && argv[0] !== "redis")) fatal("sync-memory takes mysql or redis");
        resourceLimitsMemory(argv[0]);
      },
    },
  },
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

import { handle } from "./app/index";
import { runStagerAction } from "./action";
import { STAGER_TARGETS } from "./inject/targets";
import type { AddonDefinition } from "../../cli/addon-catalog";

export const STAGER_ADDON: AddonDefinition = {
  name: "stager",
  title: "Stager",
  description: "Create staging copies of WordPress, PHP, static, and Instatic sites.",
  targets: STAGER_TARGETS,
  handler: handle,
  action: runStagerAction,
  // Stale-job recovery, job-record expiry and orphaned-vhost recovery. None of
  // it ran on its own before: only an explicit CLI invocation reached prune, so
  // a clone killed by an OOM, a `systemctl stop` or a reboot left its target
  // stuck `running` for ever, and only prune clears that.
  maintenance: {
    label: "stager maintenance (prune)",
    run: async (options) => {
      const code = await runStagerAction(["prune"], { ...(options ?? {}), emitReply: false });
      if (code !== 0) throw new Error(`prune returned exit code ${code}`);
      return null;
    },
  },
};

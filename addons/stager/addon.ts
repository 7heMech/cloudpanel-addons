import { handle } from "./app/index";
import { runStagerAction } from "./action";
import { STAGER_TARGETS } from "./inject/targets";
import type { AddonDefinition } from "../../lib/addon-definition";

export const STAGER_ADDON: AddonDefinition = {
  name: "stager",
  title: "Stager",
  description: "Create staging copies of WordPress, PHP, static, and Instatic sites.",
  changed: [
    { in: "2.0.0-rc.1", note: "Staging copies no longer send mail." },
    { in: "2.2.0-rc.1", note: "A clone or promote copies only the files the source site's user can read." },
  ],
  targets: STAGER_TARGETS,
  handler: handle,
  action: runStagerAction,
  // A clone killed by an OOM, a `systemctl stop` or a reboot leaves its target
  // stuck `running` for ever, and only prune clears that.
  repair: {
    label: "stager (prune)",
    run: async (options) => {
      const code = await runStagerAction(["prune"], { ...(options ?? {}), emitReply: false });
      if (code !== 0) throw new Error(`prune returned exit code ${code}`);
      return null;
    },
  },
};

import { handle } from "./app/index";
import { runGitAction } from "./action";
import { GIT_TARGETS } from "./inject/targets";
import type { AddonDefinition } from "../../cli/addon-catalog";

export const GIT_ADDON: AddonDefinition = {
  name: "git",
  title: "Git Deploy",
  description: "Deploy a site from a Git remote and run a command afterwards.",
  targets: GIT_TARGETS,
  handler: handle,
  action: runGitAction,
  // Deploying is site work, and a site manager manages every site CloudPanel
  // has. Everything this addon does runs as the site's own user, so it hands
  // that role no authority the panel has not already given it.
  siteManager: true,
  // Job-record expiry and stale-job recovery. A deployment killed by a reboot
  // or an OOM leaves its record `running` for ever otherwise, and only this
  // clears it.
  maintenance: {
    label: "git maintenance (prune)",
    run: async (options) => {
      const code = await runGitAction(["prune"], { ...(options ?? {}), emitReply: false });
      if (code !== 0) throw new Error(`prune returned exit code ${code}`);
      return null;
    },
  },
};

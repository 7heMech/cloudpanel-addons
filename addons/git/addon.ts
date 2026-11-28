import { handle } from "./app/index";
import { GIT_HOOK_PREFIX, handleGitHook } from "./app/hook";
import { runGitAction } from "./action";
import { GIT_TARGETS } from "./inject/targets";
import type { AddonDefinition } from "../../lib/addon-definition";

export const GIT_ADDON: AddonDefinition = {
  name: "git",
  title: "Git Deploy",
  description: "Deploy a site from a Git remote and run a command afterwards.",
  changed: [
    { in: "2.2.0-rc.3", note: "The push-to-deploy URL now works when the panel has basic auth: basic auth no longer applies to that one route, whose token is its credential. The rest of the addon pages keep basic auth." },
  ],
  targets: GIT_TARGETS,
  handler: handle,
  action: runGitAction,
  // Deploying is site work, and a site manager manages every site CloudPanel
  // has. Everything this addon does runs as the site's own user, so it hands
  // that role no authority the panel has not already given it.
  siteManager: true,
  // Push-to-deploy: the token in the URL is the credential, and only root can read it.
  preGate: { prefix: GIT_HOOK_PREFIX, handle: handleGitHook },
  // Job-record expiry and stale-job recovery. A deployment killed by a reboot
  // or an OOM leaves its record `running` for ever otherwise, and only this
  // clears it.
  repair: {
    label: "git (prune)",
    run: async (options) => {
      const code = await runGitAction(["prune"], { ...(options ?? {}), emitReply: false });
      if (code !== 0) throw new Error(`prune returned exit code ${code}`);
      return null;
    },
  },
};

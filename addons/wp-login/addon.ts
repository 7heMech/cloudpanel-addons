import { handle } from "./app/index";
import { reconcileWpVarnish, reconcileWpMainwp, runWpLoginAction } from "./action";
import { WP_LOGIN_TARGETS } from "./inject/targets";
import type { AddonDefinition } from "../../cli/addon-catalog";

export const WP_LOGIN_ADDON: AddonDefinition = {
  name: "wp-login",
  title: "WordPress Tools",
  description: "One-click WordPress sign-in and optional automatic installation of CLP Varnish Cache and MainWP Child on eligible sites.",
  targets: WP_LOGIN_TARGETS,
  handler: handle,
  action: runWpLoginAction,
  maintenance: {
    label: "WordPress plugins",
    run: async () => {
      const passes = [
        async () => {
          const result = await reconcileWpVarnish({}, { dueOnly: true });
          return { changed: result.installed, failed: result.failed };
        },
        async () => {
          const result = await reconcileWpMainwp();
          return { changed: result.connected + result.removed, failed: result.failed };
        },
      ];
      const failed: string[] = [];
      let changed = 0;
      for (const pass of passes) {
        try {
          const result = await pass();
          changed += result.changed;
          failed.push(...result.failed);
        } catch (error) { failed.push(error instanceof Error ? error.message : String(error)); }
      }
      if (failed.length) throw new Error(failed.join("; "));
      return changed ? `${changed} WordPress plugin changes completed` : null;
    },
  },
};

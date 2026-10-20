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
    // Each policy's failure is reported without stopping the other.
    run: async () => {
      const failed: string[] = [];
      const done: string[] = [];
      try {
        const varnish = await reconcileWpVarnish({}, { dueOnly: true });
        failed.push(...varnish.failed);
        if (varnish.installed) done.push(`${varnish.installed} CLP Varnish Cache installed`);
      } catch (error) {
        failed.push(error instanceof Error ? error.message : String(error));
      }
      try {
        const mainwp = await reconcileWpMainwp();
        failed.push(...mainwp.failed);
        if (mainwp.connected) done.push(`${mainwp.connected} connected to MainWP`);
        if (mainwp.removed) done.push(`${mainwp.removed} cleaned up from MainWP`);
      } catch (error) {
        failed.push(error instanceof Error ? error.message : String(error));
      }
      if (failed.length) throw new Error([...done, ...failed].join("; "));
      return done.length ? done.join("; ") : null;
    },
  },
};

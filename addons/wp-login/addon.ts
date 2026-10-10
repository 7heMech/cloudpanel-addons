import { handle } from "./app/index";
import { reconcileWpVarnish, runWpLoginAction } from "./action";
import { WP_LOGIN_TARGETS } from "./inject/targets";
import type { AddonDefinition } from "../../cli/addon-catalog";

export const WP_LOGIN_ADDON: AddonDefinition = {
  name: "wp-login",
  title: "WordPress Tools",
  description: "One-click WordPress sign-in and optional automatic installation of CLP Varnish Cache on eligible sites.",
  targets: WP_LOGIN_TARGETS,
  handler: handle,
  action: runWpLoginAction,
  maintenance: {
    label: "WordPress Varnish",
    run: async () => {
      const result = await reconcileWpVarnish();
      if (result.failed.length) throw new Error(result.failed.join("; "));
      return result.installed ? `${result.installed} plugin installation${result.installed === 1 ? "" : "s"} activated` : null;
    },
  },
};

import { handle } from "./app/index";
import { runWpLoginAction, wpPoliciesActive, type WpLoginActionOptions } from "./action";
import { queueAddonPass } from "../../cli/job-store";
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
    run: (options) => {
      if (!wpPoliciesActive((options ?? {}) as WpLoginActionOptions)) return null;
      return queueAddonPass({ addon: "wp-login", verb: "sync", description: "WordPress plugin policies", runtime: 180 })
        ? "plugin policy pass queued" : null;
    },
  },
};

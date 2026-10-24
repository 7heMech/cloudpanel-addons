import { handle } from "./app/index";
import { runWpToolsAction, wpPoliciesActive, type WpToolsActionOptions } from "./action";
import { queueAddonPass } from "../../cli/job-store";
import { WP_TOOLS_TARGETS } from "./inject/targets";
import type { AddonDefinition } from "../../cli/addon-catalog";

export const WP_TOOLS_ADDON: AddonDefinition = {
  name: "wp-tools",
  title: "WordPress Tools",
  description: "One-click WordPress sign-in and optional automatic installation of CLP Varnish Cache and MainWP Child on eligible sites.",
  targets: WP_TOOLS_TARGETS,
  handler: handle,
  action: runWpToolsAction,
  maintenance: {
    label: "WordPress plugins",
    run: (options) => {
      if (!wpPoliciesActive((options ?? {}) as WpToolsActionOptions)) return null;
      return queueAddonPass({ addon: "wp-tools", verb: "sync", description: "WordPress plugin policies", runtime: 180 })
        ? "plugin policy pass queued" : null;
    },
  },
};

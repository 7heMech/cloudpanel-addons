import { handle } from "./app/index";
import { pruneWpJobs, runWpToolsAction, wpPoliciesActive, type WpToolsActionOptions } from "./action";
import { queueAddonPass } from "../../cli/job-store";
import { WP_TOOLS_TARGETS } from "./inject/targets";
import type { AddonDefinition } from "../../cli/addon-catalog";

export const WP_TOOLS_ADDON: AddonDefinition = {
  name: "wp-tools",
  title: "WordPress Tools",
  description: "One-click WordPress sign-in and optional automatic installation of CLP Varnish Cache and MainWP Child on eligible sites.",
  changed: { in: "2.0.0-rc.1", note: "Renamed from WordPress Sign-In; installs CLP Varnish Cache and MainWP Child for you." },
  targets: WP_TOOLS_TARGETS,
  handler: handle,
  action: runWpToolsAction,
  maintenance: {
    label: "WordPress plugins",
    run: (options) => {
      // Job records expire, and one whose runner died is marked failed, so the page stops following it.
      pruneWpJobs((options ?? {}) as WpToolsActionOptions);
      if (!wpPoliciesActive((options ?? {}) as WpToolsActionOptions)) return null;
      return queueAddonPass({ addon: "wp-tools", verb: "sync", description: "WordPress plugin policies", runtime: 180 })
        ? "plugin policy pass queued" : null;
    },
  },
};

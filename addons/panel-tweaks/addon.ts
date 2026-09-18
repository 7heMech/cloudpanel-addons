import { handle } from "./app/index";
import { runPanelTweaksAction, scanDiskUsage, type PanelTweaksActionOptions } from "./action";
import { PANEL_TWEAKS_TARGETS } from "./inject/targets";
import type { AddonDefinition } from "../../cli/addon-catalog";

export const PANEL_TWEAKS_ADDON: AddonDefinition = {
  name: "panel-tweaks",
  title: "Panel UI tweaks",
  description: "Small additions to CloudPanel's own pages: a site count, search and sorting, SSL, runtime and size columns, a sites table and a header that read on a phone, row actions in a menu, and a device theme on the login page.",
  targets: PANEL_TWEAKS_TARGETS,
  handler: handle,
  action: runPanelTweaksAction,
  // Measured site sizes ride the fifteen-minute repair timer rather than a
  // timer of their own. It already runs as root on the interval this wants, and
  // a second unit would buy nothing but another thing to install, arm and
  // repair. The sweep returns nothing at all while the tweak is switched off,
  // so an operator who never asked for sizes never pays for them.
  maintenance: {
    label: "panel tweaks",
    run: (options) => scanDiskUsage((options ?? {}) as PanelTweaksActionOptions),
  },
};

import { handle } from "./app/index";
import { panelTweaksUpkeep, runPanelTweaksAction, type PanelTweaksActionOptions } from "./action";
import { restorePanelPhp, withdrawPanelPhp } from "./panel-php";
import { PANEL_TWEAKS_TARGETS } from "./inject/targets";
import type { AddonDefinition } from "../../cli/addon-catalog";

export const PANEL_TWEAKS_ADDON: AddonDefinition = {
  name: "panel-tweaks",
  title: "Panel Tweaks",
  description: "Site search and columns, automatic SSL for native sites, mobile layouts, theme improvements, and a newer PHP for CloudPanel itself.",
  preselected: true,
  targets: PANEL_TWEAKS_TARGETS,
  handler: handle,
  action: runPanelTweaksAction,
  // Measured site sizes and the panel's PHP ride the fifteen-minute repair
  // timer rather than timers of their own. The hook uses the stored measurement
  // time to do the expensive sweep about every six hours, and returns nothing
  // for a tweak that is off.
  maintenance: {
    label: "panel tweaks",
    run: (options) => panelTweaksUpkeep((options ?? {}) as PanelTweaksActionOptions),
  },
  deactivate: () => withdrawPanelPhp(),
  activate: () => restorePanelPhp(),
};

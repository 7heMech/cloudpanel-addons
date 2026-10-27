import { handle } from "./app/index";
import { panelTweaksUpkeep, runPanelTweaksAction, type PanelTweaksActionOptions } from "./action";
import { PANEL_TWEAKS_TARGETS } from "./inject/targets";
import type { AddonDefinition } from "../../cli/addon-catalog";

export const PANEL_TWEAKS_ADDON: AddonDefinition = {
  name: "panel-tweaks",
  title: "Panel Tweaks",
  description: "Site search, columns and CSV download, automatic SSL for native sites, mobile layouts and theme improvements.",
  changed: { in: "2.0.0-rc.1", note: "Site switches first; the panel PHP version moved to System Tweaks." },
  preselected: true,
  targets: PANEL_TWEAKS_TARGETS,
  handler: handle,
  action: runPanelTweaksAction,
  // Measured site sizes ride the fifteen-minute repair timer rather than a
  // timer of their own. The hook uses the stored measurement
  // time to do the expensive sweep about every six hours, and returns nothing
  // for a tweak that is off.
  maintenance: {
    label: "panel tweaks",
    run: (options) => panelTweaksUpkeep((options ?? {}) as PanelTweaksActionOptions),
  },
};

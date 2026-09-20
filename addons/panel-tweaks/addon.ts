import { handle } from "./app/index";
import { runPanelTweaksAction, scanDiskUsage, type PanelTweaksActionOptions } from "./action";
import { PANEL_TWEAKS_TARGETS } from "./inject/targets";
import type { AddonDefinition } from "../../cli/addon-catalog";

export const PANEL_TWEAKS_ADDON: AddonDefinition = {
  name: "panel-tweaks",
  title: "Panel Tweaks",
  description: "Site search and columns, mobile layouts, and theme improvements for CloudPanel.",
  targets: PANEL_TWEAKS_TARGETS,
  handler: handle,
  action: runPanelTweaksAction,
  // Measured site sizes ride the fifteen-minute repair timer rather than a
  // timer of their own. The hook uses the stored measurement time to do the
  // expensive sweep about every six hours. It returns nothing while the tweak
  // is off, so an operator who never asked for sizes never pays for them.
  maintenance: {
    label: "panel tweaks",
    run: (options) => scanDiskUsage((options ?? {}) as PanelTweaksActionOptions),
  },
};

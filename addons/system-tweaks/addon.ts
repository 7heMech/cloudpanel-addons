import { handle } from "./app/index";
import { restoreSystemTweaks, runSystemTweaksAction, systemTweaksMaintenance, withdrawSystemTweaks } from "./action";
import type { AddonDefinition } from "../../cli/addon-catalog";

export const SYSTEM_TWEAKS_ADDON: AddonDefinition = {
  name: "system-tweaks",
  title: "System Tweaks",
  description: "Automatic security updates, the PHP upload-progress mitigation, a newer PHP for CloudPanel itself, forged visitor-IP blocking and /tmp cleanup.",
  added: "2.0.0-rc.1",
  preselected: true,
  targets: [],
  handler: handle,
  action: runSystemTweaksAction,
  repair: {
    label: "system tweaks",
    run: () => systemTweaksMaintenance(),
  },
  deactivate: () => withdrawSystemTweaks(),
  activate: () => restoreSystemTweaks(),
};

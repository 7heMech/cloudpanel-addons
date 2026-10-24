import { handle } from "./app/index";
import { restoreSystemTweaks, runSystemTweaksAction, systemTweaksUpkeep, withdrawSystemTweaks } from "./action";
import type { AddonDefinition } from "../../cli/addon-catalog";

export const SYSTEM_TWEAKS_ADDON: AddonDefinition = {
  name: "system-tweaks",
  title: "System Tweaks",
  description: "Automatic security updates and the PHP upload-progress mitigation.",
  targets: [],
  handler: handle,
  action: runSystemTweaksAction,
  maintenance: {
    label: "system tweaks",
    run: () => systemTweaksUpkeep(),
  },
  deactivate: () => withdrawSystemTweaks(),
  activate: () => restoreSystemTweaks(),
};

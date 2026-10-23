import { handle } from "./app/index";
import { restoreGuardAfterWithdrawal, restoreSystemTweaks, runSystemTweaksAction, systemTweaksUpkeep, withdrawSystemTweaks } from "./action";
import type { AddonDefinition } from "../../cli/addon-catalog";

export const SYSTEM_TWEAKS_ADDON: AddonDefinition = {
  name: "system-tweaks",
  title: "System Tweaks",
  description: "Automatic security updates for the system and CloudPanel's PHP, and the PHP upload-progress mitigation.",
  targets: [],
  handler: handle,
  action: runSystemTweaksAction,
  maintenance: {
    label: "system tweaks",
    run: () => systemTweaksUpkeep(),
  },
  deactivate: () => withdrawSystemTweaks(),
  withdrawn: () => restoreGuardAfterWithdrawal(),
  activate: () => restoreSystemTweaks(),
};

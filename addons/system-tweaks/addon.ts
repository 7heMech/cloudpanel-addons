import { handle } from "./app/index";
import {
  restoreSystemTweaks, runSystemTweaksAction, systemTweaksFirewall, systemTweaksMaintenance, systemTweaksVarnish, withdrawSystemTweaks,
} from "./action";
import { SYSTEM_TWEAKS_TARGETS } from "./inject/targets";
import type { AddonDefinition } from "../../cli/addon-catalog";

export const SYSTEM_TWEAKS_ADDON: AddonDefinition = {
  name: "system-tweaks",
  title: "System Tweaks",
  description: "Automatic security updates, the PHP upload-progress mitigation, a newer PHP for CloudPanel itself, forged visitor-IP blocking, nginx config injection blocking, phpMyAdmin lockdown, a File Manager kept in each site's home, /tmp cleanup and UDP firewall rules.",
  added: "2.0.0-rc.1",
  changed: { in: "2.0.0", note: "Open UDP ports from CloudPanel's own Firewall page." },
  preselected: true,
  targets: SYSTEM_TWEAKS_TARGETS,
  handler: handle,
  action: runSystemTweaksAction,
  repair: {
    label: "system tweaks",
    run: () => systemTweaksMaintenance(),
  },
  newSites: {
    label: "system tweaks Varnish backends",
    run: () => systemTweaksVarnish(),
  },
  firewall: {
    label: "system tweaks firewall",
    run: () => systemTweaksFirewall(),
  },
  deactivate: () => withdrawSystemTweaks(),
  activate: () => restoreSystemTweaks(),
};

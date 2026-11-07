import { handle } from "./app/index";
import {
  restoreSystemTweaks, runSystemTweaksAction, systemTweaksFirewall, systemTweaksMaintenance, systemTweaksVarnish, withdrawSystemTweaks,
} from "./action";
import { SYSTEM_TWEAKS_TARGETS } from "./inject/targets";
import type { AddonDefinition } from "../../cli/addon-catalog";

export const SYSTEM_TWEAKS_ADDON: AddonDefinition = {
  name: "system-tweaks",
  title: "System Tweaks",
  description: "Server security, automatic updates, panel PHP, remote backup compression and memory limits.",
  added: "2.0.0-rc.1",
  changed: [
    { in: "2.0.1-rc.1", note: "CloudPanel's clp-agent is cut off from the network, so it no longer sends CloudPanel your sites' domains and panel users' names and emails. Switch it off under Settings." },
    { in: "2.0.1-rc.1", note: "When the server runs out of memory, the kernel now kills a site's PHP worker before MySQL or nginx. A new Memory card can also size MySQL and cap Redis to the server's RAM; both are off until you switch them on." },
    { in: "2.0.0", note: "Several CloudPanel security weaknesses are now mitigated; the panel's shared certificate is replaced, so your browser asks you to accept the new one once." },
  ],
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

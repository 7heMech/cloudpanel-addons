import { handle } from "./app/index";
import {
  restoreSystemTweaks, runSystemTweaksAction, systemTweaksFirewall, systemTweaksMaintenance, systemTweaksVarnish, withdrawSystemTweaks,
} from "./action";
import { SYSTEM_TWEAKS_TARGETS } from "./inject/targets";
import type { AddonDefinition } from "../../cli/addon-catalog";

export const SYSTEM_TWEAKS_ADDON: AddonDefinition = {
  name: "system-tweaks",
  title: "System Tweaks",
  description: "Server security, automatic updates, panel PHP, remote backup compression, SSH login message.",
  added: "2.0.0-rc.1",
  changed: [
    { in: "2.1.0-rc.3", note: "While root has locked System Tweaks, the panel can switch protections on but not off, enable the addon, and move the panel's PHP only to a newer version. Lock settings, at the top of the page, turns every protection on and locks. New installs start locked; updates never lock an existing box." },
    { in: "2.1.0-rc.2", note: "SSH logins show the server's uptime, load, memory, disk, addresses and pending updates in place of CloudPanel's banner. Switch it off under SSH login." },
    { in: "2.1.0-rc.1", note: "Settings is now Hardening and includes MySQL on this server only." },
    { in: "2.1.0-rc.1", note: "CloudPanel's clp-agent is cut off from the network, so it no longer sends CloudPanel your sites' domains and panel users' names and emails. Switch it off under Hardening." },
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

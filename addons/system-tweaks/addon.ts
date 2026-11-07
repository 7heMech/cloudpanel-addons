import { handle } from "./app/index";
import {
  restoreSystemTweaks, runSystemTweaksAction, systemTweaksPhpPools, systemTweaksBackupCompression, systemTweaksFirewall, systemTweaksMaintenance,
  systemTweaksMotd, systemTweaksPhpMyAdmin, systemTweaksVarnish, withdrawSystemTweaks,
} from "./action";
import { SYSTEM_TWEAKS_TARGETS } from "./inject/targets";
import { DEFAULT_REAL_IP_PATHS, REAL_IP_MARKER, releaseRealIp } from "./real-ip";
import { syncVarnishBackends } from "./varnish-backend";
import { fatal, log } from "../../lib/log";
import type { AddonDefinition } from "../../lib/addon-definition";

export const SYSTEM_TWEAKS_ADDON: AddonDefinition = {
  name: "system-tweaks",
  title: "System Tweaks",
  description: "Server security, automatic updates, panel PHP, remote backup compression, SSH login message.",
  added: "2.0.0-rc.1",
  changed: [
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
  // CloudPanel rewrites its phpMyAdmin vhost, replaces its app tree on an
  // update, and an upgrade empties /etc/update-motd.d and puts its banner back.
  anchors: [
    { label: "phpMyAdmin rules", run: () => systemTweaksPhpMyAdmin() },
    { label: "remote backup compression", run: () => systemTweaksBackupCompression() },
    { label: "SSH login message", run: () => systemTweaksMotd() },
  ],
  commands: {
    // nginx's unit runs this before it loads the vhosts; its failure does not stop the reload.
    "sync-varnish": {
      root: true,
      run: (argv) => {
        if (argv.length) fatal("sync-varnish takes no arguments");
        const refused = syncVarnishBackends();
        if (refused.length) log.warn(`Varnish server refused, so these sites skip Varnish: ${refused.join(", ")}`);
      },
    },
    // Every PHP-FPM unit runs this before it starts, and before and after it reloads; its failure does not stop PHP-FPM.
    "sync-php-pools": {
      root: true,
      run: (argv) => {
        if (argv.length > 1 || (argv.length === 1 && argv[0] !== "--before-reload")) fatal("sync-php-pools takes only --before-reload");
        systemTweaksPhpPools({}, argv[0] === "--before-reload");
      },
    },
  },
  conffiles: [{ path: DEFAULT_REAL_IP_PATHS.nginxConf, marker: REAL_IP_MARKER, release: () => releaseRealIp() }],
  deactivate: () => withdrawSystemTweaks(),
  activate: () => restoreSystemTweaks(),
};

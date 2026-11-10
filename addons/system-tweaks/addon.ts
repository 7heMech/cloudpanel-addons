import { handle } from "./app/index";
import {
  restoreSystemTweaks, runSystemTweaksAction, systemTweaksPhpPools, systemTweaksBackupCompression, systemTweaksMaintenance,
  systemTweaksMotd, systemTweaksPhpGuardOff, systemTweaksPhpMyAdmin, systemTweaksVarnish, withdrawSystemTweaks,
} from "./action";
import { DEFAULT_REAL_IP_PATHS, REAL_IP_MARKER, releaseRealIp } from "./real-ip";
import { syncVarnishBackends } from "./varnish-backend";
import { DEFAULT_VISITOR_IP_PATHS, UNTRUSTED_LOOPBACK, VISITOR_IP, releaseVisitorIp } from "./visitor-ip";
import { fatal, log } from "../../lib/log";
import type { AddonDefinition } from "../../lib/addon-definition";
import { SYSTEM_TWEAKS_SETUP } from "./setup";

export const SYSTEM_TWEAKS_ADDON: AddonDefinition = {
  name: "system-tweaks",
  title: "System Tweaks",
  description: "Server security, automatic updates, panel PHP, remote backup compression, SSH login message.",
  added: "2.0.0-rc.1",
  changed: [
    { in: "2.1.0-rc.4", note: "Lock settings moved into the Hardening card." },
    { in: "2.1.0-rc.4", note: "Sites behind Cloudflare see the visitor's IP; move a vhost's port 8080 IP rules to its first server." },
    { in: "2.1.0-rc.3", note: "Lock settings turns every protection on, and only root can unlock. New installs start locked; updates don't." },
    { in: "2.1.0-rc.2", note: "SSH logins show a server summary instead of CloudPanel's banner." },
    { in: "2.1.0-rc.1", note: "Settings is now Hardening, and adds MySQL on this server only, off by default." },
    { in: "2.1.0-rc.1", note: "clp-agent no longer sends CloudPanel your domains and panel users." },
    { in: "2.0.0", note: "Mitigates several CloudPanel weaknesses; accept the panel's new certificate once." },
  ],
  targets: [],
  setup: SYSTEM_TWEAKS_SETUP,
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
  conffiles: [
    { path: DEFAULT_REAL_IP_PATHS.nginxConf, marker: REAL_IP_MARKER, release: () => releaseRealIp() },
    { path: DEFAULT_VISITOR_IP_PATHS.nginxConf, marker: [VISITOR_IP, UNTRUSTED_LOOPBACK], release: () => releaseVisitorIp("nginxConf") },
    { path: DEFAULT_VISITOR_IP_PATHS.fastcgiParams, marker: VISITOR_IP, release: () => releaseVisitorIp("fastcgiParams") },
  ],
  phpGuardOff: () => systemTweaksPhpGuardOff(),
  deactivate: () => withdrawSystemTweaks(),
  activate: (wasEnabled) => restoreSystemTweaks({}, wasEnabled),
};

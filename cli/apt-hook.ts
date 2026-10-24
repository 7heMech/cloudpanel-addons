// `clp-addons apt-hook pre|post`, which systemd runs around unattended-upgrades'
// daily run; see conffiles.ts.
import { DEFAULT_REAL_IP_PATHS, REAL_IP_MARKER, releaseRealIp } from "../addons/system-tweaks/real-ip";
import { endConffileRelease, releaseConffiles } from "./conffiles";
import { releaseMaintenanceSettings } from "./inject";
import { NGINX_GLOBAL_SETTINGS } from "./paths";
import { cmdRepair } from "./repair";
import { fatal, log, requireRoot } from "./util";

export async function cmdAptHook(argv: string[]): Promise<void> {
  requireRoot("apt-hook");
  const [phase, ...extra] = argv;
  if (extra.length > 0 || (phase !== "pre" && phase !== "post")) fatal("usage: clp-addons apt-hook pre|post");
  if (phase === "pre") {
    const released = releaseConffiles([
      { path: NGINX_GLOBAL_SETTINGS, marker: "# clp-addons:maintenance:start", release: () => releaseMaintenanceSettings() },
      { path: DEFAULT_REAL_IP_PATHS.nginxConf, marker: REAL_IP_MARKER, release: () => releaseRealIp() },
    ]);
    if (released.length) log.ok(`package text restored for the upgrade: ${released.join(", ")}`);
    return;
  }
  if (endConffileRelease()) await cmdRepair(["--quiet"]);
}

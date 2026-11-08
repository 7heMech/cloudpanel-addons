// `clp-addons apt-hook pre|post`, which systemd runs around unattended-upgrades'
// daily run; see conffiles.ts.
import { ADDONS } from "../addons/catalog";
import { endConffileRelease, releaseConffiles } from "./conffiles";
import { cmdRepair } from "./repair";
import { fatal, log, requireRoot } from "../lib/log";

export async function cmdAptHook(argv: string[]): Promise<void> {
  requireRoot("apt-hook");
  const [phase, ...extra] = argv;
  if (extra.length > 0 || (phase !== "pre" && phase !== "post")) fatal("usage: clp-addons apt-hook pre|post");
  if (phase === "pre") {
    const released = releaseConffiles(Object.values(ADDONS).flatMap((spec) => spec.conffiles ?? []));
    if (released.length) log.ok(`package text restored for the upgrade: ${released.join(", ")}`);
    return;
  }
  if (endConffileRelease()) await cmdRepair(["--quiet"]);
}

// `clp-addons install`.

import { dashboardUrl, installedAddons, resolveAddon } from "./addons";
import { artifactNames, installArtifacts } from "./artifacts";
import { bootstrapProvision, applyEnable } from "./toggle";
import { ADDONS, ADDON_NAMES, type AddonSpec } from "./addon-catalog";
import { pickAddons } from "./menu";
import { withOperationLock } from "./operation-lock";
import { ensureDirs, ensureRequiredUnits, ensureServiceUser } from "./provision";
import { CLI_VERSION, loadLocal } from "./release";
import { fatal, log, parseFlags, requireRoot } from "./util";

/**
 * Enables bundled code. `--local` is install.sh handing over the binary it has
 * just installed, so its artifacts are recorded before provisioning. With no
 * addon named, a terminal is asked which ones. Changing version is `update`.
 */
export async function cmdInstall(argv: string[]): Promise<void> {
  requireRoot("install");
  const { positional, flags } = parseFlags(argv);
  const unknown = Object.keys(flags).find((flag) => flag !== "local");
  if (unknown) fatal(`install does not take --${unknown}${unknown === "version" ? "; change version with clp-addons update --version" : ""}`);
  if (flags.local === true) fatal("--local requires a value");
  const names = positional.length > 0 ? positional : await askAddons();
  const [first, ...rest] = [...new Set(names)].map(resolveAddon);
  return withOperationLock(`install ${names.join(", ")}`, async () => {
    if (typeof flags.local === "string") applyLocal(first!, flags.local);
    else await applyEnable(first!.name);
    for (const spec of rest) await applyEnable(spec.name);
    log.plain();
    log.plain(`Dashboard URL: ${dashboardUrl()}`);
  });
}

async function askAddons(): Promise<string[]> {
  const preselected = ADDON_NAMES.filter((name) => ADDONS[name]!.preselected);
  if (!process.stdin.isTTY || !process.stdout.isTTY || process.env.TERM === "dumb") {
    fatal(`name the addons to install, for example: clp-addons install ${preselected.join(" ")}`);
  }
  const picked = await pickAddons();
  if (!picked) fatal("installation cancelled");
  return picked;
}

function applyLocal(spec: AddonSpec, dir: string): void {
  ensureRequiredUnits(spec);
  const specs = [...installedAddons().filter((item) => item.name !== spec.name), spec];
  const artifacts = loadLocal(dir, artifactNames());
  ensureServiceUser();
  ensureDirs(specs, true);
  installArtifacts(artifacts, CLI_VERSION.replace(/^v/, ""));
  bootstrapProvision(specs);
  spec.activate?.();
  log.ok(`${spec.name} installed`);
}

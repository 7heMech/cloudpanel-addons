import { dashboardUrl, migrateOldAddonNames, resolveAddon } from "./addons";
import { enabledAddons } from "../addons/catalog";
import { artifactNames, installArtifacts, installedTag } from "./artifacts";
import { bootstrapProvision, applyEnable } from "./toggle";
import { type AddonSpec } from "../lib/addon-definition";
import { recordNewsSince } from "../manager/action";
import { withOperationLock } from "./operation-lock";
import { ensureDirs, ensureRequiredUnits, ensureServiceUser } from "./provision";
import { CLI_VERSION } from "../lib/version";
import { loadLocal } from "./release";
import { fatal, log, requireRoot } from "../lib/log";
import { parseFlags } from "./flags";

/**
 * What install.sh runs: `--local` hands over the binary it has just installed,
 * so its artifacts are recorded before provisioning, with or without addons.
 * Changing version is `update`.
 */
export async function cmdInstall(argv: string[]): Promise<void> {
  requireRoot("install");
  const { positional, flags } = parseFlags(argv);
  const unknown = Object.keys(flags).find((flag) => flag !== "local");
  if (unknown) fatal(`install does not take --${unknown}${unknown === "version" ? "; change version with clp-addons update --version" : ""}`);
  const local = flags.local;
  if (typeof local !== "string") fatal("install is what install.sh runs; turn addons on with clp-addons enable <addon>");
  const specs = [...new Set(positional)].map(resolveAddon);
  return withOperationLock(`install ${positional.join(", ") || "clp-addons"}`, async () => {
    // Re-running the installer on an older box must not leave a renamed addon behind until repair.
    migrateOldAddonNames();
    applyLocal(specs.shift(), local);
    for (const spec of specs) await applyEnable(spec.name);
    log.plain();
    if (!enabledAddons().some((spec) => spec.name === "system-tweaks")) {
      log.plain("System Tweaks is recommended: it applies the security fixes. Enable it on the Addons page or with: clp-addons enable system-tweaks");
    }
    log.plain(`Dashboard URL: ${dashboardUrl()}`);
  });
}

function applyLocal(spec: AddonSpec | undefined, dir: string): void {
  if (spec) ensureRequiredUnits(spec);
  const specs = [...enabledAddons().filter((item) => item.name !== spec?.name), ...(spec ? [spec] : [])];
  const artifacts = loadLocal(dir, artifactNames());
  ensureServiceUser();
  ensureDirs(specs, true);
  recordNewsSince(installedTag());
  installArtifacts(artifacts, CLI_VERSION.replace(/^v/, ""));
  bootstrapProvision(specs);
  if (!spec) return log.ok("clp-addons installed");
  spec.activate?.();
  log.ok(`${spec.name} installed`);
}

// `clp-addons install`.

import { dashboardUrl, installedAddons, migrateOldAddonNames, resolveAddon } from "./addons";
import { artifactNames, installArtifacts, installedTag } from "./artifacts";
import { bootstrapProvision, applyEnable } from "./toggle";
import { type AddonSpec } from "./addon-catalog";
import { recordNewsSince } from "./manager-action";
import { withOperationLock } from "./operation-lock";
import { ensureDirs, ensureRequiredUnits, ensureServiceUser } from "./provision";
import { CLI_VERSION, loadLocal } from "./release";
import { fatal, log, parseFlags, requireRoot } from "./util";
import { ActionFailure } from "./action-common";
import { changeLock, lockFileProblem, type LockFiles } from "./lock-addon";

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
    // Read before anything is installed, so a re-run of the installer is not mistaken for a first one.
    const previous = installedTag();
    // Re-running the installer on an older box must not leave a renamed addon behind until repair.
    migrateOldAddonNames();
    lockNewInstall(previous);
    applyLocal(specs.shift(), local);
    for (const spec of specs) await applyEnable(spec.name);
    log.plain();
    if (!installedAddons().some((spec) => spec.name === "system-tweaks")) {
      log.plain("System Tweaks is recommended: it applies the security fixes. Enable it on the Addons page or with: clp-addons enable system-tweaks");
    }
    log.plain(`Dashboard URL: ${dashboardUrl()}`);
  });
}

/**
 * A new box, one with no release installed before, starts with System Tweaks
 * locked, so the panel can switch its protections on but never off. It is
 * written before any addon is enabled, so System Tweaks enabled now starts
 * from its defaults. An existing box is never locked here, since its switches
 * may be off on purpose. True when it locked.
 */
export function lockNewInstall(previousTag: string | null, files?: LockFiles): boolean {
  if (previousTag !== null) return false;
  try {
    if (!changeLock("system-tweaks", true, files)) return false;
    log.ok("System Tweaks is locked: the panel can switch its protections on but not off. Undo it with clp-addons unlock system-tweaks");
    return true;
  } catch (error) {
    log.warn(`System Tweaks was not locked: ${error instanceof ActionFailure ? error.message : lockFileProblem(error, files?.file)}`);
    return false;
  }
}

function applyLocal(spec: AddonSpec | undefined, dir: string): void {
  if (spec) ensureRequiredUnits(spec);
  const specs = [...installedAddons().filter((item) => item.name !== spec?.name), ...(spec ? [spec] : [])];
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

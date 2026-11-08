import { dashboardUrl, migrateOldAddonNames, resolveAddon } from "./addons";
import { enabledAddons } from "../addons/catalog";
import { artifactNames, installArtifacts, installedTag } from "./artifacts";
import { bootstrapProvision, applyEnable } from "./toggle";
import { type AddonSpec } from "../lib/addon-definition";
import { recordNewsSince } from "../manager/action";
import { withOperationLock } from "./operation-lock";
import { ARTIFACT_MANIFEST_PATH } from "../lib/paths";
import { lstatSync } from "node:fs";
import { ensureDirs, ensureRequiredUnits, ensureServiceUser } from "./provision";
import { CLI_VERSION } from "../lib/version";
import { loadLocal } from "./release";
import { fatal, log, requireRoot } from "../lib/log";
import { CLOUDPANEL_RANGE, describeRange, panelVersion, rangeFit } from "../lib/cloudpanel-version";
import { parseFlags } from "./flags";
import { changeLock, lockFailure, type LockFiles } from "../lib/lock-addon";

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
    warnOutsidePanelRange();
    // Read before anything is installed, so a re-run of the installer is not mistaken for a first one.
    const fresh = freshBox();
    // Re-running the installer on an older box must not leave a renamed addon behind until repair.
    migrateOldAddonNames();
    lockNewInstall(fresh);
    applyLocal(specs.shift(), local);
    for (const spec of specs) await applyEnable(spec.name);
    log.plain();
    if (!enabledAddons().some((spec) => spec.name === "system-tweaks")) {
      log.plain("System Tweaks is recommended: it applies the security fixes. Enable it on the Addons page or with: clp-addons enable system-tweaks");
    }
    log.plain(`Dashboard URL: ${dashboardUrl()}`);
  });
}

/**
 * No release was ever installed: no artifact manifest, readable or not, and no
 * addon enabled. A manifest that cannot be read is still an existing box.
 */
export function freshBox(manifest = ARTIFACT_MANIFEST_PATH, enabled = enabledAddons().length): boolean {
  if (enabled > 0) return false;
  try {
    lstatSync(manifest);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

/**
 * A new box, one with no release installed before, starts with System Tweaks
 * locked, so the panel can switch its protections on but never off. It is
 * written before any addon is enabled, so System Tweaks enabled now starts
 * from its defaults. An existing box is never locked here, since its switches
 * may be off on purpose. True when it locked.
 */
export function lockNewInstall(fresh: boolean, files?: LockFiles): boolean {
  if (!fresh) return false;
  try {
    if (!changeLock("system-tweaks", true, files)) return false;
    log.ok("System Tweaks is locked: the panel can switch its protections on but not off. Undo it with clp-addons unlock system-tweaks");
    return true;
  } catch (error) {
    log.warn(`System Tweaks was not locked: ${lockFailure(error, files?.file)}`);
    return false;
  }
}

/**
 * A warning, not a refusal: the hash and anchor checks keep the addons off any
 * CloudPanel page they were not built for, and System Tweaks' fixes matter
 * most on exactly the box that is behind or ahead.
 */
function warnOutsidePanelRange(): void {
  const installed = panelVersion();
  const fit = rangeFit(installed);
  if (fit === "within") return;
  const range = describeRange(CLOUDPANEL_RANGE);
  if (fit === "unknown") return log.warn(`could not read the CloudPanel version; this release supports CloudPanel ${range}`);
  log.warn(fit === "below"
    ? `CloudPanel ${installed} is older than this release supports (${range}); update CloudPanel with clp-update`
    : `CloudPanel ${installed} is newer than this release was checked against (${range}); a CloudPanel page that changed stays unpatched until a release supports it, and clp-addons status lists it`);
}

function applyLocal(spec: AddonSpec | undefined, dir: string): void {
  if (spec) ensureRequiredUnits(spec);
  const installed = enabledAddons();
  const wasEnabled = installed.some((item) => item.name === spec?.name);
  const specs = [...installed.filter((item) => item.name !== spec?.name), ...(spec ? [spec] : [])];
  const artifacts = loadLocal(dir, artifactNames());
  ensureServiceUser();
  ensureDirs(specs, true);
  recordNewsSince(installedTag());
  installArtifacts(artifacts, CLI_VERSION.replace(/^v/, ""));
  bootstrapProvision(specs);
  if (!spec) return log.ok("clp-addons installed");
  spec.activate?.(wasEnabled);
  log.ok(`${spec.name} installed`);
}

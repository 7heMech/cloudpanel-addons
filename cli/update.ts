import { errorMessage } from "../lib/errors";
import { rmSync } from "node:fs";
import { enabledAddons, phpGuardOptedOut } from "../addons/catalog";
import { migrateOldAddonNames, revertAddonRenames } from "./addons";
import {
  artifactNames, currentArtifactsMatch, installArtifacts, keepPreviousArtifacts, replaceArtifacts,
  rollbackUpdate,
} from "./artifacts";
import { reconcileAnchors, reconcileNginx, reconcilePanelBlocks } from "./reconcile";
import { reconcilePhpGuard } from "../lib/php-guard";
import { type AddonSpec } from "../lib/addon-definition";
import { keepNewsSince, recordNewsSince } from "../manager/action";
import { operationLockEnv, withOperationLock } from "./operation-lock";
import { CLI_BIN, LEGACY_GH, MANAGER_UNIT, RECONCILE_SERVICE } from "../lib/paths";
import {
  ensureAuthHelperReady, ensureDirs, ensureServiceUser, installUnits, reconcilePanelIdentity, removeLegacyUnits,
  startUnits, writeConfig,
} from "./provision";
import { unitActive } from "../lib/systemd";
import { CLI_VERSION } from "../lib/version";
import { type FetchedArtifact, fetchVerified, resolveRelease, verifyAttestation } from "./release";
import type { OnProgress } from "../lib/log";
import { fatal, log, requireRoot } from "../lib/log";
import { parseFlags } from "./flags";
import { run, tryRun } from "../lib/command";
import { compareSemver, isPrerelease } from "../lib/semver";
import { lockState } from "../lib/root-locks";
import {
  CLOUDPANEL_RANGE_ASSET, describeRange, panelVersion, parseRange, rangeFit,
} from "../lib/cloudpanel-version";
function finalizeUpdate(beforeManagerRestart?: () => void): AddonSpec[] {
  // A failure from here on makes the binary that started this update restore
  // itself, and an earlier binary knows the renamed addons only by their old
  // names, so they go back first.
  const renames = migrateOldAddonNames();
  try {
    const specs = enabledAddons();
    ensureServiceUser();
    ensureDirs(specs);
    ensureAuthHelperReady();
    for (const spec of specs) writeConfig(spec, true);
    reconcilePanelIdentity();
    removeLegacyUnits(true);
    rmSync(LEGACY_GH, { force: true });
    installUnits(specs);
    ensureDirs(specs);
    reconcileAnchors(false);
    if (!reconcilePanelBlocks(false)) log.warn("a change to CloudPanel's Nginx settings needs manual repair");
    if (!reconcileNginx(false)) log.warn("Nginx proxy needs manual repair");
    reconcilePhpGuard(true, false, { optedOut: phpGuardOptedOut() });
    startUnits({ beforeManagerRestart });
    // Addon upkeep, such as a changed guard System Tweaks installs, would
    // otherwise wait for the next quarter-hour; it runs once this update lets go of the lock.
    tryRun("systemctl", ["start", "--no-block", RECONCILE_SERVICE]);
    if (renames.length > 0 && unitActive(MANAGER_UNIT) !== "active") revertAddonRenames(renames);
    return specs;
  } catch (error) {
    revertAddonRenames(renames);
    throw error;
  }
}

/**
 * Warns when the installed CloudPanel is outside the release's range, and
 * never refuses: the release's fixes are wanted on any CloudPanel, and the
 * template checks hold back any page that changed. A malformed range only
 * warns too. The range is checksummed here and attested with the binary, and
 * a release from before ranges has none to check.
 */
async function checkPanelRange(
  release: Awaited<ReturnType<typeof resolveRelease>>,
  target: string,
  options: UpdateOptions,
): Promise<FetchedArtifact[]> {
  if (!release.assets.has(CLOUDPANEL_RANGE_ASSET)) return [];
  const installed = panelVersion();
  const fetched = await fetchVerified(release, [CLOUDPANEL_RANGE_ASSET], options.onStep, options.onProgress);
  const range = parseRange(fetched[0]!.bytes.toString("utf-8"));
  if (!range) {
    log.warn(`${CLOUDPANEL_RANGE_ASSET} in release ${release.tag} is not a CloudPanel version range; updating without checking it`);
    return fetched;
  }
  const fit = rangeFit(installed, range);
  if (fit === "below") log.warn(`clp-addons ${target} supports CloudPanel ${describeRange(range)}; this server runs ${installed}, so a CloudPanel page the addons were not checked on stays unpatched. Updating CloudPanel with clp-update is recommended`);
  if (fit === "above") log.warn(`clp-addons ${target} was checked against CloudPanel ${describeRange(range)}; this server runs ${installed}, so a CloudPanel page that changed stays unpatched until a release supports it`);
  if (fit === "unknown") log.warn(`could not read the CloudPanel version; clp-addons ${target} supports CloudPanel ${describeRange(range)}`);
  return fetched;
}

type UpdateOptions = {
  beforeManagerRestart?: () => void;
  onStep?: (step: string) => void;
  onProgress?: OnProgress;
};

/** If the binary moves, the installed copy re-runs this command and only that process provisions. */
export async function cmdUpdate(argv: string[], options: UpdateOptions = {}): Promise<void> {
  requireRoot("update");
  return withOperationLock("update", () => applyUpdate(argv, options));
}

/**
 * New installs lock System Tweaks; an update never does, since a box's
 * switches may be off on purpose, so it only says how. Reads, never writes.
 */
export function lockHint(enabled: boolean, file?: string, rootUid?: number): string | null {
  return enabled && lockState("system-tweaks", file, rootUid) === "unlocked"
    ? "Tip: so the panel can switch System Tweaks' protections on but never off, run clp-addons lock system-tweaks"
    : null;
}

function suggestLock(): void {
  const hint = lockHint(enabledAddons().some((spec) => spec.name === "system-tweaks"));
  if (hint) log.plain(hint);
}

async function applyUpdate(argv: string[], options: UpdateOptions): Promise<void> {
  const { flags } = parseFlags(argv);
  // A box running a pre-release keeps following them; a release takes it back to releases.
  const release = await resolveRelease(
    typeof flags.version === "string" ? flags.version : "latest",
    flags["allow-prerelease"] === true || isPrerelease(CLI_VERSION),
  );
  const current = CLI_VERSION.replace(/^v/, "");
  const target = release.tag.replace(/^v/, "");

  // Without --version an update only moves forward, whatever GitHub lists.
  if (typeof flags.version !== "string" && compareSemver(target, current) < 0) {
    log.ok(`clp-addons ${current} is up to date; the newest published release is ${target}`);
    suggestLock();
    return;
  }
  const upToDate = current === target;
  const artifactsCurrent = upToDate && currentArtifactsMatch(target);
  // Nothing to install, and repair is the command that re-applies the panel side.
  if (artifactsCurrent && flags["no-self-update"] !== true) {
    log.ok(`clp-addons ${current} is up to date`);
    suggestLock();
    return;
  }
  let artifacts: FetchedArtifact[] | undefined;
  if (!artifactsCurrent) {
    const range = await checkPanelRange(release, target, options);
    artifacts = await fetchVerified(release, artifactNames(), options.onStep, options.onProgress);
    await verifyAttestation(release, [...range, ...artifacts], flags["skip-attestation"] === true);
  }

  if (artifacts) {
    if (flags["no-self-update"] !== true) {
      // Re-enter the stable public command rather than a new private command:
      // an explicit downgrade can target a release from before this handoff
      // existed. Such a binary still knows how to update itself. The internal
      // flag bounds the handoff in current releases and is ignored safely by
      // older ones, whose installed version already equals the requested tag.
      const handoff = [
        "update",
        ...argv,
        `--version=${release.tag}`,
        "--no-self-update",
        `--updated-from=${current}`,
      ];
      try {
        keepPreviousArtifacts();
      } catch (error) {
        fatal(`could not keep the running binary aside, so the update was not started: ${errorMessage(error)}`);
      }
      let failure: string | null = null;
      const restoreNewsSince = keepNewsSince();
      try {
        replaceArtifacts(artifacts, target);
        options.beforeManagerRestart?.();
        run(CLI_BIN, handoff, { stdio: "inherit", env: operationLockEnv() });
        const state = unitActive(MANAGER_UNIT);
        if (state !== "active") failure = `${MANAGER_UNIT} is ${state} after the update`;
      } catch (error) {
        failure = errorMessage(error);
      }
      if (failure) {
        restoreNewsSince();
        rollbackUpdate(current, failure);
      }
      return;
    }
    installArtifacts(artifacts, target);
  }
  if (current !== target) {
    fatal(`update handoff expected ${target} but the running process is ${current}`);
  }
  const updatedFrom = flags["no-self-update"] === true && typeof flags["updated-from"] === "string"
    ? flags["updated-from"].replace(/^v/, "")
    : current;
  const versionChanged = updatedFrom !== target;
  if (versionChanged) recordNewsSince(updatedFrom);
  const specs = finalizeUpdate(options.beforeManagerRestart);
  if (specs.length === 0) {
    log.ok(versionChanged
      ? `clp-addons updated from ${updatedFrom} to ${target}; no addon service is configured`
      : `clp-addons ${current} reinstalled; no addon service is configured`);
    suggestLock();
    return;
  }
  log.ok(versionChanged ? `clp-addons updated from ${updatedFrom} to ${target}` : `clp-addons ${current} reinstalled`);
  suggestLock();
}

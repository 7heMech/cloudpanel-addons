// `clp-addons update`, and the rollback a failed one runs.

import { installedAddons, migrateAbsorbedAddons } from "./addons";
import {
  artifactNames, currentArtifactsMatch, installArtifacts, keepPreviousArtifacts, replaceArtifacts,
  rollbackUpdate,
} from "./artifacts";
import { reconcileAnchors, reconcileMaintenanceNginx, reconcileNginx } from "./reconcile";
import { type AddonSpec } from "./addon-catalog";
import { operationLockEnv, withOperationLock } from "./operation-lock";
import { CLI_BIN, MANAGER_UNIT } from "./paths";
import {
  ensureAuthHelperReady, ensureDirs, ensureServiceUser, installUnits, reconcilePanelIdentity,
  removeLegacyInstall, removeLegacyUnits, removeLegacyUsers, startUnits, unitActive, writeConfig,
} from "./provision";
import {
  CLI_VERSION, type FetchedArtifact, fetchVerified, resolveRelease, verifyAttestation,
} from "./release";
import { fatal, log, parseFlags, requireRoot, run } from "./util";
/**
 * Reconcile all provisioning from the binary that owns the definitions.
 * Services restart last, after every generated file reflects this process.
 */
function finalizeUpdate(beforeManagerRestart?: () => void): AddonSpec[] {
  migrateAbsorbedAddons();
  const specs = installedAddons();
  ensureServiceUser();
  removeLegacyInstall();
  ensureDirs(specs);
  ensureAuthHelperReady();
  for (const spec of specs) writeConfig(spec, true);
  reconcilePanelIdentity();
  removeLegacyUnits(true);
  removeLegacyUsers(true);
  installUnits(specs);
  ensureDirs(specs);
  reconcileAnchors(false);
  if (!reconcileMaintenanceNginx(false)) log.warn("Nginx maintenance check needs manual repair");
  if (!reconcileNginx(false)) log.warn("Nginx proxy needs manual repair");
  startUnits({ beforeManagerRestart });
  return specs;
}

/**
 * Updates release artifacts when necessary. If the binary moves, re-run this
 * same command as the installed copy and let only that process provision.
 */
export async function cmdUpdate(argv: string[], options: { beforeManagerRestart?: () => void } = {}): Promise<void> {
  requireRoot("update");
  return withOperationLock("update", () => applyUpdate(argv, options));
}

async function applyUpdate(argv: string[], options: { beforeManagerRestart?: () => void }): Promise<void> {
  const { flags } = parseFlags(argv);
  const release = await resolveRelease(
    typeof flags.version === "string" ? flags.version : "latest",
    flags["allow-prerelease"] === true,
  );
  const current = CLI_VERSION.replace(/^v/, "");
  const target = release.tag.replace(/^v/, "");

  const upToDate = current === target;
  const artifactsCurrent = upToDate && currentArtifactsMatch(target);
  let artifacts: FetchedArtifact[] | undefined;
  if (!artifactsCurrent) {
    artifacts = await fetchVerified(release, artifactNames());
    await verifyAttestation(release, artifacts, flags["skip-attestation"] === true);
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
      // Keeping the running binary aside happens before the boundary, because
      // nothing has been replaced yet: there is no rollback to report, only an
      // update that never started.
      try {
        keepPreviousArtifacts();
      } catch (error) {
        fatal(`could not keep the running binary aside, so the update was not started: ${error instanceof Error ? error.message : String(error)}`);
      }
      // Everything from the replacement onwards is one boundary: the binary
      // and its manifest are written here, so a failure between them is as
      // much a half-finished update as a handoff that will not run. The
      // rollback itself is outside it, so its own failure is not retried.
      let failure: string | null = null;
      try {
        replaceArtifacts(artifacts, target);
        options.beforeManagerRestart?.();
        run(CLI_BIN, handoff, { stdio: "inherit", env: operationLockEnv() });
        const state = unitActive(MANAGER_UNIT);
        if (state !== "active") failure = `${MANAGER_UNIT} is ${state} after the update`;
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      if (failure) rollbackUpdate(current, failure);
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
  const specs = finalizeUpdate(options.beforeManagerRestart);
  if (specs.length === 0) {
    log.ok(versionChanged
      ? `clp-addons updated from ${updatedFrom} to ${target}; no addon service is configured`
      : `clp-addons ${current} is up to date`);
    return;
  }
  log.ok(versionChanged
    ? `clp-addons updated from ${updatedFrom} to ${target}`
    : `clp-addons ${current} is up to date; provisioning reconciled`);
}

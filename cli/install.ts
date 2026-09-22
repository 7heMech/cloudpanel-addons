// `clp-addons install`.

import { dashboardUrl, installedAddons, resolveAddon } from "./addons";
import { artifactNames, installArtifacts } from "./artifacts";
import { bootstrapProvision, applyEnable } from "./toggle";
import { type AddonSpec } from "./addon-catalog";
import { withOperationLock } from "./operation-lock";
import { ensureDirs, ensureRequiredUnits, ensureServiceUser, removeLegacyInstall } from "./provision";
import {
  CLI_VERSION, type FetchedArtifact, fetchVerified, loadLocal, resolveRelease, verifyAttestation,
} from "./release";
import { fatal, log, parseFlags, requireRoot } from "./util";
/**
 * Enables bundled code by default. Explicit --version/--local requests also
 * replace the binary with verified artifacts before reconciling provisioning.
 */
export async function cmdInstall(argv: string[]): Promise<void> {
  requireRoot("install");
  const { positional, flags } = parseFlags(argv);
  const spec = resolveAddon(positional[0]);
  return withOperationLock(`install ${spec.name}`, () => applyInstall(spec, flags));
}

async function applyInstall(spec: AddonSpec, flags: Record<string, string | true>): Promise<void> {
  if (flags.version === undefined && flags.local === undefined) {
    await applyEnable(spec.name);
    return;
  }
  if (flags.version === true || flags.local === true) fatal("--version and --local require a value");
  if (flags.version !== undefined && flags.local !== undefined) fatal("use either --version or --local, not both");
  ensureRequiredUnits(spec);

  const specs = [...installedAddons().filter((item) => item.name !== spec.name), spec];
  const names = artifactNames();
  let artifacts: FetchedArtifact[];
  let artifactTag: string | undefined;
  if (typeof flags.local === "string") {
    artifacts = loadLocal(flags.local, names);
  } else {
    const release = await resolveRelease(
      typeof flags.version === "string" ? flags.version : "latest",
      flags["allow-prerelease"] === true,
    );
    artifactTag = release.tag.replace(/^v/, "");
    artifacts = await fetchVerified(release, names);
    await verifyAttestation(release, artifacts, flags["skip-attestation"] === true);
  }

  ensureServiceUser();
  removeLegacyInstall();
  ensureDirs(specs, true);
  installArtifacts(artifacts, artifactTag ?? CLI_VERSION.replace(/^v/, ""));
  bootstrapProvision(specs);

  log.plain();
  log.ok(`${spec.name} installed`);
  log.plain(`  Dashboard URL: ${dashboardUrl()}`);
}

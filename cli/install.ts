// `clp-addons install`.

import { dashboardUrl, installedAddons, resolveAddon } from "./addons";
import { artifactNames, installArtifacts } from "./artifacts";
import { bootstrapProvision, applyEnable } from "./toggle";
import { ADDONS, ADDON_NAMES, type AddonSpec } from "./addon-catalog";
import { pickAddons } from "./menu";
import { operationLockEnv, withOperationLock } from "./operation-lock";
import { CLI_BIN } from "./paths";
import { ensureDirs, ensureRequiredUnits, ensureServiceUser } from "./provision";
import {
  CLI_VERSION, type FetchedArtifact, fetchVerified, loadLocal, resolveRelease, verifyAttestation,
} from "./release";
import { fatal, log, parseFlags, requireRoot, run } from "./util";

/**
 * Enables bundled code by default. Explicit --version/--local requests also
 * replace the binary with verified artifacts before reconciling provisioning.
 * With no addon named, a terminal is asked which ones; this is the question
 * install.sh leaves to the binary it has just verified.
 */
export async function cmdInstall(argv: string[]): Promise<void> {
  requireRoot("install");
  const { positional, flags } = parseFlags(argv);
  const names = positional.length > 0 ? positional : await askAddons();
  const [first, ...rest] = [...new Set(names)].map(resolveAddon);
  return withOperationLock(`install ${names.join(", ")}`, async () => {
    const replaced = await applyInstall(first!, flags);
    if (replaced && rest.length > 0) {
      // The rest are enabled by the binary just installed, not by this one.
      try {
        run(CLI_BIN, ["install", ...rest.map((spec) => spec.name)], { stdio: "inherit", env: operationLockEnv() });
      } catch {
        fatal(`${first!.name} is installed; finish with: clp-addons install ${rest.map((spec) => spec.name).join(" ")}`);
      }
      return;
    }
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

/** Whether the binary was replaced. */
async function applyInstall(spec: AddonSpec, flags: Record<string, string | true>): Promise<boolean> {
  if (flags.version === undefined && flags.local === undefined) {
    await applyEnable(spec.name);
    return false;
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
  ensureDirs(specs, true);
  installArtifacts(artifacts, artifactTag ?? CLI_VERSION.replace(/^v/, ""));
  bootstrapProvision(specs);
  spec.activate?.();

  log.ok(`${spec.name} installed`);
  return true;
}

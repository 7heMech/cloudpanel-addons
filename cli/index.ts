import {
  copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync,
} from "node:fs";

import {
  ARTIFACT_MANIFEST_PATH, AUTH_SERVICE_UNIT, AUTH_SOCKET_UNIT, CLI_ARTIFACT, CLI_BIN,
  CLOUDFLARE_RECONCILE_TIMER, CONFIG_DIR, LIBEXEC_DIR, MANAGER_UNIT, SOCKET_PATH, STATE_DIR, SYSTEMD_DIR,
  mountPath,
} from "./paths";
import { ADDONS, ADDON_NAMES, addonHandler, addonMaintenance, type AddonSpec } from "./addon-catalog";
import {
  CLI_VERSION, fetchVerified, loadLocal, resolveRelease, verifyAttestation, type FetchedArtifact,
} from "./release";
import {
  ensureDirs, ensureRequiredUnits, ensureServiceUser, ensureTimerArmed, hardenBackups,
  ensureAuthHelperReady, reconcilePanelIdentity, installUnits, installedConfig, purgeTwigCache,
  removeLegacyUnits, applyToggleUnits, platformProvisioned, removeLegacyInstall, removeLegacyUsers,
  removeSudoers, startUnits, stopUnits, unitActive, unitPid, warnIfPanelSessionUnreadable, writeConfig,
} from "./provision";
import {
  KNOWN_GOOD_PANEL_VERSIONS, inspect, inspectNginxMaintenance, inspectNginxProxy, masterVhostHost,
  panelVersion, purgeTwigCache as purgeInjectCache, reconcile, reconcileNginxMaintenance,
  reconcileNginxProxy, type Injection, type MaintenanceNginxStatus, type NginxProxyStatus,
  type TargetStatus,
} from "./inject";
import { fatal, Fatal, log, parseFlags, requireRoot, run, tryRun, writeAtomic } from "./util";
import { operationLockEnv, withOperationLock, withOperationLockSync } from "./operation-lock";
import { runRecon } from "./recon";
import { cmdServe } from "../manager/server";

import { adminHeaderTarget, headerTarget, siteLayoutTarget, SITE_TAB_TEMPLATE } from "../lib/panel-nav";

import { ensureMaintenanceData, executeMaintenanceAction } from "../addons/maintenance/action";

import { removeWpLogin } from "../addons/wp-login/action";
import { runAuthActionStdin } from "./auth-action";
import { pruneManagerJobs, runManagerAction, type ManagerOps } from "./manager-action";


function resolveAddon(name: string | undefined): AddonSpec {
  const key = name ?? "";
  const spec = ADDONS[key];
  if (!spec) fatal(`unknown addon '${key}'. Available: ${ADDON_NAMES.join(", ")}`);
  return spec;
}

function installedAddons(): AddonSpec[] {
  return ADDON_NAMES.map((name) => ADDONS[name]!).filter(installedConfig);
}

/**
 * Addons that are now part of another addon.
 *
 * `login-theme` was a whole addon for one script in the login page's <head>.
 * It is a switch inside Panel Tweaks now, and a box that had it enabled
 * should come out of an update with the device theme still working rather than
 * with an addon that no longer exists. The config file is the enabled flag, so
 * moving it is the whole migration: the state directory held nothing, and the Twig
 * block goes when the templates are next rendered, because the injection set is
 * read from the config files.
 */
const ABSORBED_ADDONS: Record<string, string> = { "login-theme": "panel-tweaks" };

export function migrateAbsorbedAddons(quiet = false): void {
  for (const [from, into] of Object.entries(ABSORBED_ADDONS)) {
    const legacyConfig = `${CONFIG_DIR}/${from}.conf`;
    if (!existsSync(legacyConfig)) continue;
    const spec = ADDONS[into];
    if (spec && !installedConfig(spec)) writeConfig(spec, true);
    rmSync(legacyConfig, { force: true });
    rmSync(`${legacyConfig}.new`, { force: true });
    rmSync(`${STATE_DIR}/${from}`, { recursive: true, force: true });
    if (!quiet) log.ok(`${from} is part of ${into} now and was carried over`);
  }
}

function artifactNames(): string[] {
  return [CLI_ARTIFACT];
}

function artifact(artifacts: FetchedArtifact[], name: string): Buffer {
  const found = artifacts.find((item) => item.name === name);
  if (!found) fatal(`release did not contain ${name}`);
  return found.bytes;
}

function artifactPaths(): Map<string, string> {
  return new Map([[CLI_ARTIFACT, CLI_BIN]]);
}

function sha256(bytes: Buffer): string {
  return Bun.CryptoHasher.hash("sha256", bytes, "hex");
}

function secureRegularFile(path: string, executable = false): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && stat.uid === 0 && (stat.mode & 0o022) === 0 && (!executable || (stat.mode & 0o111) !== 0);
  } catch {
    return false;
  }
}

function currentArtifactsMatch(tag: string): boolean {
  if (!secureRegularFile(ARTIFACT_MANIFEST_PATH)) return false;

  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(ARTIFACT_MANIFEST_PATH, "utf-8"));
  } catch {
    return false;
  }
  if (typeof manifest !== "object" || manifest === null) return false;
  const record = manifest as { version?: unknown; tag?: unknown; artifacts?: unknown };
  if (record.version !== 1 || record.tag !== tag || typeof record.artifacts !== "object" || record.artifacts === null) {
    return false;
  }

  const checksums = record.artifacts as Record<string, unknown>;
  for (const [name, path] of artifactPaths()) {
    const expected = checksums[name];
    if (typeof expected !== "string" || !/^[0-9a-f]{64}$/.test(expected) || !secureRegularFile(path, true)) return false;
    try {
      if (sha256(readFileSync(path)) !== expected) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function writeArtifactManifest(tag: string, artifacts: FetchedArtifact[]): void {
  const checksums: Record<string, string> = {};
  for (const name of artifactPaths().keys()) checksums[name] = sha256(artifact(artifacts, name));
  writeAtomic(ARTIFACT_MANIFEST_PATH, JSON.stringify({ version: 1, tag, artifacts: checksums }) + "\n", 0o600);
  tryRun("chown", ["root:root", ARTIFACT_MANIFEST_PATH]);
}

/** Where the binary this update replaces is kept, in case it has to come back. */
const PREVIOUS_BIN = `${LIBEXEC_DIR}/clp-addons.previous`;
const PREVIOUS_MANIFEST = `${LIBEXEC_DIR}/artifacts.previous.json`;

function hardLinkOrCopy(from: string, to: string): void {
  rmSync(to, { force: true });
  try {
    linkSync(from, to);
  } catch {
    copyFileSync(from, to);
  }
}

/**
 * Keep the running binary and its manifest where a failed update can put them
 * back. Hard-linked rather than copied: it costs nothing and cannot be a
 * partial file. The manifest goes with it because `currentArtifactsMatch`
 * reads it -- restoring one without the other leaves the box claiming a
 * version it is not running.
 */
function keepPreviousArtifacts(): void {
  rmSync(PREVIOUS_BIN, { force: true });
  rmSync(PREVIOUS_MANIFEST, { force: true });
  if (!existsSync(CLI_BIN)) return;
  mkdirSync(LIBEXEC_DIR, { recursive: true });
  hardLinkOrCopy(CLI_BIN, PREVIOUS_BIN);
  if (existsSync(ARTIFACT_MANIFEST_PATH)) hardLinkOrCopy(ARTIFACT_MANIFEST_PATH, PREVIOUS_MANIFEST);
}

/**
 * Whether the kept-aside binary is the release its kept-aside manifest names.
 *
 * `null` when there is nothing to compare against. The manifest is rewritten
 * only by the release install path, so a binary put in place by
 * `tools/deploy-stg.ts` or by hand leaves the previous release's manifest
 * beside it and the two legitimately disagree.
 */
function previousArtifactsAgree(): boolean | null {
  if (!secureRegularFile(PREVIOUS_MANIFEST)) return null;
  try {
    const manifest = JSON.parse(readFileSync(PREVIOUS_MANIFEST, "utf-8")) as { artifacts?: Record<string, unknown> };
    const expected = manifest.artifacts?.[CLI_ARTIFACT];
    if (typeof expected !== "string" || !/^[0-9a-f]{64}$/.test(expected)) return null;
    return sha256(readFileSync(PREVIOUS_BIN)) === expected;
  } catch {
    return null;
  }
}

/**
 * Checked at the moment of use rather than trusted for having been written
 * here: this runs as root and hands the box back a binary to execute. A
 * checksum that disagrees is reported rather than refused -- refusing would
 * leave the box on the binary that just failed, which is worse.
 */
function restorePreviousArtifacts(): boolean {
  if (!secureRegularFile(PREVIOUS_BIN, true)) return false;
  if (previousArtifactsAgree() === false) {
    log.warn(`${PREVIOUS_BIN} does not match the checksum its manifest records; restoring it anyway`);
  }
  const staged = `${CLI_BIN}.rollback`;
  hardLinkOrCopy(PREVIOUS_BIN, staged);
  renameSync(staged, CLI_BIN);
  if (secureRegularFile(PREVIOUS_MANIFEST)) {
    const stagedManifest = `${ARTIFACT_MANIFEST_PATH}.rollback`;
    hardLinkOrCopy(PREVIOUS_MANIFEST, stagedManifest);
    renameSync(stagedManifest, ARTIFACT_MANIFEST_PATH);
  } else {
    rmSync(ARTIFACT_MANIFEST_PATH, { force: true });
  }
  return true;
}

function replaceArtifacts(artifacts: FetchedArtifact[], tag: string): void {
  writeAtomic(CLI_BIN, artifact(artifacts, CLI_ARTIFACT), 0o755);
  tryRun("chown", ["root:root", CLI_BIN]);
  writeArtifactManifest(tag, artifacts);
}

function installArtifacts(artifacts: FetchedArtifact[], tag: string): void {
  keepPreviousArtifacts();
  replaceArtifacts(artifacts, tag);
}

/**
 * Put the box back on the binary it was running.
 *
 * The parent is the old binary and it outlives the child it handed off to, so
 * it is the only process still able to act when the new one will not start,
 * fails part-way through provisioning, or leaves the services down.
 */
function rollbackUpdate(previousVersion: string, reason: string): never {
  log.err(`the updated binary failed: ${reason}`);
  if (!restorePreviousArtifacts()) {
    fatal(
      `no usable earlier binary was kept, so the box is still running the update; ` +
      `run 'clp-addons repair' and check 'systemctl status ${MANAGER_UNIT}'`,
    );
  }
  const restart = tryRun("systemctl", ["restart", AUTH_SOCKET_UNIT, AUTH_SERVICE_UNIT, MANAGER_UNIT]);
  if (!restart.ok) log.err(`the background services did not restart: ${restart.out}`);
  // Only the two artifacts come back. Whatever the update had already written
  // -- config files, units, templates, Nginx fragments -- is the new version's
  // and stays, which is what repair exists to converge.
  fatal(
    `rolled the binary and its manifest back; the box is running clp-addons ${previousVersion}. ` +
    `Run 'clp-addons repair' to reconcile anything the update had already written`,
  );
}

/**
 * `managerNav` is whether the panel keeps its "Addons" entry.
 *
 * It belongs to the manager, not to any addon, and it used to be derived from
 * "at least one addon is enabled". That was the same thing right up until an
 * addon could be disabled from the page the entry leads to: disabling the last
 * one took the link away, and the only way back to the page that would offer
 * the addons again was to know the URL. The entry now goes when the
 * installation goes, which is `cmdUninstall`'s call to make, not this one's.
 */
export function installedInjections(exclude?: string, managerNav = true): Injection[] {
  const injections: Injection[] = [];
  const installed = ADDON_NAMES.filter((name) => name !== exclude && existsSync(ADDONS[name]!.configFile));

  // Kept outside the addon target lists so installing a second addon cannot
  // emit a second style/script block or replace the first one's marker.
  if (managerNav) {
    injections.push({ addon: "manager", target: headerTarget(), url: "/addons/" });
    injections.push({ addon: "manager", target: adminHeaderTarget(), url: "/addons/" });
  }

  // The site tab strip only needs its one-row rule once some installed addon is
  // actually adding a tab to it, and it needs it exactly once however many do.
  if (installed.some((name) => ADDONS[name]!.targets.some((target) => target.template === SITE_TAB_TEMPLATE))) {
    injections.push({ addon: "manager", target: siteLayoutTarget(), url: "/addons/" });
  }

  for (const name of installed) {
    const spec = ADDONS[name]!;
    for (const target of spec.targets) injections.push({
      addon: name,
      target,
      url: mountPath(name),
    });
  }
  return injections;
}

function describeTarget(status: TargetStatus): string {
  switch (status.state) {
    case "ok": return "patched";
    case "missing-anchor": return "missing; repair will re-inject";
    case "stale-content": return "stale; repair will rewrite it";
    case "template-absent": return "template not found";
    case "anchor-not-found-in-markup": return "anchor markup not found";
    case "upstream-changed": return `upstream changed (${status.found.slice(0, 12)})`;
  }
}

function reconcileAnchors(quiet: boolean, exclude?: string, managerNav = true): boolean {
  const injections = installedInjections(exclude, managerNav);
  const wanted = new Map(injections.map((injection) => [`${injection.addon}:${injection.target.slug}`, injection]));
  const result = reconcile(injections);
  let blocked = false;
  for (const status of result.statuses) {
    const injection = wanted.get(`${status.addon}:${status.slug}`);
    if (!injection) continue;
    if (status.state === "ok") {
      if (!quiet) log.ok(`${status.addon}/${status.slug} patched`);
      continue;
    }
    if (status.state === "template-absent") {
      if (!quiet) log.warn(`${status.addon}/${status.slug}: ${describeTarget(status)}`);
      // Left non-fatal for repair/update, which run unattended and may catch
      // the panel mid-upgrade while cloudpanel.postinst has the app directory
      // moved aside; the next periodic reconcile heals it. install/enable
      // check this return value and abort, so a target whose template is
      // simply absent on this panel build (wrong path, unsupported version)
      // still surfaces as a failure there instead of a silent no-op.
      if (injection.target.required) blocked = true;
      continue;
    }
    log.err(`${status.addon}/${status.slug}: ${describeTarget(status)}`);
    if (status.state === "upstream-changed" || status.state === "anchor-not-found-in-markup") {
      log.err(`CloudPanel ${panelVersion()} changed the target markup; known good: ${KNOWN_GOOD_PANEL_VERSIONS.join(", ")}`);
    }
    if (injection.target.required) blocked = true;
  }
  if (result.changed) {
    purgeInjectCache();
    if (!quiet) log.ok("Twig cache purged");
  }
  return !blocked;
}

function reconcileNginx(quiet: boolean, enabled = true): boolean {
  const result = reconcileNginxProxy({ enabled });
  if (result.state === "ok" || (!enabled && result.state === "missing")) {
    if (result.changed && !quiet) log.ok(enabled ? "Nginx proxy injected and verified" : "Nginx proxy removed and verified");
    return true;
  }
  log.err(`Nginx proxy: ${result.detail ?? result.state}`);
  return false;
}

function reconcileMaintenanceNginx(quiet: boolean, enabled = existsSync(ADDONS.maintenance!.configFile)): boolean {
  if (enabled) ensureMaintenanceData(ADDONS.maintenance!.stateDir);
  const result = reconcileNginxMaintenance({ enabled });
  if (result.state === "ok" || (!enabled && result.state === "missing")) {
    if (result.changed && !quiet) log.ok(enabled ? "Nginx maintenance check injected and verified" : "Nginx maintenance check removed and verified");
    return true;
  }
  log.err(`Nginx maintenance check: ${result.detail ?? result.state}`);
  return false;
}

function dashboardUrl(): string {
  const host = masterVhostHost() ?? "<cloudpanel-host>";
  return `https://${host}/addons/`;
}

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

/**
 * Everything a first install has to put on the box, in the order it has to
 * happen: accounts and directories before files, files before units, units
 * before anything is started.
 *
 * Shared by `install` and by an `enable` that finds nothing provisioned. It is
 * deliberately not what a toggle runs -- re-creating the service user, probing
 * the auth helper and sweeping legacy installs are answers to "has this box
 * ever been set up", and asking that on every toggle is most of what made a
 * toggle slow.
 */
function bootstrapProvision(specs: AddonSpec[]): void {
  ensureServiceUser();
  removeLegacyInstall();
  ensureDirs(specs, true);
  ensureAuthHelperReady();
  for (const item of specs) writeConfig(item, true);
  reconcilePanelIdentity();
  installUnits(specs);
  removeLegacyUnits(true);
  removeLegacyUsers(true);
  ensureDirs(specs);
  if (!reconcileAnchors(false)) fatal("could not safely patch the required CloudPanel templates");
  if (!reconcileMaintenanceNginx(false)) fatal("could not safely inject the Nginx maintenance check");
  if (!reconcileNginx(false)) fatal("could not safely inject the CloudPanel Nginx proxy");
  startUnits();
}

/**
 * Turn an addon that already ships in this binary on.
 *
 * This is `cmdInstall` with the download removed, because there is nothing to
 * download: `ADDONS` is compiled in and so are its injection targets. What is
 * left -- the config file, the state directory, the Twig anchors, the units --
 * is the whole of what "installed" ever meant for an individual addon.
 */
export async function applyEnable(name: string): Promise<void> {
  requireRoot("enable");
  const spec = resolveAddon(name);
  return withOperationLock(`enable ${spec.name}`, () => enableAddon(spec));
}

async function enableAddon(spec: AddonSpec): Promise<void> {
  ensureRequiredUnits(spec);
  const before = installedAddons().filter((item) => item.name !== spec.name);
  const specs = [...before, spec];

  if (!platformProvisioned()) {
    bootstrapProvision(specs);
    log.ok(`${spec.name} enabled`);
    return;
  }

  // The panel identity is what lets a site action refuse to operate on the
  // panel's own hostname, and disabling the last addon removes it. Put it back
  // before anything that could accept a site action, which is the moment this
  // addon's config file exists.
  if (before.length === 0) reconcilePanelIdentity(true, specs);
  writeConfig(spec, true);
  ensureDirs(specs);
  const changes = installUnits(specs);
  // An addon with no injection targets changes no panel markup, so there is
  // nothing to patch and nothing to purge. cloudflare-ips is the current case.
  if (spec.targets.length > 0 && !reconcileAnchors(false)) {
    fatal("could not safely patch the required CloudPanel templates");
  }
  if (spec.name === "maintenance" && !reconcileMaintenanceNginx(false, true)) {
    fatal("could not safely inject the Nginx maintenance check");
  }
  applyToggleUnits(changes);
  log.ok(`${spec.name} enabled`);
}

/**
 * The WordPress sign-in helper is a file in somebody else's site, not state in
 * this addon's own directory, so withdrawing the addon has to take it back out.
 * A failure warns rather than stops: an addon that cannot be removed because
 * one site's files moved would be worse than a helper left behind and named.
 */
function withdrawWpLogin(): void {
  try {
    const { removed, failed } = removeWpLogin();
    if (removed > 0) log.ok(`sign-in helper removed from ${removed} site${removed === 1 ? "" : "s"}`);
    if (failed.length > 0) log.warn(`the sign-in helper is still in ${failed.join("; ")}`);
  } catch (error) {
    log.warn(`the sign-in helper could not be removed from every site: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Turn one addon off and leave everything it made behind.
 *
 * Deliberately not `cmdUninstall`: that removes the binary once the last addon
 * goes, and may remove an addon's data. Disabling withdraws the addon from the
 * panel -- its config, its units' knowledge of it, its Twig markup -- and keeps
 * its state directory, so enabling it again returns the same instances.
 */
export function applyDisable(name: string): void {
  requireRoot("disable");
  const spec = resolveAddon(name);
  withOperationLockSync(`disable ${spec.name}`, () => disableAddon(spec));
}

function disableAddon(spec: AddonSpec): void {
  const remaining = installedAddons().filter((item) => item.name !== spec.name);

  if (spec.name === "wp-login") withdrawWpLogin();
  rmSync(spec.configFile, { force: true });
  rmSync(`${spec.configFile}.new`, { force: true });
  // Reconciled after the config file is gone, so the injection set is read
  // from the state that now exists rather than described by an `exclude`
  // argument. The Twig cache is purged by the reconciler when the markup
  // actually changes; disable used to purge it a second time unconditionally.
  if (spec.targets.length > 0) reconcileAnchors(false);
  if (spec.name === "maintenance" && !reconcileMaintenanceNginx(false, false)) {
    fatal("could not safely update the Nginx maintenance check");
  }
  ensureDirs(remaining);
  // Nothing of ours may act on a site once no addon is enabled.
  if (remaining.length === 0) reconcilePanelIdentity(true, remaining);
  const changes = installUnits(remaining);
  applyToggleUnits(changes);
  log.ok(`${spec.name} disabled; its data under ${spec.stateDir} was kept`);
}

/**
 * The privileged half of the three manager verbs.
 *
 * `update` is `clp-addons update` with no arguments -- the same resolver, the
 * same checksum and provenance verification, the same installer. There is no
 * second download path, which is the point: a button that fetched releases its
 * own way would be a second thing to get right.
 */
export const MANAGER_OPS: ManagerOps = {
  enable: applyEnable,
  disable: applyDisable,
  update: (beforeManagerRestart) => cmdUpdate([], { beforeManagerRestart }),
  // Short: this one answers a live request from the panel, so it refuses and
  // names the operation in the way rather than making the page wait it out.
  reconcile: () => withOperationLockSync("reconcile", () => {
    if (!reconcileAnchors(true)) fatal("could not safely patch the CloudPanel templates");
  }, { timeoutSeconds: 15 }),
};

/**
 * Run each installed addon's own upkeep, in catalog order.
 *
 * Stager's prune and Instatic's were called by name from `cmdRepair`, which
 * meant repair knew which addons had upkeep and what it was called. An addon
 * now declares its own, and none of it is allowed to fail the rest of repair:
 * this is self-healing, not a precondition for anything.
 */
export async function runAddonMaintenance(
  installed: AddonSpec[],
  options?: Record<string, unknown>,
): Promise<void> {
  for (const spec of addonMaintenance(installed)) {
    const task = spec.maintenance!;
    try {
      const line = await task.run(options);
      if (line) log.ok(`${task.label}: ${line}`);
    } catch (error) {
      log.warn(`${task.label} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/**
 * The manager's own job records need the same upkeep the addons' do: a runner
 * killed part-way (a reboot during an update) otherwise leaves a record that
 * says "running" forever, and the index page would keep following it.
 */
export function runManagerMaintenance(): void {
  try {
    const { removed, stuck } = pruneManagerJobs();
    if (removed || stuck) log.ok(`manager job records: ${removed} expired, ${stuck} marked failed`);
  } catch (error) {
    log.warn(`manager maintenance (prune) failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Reconciles manager provisioning and enabled addon state, or only injected
 * CloudPanel anchors and the Nginx proxy when `--anchors-only` is supplied.
 */
export async function cmdRepair(argv: string[]): Promise<void> {
  requireRoot("repair");
  const { positional, flags } = parseFlags(argv);
  const anchorsOnly = flags["anchors-only"] === true;
  return withOperationLock(anchorsOnly ? "repair --anchors-only" : "repair", () => applyRepair(positional, flags));
}

async function applyRepair(positional: string[], flags: Record<string, string | true>): Promise<void> {
  const quiet = flags.quiet === true;
  if (flags["anchors-only"] === true) {
    // The watcher's fast path: reconcile only what this project injected into
    // panel-owned files. The Nginx proxy belongs here as much as the Twig
    // anchors do -- the vhost is owned by the panel user on the CloudPanel
    // layout, so a panel action can drop the /addons/ block at any time, and
    // waiting up to fifteen minutes for the timer would leave the manager
    // unreachable in between. Both reconcilers no-op when nothing drifted, so
    // this stays cheap enough to run on every template write during an upgrade.
    reconcileAnchors(quiet);
    if (!reconcileMaintenanceNginx(quiet)) log.err("Nginx maintenance check is not ready; run repair after checking global_settings");
    if (!reconcileNginx(quiet)) log.err("Nginx proxy is not ready; run repair after checking the master vhost");
    return;
  }
  migrateAbsorbedAddons(quiet);
  const specs = positional[0] ? [resolveAddon(positional[0])] : installedAddons();
  const all = installedAddons();
  // An installation with every addon disabled still needs its timer, its Nginx
  // proxy and the panel's Addons entry reconciled -- that is the state the page
  // offering them back is served from. Only a box with no manager at all has
  // nothing to repair.
  if (specs.length === 0 && !existsSync(`${SYSTEMD_DIR}/${MANAGER_UNIT}`)) {
    fatal("clp-addons is not installed; run install first");
  }

  ensureServiceUser(quiet);
  removeLegacyInstall(quiet);
  ensureDirs(all);
  // Unattended (timer-driven) reconciliation must not abort just because nobody is
  // currently logged into the panel; unlike install, warn and keep repairing.
  warnIfPanelSessionUnreadable();
  try {
    ensureAuthHelperReady();
  } catch (error) {
    log.warn(`panel auth helper check failed, continuing without it: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const spec of all) {
    writeConfig(spec, true);
    hardenBackups(spec, quiet);
  }
  removeLegacyUnits(quiet);
  removeLegacyUsers(quiet);
  reconcilePanelIdentity(quiet);
  const unitChanges = installUnits(all);
  ensureDirs(all);
  if (unitChanges.systemd || unitActive(MANAGER_UNIT) !== "active") startUnits();
  else {
    ensureTimerArmed("clp-addons-reconcile.timer", quiet);
    if (all.some((spec) => spec.name === "cloudflare-ips")) {
      ensureTimerArmed(CLOUDFLARE_RECONCILE_TIMER, quiet);
    }
  }
  reconcileAnchors(quiet);
  if (!reconcileMaintenanceNginx(quiet)) log.err("Nginx maintenance check is not ready; run repair after checking global_settings");
  if (!reconcileNginx(quiet)) log.err("Nginx proxy is not ready; run repair after checking the master vhost");
  // Runs after the master-vhost reconciliation above, not before: recovering
  // a carried-over vhost also does its own `nginx -t` before reloading, and
  // skips the reload if that check fails. Running prune first, while the
  // master vhost might still be broken, would leave a just-restored site
  // vhost on disk but unloaded until the next 15-minute cycle.
  await runAddonMaintenance(all);
  runManagerMaintenance();
  if (!quiet) log.ok(`repair complete (${specs.map((spec) => spec.name).join(", ") || "no addon enabled"})`);
}

function statusValue(value: string, ok: boolean): string {
  if (!process.stdout.isTTY) return value;
  return ok ? `\x1b[32m${value}\x1b[0m` : `\x1b[31m${value}\x1b[0m`;
}

function nginxStatus(status: NginxProxyStatus): string {
  if (status.state === "ok") return statusValue("VHost Injected & Verified ✓", true);
  return statusValue(status.detail ?? "Needs repair", false);
}

function maintenanceNginxStatus(status: MaintenanceNginxStatus): string {
  if (!existsSync(ADDONS.maintenance!.configFile)) return "Not enabled";
  if (status.state === "ok") return statusValue("Global Check Injected & Verified ✓", true);
  return statusValue(status.detail ?? "Needs repair", false);
}

export function anchorStatus(): string {
  const statuses = installedInjections().map((injection) => inspect(injection));
  if (statuses.length === 0) return "Not configured";
  const required = statuses.filter((status) => {
    if (status.addon === "manager") return true;
    const spec = ADDONS[status.addon];
    return spec?.targets.find((target) => target.slug === status.slug)?.required;
  });
  return required.every((status) => status.state === "ok")
    ? statusValue("Twig Templates Patched ✓", true)
    : statusValue("Needs repair", false);
}

function socketStatus(): string {
  let socket: ReturnType<typeof lstatSync>;
  try {
    socket = lstatSync(SOCKET_PATH);
  } catch {
    return statusValue(`UNIX Socket (${SOCKET_PATH}) — missing`, false);
  }

  const mode = socket.mode & 0o777;
  const modeText = mode.toString(8).padStart(4, "0");
  const owner = `${socket.uid}:${socket.gid}`;
  const details = `mode ${modeText}, owner ${owner}`;
  if (!socket.isSocket()) {
    return statusValue(`UNIX Socket (${SOCKET_PATH}) — not a socket (${details})`, false);
  }
  return mode === 0o660
    ? statusValue(`UNIX Socket (${SOCKET_PATH}) — ready (${details})`, true)
    : statusValue(`UNIX Socket (${SOCKET_PATH}) — not ready (${details}; expected mode 0660)`, false);
}

async function cmdStatus(): Promise<void> {
  const specs = installedAddons();
  const managerState = unitActive(MANAGER_UNIT);
  const active = managerState === "active";
  const pid = unitPid(MANAGER_UNIT);
  const line = "─".repeat(64);

  log.plain(` CloudPanel Addons  v${CLI_VERSION.replace(/^v/, "")}`);
  log.plain(line);
  log.plain(" Status");
  log.plain(`   • Manager unit ${statusValue(managerState, active)}`);
  log.plain(`   • Manager PID  ${statusValue(pid ?? "not available", active && pid !== null)}`);
  log.plain(`   • Socket       ${socketStatus()}`);
  log.plain(`   • Nginx       ${nginxStatus(inspectNginxProxy())}`);
  log.plain(`   • Maintenance ${maintenanceNginxStatus(inspectNginxMaintenance())}`);
  log.plain(`   • Anchors     ${anchorStatus()}`);
  log.plain();
  log.plain(" Installed Addons");
  log.plain("   NAME       ROUTE              ACTION        STATE");
  if (specs.length === 0) log.plain("   (none)");
  for (const spec of specs) {
    const action = secureRegularFile(CLI_BIN, true) ? "Verified ✓" : "Missing";
    const mounted = addonHandler(spec.name) !== undefined;
    const ready = active && mounted && action !== "Missing";
    const state = !mounted ? "not mounted" : action === "Missing" ? "action missing" : ready ? "ready" : "manager inactive";
    log.plain(`   ${spec.name.padEnd(10)} ${mountPath(spec.name).padEnd(18)} ${action.padEnd(13)} ${statusValue(state, ready)}`);
  }
  log.plain();
  log.plain(` Dashboard URL: ${dashboardUrl()}`);
  log.plain(line);
}

function listInstances(spec: AddonSpec): string[] {
  if (!existsSync(spec.stateDir)) return [];
  return readdirSync(spec.stateDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(`${spec.stateDir}/${entry.name}/meta.json`))
    .map((entry) => entry.name)
    .sort();
}

export function cmdUninstall(argv: string[]): void {
  requireRoot("uninstall");
  const { positional, flags } = parseFlags(argv);
  const spec = resolveAddon(positional[0]);
  if (!installedConfig(spec)) fatal(`${spec.name} is not installed`);
  withOperationLockSync(`uninstall ${spec.name}`, () => applyUninstall(spec, flags));
}

function applyUninstall(spec: AddonSpec, flags: Record<string, string | true>): void {
  const purge = flags.purge === true;
  const instances = listInstances(spec);
  const remaining = ADDON_NAMES.filter((name) => name !== spec.name && existsSync(ADDONS[name]!.configFile));

  if (flags.yes !== true) {
    const instanceText = instances.length
      ? instances.map((name) => `  - instance ${name}${purge ? ": container and data" : " (kept)"}`).join("\n")
      : "  - no instances found";
    fatal(
      `uninstall ${spec.name}\n` +
      `  - ${CLI_BIN} action ${spec.name}\n` +
      `  - ${spec.configFile}\n` +
      `  - ${purge ? `${spec.stateDir} and its instances` : `${spec.stateDir} (kept)`}\n` +
      `${instanceText}\n` +
      "Re-run with --yes to proceed.",
    );
  }

  if (!reconcileMaintenanceNginx(true, remaining.includes("maintenance"))) {
    fatal("could not safely update the Nginx maintenance check; no addon files were removed");
  }

  stopUnits(remaining.length > 0);
  removeLegacyInstall();
  reconcileAnchors(true, spec.name, remaining.length > 0);
  purgeTwigCache();
  if (purge) {
    const failed: string[] = [];
    if (spec.name === "instatic") {
      for (const domain of instances) {
        const result = tryRun(CLI_BIN, ["action", "instatic", "delete", "--domain", domain, "--confirm", domain]);
        if (!result.ok) {
          failed.push(domain);
          log.warn(`could not remove ${domain}: ${result.out}`);
        }
      }
    }
    if (failed.length > 0) {
      fatal(`could not remove ${spec.name} instances; state preserved for retry: ${failed.join(", ")}`);
    }
  }
  removeSudoers();
  if (spec.name === "wp-login") withdrawWpLogin();
  if (purge) rmSync(spec.stateDir, { recursive: true, force: true });
  rmSync(spec.configFile, { force: true });
  rmSync(`${spec.configFile}.new`, { force: true });

  if (remaining.length > 0) {
    ensureDirs(remaining.map((name) => ADDONS[name]!));
    reconcilePanelIdentity();
    installUnits(remaining.map((name) => ADDONS[name]!));
    startUnits();
    log.ok(`${spec.name} removed; remaining addons are still available`);
    return;
  }

  reconcileNginx(true, false);
  stopUnits();
  rmSync(CLI_BIN, { force: true });
  rmSync(LIBEXEC_DIR, { recursive: true, force: true });
  log.ok(`${spec.name} removed`);
}

function usage(): void {
  log.plain(`clp-addons ${CLI_VERSION} — CloudPanel Addons

  clp-addons install <addon> [--version=vX.Y.Z] [--skip-attestation] [--local=DIR]
  clp-addons update [--version=vX.Y.Z] [--skip-attestation]   (alias: upgrade)
  clp-addons repair [<addon>] [--quiet] [--anchors-only]
  clp-addons status
  clp-addons uninstall <addon> --yes [--purge]
  clp-addons maintenance <domain> [on|off|status]
  clp-addons action cloudflare-ips <list|set|policy|reconcile> [options]
  clp-addons action instatic <verb> [options]
  clp-addons action stager <verb> [options]
  clp-addons action maintenance <verb> --domain=<domain>
  clp-addons action git <verb> [--domain=<domain>] [--job=<job>]
  clp-addons action manager <enable|disable|update|job|watch-job> [--addon=<addon>] [--id=<job>]
  clp-addons action auth (session id on bounded stdin)
  clp-addons serve
  clp-addons --version

Addons: ${ADDON_NAMES.join(", ")}

Install enables bundled addon code without downloading a release. Use update
to upgrade the binary, or install --version to explicitly select a release.

The manager is served at ${mountPath("instatic").replace("/instatic", "")} through
the CloudPanel master vhost and authenticates with the CloudPanel cloudpanel session.`);
}

async function cmdAction(argv: string[]): Promise<number> {
  const [addon, ...rest] = argv;
  // Platform verbs, not addon verbs: the auth gateway and the manager are not
  // things an operator can enable, so they are dispatched before the catalog.
  if (addon === "auth") return runAuthActionStdin(rest);
  if (addon === "manager") return runManagerAction(rest, MANAGER_OPS);

  const spec = addon ? ADDONS[addon] : undefined;
  if (!spec?.action) fatal(`unknown action addon '${addon ?? ""}'`);
  if (!installedConfig(spec)) fatal(`the ${spec.name} addon is not installed`);
  return spec.action(rest);
}

async function cmdMaintenance(argv: string[]): Promise<void> {
  requireRoot("maintenance");
  if (!installedConfig(ADDONS.maintenance!)) fatal("the maintenance addon is not installed");
  const [rawDomain, operation = "status", ...extra] = argv;
  if (!rawDomain || extra.length > 0 || !["on", "off", "status"].includes(operation)) {
    fatal("usage: clp-addons maintenance <domain> [on|off|status]");
  }
  const verb = operation === "on" ? "enable" : operation === "off" ? "disable" : "status";
  try {
    const result = await executeMaintenanceAction([verb, `--domain=${rawDomain}`]) as {
      domain: string; enabled: boolean; customTemplate: boolean; bypasses: string[];
    };
    if (operation === "status") {
      log.plain(`${result.domain}: ${result.enabled ? "maintenance (503)" : "live"}`);
      log.plain(`Template: ${result.customTemplate ? "custom" : "default"}`);
      log.plain(`IP bypasses: ${result.bypasses.length ? result.bypasses.join(", ") : "none"}`);
    } else {
      log.ok(`${result.domain}: maintenance mode ${result.enabled ? "enabled" : "disabled"}`);
    }
  } catch (error) {
    fatal(error instanceof Error ? error.message : String(error));
  }
}

async function cmdOverview(): Promise<void> {
  log.plain(`CloudPanel Addons v${CLI_VERSION.replace(/^v/, "")}`);
  log.plain(`Dashboard: ${dashboardUrl()}`);
  const specs = installedAddons();
  log.plain(specs.length ? `Installed: ${specs.map((spec) => spec.name).join(", ")}` : "No addons installed");
  log.plain("Run 'clp-addons status' for service and integration details.");
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    await cmdOverview();
    return 0;
  }
  const [verb = "help", ...rest] = args;
  switch (verb) {
    case "overview": await cmdOverview(); return 0;
    case "--version":
    case "-v": log.plain(CLI_VERSION); return 0;
    case "install": await cmdInstall(rest); return 0;
    case "update":
    case "upgrade": await cmdUpdate(rest); return 0;
    case "self-update": fatal("self-update is deprecated; use clp-addons update");
    case "recon": await runRecon(); return 0;
    case "repair": await cmdRepair(rest); return 0;
    case "status": await cmdStatus(); return 0;
    case "maintenance": await cmdMaintenance(rest); return 0;
    case "uninstall": cmdUninstall(rest); return 0;
    case "action": return await cmdAction(rest);
    case "serve": return await cmdServe();
    case "help":
    case "--help":
    case "-h": usage(); return 0;
    default: log.err(`unknown command '${verb}'`); usage(); return 2;
  }
}

if (import.meta.main) {
  try {
    process.exit(await main());
  } catch (error) {
    if (error instanceof Fatal) {
      log.err(error.message);
      process.exit(1);
    }
    throw error;
  }
}

import type { Server } from "bun";
import { chmodSync, chownSync, existsSync, lstatSync, readFileSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  ARTIFACT_MANIFEST_PATH, CLI_ARTIFACT, CLI_BIN, CLOUDFLARE_RECONCILE_TIMER, CONFIG_DIR,
  LIBEXEC_DIR, MANAGER_UNIT, PANEL_GROUP,
  SOCKET_PATH, STATE_DIR, SYSTEMD_DIR, mountPath,
} from "./paths";
import {
  ADDONS, ADDON_NAMES, addonHandler, addonMaintenance, type AddonSpec,
} from "./addon-catalog";
import { CLI_VERSION, fetchVerified, loadLocal, resolveRelease, verifyAttestation, type FetchedArtifact } from "./release";
import {
  ensureDirs, ensureRequiredUnits, ensureServiceUser, ensureTimerArmed, hardenBackups,
  ensureAuthHelperReady, reconcilePanelIdentity, installUnits, installedConfig, purgeTwigCache, removeLegacyUnits,
  applyToggleUnits, platformProvisioned,
  removeLegacyInstall, removeLegacyUsers, removeSudoers, startUnits, stopUnits, unitActive,
  unitPid, warnIfPanelSessionUnreadable, writeConfig,
} from "./provision";
import {
  KNOWN_GOOD_PANEL_VERSIONS, inspect, inspectNginxMaintenance, inspectNginxProxy, masterVhostHost, panelVersion,
  purgeTwigCache as purgeInjectCache, reconcile, reconcileNginxMaintenance, reconcileNginxProxy,
  type Injection, type MaintenanceNginxStatus, type NginxProxyStatus, type TargetStatus,
} from "./inject";
import { fatal, Fatal, log, parseFlags, requireRoot, run, tryRun, writeAtomic } from "./util";
import { runRecon } from "./recon";
import { adminGate, authenticateRequest } from "../lib/sso-auth";
// Re-exported because the manager's tests name it here.
export { adminGate };
import { splitMount } from "../lib/mount";
import {
  esc, escJs, guardMutation, htmlResponse, jsonResponse, newCsrfToken,
  safeDecodePathSegment,
} from "../lib/app-http";
// Re-exported because this module was where it lived and the manager's tests
// and routes name it here.
export { safeDecodePathSegment };
import { JOB_STYLE, JOB_WATCH_JS, renderLayout } from "../lib/app-ui";
import { adminHeaderTarget, headerTarget, siteLayoutTarget, SITE_TAB_TEMPLATE } from "../lib/panel-nav";
import { checkCliUpdate, type CliUpdateInfo } from "../lib/update-check";
import { CHANGELOG_URL, UPDATE_PATH } from "../lib/update-ui";
import { ensureMaintenanceData, executeMaintenanceAction } from "../addons/maintenance/action";
import { GIT_HOOK_PREFIX, handleGitHook } from "../addons/git/app/hook";
import { removeWpLogin } from "../addons/wp-login/action";
import { runAuthActionStdin } from "./auth-action";
import { pruneManagerJobs, runManagerAction, type ManagerJobView, type ManagerOps } from "./manager-action";
import { callGatewayAction, streamGatewayAction, type ActionResult } from "../lib/gateway-client";
import { jobEventStream, type JobWatcher } from "../lib/job-stream";
import { JOB_ID_RE } from "./job-store";

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

function installArtifacts(artifacts: FetchedArtifact[], tag: string): void {
  writeAtomic(CLI_BIN, artifact(artifacts, CLI_ARTIFACT), 0o755);
  tryRun("chown", ["root:root", CLI_BIN]);
  writeArtifactManifest(tag, artifacts);
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
    installArtifacts(artifacts, target);
    if (flags["no-self-update"] !== true) {
      options.beforeManagerRestart?.();
      // Re-enter the stable public command rather than a new private command:
      // an explicit downgrade can target a release from before this handoff
      // existed. Such a binary still knows how to update itself. The internal
      // flag bounds the handoff in current releases and is ignored safely by
      // older ones, whose installed version already equals the requested tag.
      run(CLI_BIN, [
        "update",
        ...argv,
        `--version=${release.tag}`,
        "--no-self-update",
        `--updated-from=${current}`,
      ], { stdio: "inherit" });
      return;
    }
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
    const { removed } = removeWpLogin();
    if (removed > 0) log.ok(`sign-in helper removed from ${removed} site${removed === 1 ? "" : "s"}`);
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
  reconcile: () => {
    if (!reconcileAnchors(true)) fatal("could not safely patch the CloudPanel templates");
  },
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

function internalPath(path: string): string {
  if (path === "/addons" || path === "/addons/") return "/";
  if (path.startsWith("/addons/")) return path.slice("/addons".length).replace(/\/+$/, "") || "/";
  return path.replace(/\/+$/, "") || "/";
}

/** The manager's own privileged verbs go over the same gateway the addons use. */
async function managerAction<T>(verb: string, args: string[] = []): Promise<ActionResult<T>> {
  // The create verbs hand the work to systemd and return; nothing here waits
  // for an enable or an update to finish.
  return callGatewayAction<T>("manager", verb, args, undefined, { timeout: 30_000 });
}

async function latestManagerJobView(): Promise<ManagerJobView | null> {
  const result = await managerAction<{ job: ManagerJobView; log: string } | null>("job");
  return result.ok && result.data ? result.data.job : null;
}

function managerJson(body: unknown, status = 200): Response {
  return jsonResponse(body, { status });
}

/**
 * The manager's own API: update status, enable, disable, update, and following
 * the job each mutation starts.
 *
 * Every route here is already behind the SSO gate and the administrator gate at
 * the socket boundary; `guardMutation` adds the same origin and CSRF check the
 * addons use, so a page on another origin cannot spend an administrator's
 * session on a binary replacement.
 *
 * Returns null when the path is not one of these, so the caller can carry on.
 */
export async function handleManagerRoute(
  req: Request,
  path: string,
  server: Server<unknown>,
  update: CliUpdateInfo | null = null,
): Promise<Response | null> {
  if (path === "/api/update" && req.method === "GET") {
    return managerJson({ ok: true, data: update });
  }

  const addonRoute = path.match(/^\/api\/addons\/([^/]+)\/(enable|disable)$/);
  if (addonRoute && req.method === "POST") {
    const denied = guardMutation(req);
    if (denied) return denied;
    const name = safeDecodePathSegment(addonRoute[1]!);
    if (!name) return managerJson({ ok: false, error: "invalid addon name" }, 400);
    if (!ADDON_NAMES.includes(name)) return managerJson({ ok: false, error: "unknown addon" }, 404);
    const result = await managerAction(addonRoute[2]!, [`--addon=${name}`]);
    return managerJson(result, result.ok ? 200 : 400);
  }

  if (path === "/api/update" && req.method === "POST") {
    const denied = guardMutation(req);
    if (denied) return denied;
    const result = await managerAction("update");
    return managerJson(result, result.ok ? 200 : 400);
  }

  const jobRoute = path.match(/^\/api\/jobs\/([^/]+?)(\/events)?$/);
  if (jobRoute && req.method === "GET") {
    const id = safeDecodePathSegment(jobRoute[1]!);
    if (!id || !JOB_ID_RE.test(id)) return managerJson({ ok: false, error: "not a valid job id" }, 400);
    const getJob = (jobId: string) => managerAction<{ job: ManagerJobView; log: string }>("job", [`--id=${jobId}`]);
    const watchJob = (jobId: string, handlers: Parameters<JobWatcher<ManagerJobView>>[1]) => {
      let ended = false;
      const close = (error?: string) => {
        if (ended) return;
        ended = true;
        handlers.onClose(error);
      };
      return streamGatewayAction<{ job: ManagerJobView; log: string }>({
        addon: "manager",
        verb: "watch-job",
        args: [`--id=${jobId}`],
        onReply(reply) {
          if (reply.ok && reply.data) handlers.onSnapshot(reply.data);
          else if (!reply.ok) close(reply.error);
          else close("gateway returned an empty job snapshot");
        },
        onClose: close,
      });
    };
    if (jobRoute[2] || req.headers.get("accept")?.includes("text/event-stream")) {
      return jobEventStream({ id, req, server, getJob, watchJob });
    }
    const result = await getJob(id);
    return managerJson(result, result.ok ? 200 : 404);
  }

  return null;
}

/**
 * Which addons this manager serves, answered per request.
 *
 * This used to be a list built once at startup, which is why enabling an addon
 * had to restart the manager: until it did, the addon's own pages returned 404
 * from a process that had been told, at boot, that it did not exist. The handler
 * map is still compiled in and still explicit -- nothing is loaded dynamically.
 * What is dynamic is availability, and availability is a config file, so it is
 * read from the config files.
 *
 * Serving nothing is a legitimate state, not a failed start. Every addon is
 * compiled in, so a manager with none of them enabled still has a job: it is
 * the page that offers them back. Exiting instead meant disabling the last
 * addon killed the only surface that could re-enable it.
 */
function mountedAddons(): string[] {
  return ADDON_NAMES.filter((name) => addonHandler(name) && existsSync(ADDONS[name]!.configFile));
}

/**
 * The routes a signed-in non-administrator may reach, named one by one.
 *
 * An addon that declares `siteManager` is the other way in, for the whole
 * mount rather than a route: CloudPanel does not narrow a site manager's site
 * list, so its pages are already scoped for that role.
 *
 * The blanket gate below is what makes the manager an administrative surface,
 * and these are the exceptions that scope themselves instead. The WordPress
 * sign-in is one because the panel user it signs in for is one CloudPanel
 * already gave the site's file manager and database to, so the shortcut adds
 * no authority; the root action holds it to the sites `user_sites` maps to
 * that account. The session route hands out the CSRF pair those callers cannot
 * get from an addon page, and reads nothing. Panel Tweaks' state route is one
 * because the page it enhances is CloudPanel's own Sites page, which every
 * panel user sees; the action narrows the reply to the rows that page would
 * already have drawn for the caller.
 */
const SELF_SCOPED_ROUTES = new Set([
  "POST /wp-login/api/sign-in",
  "GET /wp-login/api/session",
  "GET /panel-tweaks/api/panel",
]);

/**
 * Every request the manager answers, in the order it decides them. Exported so
 * a test can send real requests through the same function the socket does.
 */
export async function handleRequest(req: Request, server: Server<unknown>): Promise<Response> {
  const path = internalPath(new URL(req.url).pathname);

  // The one credential that is not a CloudPanel session. A POST whose URL
  // carries a per-site token the root gateway recognises is a push-to-deploy
  // delivery and is answered here; anything else returns null and meets the
  // gate below, so this is a second credential type rather than an exception
  // list, and the URL is no oracle for which sites have a webhook.
  // Nothing is looked up for a request that is not shaped like one: the gate
  // below stays the first thing every other request meets.
  if (req.method === "POST" && path.startsWith(GIT_HOOK_PREFIX) && mountedAddons().includes("git")) {
    const delivery = await handleGitHook(req, path);
    if (delivery) return delivery;
  }

  // Nothing else is answered before this, not even the liveness probe: a route
  // decided ahead of the gate answers whoever can reach the panel.
  const gate = await authenticateRequest(req);
  // Sent as the gate built it. The shared header policy used to go over the
  // top, which is what made a refusal here look unlike the panel's own.
  if (gate.response) return gate.response;

  // The manager is an administrative surface. Keep this decision at the
  // shared socket boundary so every mounted HTML and API route, including
  // future handlers and the manager index, receives the same gate before
  // update checks or addon code can run.
  const denied = adminGate(gate.auth);
  if (denied) {
    const selfScoped = SELF_SCOPED_ROUTES.has(`${req.method} ${path}`);
    const siteManager = gate.auth?.roles.includes("ROLE_SITE_MANAGER") ?? false;
    if (!selfScoped && !siteManager) return denied;
    // Straight to the addon, ahead of the update check and the manager's own
    // routes: what this session is allowed is that handler, not the rest of
    // the manager with a narrower path.
    const scoped = splitMount(path, mountedAddons());
    if (!scoped) return denied;
    if (!selfScoped && ADDONS[scoped.addon]?.siteManager !== true) return denied;
    return await addonHandler(scoped.addon)!(req, scoped.rest, null, server, gate.auth);
  }

  // Polled while this process restarts; the gateway that validates the session
  // is a separate unit, so it keeps answering across the restart.
  if (path === "/health") {
    return jsonResponse({ ok: true, service: "clp-addons" });
  }

  const update = await checkCliUpdate(CLI_VERSION);
  const notice = update?.hasUpdate ? { current: update.current, latest: update.latest } : null;

  const managerRoute = await handleManagerRoute(req, path, server, update);
  if (managerRoute) return managerRoute;

  const hit = splitMount(path, mountedAddons());
  if (hit) return await addonHandler(hit.addon)!(req, hit.rest, notice, server, gate.auth);
  if (path === "/update" && req.method === "GET") {
    return updatePage(update, CLI_VERSION, { job: await latestManagerJobView(), csrf: newCsrfToken() });
  }
  if (path === "/") {
    // Read at request time rather than from the startup addon list: a job
    // that has just finished enabling an addon has not yet restarted this
    // process, and a page that still denied the addon existed would be
    // wrong for exactly as long as anybody was likely to look at it.
    const enabled = ADDON_NAMES.filter((name) => existsSync(ADDONS[name]!.configFile));
    return indexPage(enabled, notice, {
      available: ADDON_NAMES.filter((name) => !enabled.includes(name)),
      job: await latestManagerJobView(),
      csrf: newCsrfToken(),
    });
  }
  return jsonResponse({ ok: false, error: "not found" }, { status: 404 });
}

/**
 * Starts the manager on its Unix socket and remains pending for the process
 * lifetime. The restrictive socket-creation umask is restored before setup
 * continues or an error escapes.
 */
async function cmdServe(): Promise<never> {
  const socketDir = SOCKET_PATH.slice(0, SOCKET_PATH.lastIndexOf("/"));
  if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH);
  const prevUmask = process.umask(0o007);
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      unix: SOCKET_PATH,
      // Bun renders its own error page, stack trace included, unless NODE_ENV
      // is production, and the unit sets no NODE_ENV.
      development: false,
      error(error) {
        console.error("[clp-addons] request failed:", error);
        return jsonResponse({ ok: false, error: "internal error" }, { status: 500 });
      },
      fetch: handleRequest,
    });
  } finally {
    process.umask(prevUmask);
  }

  chmodSync(SOCKET_PATH, 0o660);
  const groupId = Number.parseInt(execFileSync("getent", ["group", PANEL_GROUP], { encoding: "utf-8" }).split(":")[2] ?? "", 10);
  if (!Number.isInteger(groupId)) throw new Error(`could not resolve group ${PANEL_GROUP}`);
  chownSync(SOCKET_PATH, -1, groupId);
  chmodSync(SOCKET_PATH, 0o660);
  log.plain(`[clp-addons] listening on ${socketDir}/manager.sock`);
  process.on("uncaughtException", (error) => console.error("[clp-addons] uncaught exception:", error));
  process.on("unhandledRejection", (error) => console.error("[clp-addons] unhandled rejection:", error));
  void server;
  return new Promise<never>(() => {});
}

const MANAGER_INDEX_CSS = `
.addon-card .actions { margin-top: auto; }
.addon-card .addon-status { align-self: center; }
.manager-job-status { width: 100%; margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--border); }
.manager-job-status .job-summary { justify-content: space-between; }
.manager-job-status .step { margin: 6px 0 0; overflow-wrap: anywhere; }
.job-log-details { margin-top: 10px; }
.job-log-details summary { color: var(--muted); font-size: 14px; cursor: pointer; }
.job-log-details pre { max-height: 240px; margin: 10px 0 0; }
.addon-section { margin-top: 30px; }
.addon-section h2 { margin: 0 0 20px; font-size: 20px; }
.update-page { max-width: 800px; margin: 0 auto; }
.update-versions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 24px; margin: 0 0 25px; }
.update-versions dt { color: var(--muted); font-size: 14px; margin-bottom: 8px; }
.update-versions dd { margin: 0; font-family: var(--mono); font-size: 22px; overflow-wrap: anywhere; }
.update-page .card-header { flex-wrap: wrap; }
.update-page .update-actions { border-top: 1px solid var(--border); padding-top: 20px; margin-top: 25px; }
@media (max-width: 480px) {
  .update-versions { grid-template-columns: minmax(0, 1fr); }
}
`;

const MANAGER_INDEX_JS = `
function managerJobCard(source, key, standalone) {
  const fromSource = source && typeof source.closest === 'function'
    ? source.closest('[data-manager-job-card]')
    : null;
  if (fromSource) return fromSource;
  if (!key) return null;
  const owner = Array.from(CLP_ROOT.querySelectorAll('[data-manager-job-card]')).find(function (candidate) {
    return candidate.getAttribute('data-manager-job-card') === key;
  }) || null;
  if (owner || !standalone) return owner;

  const card = document.createElement('article');
  card.className = 'card';
  card.setAttribute('data-manager-job-card', key);
  // Where the server puts a job no card claims: under the heading and above the
  // cards, not below everything else the page has to show.
  const heading = CLP_ROOT.querySelector('.page-heading');
  if (heading && heading.parentNode) heading.parentNode.insertBefore(card, heading.nextSibling);
  else {
    const parent = CLP_ROOT.querySelector('main') || CLP_ROOT.body || CLP_ROOT;
    if (parent && typeof parent.appendChild === 'function') parent.appendChild(card);
  }
  return card;
}

function describeManagerJob(job) {
  if (!job) return 'Working';
  if (job.kind === 'update') return 'Updating clp-addons';
  return (job.kind === 'disable' ? 'Disabling ' : 'Enabling ') + (job.addon || 'an addon');
}

function showJob(title, card) {
  if (!card) return;
  let status = card.querySelector('[data-manager-job-status]');
  if (!status) {
    status = document.createElement('div');
    status.className = 'manager-job-status';
    status.setAttribute('data-manager-job-status', '');
    status.setAttribute('aria-live', 'polite');
    status.innerHTML = '<div class="job-summary">' +
      '<strong id="job-title"></strong>' +
      '<span class="badge state-queued" id="job-state">queued</span>' +
      '</div>' +
      '<p class="step" id="job-step">Starting…</p>' +
      '<details class="job-log-details"><summary>Output</summary><pre id="job-log">(no output yet)</pre></details>';
    card.appendChild(status);
  }
  status.hidden = false;
  const heading = status.querySelector('#job-title');
  if (heading && title) heading.textContent = title;
  const state = status.querySelector('#job-state');
  if (state) {
    state.textContent = 'queued';
    state.className = 'badge state-queued';
  }
  const step = status.querySelector('#job-step');
  if (step) step.textContent = 'Starting…';
}

// Every one of these restarts the manager, so the reply we are waiting for is
// only ever a job id: the outcome arrives through the job record, which
// survives the restart that kills this page's connection.
async function startManagerJob(path, title, source, key) {
  const card = managerJobCard(source, key);
  busy(true);
  try {
    const res = await call(path, { method: 'POST' });
    const id = res.data && res.data.jobId;
    if (!id) throw new Error('the manager did not start a job');
    // A duplicate request follows the job that is already running. Its owner
    // is authoritative; the clicked card is only for a newly created job.
    const existing = res.data.existing === true;
    const running = existing ? res.data.job : null;
    const jobKey = running && running.kind === 'update' ? 'update' : (running && running.addon) || 'manager-job';
    const jobCard = existing ? managerJobCard(null, jobKey, true) : card;
    showJob(existing ? describeManagerJob(running) : title, jobCard);
    watchJob(id, jobCard);
  } catch (err) {
    busy(false);
    // In the page rather than in a modal the browser owns, which would cover
    // the card it is talking about and lose it on dismissal.
    notify(err.message, 'error');
  }
}

function enableAddon(name, source) {
  clearNotice();
  startManagerJob('/api/addons/' + encodeURIComponent(name) + '/enable', 'Enabling ' + name, source, name);
}

// The same dialog every addon uses for a decision an operator has to make, so
// disabling one reads the way turning on global maintenance does. The browser's
// confirm() said the same words in a box this project does not style, cannot
// carry a details list in, and which reads as the page having gone wrong.
async function disableAddon(name, title, source) {
  const accepted = await confirmAction({
    // The name the card shows, not the slug the route takes: an operator
    // reading "Disable instatic?" under a card headed "Instatic CMS" has to
    // stop and match them up.
    title: 'Disable ' + (title || name) + '?',
    text: 'It stops appearing in CloudPanel and its pages stop answering.',
    details: [
      'Nothing it created is deleted: its data is kept and enabling it again returns the same instances.',
      // Double-quoted because of the apostrophe: this is JavaScript inside a
      // TypeScript template literal, where a backslash escape is eaten before
      // the browser ever sees it.
      "Anything it injected into CloudPanel's own pages is removed.",
    ],
    confirmLabel: 'Disable',
    danger: true,
  });
  if (!accepted) return;
  clearNotice();
  startManagerJob('/api/addons/' + encodeURIComponent(name) + '/disable', 'Disabling ' + name, source, name);
}

function updateNow(source) {
  startManagerJob('/api/update', 'Updating clp-addons', source, 'update');
}

// A failure is worth showing once. Remembering the dismissal by job id keeps it
// from reappearing on every visit without needing the server to record that
// somebody has read it.
function dismissFailure(id) {
  try { localStorage.setItem('clp-addons-seen-job', id); } catch (e) {}
  const alertBox = document.getElementById('job-failure');
  if (alertBox) alertBox.remove();
}

(function () {
  const alertBox = document.getElementById('job-failure');
  if (!alertBox) return;
  let seen = null;
  try { seen = localStorage.getItem('clp-addons-seen-job'); } catch (e) {}
  if (seen === alertBox.getAttribute('data-job')) alertBox.remove();
})();
`;

/** Renders the manager card for a known addon, or nothing for an unknown name. */
function addonCard(name: string, enabled: boolean, job: ManagerJobView | null = null): string {
  const spec = ADDONS[name];
  if (!spec) return "";
  const title = spec.title ?? spec.name;
  const description = spec.description ? `<p>${esc(spec.description)}</p>` : "";
  const mounted = addonHandler(spec.name) !== undefined;
  const live = liveManagerJob(job);
  const addonJob = live && live.addon === spec.name ? live : null;
  const actions = enabled
    ? `${mounted ? `<a class="btn btn-primary btn-lg" href="${esc(`${mountPath(spec.name)}/`)}" aria-label="Open ${esc(title)}">Open</a>` : '<span class="badge state-running addon-status">Enabled</span>'}
    <button class="btn btn-danger btn-lg" type="button" onclick="disableAddon('${escJs(spec.name)}', '${escJs(title)}', this)">Disable</button>`
    : `<button class="btn btn-primary btn-lg" type="button" onclick="enableAddon('${escJs(spec.name)}', this)">Enable ${esc(title)}</button>`;
  return `<article class="card addon-card" data-manager-job-card="${esc(spec.name)}">
  <div class="card-header"><h2>${esc(title)}</h2></div>
  ${description}
  <div class="actions">${actions}</div>
  ${addonJob ? managerJobStatus(addonJob) : ""}
</article>`;
}

function liveManagerJob(job: ManagerJobView | null): ManagerJobView | null {
  return job && (job.state === "queued" || job.state === "running") ? job : null;
}

/**
 * Live manager progress stays with the card whose action started the job.
 *
 * The log is behind a summary rather than gone: enabling an addon that has to
 * install Docker spends minutes on one step, and what it is doing is in the
 * log. Closed by default, because the state and the step are what a card has
 * room for.
 */
function managerJobStatus(job: ManagerJobView): string {
  return `<div class="manager-job-status" data-manager-job-status aria-live="polite">
  <div class="job-summary">
    <strong id="job-title">${esc(describeJob(job))}</strong>
    <span class="badge state-${esc(job.state)}" id="job-state">${esc(job.state)}</span>
  </div>
  <p class="step" id="job-step">${esc(job.step)}</p>
  ${JOB_LOG_DETAILS}
</div>`;
}

const JOB_LOG_DETAILS = `<details class="job-log-details">
    <summary>Output</summary>
    <pre id="job-log">(no output yet)</pre>
  </details>`;

/**
 * A job with no card of its own -- an update watched from the index, an enable
 * watched from the update page -- still has to be visible, so it takes a block
 * of its own above the cards.
 */
function managerJobBlock(job: ManagerJobView | null, homeCard: string | null): string {
  const live = liveManagerJob(job);
  if (!live || managerJobKey(live) === homeCard) return "";
  return `<article class="card" data-manager-job-card="${esc(managerJobKey(live))}">${managerJobStatus(live)}</article>`;
}

/** The card a job belongs to: the addon it is about, or the update page's own. */
function managerJobKey(job: ManagerJobView): string {
  return job.kind === "update" ? "update" : job.addon;
}

/** Failure details survive navigation without creating a second progress card. */
function managerJobFailure(job: ManagerJobView | null): string {
  const failure = job && job.state === "failed" ? job : null;
  const failureBlock = failure
    ? `<div class="alert" id="job-failure" data-job="${esc(failure.id)}">
  <strong>${esc(describeJob(failure))} failed.</strong> ${esc(failure.error || "No reason was recorded.")}
  <button class="btn" type="button" onclick="dismissFailure('${escJs(failure.id)}')">Dismiss</button>
</div>`
    : "";
  return failureBlock;
}

type ManagerPageOptions = { job?: ManagerJobView | null; csrf?: string };

/** The manager index: enabled addons, bundled addons available to enable, and progress. */
export function indexPage(
  enabled: string[],
  update?: { current: string; latest: string } | null,
  options: ManagerPageOptions & { available?: string[] } = {},
): Response {
  const available = options.available ?? [];
  const cards = enabled.map((name) => addonCard(name, true, options.job ?? null)).join("");
  const availableCards = available.map((name) => addonCard(name, false, options.job ?? null)).join("");

  const live = liveManagerJob(options.job ?? null);
  const claimed = live && [...enabled, ...available].includes(managerJobKey(live)) ? managerJobKey(live) : null;
  const content = `<div class="page-heading"><h1>Addons</h1><a class="btn" href="${UPDATE_PATH}">Updates</a></div>` +
    managerJobFailure(options.job ?? null) +
    managerJobBlock(options.job ?? null, claimed) +
    (cards
      ? `<div class="addon-grid">${cards}</div>`
      : `<div class="card empty">${esc(available.length
        ? "No addons are enabled. Enable one below to add it to CloudPanel."
        : "No addons are currently available.")}</div>`) +
    (availableCards
      ? `<section class="addon-section"><h2>Available</h2><div class="addon-grid">${availableCards}</div></section>`
      : "");

  return managerPage("CloudPanel Addons", content, update, options);
}

/** A GET only shows the release; installation still requires a guarded POST. */
export function updatePage(
  info: CliUpdateInfo | null,
  currentVersion = CLI_VERSION,
  options: ManagerPageOptions = {},
): Response {
  const update = info?.hasUpdate ? info : null;
  const live = liveManagerJob(options.job ?? null);
  const development = currentVersion === "0.0.0-dev";
  const status = update ? "Update available" : info ? "Up to date" : development ? "Development build" : "Unable to check";
  const message = update
    ? "Install the latest release of CloudPanel Addons. The Addons manager will restart briefly during the update."
    : info ? "No newer release is available for this installation."
    : development ? "Update checks are disabled for development builds."
    : "We could not check for a new release. Try again later or view the changelog on GitHub.";
  const content = `<div class="update-page">
  <div class="page-heading"><h1>Update CloudPanel Addons</h1><a class="btn" href="/addons/">Back to Addons</a></div>
  ${managerJobFailure(options.job ?? null)}
  ${managerJobBlock(options.job ?? null, "update")}
  <article class="card" data-manager-job-card="update">
    <div class="card-header"><h2>CloudPanel Addons</h2><span class="badge ${update ? "state-queued" : info ? "state-done" : "state-unknown"}">${status}</span></div>
    <dl class="update-versions">
      <div><dt>Installed version</dt><dd>v${esc((info?.current ?? currentVersion).replace(/^v/, ""))}</dd></div>
      <div><dt>Latest release</dt><dd>${info ? `v${esc(info.latest)}` : "Unavailable"}</dd></div>
    </dl>
    <p>${message}</p>
    <div class="actions update-actions">
      <a class="btn" href="${CHANGELOG_URL}" target="_blank" rel="noopener noreferrer">Changelog</a>
      ${update ? `<button class="btn btn-primary" type="button" onclick="updateNow(this)"${live ? " disabled" : ""}>Install update</button>` : ""}
    </div>
    ${live && live.kind === "update" ? managerJobStatus(live) : ""}
    ${live && live.kind !== "update" ? '<p class="hint">Another addon operation is in progress; the update can start once it finishes.</p>' : ""}
  </article>
</div>`;
  return managerPage("Update CloudPanel Addons", content, update, options);
}

function managerPage(
  title: string,
  content: string,
  update: { current: string; latest: string } | null | undefined,
  options: ManagerPageOptions,
): Response {
  const job = options.job;
  const live = liveManagerJob(job ?? null);
  return htmlResponse(renderLayout(title, content, {
    brand: "CloudPanel Addons",
    base: "/addons",
    nav: [],
    css: JOB_STYLE + MANAGER_INDEX_CSS,
    script: MANAGER_INDEX_JS + JOB_WATCH_JS + (live ? `
const managerJobTarget = CLP_ROOT.querySelector('[data-manager-job-status]');
watchJob('${escJs(live.id)}', managerJobTarget ? managerJobTarget.closest('[data-manager-job-card]') : null);
` : ""),
    updateNotice: update,
  }), { csrf: options.csrf });
}

/** How a job is named in the UI: "Enabling stager", "Updating clp-addons". */
function describeJob(job: ManagerJobView): string {
  if (job.kind === "update") return "Updating clp-addons";
  const verb = job.kind === "disable" ? "Disabling" : "Enabling";
  return `${verb} ${job.addon || "an addon"}`;
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

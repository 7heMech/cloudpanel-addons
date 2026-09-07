// clp-addons: run as root on the CloudPanel host.
//
// Bootstrapped once by the curl installer, then self-updating. `repair` is
// `install` minus the download and is idempotent, so the reconciliation timer
// calls it rather than duplicating the logic.

import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import {
  ADDON_NAMES, ADDONS, CLI_ARTIFACT, CLI_BIN, CURRENT_LINK, LIB_DIR, MANAGER_PORT, MANAGER_UNIT,
  PLATFORM_CONFIG, RELEASES_DIR, SITE_CREATED_MARKER, mountPath, type AddonSpec,
} from "./paths";
import { CLI_VERSION, fetchVerified, loadLocal, resolveRelease, verifyAttestation, type ResolvedRelease } from "./release";
import {
  addonIsAtRelease, assertNotInDockerGroup, currentRelease, describeAuthState, ensureDirs, ensureManagerSite,
  ensureSharedGroup, hardenSiteUser,
  installSudoers, installUnits, installWrapper, placeRelease, pruneReleases, readOwnDomain, readPlatformDomain,
  releaseArtifacts,
  ensureTimerArmed, hardenBackups, removeLegacyUsers, removeSudoers, resolveSiteUser, siteBasicAuth,
  siteUserOf, siteUserState,
  removeLegacyUnits, startUnits, stopUnits, timerNextElapse, unitActive,
  unitRunningUser, writeConfig, writePlatformConfig,
} from "./provision";
import { Fatal, fatal, log, parseFlags, requireRoot, run, tryRun, writeAtomic } from "./util";
import {
  KNOWN_GOOD_PANEL_VERSIONS, inspect, panelVersion, purgeTwigCache, reconcile,
  type Injection, type TargetStatus,
} from "./inject";
import { generateSnapshot } from "../lib/panel-snapshot";
import { SNAPSHOT_FILE } from "../lib/snapshot-reader";
import { handle as handleInstatic } from "../addons/instatic/app/index";
import { handle as handleStager } from "../addons/stager/app/index";
import { splitMount } from "../lib/mount";
import { SECURITY_HEADERS, esc } from "../lib/app-http";
import { renderLayout } from "../lib/app-ui";

/**
 * Each addon's request handler, bundled into this binary.
 *
 * The addon modules export a handler rather than serving on import, so naming
 * one here costs nothing at startup for the commands that are not `serve`, and
 * one process can mount all of them. The registry in paths.ts stays free of it:
 * that file is imported by the addons' own inject/targets.ts, and a value import
 * back the other way would close the cycle.
 */
type AddonHandler = (req: Request, path: string) => Promise<Response>;
const MANAGERS: Record<string, AddonHandler> = {
  instatic: handleInstatic,
  stager: handleStager,
};

function resolveAddon(name: string | undefined): AddonSpec {
  const key = name ?? "instatic";
  const spec = ADDONS[key];
  if (!spec) fatal(`unknown addon '${key}'. Available: ${ADDON_NAMES.join(", ")}`);
  return spec;
}

function describeTarget(s: TargetStatus): string {
  switch (s.state) {
    case "ok": return "present";
    case "missing-anchor": return "MISSING (repair will re-inject)";
    case "stale-content": return "STALE (points at an old URL; repair will rewrite it)";
    case "template-absent": return "template not found on this box";
    case "anchor-not-found-in-markup": return "ANCHOR MARKUP GONE — patch needs rebuilding";
    case "upstream-changed":
      return `UPSTREAM CHANGED — refusing to patch (expected ${s.expected.slice(0, 12)}, found ${s.found.slice(0, 12)})`;
  }
}

/**
 * How the manager's own site is protected, in one line.
 *
 * This is the precondition the README leads with: the manager can create and
 * delete CloudPanel sites, so it must not be reachable without authentication.
 * Until now `status` had nothing to say about it, which made the one command an
 * operator runs to check the install silent on the thing that matters most.
 */
function describeSiteAuth(domain: string | null): string {
  if (!domain) return "unknown (no configured domain)";
  return describeAuthState(siteBasicAuth(domain));
}

// --- anchors ----------------------------------------------------------------

/**
 * Re-apply the panel-side anchors. Stops rather than patching when upstream's
 * markup has moved: applying a patch built for the old markup is worse than
 * having no link.
 */
/**
 * Every patch every installed addon wants, in one list.
 *
 * A template is shared, so it cannot be rendered for one addon at a time: the
 * injector needs the whole set to rebuild a file from pristine. `exclude` is
 * how uninstall works -- reconciling without an addon's injections is what
 * removes its markup, rather than a separate removal path that could disagree.
 */
function installedInjections(exclude?: string): Injection[] {
  const out: Injection[] = [];
  for (const name of ADDON_NAMES) {
    if (name === exclude) continue;
    const s = ADDONS[name]!;
    if (!existsSync(s.configFile)) continue;
    const domain = readOwnDomain(s);
    if (!domain) continue;
    // One host, one path per addon. The injector only ever sees the finished
    // URL, so mounting is a fact about the platform rather than about a patch.
    for (const target of s.targets) {
      out.push({ addon: name, target, url: `https://${domain}${mountPath(name)}` });
    }
  }
  return out;
}

function reconcileAnchors(quiet: boolean, exclude?: string): boolean {
  const injections = installedInjections(exclude);
  const wanted = new Map(injections.map((i) => [`${i.addon}:${i.target.slug}`, i]));
  const { statuses, changed } = reconcile(injections);

  let blocked = false;
  for (const st of statuses) {
    const key = `${st.addon}:${st.slug}`;
    const inj = wanted.get(key);
    if (!inj) continue;

    if (st.state === "ok") {
      if (!quiet) log.ok(`anchor ${key}: present`);
      continue;
    }
    if (st.state === "template-absent") {
      log.warn(`anchor ${key}: ${describeTarget(st)}`);
      continue;
    }
    log.err(`anchor ${key}: ${describeTarget(st)}`);
    if (st.state === "upstream-changed" || st.state === "anchor-not-found-in-markup") {
      log.err(
        `  CloudPanel ${panelVersion()} has changed the markup this patch targets.\n` +
          `  Not applying it. Rebuild the patch against the new markup, then run repair again.\n` +
          `  Known good against: ${KNOWN_GOOD_PANEL_VERSIONS.join(", ")}`
      );
    }
    if (inj.target.required) blocked = true;
  }

  // Purging is mandatory, not optional: Twig serves the compiled copy until
  // the cache is gone.
  if (changed) {
    purgeTwigCache();
    log.ok("Twig cache purged");
  }
  if (blocked) log.warn("a required anchor could not be applied; the nav entry will be absent");
  return changed;
}

// --- commands ---------------------------------------------------------------

async function cmdInstall(argv: string[]): Promise<void> {
  requireRoot("install");
  const { positional, flags } = parseFlags(argv);
  const spec = resolveAddon(positional[0]);

  // One CloudPanel site serves every addon, so the hostname belongs to the
  // platform rather than to this addon. The first install names it; later ones
  // inherit it, and may only re-state it if it matches -- silently moving every
  // installed addon to a new hostname because one install said so would take the
  // others offline, and the operator asked about one addon.
  const given = typeof flags.domain === "string" ? flags.domain : null;
  if (given && !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(given)) {
    fatal(`--domain='${given}' is not a valid hostname`);
  }
  const established = platformDomain();
  if (established && given && given !== established) {
    fatal(
      `the addons are already served from ${established}, and there is one site for all of them.\n` +
        `  Install ${spec.name} without --domain to add it there, or uninstall the others first\n` +
        `  if you mean to move the whole thing to ${given}.`
    );
  }
  if (!established && !given) {
    fatal(
      `install needs --domain=<hostname> for the CloudPanel site the addons are served from.\n` +
        `  Example: clp-addons install ${spec.name} --domain=addons.example.com\n` +
        `  Every addon is mounted under a path on it, so this is asked once.`
    );
  }
  const domain = (given ?? established)!;

  for (const unit of spec.requiresUnits ?? []) {
    if (!tryRun("systemctl", ["is-active", unit]).ok) {
      fatal(`${unit} is not active. Install and start it before installing ${spec.name}.`);
    }
  }

  // Not just this addon's. `current` is shared, so a release tree carrying only
  // the addon being installed would break every addon already running from it.
  const alsoInstalled = installedAddons().filter((s) => s.name !== spec.name);
  const wantedArtifacts = releaseArtifacts([spec, ...alsoInstalled]);
  let tag: string;
  let artifacts;
  if (typeof flags.local === "string") {
    tag = `local-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    log.step(`installing ${spec.name} from the local build in ${flags.local}`);
    artifacts = loadLocal(flags.local, wantedArtifacts);
  } else {
    const rel = await resolveRelease(
      typeof flags.version === "string" ? flags.version : "latest",
      flags["allow-prerelease"] === true
    );
    tag = rel.tag;
    log.step(`installing ${spec.name} from release ${rel.tag}`);
    artifacts = await fetchVerified(rel, wantedArtifacts);
    await verifyAttestation(rel, artifacts, flags["skip-attestation"] === true);
  }

  // The site has to exist before anything else: the account the manager runs
  // as is the one CloudPanel creates for it (decision 2.4).
  const siteCreated = ensureManagerSite(domain);
  const user = resolveSiteUser(domain);
  hardenSiteUser(user);
  assertNotInDockerGroup(user);
  ensureSharedGroup(user);
  ensureDirs(spec);
  hardenBackups(spec);

  placeRelease(tag, artifacts, wantedArtifacts);
  pruneReleases();

  const wrapper = artifacts.find((a) => a.name === spec.wrapperArtifact)!;
  installWrapper(spec, wrapper.bytes);
  installSudoers(spec, user);

  // Place the CLI itself last among the binaries, so a failure earlier leaves
  // the previous working CLI in place.
  const cli = artifacts.find((a) => a.name === CLI_ARTIFACT)!;
  writeAtomic(CLI_BIN, cli.bytes, 0o755);

  writePlatformConfig(domain, user);
  writeConfig(spec, domain, user, true);

  // Remember whether the site is ours to delete. `uninstall --purge` reads this:
  // a site that already existed and was adopted was serving something before the
  // addons arrived, and removing it would take that with it. Absent marker means
  // "not ours", so an install predating this file is treated as adopted rather
  // than guessed at. Platform-level, like the site it describes.
  if (siteCreated) writeAtomic(SITE_CREATED_MARKER, domain, 0o600);

  // Every installed addon, because there is one unit and it serves all of them:
  // installing a second addon has to add its routes to the running manager.
  const serving = installedAddons();
  removeLegacyUnits();
  installUnits(serving, user);
  log.step("generating the sanitized panel snapshot");
  generateSnapshot();
  for (const sp of serving) ensureDirs(sp);
  startUnits();
  removeLegacyUsers(user);

  reconcileAnchors(false);

  // The catch-up loop that used to live here -- re-adding the shared group to
  // every other addon's account and restarting its unit -- is gone with the
  // second account and the second unit. There is one of each, and both were just
  // written above.

  log.plain();
  log.ok(`${spec.name} ${tag} installed.`);
  log.plain(`  Manager UI:  https://${domain}${mountPath(spec.name)}`);
  if (serving.length > 1) {
    log.plain(`  Also here:   ${serving.filter((sp) => sp.name !== spec.name)
      .map((sp) => `https://${domain}${mountPath(sp.name)}`).join(", ")}`);
  }

  // Say what is actually true rather than reciting the same two steps whether or
  // not they are already done. On a reinstall they usually are.
  const auth = siteBasicAuth(domain);
  if (auth.panelManaged && auth.active) {
    log.ok(`  ${domain} is behind CloudPanel Basic Auth${auth.ipAllowlist ? " and an IP allowlist" : ""}`);
  } else if (auth.vhostOnly) {
    log.warn(
      `  ${domain} has basic auth in its vhost but not in the panel's own record.\n` +
        `  The Security tab shows it as off, so switching it there can rewrite the edit away.\n` +
        `  Re-add it through Site → Security → Basic Auth so the panel owns it.`
    );
  } else {
    log.err(
      `  ${domain} is reachable without authentication. The manager can create and\n` +
        `  delete CloudPanel sites, so add Site → Security → Basic Auth now. That page\n` +
        `  also carries the IP allowlist.`
    );
  }
  log.plain(`  Certificate: clpctl lets-encrypt:install:certificate --domainName=${domain}`);
}

async function cmdUpdate(argv: string[]): Promise<void> {
  requireRoot("update");
  const { positional, flags } = parseFlags(argv);
  // No addon named means every installed one, same as repair. `--all` stays as
  // the explicit form and now means the same thing.
  const targets = positional[0]
    ? [positional[0]]
    : (flags.all === true ? ADDON_NAMES : installedAddons().map((s) => s.name));
  if (targets.length === 0) fatal("no addon is installed; run install first");

  // Resolved once. It used to be asked per addon, which was an API round trip
  // per addon for an answer that cannot differ between them.
  const wanted = typeof flags.version === "string" ? flags.version : "latest";
  const rel = await resolveRelease(wanted, flags["allow-prerelease"] === true);

  // The CLI before the addons. If it moves, this call does not come back: it
  // re-runs the command as the CLI it just installed.
  await selfUpdateFirst(rel, flags);

  for (const name of targets) {
    const spec = resolveAddon(name);

    // Per addon, not per release tree. `currentRelease()` is shared, so asking it
    // here meant the first addon updated and every later one was skipped.
    if (addonIsAtRelease(spec, rel.tag)) {
      log.ok(`${spec.name} is already on ${rel.tag}`);
      continue;
    }

    // Every installed addon's artifacts, for the same reason install fetches
    // them: this call moves `current`, and the addons not named here go on
    // running from it.
    const wantedArtifacts = releaseArtifacts(
      [spec, ...installedAddons().filter((s) => s.name !== spec.name)]
    );
    const artifacts = await fetchVerified(rel, wantedArtifacts);
    await verifyAttestation(rel, artifacts, flags["skip-attestation"] === true);

    // Resolve who this runs as before stopping anything. Both of these can
    // fail -- a missing config, a panel site deleted from under us -- and
    // failing after the stop leaves the manager down with nothing installed to
    // replace it.
    const domain = platformDomain();
    if (!domain) fatal("no configured domain; run install first");
    const user = resolveSiteUser(domain);

    // The wrapper is synchronous and short-lived, so draining is simple: stop
    // the manager, which is the only caller, then swap. It serves every addon
    // now, so this is a brief outage for all of them rather than for one -- the
    // price of one process, and an update is already a restart.
    log.step(`stopping ${MANAGER_UNIT} before the swap`);
    tryRun("systemctl", ["stop", MANAGER_UNIT]);

    placeRelease(rel.tag, artifacts, wantedArtifacts);
    installWrapper(spec, artifacts.find((a) => a.name === spec.wrapperArtifact)!.bytes);
    installSudoers(spec, user);
    writeAtomic(CLI_BIN, artifacts.find((a) => a.name === CLI_ARTIFACT)!.bytes, 0o755);

    writePlatformConfig(domain, user);
    writeConfig(spec, domain, user);

    installUnits(installedAddons(), user);
    startUnits();
    reconcileAnchors(false);
    pruneReleases();
    log.ok(`${spec.name} updated to ${rel.tag}`);
  }
}

/**
 * Bring the CLI to the target release before it updates anything else, and hand
 * over to the copy just written.
 *
 * Replacing ${CLI_BIN} does not change the process already running, so without
 * the hand-over the *old* CLI would go on to update the addons using its own
 * idea of what a release contains. That is not hypothetical: v0.6.0 merged the
 * per-addon app binaries into one, so a v0.5.2 CLI asked it for
 * `instatic-app-linux-x64` and stopped. Doing the CLI first only helps if what
 * continues is the new one.
 *
 * Either returns, having found nothing to do, or hands over and never comes
 * back -- so the caller can simply carry on afterwards.
 *
 * The re-run carries --no-self-update so this can happen at most once. A version
 * that never compares equal -- a local build reports 0.0.0-dev -- would otherwise
 * be an infinite loop rather than a failed update.
 */
async function selfUpdateFirst(rel: ResolvedRelease, flags: Record<string, string | true>): Promise<void> {
  if (flags["no-self-update"] === true) return;
  const target = rel.tag.replace(/^v/, "");
  if (CLI_VERSION === target) return;

  log.step(`updating clp-addons itself from ${CLI_VERSION} to ${target} first`);
  const artifacts = await fetchVerified(rel, [CLI_ARTIFACT]);
  await verifyAttestation(rel, artifacts, flags["skip-attestation"] === true);
  writeAtomic(CLI_BIN, artifacts[0]!.bytes, 0o755);

  // Seed the release tree with the copy just verified, so the re-run finds it
  // instead of fetching the same 78 MiB again -- `fetchVerified` looks in
  // `releases/<tag>` first, and nothing had put it there yet. Same reason
  // install.sh seeds it after the bootstrap download, and the same reason it is
  // safe: the re-run re-hashes whatever it finds against the release's own
  // SHA256SUMS before using it.
  //
  // Only the file. Moving `current` is placeRelease's job and must wait until
  // the directory holds every installed addon's wrapper too, which is exactly
  // what the re-run is about to do.
  writeAtomic(`${RELEASES_DIR}/${rel.tag}/${CLI_ARTIFACT}`, artifacts[0]!.bytes, 0o755);

  log.ok(`clp-addons is now ${target}; continuing as that`);

  // spawnSync rather than an exec: there is no execve here, and inheriting the
  // streams makes the hand-over invisible to whoever is watching the output.
  const r = spawnSync(CLI_BIN, [...process.argv.slice(2), "--no-self-update"], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}

async function cmdSelfUpdate(argv: string[]): Promise<void> {
  requireRoot("self-update");
  const { flags } = parseFlags(argv);
  const wanted = typeof flags.version === "string" ? flags.version : "latest";
  const rel = await resolveRelease(wanted, flags["allow-prerelease"] === true);

  if (rel.tag === `v${CLI_VERSION}`) {
    log.ok(`already running ${rel.tag}`);
    return;
  }

  const artifacts = await fetchVerified(rel, [CLI_ARTIFACT]);
  await verifyAttestation(rel, artifacts, flags["skip-attestation"] === true);

  // Atomic replace, so a CLI is always present even if this is interrupted.
  writeAtomic(CLI_BIN, artifacts[0]!.bytes, 0o755);
  log.ok(`clp-addons updated from ${CLI_VERSION} to ${rel.tag.replace(/^v/, "")}`);
  log.plain(`  'clp-addons update' moves the addons to ${rel.tag} too, and does this step itself.`);
}

/**
 * Every addon with a config file on disk, which is what "installed" means here.
 *
 * `repair` used to reconcile whichever addon `resolveAddon()` defaulted to, and
 * that default is instatic. The reconcile timer runs `clp-addons repair --quiet`
 * with no addon named, so on a two-addon box the timer reconciled one of them
 * and silently ignored the other: no wrapper reinstall, no sudoers re-validation,
 * no re-hardened site user, no service restart. Panel anchors were the exception
 * and always covered every addon, which is exactly what would have made this
 * hard to spot -- the visible symptom, a missing nav entry, was the one thing
 * that still worked.
 */
function installedAddons(): AddonSpec[] {
  return ADDON_NAMES.map((n) => ADDONS[n]!).filter((s) => existsSync(s.configFile));
}

/**
 * The hostname every addon is served from.
 *
 * `platform.conf` is the record, but it postdates the addons: a box installed
 * before they shared one site has no such file, and the hostname lives in each
 * addon's own config instead -- which is where its wrapper reads it from, so it
 * is still true. Falling back to that is what lets `repair` carry such a box
 * forward instead of stopping, and repair stopping is worse here than most
 * failures, because the reconciliation timer is the thing that calls it every
 * fifteen minutes. Reconstructing it is exactly repair's job.
 */
function platformDomain(): string | null {
  const recorded = readPlatformDomain();
  if (recorded) return recorded;
  for (const spec of installedAddons()) {
    const own = readOwnDomain(spec);
    if (own) return own;
  }
  return null;
}

/** One addon's share of a repair. The shared work is done once by the caller. */
function repairAddon(spec: AddonSpec, user: string, quiet: boolean): void {
  ensureDirs(spec);
  hardenBackups(spec, quiet);

  // The timer calls this every 15 minutes, so a reconciliation that changed
  // nothing should say nothing. Otherwise the journal fills with identical
  // success lines and a real message is lost in them.
  const wrapperSrc = `${CURRENT_LINK}/${spec.wrapperArtifact}`;
  if (existsSync(wrapperSrc)) {
    installWrapper(spec, readFileSync(wrapperSrc), quiet);
    installSudoers(spec, user, quiet);
  } else if (!quiet) {
    log.warn(`no wrapper in the current release at ${wrapperSrc}; skipping wrapper reinstall`);
  }

  // Whatever this addon has to do on a schedule. Failure is reported and then
  // ignored: housekeeping must never be the reason a repair stops half done.
  if (spec.maintenanceVerb && existsSync(spec.wrapperPath)) {
    const r = tryRun(spec.wrapperPath, [spec.maintenanceVerb]);
    if (!r.ok && !quiet) log.warn(`${spec.name} ${spec.maintenanceVerb} failed: ${r.out}`);
  }

}

/**
 * The half of a repair that belongs to the platform rather than to any addon:
 * the one account, the one unit, the snapshot. Called once after every addon has
 * had its own share, because there is one of each no matter how many addons are
 * installed.
 */
function repairPlatform(specs: AddonSpec[], user: string, quiet: boolean): void {
  // Editing the site in the panel can restore the shell, so re-assert it.
  hardenSiteUser(user, quiet);
  assertNotInDockerGroup(user);
  ensureSharedGroup(user, quiet);

  removeLegacyUnits(quiet);
  const unitChanged = installUnits(specs, user);
  generateSnapshot();
  for (const spec of specs) ensureDirs(spec);

  // Compare against the account the process is actually running as, not just
  // the unit file: an earlier repair may have rewritten the file already, and
  // systemd keeps the definition it started with until a restart.
  const runningAs = unitRunningUser(MANAGER_UNIT);
  if (unitChanged || (runningAs !== null && runningAs !== user)) {
    if (!quiet) {
      log.step(`${MANAGER_UNIT} is running as ${runningAs ?? "nothing"}; restarting it as ${user}`);
    }
    tryRun("systemctl", ["restart", MANAGER_UNIT]);
  } else if (unitActive(MANAGER_UNIT) !== "active") {
    log.step(`${MANAGER_UNIT} is not active; starting it`);
    tryRun("systemctl", ["start", MANAGER_UNIT]);
  }

  // Only now, with nothing running as it, can the old account go.
  removeLegacyUsers(user, quiet);
}

function cmdRepair(argv: string[]): void {
  requireRoot("repair");
  const { positional, flags } = parseFlags(argv);
  const quiet = flags.quiet === true;

  // The path unit uses this: anchors only, no wrapper reinstall, no visudo, no
  // daemon-reload, no snapshot. Cheap enough to run on every template write, and
  // already covers every addon in one pass.
  if (flags["anchors-only"] === true) {
    reconcileAnchors(quiet);
    return;
  }

  // Named addon, or everything installed. The timer names none.
  const specs = positional[0] ? [resolveAddon(positional[0])] : installedAddons();
  if (specs.length === 0) fatal("no addon is installed; run install first");

  const domain = platformDomain();
  if (!domain) fatal("no configured domain; run install first");
  const user = resolveSiteUser(domain);

  // Write it back whether or not it was there. On a box that predates the file
  // this is the migration; everywhere else it is a no-op that keeps the record
  // agreeing with the addon configs it was derived from.
  if (!readPlatformDomain()) {
    log.warn(`no ${PLATFORM_CONFIG}; taking ${domain} from the installed addons and writing it`);
  }
  writePlatformConfig(domain, user);

  for (const spec of specs) repairAddon(spec, user, quiet);

  // The unit has to describe every installed addon, not just the ones named
  // here: it is one process serving all of them, so repairing `stager` alone
  // must not rewrite the unit as though instatic were gone.
  repairPlatform(installedAddons(), user, quiet);

  // Platform-wide, so once rather than per addon.
  ensureTimerArmed("clp-addons-reconcile.timer", quiet);
  reconcileAnchors(quiet);
  if (!quiet) log.ok(`repair complete (${specs.map((s) => s.name).join(", ")})`);
}

async function cmdStatus(argv: string[]): Promise<void> {
  const { positional } = parseFlags(argv);
  // Every installed addon unless one is named. Defaulting to instatic meant a
  // second addon was simply absent from the output, with nothing saying so.
  const specs = positional[0] ? [resolveAddon(positional[0])] : installedAddons();

  // Wide enough for the longest label any addon contributes, which is an anchor
  // slug: "  anchor site-list-action" is 25. At 22 it ran into its own value.
  const pad = (label: string) => label.padEnd(26);
  log.plain(`clp-addons ${CLI_VERSION}`);
  log.plain();

  log.plain(`${pad("Installed release")}${currentRelease() ?? "none"}`);
  log.plain(`${pad("CloudPanel")}${panelVersion()}`);
  // Only the units something installed actually depends on. Reporting Docker on
  // a box running an addon that never touches it invites the wrong diagnosis.
  for (const unit of [...new Set(specs.flatMap((sp) => sp.requiresUnits ?? []))]) {
    log.plain(`${pad(unit)}${tryRun("systemctl", ["is-active", unit]).out || "unknown"}`);
  }
  log.plain();

  // One site, one service, one account, however many addons. Reported once,
  // because printing it under each addon invited the reading that each had its
  // own -- which is exactly what stopped being true.
  const domain = platformDomain();
  log.plain("Platform:");
  log.plain(`${pad("  Site")}${domain ?? "not configured"}`);
  log.plain(`${pad("  Site protected")}${describeSiteAuth(domain)}`);
  log.plain(`${pad("  Manager service")}${unitActive(MANAGER_UNIT)}`);
  // is-active alone says `active` for a timer that has elapsed and will never
  // fire again, so name the next elapse. No elapse means reconciliation is dead.
  const nextRun = timerNextElapse("clp-addons-reconcile.timer");
  log.plain(
    `${pad("  Reconcile timer")}${unitActive("clp-addons-reconcile.timer")}` +
      (nextRun ? `, next ${nextRun}` : ", NO SCHEDULED RUN. Run repair.")
  );

  const runAs = domain ? siteUserOf(domain) : null;
  log.plain(`${pad("  Runs as")}${runAs ?? "unknown"}${runAs ? " (CloudPanel site user)" : ""}`);
  if (runAs) {
    // Same reader hardenSiteUser decides from, so status cannot report a state
    // that repair disagrees with.
    const { shell, locked } = siteUserState(runAs);
    const hardened = shell === "/usr/sbin/nologin" && locked;
    log.plain(`${pad("  Account locked")}${hardened ? "yes (nologin, password locked)" : "NO — run repair"}`);
  }
  const inDocker = runAs ? tryRun("id", ["-nG", runAs]).out.split(/\s+/).includes("docker") : false;
  log.plain(`${pad("  Docker group")}${inDocker ? "YES — equivalent to root, run repair" : "no (correct)"}`);
  try {
    const snap = JSON.parse(readFileSync(SNAPSHOT_FILE, "utf-8"));
    const age = Math.round((Date.now() - new Date(snap.updatedAt).getTime()) / 1000);
    log.plain(`${pad("  Panel snapshot")}${snap.sites.length} sites, ${snap.allocatedPorts.length} ports, ${age}s old`);
  } catch {
    log.plain(`${pad("  Panel snapshot")}missing — run repair`);
  }
  log.plain();

  if (specs.length === 0) log.plain("No addon is installed.");
  for (const spec of specs) {
    const url = domain ? `https://${domain}${mountPath(spec.name)}` : mountPath(spec.name);
    log.plain(`Addon: ${spec.name}`);
    log.plain(`${pad("  Mounted at")}${url}`);
    log.plain(`${pad("  Wrapper")}${existsSync(spec.wrapperPath) ? spec.wrapperPath : "NOT INSTALLED"}`);
    log.plain(
      `${pad("  Sudoers")}${existsSync(`/etc/sudoers.d/clp-addon-${spec.name}`) ? "present" : "NOT INSTALLED"}`
    );
    for (const t of spec.targets) {
      const st = inspect({ addon: spec.name, target: t, url });
      log.plain(`${pad(`  anchor ${t.slug}`)}${describeTarget(st)}`);
    }
    log.plain();
  }
}

/**
 * Instances the addon is managing, as the addon itself sees them: a directory
 * under the state dir with a meta.json. Read from disk rather than from docker
 * so an instance whose container is already gone is still accounted for.
 */
function listInstances(spec: AddonSpec): string[] {
  if (!existsSync(spec.stateDir)) return [];
  return readdirSync(spec.stateDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(`${spec.stateDir}/${e.name}/meta.json`))
    .map((e) => e.name)
    .sort();
}

function cmdUninstall(argv: string[]): void {
  requireRoot("uninstall");
  const { positional, flags } = parseFlags(argv);
  const spec = resolveAddon(positional[0]);
  const purge = flags.purge === true;
  const instances = listInstances(spec);
  const ownDomain = platformDomain();

  // The release tree and the CLI are shared. A second addon still installed
  // needs both, so they go only when nothing is left that uses them.
  const remaining = ADDON_NAMES.filter((n) => n !== spec.name && existsSync(ADDONS[n]!.configFile));

  // So is the CloudPanel site, now that every addon is served from one. It goes
  // only when this is the last addon *and* this installer is what created it --
  // an adopted site was serving something before the addons arrived.
  const siteIsOurs = existsSync(SITE_CREATED_MARKER);
  const siteGoes = purge && siteIsOurs && remaining.length === 0;

  if (flags.yes !== true) {
    // Say exactly what will be destroyed, by name. "and every instance" is not
    // something an operator can check against what they believe is on the box.
    const shared = remaining.length
      ? `    - ${CLI_BIN} and the release tree stay: still used by ${remaining.join(", ")}\n`
      : `    - ${CLI_BIN} and ${LIB_DIR}\n`;
    // Say what actually happens to the manager. It is shared now, so removing one
    // addon restarts it without that addon's routes rather than stopping it, and
    // a confirmation prompt that overstates what it destroys is worse than none.
    const service = remaining.length
      ? `  Removes the wrapper, the sudoers line, ${spec.configFile} and the panel patches,\n` +
        `  and restarts ${MANAGER_UNIT} without ${spec.name}'s routes. Plus:\n`
      : `  Removes ${MANAGER_UNIT}, the wrapper, the sudoers line, ${spec.configFile} and the\n` +
        `  panel patches, plus:\n`;
    const common = service + shared;
    fatal(purge
      ? `uninstall --purge\n` + common +
        instances.map((d) => `    - instance ${d}: container, data and its CloudPanel site\n`).join("") +
        (instances.length ? "" : `    - (no instances found)\n`) +
        (siteGoes && ownDomain
          ? `    - the shared CloudPanel site ${ownDomain}\n`
          : remaining.length > 0
            ? `    - (the site stays: ${remaining.join(", ")} is still served from it)\n`
            : `    - (the site is left alone: not created by this installer)\n`) +
        `    - ${spec.stateDir}\n` +
        `  Each instance is archived to /var/backups/clp-addons/${spec.name} first.\n` +
        `  Re-run with --yes to proceed.`
      : `uninstall\n` + common +
        (instances.length
          ? `  Instance containers and their data are left alone. Re-run with --yes to proceed,\n` +
            `  or add --purge to also remove ${instances.length} instance(s) and their sites.`
          : `  ${spec.stateDir} is left alone. Re-run with --yes to proceed, or add --purge to\n` +
            `  remove it too.`));
  }

  // Keep the platform's own units when another addon still needs them. The
  // manager unit is one of those now: it serves every addon, so removing one
  // means rewriting and restarting it rather than stopping it.
  stopUnits(remaining.length > 0);
  removeSudoers(spec);
  // Re-render the templates without this addon's injections. Any other addon's
  // markup is rebuilt in the same pass, so removing one cannot take another's
  // nav entry with it.
  reconcileAnchors(true, spec.name);
  purgeTwigCache();
  log.ok("panel anchors removed and the Twig cache purged");

  // Instances first, while the wrapper is still on disk. They go through its
  // own delete verb rather than a second implementation here: that path already
  // archives the data, refuses to delete a site it did not create, and passes
  // --force so clpctl cannot block on a prompt.
  //
  // The sudoers line is gone by now, but this runs as root and calls the script
  // directly, so it does not need it.
  if (purge) {
    for (const domain of instances) {
      log.step(`removing instance ${domain}`);
      const r = tryRun(spec.wrapperPath, ["delete", "--domain", domain, "--confirm", domain]);
      if (!r.ok) log.warn(`could not remove ${domain}; leaving it in place`);
    }

    if (siteGoes && ownDomain) {
      log.step(`deleting the shared CloudPanel site ${ownDomain}`);
      if (!tryRun("clpctl", ["site:delete", `--domainName=${ownDomain}`, "--force"]).ok) {
        log.warn(`clpctl site:delete failed for ${ownDomain}; remove it from the panel by hand`);
      }
      rmSync(SITE_CREATED_MARKER, { force: true });
    } else if (ownDomain && remaining.length > 0) {
      log.warn(`leaving ${ownDomain} in place: ${remaining.join(", ")} is still served from it`);
    } else if (ownDomain) {
      log.warn(`leaving ${ownDomain} in place: this installer did not create it`);
    }

    rmSync(spec.stateDir, { recursive: true, force: true });
  }

  // Then this addon's own files. The plan text has always said uninstall
  // removes the wrapper; until now it did not.
  rmSync(spec.wrapperPath, { force: true });
  rmSync(spec.configFile, { force: true });
  rmSync(`${spec.configFile}.new`, { force: true });

  if (remaining.length > 0) {
    // The routes this addon served have to stop answering, and the unit has to
    // stop naming its state directory. Both are one rewrite of the shared unit.
    const domain = platformDomain();
    const user = domain ? siteUserOf(domain) : null;
    if (user) {
      installUnits(remaining.map((n) => ADDONS[n]!), user);
      tryRun("systemctl", ["restart", MANAGER_UNIT]);
      log.ok(`${MANAGER_UNIT} restarted without ${spec.name}`);
    }
    log.ok(`${spec.name} removed`);
    log.plain(`  Kept ${CLI_BIN} and the release tree: still used by ${remaining.join(", ")}`);
  } else {
    // Deleting the binary that is executing is safe: the inode survives until
    // this process exits.
    rmSync(LIB_DIR, { recursive: true, force: true });
    rmSync(PLATFORM_CONFIG, { force: true });
    rmSync(CLI_BIN, { force: true });
    log.ok(`${spec.name} removed, along with ${CLI_BIN} and the release tree`);
  }

  // The site is shared, so name it as what it is rather than as this addon's.
  const site = remaining.length
    ? `the CloudPanel site (${remaining.join(", ")} is still served from it)`
    : "the CloudPanel site";
  if (purge) log.plain(`  Archives kept: /var/backups/clp-addons/${spec.name}`);
  else if (instances.length) {
    log.warn(`Left in place on purpose: ${spec.stateDir}, ${site}, and every instance container.`);
  } else {
    log.warn(`Left in place on purpose: ${spec.stateDir} and ${site}.`);
  }
}

/**
 * Run one addon's manager in the foreground. This is what its systemd unit
 * ExecStarts, with User= set to the addon site's own CloudPanel account.
 *
 * Deliberately not requireRoot(): this is the one verb that is meant to run
 * unprivileged, and the manager's whole design is that its only privileged path
 * is sudo of its own wrapper.
 */
async function cmdServe(_argv: string[]): Promise<never> {
  // Every installed addon, mounted under its own path on the one site. No addon
  // argument: there is one unit, and which addons it serves is a fact about what
  // is installed rather than something ExecStart restates and can get wrong.
  const specs = installedAddons();
  if (specs.length === 0) fatal("no addon is installed; run install first");

  const mounted = specs.map((s2) => s2.name).filter((n) => MANAGERS[n]);
  const missing = specs.map((s2) => s2.name).filter((n) => !MANAGERS[n]);
  for (const n of missing) log.warn(`${n} is installed but no manager for it is bundled in this binary`);
  if (mounted.length === 0) fatal("none of the installed addons have a manager in this binary");

  const server = Bun.serve({
    // The unit declares PORT, so read it rather than assuming the default. That
    // is also what lets a second copy be started on a spare port to try it.
    port: Number(process.env.PORT || MANAGER_PORT),
    hostname: process.env.HOST || "127.0.0.1",
    // The longest an addon route may take. Instatic's create pulls an image and
    // waits on a health check, which is the slowest thing any of them do.
    idleTimeout: 255,

    async fetch(req) {
      const path = new URL(req.url).pathname.replace(/\/+$/, "") || "/";

      // Liveness for systemd, above the mounts so it answers whatever is
      // installed. It reports nothing about any addon.
      if (path === "/health") {
        return Response.json({ ok: true, service: "clp-addons", addons: mounted }, { headers: SECURITY_HEADERS });
      }

      const hit = splitMount(path, mounted);
      if (hit) return MANAGERS[hit.addon]!(req, hit.rest);

      // The root is an index rather than a redirect to whichever addon happens
      // to be first: with two installed, picking one is a guess, and the operator
      // arriving at the bare hostname is the one who does not yet know what is
      // here.
      if (path === "/") return indexPage(mounted);

      return Response.json({ ok: false, error: "not found" }, { status: 404, headers: SECURITY_HEADERS });
    },
  });

  log.plain(`[clp-addons] listening on http://${server.hostname}:${server.port} serving ${mounted.join(", ")}`);

  // Bun.serve holds the event loop open on its own. Never resolving is what
  // keeps main() from returning into the process.exit() that ends every other
  // command the moment it is done.
  return new Promise<never>(() => {});
}

/** The bare hostname: what is installed, and where each one lives. */
function indexPage(addons: string[]): Response {
  const links = addons
    .map((n) => `<li><a href="${esc(mountPath(n))}/">${esc(n)}</a></li>`)
    .join("");
  return new Response(
    renderLayout("CloudPanel addons", `<div class="card"><ul>${links}</ul></div>`, {
      brand: "CloudPanel addons",
      base: "",
      nav: [],
      script: "",
    }),
    { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...SECURITY_HEADERS } }
  );
}

function usage(): void {
  log.plain(`clp-addons ${CLI_VERSION} — CloudPanel addon manager (run as root)

  clp-addons install <addon> [--domain=<host>] [--version=vX.Y.Z] [--skip-attestation]
  clp-addons install <addon> --domain=<host> --local=dist      (staging only)
  clp-addons update [<addon>|--all] [--version=vX.Y.Z]   (alias: upgrade)
  clp-addons self-update [--version=vX.Y.Z]
  clp-addons repair [<addon>] [--quiet] [--anchors-only]
  clp-addons status [<addon>]
  clp-addons uninstall <addon> --yes [--purge]
  clp-addons serve                                             (systemd runs this)
  clp-addons --version

Addons: ${ADDON_NAMES.join(", ")}

One CloudPanel site serves all of them, each under its own path, so --domain is
asked once: the first install names it and later ones join it.

update brings the CLI itself to the release first, then hands over to that copy
to move the addons -- so what a release contains is always read by the CLI from
that release, whatever changed about it.

install, update and self-update refuse a release marked as a prerelease. These
artifacts run as root, so add --allow-prerelease when you mean it.

'repair' is 'install' without the download and is safe to run repeatedly; the
reconciliation timer calls it every 15 minutes to put the panel-side anchors
back after a CloudPanel update.`);
}

async function main(): Promise<number> {
  const [verb = "help", ...rest] = process.argv.slice(2);
  switch (verb) {
    case "--version":
    case "-v":
      log.plain(CLI_VERSION);
      return 0;
    case "install":      await cmdInstall(rest); return 0;
    // `upgrade` is the same command. Both are what people type, and having one
    // of them be an unknown-command error is a worse answer than doing the job.
    case "update":
    case "upgrade":      await cmdUpdate(rest); return 0;
    case "self-update":  await cmdSelfUpdate(rest); return 0;
    case "repair":       cmdRepair(rest); return 0;
    case "status":       await cmdStatus(rest); return 0;
    case "uninstall":    cmdUninstall(rest); return 0;
    case "serve":        return await cmdServe(rest);
    case "help":
    case "--help":
    case "-h":
      usage();
      return 0;
    default:
      log.err(`unknown command '${verb}'`);
      usage();
      return 2;
  }
}

try {
  process.exit(await main());
} catch (err) {
  if (err instanceof Fatal) {
    log.err(err.message);
    process.exit(1);
  }
  throw err;
}

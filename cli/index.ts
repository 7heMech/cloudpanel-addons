// clp-addons: run as root on the CloudPanel host.
//
// Bootstrapped once by the curl installer, then self-updating. `repair` is
// `install` minus the download and is idempotent, so the reconciliation timer
// calls it rather than duplicating the logic.

import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { ADDON_NAMES, ADDONS, CLI_BIN, CURRENT_LINK, type AddonSpec } from "./paths";
import { CLI_VERSION, fetchVerified, loadLocal, resolveRelease, verifyAttestation } from "./release";
import {
  assertNotInDockerGroup, currentRelease, ensureAddonSite, ensureDirs, hardenSiteUser,
  installSudoers, installUnits, installWrapper, placeRelease, pruneReleases, readOwnDomain,
  removeLegacyUsers, removeSudoers, resolveSiteUser, startUnits, stopUnits, unitActive,
  unitRunningUser, writeConfig,
} from "./provision";
import { Fatal, fatal, log, parseFlags, requireRoot, run, tryRun, writeAtomic } from "./util";
import {
  KNOWN_GOOD_PANEL_VERSIONS, TARGETS, applyTarget, inspectTarget, panelVersion, purgeTwigCache,
  removeTarget, type TargetStatus,
} from "../addons/instatic/inject/template-manager";
import { generateSnapshot } from "../lib/panel-snapshot";

const CLI_ARTIFACT = "clp-addons-linux-x64";

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

// --- anchors ----------------------------------------------------------------

/**
 * Re-apply the panel-side anchors. Stops rather than patching when upstream's
 * markup has moved: applying a patch built for the old markup is worse than
 * having no link.
 */
function reconcileAnchors(spec: AddonSpec, quiet: boolean): boolean {
  const domain = readOwnDomain(spec);
  if (!domain) {
    log.warn("no OWN_DOMAIN in the addon config; skipping anchor injection");
    return false;
  }
  const url = `https://${domain}`;

  let changed = false;
  let blocked = false;
  for (const target of TARGETS) {
    const before = inspectTarget(target, url);
    if (before.state === "ok") {
      if (!quiet) log.ok(`anchor ${target.slug}: present`);
      continue;
    }
    if (before.state === "stale-content") {
      // Regenerate from pristine so the rewrite cannot double-apply.
      removeTarget(target);
    }
    if (before.state === "upstream-changed" || before.state === "anchor-not-found-in-markup") {
      log.err(`anchor ${target.slug}: ${describeTarget(before)}`);
      log.err(
        `  CloudPanel ${panelVersion()} has changed the markup this patch targets.\n` +
          `  Not applying it. Rebuild the patch against the new markup, then run repair again.\n` +
          `  Known good against: ${KNOWN_GOOD_PANEL_VERSIONS.join(", ")}`
      );
      if (target.required) blocked = true;
      continue;
    }
    if (before.state === "template-absent") {
      log.warn(`anchor ${target.slug}: ${describeTarget(before)}`);
      continue;
    }

    const after = applyTarget(target, url);
    if (after.state === "ok") {
      log.ok(`anchor ${target.slug}: injected`);
      changed = true;
    } else {
      log.err(`anchor ${target.slug}: ${describeTarget(after)}`);
      if (target.required) blocked = true;
    }
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

  const domain = typeof flags.domain === "string" ? flags.domain : null;
  if (!domain) {
    fatal(
      `install needs --domain=<hostname> for the manager's own CloudPanel site.\n` +
        `  Example: clp-addons install ${spec.name} --domain=addons.example.com`
    );
  }
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(domain)) {
    fatal(`--domain='${domain}' is not a valid hostname`);
  }

  if (!tryRun("systemctl", ["is-active", "docker"]).ok) {
    fatal("docker is not active. Install and start it before installing this addon.");
  }

  const wantedArtifacts = [CLI_ARTIFACT, spec.appArtifact, spec.wrapperArtifact];
  let tag: string;
  let artifacts;
  if (typeof flags.local === "string") {
    tag = `local-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    log.step(`installing ${spec.name} from the local build in ${flags.local}`);
    artifacts = loadLocal(flags.local, wantedArtifacts);
  } else {
    const rel = await resolveRelease(typeof flags.version === "string" ? flags.version : "latest");
    tag = rel.tag;
    log.step(`installing ${spec.name} from release ${rel.tag}`);
    artifacts = await fetchVerified(rel, wantedArtifacts);
    await verifyAttestation(artifacts, flags["skip-attestation"] === true);
  }

  // The site has to exist before anything else: the account the manager runs
  // as is the one CloudPanel creates for it (decision 2.4).
  const siteCreated = ensureAddonSite(spec, domain);
  const user = resolveSiteUser(domain);
  hardenSiteUser(user);
  assertNotInDockerGroup(user);
  ensureDirs(spec, user);

  placeRelease(tag, artifacts);
  pruneReleases();

  const wrapper = artifacts.find((a) => a.name === spec.wrapperArtifact)!;
  installWrapper(spec, wrapper.bytes);
  installSudoers(spec, user);

  // Place the CLI itself last among the binaries, so a failure earlier leaves
  // the previous working CLI in place.
  const cli = artifacts.find((a) => a.name === CLI_ARTIFACT)!;
  writeAtomic(CLI_BIN, cli.bytes, 0o755);

  writeConfig(spec, domain, user, true);

  // Remember whether the manager's site is ours to delete. `uninstall --purge`
  // reads this: a site that already existed and was adopted was serving
  // something before this addon arrived, and removing it would take that with
  // it. Absent marker means "not ours", so an install predating this file is
  // treated as adopted rather than guessed at.
  if (siteCreated) writeAtomic(`${spec.stateDir}/.site-created-by-addon`, domain, 0o600);

  installUnits(spec, user);
  log.step("generating the sanitized panel snapshot");
  generateSnapshot();
  ensureDirs(spec, user);
  startUnits(spec);
  removeLegacyUsers(user);

  reconcileAnchors(spec, false);

  log.plain();
  log.ok(`${spec.name} ${tag} installed.`);
  log.plain(`  Manager UI:  https://${domain}`);
  log.plain(`  Next steps:  add basic auth for that site in the panel, then issue a certificate with`);
  log.plain(`               clpctl lets-encrypt:install:certificate --domainName=${domain}`);
}

async function cmdUpdate(argv: string[]): Promise<void> {
  requireRoot("update");
  const { positional, flags } = parseFlags(argv);
  const targets = flags.all === true ? ADDON_NAMES : [positional[0] ?? "instatic"];

  for (const name of targets) {
    const spec = resolveAddon(name);
    const wanted = typeof flags.version === "string" ? flags.version : "latest";
    const rel = await resolveRelease(wanted);

    if (rel.tag === currentRelease()) {
      log.ok(`${spec.name} is already on ${rel.tag}`);
      continue;
    }

    const artifacts = await fetchVerified(rel, [CLI_ARTIFACT, spec.appArtifact, spec.wrapperArtifact]);
    await verifyAttestation(artifacts, flags["skip-attestation"] === true);

    // The wrapper is synchronous and short-lived, so draining is simple: stop
    // the app, which is the only caller, then swap.
    log.step(`stopping ${spec.unit} before the swap`);
    tryRun("systemctl", ["stop", spec.unit]);

    const domain = readOwnDomain(spec);
    const user = domain ? resolveSiteUser(domain) : null;
    if (!user) fatal("no configured domain for this addon; run install first");

    placeRelease(rel.tag, artifacts);
    installWrapper(spec, artifacts.find((a) => a.name === spec.wrapperArtifact)!.bytes);
    installSudoers(spec, user);
    writeAtomic(CLI_BIN, artifacts.find((a) => a.name === CLI_ARTIFACT)!.bytes, 0o755);

    writeConfig(spec, domain!, user);

    installUnits(spec, user);
    startUnits(spec);
    reconcileAnchors(spec, false);
    pruneReleases();
    log.ok(`${spec.name} updated to ${rel.tag}`);
  }
}

async function cmdSelfUpdate(argv: string[]): Promise<void> {
  requireRoot("self-update");
  const { flags } = parseFlags(argv);
  const wanted = typeof flags.version === "string" ? flags.version : "latest";
  const rel = await resolveRelease(wanted);

  if (rel.tag === `v${CLI_VERSION}`) {
    log.ok(`already running ${rel.tag}`);
    return;
  }

  const artifacts = await fetchVerified(rel, [CLI_ARTIFACT]);
  await verifyAttestation(artifacts, flags["skip-attestation"] === true);

  // Atomic replace, so a CLI is always present even if this is interrupted.
  writeAtomic(CLI_BIN, artifacts[0]!.bytes, 0o755);
  log.ok(`clp-addons updated from ${CLI_VERSION} to ${rel.tag.replace(/^v/, "")}`);
  log.plain(`  Run 'clp-addons update --all' to move the addons to ${rel.tag} as well.`);
}

function cmdRepair(argv: string[]): void {
  requireRoot("repair");
  const { positional, flags } = parseFlags(argv);
  const quiet = flags.quiet === true;
  const spec = resolveAddon(positional[0]);

  // The path unit uses this: anchors only, no wrapper reinstall, no visudo, no
  // daemon-reload, no snapshot. Cheap enough to run on every template write.
  if (flags["anchors-only"] === true) {
    reconcileAnchors(spec, quiet);
    return;
  }

  // install minus the download, and idempotent.
  const ownDomain = readOwnDomain(spec);
  if (!ownDomain) fatal("no configured domain for this addon; run install first");
  const user = resolveSiteUser(ownDomain);

  // Editing the site in the panel can restore the shell, so re-assert it.
  hardenSiteUser(user, quiet);
  assertNotInDockerGroup(user);
  ensureDirs(spec, user);

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

  const unitChanged = installUnits(spec, user);
  generateSnapshot();
  ensureDirs(spec, user);

  // Compare against the account the process is actually running as, not just
  // the unit file: an earlier repair may have rewritten the file already, and
  // systemd keeps the definition it started with until a restart.
  const runningAs = unitRunningUser(spec.unit);
  if (unitChanged || (runningAs !== null && runningAs !== user)) {
    if (!quiet) {
      log.step(`${spec.unit} is running as ${runningAs ?? "nothing"}; restarting it as ${user}`);
    }
    tryRun("systemctl", ["restart", spec.unit]);
  } else if (unitActive(spec.unit) !== "active") {
    log.step(`${spec.unit} is not active; starting it`);
    tryRun("systemctl", ["start", spec.unit]);
  }

  // Only now, with nothing running as it, can the old account go.
  removeLegacyUsers(user, quiet);
  tryRun("systemctl", ["start", "clp-addons-reconcile.timer"]);

  reconcileAnchors(spec, quiet);
  if (!quiet) log.ok("repair complete");
}

async function cmdStatus(argv: string[]): Promise<void> {
  const { positional } = parseFlags(argv);
  const spec = resolveAddon(positional[0]);

  const pad = (label: string) => label.padEnd(22);
  log.plain(`clp-addons ${CLI_VERSION}`);
  log.plain();

  log.plain(`${pad("Installed release")}${currentRelease() ?? "none"}`);
  log.plain(`${pad("CloudPanel")}${panelVersion()}`);
  log.plain(`${pad("Docker")}${tryRun("systemctl", ["is-active", "docker"]).out || "unknown"}`);
  log.plain();

  log.plain(`Addon: ${spec.name}`);
  log.plain(`${pad("  Service")}${unitActive(spec.unit)}`);
  log.plain(`${pad("  Reconcile timer")}${unitActive("clp-addons-reconcile.timer")}`);
  log.plain(`${pad("  Own site")}${readOwnDomain(spec) ?? "not configured"}`);
  log.plain(`${pad("  Wrapper")}${existsSync(spec.wrapperPath) ? spec.wrapperPath : "NOT INSTALLED"}`);
  log.plain(
    `${pad("  Sudoers")}${existsSync(`/etc/sudoers.d/clp-addon-${spec.name}`) ? "present" : "NOT INSTALLED"}`
  );

  const own = readOwnDomain(spec);
  const runAs = own ? tryRun("sqlite3", ["-readonly", "/home/clp/htdocs/app/data/db.sq3",
    `SELECT user FROM site WHERE domain_name = '${own}';`]).out.trim() : "";
  log.plain(`${pad("  Runs as")}${runAs || "unknown"}${runAs ? ` (CloudPanel site user)` : ""}`);
  if (runAs) {
    const shell = tryRun("getent", ["passwd", runAs]).out.split(":")[6] ?? "";
    const pw = tryRun("passwd", ["-S", runAs]).out.split(/\s+/)[1] ?? "";
    const hardened = shell === "/usr/sbin/nologin" && pw === "L";
    log.plain(`${pad("  Account locked")}${hardened ? "yes (nologin, password locked)" : "NO — run repair"}`);
  }
  const inDocker = runAs ? tryRun("id", ["-nG", runAs]).out.split(/\s+/).includes("docker") : false;
  log.plain(`${pad("  Docker group")}${inDocker ? "YES — equivalent to root, run repair" : "no (correct)"}`);
  log.plain();

  log.plain("Panel anchors:");
  for (const t of TARGETS) {
    log.plain(`${pad(`  ${t.slug}`)}${describeTarget(inspectTarget(t, own ? `https://${own}` : undefined))}`);
  }
  log.plain();

  try {
    const snap = JSON.parse(readFileSync("/var/lib/clp-addons/snapshot.json", "utf-8"));
    const age = Math.round((Date.now() - new Date(snap.updatedAt).getTime()) / 1000);
    log.plain(`${pad("Panel snapshot")}${snap.sites.length} sites, ${snap.allocatedPorts.length} ports, ${age}s old`);
  } catch {
    log.plain(`${pad("Panel snapshot")}missing — run repair`);
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
  const ownDomain = readOwnDomain(spec);
  const ownSiteIsOurs = existsSync(`${spec.stateDir}/.site-created-by-addon`);

  if (flags.yes !== true) {
    // Say exactly what will be destroyed, by name. "and every instance" is not
    // something an operator can check against what they believe is on the box.
    const plan = purge
      ? `uninstall --purge removes the service, the wrapper, the sudoers line and the panel\n` +
        `  patches, and then DESTROYS:\n` +
        (instances.length
          ? instances.map((d) => `    - instance ${d}: container, data and its CloudPanel site\n`).join("")
          : `    - (no instances found)\n`) +
        (ownSiteIsOurs && ownDomain
          ? `    - the manager's own CloudPanel site ${ownDomain}\n`
          : `    - (the manager's site is left alone: not created by this addon)\n`) +
        `    - ${spec.stateDir}\n` +
        `  Each instance is archived to /var/backups/clp-addons/${spec.name} first.\n` +
        `  Re-run with --yes to proceed.`
      : `uninstall removes the service, the wrapper and the sudoers line, and un-patches the panel.\n` +
        `  Instance containers and their data are left alone. Re-run with --yes to proceed,\n` +
        `  or add --purge to also remove ${instances.length} instance(s) and their sites.`;
    fatal(plan);
  }

  stopUnits(spec);
  removeSudoers(spec);
  for (const t of TARGETS) removeTarget(t);
  purgeTwigCache();
  log.ok("panel anchors removed and the Twig cache purged");

  if (!purge) {
    log.warn(`Left in place on purpose: ${spec.stateDir}, the addon's CloudPanel site, and every instance container.`);
    return;
  }

  // Instances go through the wrapper's own delete verb rather than a second
  // implementation here. It already archives the data, refuses to delete a
  // site it did not create, and passes --force so clpctl cannot block on a
  // prompt -- all of which a reimplementation would have to get right again.
  //
  // The sudoers line is gone by now, but this runs as root and calls the
  // script directly, so it does not need it.
  for (const domain of instances) {
    log.step(`removing instance ${domain}`);
    const r = tryRun(spec.wrapperPath, ["delete", "--domain", domain, "--confirm", domain]);
    if (!r.ok) log.warn(`could not remove ${domain}; leaving it in place`);
  }

  if (ownSiteIsOurs && ownDomain) {
    log.step(`deleting the manager's CloudPanel site ${ownDomain}`);
    if (!tryRun("clpctl", ["site:delete", `--domainName=${ownDomain}`, "--force"]).ok) {
      log.warn(`clpctl site:delete failed for ${ownDomain}; remove it from the panel by hand`);
    }
  } else if (ownDomain) {
    log.warn(`leaving ${ownDomain} in place: this addon did not create it`);
  }

  // Last, because everything above reads from it.
  rmSync(spec.stateDir, { recursive: true, force: true });
  log.ok(`${spec.name} purged`);
  log.plain(`  Archives kept: /var/backups/clp-addons/${spec.name}`);
}

function usage(): void {
  log.plain(`clp-addons ${CLI_VERSION} — CloudPanel addon manager (run as root)

  clp-addons install <addon> --domain=<host> [--version=vX.Y.Z] [--skip-attestation]
  clp-addons install <addon> --domain=<host> --local=dist      (staging only)
  clp-addons update [<addon>|--all] [--version=vX.Y.Z]
  clp-addons self-update [--version=vX.Y.Z]
  clp-addons repair [<addon>] [--quiet] [--anchors-only]
  clp-addons status [<addon>]
  clp-addons uninstall <addon> --yes [--purge]
  clp-addons --version

Addons: ${ADDON_NAMES.join(", ")}

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
    case "update":       await cmdUpdate(rest); return 0;
    case "self-update":  await cmdSelfUpdate(rest); return 0;
    case "repair":       cmdRepair(rest); return 0;
    case "status":       await cmdStatus(rest); return 0;
    case "uninstall":    cmdUninstall(rest); return 0;
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

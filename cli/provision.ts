// Everything that puts the box into the installed state. Written so that
// `repair` can call the same functions as `install`: there must be exactly one
// implementation of "make the box match what should be installed", or the
// reconciliation timer and the installer drift apart.

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, renameSync, readdirSync } from "node:fs";
import {
  ADDONS, ANCHOR_SERVICE, CLI_ARTIFACT, CLI_BIN, CONFIG_DIR, CURRENT_LINK, LEGACY_USERS, LIB_DIR, LOCK_DIR,
  LEGACY_UNITS, MANAGER_PORT, MANAGER_UNIT, PANEL_DB, PLATFORM_CONFIG, RECONCILE_PATH, RECONCILE_SERVICE, RECONCILE_TIMER,
  RELEASES_DIR, SHARED_GROUP, STATE_DIR, SYSTEMD_DIR,
  templateWatchPaths, type AddonSpec,
} from "./paths";
import { fatal, log, run, tryRun, writeAtomic } from "./util";
import type { FetchedArtifact } from "./release";

// --- accounts ---------------------------------------------------------------

/**
 * The account the manager runs as is the one CloudPanel created for the
 * addon's own site (decision 2.4), not one this installer invents. One account
 * per addon site rather than two, and CloudPanel owns its lifecycle: deleting
 * the site removes the user, so uninstall has nothing of its own to clean up.
 */
/**
 * The account name to ask CloudPanel to create for a site.
 *
 * `clpctl site:add:reverse-proxy` requires --siteUser, so a name has to come
 * from somewhere; CloudPanel only generates one for sites created through its
 * own UI. This is that scheme, and it is the only one -- the manager's site and
 * an instance's site are both just sites this addon created, so they are named
 * the same way.
 *
 *     addon-<first 8 alphanumerics of the domain>-<6 hex of sha256(domain)>
 *
 * The hash is what makes it safe. Two earlier schemes truncated the domain to
 * fit a 15-character budget, which meant uniqueness rested on a prefix:
 * `demo.clp-stg.local` and `demo.clp-stg.example.com` both reduced to
 * `inst_democlpstg`, and site.user is UNIQUE, so the second site failed inside
 * clpctl with nothing explaining why. Hashing the whole domain removes the
 * question; the readable fragment is for operators reading /etc/passwd.
 *
 * Reimplemented in the wrapper, which is bash and cannot import this. That
 * duplication is pinned by a test asserting both produce the same name.
 */
export function siteUserFor(domain: string): string {
  const d = domain.toLowerCase();
  const readable = d.replace(/[^a-z0-9]/g, "").slice(0, 8);
  const hash = createHash("sha256").update(d).digest("hex").slice(0, 6);
  return `addon-${readable}-${hash}`;
}

export function siteUserOf(domain: string): string | null {
  const r = tryRun("sqlite3", ["-readonly", PANEL_DB,
    `SELECT user FROM site WHERE domain_name = '${domain}';`]);
  return (r.ok && r.out.trim()) || null;
}

/**
 * Shell and password state of a site account, as `status` reports it and as
 * hardenSiteUser decides from. One reader, so the two can never disagree about
 * what "hardened" means.
 */
export function siteUserState(user: string): { shell: string; locked: boolean } {
  return {
    shell: tryRun("getent", ["passwd", user]).out.split(":")[6] ?? "",
    locked: tryRun("passwd", ["-S", user]).out.split(/\s+/)[1] === "L",
  };
}

/**
 * Whether CloudPanel's own per-site Basic Auth is in front of a site.
 *
 * The panel already has this feature -- Site -> Security writes a `basic_auth`
 * row and points `site.basic_auth_id` at it, with `whitelisted_ips` covering the
 * IP allowlist too -- so there is nothing here to build. This reads the panel's
 * record and reports it. Enabling it stays a panel action: `clpctl` has
 * `cloudpanel:enable:basic-auth`, but that protects the panel's own login, not a
 * site, and writing `basic_auth` rows ourselves would mean writing an
 * undocumented schema while the panel is running (decision 2.6).
 *
 * `vhostOnly` is the state this box was actually found in: `auth_basic` present
 * in the site's vhost, `basic_auth_id` NULL. That does protect the site, and it
 * survives regeneration because the panel rebuilds the vhost from the template
 * it is stored in, but the panel's Security tab shows Basic Auth as off, so an
 * operator reading the UI sees an unprotected site and toggling that switch can
 * rewrite the edit away.
 */
export interface SiteAuthState {
  panelManaged: boolean;
  active: boolean;
  ipAllowlist: boolean;
  vhostOnly: boolean;
}

export function siteBasicAuth(domain: string): SiteAuthState {
  const none: SiteAuthState = { panelManaged: false, active: false, ipAllowlist: false, vhostOnly: false };
  // The domain reaches SQL as a literal, so gate it the way the wrapper does
  // rather than trusting whatever ended up in the config file.
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(domain)) return none;

  const r = tryRun("sqlite3", ["-readonly", PANEL_DB,
    `SELECT b.is_active, (b.whitelisted_ips IS NOT NULL AND b.whitelisted_ips != '')` +
    ` FROM site s JOIN basic_auth b ON b.id = s.basic_auth_id WHERE s.domain_name = '${domain}';`]);

  if (r.ok && r.out.trim()) {
    const [active, ips] = r.out.trim().split("|");
    return { panelManaged: true, active: active === "1", ipAllowlist: ips === "1", vhostOnly: false };
  }

  // No panel record. The vhost is read, never written, purely to tell the two
  // unprotected-looking states apart.
  const vhost = `/etc/nginx/sites-enabled/${domain}.conf`;
  if (existsSync(vhost) && /^\s*auth_basic\s+"/m.test(readFileSync(vhost, "utf-8"))) {
    return { panelManaged: false, active: true, ipAllowlist: false, vhostOnly: true };
  }
  return none;
}

/** How a site's protection reads in `status`. Pure, so it is testable without a panel. */
export function describeAuthState(a: SiteAuthState): string {
  if (a.panelManaged && a.active) {
    return `yes, CloudPanel Basic Auth${a.ipAllowlist ? " + IP allowlist" : ""}`;
  }
  if (a.panelManaged) return "NO — CloudPanel Basic Auth exists for this site but is switched off";
  if (a.vhostOnly) {
    return "yes, but via a vhost edit — the panel's Security tab shows it as off; move it to Site → Security";
  }
  return "NO — the manager is reachable without authentication";
}

export function resolveSiteUser(domain: string): string {
  const user = siteUserOf(domain);
  if (!user) {
    fatal(
      `could not find the CloudPanel site user for ${domain}.\n` +
        `  The addon runs as that site's user, so the site has to exist first.`
    );
  }
  return user;
}

/**
 * CloudPanel gives site users a login shell and a password so operators can
 * use SFTP. For the addon's own site that is a liability rather than a
 * feature: the site has no docroot anyone edits, it is a pure reverse proxy,
 * and this account is the one permitted to sudo the root wrapper. Leaving it
 * interactively reachable would turn that site's SFTP credentials into a path
 * to root for anyone who can read them in the panel.
 *
 * Re-asserted by repair, because editing the site in the panel can put the
 * shell back.
 */
export function hardenSiteUser(user: string, quiet = false): void {
  const { shell, locked } = siteUserState(user);

  if (shell !== "/usr/sbin/nologin") {
    run("usermod", ["-s", "/usr/sbin/nologin", user]);
    if (!quiet) log.ok(`${user}: login shell disabled`);
  }
  if (!locked) {
    run("passwd", ["-l", user]);
    if (!quiet) log.ok(`${user}: password locked`);
  }
}

/**
 * Docker group membership is equivalent to root: a member can start a
 * container with the host filesystem bind-mounted. Being in it would make the
 * wrapper's argument validation decorative, so check and undo it.
 */
export function assertNotInDockerGroup(user: string): void {
  const r = tryRun("id", ["-nG", user]);
  if (!r.ok) return;
  if (r.out.split(/\s+/).includes("docker")) {
    log.warn(`${user} is in the docker group, which is equivalent to root; removing`);
    tryRun("gpasswd", ["-d", user, "docker"]);
  }
}

/**
 * Remove the dedicated account earlier versions created. CloudPanel's site
 * user replaces it, and leaving it behind means a stray account that once had
 * a sudoers rule pointing at a root wrapper.
 */
export function removeLegacyUsers(activeUser: string, quiet = false): void {
  for (const legacy of LEGACY_USERS) {
    if (legacy === activeUser) continue;
    if (!tryRun("id", ["-u", legacy]).ok) continue;
    log.warn(`removing the legacy account ${legacy}; the addon now runs as ${activeUser}`);
    tryRun("gpasswd", ["-d", legacy, "docker"]);
    rmSync(`/etc/sudoers.d/clp-addon-${legacy}`, { force: true });
    const r = tryRun("userdel", [legacy]);
    if (!r.ok && !quiet) log.warn(`could not remove ${legacy}: ${r.out}`);
  }
}

// --- directories ------------------------------------------------------------

/**
 * The group that lets every addon read one snapshot file.
 *
 * Idempotent, and called from both install and repair, because a site user can
 * lose the membership: editing the site in the panel rewrites the account, and
 * the same reasoning that makes hardenSiteUser re-assert the shell applies here.
 */
export function ensureSharedGroup(user: string, quiet = false): void {
  if (!tryRun("getent", ["group", SHARED_GROUP]).ok) {
    run("groupadd", ["--system", SHARED_GROUP]);
    if (!quiet) log.ok(`created the ${SHARED_GROUP} group`);
  }
  const groups = tryRun("id", ["-nG", user]).out.split(/\s+/).filter(Boolean);
  if (!groups.includes(SHARED_GROUP)) {
    run("usermod", ["-aG", SHARED_GROUP, user]);
    if (!quiet) log.ok(`added ${user} to ${SHARED_GROUP}`);
  }
}

export function ensureDirs(spec: AddonSpec): void {
  for (const d of [LIB_DIR, RELEASES_DIR, CONFIG_DIR, STATE_DIR, LOCK_DIR]) {
    mkdirSync(d, { recursive: true });
  }
  mkdirSync(spec.stateDir, { recursive: true });

  // root:root, not the addon's site user.
  //
  // Only the wrapper writes here, and it runs as root; the manager reaches every
  // one of these files through the wrapper rather than off the filesystem. Giving
  // the directory to the app user let that account rename the wrapper's own
  // root-owned records aside -- `jobs/` for the stager, an instance directory for
  // instatic -- and put its own in their place, which made every path the wrapper
  // derives from those records caller-controlled. The ownership dates from when
  // the manager kept an app.db of its own in here; that file was removed and the
  // ownership was not.
  //
  // Still not recursive, for the original reason: the subdirectories are instance
  // storage, each owned by the site user of the instance that runs there, and a
  // `chown -R` would take that away every fifteen minutes when the reconcile
  // timer next called repair.
  run("chown", ["root:root", spec.stateDir]);
  run("chmod", ["750", spec.stateDir]);

  // The snapshot is customer data: the addons' shared group reads it, nobody
  // else. The group rather than this addon's own user, or installing a second
  // addon would take the file away from the first one.
  const snapshot = `${STATE_DIR}/snapshot.json`;
  if (existsSync(snapshot)) {
    run("chown", [`root:${SHARED_GROUP}`, snapshot]);
    run("chmod", ["640", snapshot]);
  }
}

/**
 * Tighten snapshot archives written before the mode was set explicitly.
 *
 * Every archive the wrapper produces contains the instance's instatic.env, and
 * therefore its master key, alongside the database. The mode used to be inherited
 * from whoever invoked the wrapper, so archives written by root from a shell
 * landed at 0644 inside a 0755 directory -- readable by every account on the box,
 * and on a CloudPanel host every site user has SFTP. The wrapper now sets the mode
 * itself, but files already on disk keep the old one, and nothing else would ever
 * revisit them. repair is the place that makes the box match what should be
 * installed, so it fixes them here.
 */
export function hardenBackups(spec: AddonSpec, quiet = false): void {
  const dir = `/var/backups/clp-addons/${spec.name}`;
  if (!existsSync(dir)) return;

  let tightened = 0;
  const fix = (path: string, mode: number) => {
    if ((statSync(path).mode & 0o777) === mode) return;
    chmodSync(path, mode);
    tightened++;
  };

  fix(dir, 0o700);
  for (const entry of readdirSync(dir)) {
    const path = `${dir}/${entry}`;
    if (statSync(path).isFile()) fix(path, 0o600);
  }
  if (tightened > 0 && !quiet) {
    log.ok(`${dir}: tightened ${tightened} path(s); the archives hold instance master keys`);
  }
}

// --- releases ---------------------------------------------------------------

/**
 * Every artifact that has to exist in a release tree for these addons to run.
 *
 * `current` is shared: every addon's service unit ExecStarts the one binary in
 * `current`, and each addon needs its own wrapper beside it, so a release
 * directory is only safe to point at once it holds every installed addon's
 * wrapper as well as the binary.
 */
export function releaseArtifacts(specs: AddonSpec[]): string[] {
  const names = new Set<string>([CLI_ARTIFACT]);
  for (const spec of specs) names.add(spec.wrapperArtifact);
  return [...names];
}

/**
 * Place a release under releases/<tag> and move `current` onto it. Immutable
 * directories mean a rollback is a symlink swap rather than a re-download.
 *
 * `required` is what must be in the directory before `current` moves. Installing
 * a second addon used to fetch only that addon's artifacts, write them into a
 * new release directory and point `current` at it -- which took the first
 * addon's app binary out from under its own unit, and the only symptom was
 * status=203/EXEC on a service that had been running for weeks. The guard is
 * here rather than in the caller because this is the function that moves the
 * symlink, and every caller of it has the same obligation.
 */
export function placeRelease(tag: string, artifacts: FetchedArtifact[], required: string[] = []): string {
  const dir = `${RELEASES_DIR}/${tag}`;
  mkdirSync(dir, { recursive: true });
  for (const a of artifacts) {
    // The wrapper stays a plain script (decision 2.13); both are 0755 root:root.
    writeAtomic(`${dir}/${a.name}`, a.bytes, 0o755);
  }
  writeAtomic(`${dir}/VERSION`, `${tag}\n`, 0o644);

  const missing = required.filter((n) => !existsSync(`${dir}/${n}`));
  if (missing.length > 0) {
    fatal(
      `refusing to point 'current' at ${tag}: ${dir} is missing ${missing.join(", ")}.\n` +
        `  Another installed addon runs from that release tree and would stop starting.`
    );
  }

  const tmpLink = `${CURRENT_LINK}.new`;
  rmSync(tmpLink, { force: true });
  symlinkSync(dir, tmpLink);
  renameSync(tmpLink, CURRENT_LINK);
  log.ok(`release ${tag} placed and 'current' now points at it`);
  return dir;
}

/**
 * Keep the last two releases so a rollback target always exists.
 *
 * Ordered by when each was placed, not by name. Sorting the directory names
 * put v0.10.0 before v0.8.0 lexicographically, so the newest release was the
 * one pruned and an ancient one kept as the rollback target. Placement time is
 * also the only ordering that means anything for the `local-<timestamp>` tags
 * a staging install produces.
 */
export function pruneReleases(keep = 2): void {
  if (!existsSync(RELEASES_DIR)) return;
  const current = existsSync(CURRENT_LINK) ? readlinkSync(CURRENT_LINK) : "";
  const dirs = readdirSync(RELEASES_DIR)
    .map((d) => ({ d, at: statSync(`${RELEASES_DIR}/${d}`).mtimeMs }))
    .sort((a, b) => b.at - a.at)
    .map((e) => e.d);
  for (const d of dirs.slice(keep)) {
    const path = `${RELEASES_DIR}/${d}`;
    if (path === current) continue;
    log.step(`pruning old release ${d}`);
    rmSync(path, { recursive: true, force: true });
  }
}

/**
 * Is this addon's own installed state already from `tag`?
 *
 * `update --all` used to ask `currentRelease() === rel.tag`, which is a fact about
 * the shared release tree rather than about the addon. The first addon in the loop
 * called placeRelease() and moved `current` onto the new tag, so every addon after
 * it matched, logged "already on", and had its app binary and wrapper skipped
 * entirely. Nothing looked wrong -- the run reported success for all of them.
 *
 * The addon's files are the honest answer, in keeping with the wrapper's own rule
 * that what is on disk is the record: the release has to carry this addon's
 * artifacts, and the wrapper actually installed has to be the one in that release.
 */
export function addonIsAtRelease(spec: AddonSpec, tag: string): boolean {
  if (currentRelease() !== tag) return false;

  const releaseDir = `${RELEASES_DIR}/${tag}`;
  const app = `${releaseDir}/${CLI_ARTIFACT}`;
  const wrapper = `${releaseDir}/${spec.wrapperArtifact}`;
  if (!existsSync(app) || !existsSync(wrapper) || !existsSync(spec.wrapperPath)) return false;

  return readFileSync(spec.wrapperPath).equals(readFileSync(wrapper));
}

export function currentRelease(): string | null {
  const versionFile = `${CURRENT_LINK}/VERSION`;
  try {
    return existsSync(versionFile) ? readFileSync(versionFile, "utf-8").trim() : null;
  } catch {
    return null;
  }
}

// --- the wrapper and its sudoers line ---------------------------------------

export function installWrapper(spec: AddonSpec, bytes: Buffer, quiet = false): void {
  // root:root 0755 in a root-owned directory that is not group-writable. If
  // the site user can write the script it runs as root, we have handed out
  // plain root.
  writeAtomic(spec.wrapperPath, bytes, 0o755);
  run("chown", ["root:root", spec.wrapperPath]);
  run("chown", ["root:root", LIB_DIR]);
  run("chmod", ["755", LIB_DIR]);
  if (!quiet) log.ok(`wrapper installed root:root 0755 at ${spec.wrapperPath}`);
}

export function installSudoers(spec: AddonSpec, user: string, quiet = false): void {
  // One line, one addon, one absolute path, no wildcards. A rule such as
  // `NOPASSWD: /usr/bin/clpctl *` is equivalent to full root.
  const file = `/etc/sudoers.d/clp-addon-${spec.name}`;
  const body =
    `# Managed by clp-addons. One addon, one wrapper, no wildcards.\n` +
    `# ${user} may run exactly this script as root and nothing else.\n` +
    `${user} ALL=(root) NOPASSWD: ${spec.wrapperPath}\n`;

  // Validate a candidate file before it can affect sudo. A malformed drop-in
  // can lock the box out of sudo entirely, so it is never written into place
  // unvalidated.
  const staging = `/etc/sudoers.d/.clp-addon-${spec.name}.candidate`;
  writeAtomic(staging, body, 0o440);
  const check = tryRun("visudo", ["-c", "-f", staging]);
  if (!check.ok) {
    rmSync(staging, { force: true });
    fatal(`refusing to install a sudoers drop-in that does not validate:\n${check.out}`);
  }
  renameSync(staging, file);
  run("chown", ["root:root", file]);
  run("chmod", ["440", file]);

  // Re-validate the whole configuration now that the drop-in is live.
  const full = tryRun("visudo", ["-c"]);
  if (!full.ok) {
    rmSync(file, { force: true });
    fatal(`sudoers configuration broke after installing the drop-in; removed it:\n${full.out}`);
  }
  if (!quiet) log.ok(`sudoers drop-in installed and validated (${user} → ${spec.wrapperPath})`);
}

export function removeSudoers(spec: AddonSpec): void {
  rmSync(`/etc/sudoers.d/clp-addon-${spec.name}`, { force: true });
}

// --- config -----------------------------------------------------------------

/**
 * Shipped defaults land as .new for the operator to diff, so an update can
 * never clobber a config the operator has edited (section 8).
 */
export function writeConfig(spec: AddonSpec, ownDomain: string, user: string, force = false): void {
  const body =
    `# clp-addons: ${spec.name}\n` +
    `# OWN_DOMAIN is the site serving the manager UI. Every addon shares it now:\n` +
    `# there is one CloudPanel site and each addon is mounted under a path on it.\n` +
    `# The wrapper refuses to act on this hostname, so an addon cannot delete the\n` +
    `# vhost it is served through -- or the one another addon is served through.\n` +
    `OWN_DOMAIN=${ownDomain}\n` +
    `PORT=${MANAGER_PORT}\n` +
    `RUN_AS=${user}\n`;

  // On install the operator named the domain explicitly, so their intent is
  // unambiguous and the file is written. On update it is not: the config may
  // have been edited since, so defaults land as .new to diff (section 8).
  if (existsSync(spec.configFile) && !force) {
    const existing = readFileSync(spec.configFile, "utf-8");
    if (existing === body) return;
    writeAtomic(`${spec.configFile}.new`, body, 0o640);
    log.warn(`${spec.configFile} exists and differs; shipped defaults written to ${spec.configFile}.new`);
    return;
  }
  writeAtomic(spec.configFile, body, 0o640);
  run("chown", [`root:${user}`, spec.configFile]);
  rmSync(`${spec.configFile}.new`, { force: true });
}

/**
 * The platform's own record of the shared site.
 *
 * Separate from the per-addon files because it outlives them: uninstalling one
 * addon must not take the hostname the others are served on. Those files are
 * written from this one, never the other way round.
 */
export function writePlatformConfig(domain: string, user: string): void {
  writeAtomic(PLATFORM_CONFIG,
    `# clp-addons: the platform\n` +
    `# One CloudPanel site serves every addon, each mounted under its own path.\n` +
    `DOMAIN=${domain}\n` +
    `PORT=${MANAGER_PORT}\n` +
    `RUN_AS=${user}\n`,
    0o640);
  run("chown", [`root:${user}`, PLATFORM_CONFIG]);
}

export function readPlatformDomain(): string | null {
  if (!existsSync(PLATFORM_CONFIG)) return null;
  const m = readFileSync(PLATFORM_CONFIG, "utf-8").match(/^\s*DOMAIN\s*=\s*(.+)$/m);
  return m ? m[1]!.trim() : null;
}

export function readOwnDomain(spec: AddonSpec): string | null {
  if (!existsSync(spec.configFile)) return null;
  const m = readFileSync(spec.configFile, "utf-8").match(/^\s*OWN_DOMAIN\s*=\s*(.+)$/m);
  return m ? m[1]!.trim() : null;
}

// --- systemd ----------------------------------------------------------------

/**
 * The one manager unit. It serves every installed addon, each under its own
 * path on the shared site, so there is one service, one account and one port
 * rather than a set of each per addon.
 *
 * Every addon's environment is declared here because the process holds all of
 * them. Derived from the installed set rather than written out, so adding an
 * addon is still a registry entry.
 */
function serviceUnit(specs: AddonSpec[], user: string): string {
  // Only the units something installed actually depends on. A box running an
  // addon that never touches Docker should not order its manager after it.
  const after = ["network-online.target", ...new Set(specs.flatMap((sp) => sp.requiresUnits ?? []).map((u) => `${u}.service`))];
  const env = specs.flatMap((sp) => [
    `Environment=${sp.name.toUpperCase()}_APP_DATA=${sp.stateDir}`,
    `Environment=${sp.name.toUpperCase()}_WRAPPER=${sp.wrapperPath}`,
  ]);
  return `[Unit]
Description=CloudPanel addons: manager for ${specs.map((sp) => sp.name).join(", ") || "no addon"}
After=${after.join(" ")}
Wants=${after.join(" ")}

[Service]
Type=simple
User=${user}
Group=${user}
Environment=PORT=${MANAGER_PORT}
Environment=HOST=127.0.0.1
${env.join("\n")}
# Named rather than left to the account's own group list, so the unit states
# what it needs to read ${STATE_DIR}/snapshot.json instead of depending on
# systemd's default handling of an account's supplementary groups.
SupplementaryGroups=${SHARED_GROUP}
ExecStart=${CURRENT_LINK}/${CLI_ARTIFACT} serve
Restart=always
RestartSec=5
UMask=0027

# Deliberately little systemd sandboxing here, and NoNewPrivileges is left off.
#
# The app's only privileged path is 'sudo <wrapper>', and NoNewPrivileges=yes
# blocks sudo outright. Most of the usual hardening directives — ProtectKernel*,
# RestrictNamespaces, RestrictAddressFamilies, SystemCallArchitectures,
# MemoryDenyWriteExecute, RestrictSUIDSGID — imply NoNewPrivileges=yes, so they
# cannot be used here.
#
# Namespace directives are just as unhelpful: ProtectSystem and ProtectHome are
# inherited by children, so they would apply to the wrapper too, and the wrapper
# legitimately needs /home/clp (to read the panel database) and /etc (clpctl
# writes vhosts). Sandboxing the unit would break the boundary rather than
# reinforce it.
#
# The isolation that actually holds is the unprivileged account plus a sudoers
# line naming exactly one script with no wildcards. One account now reaches
# every installed addon's wrapper rather than only its own; that is the price of
# one hostname, and it is the wrapper's argument validation that was always
# carrying the weight.

[Install]
WantedBy=multi-user.target
`;
}

/**
 * The units that run the CLI itself.
 *
 * These ExecStart ${CLI_BIN} rather than the path inside the current release,
 * unlike the addon's own service. The CLI has its own update path -- and
 * `self-update` rewrites exactly one file, ${CLI_BIN} -- so a unit pointing
 * into the release directory would go on running the previous CLI forever
 * after a self-update, with nothing to indicate it.
 */
function reconcileUnits(): { service: string; timer: string; path: string; anchor: string } {
  return {
    // A dpkg post-invoke hook catches apt-driven updates and misses manual
    // ones. A timer catches every path, including unattended-upgrades at 6am.
    service: `[Unit]
Description=CloudPanel addons: reconcile panel-side anchors and state
After=network.target

[Service]
Type=oneshot
ExecStart=${CLI_BIN} repair --quiet
`,
    // OnCalendar, not OnUnitActiveSec.
    //
    // The timer used to carry only monotonic triggers: OnBootSec=2min and
    // OnUnitActiveSec=15min. Both anchor to an event in the past, so as soon as
    // systemd decides there is no future elapse the unit parks in SubState=elapsed
    // and never fires again. Restarting the timer does not revive it -- measured
    // on a staging box, `systemctl restart` left it elapsed with
    // NextElapseUSecMonotonic=infinity, and only activating the service itself
    // re-anchored OnUnitActiveSec. Since startUnits() restarts this timer on every
    // install and update, that made every install a chance to kill reconciliation
    // silently: no nav entry after a panel upgrade, a stale panel snapshot, and no
    // re-assertion of nologin on the one account permitted to sudo the wrapper.
    //
    // A calendar trigger always has a next elapse, so the unit cannot get stuck.
    // Persistent=true also starts meaning something here; it only ever applied to
    // OnCalendar= and was decorative next to the monotonic triggers.
    timer: `[Unit]
Description=CloudPanel addons: periodic reconciliation

[Timer]
OnBootSec=2min
OnCalendar=*:0/15
Persistent=true
RandomizedDelaySec=30

[Install]
WantedBy=timers.target
`,

    // Event-driven repair on top of the timer, so a CloudPanel update is
    // repaired in seconds rather than in up to one timer interval.
    //
    // This is a root-run path unit rather than a watch inside the addon
    // service on purpose: /home/clp is 0700 clp:clp, so the app's account
    // cannot even traverse to the templates. Giving it the access would mean
    // either the clp group (read/write over the whole panel tree) or a new
    // wrapper verb — both widen the privilege boundary to save a few minutes.
    //
    // systemd re-arms the watch by walking up to the nearest existing parent,
    // which is what makes this survive cloudpanel.postinst moving the whole
    // app directory aside and extracting a fresh one.
    //
    // The timer stays as the backstop: a path unit can miss an event, and
    // repair also refreshes the snapshot and the sudoers drop-in.
    path: `[Unit]
Description=CloudPanel addons: watch the panel templates we patch

[Path]
${templateWatchPaths().map((p) => `PathChanged=${p}`).join("\n")}
Unit=${ANCHOR_SERVICE}

[Install]
WantedBy=paths.target
`,

    anchor: `[Unit]
Description=CloudPanel addons: re-inject the panel anchors

[Service]
Type=oneshot
# An update rewrites these templates repeatedly while it extracts. systemd will
# not run this concurrently with itself, so a short pause here coalesces the
# burst into one pass plus a confirming second one.
ExecStartPre=/bin/sleep 2
ExecStart=${CLI_BIN} repair --anchors-only --quiet
`,
  };
}

/**
 * Returns true when the addon's own unit changed, which the caller must treat
 * as "restart required". systemd keeps running the old definition otherwise —
 * notably the old User=, which then blocks removing the account it replaced.
 */
export function installUnits(specs: AddonSpec[], user: string): boolean {
  const units = reconcileUnits();
  const unitPath = `${SYSTEMD_DIR}/${MANAGER_UNIT}`;
  const desired = serviceUnit(specs, user);
  const current = existsSync(unitPath) ? readFileSync(unitPath, "utf-8") : "";
  const changed = current !== desired;
  writeAtomic(unitPath, desired, 0o644);
  writeAtomic(`${SYSTEMD_DIR}/${RECONCILE_SERVICE}`, units.service, 0o644);
  writeAtomic(`${SYSTEMD_DIR}/${RECONCILE_TIMER}`, units.timer, 0o644);
  writeAtomic(`${SYSTEMD_DIR}/${ANCHOR_SERVICE}`, units.anchor, 0o644);
  writeAtomic(`${SYSTEMD_DIR}/${RECONCILE_PATH}`, units.path, 0o644);
  run("systemctl", ["daemon-reload"]);
  return changed;
}

export function startUnits(): void {
  run("systemctl", ["enable", MANAGER_UNIT]);
  run("systemctl", ["restart", MANAGER_UNIT]);
  run("systemctl", ["enable", RECONCILE_TIMER]);
  run("systemctl", ["restart", RECONCILE_TIMER]);
  run("systemctl", ["enable", RECONCILE_PATH]);
  run("systemctl", ["restart", RECONCILE_PATH]);
  // Restarting a timer is the operation that used to leave it permanently
  // elapsed, so confirm it came back with a real next elapse rather than
  // assuming it did.
  ensureTimerArmed(RECONCILE_TIMER);
  log.ok(`${MANAGER_UNIT}, ${RECONCILE_TIMER} and ${RECONCILE_PATH} enabled`);
}

/**
 * Stop and remove an addon's units.
 *
 * `keepShared` is what makes uninstalling one addon safe for another. The
 * reconcile timer, its service, and the anchor path unit belong to the platform
 * rather than to any addon, and this used to delete them unconditionally. So
 * `uninstall addonA` stopped reconciliation for addon B, and B could not recover
 * on its own: `repair` is what rewrites those units, and the timer that runs
 * `repair` had just been deleted. cmdUninstall already knew whether anything
 * else was still installed -- it uses the same answer to decide whether to keep
 * the CLI and the release tree -- so it passes it here too.
 */
export function stopUnits(keepShared = false): void {
  // The manager unit is now shared too: it serves every installed addon, so it
  // only goes when the last one does. Uninstalling one addon rewrites and
  // restarts it instead, which is what drops that addon's routes.
  if (keepShared) {
    tryRun("systemctl", ["daemon-reload"]);
    return;
  }

  for (const u of [MANAGER_UNIT, RECONCILE_TIMER, RECONCILE_PATH]) {
    tryRun("systemctl", ["disable", "--now", u]);
  }
  const files = [`${SYSTEMD_DIR}/${MANAGER_UNIT}`, `${SYSTEMD_DIR}/${RECONCILE_SERVICE}`,
     `${SYSTEMD_DIR}/${RECONCILE_TIMER}`, `${SYSTEMD_DIR}/${RECONCILE_PATH}`,
     `${SYSTEMD_DIR}/${ANCHOR_SERVICE}`];
  for (const f of files) rmSync(f, { force: true });

  tryRun("systemctl", ["daemon-reload"]);
}

/**
 * Which account the unit is *actually* running as right now, which is not
 * necessarily what the unit file says: systemd keeps the definition it started
 * with until the service is restarted. Comparing the file alone misses the
 * case where an earlier run already rewrote it.
 */
export function unitRunningUser(unit: string): string | null {
  const pid = tryRun("systemctl", ["show", "-p", "MainPID", "--value", unit]).out.trim();
  if (!pid || pid === "0") return null;
  const owner = tryRun("ps", ["-o", "user=", "-p", pid]).out.trim();
  return owner || null;
}

/**
 * Remove the per-addon service units that predate the shared manager. Idempotent,
 * and safe to call when they were never there.
 */
export function removeLegacyUnits(quiet = false): void {
  for (const unit of LEGACY_UNITS) {
    const file = `${SYSTEMD_DIR}/${unit}`;
    if (!existsSync(file)) continue;
    if (!quiet) log.warn(`removing the legacy unit ${unit}; one manager serves every addon now`);
    tryRun("systemctl", ["disable", "--now", unit]);
    rmSync(file, { force: true });
    tryRun("systemctl", ["daemon-reload"]);
  }
}

export function unitActive(unit: string): string {
  return tryRun("systemctl", ["is-active", unit]).out || "unknown";
}

/**
 * When a timer will next fire, or null when it has no scheduled elapse.
 *
 * `systemctl is-active` is not enough to tell whether a timer still works. A
 * timer that has fallen into SubState=elapsed reports `active` and will never
 * run again, which is exactly the state the old monotonic-only unit reached --
 * so `status` said the reconciliation timer was healthy while it had been dead
 * for thirteen hours. Ask for the next elapse instead, because that is the thing
 * that has to be true for the timer to be doing its job.
 */
export function timerNextElapse(unit: string): string | null {
  for (const prop of ["NextElapseUSecRealtime", "NextElapseUSecMonotonic"]) {
    const v = tryRun("systemctl", ["show", "-p", prop, "--value", unit]).out.trim();
    if (v && v !== "0" && v !== "infinity" && v !== "n/a") return v;
  }
  return null;
}

/**
 * Put a stuck timer back to work.
 *
 * `systemctl start` is a no-op on a unit that is already active, so the previous
 * recovery here could never fix an elapsed timer -- the one case that needed
 * fixing. Restart is what re-evaluates the trigger, and with a calendar trigger
 * that always yields a future elapse.
 */
export function ensureTimerArmed(unit: string, quiet = false): void {
  if (timerNextElapse(unit)) return;
  if (!quiet) log.warn(`${unit} has no scheduled elapse; restarting it`);
  tryRun("systemctl", ["restart", unit]);
  if (!timerNextElapse(unit)) log.err(`${unit} still has no scheduled elapse after a restart`);
}

// --- the addon's own CloudPanel site ----------------------------------------

/**
 * The one CloudPanel site every addon is served from (decision 2.4).
 *
 * Stock reverse proxy, so SSL, backups and per-site security keep working
 * without us touching a vhost, and clpctl stays the only thing that writes
 * panel state (decision 2.6). One site rather than one per addon is also what
 * keeps the vhost stock: the template has exactly one {{reverse_proxy_url}} and
 * no clpctl verb rewrites an existing site's vhost, so routing per addon has to
 * happen above nginx. It happens in the manager, by path.
 */
export function ensureManagerSite(domain: string): boolean {
  // An existing site is adopted, but only when it is already the reverse proxy
  // this manager needs. Adopting a static or PHP site instead leaves the manager
  // running on its port with nothing routing to it, and nothing says so: the
  // hostname resolves, nginx answers 200 from whatever was there first, and the
  // install reports success. Same defect the wrapper's cmd_create had for
  // instances; the panel records both facts that tell the two apart.
  const row = tryRun("sqlite3", ["-readonly", PANEL_DB,
    `SELECT type, COALESCE(reverse_proxy_url, '') FROM site WHERE domain_name = '${domain}';`]);
  if (row.ok && row.out.trim()) {
    const [type, url] = row.out.trim().split("|");
    const wanted = `http://127.0.0.1:${MANAGER_PORT}`;
    if (type !== "reverse-proxy") {
      fatal(
        `a CloudPanel site for ${domain} already exists and is a '${type}' site, not a reverse proxy.\n` +
          `  Adopting it would leave the manager unreachable. Delete that site, or use a\n` +
          `  hostname of its own for the addons.`
      );
    }
    if (url !== wanted) {
      fatal(
        `the CloudPanel site ${domain} proxies '${url}' rather than ${wanted}.\n` +
          `  That is somebody else's upstream. Use a hostname of its own for the addons.`
      );
    }
    log.ok(`CloudPanel site ${domain} already exists and proxies ${wanted}`);
    return false;
  }

  log.step(`creating CloudPanel reverse-proxy site ${domain} → 127.0.0.1:${MANAGER_PORT}`);

  const siteUser = siteUserFor(domain);
  const taken = tryRun("sqlite3", ["-readonly", PANEL_DB,
    `SELECT domain_name FROM site WHERE user = '${siteUser}';`]);
  if (taken.ok && taken.out) {
    fatal(
      `the site user '${siteUser}' is already used by ${taken.out}.\n` +
        `  Delete that site, or install under a different hostname.`
    );
  }
  const password = `Aa1${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}!`;
  const r = tryRun("clpctl", [
    "site:add:reverse-proxy",
    `--domainName=${domain}`,
    `--reverseProxyUrl=http://127.0.0.1:${MANAGER_PORT}`,
    `--siteUser=${siteUser}`,
    `--siteUserPassword=${password}`,
  ]);
  if (!r.ok) fatal(`clpctl site:add:reverse-proxy failed for ${domain}:\n${r.out}`);
  log.ok(`site ${domain} created`);
  log.warn(
    `Add per-site security for ${domain} in the panel now (Site → Security → Basic Auth,\n` +
      `  and an IP allowlist if you have static addresses). The manager can create and delete\n` +
      `  sites, so it must not be reachable without authentication.`
  );
  return true;
}


// Everything that puts the box into the installed state. Written so that
// `repair` can call the same functions as `install`: there must be exactly one
// implementation of "make the box match what should be installed", or the
// reconciliation timer and the installer drift apart.

import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, renameSync, readdirSync } from "node:fs";
import {
  ADDONS, ANCHOR_SERVICE, CONFIG_DIR, CURRENT_LINK, LEGACY_USERS, LIB_DIR, LOCK_DIR,
  RECONCILE_PATH, RECONCILE_SERVICE, RECONCILE_TIMER, RELEASES_DIR, STATE_DIR, SYSTEMD_DIR,
  TEMPLATE_WATCH_PATHS, type AddonSpec,
} from "./paths";
import { fatal, log, run, tryRun, writeAtomic } from "./util";
import type { FetchedArtifact } from "./release";

// --- accounts ---------------------------------------------------------------

const PANEL_DB = "/home/clp/htdocs/app/data/db.sq3";

/**
 * The account the manager runs as is the one CloudPanel created for the
 * addon's own site (decision 2.4), not one this installer invents. One account
 * per addon site rather than two, and CloudPanel owns its lifecycle: deleting
 * the site removes the user, so uninstall has nothing of its own to clean up.
 */
export function resolveSiteUser(domain: string): string {
  const r = tryRun("sqlite3", ["-readonly", PANEL_DB,
    `SELECT user FROM site WHERE domain_name = '${domain}';`]);
  const user = r.ok ? r.out.trim() : "";
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
  const shell = tryRun("getent", ["passwd", user]).out.split(":")[6] ?? "";
  const locked = tryRun("passwd", ["-S", user]).out.split(/\s+/)[1] === "L";

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

export function ensureDirs(spec: AddonSpec, user: string): void {
  for (const d of [LIB_DIR, RELEASES_DIR, CONFIG_DIR, STATE_DIR, LOCK_DIR]) {
    mkdirSync(d, { recursive: true });
  }
  mkdirSync(spec.stateDir, { recursive: true });

  // Not recursive, and deliberately so. The subdirectories of the state dir are
  // instance storage, each owned by the site user of the instance that runs
  // there. A `chown -R` here hands all of them to the manager, at which point
  // every container loses the ability to write its own database -- and since
  // `repair` calls this and the reconcile timer calls `repair`, it would do so
  // again every fifteen minutes. The wrapper owns instance directories; this
  // function owns the manager's own files and nothing below them.
  run("chown", [`${user}:${user}`, spec.stateDir]);
  run("chmod", ["750", spec.stateDir]);

  const appDb = `${spec.stateDir}/app.db`;
  if (existsSync(appDb)) run("chown", [`${user}:${user}`, appDb]);

  // The snapshot is customer data: the app's group reads it, nobody else.
  const snapshot = `${STATE_DIR}/snapshot.json`;
  if (existsSync(snapshot)) {
    run("chown", [`root:${user}`, snapshot]);
    run("chmod", ["640", snapshot]);
  }
}

// --- releases ---------------------------------------------------------------

/**
 * Place a release under releases/<tag> and move `current` onto it. Immutable
 * directories mean a rollback is a symlink swap rather than a re-download.
 */
export function placeRelease(tag: string, artifacts: FetchedArtifact[]): string {
  const dir = `${RELEASES_DIR}/${tag}`;
  mkdirSync(dir, { recursive: true });
  for (const a of artifacts) {
    // The wrapper stays a plain script (decision 2.13); both are 0755 root:root.
    writeAtomic(`${dir}/${a.name}`, a.bytes, 0o755);
  }
  writeAtomic(`${dir}/VERSION`, `${tag}\n`, 0o644);

  const tmpLink = `${CURRENT_LINK}.new`;
  rmSync(tmpLink, { force: true });
  symlinkSync(dir, tmpLink);
  renameSync(tmpLink, CURRENT_LINK);
  log.ok(`release ${tag} placed and 'current' now points at it`);
  return dir;
}

/** Keep the last two releases so a rollback target always exists. */
export function pruneReleases(keep = 2): void {
  if (!existsSync(RELEASES_DIR)) return;
  const current = existsSync(CURRENT_LINK) ? readlinkSync(CURRENT_LINK) : "";
  const dirs = readdirSync(RELEASES_DIR).sort().reverse();
  for (const d of dirs.slice(keep)) {
    const path = `${RELEASES_DIR}/${d}`;
    if (path === current) continue;
    log.step(`pruning old release ${d}`);
    rmSync(path, { recursive: true, force: true });
  }
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
    `# OWN_DOMAIN is the site serving the manager UI. The wrapper refuses to\n` +
    `# act on it, so the addon cannot delete the vhost it is served through.\n` +
    `OWN_DOMAIN=${ownDomain}\n` +
    `PORT=${spec.port}\n` +
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

export function readOwnDomain(spec: AddonSpec): string | null {
  if (!existsSync(spec.configFile)) return null;
  const m = readFileSync(spec.configFile, "utf-8").match(/^\s*OWN_DOMAIN\s*=\s*(.+)$/m);
  return m ? m[1]!.trim() : null;
}

// --- systemd ----------------------------------------------------------------

function serviceUnit(spec: AddonSpec, user: string): string {
  return `[Unit]
Description=CloudPanel addon: ${spec.name} manager
After=network-online.target docker.service
Wants=network-online.target docker.service

[Service]
Type=simple
User=${user}
Group=${user}
Environment=PORT=${spec.port}
Environment=HOST=127.0.0.1
Environment=INSTATIC_APP_DATA=${spec.stateDir}
Environment=INSTATIC_WRAPPER=${spec.wrapperPath}
ExecStart=${CURRENT_LINK}/${spec.appArtifact}
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
# line naming exactly one script with no wildcards. That is worth precisely as
# much as the wrapper's argument validation is strict, which is why the wrapper
# is the file to review line by line.

[Install]
WantedBy=multi-user.target
`;
}

function reconcileUnits(): { service: string; timer: string; path: string; anchor: string } {
  return {
    // A dpkg post-invoke hook catches apt-driven updates and misses manual
    // ones. A timer catches every path, including unattended-upgrades at 6am.
    service: `[Unit]
Description=CloudPanel addons: reconcile panel-side anchors and state
After=network.target

[Service]
Type=oneshot
ExecStart=${CURRENT_LINK}/clp-addons-linux-x64 repair --quiet
`,
    timer: `[Unit]
Description=CloudPanel addons: periodic reconciliation

[Timer]
OnBootSec=2min
OnUnitActiveSec=15min
Persistent=true

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
${TEMPLATE_WATCH_PATHS.map((p) => `PathChanged=${p}`).join("\n")}
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
ExecStart=${CURRENT_LINK}/clp-addons-linux-x64 repair --anchors-only --quiet
`,
  };
}

/**
 * Returns true when the addon's own unit changed, which the caller must treat
 * as "restart required". systemd keeps running the old definition otherwise —
 * notably the old User=, which then blocks removing the account it replaced.
 */
export function installUnits(spec: AddonSpec, user: string): boolean {
  const units = reconcileUnits();
  const unitPath = `${SYSTEMD_DIR}/${spec.unit}`;
  const desired = serviceUnit(spec, user);
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

export function startUnits(spec: AddonSpec): void {
  run("systemctl", ["enable", spec.unit]);
  run("systemctl", ["restart", spec.unit]);
  run("systemctl", ["enable", RECONCILE_TIMER]);
  run("systemctl", ["restart", RECONCILE_TIMER]);
  run("systemctl", ["enable", RECONCILE_PATH]);
  run("systemctl", ["restart", RECONCILE_PATH]);
  log.ok(`${spec.unit}, ${RECONCILE_TIMER} and ${RECONCILE_PATH} enabled`);
}

export function stopUnits(spec: AddonSpec): void {
  for (const u of [spec.unit, RECONCILE_TIMER, RECONCILE_PATH]) {
    tryRun("systemctl", ["disable", "--now", u]);
  }
  for (const f of [`${SYSTEMD_DIR}/${spec.unit}`, `${SYSTEMD_DIR}/${RECONCILE_SERVICE}`,
                   `${SYSTEMD_DIR}/${RECONCILE_TIMER}`, `${SYSTEMD_DIR}/${RECONCILE_PATH}`,
                   `${SYSTEMD_DIR}/${ANCHOR_SERVICE}`]) {
    rmSync(f, { force: true });
  }
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

export function unitActive(unit: string): string {
  return tryRun("systemctl", ["is-active", unit]).out || "unknown";
}

// --- the addon's own CloudPanel site ----------------------------------------

/**
 * The manager runs behind a stock CloudPanel reverse-proxy site (decision 2.4),
 * so SSL, backups and per-site security keep working without us touching a
 * vhost. clpctl is the only thing that writes panel state; we never do
 * (decision 2.6).
 */
export function ensureAddonSite(spec: AddonSpec, domain: string): boolean {
  const db = "/home/clp/htdocs/app/data/db.sq3";
  const exists = tryRun("sqlite3", ["-readonly", db,
    `SELECT COUNT(*) FROM site WHERE domain_name = '${domain}';`]);
  if (exists.ok && Number(exists.out) > 0) {
    log.ok(`CloudPanel site ${domain} already exists`);
    return false;
  }

  log.step(`creating CloudPanel reverse-proxy site ${domain} → 127.0.0.1:${spec.port}`);

  // Derived from the domain, not from the addon name: a fixed name means a
  // second addon site, or a reinstall under a different hostname, collides
  // with a user that clpctl will not reuse.
  const siteUser = `a${spec.name.slice(0, 4)}-${domain.replace(/[^a-z0-9]/g, "")}`.slice(0, 15);
  const taken = tryRun("sqlite3", ["-readonly", db,
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
    `--reverseProxyUrl=http://127.0.0.1:${spec.port}`,
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

export { ADDONS };

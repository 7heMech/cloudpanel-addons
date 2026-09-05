// Everything that puts the box into the installed state. Written so that
// `repair` can call the same functions as `install`: there must be exactly one
// implementation of "make the box match what should be installed", or the
// reconciliation timer and the installer drift apart.

import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, renameSync, readdirSync } from "node:fs";
import {
  ADDONS, CONFIG_DIR, CURRENT_LINK, LIB_DIR, LOCK_DIR, RECONCILE_SERVICE, RECONCILE_TIMER,
  RELEASES_DIR, STATE_DIR, SYSTEMD_DIR, type AddonSpec,
} from "./paths";
import { fatal, log, run, tryRun, writeAtomic } from "./util";
import type { FetchedArtifact } from "./release";

// --- accounts ---------------------------------------------------------------

export function ensureUser(spec: AddonSpec): void {
  if (tryRun("id", ["-u", spec.user]).ok) return;
  log.step(`creating system user ${spec.user}`);
  // No shell, no home, no docker group. The wrapper is the only privileged
  // path this account has, which is the whole point of decision 2.5.
  run("useradd", ["--system", "--shell", "/usr/sbin/nologin", "--no-create-home",
                  "--home-dir", spec.stateDir, spec.user]);
}

/**
 * Docker group membership is equivalent to root: a member can start a
 * container with the host filesystem bind-mounted. Being in it would make the
 * wrapper's argument validation decorative, so check and undo it.
 */
export function assertNotInDockerGroup(spec: AddonSpec): void {
  const r = tryRun("id", ["-nG", spec.user]);
  if (!r.ok) return;
  if (r.out.split(/\s+/).includes("docker")) {
    log.warn(`${spec.user} is in the docker group, which is equivalent to root; removing`);
    tryRun("gpasswd", ["-d", spec.user, "docker"]);
  }
}

// --- directories ------------------------------------------------------------

export function ensureDirs(spec: AddonSpec): void {
  for (const d of [LIB_DIR, RELEASES_DIR, CONFIG_DIR, STATE_DIR, LOCK_DIR]) {
    mkdirSync(d, { recursive: true });
  }
  mkdirSync(spec.stateDir, { recursive: true });
  run("chown", ["-R", `${spec.user}:${spec.user}`, spec.stateDir]);
  run("chmod", ["750", spec.stateDir]);

  // The snapshot is customer data: the app's group reads it, nobody else.
  const snapshot = `${STATE_DIR}/snapshot.json`;
  if (existsSync(snapshot)) {
    run("chown", [`root:${spec.user}`, snapshot]);
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

export function installSudoers(spec: AddonSpec, quiet = false): void {
  // One line, one addon, one absolute path, no wildcards. A rule such as
  // `NOPASSWD: /usr/bin/clpctl *` is equivalent to full root.
  const file = `/etc/sudoers.d/clp-addon-${spec.name}`;
  const body =
    `# Managed by clp-addons. One addon, one wrapper, no wildcards.\n` +
    `# ${spec.user} may run exactly this script as root and nothing else.\n` +
    `${spec.user} ALL=(root) NOPASSWD: ${spec.wrapperPath}\n`;

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
  if (!quiet) log.ok(`sudoers drop-in installed and validated (${spec.user} → ${spec.wrapperPath})`);
}

export function removeSudoers(spec: AddonSpec): void {
  rmSync(`/etc/sudoers.d/clp-addon-${spec.name}`, { force: true });
}

// --- config -----------------------------------------------------------------

/**
 * Shipped defaults land as .new for the operator to diff, so an update can
 * never clobber a config the operator has edited (section 8).
 */
export function writeConfig(spec: AddonSpec, ownDomain: string, force = false): void {
  const body =
    `# clp-addons: ${spec.name}\n` +
    `# OWN_DOMAIN is the site serving the manager UI. The wrapper refuses to\n` +
    `# act on it, so the addon cannot delete the vhost it is served through.\n` +
    `OWN_DOMAIN=${ownDomain}\n` +
    `PORT=${spec.port}\n`;

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
  run("chown", [`root:${spec.user}`, spec.configFile]);
  rmSync(`${spec.configFile}.new`, { force: true });
}

export function readOwnDomain(spec: AddonSpec): string | null {
  if (!existsSync(spec.configFile)) return null;
  const m = readFileSync(spec.configFile, "utf-8").match(/^\s*OWN_DOMAIN\s*=\s*(.+)$/m);
  return m ? m[1]!.trim() : null;
}

// --- systemd ----------------------------------------------------------------

function serviceUnit(spec: AddonSpec): string {
  return `[Unit]
Description=CloudPanel addon: ${spec.name} manager
After=network-online.target docker.service
Wants=network-online.target docker.service

[Service]
Type=simple
User=${spec.user}
Group=${spec.user}
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

function reconcileUnits(): { service: string; timer: string } {
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
  };
}

export function installUnits(spec: AddonSpec): void {
  const units = reconcileUnits();
  writeAtomic(`${SYSTEMD_DIR}/${spec.unit}`, serviceUnit(spec), 0o644);
  writeAtomic(`${SYSTEMD_DIR}/${RECONCILE_SERVICE}`, units.service, 0o644);
  writeAtomic(`${SYSTEMD_DIR}/${RECONCILE_TIMER}`, units.timer, 0o644);
  run("systemctl", ["daemon-reload"]);
}

export function startUnits(spec: AddonSpec): void {
  run("systemctl", ["enable", spec.unit]);
  run("systemctl", ["restart", spec.unit]);
  run("systemctl", ["enable", RECONCILE_TIMER]);
  run("systemctl", ["restart", RECONCILE_TIMER]);
  log.ok(`${spec.unit} and ${RECONCILE_TIMER} enabled`);
}

export function stopUnits(spec: AddonSpec): void {
  for (const u of [spec.unit, RECONCILE_TIMER]) tryRun("systemctl", ["disable", "--now", u]);
  for (const f of [`${SYSTEMD_DIR}/${spec.unit}`, `${SYSTEMD_DIR}/${RECONCILE_SERVICE}`,
                   `${SYSTEMD_DIR}/${RECONCILE_TIMER}`]) {
    rmSync(f, { force: true });
  }
  tryRun("systemctl", ["daemon-reload"]);
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

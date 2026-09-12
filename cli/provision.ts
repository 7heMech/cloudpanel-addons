import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync,
} from "node:fs";
import {
  ADDON_NAMES, ANCHOR_SERVICE, CLI_BIN, CONFIG_DIR, LIBEXEC_DIR, LEGACY_UNITS,
  ADDONS, AUTH_SERVICE_UNIT, AUTH_SOCKET_PATH, AUTH_SOCKET_UNIT, LEGACY_USERS, LOCK_DIR, MANAGER_UNIT,
  PANEL_GROUP, PANEL_USER, RECONCILE_PATH, RECONCILE_SERVICE,
  RECONCILE_TIMER, SERVICE_GROUP, SERVICE_USER, SESSION_DIR, SHARED_GROUP, SOCKET_DIR, STATE_DIR,
  SYSTEMD_DIR, TWIG_CACHE_DIR, PANEL_IDENTITY_PATH, type AddonSpec, templateWatchPaths,
} from "./paths";
import { findMasterVhost, panelVhostWatchPath } from "./inject";
import { panelUserUid } from "../lib/sso-auth";
import { fatal, log, run, tryRun, writeAtomic } from "./util";

export { PANEL_IDENTITY_PATH } from "./paths";

const LEGACY_MANAGER_AUTH = `${CONFIG_DIR}/manager-auth`;
const LEGACY_PLATFORM_CONFIG = `${CONFIG_DIR}/platform.conf`;
const LEGACY_SITE_MARKER = `${STATE_DIR}/.site-created-by-addons`;
const LEGACY_LIBRARY_DIR = "/usr/local/lib/clp-addons";
const BACKUP_DIR = "/var/backups/clp-addons";
const INSTATIC_BACKUP_CRON = "/etc/cron.d/clp-addons-instatic-backup";

export function instaticBackupCron(): string {
  return `# Instatic recovery snapshots for CloudPanel Remote Backups.
# Adjust this schedule to precede your Remote Backup schedule.
# CloudPanel's 04:15 create_backup.sh backs up the panel application itself.
SHELL=/bin/sh
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
30 3 * * * root ${CLI_BIN} action instatic backup
`;
}

export function reconcileInstaticBackupCron(enabled: boolean, path = INSTATIC_BACKUP_CRON): void {
  if (!enabled) {
    rmSync(path, { force: true });
  } else if (!existsSync(path)) {
    // Preserve an operator's schedule across update/repair.
    writeAtomic(path, instaticBackupCron(), 0o644);
  }
}
export interface ProvisionCommandRunner {
  run(command: string, args: string[]): string;
  tryRun(command: string, args: string[]): { ok: boolean; out: string };
}

interface DirectoryOperations {
  mkdir(path: string, options: { recursive: true }): void;
  exists(path: string): boolean;
}

const directoryOperations: DirectoryOperations = {
  mkdir: (path, options) => { mkdirSync(path, options); },
  exists: existsSync,
};

const HOSTNAME_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOSTNAME_RE = new RegExp(`^(?:${HOSTNAME_LABEL})(?:\\.${HOSTNAME_LABEL})+$`);
const WILDCARD_HOSTNAME_RE = new RegExp(`^\\*\\.(?:${HOSTNAME_LABEL})(?:\\.${HOSTNAME_LABEL})+$`);

export interface PanelIdentity {
  primary: string;
  aliases: string[];
}

function normalizePanelHostname(value: string): string | null {
  let host = value.trim().toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (!host || host.includes("..")) return null;
  if (HOSTNAME_RE.test(host) || WILDCARD_HOSTNAME_RE.test(host)) return host;
  return null;
}

/** Extract the panel's exact and wildcard server names from a root-owned vhost. */
export function panelIdentityFromVhost(content: string): PanelIdentity | null {
  const names = new Set<string>();
  const uncommented = content.replace(/#[^\r\n]*/g, "");
  const directive = /(?:^|[;{}])\s*server_name\s+([^;]+);/gim;
  let match: RegExpExecArray | null;
  let sawDirective = false;
  while ((match = directive.exec(uncommented))) {
    sawDirective = true;
    for (const raw of match[1]!.trim().split(/\s+/)) {
      if (raw === "_" || raw.toLowerCase() === "localhost") continue;
      const name = normalizePanelHostname(raw);
      if (!name) return null;
      names.add(name);
    }
  }

  const exact = [...names].find((name) => HOSTNAME_RE.test(name));
  // A stock CloudPanel serves the panel as `server_name _;` and only gains a
  // hostname once an operator sets one. That is the catch-all panel, not an
  // unparseable vhost: there is no panel domain, so nothing can collide with
  // it, and the guard has nothing to refuse. A vhost with no server_name at
  // all is still rejected -- it is not the file we think it is.
  if (!exact) return sawDirective && names.size === 0 ? { primary: "", aliases: [] } : null;
  return { primary: exact, aliases: [...names].filter((name) => name !== exact).sort() };
}

function installedAddonSpecs(): AddonSpec[] {
  return ADDON_NAMES.map((name) => ADDONS[name]!).filter((spec) => existsSync(spec.configFile));
}

/**
 * Who may own the panel vhost we read the identity from, and inject the proxy
 * into.
 *
 * This used to demand root ownership. On the CloudPanel layout that is
 * unsatisfiable by design -- the panel owns its whole Nginx tree, config root
 * included -- and demanding it bought nothing, because the panel user is
 * already inside this project's trust boundary in two load-bearing ways: the
 * manager socket is group `clp` mode 0660 so the panel can reach the daemon
 * without going through Nginx at all, and the session files `action auth`
 * trusts to decide who you are are panel-owned, so the panel user can mint a
 * session that comes back ROLE_ADMIN. A vhost check cannot defend against an
 * actor that already holds both.
 *
 * What is still worth refusing is a vhost any local user can rewrite. That is
 * the check's remaining job; do not re-tighten this to root-only without
 * reading docs/DECISIONS.md first, as it makes the installer refuse every
 * current CloudPanel.
 */
export function vhostOwnerAccepted(uid: number, mode: number): boolean {
  if ((mode & 0o002) !== 0) return false;
  if (uid === 0) return true;
  const panelUid = panelUserUid();
  return panelUid !== null && uid === panelUid;
}

function ensurePanelIdentity(quiet = false): void {
  const vhostPath = findMasterVhost();
  if (!vhostPath) fatal("CloudPanel master vhost was not found; refusing to install privileged actions");

  let content: string;
  let trustedOwner = false;
  let panelOwned = false;
  try {
    const stat = statSync(vhostPath);
    trustedOwner = stat.isFile() && vhostOwnerAccepted(stat.uid, stat.mode);
    panelOwned = stat.uid !== 0;
    content = readFileSync(vhostPath, "utf-8");
  } catch {
    fatal(`CloudPanel master vhost could not be read: ${vhostPath}`);
  }
  if (!trustedOwner) {
    fatal(`CloudPanel master vhost must be owned by root or ${PANEL_USER} and not world-writable: ${vhostPath}`);
  }
  if (panelOwned && !quiet) {
    log.warn(`${vhostPath} is owned by ${PANEL_USER}, not root: the panel can rewrite the /addons/ proxy at any time, and reconciliation is what restores it`);
  }

  const identity = panelIdentityFromVhost(content);
  if (!identity) {
    fatal(`CloudPanel master vhost has no valid panel identity: ${vhostPath}`);
  }

  const aliases = identity.aliases.length ? identity.aliases.join(" ") : "";
  const body =
    "# Managed by clp-addons; read by the root action binary.\n" +
    `PRIMARY=${identity.primary}\n` +
    `ALIASES=${aliases}\n`;
  writeAtomic(PANEL_IDENTITY_PATH, body, 0o600);
  run("chown", ["root:root", PANEL_IDENTITY_PATH]);
  run("chmod", ["600", PANEL_IDENTITY_PATH]);
  if (!quiet) log.ok(`panel identity recorded from ${vhostPath}`);
}

function groupNames(output: string): Set<string> {
  return new Set(output.trim().split(/\s+/).filter(Boolean));
}

function dockerGroupHasUser(output: string): boolean {
  const members = output.trim().split(":")[3] ?? "";
  return members.split(",").map((member) => member.trim()).includes(SERVICE_USER);
}

function enforceNoDockerMembership(commands: ProvisionCommandRunner): void {
  const docker = commands.tryRun("getent", ["group", "docker"]);
  if (!docker.ok) return;

  const before = commands.tryRun("id", ["-nG", SERVICE_USER]);
  if (!before.ok) {
    fatal(`could not inspect ${SERVICE_USER} group membership; refusing to continue`);
  }
  if (!groupNames(before.out).has("docker")) return;

  const primary = commands.tryRun("id", ["-gn", SERVICE_USER]);
  if (!primary.ok) {
    fatal(`could not inspect ${SERVICE_USER}'s primary group; refusing to continue`);
  }

  if (primary.out.trim() === "docker") {
    const moved = commands.tryRun("usermod", ["--gid", SERVICE_GROUP, SERVICE_USER]);
    if (!moved.ok) {
      fatal(`could not move ${SERVICE_USER} to its dedicated primary group: ${moved.out || "usermod failed"}`);
    }
  }

  if (dockerGroupHasUser(docker.out)) {
    const removed = commands.tryRun("gpasswd", ["--delete", SERVICE_USER, "docker"]);
    if (!removed.ok) {
      fatal(`could not remove ${SERVICE_USER} from the docker group: ${removed.out || "gpasswd failed"}`);
    }
  }

  const after = commands.tryRun("id", ["-nG", SERVICE_USER]);
  if (!after.ok || groupNames(after.out).has("docker")) {
    fatal(`security invariant failed: ${SERVICE_USER} is still a member of the docker group`);
  }
}

export function ensureServiceUser(
  quiet = false,
  commands: ProvisionCommandRunner = { run, tryRun },
): void {
  const userExists = commands.tryRun("id", ["-u", SERVICE_USER]).ok;
  if (!userExists) {
    const userArgs = ["--system", "--no-create-home", "--shell", "/usr/sbin/nologin"];
    if (commands.tryRun("getent", ["group", SERVICE_GROUP]).ok) userArgs.push("--gid", SERVICE_GROUP);
    else userArgs.push("--user-group");
    userArgs.push(SERVICE_USER);
    commands.run("useradd", userArgs);
    if (!quiet) log.ok(`created system user ${SERVICE_USER}`);
  }
  if (!commands.tryRun("getent", ["group", SERVICE_GROUP]).ok) {
    commands.run("groupadd", ["--system", SERVICE_GROUP]);
  }

  const passwd = commands.tryRun("getent", ["passwd", SERVICE_USER]).out.split(":");
  if (passwd[6] !== "/usr/sbin/nologin") {
    commands.run("usermod", ["--shell", "/usr/sbin/nologin", SERVICE_USER]);
  }
  const status = commands.tryRun("passwd", ["-S", SERVICE_USER]).out.split(/\s+/);
  if (status[1] !== "L") commands.tryRun("passwd", ["-l", SERVICE_USER]);

  enforceNoDockerMembership(commands);

  if (!commands.tryRun("getent", ["group", PANEL_GROUP]).ok) {
    fatal(`CloudPanel group '${PANEL_GROUP}' was not found`);
  }
  const groups = [...groupNames(commands.tryRun("id", ["-nG", SERVICE_USER]).out)];
  if (!groups.includes(PANEL_GROUP)) {
    commands.run("usermod", ["-aG", PANEL_GROUP, SERVICE_USER]);
    if (!quiet) log.ok(`added ${SERVICE_USER} to ${PANEL_GROUP}`);
  }
}

export function removeLegacyUsers(quiet = false): void {
  for (const user of LEGACY_USERS) {
    if (!tryRun("id", ["-u", user]).ok) continue;
    tryRun("gpasswd", ["-d", user, "docker"]);
    rmSync(`/etc/sudoers.d/clp-addon-${user}`, { force: true });
    const result = tryRun("userdel", [user]);
    if (!result.ok && !quiet) log.warn(`could not remove legacy user ${user}: ${result.out}`);
  }
}

export function removeLegacyInstall(quiet = false): void {
  if (existsSync(LEGACY_SITE_MARKER)) {
    const domain = readFileSync(LEGACY_SITE_MARKER, "utf-8").trim();
    const validDomain = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(domain);
    if (validDomain) {
      const result = tryRun("clpctl", ["site:delete", `--domainName=${domain}`, "--force"]);
      if (result.ok) {
        if (!quiet) log.ok(`removed the legacy manager site ${domain}`);
        rmSync(LEGACY_SITE_MARKER, { force: true });
      } else if (!quiet) {
        log.warn(`could not remove the legacy manager site ${domain}: ${result.out}`);
      }
    } else {
      rmSync(LEGACY_SITE_MARKER, { force: true });
    }
  }

  for (const path of [LEGACY_MANAGER_AUTH, LEGACY_PLATFORM_CONFIG]) rmSync(path, { force: true });
  for (const path of [
    `${LEGACY_LIBRARY_DIR}/releases`,
    `${LEGACY_LIBRARY_DIR}/current`,
    `${LEGACY_LIBRARY_DIR}/gh`,
  ]) rmSync(path, { recursive: true, force: true });
  try {
    for (const entry of readdirSync(LEGACY_LIBRARY_DIR)) {
      if (entry.startsWith("clp-action-")) rmSync(`${LEGACY_LIBRARY_DIR}/${entry}`, { force: true });
    }
  } catch {
    // The legacy directory is optional on a fresh installation.
  }
  tryRun("rmdir", [LEGACY_LIBRARY_DIR]);
}

function removeLegacySudoers(): void {
  for (const name of ADDON_NAMES) rmSync(`/etc/sudoers.d/clp-addon-${name}`, { force: true });
}

export function ensurePanelSessionReadable(
  commands: ProvisionCommandRunner = { run, tryRun },
  sessionDir = SESSION_DIR,
  expectedUid?: number,
  expectedGid?: number,
): void {
  let directory: ReturnType<typeof lstatSync>;
  try {
    directory = lstatSync(sessionDir);
  } catch {
    fatal(`CloudPanel session directory is missing or unreadable: ${sessionDir}`);
  }
  if (directory.isSymbolicLink() || !directory.isDirectory()) {
    fatal(`CloudPanel session path is not a regular directory: ${sessionDir}`);
  }

  const uidResult = expectedUid === undefined
    ? commands.tryRun("getent", ["passwd", PANEL_USER])
    : { ok: true, out: String(expectedUid) };
  const uid = expectedUid ?? Number.parseInt(uidResult.out.split(":")[2] ?? "", 10);
  const gidResult = expectedGid === undefined
    ? commands.tryRun("getent", ["group", PANEL_GROUP])
    : { ok: true, out: String(expectedGid) };
  const gid = expectedGid ?? Number.parseInt(gidResult.out.split(":")[2] ?? "", 10);
  if (!uidResult.ok || !Number.isInteger(uid) || !gidResult.ok || !Number.isInteger(gid)) {
    fatal(`could not resolve the ${PANEL_GROUP} owner required for CloudPanel sessions`);
  }
  const trustedOwner = directory.uid === uid || directory.uid === 0;
  const untrustedGroupWrite = (directory.mode & 0o020) !== 0 && directory.gid !== gid && directory.gid !== 0;
  if (!trustedOwner || untrustedGroupWrite || (directory.mode & 0o002) !== 0) {
    const mode = (directory.mode & 0o7777).toString(8).padStart(4, "0");
    fatal(`CloudPanel session directory must be owned by root or ${PANEL_USER} and writable only by root or ${PANEL_GROUP}: ${sessionDir} (found ${directory.uid}:${directory.gid} mode ${mode})`);
  }

  // A fresh install commonly has no live session file. The root helper checks
  // each request's regular-file, owner, size, and expiry safeguards; this
  // readiness check intentionally does not pretend the daemon can read 0600
  // files directly through its supplementary group. Root can also traverse
  // 0700/0750/0755 directories; requiring exactly clp:clp 0770 broke safe panel
  // layouts. Leave CloudPanel's permissions and live sessions untouched.
}

export function ensureAuthHelperReady(
  commands: ProvisionCommandRunner = { run, tryRun },
  helperPath = CLI_BIN,
): void {
  let helper: ReturnType<typeof lstatSync>;
  try {
    helper = lstatSync(helperPath);
  } catch {
    fatal(`CloudPanel auth helper is missing: ${helperPath}`);
  }
  if (!helper.isFile() || helper.uid !== 0 || (helper.mode & 0o022) !== 0 || (helper.mode & 0o111) === 0) {
    fatal(`CloudPanel auth helper is not a root-owned, non-writable executable: ${helperPath}`);
  }
  const probe = commands.tryRun(helperPath, ["action", "auth"]);
  if (!probe.ok || probe.out.trim() !== '{"valid":false}') {
    fatal(`CloudPanel auth helper failed its invalid-session probe: ${helperPath}`);
  }
}

/**
 * Same check as ensurePanelSessionReadable, but for the unattended repair path: it must
 * never abort the run. Unlike interactive install, nobody is watching the exit code, so a
 * missing session (e.g. no operator currently logged into the panel) can't be fatal -- it
 * can only be logged so the SSO-is-broken signal isn't lost entirely.
 */
export function warnIfPanelSessionUnreadable(
  commands: ProvisionCommandRunner = { run, tryRun },
  sessionDir = SESSION_DIR,
  expectedUid?: number,
  expectedGid?: number,
): void {
  try {
    ensurePanelSessionReadable(commands, sessionDir, expectedUid, expectedGid);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`panel session check failed, continuing without it: ${message}`);
  }
}

/**
 * Creates and permissions shared and addon state directories, removes the
 * obsolete panel snapshot file when present, and optionally verifies access to
 * CloudPanel sessions.
 */
export function ensureDirs(
  specs: AddonSpec[] = [],
  verifySession = false,
  commands: ProvisionCommandRunner = { run, tryRun },
  fs: DirectoryOperations = directoryOperations,
): void {
  for (const path of [LIBEXEC_DIR, CONFIG_DIR, STATE_DIR, LOCK_DIR, SOCKET_DIR, BACKUP_DIR]) {
    fs.mkdir(path, { recursive: true });
  }
  for (const spec of specs) fs.mkdir(spec.stateDir, { recursive: true });

  commands.run("chown", ["root:root", LIBEXEC_DIR]);
  commands.run("chmod", ["755", LIBEXEC_DIR]);
  commands.run("chown", ["root:root", CONFIG_DIR]);
  commands.run("chmod", ["755", CONFIG_DIR]);
  commands.run("chown", [`root:${SHARED_GROUP}`, STATE_DIR]);
  commands.run("chmod", ["750", STATE_DIR]);
  commands.run("chown", [`${SERVICE_USER}:${SERVICE_GROUP}`, SOCKET_DIR]);
  commands.run("chmod", ["755", SOCKET_DIR]);
  commands.run("chown", ["root:root", BACKUP_DIR]);
  commands.run("chmod", ["755", BACKUP_DIR]);
  for (const spec of specs) {
    commands.run("chown", ["root:root", spec.stateDir]);
    commands.run("chmod", ["750", spec.stateDir]);
  }

  const snapshot = `${STATE_DIR}/snapshot.json`;
  if (fs.exists(snapshot)) {
    try {
      rmSync(snapshot, { force: true });
    } catch {}
  }
  if (verifySession) ensurePanelSessionReadable(commands);
}

export function hardenBackups(spec: AddonSpec, quiet = false): void {
  const dir = `/var/backups/clp-addons/${spec.name}`;
  if (!existsSync(dir)) return;

  let changed = 0;
  const fix = (path: string, mode: number) => {
    if ((statSync(path).mode & 0o777) === mode) return;
    chmodSync(path, mode);
    changed++;
  };
  fix(dir, 0o700);
  for (const entry of readdirSync(dir)) {
    const path = `${dir}/${entry}`;
    if (statSync(path).isFile()) fix(path, 0o600);
  }
  if (changed && !quiet) log.ok(`${dir}: tightened ${changed} path(s)`);
}

/**
 * Record who the panel is, and scrub anything an older install left behind.
 *
 * This used to install a sudoers rule, and was called `installSudoers` long
 * after it had stopped doing that: the root gateway daemon replaced sudo
 * entirely, so the manager holds no sudo privileges at all and there is no rule
 * to write. What is left is the panel identity file the root action binary
 * reads to refuse operating on the panel's own hostname, plus the removal of
 * any `/etc/sudoers.d` drop-in a pre-gateway version of this project installed.
 * That removal has to keep happening for as long as an upgrade from one of
 * those versions is possible; the name it was hiding under did not.
 */
export function reconcilePanelIdentity(quiet = false, specs: AddonSpec[] = installedAddonSpecs()): void {
  removeSudoers();
  if (specs.length > 0) {
    ensurePanelIdentity(quiet);
  } else {
    rmSync(PANEL_IDENTITY_PATH, { force: true });
  }
  if (!quiet) log.ok("panel identity reconciled; the manager dispatches via the root gateway and holds no sudo rule");
}

export function removeSudoers(): void {
  rmSync("/etc/sudoers.d/clp-addons", { force: true });
  removeLegacySudoers();
}

function configBody(spec: AddonSpec): string {
  return `# clp-addons: ${spec.name}\nRUN_AS=${SERVICE_USER}\n`;
}

export function writeConfig(spec: AddonSpec, force = false): void {
  const body = configBody(spec);
  if (existsSync(spec.configFile) && !force) {
    if (readFileSync(spec.configFile, "utf-8") === body) return;
    writeAtomic(`${spec.configFile}.new`, body, 0o640);
    log.warn(`${spec.configFile} differs; wrote the managed defaults to .new`);
    return;
  }
  writeAtomic(spec.configFile, body, 0o640);
  run("chown", [`root:${SERVICE_GROUP}`, spec.configFile]);
  rmSync(`${spec.configFile}.new`, { force: true });
}

export function installedConfig(spec: AddonSpec): boolean {
  return existsSync(spec.configFile);
}

export function serviceUnit(specs: AddonSpec[]): string {
  const dependencies = [...new Set(specs.flatMap((spec) => spec.requiresUnits ?? []))];
  const after = ["network-online.target", AUTH_SOCKET_UNIT, ...dependencies.map((unit) => `${unit}.service`)];
  const env = specs.flatMap((spec) => [
    `Environment=${spec.name.toUpperCase()}_APP_DATA=${spec.stateDir}`,
  ]);
  // Only the root actions use /run/lock/clp-addons, creating it on demand.
  // Binding it into this service's namespace prevented startup after /run was
  // cleared by a reboot, before serve could create the manager socket.
  return `[Unit]
Description=CloudPanel Addons manager
After=${after.join(" ")}
Wants=${after.join(" ")}

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_GROUP}
SupplementaryGroups=${PANEL_GROUP}
RuntimeDirectory=clp-addons
RuntimeDirectoryMode=0755
RuntimeDirectoryPreserve=yes
${env.join("\n")}
ProtectSystem=full
ProtectHome=read-only
PrivateTmp=yes
ProtectKernelTunables=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
NoNewPrivileges=yes
ReadWritePaths=/etc/nginx -/etc/letsencrypt /etc/php /home /run/clp-addons /var/backups/clp-addons /var/lib/clp-addons
ExecStart=/usr/local/bin/clp-addons serve
Restart=always
RestartSec=5
UMask=0007

[Install]
WantedBy=multi-user.target
`;
}

/**
 * The root side of session authentication, as systemd units rather than sudo.
 *
 * The manager is sandboxed with RestrictAddressFamilies= and
 * ProtectKernelTunables=, each of which implies NoNewPrivileges=yes, and
 * systemd does not let a unit turn that back off. Under NoNewPrivileges sudo
 * cannot escalate at all, so the daemon could never call the helper that way
 * without giving up its own sandbox.
 *
 * Socket activation inverts it: the manager connects as itself, and systemd
 * passes the listening socket to the resident root gateway with Accept=no.
 * The socket creates its parent directory before the manager takes ownership
 * through RuntimeDirectory; it must not independently manage that directory's
 * ownership or lifetime.
 */
export function authUnits(): { socket: string; service: string } {
  return {
    socket: `[Unit]
Description=CloudPanel Addons session authentication socket

[Socket]
ListenStream=${AUTH_SOCKET_PATH}
SocketUser=root
SocketGroup=${SERVICE_GROUP}
SocketMode=0660
Accept=no
DirectoryMode=0755

[Install]
WantedBy=sockets.target
`,
    service: `[Unit]
Description=CloudPanel Addons root gateway daemon
Requires=${AUTH_SOCKET_UNIT}
After=${AUTH_SOCKET_UNIT}

[Service]
Type=simple
ExecStart=${CLI_BIN} action auth
StandardError=journal
TimeoutStartSec=10
Restart=always
RestartSec=1

[Install]
WantedBy=multi-user.target
`,
  };
}

export function reconcileUnits(): { service: string; timer: string; path: string; anchor: string } {
  return {
    service: `[Unit]
Description=CloudPanel Addons reconciliation
After=network.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/clp-addons repair --quiet
`,
    timer: `[Unit]
Description=CloudPanel Addons periodic reconciliation

[Timer]
OnCalendar=*:0/15
Persistent=true
RandomizedDelaySec=30

[Install]
WantedBy=timers.target
`,
    path: `[Unit]
Description=CloudPanel Addons template watcher

[Path]
${reconcileWatchPaths().map((path) => `PathChanged=${path}`).join("\n")}
Unit=${ANCHOR_SERVICE}

[Install]
WantedBy=paths.target
`,
    anchor: `[Unit]
Description=CloudPanel Addons template reconciliation

[Service]
Type=oneshot
ExecStartPre=/bin/sleep 2
ExecStart=/usr/local/bin/clp-addons repair --anchors-only --quiet
`,
  };
}

/**
 * Everything the watcher reconciles: the addons' Twig anchors and the panel
 * vhost carrying the /addons/ proxy. The vhost belongs here because on the
 * CloudPanel layout it is owned by the panel user, so a panel action can
 * rewrite it at any time; the reconciler puts the block back, but only once
 * something tells it to look.
 */
function reconcileWatchPaths(): string[] {
  const vhost = panelVhostWatchPath();
  return [...templateWatchPaths(), ...(vhost ? [vhost] : [])];
}

export function installUnits(specs: AddonSpec[]): boolean {
  reconcileInstaticBackupCron(specs.some((spec) => spec.name === "instatic"));
  const units = reconcileUnits();
  const servicePath = `${SYSTEMD_DIR}/${MANAGER_UNIT}`;
  const desired = serviceUnit(specs);
  const changed = !existsSync(servicePath) || readFileSync(servicePath, "utf-8") !== desired;
  writeAtomic(servicePath, desired, 0o644);
  writeAtomic(`${SYSTEMD_DIR}/${RECONCILE_SERVICE}`, units.service, 0o644);
  writeAtomic(`${SYSTEMD_DIR}/${RECONCILE_TIMER}`, units.timer, 0o644);
  writeAtomic(`${SYSTEMD_DIR}/${RECONCILE_PATH}`, units.path, 0o644);
  writeAtomic(`${SYSTEMD_DIR}/${ANCHOR_SERVICE}`, units.anchor, 0o644);
  const auth = authUnits();
  writeAtomic(`${SYSTEMD_DIR}/${AUTH_SOCKET_UNIT}`, auth.socket, 0o644);
  writeAtomic(`${SYSTEMD_DIR}/${AUTH_SERVICE_UNIT}`, auth.service, 0o644);
  rmSync(`${SYSTEMD_DIR}/clp-addons-auth@.service`, { force: true });
  run("systemctl", ["daemon-reload"]);
  return changed;
}

export function startUnits(): void {
  // Before the manager: without it every authenticated request fails closed.
  run("systemctl", ["enable", AUTH_SOCKET_UNIT]);
  run("systemctl", ["restart", AUTH_SOCKET_UNIT]);
  run("systemctl", ["enable", AUTH_SERVICE_UNIT]);
  run("systemctl", ["restart", AUTH_SERVICE_UNIT]);
  run("systemctl", ["enable", MANAGER_UNIT]);
  run("systemctl", ["restart", MANAGER_UNIT]);
  run("systemctl", ["enable", RECONCILE_TIMER]);
  run("systemctl", ["restart", RECONCILE_TIMER]);
  run("systemctl", ["enable", RECONCILE_PATH]);
  run("systemctl", ["restart", RECONCILE_PATH]);
  ensureTimerArmed(RECONCILE_TIMER);
}

export function stopUnits(keepShared = false): void {
  if (keepShared) return;
  reconcileInstaticBackupCron(false);
  for (const unit of [MANAGER_UNIT, RECONCILE_TIMER, RECONCILE_PATH, AUTH_SOCKET_UNIT, AUTH_SERVICE_UNIT]) {
    tryRun("systemctl", ["disable", "--now", unit]);
  }
  for (const unit of [MANAGER_UNIT, RECONCILE_SERVICE, RECONCILE_TIMER, RECONCILE_PATH, ANCHOR_SERVICE,
    AUTH_SOCKET_UNIT, AUTH_SERVICE_UNIT, "clp-addons-auth@.service"]) {
    rmSync(`${SYSTEMD_DIR}/${unit}`, { force: true });
  }
  tryRun("systemctl", ["daemon-reload"]);
}

export function unitActive(unit: string): string {
  return tryRun("systemctl", ["is-active", unit]).out || "unknown";
}

export function unitPid(unit: string): string | null {
  const pid = tryRun("systemctl", ["show", "-p", "MainPID", "--value", unit]).out.trim();
  return pid && pid !== "0" ? pid : null;
}

export function timerNextElapse(unit: string): string | null {
  const value = tryRun("systemctl", ["show", "-p", "NextElapseUSecRealtime", "--value", unit]).out.trim();
  return value && value !== "0" && value !== "infinity" && value !== "n/a" ? value : null;
}

export function ensureTimerArmed(unit: string, quiet = false): void {
  if (timerNextElapse(unit)) return;
  if (!quiet) log.warn(`${unit} has no scheduled run; restarting it`);
  tryRun("systemctl", ["restart", unit]);
  if (!timerNextElapse(unit) && !quiet) log.err(`${unit} still has no scheduled run`);
}

export function purgeTwigCache(): void {
  if (!existsSync(TWIG_CACHE_DIR)) return;
  for (const entry of readdirSync(TWIG_CACHE_DIR)) {
    rmSync(`${TWIG_CACHE_DIR}/${entry}`, { recursive: true, force: true });
  }
}

export function removeLegacyUnits(quiet = false): void {
  for (const unit of LEGACY_UNITS) {
    const path = `${SYSTEMD_DIR}/${unit}`;
    if (!existsSync(path)) continue;
    if (!quiet) log.warn(`removing legacy unit ${unit}`);
    tryRun("systemctl", ["disable", "--now", unit]);
    rmSync(path, { force: true });
  }
  removeLegacySudoers();
}

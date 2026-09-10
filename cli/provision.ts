import { randomBytes } from "node:crypto";
import {
  chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync,
} from "node:fs";
import {
  ADDON_NAMES, ANCHOR_SERVICE, CONFIG_DIR, HMAC_KEY_PATH, LIBEXEC_DIR, LEGACY_UNITS,
  ADDONS, GH_PRIVATE, LEGACY_USERS, LOCK_DIR, MANAGER_UNIT, PANEL_GROUP, RECONCILE_PATH, RECONCILE_SERVICE,
  RECONCILE_TIMER, SERVICE_GROUP, SERVICE_USER, SHARED_GROUP, SOCKET_DIR, STATE_DIR,
  SYSTEMD_DIR, TWIG_CACHE_DIR, type AddonSpec, templateWatchPaths,
} from "./paths";
import { findMasterVhost } from "./inject";
import { fatal, log, run, tryRun, writeAtomic } from "./util";

const LEGACY_MANAGER_AUTH = `${CONFIG_DIR}/manager-auth`;
const LEGACY_PLATFORM_CONFIG = `${CONFIG_DIR}/platform.conf`;
const LEGACY_SITE_MARKER = `${STATE_DIR}/.site-created-by-addons`;
const LEGACY_LIBRARY_DIR = "/usr/local/lib/clp-addons";
export const PANEL_IDENTITY_PATH = `${CONFIG_DIR}/panel-identity.conf`;
export const SESSION_VALIDATOR_PATH = `${LIBEXEC_DIR}/clp-verify-session`;

export interface ProvisionCommandRunner {
  run(command: string, args: string[]): string;
  tryRun(command: string, args: string[]): { ok: boolean; out: string };
}

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
  while ((match = directive.exec(uncommented))) {
    for (const raw of match[1]!.trim().split(/\s+/)) {
      if (raw === "_" || raw.toLowerCase() === "localhost") continue;
      const name = normalizePanelHostname(raw);
      if (!name) return null;
      names.add(name);
    }
  }

  const exact = [...names].find((name) => HOSTNAME_RE.test(name));
  if (!exact) return null;
  return { primary: exact, aliases: [...names].filter((name) => name !== exact).sort() };
}

function installedAddonSpecs(): AddonSpec[] {
  return ADDON_NAMES.map((name) => ADDONS[name]!).filter((spec) => existsSync(spec.configFile));
}

export function sudoersCommandPaths(specs: AddonSpec[] = installedAddonSpecs()): string[] {
  const wrappers = specs.map((spec) => spec.wrapperPath).filter((path) => path !== GH_PRIVATE);
  return [...new Set([SESSION_VALIDATOR_PATH, ...wrappers])].sort();
}

export function sudoersRule(specs: AddonSpec[] = installedAddonSpecs()): string {
  const commands = sudoersCommandPaths(specs);
  if (commands.some((path) => !path.startsWith("/") || /[*?[\]]/.test(path))) {
    fatal("refusing to install sudoers configuration with a non-absolute or wildcard command path");
  }
  return `${SERVICE_USER} ALL=(root) NOPASSWD: ${commands.join(", ")}`;
}

function ensurePanelIdentity(quiet = false): void {
  const vhostPath = findMasterVhost();
  if (!vhostPath) fatal("CloudPanel master vhost was not found; refusing to install root wrappers");

  let content: string;
  let rootOwned = false;
  try {
    const stat = statSync(vhostPath);
    rootOwned = stat.isFile() && stat.uid === 0 && (stat.mode & 0o022) === 0;
    content = readFileSync(vhostPath, "utf-8");
  } catch {
    fatal(`CloudPanel master vhost could not be read: ${vhostPath}`);
  }
  if (!rootOwned) fatal(`CloudPanel master vhost is not a root-owned, non-writable file: ${vhostPath}`);

  const identity = panelIdentityFromVhost(content);
  if (!identity) {
    fatal(`CloudPanel master vhost has no valid panel identity: ${vhostPath}`);
  }

  const aliases = identity.aliases.length ? identity.aliases.join(" ") : "";
  const body =
    "# Managed by clp-addons; read by root action wrappers.\n" +
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
    `${LEGACY_LIBRARY_DIR}/clp-action-instatic`,
    `${LEGACY_LIBRARY_DIR}/clp-action-stager`,
  ]) rmSync(path, { recursive: true, force: true });
  tryRun("rmdir", [LEGACY_LIBRARY_DIR]);
}

function removeLegacySudoers(): void {
  for (const name of ADDON_NAMES) rmSync(`/etc/sudoers.d/clp-addon-${name}`, { force: true });
}

export function ensureDirs(specs: AddonSpec[] = []): void {
  for (const path of [LIBEXEC_DIR, CONFIG_DIR, STATE_DIR, LOCK_DIR, SOCKET_DIR]) {
    mkdirSync(path, { recursive: true });
  }
  for (const spec of specs) mkdirSync(spec.stateDir, { recursive: true });

  run("chown", ["root:root", LIBEXEC_DIR]);
  run("chmod", ["755", LIBEXEC_DIR]);
  run("chown", ["root:root", CONFIG_DIR]);
  run("chmod", ["755", CONFIG_DIR]);
  run("chown", [`root:${SHARED_GROUP}`, STATE_DIR]);
  run("chmod", ["750", STATE_DIR]);
  run("chown", [`${SERVICE_USER}:${SERVICE_GROUP}`, SOCKET_DIR]);
  run("chmod", ["755", SOCKET_DIR]);
  for (const spec of specs) {
    run("chown", ["root:root", spec.stateDir]);
    run("chmod", ["750", spec.stateDir]);
  }

  const snapshot = `${STATE_DIR}/snapshot.json`;
  if (existsSync(snapshot)) {
    run("chown", [`root:${SHARED_GROUP}`, snapshot]);
    run("chmod", ["640", snapshot]);
  }
}

export function ensureHmacKey(): void {
  mkdirSync(SOCKET_DIR, { recursive: true });
  let valid = false;
  try {
    valid = readFileSync(HMAC_KEY_PATH).length >= 32;
  } catch {
    valid = false;
  }
  if (!valid) writeAtomic(HMAC_KEY_PATH, randomBytes(32), 0o640);
  run("chown", [`root:${SERVICE_GROUP}`, HMAC_KEY_PATH]);
  run("chmod", ["640", HMAC_KEY_PATH]);
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

export function installWrapper(spec: AddonSpec, bytes: Buffer, quiet = false): void {
  writeAtomic(spec.wrapperPath, bytes, 0o755);
  run("chown", ["root:root", spec.wrapperPath]);
  if (!quiet) log.ok(`installed ${spec.wrapperArtifact}`);
}

export function installSessionValidator(bytes: Buffer, quiet = false): void {
  writeAtomic(SESSION_VALIDATOR_PATH, bytes, 0o755);
  run("chown", ["root:root", SESSION_VALIDATOR_PATH]);
  if (!quiet) log.ok("installed CloudPanel session validator");
}

export function installSudoers(quiet = false, specs: AddonSpec[] = installedAddonSpecs()): void {
  const file = "/etc/sudoers.d/clp-addons";
  const candidate = "/etc/sudoers.d/.clp-addons.candidate";
  ensurePanelIdentity(quiet);
  const body =
    "# Managed by clp-addons.\n" +
    `${sudoersRule(specs)}\n`;

  writeAtomic(candidate, body, 0o440);
  const check = tryRun("visudo", ["-c", "-f", candidate]);
  if (!check.ok) {
    rmSync(candidate, { force: true });
    fatal(`refusing to install invalid sudoers configuration:\n${check.out}`);
  }
  run("chown", ["root:root", candidate]);
  run("chmod", ["440", candidate]);
  run("mv", [candidate, file]);
  const full = tryRun("visudo", ["-c"]);
  if (!full.ok) {
    rmSync(file, { force: true });
    fatal(`sudoers validation failed after installation:\n${full.out}`);
  }
  if (!quiet) log.ok(`sudoers allows ${SERVICE_USER} to run the managed helpers`);
}

export function removeSudoers(): void {
  rmSync("/etc/sudoers.d/clp-addons", { force: true });
  rmSync(PANEL_IDENTITY_PATH, { force: true });
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

function serviceUnit(specs: AddonSpec[]): string {
  const dependencies = [...new Set(specs.flatMap((spec) => spec.requiresUnits ?? []))];
  const after = ["network-online.target", ...dependencies.map((unit) => `${unit}.service`)];
  const env = specs.flatMap((spec) => [
    `Environment=${spec.name.toUpperCase()}_APP_DATA=${spec.stateDir}`,
    `Environment=${spec.name.toUpperCase()}_WRAPPER=${spec.wrapperPath}`,
  ]);
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
ExecStartPre=+/usr/local/bin/clp-addons ensure-key
ExecStart=/usr/local/bin/clp-addons serve
Restart=always
RestartSec=5
UMask=0007

[Install]
WantedBy=multi-user.target
`;
}

function reconcileUnits(): { service: string; timer: string; path: string; anchor: string } {
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
${templateWatchPaths().map((path) => `PathChanged=${path}`).join("\n")}
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

export function installUnits(specs: AddonSpec[]): boolean {
  const units = reconcileUnits();
  const servicePath = `${SYSTEMD_DIR}/${MANAGER_UNIT}`;
  const desired = serviceUnit(specs);
  const changed = !existsSync(servicePath) || readFileSync(servicePath, "utf-8") !== desired;
  writeAtomic(servicePath, desired, 0o644);
  writeAtomic(`${SYSTEMD_DIR}/${RECONCILE_SERVICE}`, units.service, 0o644);
  writeAtomic(`${SYSTEMD_DIR}/${RECONCILE_TIMER}`, units.timer, 0o644);
  writeAtomic(`${SYSTEMD_DIR}/${RECONCILE_PATH}`, units.path, 0o644);
  writeAtomic(`${SYSTEMD_DIR}/${ANCHOR_SERVICE}`, units.anchor, 0o644);
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
  ensureTimerArmed(RECONCILE_TIMER);
}

export function stopUnits(keepShared = false): void {
  if (keepShared) return;
  for (const unit of [MANAGER_UNIT, RECONCILE_TIMER, RECONCILE_PATH]) {
    tryRun("systemctl", ["disable", "--now", unit]);
  }
  for (const unit of [MANAGER_UNIT, RECONCILE_SERVICE, RECONCILE_TIMER, RECONCILE_PATH, ANCHOR_SERVICE]) {
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

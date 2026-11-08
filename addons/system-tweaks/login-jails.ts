/**
 * fail2ban jails for the panel login and for SSH. CloudPanel records only
 * successful logins, so the panel's own nginx sends each failed one to the
 * journal. fail2ban bans in its own nftables table, which `ufw reset` does not
 * touch. See "Login jails" in docs/decisions/system-tweaks.md.
 */
import { errorMessage } from "../../lib/errors";
import { existsSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { failAction } from "../../lib/action";
import { commandOutput, type CommandResult } from "../../lib/command";
import { cloudflareRanges, nginxFileChange, trustedVhost, withNginxTransaction } from "../../lib/nginx-transaction";
import { CLOUDFLARE_IPS_PATH, ROOT_UID, nginxLayout } from "../../lib/paths";
import { writeOrRemove } from "../../lib/atomic-write";
import { panelUserGid, panelUserUid } from "../../lib/sso-auth";
import { aptInstall, installedVersion, systemRun, type Run } from "./packages";

export const PANEL_JAIL = "clp-addons-panel";
/** The panel through CloudPanel's custom domain, which the sites' nginx serves on 443. */
export const DOMAIN_JAIL = "clp-addons-domain";
export const SSH_JAIL = "sshd";
export const LOGIN_JAILS = [PANEL_JAIL, DOMAIN_JAIL, SSH_JAIL] as const;
const PANEL_PORT = "8443";
const DOMAIN_PORT = "443";
const LOG_TAG = "clp_addons_panel";
const DOMAIN_TAG = "clp_addons_domain";
/** fail2ban, its journal reader, and nft for the bans. */
export const LOGIN_JAIL_PACKAGES = ["fail2ban", "python3-systemd", "nftables"];
/** Proxies the panel trusts besides Cloudflare: a ban on one would shut out everyone behind it. */
const PRIVATE_PROXIES = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"];
export const JAIL_LIMITS = { maxretry: 5, findtime: "1h", bantime: "1h" };
const HEADER = "# Written by clp-addons System Tweaks, which replaces it. Change the jails on its page.";

export interface LoginJailSettings {
  panel: boolean;
  ssh: boolean;
}

/** fail2ban.service as it was before System Tweaks first started it. */
export interface Fail2banBefore {
  enabled: boolean;
  active: boolean;
}

export const DEFAULT_LOGIN_JAIL_PATHS = {
  fail2banDir: "/etc/fail2ban",
  /** The panel's own nginx.conf; null on a CloudPanel whose panel shares the sites' nginx. */
  panelConf: nginxLayout().configFile as string | null,
  panelUid: null as number | null,
  panelGid: null as number | null,
  cloudflareIps: CLOUDFLARE_IPS_PATH,
  /** CloudPanel's custom-domain vhost, which proxies the panel from the sites' nginx. */
  domainVhost: "/etc/nginx/sites-enabled/custom-domain.conf",
  /** The sites' nginx.conf, whose `user` writes the custom domain's lines. */
  sitesConf: "/etc/nginx/nginx.conf",
  passwd: "/etc/passwd",
  /** The sites' nginx worker account; null reads it from `sitesConf`. */
  domainUid: null as number | null,
  /** Who must own the custom domain's vhost. */
  rootUid: ROOT_UID,
  rootGid: 0,
};

export interface LoginJailOptions {
  paths?: Partial<typeof DEFAULT_LOGIN_JAIL_PATHS>;
  run?: Run;
}

export interface Ban {
  jail: string;
  ip: string;
  /** When fail2ban lifts it, as fail2ban prints it. */
  until: string;
}

export interface SshLogin {
  password: boolean;
  /** sshd's PermitRootLogin. */
  rootLogin: string;
}

export interface LoginJailsStatus {
  /** Packages the jails need that are missing. */
  missing: string[];
  service: "active" | "inactive" | "masked";
  /** The jails of these two that fail2ban runs now. */
  running: string[];
  /** Whether the panel's nginx sends failed logins to the journal; null without a panel nginx. */
  panelLog: boolean | null;
  /** CloudPanel's custom domain, and whether its vhost sends failed logins to the journal; null without one. */
  customDomain: { name: string; logged: boolean; supported: boolean } | null;
  bans: Ban[];
  sshd: SshLogin | null;
  problem: string;
}

interface Context {
  paths: typeof DEFAULT_LOGIN_JAIL_PATHS;
  run: Run;
}

function contextOf(options: LoginJailOptions): Context {
  return { paths: { ...DEFAULT_LOGIN_JAIL_PATHS, ...options.paths }, run: options.run ?? systemRun };
}

function files(paths: Context["paths"]) {
  return {
    defaults: `${paths.fail2banDir}/jail.d/00-clp-addons.conf`,
    jails: `${paths.fail2banDir}/jail.d/clp-addons.local`,
    filter: `${paths.fail2banDir}/filter.d/${PANEL_JAIL}.conf`,
  };
}

function output(result: CommandResult): string {
  return commandOutput(result, 3);
}

// --- The panel's nginx -----------------------------------------------------

const OFF_RE = /^([ \t]*)access_log[ \t]+off[ \t]*;[ \t]*$/gm;
const MARK = "#clp-addons:login-log ";
const MARKED_RE = /^([ \t]*)#clp-addons:login-log (access_log[ \t]+off[ \t]*;)[ \t]*$/gm;
const BLOCK_RE = /^[ \t]*# clp-addons:login-log:start\n(?:.*\n)*?[ \t]*# clp-addons:login-log:end\n/gm;

/**
 * A regex for every spelling of `path` that PHP's rawurldecode turns back into
 * it, which is what Symfony's router matches. nginx's `~*` makes it ignore case.
 */
export function anySpelling(path: string): string {
  return [...path].map((char) => {
    const literal = /[A-Za-z0-9/]/.test(char) ? char : `\\${char}`;
    return `(?:${literal}|%${char.charCodeAt(0).toString(16).padStart(2, "0")})`;
  }).join("");
}

/** Symfony takes `/index.php` off the front as the base URL, so `/index.php/login/mfa` reaches the same route. */
function routeRe(path: string): string {
  return `(?:${anySpelling("/index.php")})?${anySpelling(path)}(?:\\?.*)?$`;
}

/**
 * The maps that name a failed login, and its log format. A failed login is a
 * POST to /login sent back to /login, a POST to /login/mfa answered with the
 * form again, or a 401 to a request that named a basic-auth user. The line
 * names the address that opened the connection, which is what nftables sees.
 */
function loginMaps(): string[] {
  return [
    `map "$request_method $status $request_uri" $clp_addons_login_form {`,
    `    default "";`,
    `    "~*^POST 302 ${routeRe("/login")}" password;`,
    `    "~*^POST 200 ${routeRe("/login/mfa")}" mfa;`,
    "}",
    "map $sent_http_location $clp_addons_login_back {",
    `    default "";`,
    `    "~*^(?:https?://[^/]+)?${routeRe("/login")}" 1;`,
    "}",
    `map "$clp_addons_login_form $clp_addons_login_back $status $remote_user" $clp_addons_login_failed {`,
    `    default "";`,
    `    "~^password 1 " password;`,
    `    "~^mfa " mfa;`,
    `    "~^\\S* \\S* 401 \\S" basic-auth;`,
    "}",
    "log_format clp_addons_login escape=none '$clp_addons_login_failed login failed from $realip_remote_addr';",
  ];
}

function syslogLog(tag: string): string {
  return `access_log syslog:server=unix:/dev/log,facility=authpriv,severity=notice,tag=${tag},nohostname clp_addons_login if=$clp_addons_login_failed;`;
}

/** What takes the place of the panel's http-level `access_log off;`. */
export function loginLogBlock(indent: string): string {
  const lines = [`${MARK}access_log off;`, "# clp-addons:login-log:start", ...loginMaps(), syslogLog(LOG_TAG), "# clp-addons:login-log:end"];
  return lines.map((line) => `${indent}${line}\n`).join("");
}

export function withoutLoginLog(content: string): string {
  return content.replace(BLOCK_RE, "").replace(MARKED_RE, (_line, indent: string, directive: string) => `${indent}${directive}`);
}

/** The file with the block in place of its one `access_log off;`; null when it has none or several. */
export function withLoginLog(content: string): string | null {
  const upstream = withoutLoginLog(content);
  const found = [...upstream.matchAll(OFF_RE)];
  if (found.length !== 1) return null;
  const match = found[0]!;
  const end = match.index! + match[0].length + (upstream[match.index! + match[0].length] === "\n" ? 1 : 0);
  return `${upstream.slice(0, match.index)}${loginLogBlock(match[1]!)}${upstream.slice(end)}`;
}

const NO_ANCHOR = "the panel's nginx.conf has no single access_log off; line to log failed logins in place of";

function panelTarget(ctx: Context) {
  const conf = ctx.paths.panelConf;
  if (!conf || !existsSync(conf)) return null;
  const gid = ctx.paths.panelGid ?? panelUserGid();
  return {
    conf, uid: [ctx.paths.panelUid ?? panelUserUid() ?? ctx.paths.rootUid, ctx.paths.rootUid] as const,
    groups: [ctx.paths.rootGid, ...(gid === null ? [] : [gid])],
  };
}

function panelLogActive(ctx: Context): boolean | null {
  const target = panelTarget(ctx);
  if (!target) return null;
  const { content } = trustedVhost(target.conf, target.uid, target.groups);
  return withLoginLog(content) === content;
}

/** Adds or removes the block, testing and reloading the panel's nginx and restoring the file on failure. */
export function applyLoginLog(enabled: boolean, options: LoginJailOptions = {}): boolean {
  const ctx = contextOf(options);
  const target = panelTarget(ctx);
  if (!target) return false;
  const wanted = (content: string) => enabled ? withLoginLog(content) ?? failAction(NO_ANCHOR) : withoutLoginLog(content);
  const current = readFileSync(target.conf, "utf8");
  if (wanted(current) === current) return false;
  const nginx = { nginx: "nginx", systemctl: "systemctl", config: target.conf, service: "clp-nginx" };
  return withNginxTransaction(null, nginx, (command, args) => ctx.run(command, args), (changes) => {
    const change = nginxFileChange(target.conf, null, target.uid, target.groups);
    if (change.backup.content === null) return;
    change.content = wanted(change.backup.content);
    changes.push(change);
  }).changed;
}

// --- The custom domain's vhost --------------------------------------------

const DOMAIN_LINE = "# clp-addons:login-log";
const DOMAIN_LINE_RE = /^[ \t]*access_log [^\n]*# clp-addons:login-log\n/gm;
const SERVER_NAME_RE = /^([ \t]*)server_name[ \t]+([^;\s]+)[^;]*;[ \t]*$/gm;

export function withoutDomainLog(content: string): string {
  return content.replace(BLOCK_RE, "").replace(DOMAIN_LINE_RE, "");
}

/**
 * CloudPanel's custom-domain vhost with the maps before its server block and
 * the log after its `server_name`; null when it has no single server block.
 * The sites' nginx sees the client's own connection, where the panel sees only
 * this proxy's loopback one.
 */
export function withDomainLog(content: string): string | null {
  const upstream = withoutDomainLog(content);
  const names = [...upstream.matchAll(SERVER_NAME_RE)];
  if (names.length !== 1 || (upstream.match(/^[ \t]*server[ \t]*\{/gm) ?? []).length !== 1) return null;
  const at = names[0]!.index! + names[0]![0].length + 1;
  const block = ["# clp-addons:login-log:start", ...loginMaps(), "# clp-addons:login-log:end", ""].join("\n");
  return `${block}${upstream.slice(0, at)}${names[0]![1]}${syslogLog(DOMAIN_TAG)} ${DOMAIN_LINE}\n${upstream.slice(at)}`;
}

export function customDomainName(content: string): string | null {
  const names = [...withoutDomainLog(content).matchAll(SERVER_NAME_RE)];
  return names.length === 1 ? names[0]![2]! : null;
}

function readDomainVhost(ctx: Context): string | null {
  if (!existsSync(ctx.paths.domainVhost)) return null;
  return trustedVhost(ctx.paths.domainVhost, ctx.paths.rootUid).content;
}

/** The uid the sites' nginx workers run as, from its `user` line; nginx runs them as root on CloudPanel. */
function domainUid(ctx: Context): number | null {
  if (ctx.paths.domainUid !== null) return ctx.paths.domainUid;
  let user = "nobody";
  try {
    const match = /^[ \t]*user[ \t]+([^\s;]+)/m.exec(readFileSync(ctx.paths.sitesConf, "utf8"));
    if (match) user = match[1]!;
  } catch { return null; }
  if (user === "root") return 0;
  try {
    const line = readFileSync(ctx.paths.passwd, "utf8").split("\n").find((entry) => entry.startsWith(`${user}:`));
    const uid = Number.parseInt(line?.split(":")[2] ?? "", 10);
    return Number.isInteger(uid) ? uid : null;
  } catch { return null; }
}

/** Adds or removes the custom domain's log, testing and reloading the sites' nginx and restoring the file on failure. */
export function applyDomainLog(enabled: boolean, options: LoginJailOptions = {}): boolean {
  const ctx = contextOf(options);
  const current = readDomainVhost(ctx);
  if (current === null) return false;
  // A vhost this cannot place the log in is left as CloudPanel wrote it; the page says so.
  const wanted = (content: string) => enabled ? withDomainLog(content) ?? withoutDomainLog(content) : withoutDomainLog(content);
  if (wanted(current) === current) return false;
  const nginx = { nginx: "nginx", systemctl: "systemctl" };
  return withNginxTransaction(null, nginx, (command, args) => ctx.run(command, args), (changes) => {
    const change = nginxFileChange(ctx.paths.domainVhost, null, ctx.paths.rootUid);
    if (change.backup.content === null) return;
    change.content = wanted(change.backup.content);
    changes.push(change);
  }).changed;
}

// --- fail2ban's files ------------------------------------------------------

function sshPorts(ctx: Context): string[] {
  const ports = [...sshdConfig(ctx).entries()].filter(([key]) => key === "port" || key.startsWith("port#")).map(([, value]) => value);
  return ports.length ? ports : ["ssh"];
}

/** `sshd -T`, by lowercase key; ports repeat, so each `port` line is its own entry. */
function sshdConfig(ctx: Context): Map<string, string> {
  const result = ctx.run("sshd", ["-T"]);
  const config = new Map<string, string>();
  if (!result.ok) return config;
  let ports = 0;
  for (const line of result.stdout.split("\n")) {
    const [key = "", ...rest] = line.trim().split(/\s+/);
    if (!key) continue;
    config.set(key === "port" && ports++ ? `port#${ports}` : key, rest.join(" "));
  }
  return config;
}

function panelProxies(ctx: Context): string[] {
  const cloudflare = cloudflareRanges(ctx.paths.cloudflareIps).filter((range) => {
    const [address = "", prefix] = range.split("/");
    const family = isIP(address);
    return family !== 0 && (prefix === undefined || (/^\d+$/.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128)));
  });
  return [...PRIVATE_PROXIES, ...cloudflare];
}

function limits(): string[] {
  return [`maxretry = ${JAIL_LIMITS.maxretry}`, `findtime = ${JAIL_LIMITS.findtime}`, `bantime = ${JAIL_LIMITS.bantime}`];
}

/**
 * The three files, or null for one to remove. The `.local` sorts after the
 * operator's jail.local, so its `[sshd]` decides; the `[DEFAULT]` sorts before
 * it, so an operator's own ignoreip replaces the loopback default there.
 */
export function jailFiles(settings: LoginJailSettings, input: {
  panelUid: number | null; domainUid: number | null; proxies: string[]; sshPorts: string[];
}): {
  defaults: string | null; jails: string | null; filter: string | null;
} {
  if (!settings.panel && !settings.ssh) return { defaults: null, jails: null, filter: null };
  const sections: string[] = [];
  if (settings.panel && input.panelUid !== null) {
    sections.push([
      `[${PANEL_JAIL}]`,
      "enabled = true",
      `filter = ${PANEL_JAIL}`,
      // The panel's nginx runs as an ordinary account, and journald files that account's lines apart from the system's.
      "backend = systemd[journalflags=1]",
      `journalmatch = SYSLOG_IDENTIFIER=${LOG_TAG} _UID=${input.panelUid}`,
      `port = ${PANEL_PORT}`,
      "banaction = nftables-multiport",
      ...limits(),
      `ignoreip = %(known/ignoreip)s ${input.proxies.join(" ")}`,
    ].join("\n"));
  }
  if (settings.panel && input.domainUid !== null) {
    // A block here covers HTTPS for every site: nftables cannot tell which host a client asked for.
    sections.push([
      `[${DOMAIN_JAIL}]`,
      "enabled = true",
      `filter = ${PANEL_JAIL}`,
      "backend = systemd[journalflags=1]",
      `journalmatch = SYSLOG_IDENTIFIER=${DOMAIN_TAG} _UID=${input.domainUid}`,
      `port = ${DOMAIN_PORT}`,
      "banaction = nftables-multiport",
      ...limits(),
      `ignoreip = %(known/ignoreip)s ${input.proxies.join(" ")}`,
    ].join("\n"));
  }
  sections.push(settings.ssh
    ? ["[sshd]", "enabled = true", "backend = systemd", "banaction = nftables-multiport", `port = ${input.sshPorts.join(",")}`, ...limits()].join("\n")
    : "[sshd]\nenabled = false");
  return {
    defaults: `${HEADER}\n[DEFAULT]\nignoreip = 127.0.0.1/8 ::1\n`,
    jails: `${HEADER}\n${sections.join("\n\n")}\n`,
    filter: [
      HEADER,
      "[INCLUDES]",
      "before = common.conf",
      "[Definition]",
      "_daemon = clp_addons_(?:panel|domain)",
      "failregex = ^%(__prefix_line)s(?:password|mfa|basic-auth) login failed from <ADDR>$",
      "ignoreregex =",
      "",
    ].join("\n"),
  };
}

/** Writes the files and has fail2ban test them; on a refusal they go back as they were. Whether any changed. */
function writeJailFiles(ctx: Context, settings: LoginJailSettings): boolean {
  const wanted = jailFiles(settings, {
    panelUid: ctx.paths.panelUid ?? panelUserUid(),
    domainUid: domainUid(ctx),
    proxies: panelProxies(ctx),
    sshPorts: settings.ssh ? sshPorts(ctx) : [],
  });
  const paths = files(ctx.paths);
  const previous = new Map<string, string | null>();
  const put = (path: string, content: string | null) => writeOrRemove(path, content, { mode: 0o644 });
  for (const key of ["defaults", "jails", "filter"] as const) {
    const path = paths[key];
    const current = existsSync(path) ? readFileSync(path, "utf8") : null;
    if (current === wanted[key]) continue;
    previous.set(path, current);
    put(path, wanted[key]);
  }
  if (!previous.size || wanted.jails === null) return previous.size > 0;
  const tested = ctx.run("fail2ban-client", ["-t"]);
  if (!tested.ok) {
    for (const [path, content] of previous) put(path, content);
    failAction(`fail2ban refused the jails: ${output(tested)}`);
  }
  return true;
}

// --- The service -----------------------------------------------------------

export function missingPackages(options: LoginJailOptions = {}): string[] {
  const { run } = contextOf(options);
  return LOGIN_JAIL_PACKAGES.filter((name) => !installedVersion(run, name));
}

function unitState(ctx: Context): { enabled: boolean; active: boolean; masked: boolean } {
  const enabled = ctx.run("systemctl", ["is-enabled", "fail2ban"]).stdout.trim();
  const active = ctx.run("systemctl", ["is-active", "fail2ban"]).stdout.trim();
  return { enabled: enabled === "enabled", active: active === "active", masked: enabled.startsWith("masked") };
}

function runningJails(ctx: Context): string[] {
  const result = ctx.run("fail2ban-client", ["status"]);
  const line = /Jail list:\s*(.*)$/m.exec(result.ok ? result.stdout : "");
  return line ? line[1]!.split(",").map((name) => name.trim()).filter(Boolean) : [];
}

function must(ctx: Context, command: string, args: string[]): void {
  const result = ctx.run(command, args);
  if (!result.ok) failAction(`${command} ${args.join(" ")} failed: ${output(result)}`);
}

/**
 * Puts fail2ban in the state the settings ask for. The first time it does,
 * it records the service as it was, and an SSH jail fail2ban already ran
 * stays on. With both jails off it puts the service back as recorded.
 */
export function applyLoginJails(settings: LoginJailSettings, before: Fail2banBefore | null, options: LoginJailOptions = {}): {
  before: Fail2banBefore | null; ssh: boolean; changed: boolean;
} {
  const ctx = contextOf(options);
  if (!settings.panel && !settings.ssh) {
    return { before: null, ssh: false, changed: releaseLoginJails(before, options) };
  }
  if (missingPackages(options).length) {
    const changed = applyLoginLog(false, options);
    return { before, ssh: settings.ssh, changed: applyDomainLog(false, options) || changed };
  }
  const state = unitState(ctx);
  if (state.masked) return { before, ssh: settings.ssh, changed: false };
  const recorded = before ?? { enabled: state.enabled, active: state.active };
  const wanted = { ...settings };
  if (before === null && state.active && runningJails(ctx).includes(SSH_JAIL)) wanted.ssh = true;
  let changed = applyLoginLog(wanted.panel, options);
  if (applyDomainLog(wanted.panel, options)) changed = true;
  const written = writeJailFiles(ctx, wanted);
  if (written || !state.active) {
    must(ctx, "systemctl", [state.active ? "reload" : "restart", "fail2ban"]);
    changed = true;
  }
  if (!state.enabled) must(ctx, "systemctl", ["enable", "fail2ban"]);
  return { before: recorded, ssh: wanted.ssh, changed };
}

/** Removes everything System Tweaks added and puts the service back as `before` says. */
export function releaseLoginJails(before: Fail2banBefore | null, options: LoginJailOptions = {}): boolean {
  const ctx = contextOf(options);
  let changed = applyLoginLog(false, options);
  if (applyDomainLog(false, options)) changed = true;
  if (writeJailFiles(ctx, { panel: false, ssh: false })) changed = true;
  if (!before) return changed;
  const state = unitState(ctx);
  if (before.active) {
    if (changed || !state.active) must(ctx, "systemctl", [state.active ? "reload" : "restart", "fail2ban"]);
  } else if (state.active) must(ctx, "systemctl", ["stop", "fail2ban"]);
  if (!before.enabled && state.enabled) must(ctx, "systemctl", ["disable", "fail2ban"]);
  return true;
}

/** apt-get install for whichever packages are missing, with the lists refreshed and tried once more when they are stale. */
export function installLoginJailPackages(options: LoginJailOptions = {}): void {
  const missing = missingPackages(options);
  if (missing.length) aptInstall(contextOf(options).run, missing);
}

// --- What the page shows ---------------------------------------------------

/** `fail2ban-client get <jail> banip --with-time`: `203.0.113.7 \t2026-11-04 11:18:24 + 3600 = 2026-11-04 12:18:24`. */
export function parseBans(jail: string, text: string): Ban[] {
  return text.split("\n").flatMap((line) => {
    const match = /^(\S+)\s+.*=\s*(.+?)\s*$/.exec(line.trim());
    return match && isIP(match[1]!) ? [{ jail, ip: match[1]!, until: match[2]! }] : [];
  });
}

export function sshLogin(config: Map<string, string>): SshLogin | null {
  if (!config.size) return null;
  const pam = config.get("usepam") === "yes" && config.get("kbdinteractiveauthentication") === "yes";
  return { password: config.get("passwordauthentication") === "yes" || pam, rootLogin: config.get("permitrootlogin") ?? "" };
}

export function loginJailsStatus(options: LoginJailOptions = {}): LoginJailsStatus {
  const ctx = contextOf(options);
  const problems: string[] = [];
  let panelLog: boolean | null = null;
  try { panelLog = panelLogActive(ctx); }
  catch (error) { problems.push(errorMessage(error)); }
  let customDomain: LoginJailsStatus["customDomain"] = null;
  try {
    const vhost = readDomainVhost(ctx);
    const name = vhost === null ? null : customDomainName(vhost);
    if (vhost !== null) {
      const wanted = withDomainLog(vhost);
      customDomain = { name: name ?? ctx.paths.domainVhost, logged: wanted === vhost, supported: wanted !== null };
    }
  } catch (error) { problems.push(errorMessage(error)); }
  const sshd = sshLogin(sshdConfig(ctx));
  const missing = missingPackages(options);
  if (missing.includes("fail2ban")) {
    return { missing, service: "inactive", running: [], panelLog, customDomain, bans: [], sshd, problem: problems.join("; ") };
  }
  const state = unitState(ctx);
  const running = state.active ? runningJails(ctx).filter((name) => (LOGIN_JAILS as readonly string[]).includes(name)) : [];
  const bans = running.flatMap((jail) => {
    const result = ctx.run("fail2ban-client", ["get", jail, "banip", "--with-time"]);
    return result.ok ? parseBans(jail, result.stdout) : [];
  });
  return {
    missing, service: state.masked ? "masked" : state.active ? "active" : "inactive", running, panelLog, customDomain, bans, sshd,
    problem: problems.join("; "),
  };
}

export function unban(body: Record<string, unknown>, options: LoginJailOptions = {}): void {
  const { jail, ip } = body;
  if (!(LOGIN_JAILS as readonly unknown[]).includes(jail)) failAction(`jail must be one of ${LOGIN_JAILS.join(", ")}`);
  if (typeof ip !== "string" || !isIP(ip)) failAction("ip must be an IPv4 or IPv6 address");
  const result = contextOf(options).run("fail2ban-client", ["set", jail as string, "unbanip", ip]);
  if (!result.ok) failAction(`fail2ban could not unban ${ip}: ${output(result)}`);
}

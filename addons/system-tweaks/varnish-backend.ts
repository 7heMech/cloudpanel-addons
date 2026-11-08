/**
 * CloudPanel fills a site's `{{varnish_proxy_pass}}` from
 * `~/.varnish-cache/settings.json`, which the site's own user can write, and
 * points `{{nginx_access_log}}` and `{{nginx_error_log}}` at
 * `~/logs/nginx/{access,error}.log`, which the site's own user can replace with
 * a symlink before the root nginx master opens them. Each site's stored vhost
 * names a root-owned Varnish include and root-owned log paths under
 * `/var/log/clp-addons-nginx/<user>/` in their place, while `~/logs/nginx`
 * becomes a symlink to `/var/log/clp-addons-nginx/<user>` so CloudPanel's Logs
 * viewer, SFTP and logrotate keep working.
 */
import type { Database } from "bun:sqlite";
import {
  chmodSync, chownSync, closeSync, constants, existsSync, fchmodSync, fchownSync, fstatSync, lchownSync,
  lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, renameSync,
  rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { failAction } from "../../lib/action";
import { normalizeIdentityHostname } from "../../lib/panel-identity";
import { runCommand, type CommandResult } from "../../lib/command";
import { trustedVhost, withNginxTransaction, type NginxChange } from "../../lib/nginx-transaction";
import { openPanelDatabase, withPanelDb } from "../../lib/panel-db";
import { CLI_BIN, DISTRO_NGINX_SITES_DIR, PANEL_DB, ROOT_UID, SYSTEMD_DIR } from "../../lib/paths";
import { learnVhostMapContent, renderVhostBodyResult } from "../../lib/site-vhost";
import { writeFileAtomic } from "../../lib/atomic-write";
import { daemonReload } from "../../lib/systemd";
import { isTrustedDirectory, present, regularText, trustedText } from "../../lib/trusted-file";
import { readVarnishSettings, VHOST_VALUE_RULES } from "./vhost-values";

const VARNISH_PLACEHOLDER = "{{varnish_proxy_pass}}";
const ACCESS_LOG_PLACEHOLDER = "{{nginx_access_log}}";
const ERROR_LOG_PLACEHOLDER = "{{nginx_error_log}}";
/** What CloudPanel renders when Varnish is off for a site. */
const NO_VARNISH = "proxy_pass http://127.0.0.1:8080;";
const MAX_LOG_MIGRATE_BYTES = 64 * 1024 * 1024;

const DEFAULT_VARNISH_BACKEND_PATHS = {
  panelDb: PANEL_DB,
  homeRoot: "/home",
  passwdFile: "/etc/passwd",
  vhostDir: DISTRO_NGINX_SITES_DIR,
  includeDir: "/etc/nginx/clp-addons-varnish",
  logDir: "/var/log/clp-addons-nginx",
  logrotateDir: "/etc/logrotate.d",
  dropIn: `${SYSTEMD_DIR}/nginx.service.d/zz-clp-addons-varnish.conf`,
  unit: "nginx.service",
  bin: CLI_BIN,
  vhostUid: ROOT_UID,
};

type VarnishBackendPaths = typeof DEFAULT_VARNISH_BACKEND_PATHS;

export interface VarnishBackendOptions {
  paths?: Partial<VarnishBackendPaths>;
  run?: (command: string, args: string[]) => CommandResult;
}

interface Context {
  paths: VarnishBackendPaths;
  run: (command: string, args: string[]) => CommandResult;
}

function contextOf(options: VarnishBackendOptions): Context {
  return {
    paths: { ...DEFAULT_VARNISH_BACKEND_PATHS, ...options.paths },
    run: options.run ?? ((command, args) => runCommand(command, args, 60_000)),
  };
}

interface Site {
  domain: string;
  user: string;
  varnish: boolean;
  cloudflare: boolean;
  template: string;
}

function sites(db: Database): Site[] {
  const cols = new Set(db.query<{ name: string }, []>("PRAGMA table_info(site)").all().map((col) => col.name));
  const selectCloudflare = cols.has("allow_traffic_from_cloudflare_only") ? "allow_traffic_from_cloudflare_only" : "0 AS allow_traffic_from_cloudflare_only";
  return db.query<{ domain_name: unknown; user: unknown; varnish_cache: unknown; allow_traffic_from_cloudflare_only: unknown; vhost_template: unknown }, []>(
    `SELECT domain_name, user, varnish_cache, ${selectCloudflare}, vhost_template FROM site ORDER BY domain_name`,
  ).all().flatMap((row) => {
    const domain = String(row.domain_name ?? "");
    const user = String(row.user ?? "");
    // No glob characters: nginx reads `*` in an include path as a mask.
    if (normalizeIdentityHostname(domain) !== domain || !/^[a-z0-9.-]+$/.test(domain) || !/^[a-z0-9][a-z0-9._-]{0,31}$/i.test(user) || typeof row.vhost_template !== "string") return [];
    return [{
      domain,
      user,
      varnish: Number(row.varnish_cache) === 1,
      cloudflare: Number(row.allow_traffic_from_cloudflare_only) === 1,
      template: row.vhost_template,
    }];
  });
}

function varnishIncludeLine(includeDir: string, domain: string): string {
  return `include ${includeDir}/${domain}.conf;`;
}

function siteAccessLogLine(logDir: string, user: string, cloudflare: boolean): string {
  return `access_log ${logDir}/${user}/access.log ${cloudflare ? "cloudflare" : "main"};`;
}

function siteErrorLogLine(logDir: string, user: string): string {
  return `error_log ${logDir}/${user}/error.log;`;
}

/** The line CloudPanel's VarnishProxyPass renders for these settings, and whether the server was refused. */
export function varnishBackend(varnish: boolean, settings: Record<string, unknown> | null): { line: string; refused: boolean } {
  if (!varnish) return { line: "", refused: false };
  const server = settings?.server;
  if (settings?.enabled !== true || server === undefined || server === null) return { line: NO_VARNISH, refused: false };
  if (typeof server !== "string" || !VHOST_VALUE_RULES.varnishServer(server)) return { line: NO_VARNISH, refused: true };
  return { line: `proxy_pass http://${server.replace(/^\/+|\/+$/g, "")};`, refused: false };
}

function includeContent(domain: string, line: string): string {
  return `# Managed by clp-addons System Tweaks: ${domain}'s Varnish backend, rewritten before nginx loads.\n${line ? `${line}\n` : ""}`;
}

function isRootDir(path: string, rootUid: number): boolean {
  try {
    return isTrustedDirectory(lstatSync(path), rootUid);
  } catch {
    return false;
  }
}

/** Whether nginx loads this site's include: its stored or its rendered vhost names it. */
function usesInclude(site: Site, paths: VarnishBackendPaths): boolean {
  const line = varnishIncludeLine(paths.includeDir, site.domain);
  return site.template.includes(VARNISH_PLACEHOLDER) || site.template.includes(line)
    || (regularText(join(paths.vhostDir, `${site.domain}.conf`))?.includes(line) ?? false);
}

/** Whether nginx opens this site's logs: its stored or rendered vhost names them, or ~/logs/nginx exists. */
function usesLogs(site: Site, paths: VarnishBackendPaths): boolean {
  const homeLogs = `/home/${site.user}/logs/nginx/`;
  const managedLogs = `${paths.logDir}/${site.user}/`;
  const rendered = regularText(join(paths.vhostDir, `${site.domain}.conf`)) ?? "";
  return site.template.includes(ACCESS_LOG_PLACEHOLDER)
    || site.template.includes(ERROR_LOG_PLACEHOLDER)
    || site.template.includes(homeLogs)
    || site.template.includes(managedLogs)
    || rendered.includes(homeLogs)
    || rendered.includes(managedLogs)
    || present(join(paths.homeRoot, site.user, "logs", "nginx"));
}

function passwdUsers(path: string): Map<string, Owner> {
  const users = new Map<string, Owner>();
  const text = regularText(path);
  if (!text) return users;
  for (const line of text.split("\n")) {
    const parts = line.split(":");
    if (parts.length < 4) continue;
    const uid = Number(parts[2]);
    const gid = Number(parts[3]);
    if (parts[0] && Number.isInteger(uid) && uid >= 0 && Number.isInteger(gid) && gid >= 0) {
      users.set(parts[0], { uid, gid });
    }
  }
  return users;
}

type Owner = { uid: number; gid: number };

/** Names logrotate and nginx give a site's logs: access.log, error.log-2026-11-03, access.log.1.gz. */
const LOG_NAME = /^[A-Za-z0-9._-]+\.log(?:-[0-9]{4}-[0-9]{2}-[0-9]{2}|\.[0-9]+)?(?:\.gz)?$/;

function openDirNoFollow(path: string): number | null {
  try {
    return openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch {
    return null;
  }
}

/** A path relative to an open directory, like the `*at()` calls: only its last component is looked up. */
function at(dirFd: number, name: string): string {
  return `/proc/self/fd/${dirFd}/${name}`;
}

/**
 * The last {@link MAX_LOG_MIGRATE_BYTES} of a regular file with one link,
 * opened without following a link or blocking on a FIFO, and whether that is all of it.
 */
function readLogTail(path: string): { data: Buffer; whole: boolean } | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1) return null;
    const length = Math.min(info.size, MAX_LOG_MIGRATE_BYTES);
    const data = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const n = readSync(fd, data, read, length - read, info.size - length + read);
      if (n === 0) break;
      read += n;
    }
    return { data: data.subarray(0, read), whole: length === info.size };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/**
 * Create a file that is not there yet, then set its owner and mode on the open
 * descriptor, never by path. Returns whether it was created.
 */
function createFileAt(path: string, data: Uint8Array, owner: Owner, mode: number): boolean {
  let fd: number;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch {
    return false;
  }
  try {
    fchownSync(fd, owner.uid, owner.gid);
    fchmodSync(fd, mode);
    // All of it or none: a short write on a full disk must not count as a copy.
    writeFileSync(fd, data);
  } catch (error) {
    try { unlinkSync(path); } catch {}
    throw error;
  } finally {
    closeSync(fd);
  }
  return true;
}

/** A directory only root can change: replaced when it is anything else. */
function ensureRootDir(path: string, mode: number, uid: number, gid: number): void {
  try {
    const info = lstatSync(path);
    if (!info.isDirectory()) rmSync(path, { recursive: true, force: true });
  } catch {}
  mkdirSync(path, { recursive: true, mode });
  try { chownSync(path, uid, gid); } catch {}
  chmodSync(path, mode);
}

function siteOwner(site: Site, paths: VarnishBackendPaths, passwd: Map<string, Owner>): Owner {
  const known = passwd.get(site.user);
  if (known) return known;
  try {
    const home = lstatSync(join(paths.homeRoot, site.user));
    if (home.isDirectory()) return { uid: home.uid, gid: home.gid };
  } catch {}
  return { uid: paths.vhostUid, gid: process.getgid?.() ?? 0 };
}

/** Run `use` with `/home/<user>/logs` open, so nothing the user renames meanwhile changes which directory it acts in. */
function withHomeLogs(site: Site, paths: VarnishBackendPaths, use: (logsFd: number) => void): void {
  const homeFd = openDirNoFollow(join(paths.homeRoot, site.user));
  if (homeFd === null) return;
  try {
    const logsFd = openDirNoFollow(at(homeFd, "logs"));
    if (logsFd === null) return;
    try { use(logsFd); }
    finally { closeSync(logsFd); }
  } finally {
    closeSync(homeFd);
  }
}

/**
 * Copy the logs from the site's own `~/logs/nginx` into root's directory, then
 * make `~/logs/nginx` a link to it. A log-named entry is removed once all of it
 * is copied; anything else is moved aside with the directory, never deleted.
 */
function linkHomeLogs(site: Site, paths: VarnishBackendPaths, siteLogDir: string, owner: Owner): void {
  withHomeLogs(site, paths, (logsFd) => {
    const entry = at(logsFd, "nginx");
    let info: ReturnType<typeof lstatSync> | null = null;
    try { info = lstatSync(entry); } catch {}
    if (info?.isSymbolicLink() && readlinkSync(entry) === siteLogDir) return;
    if (info?.isDirectory()) {
      const nginxFd = openDirNoFollow(entry);
      if (nginxFd === null) return;
      try {
        for (const name of readdirSync(at(nginxFd, "."))) {
          if (!LOG_NAME.test(name)) continue;
          const log = readLogTail(at(nginxFd, name));
          const copied = log !== null
            && createFileAt(join(siteLogDir, name), log.data, { uid: paths.vhostUid, gid: owner.gid }, 0o640)
            && log.whole;
          // A link or a FIFO under a log's name is not a log; removing the name never follows it.
          if (copied || log === null) {
            try { unlinkSync(at(nginxFd, name)); } catch {}
          }
        }
      } finally {
        closeSync(nginxFd);
      }
      try {
        rmdirSync(entry);
      } catch {
        try { renameSync(entry, at(logsFd, `nginx.before-clp-addons-${Date.now()}`)); } catch { return; }
      }
    } else if (info) {
      try { unlinkSync(entry); } catch { return; }
    }
    try {
      symlinkSync(siteLogDir, entry);
      lchownSync(entry, owner.uid, owner.gid);
    } catch { /* the vhost names root's directory either way */ }
  });
}

/** `/etc/logrotate.d/<user>` as CloudPanel's site creator writes it: everything in `~/logs`, rotated as root. */
export function cloudpanelLogrotate(user: string): string {
  return `/home/${user}/logs/*/*.log {
    su root root
    daily
    missingok
    rotate 7
    dateext
    dateformat -%Y-%m-%d
    create 0640 ${user} ${user}
    postrotate
      /etc/init.d/nginx reload &> /dev/null || true
    endscript
}`;
}

/**
 * The same rotation, with the folders the site's user owns rotated as that
 * user, so a link it puts there gets only its own rights, and nginx's logs
 * rotated as root in root's directory. The reload still runs as root.
 */
function addonLogrotate(user: string, logDir: string): string {
  const options = `    daily
    missingok
    rotate 7
    dateext
    dateformat -%Y-%m-%d`;
  return `# Managed by clp-addons System Tweaks: the site's own logs rotate as its user, nginx's in root's directory.
/home/${user}/logs/php/*.log /home/${user}/logs/varnish-cache/*.log {
    su ${user} ${user}
${options}
    create 0640 ${user} ${user}
}

${logDir}/${user}/*.log {
${options}
    create 0640 root ${user}
    postrotate
      /etc/init.d/nginx reload &> /dev/null || true
    endscript
}
`;
}

/** The site's logrotate file when only root can change it, as a regular file. */
function logrotateText(site: Site, paths: VarnishBackendPaths): string | null {
  try {
    return trustedText(join(paths.logrotateDir, site.user), paths.vhostUid);
  } catch {
    return null;
  }
}

/** Swap CloudPanel's logrotate file for the addon's, or back; a file edited by hand stays as it is. */
function syncLogrotate(site: Site, paths: VarnishBackendPaths, enabled: boolean): void {
  const current = logrotateText(site, paths);
  if (current === null) return;
  const cloudpanel = cloudpanelLogrotate(site.user);
  const ours = addonLogrotate(site.user, paths.logDir);
  const next = enabled
    ? (current.replace(/\n$/, "") === cloudpanel ? ours : null)
    : (current === ours ? cloudpanel : null);
  if (next !== null) writeFileAtomic(join(paths.logrotateDir, site.user), next, { mode: 0o644 });
}

/** Keep the site's logs in root's directory, linked from `~/logs/nginx`, with the access-log format CloudPanel's Cloudflare setting asks for. */
function syncSiteLogs(site: Site, paths: VarnishBackendPaths, owner: Owner): void {
  ensureRootDir(paths.logDir, 0o711, paths.vhostUid, 0);
  const siteLogDir = join(paths.logDir, site.user);
  ensureRootDir(siteLogDir, 0o750, paths.vhostUid, owner.gid);
  linkHomeLogs(site, paths, siteLogDir, owner);
  for (const name of ["access.log", "error.log"]) {
    createFileAt(join(siteLogDir, name), new Uint8Array(), { uid: paths.vhostUid, gid: owner.gid }, 0o640);
  }

  // Before nginx opens anything: CloudPanel renders a new site, or one whose
  // stored vhost still has the placeholders, with paths in the user's home,
  // and its Cloudflare form re-renders the stored log line with its old format.
  const vhostPath = join(paths.vhostDir, `${site.domain}.conf`);
  try {
    const vhost = trustedVhost(vhostPath, paths.vhostUid);
    const next = pointLogsAtRoot(vhost.content, site, paths);
    if (next !== vhost.content) writeFileAtomic(vhostPath, next, { mode: vhost.mode, owner: { uid: vhost.uid, gid: vhost.gid } });
  } catch {}
}

/** Every user a site row names, as stored, including rows the sync skips. */
function siteUsers(db: Database): Set<string> {
  return new Set(db.query<{ user: unknown }, []>("SELECT user FROM site").all().map((row) => String(row.user ?? "")));
}

/** Each site user's logs copied back into its home on switch-off, by name, with the size copied. */
type CopiedLogs = Map<string, Map<string, number>>;

/** Where switch-off keeps what it could not copy back in full: root's alone, beside the log directory. */
function keptLogDir(paths: VarnishBackendPaths): string {
  return `${paths.logDir}-kept`;
}

/**
 * Move a site log directory aside into {@link keptLogDir}, then delete from it
 * each file copied in full whose size has not changed since. What is left,
 * such as a log over the copy limit or lines nginx wrote after the copy, stays.
 */
function keepUncopiedLogs(paths: VarnishBackendPaths, user: string, copied: Map<string, number>): void {
  const keptRoot = keptLogDir(paths);
  ensureRootDir(keptRoot, 0o700, paths.vhostUid, 0);
  const aside = join(keptRoot, `${user}-${Date.now()}`);
  try { renameSync(join(paths.logDir, user), aside); } catch { return; }
  for (const name of readdirSync(aside)) {
    const file = join(aside, name);
    try {
      const info = lstatSync(file);
      if (info.isFile() && copied.get(name) === info.size) unlinkSync(file);
    } catch {}
  }
  try { rmdirSync(aside); } catch { return; }
  try { rmdirSync(keptRoot); } catch {}
}

/**
 * Remove each site log directory whose user is not in `keep` and that no
 * vhost in sites-enabled writes to, as when CloudPanel has deleted the site.
 * rmSync removes a link in place and never follows one. On switch-off,
 * `copied` says what is in the homes, and the rest is kept.
 */
function pruneSiteLogDirs(paths: VarnishBackendPaths, keep: Set<string>, copied?: CopiedLogs): void {
  if (!existsSync(paths.logDir)) return;
  const vhosts = existsSync(paths.vhostDir)
    ? readdirSync(paths.vhostDir).filter((entry) => entry.endsWith(".conf")).map((name) => {
      // Read through a link: a vhost linked from sites-available still writes there.
      try { return readFileSync(join(paths.vhostDir, name), "utf8"); } catch { return ""; }
    })
    : [];
  for (const user of readdirSync(paths.logDir)) {
    const prefix = `${paths.logDir}/${user}/`;
    if (keep.has(user) || vhosts.some((vhost) => vhost.includes(prefix))) continue;
    const dir = join(paths.logDir, user);
    if (copied && isRootDir(dir, paths.vhostUid)) keepUncopiedLogs(paths, user, copied.get(user) ?? new Map());
    else rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Put `~/logs/nginx` back as the site user's own directory, with a copy of the
 * logs root kept. Returns what was copied in full.
 */
function unstageSiteLogs(all: Site[], paths: VarnishBackendPaths, passwd: Map<string, Owner>): CopiedLogs {
  const copied: CopiedLogs = new Map();
  for (const site of all) {
    const owner = siteOwner(site, paths, passwd);
    const siteLogDir = join(paths.logDir, site.user);
    syncLogrotate(site, paths, false);
    withHomeLogs(site, paths, (logsFd) => {
      const entry = at(logsFd, "nginx");
      try {
        if (lstatSync(entry).isSymbolicLink()) unlinkSync(entry);
      } catch {}
      try { mkdirSync(entry, { mode: 0o700 }); } catch {}
      const nginxFd = openDirNoFollow(entry);
      if (nginxFd === null) return;
      try {
        fchownSync(nginxFd, owner.uid, owner.gid);
        fchmodSync(nginxFd, 0o770);
        let names: string[] = [];
        try {
          const info = lstatSync(siteLogDir);
          if (info.isDirectory() && info.uid === paths.vhostUid) names = readdirSync(siteLogDir);
        } catch {}
        for (const name of names.filter((name) => LOG_NAME.test(name))) {
          const log = readLogTail(join(siteLogDir, name));
          if (log !== null && createFileAt(at(nginxFd, name), log.data, owner, 0o640) && log.whole) {
            const user = copied.get(site.user) ?? new Map<string, number>();
            user.set(name, log.data.length);
            copied.set(site.user, user);
          }
        }
      } finally {
        closeSync(nginxFd);
      }
    });
  }
  return copied;
}

/**
 * Write every site's include from its settings file and prepare its root-owned
 * nginx log directory; what nginx loads and opens is only ever under root's
 * control. Returns the sites whose Varnish server was refused.
 */
export function syncVarnishBackends(options: VarnishBackendOptions = {}): string[] {
  const { paths } = contextOf(options);
  const { all, users } = withPanelDb(paths.panelDb, (db) => ({ all: sites(db), users: siteUsers(db) }));
  const passwd = passwdUsers(paths.passwdFile);
  mkdirSync(paths.includeDir, { recursive: true, mode: 0o755 });
  const kept = new Set<string>();
  const refused: string[] = [];
  for (const site of all) {
    if (usesLogs(site, paths)) {
      // One site's logs must not keep the other sites' includes from being written.
      try { syncSiteLogs(site, paths, siteOwner(site, paths, passwd)); } catch {}
    }
    try { syncLogrotate(site, paths, true); } catch {}
    if (!usesInclude(site, paths)) continue;
    const backend = varnishBackend(site.varnish, readVarnishSettings(paths.homeRoot, site.user));
    if (backend.refused) refused.push(site.domain);
    const file = join(paths.includeDir, `${site.domain}.conf`);
    kept.add(file);
    const content = includeContent(site.domain, backend.line);
    if (regularText(file) !== content) writeFileAtomic(file, content, { mode: 0o644 });
  }
  for (const name of readdirSync(paths.includeDir).filter((entry) => entry.endsWith(".conf"))) {
    const file = join(paths.includeDir, name);
    const domain = name.replace(/\.conf$/, "");
    if (kept.has(file) || regularText(join(paths.vhostDir, name))?.includes(varnishIncludeLine(paths.includeDir, domain))) continue;
    rmSync(file, { force: true });
  }
  pruneSiteLogDirs(paths, users);
  return refused;
}

/** The unit's own `ExecStartPre=` and `ExecReload=` lines, which the drop-in runs after the sync. */
function unitLines(ctx: Context): { startPre: string; reload: string } {
  const shown = ctx.run("systemctl", ["show", "-p", "FragmentPath", "--value", ctx.paths.unit]);
  const fragment = shown.ok ? regularText(shown.stdout.trim()) : null;
  const lines = fragment?.split("\n") ?? [];
  const only = (key: string) => {
    const found = lines.filter((line) => line.startsWith(`${key}=`));
    return found.length === 1 && !found[0]!.endsWith("\\") && found[0] !== `${key}=` ? found[0]! : null;
  };
  const startPre = only("ExecStartPre");
  const reload = only("ExecReload");
  if (!startPre || !reload) failAction(`${ctx.paths.unit} is not the nginx unit this addon knows`);
  return { startPre, reload };
}

function varnishDropIn(bin: string, startPre: string, reload: string): string {
  return [
    "# Managed by clp-addons System Tweaks: writes each site's checked Varnish backend before nginx loads the vhosts.",
    "[Service]",
    "ExecStartPre=",
    `ExecStartPre=-${bin} sync-varnish`,
    startPre,
    "ExecReload=",
    `ExecReload=-${bin} sync-varnish`,
    reload,
    "",
  ].join("\n");
}

function expectedDropIn(ctx: Context): string {
  const { startPre, reload } = unitLines(ctx);
  return varnishDropIn(ctx.paths.bin, startPre, reload);
}

/** CloudPanel's access and error log lines for this site, in its home or root's directory. */
function logLinePatterns(site: Site, paths: VarnishBackendPaths, dirs: "both" | "root"): { access: RegExp; error: RegExp } {
  const root = `${RegExp.escape(paths.logDir)}/${RegExp.escape(site.user)}`;
  const dir = dirs === "both" ? `(?:/home/${RegExp.escape(site.user)}/logs/nginx|${root})` : root;
  return {
    access: new RegExp(`^([ \\t]*)access_log[ \\t]+${dir}/access\\.log[ \\t]+(?:main|cloudflare)[ \\t]*;`, "gm"),
    error: new RegExp(`^([ \\t]*)error_log[ \\t]+${dir}/error\\.log[ \\t]*;`, "gm"),
  };
}

/**
 * Point the site's log lines at root's directory, with the access-log format
 * its Cloudflare setting asks for. Exact lines only, so it is safe on a
 * rendered vhost whose placeholders cannot be read back.
 */
function pointLogsAtRoot(content: string, site: Site, paths: VarnishBackendPaths): string {
  const { access, error } = logLinePatterns(site, paths, "both");
  return content
    .replace(access, `$1${siteAccessLogLine(paths.logDir, site.user, site.cloudflare)}`)
    .replace(error, `$1${siteErrorLogLine(paths.logDir, site.user)}`);
}

function rewriteTemplate(site: Site, paths: VarnishBackendPaths, enabled: boolean): string {
  const line = varnishIncludeLine(paths.includeDir, site.domain);
  if (enabled) {
    return pointLogsAtRoot(site.template
      .replaceAll(VARNISH_PLACEHOLDER, line)
      .replaceAll(ACCESS_LOG_PLACEHOLDER, siteAccessLogLine(paths.logDir, site.user, site.cloudflare))
      .replaceAll(ERROR_LOG_PLACEHOLDER, siteErrorLogLine(paths.logDir, site.user)), site, paths);
  }
  const { access, error } = logLinePatterns(site, paths, "root");
  return site.template
    .replaceAll(line, VARNISH_PLACEHOLDER)
    .replace(access, `$1${ACCESS_LOG_PLACEHOLDER}`)
    .replace(error, `$1${ERROR_LOG_PLACEHOLDER}`);
}

/**
 * Swap the Varnish and log placeholders for root-owned paths in each stored
 * vhost, or back. A rendered vhost follows when its placeholders can be read
 * back from it; otherwise CloudPanel renders it from the stored one on its next save.
 */
function stageVhosts(db: Database, changes: NginxChange[], paths: VarnishBackendPaths, enabled: boolean): void {
  for (const site of sites(db)) {
    const line = varnishIncludeLine(paths.includeDir, site.domain);
    const accessLine = siteAccessLogLine(paths.logDir, site.user, site.cloudflare);
    const template = rewriteTemplate(site, paths, enabled);
    const path = join(paths.vhostDir, `${site.domain}.conf`);
    if (enabled && existsSync(path)) {
      let backup: ReturnType<typeof trustedVhost> | null = null;
      try { backup = trustedVhost(path, paths.vhostUid); } catch { /* left for CloudPanel to render */ }
      const learned = backup
        ? (learnVhostMapContent(site.template, backup.content).map
          ?? (site.template.includes(line) ? learnVhostMapContent(site.template.replaceAll(line, VARNISH_PLACEHOLDER), backup.content).map : null))
        : null;
      let rendered = learned ? renderVhostBodyResult(template, learned).value : null;
      if (rendered !== null && learned?.get("nginx_access_log")?.includes("include /etc/nginx/cloudflare/ips;") && !rendered.includes("include /etc/nginx/cloudflare/ips;")) {
        rendered = rendered.replace(accessLine, `${accessLine}\n  include /etc/nginx/cloudflare/ips;`);
      }
      if (backup) {
        // A rendered vhost whose placeholders cannot be read back still gets root's log paths.
        const next = pointLogsAtRoot(rendered !== null ? rendered + (backup.content.endsWith("\n") ? "\n" : "") : backup.content, site, paths);
        if (next !== backup.content) changes.push({ backup, content: next });
      }
    }
    if (!enabled) {
      const current = regularText(path);
      const managedAccess = new RegExp(
        `^([ \\t]*access_log[ \\t]+)${RegExp.escape(paths.logDir)}/${RegExp.escape(site.user)}(/access\\.log[ \\t]+(?:main|cloudflare)[ \\t]*;)`,
        "gm",
      );
      const managedError = new RegExp(
        `^([ \\t]*error_log[ \\t]+)${RegExp.escape(paths.logDir)}/${RegExp.escape(site.user)}(/error\\.log[ \\t]*;)`,
        "gm",
      );
      if (current !== null && (current.includes(line) || managedAccess.test(current) || managedError.test(current))) {
        // Refused when it is not root's alone, since the paths it names are about to go.
        const backup = trustedVhost(path, paths.vhostUid);
        const backend = varnishBackend(site.varnish, readVarnishSettings(paths.homeRoot, site.user));
        const next = backup.content
          .replaceAll(line, backend.line)
          .replace(managedAccess, `$1/home/${site.user}/logs/nginx$2`)
          .replace(managedError, `$1/home/${site.user}/logs/nginx$2`);
        changes.push({ backup, content: next });
      }
    }
    if (template !== site.template) {
      db.query("UPDATE site SET vhost_template = ?, updated_at = CURRENT_TIMESTAMP WHERE domain_name = ?").run(template, site.domain);
    }
  }
}

function withVhosts(ctx: Context, enabled: boolean): boolean {
  const db = openPanelDatabase(ctx.paths.panelDb);
  try {
    return withNginxTransaction(db, { nginx: "nginx", systemctl: "systemctl" }, ctx.run,
      (changes) => stageVhosts(db, changes, ctx.paths, enabled)).changed;
  } finally {
    db.close();
  }
}

/**
 * Write the includes and log directories, run the sync before every nginx start
 * and reload, then point each site's vhost at them. Returns whether anything changed.
 */
export function installVarnishBackends(options: VarnishBackendOptions = {}): boolean {
  const ctx = contextOf(options);
  const dropIn = expectedDropIn(ctx);
  syncVarnishBackends(options);
  let changed = false;
  if (regularText(ctx.paths.dropIn) !== dropIn) {
    writeFileAtomic(ctx.paths.dropIn, dropIn, { mode: 0o644, createParent: true });
    daemonReload(ctx.run);
    changed = true;
  }
  return withVhosts(ctx, true) || changed;
}

/** Put the placeholders and ~/logs/nginx directories back, then remove the sync, includes and managed log directories. */
export function removeVarnishBackends(options: VarnishBackendOptions = {}): boolean {
  const ctx = contextOf(options);
  const dropIn = regularText(ctx.paths.dropIn);
  if (dropIn === null && !existsSync(ctx.paths.includeDir) && !existsSync(ctx.paths.logDir)) return false;
  if (dropIn !== null) {
    rmSync(ctx.paths.dropIn, { force: true });
    daemonReload(ctx.run);
  }
  const all = withPanelDb(ctx.paths.panelDb, sites);
  const passwd = passwdUsers(ctx.paths.passwdFile);
  let copied: CopiedLogs;
  try {
    copied = unstageSiteLogs(all, ctx.paths, passwd);
    withVhosts(ctx, false);
  } catch (error) {
    if (dropIn !== null) {
      writeFileAtomic(ctx.paths.dropIn, dropIn, { mode: 0o644, createParent: true });
      daemonReload(ctx.run);
    }
    try { syncVarnishBackends(options); } catch {}
    throw error;
  }
  // A vhost CloudPanel rendered from the old stored one meanwhile still names its include or log path.
  for (const name of existsSync(ctx.paths.includeDir) ? readdirSync(ctx.paths.includeDir) : []) {
    const domain = name.replace(/\.conf$/, "");
    if (!regularText(join(ctx.paths.vhostDir, name))?.includes(varnishIncludeLine(ctx.paths.includeDir, domain))) {
      rmSync(join(ctx.paths.includeDir, name), { recursive: true, force: true });
    }
  }
  if (existsSync(ctx.paths.includeDir) && readdirSync(ctx.paths.includeDir).length === 0) rmSync(ctx.paths.includeDir, { recursive: true });
  if (existsSync(ctx.paths.logDir)) {
    pruneSiteLogDirs(ctx.paths, new Set(), copied);
    if (readdirSync(ctx.paths.logDir).length === 0) rmSync(ctx.paths.logDir, { recursive: true });
  }
  return true;
}

function renderedHomeLogs(site: Site, paths: VarnishBackendPaths): boolean {
  return regularText(join(paths.vhostDir, `${site.domain}.conf`))?.includes(`/home/${site.user}/logs/nginx/`) ?? false;
}

/** Sites whose logrotate file is neither CloudPanel's nor the addon's, so the sync leaves it as it is. */
export function sitesWithOwnLogrotate(options: VarnishBackendOptions = {}): string[] {
  const { paths } = contextOf(options);
  try {
    return withPanelDb(paths.panelDb, sites).filter((site) => {
      const current = logrotateText(site, paths) ?? (present(join(paths.logrotateDir, site.user)) ? "" : null);
      return current !== null && current !== addonLogrotate(site.user, paths.logDir);
    }).map((site) => site.domain);
  } catch {
    return [];
  }
}

/**
 * Sites whose rendered vhost still names a log in the user's home. The sync
 * leaves a vhost alone when root is not the only one who can write it.
 */
export function sitesWithHomeLogs(options: VarnishBackendOptions = {}): string[] {
  const { paths } = contextOf(options);
  try {
    return withPanelDb(paths.panelDb, sites).filter((site) => renderedHomeLogs(site, paths)).map((site) => site.domain);
  } catch {
    return [];
  }
}

/** In force when the sync runs before nginx loads, and no site's vhost is left for CloudPanel to fill from a user-owned path. */
export function varnishBackendsActive(options: VarnishBackendOptions = {}): boolean {
  const ctx = contextOf(options);
  try {
    if (regularText(ctx.paths.dropIn) !== expectedDropIn(ctx)) return false;
    return withPanelDb(ctx.paths.panelDb, sites).every((site) =>
      !site.template.includes(VARNISH_PLACEHOLDER)
      && !site.template.includes(ACCESS_LOG_PLACEHOLDER)
      && !site.template.includes(ERROR_LOG_PLACEHOLDER)
      && !site.template.includes(`/home/${site.user}/logs/nginx/`)
      && !renderedHomeLogs(site, ctx.paths)
      && (!site.template.includes(varnishIncludeLine(ctx.paths.includeDir, site.domain)) || existsSync(join(ctx.paths.includeDir, `${site.domain}.conf`)))
      && (!site.template.includes(`${ctx.paths.logDir}/${site.user}/`) || isRootDir(join(ctx.paths.logDir, site.user), ctx.paths.vhostUid))
      && logrotateText(site, ctx.paths)?.replace(/\n$/, "") !== cloudpanelLogrotate(site.user));
  } catch {
    return false;
  }
}

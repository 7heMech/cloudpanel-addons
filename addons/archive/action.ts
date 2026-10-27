/**
 * Archive Sites' privileged verbs. Archiving takes a final backup of a live
 * site -- its whole home and every database -- checks it can be read back, and
 * only then deletes the site through CloudPanel's own CLI. Optionally DNS then
 * makes the domain a redirect. Restoring creates the site again the panel's
 * way and puts the files and databases back.
 *
 * Both run as background jobs, one at a time: a site's files can take minutes.
 */
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  ActionFailure, emitActionError, emitActionOk, failAction, runCommand, withFileLock,
} from "../../cli/action-common";
import { validateDomain } from "../../lib/app-http";
import {
  jobCommonFields, jobDir, jobGet, jobIdArgument, jobSiteProgress, listJobIds, queueJob, readJobLog, readJobResult, runSiteJob,
  watchJobRecord, type startJobUnit,
} from "../../cli/job-store";
import { CLI_BIN, CONFIG_DIR, PANEL_DB, STATE_DIR } from "../../cli/paths";
import { DEFAULT_SITE_VHOST_PATHS, replaceSiteVhost } from "../../cli/site-vhost";
import { standInDomains } from "../../cli/stand-ins";
import { writeFileAtomic } from "../../lib/atomic-write";

export type ArchiveVerb = "list" | "archive" | "restore" | "delete" | "run" | "job" | "watch-job";

const VERBS: ArchiveVerb[] = ["list", "archive", "restore", "delete", "run", "job", "watch-job"];
const JOB_RUNTIME_SECONDS = 6 * 3600;
const MAX_BODY = 64 * 1024;
const ID_RE = /^[a-z0-9.-]{1,200}--\d{8}T\d{6}Z$/;

export interface ArchivePaths {
  panelDb: string;
  clpctl: string;
  sqlite3: string;
  nginxVhostDir: string;
  tempDir: string;
  homeRoot: string;
  /** One directory per archive, root-only. */
  archiveDir: string;
  jobsDir: string;
  lockFile: string;
  /** Whether DNS is enabled, for the redirect step. */
  dnsConfig: string;
  /** Instatic's records: its sites are archived by Instatic itself. */
  instaticDir: string;
  standIns: string;
  rootUid: number;
}

export const DEFAULT_ARCHIVE_PATHS: ArchivePaths = {
  panelDb: PANEL_DB,
  clpctl: "/usr/bin/clpctl",
  sqlite3: DEFAULT_SITE_VHOST_PATHS.sqlite3,
  nginxVhostDir: DEFAULT_SITE_VHOST_PATHS.nginxVhostDir,
  tempDir: DEFAULT_SITE_VHOST_PATHS.tempDir,
  homeRoot: "/home",
  archiveDir: "/var/backups/clp-addons/archive",
  jobsDir: `${STATE_DIR}/archive/jobs`,
  lockFile: "/run/lock/clp-addons/archive.lock",
  dnsConfig: `${CONFIG_DIR}/dns.conf`,
  instaticDir: `${STATE_DIR}/instatic`,
  standIns: `${STATE_DIR}/dns/standins.json`,
  rootUid: 0,
};

export interface ArchiveOptions {
  paths?: Partial<ArchivePaths>;
  input?: string;
  emitReply?: boolean;
  processUid?: number;
  start?: typeof startJobUnit;
  /** The DNS step, run in-process; tests replace it. */
  dns?: (verb: string, body: unknown) => Promise<unknown>;
}

// ---------------------------------------------------------------------------
// What an archive holds
// ---------------------------------------------------------------------------

export interface ArchivedDatabaseUser {
  name: string;
  permissions: string;
  /** CloudPanel's own encrypted copy of the password, so the panel shows the same one again. */
  panelPassword: string;
  /** MySQL's hash of it, per host, so the password itself is never read. */
  logins: { host: string; plugin: string; hash: string }[];
}

export interface ArchiveMeta {
  version: 1;
  id: string;
  domain: string;
  archivedAt: string;
  type: string;
  application: string;
  siteUser: string;
  rootDirectory: string;
  vhost: string;
  phpVersion: string;
  nodejsVersion: string;
  pythonVersion: string;
  appPort: number | null;
  reverseProxyUrl: string;
  databases: { name: string; users: ArchivedDatabaseUser[] }[];
  /** Kept for reference: the panel has no command to add these back. */
  sshUsers: string[];
  ftpUsers: string[];
  cronJobs: string[];
  bytes: number;
  redirect: { target: string; applied: boolean; reason: string } | null;
  restoredAt?: string;
}

export interface ArchiveSiteView {
  domain: string;
  type: string;
  application: string;
  databases: number;
  /** Why it cannot be archived here, if it cannot. */
  blocked: string;
}

export interface ArchiveJobView {
  id: string;
  task: "archive" | "restore" | "delete";
  targets: string[];
  state: string;
  step: string;
  error: string;
  completed: number;
  total: number;
  site: string;
  result: ArchiveJobResult | null;
}

export interface ArchiveJobResult {
  done: string[];
  failed: { target: string; error: string }[];
  notes: string[];
}

export interface ArchiveState {
  sites: ArchiveSiteView[];
  archives: (Omit<ArchiveMeta, "vhost" | "databases"> & { databases: string[] })[];
  dns: boolean;
  job: ArchiveJobView | null;
  lastJob: ArchiveJobView | null;
}

export interface RedirectChoice {
  target: string;
  status: number;
  keepPath: boolean;
  keepQuery: boolean;
}

// ---------------------------------------------------------------------------
// The panel's record of a site
// ---------------------------------------------------------------------------

function withPanel<T>(paths: ArchivePaths, read: (db: Database) => T): T {
  const db = new Database(paths.panelDb, { readonly: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    return read(db);
  } finally {
    db.close();
  }
}

interface SiteRow {
  id: number;
  domain_name: string;
  type: string;
  application: string | null;
  user: string;
  root_directory: string | null;
  vhost_template: string | null;
  reverse_proxy_url: string | null;
  php_version: string | null;
  nodejs_version: string | null;
  nodejs_port: number | null;
  python_version: string | null;
  python_port: number | null;
}

function siteRow(db: Database, domain: string): SiteRow | null {
  return db.query<SiteRow, [string]>(`
    SELECT s.id, s.domain_name, s.type, s.application, s.user, s.root_directory, s.vhost_template, s.reverse_proxy_url,
           p.php_version, n.nodejs_version, n.port AS nodejs_port, y.python_version, y.port AS python_port
      FROM site s
      LEFT JOIN php_settings p ON p.site_id = s.id
      LEFT JOIN nodejs_settings n ON n.site_id = s.id
      LEFT JOIN python_settings y ON y.site_id = s.id
     WHERE s.domain_name = ?`).get(domain);
}

function siteExists(paths: ArchivePaths, domain: string): boolean {
  return withPanel(paths, (db) => db.query("SELECT 1 FROM site WHERE domain_name = ?").get(domain) !== null);
}

function blockedReason(paths: ArchivePaths, domain: string, standIns: Set<string>): string {
  if (standIns.has(domain)) return "It serves a DNS redirect; delete the redirect on the DNS page";
  if (existsSync(join(paths.instaticDir, domain, "meta.json"))) return "Instatic keeps its own final archive when it deletes a site; delete it there";
  return "";
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function clpctl(paths: ArchivePaths, args: string[], what: string): void {
  const result = runCommand(paths.clpctl, args, 3 * 3600_000);
  if (!result.ok) throw new Error(`${what}: ${(result.stderr || result.stdout).trim().split("\n").pop() || "clpctl failed"}`);
}

interface Master { host: string; port: string; user: string; password: string }

/** CloudPanel's own database administrator, read from its CLI each time and only ever passed in the environment. */
function master(paths: ArchivePaths): Master {
  const result = runCommand(paths.clpctl, ["db:show:master-credentials"], 60_000);
  const field = (name: string) => new RegExp(`\\|\\s*${name}\\s*\\|\\s*(\\S+)\\s*\\|`).exec(result.stdout)?.[1] ?? "";
  const credentials = { host: field("Host"), port: field("Port"), user: field("User Name"), password: field("Password") };
  if (!result.ok || !credentials.host || !credentials.user) throw new Error("CloudPanel did not show its database credentials");
  return credentials;
}

function mysql(credentials: Master, sql: string): string {
  const result = Bun.spawnSync(["mysql", `-h${credentials.host}`, `-P${credentials.port || "3306"}`, `-u${credentials.user}`, "-N", "-B", "-e", sql], {
    stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 60_000,
    env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", MYSQL_PWD: credentials.password },
  });
  if (!result.success) throw new Error(`MySQL refused a query: ${result.stderr.toString().trim().split("\n").pop() ?? ""}`);
  return result.stdout.toString();
}

const sqlString = (value: string): string => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;

function mysqlLogins(credentials: Master, user: string): ArchivedDatabaseUser["logins"] {
  return mysql(credentials, `SELECT host, plugin, HEX(authentication_string) FROM mysql.user WHERE user = ${sqlString(user)}`)
    .split("\n").filter(Boolean).map((line) => {
      const [host = "", plugin = "", hash = ""] = line.split("\t");
      return { host, plugin, hash };
    });
}

/** The archived hash back on a user CloudPanel has just created with a throwaway password. */
function restoreLogin(credentials: Master, user: string, login: ArchivedDatabaseUser["logins"][number]): void {
  if (!/^[a-z0-9_]+$/i.test(login.plugin) || !/^[0-9A-F]*$/i.test(login.hash)) throw new Error(`the archived login of ${user} is not one MySQL wrote`);
  const mariadb = /mariadb/i.test(mysql(credentials, "SELECT VERSION()"));
  const auth = mariadb
    ? `IDENTIFIED VIA ${login.plugin} USING ${sqlString(Buffer.from(login.hash, "hex").toString("latin1"))}`
    : `IDENTIFIED WITH ${login.plugin} AS 0x${login.hash}`;
  mysql(credentials, `ALTER USER ${sqlString(user)}@${sqlString(login.host)} ${auth}`);
}

/** Through the panel's own user, as every panel write here is. */
function panelWrite(paths: ArchivePaths, statement: string): void {
  const result = runCommand("runuser", ["-u", "clp", "--", paths.sqlite3, paths.panelDb, `PRAGMA busy_timeout=5000; ${statement}`]);
  if (!result.ok) throw new Error("CloudPanel's database refused the update");
}

function directorySize(path: string): number {
  let total = 0;
  for (const entry of readdirSync(path)) total += statSync(join(path, entry)).size;
  return total;
}

// ---------------------------------------------------------------------------
// Archives on disk
// ---------------------------------------------------------------------------

function archivePath(paths: ArchivePaths, id: string): string {
  if (!ID_RE.test(id)) failAction("that is not an archive");
  return join(paths.archiveDir, id);
}

function readMeta(paths: ArchivePaths, id: string): ArchiveMeta {
  const dir = archivePath(paths, id);
  const file = join(dir, "meta.json");
  const stat = existsSync(file) ? lstatSync(file) : null;
  if (!stat?.isFile() || (stat.mode & 0o077) !== 0) failAction("that archive is missing or not this server's own");
  const meta = JSON.parse(readFileSync(file, "utf8")) as ArchiveMeta;
  if (meta.version !== 1 || meta.id !== id) failAction("that archive is not one this addon wrote");
  return meta;
}

function writeMeta(paths: ArchivePaths, meta: ArchiveMeta): void {
  writeFileAtomic(join(archivePath(paths, meta.id), "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
}

function archives(paths: ArchivePaths): ArchiveMeta[] {
  if (!existsSync(paths.archiveDir)) return [];
  return readdirSync(paths.archiveDir).filter((name) => ID_RE.test(name)).flatMap((id) => {
    try {
      return [readMeta(paths, id)];
    } catch {
      return [];
    }
  }).sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
}

// ---------------------------------------------------------------------------
// Archiving and restoring one site
// ---------------------------------------------------------------------------

/** A final backup, read back before anything is deleted; then the site goes. */
export async function archiveSite(paths: ArchivePaths, domain: string, step: (text: string) => void): Promise<ArchiveMeta> {
  const reason = blockedReason(paths, domain, standInDomains(paths.standIns, paths.rootUid));
  if (reason) throw new Error(reason);
  const site = withPanel(paths, (db) => siteRow(db, domain));
  if (!site) throw new Error(`CloudPanel has no site ${domain}`);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const id = `${domain}--${stamp}`;
  const dir = join(paths.archiveDir, id);
  mkdirSync(paths.archiveDir, { recursive: true, mode: 0o700 });
  chmodSync(paths.archiveDir, 0o700);
  mkdirSync(dir, { mode: 0o700 });
  try {
    const databases = withPanel(paths, (db) => db.query<{ name: string; user_name: string | null; password: string | null; permissions: string | null }, [number]>(`
      SELECT d.name, u.user_name, u.password, u.permissions FROM database d LEFT JOIN database_user u ON u.database_id = d.id
       WHERE d.site_id = ? ORDER BY d.id, u.id`).all(site.id));
    const credentials = databases.some((row) => row.user_name) ? master(paths) : null;
    const byName = new Map<string, ArchiveMeta["databases"][number]>();
    for (const row of databases) {
      const entry = byName.get(row.name) ?? { name: row.name, users: [] };
      byName.set(row.name, entry);
      if (row.user_name && credentials) {
        entry.users.push({ name: row.user_name, permissions: row.permissions ?? "", panelPassword: row.password ?? "", logins: mysqlLogins(credentials, row.user_name) });
      }
    }
    for (const database of byName.values()) {
      step(`Exporting the database ${database.name}`);
      const file = join(dir, `db-${database.name}.sql.gz`);
      clpctl(paths, ["db:export", `--databaseName=${database.name}`, `--file=${file}`], `The database ${database.name} could not be exported`);
      chmodSync(file, 0o600);
      if (!runCommand("gzip", ["-t", file]).ok) throw new Error(`The export of ${database.name} cannot be read back`);
    }
    step("Packing the site's files");
    const home = join(paths.homeRoot, site.user);
    const files = join(dir, "home.tar.gz");
    const packed = runCommand("tar", ["-C", home, "-czf", files, "."], 3 * 3600_000);
    // Exit 1 is a file that changed while it was read, which a live site's logs do.
    if (!packed.ok && packed.exitCode !== 1) throw new Error(`The files could not be packed: ${packed.stderr.trim().split("\n").pop() ?? ""}`);
    chmodSync(files, 0o600);
    if (!runCommand("tar", ["-tzf", files], 3 * 3600_000).ok) throw new Error("The packed files cannot be read back");

    const extras = withPanel(paths, (db) => ({
      ssh: db.query<{ user_name: string }, [number]>("SELECT user_name FROM ssh_user WHERE site_id = ?").all(site.id).map((row) => row.user_name),
      ftp: db.query<{ user_name: string }, [number]>("SELECT user_name FROM ftp_user WHERE site_id = ?").all(site.id).map((row) => row.user_name),
      cron: db.query<{ line: string }, [number]>("SELECT minute || ' ' || hour || ' ' || day || ' ' || month || ' ' || weekday || ' ' || command AS line FROM cron_job WHERE site_id = ?")
        .all(site.id).map((row) => row.line),
    }));
    const meta: ArchiveMeta = {
      version: 1, id, domain, archivedAt: new Date().toISOString(), type: site.type, application: site.application ?? "",
      siteUser: site.user, rootDirectory: site.root_directory ?? domain, vhost: site.vhost_template ?? "",
      phpVersion: site.php_version ?? "", nodejsVersion: site.nodejs_version ?? "", pythonVersion: site.python_version ?? "",
      appPort: site.nodejs_port ?? site.python_port ?? null, reverseProxyUrl: site.reverse_proxy_url ?? "",
      databases: [...byName.values()], sshUsers: extras.ssh, ftpUsers: extras.ftp, cronJobs: extras.cron,
      bytes: directorySize(dir), redirect: null,
    };
    writeMeta(paths, meta);

    step(`Deleting ${domain} from CloudPanel`);
    clpctl(paths, ["site:delete", `--domainName=${domain}`, "--force"], `CloudPanel did not delete ${domain}`);
    const left = withPanel(paths, (db) => db.query<{ name: string }, []>("SELECT name FROM database").all().map((row) => row.name));
    for (const database of byName.keys()) {
      if (left.includes(database)) clpctl(paths, ["db:delete", `--databaseName=${database}`, "--force"], `CloudPanel kept the database ${database}`);
    }
    return meta;
  } catch (error) {
    // Nothing was deleted unless the archive was complete, so an incomplete one is only clutter.
    if (siteExists(paths, domain)) rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

const RESTORE_TYPES: Record<string, (meta: ArchiveMeta) => string[]> = {
  php: (meta) => ["site:add:php", `--phpVersion=${meta.phpVersion}`, `--vhostTemplate=${meta.application || "Generic"}`],
  static: () => ["site:add:static"],
  nodejs: (meta) => ["site:add:nodejs", `--nodejsVersion=${meta.nodejsVersion}`, `--appPort=${meta.appPort}`],
  python: (meta) => ["site:add:python", `--pythonVersion=${meta.pythonVersion}`, `--appPort=${meta.appPort}`],
  "reverse-proxy": (meta) => ["site:add:reverse-proxy", `--reverseProxyUrl=${meta.reverseProxyUrl}`],
};

/** The site created again, its files and databases put back; what could not be is said, not guessed. */
export async function restoreArchive(paths: ArchivePaths, id: string, step: (text: string) => void, isRedirect: (domain: string) => Promise<boolean>): Promise<string[]> {
  const meta = readMeta(paths, id);
  const dir = archivePath(paths, id);
  const notes: string[] = [];
  if (siteExists(paths, meta.domain)) throw new Error(`CloudPanel already has a site ${meta.domain}`);
  if (await isRedirect(meta.domain)) throw new Error(`${meta.domain} is a redirect domain; delete the redirect on the DNS page first`);
  const command = RESTORE_TYPES[meta.type];
  if (!command) throw new Error(`a ${meta.type} site cannot be created again here`);

  step(`Creating ${meta.domain}`);
  const taken = withPanel(paths, (db) => db.query<{ user: string }, []>("SELECT user FROM site").all().some((row) => row.user === meta.siteUser));
  if (taken || runCommand("id", ["-u", meta.siteUser]).ok) throw new Error(`the site user ${meta.siteUser} is taken by another site`);
  const create = (template: string[]) => runCommand(paths.clpctl, [...template, `--domainName=${meta.domain}`, `--siteUser=${meta.siteUser}`,
    `--siteUserPassword=${randomBytes(24).toString("base64url")}`], 600_000);
  let created = create(command(meta));
  if (!created.ok && meta.type === "php" && meta.application) {
    created = create(RESTORE_TYPES.php!({ ...meta, application: "" }));
    notes.push(`CloudPanel has no ${meta.application} vhost template now, so it was created as a generic PHP site`);
  }
  if (!created.ok) throw new Error(`CloudPanel did not create ${meta.domain}: ${(created.stderr || created.stdout).trim().split("\n").pop() ?? ""}`);
  notes.push("The site user has a new password; set one under the site's Settings if you sign in as it");

  step("Putting the files back");
  const home = join(paths.homeRoot, meta.siteUser);
  const unpack = Bun.spawnSync(["runuser", "-u", meta.siteUser, "--", "tar", "-xzf", "-", "-C", home, "--no-same-owner"], {
    stdin: Bun.file(join(dir, "home.tar.gz")), stdout: "ignore", stderr: "pipe", timeout: 3 * 3600_000,
  });
  if (!unpack.success) throw new Error(`The files could not be put back: ${unpack.stderr.toString().trim().split("\n").pop() ?? ""}`);

  const credentials = meta.databases.some((database) => database.users.length) ? master(paths) : null;
  for (const database of meta.databases) {
    step(`Importing the database ${database.name}`);
    const [first, ...others] = database.users;
    clpctl(paths, ["db:add", `--domainName=${meta.domain}`, `--databaseName=${database.name}`, `--databaseUserName=${first?.name ?? database.name}`,
      `--databaseUserPassword=${randomBytes(24).toString("base64url")}`], `The database ${database.name} could not be created`);
    clpctl(paths, ["db:import", `--databaseName=${database.name}`, `--file=${join(dir, `db-${database.name}.sql.gz`)}`], `The database ${database.name} could not be imported`);
    if (first && credentials) {
      try {
        for (const login of first.logins) restoreLogin(credentials, first.name, login);
        if (first.panelPassword) panelWrite(paths, `UPDATE database_user SET password = ${sqlString(first.panelPassword)} WHERE user_name = ${sqlString(first.name)};`);
      } catch (error) {
        notes.push(`${first.name} has a new password, shown under the site's Databases, because the old one could not be set again: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const user of others) notes.push(`The database user ${user.name} of ${database.name} was not added back; add it under the site's Databases`);
  }

  if (meta.vhost) {
    step("Setting the vhost");
    try {
      replaceSiteVhost({ panelDb: paths.panelDb, sqlite3: paths.sqlite3, nginxVhostDir: paths.nginxVhostDir, tempDir: paths.tempDir },
        meta.domain, meta.vhost, meta.rootDirectory !== meta.domain ? meta.rootDirectory : undefined);
    } catch (error) {
      notes.push(`The archived vhost was not set, so the site has CloudPanel's default: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (meta.sshUsers.length) notes.push(`Add the SSH users again: ${meta.sshUsers.join(", ")}`);
  if (meta.ftpUsers.length) notes.push(`Add the FTP users again: ${meta.ftpUsers.join(", ")}`);
  if (meta.cronJobs.length) notes.push(`Add the cron jobs again: ${meta.cronJobs.join("; ")}`);
  writeMeta(paths, { ...meta, restoredAt: new Date().toISOString() });
  return notes.map((note) => `${meta.domain}: ${note}`);
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

const TASKS = ["archive", "restore", "delete"] as const;

function jobView(paths: ArchivePaths, id: string): ArchiveJobView | null {
  const dir = jobDir(paths.jobsDir, id);
  const task = TASKS.find((known) => known === jobGet(dir, "task"));
  if (!task) return null;
  const common = jobCommonFields(dir);
  return {
    id, task, targets: jobGet(dir, "targets", 512 * 1024).split(",").filter(Boolean),
    state: common.state, step: common.step, error: common.error, ...jobSiteProgress(dir),
    result: readJobResult<ArchiveJobResult>(dir),
  };
}

function jobs(paths: ArchivePaths): ArchiveJobView[] {
  return listJobIds(paths.jobsDir).flatMap((id) => {
    const view = jobView(paths, id);
    return view ? [view] : [];
  });
}

function activeJob(paths: ArchivePaths): ArchiveJobView | null {
  return jobs(paths).find((job) => job.state === "queued" || job.state === "running") ?? null;
}

function dnsEnabled(paths: ArchivePaths): boolean {
  return existsSync(paths.dnsConfig);
}

export function archiveState(paths: ArchivePaths): ArchiveState {
  const standIns = standInDomains(paths.standIns, paths.rootUid);
  const sites = withPanel(paths, (db) => db.query<{ domain_name: string; type: string; application: string | null; databases: number }, []>(`
    SELECT s.domain_name, s.type, s.application, (SELECT COUNT(*) FROM database d WHERE d.site_id = s.id) AS databases
      FROM site s ORDER BY s.domain_name`).all())
    .filter((site) => !standIns.has(site.domain_name))
    .map((site) => ({
      domain: site.domain_name, type: site.type, application: site.application ?? "", databases: Number(site.databases),
      blocked: blockedReason(paths, site.domain_name, standIns),
    }));
  const all = jobs(paths);
  return {
    sites,
    archives: archives(paths).map(({ vhost: _vhost, databases, ...meta }) => ({ ...meta, databases: databases.map((database) => database.name) })),
    dns: dnsEnabled(paths),
    job: all.find((job) => job.state === "queued" || job.state === "running") ?? null,
    lastJob: all.filter((job) => job.state === "done" || job.state === "failed").at(-1) ?? null,
  };
}

function parseRedirectChoice(value: unknown): RedirectChoice | null {
  if (value == null || value === "") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.target !== "string" || !raw.target.trim()) failAction("Enter the URL to redirect to");
  return { target: raw.target.trim(), status: Number(raw.status ?? 301), keepPath: raw.keepPath !== false, keepQuery: raw.keepQuery !== false };
}

async function defaultDns(verb: string, body: unknown): Promise<unknown> {
  const { executeDnsAction } = await import("../dns/action");
  return executeDnsAction([verb], { input: JSON.stringify(body) });
}

async function runJob(paths: ArchivePaths, id: string, options: ArchiveOptions): Promise<void> {
  const view = jobView(paths, id);
  if (!view) failAction(`no such job: ${id}`);
  const dir = jobDir(paths.jobsDir, id);
  const redirect = view.task === "archive" ? parseRedirectChoice(JSON.parse(jobGet(dir, "redirect") || "null")) : null;
  const dns = options.dns ?? defaultDns;
  const verb = { archive: "Archiving", restore: "Restoring", delete: "Deleting" }[view.task];
  await runSiteJob(dir, verb, async (onProgress, wait) => {
    const result: ArchiveJobResult = { done: [], failed: [], notes: [] };
    for (const [index, target] of view.targets.entries()) {
      onProgress({ completed: index, total: view.targets.length, site: target });
      try {
        if (view.task === "delete") {
          rmSync(archivePath(paths, readMeta(paths, target).id), { recursive: true, force: true });
        } else if (view.task === "restore") {
          result.notes.push(...await restoreArchive(paths, target, wait, async (domain) => {
            if (!dnsEnabled(paths)) return false;
            const state = await dns("list", {}) as { sites: { domain: string; redirect?: unknown }[] };
            return state.sites.some((site) => site.domain === domain && site.redirect);
          }));
        } else {
          const meta = await archiveSite(paths, target, wait);
          if (redirect && dnsEnabled(paths)) {
            wait(`Making ${target} a redirect`);
            try {
              const made = await dns("archive-redirect", { source: target, ...redirect }) as { applied: boolean; reason: string };
              meta.redirect = { target: redirect.target, applied: made.applied, reason: made.reason };
              if (!made.applied) result.notes.push(`${target}: the redirect waits: ${made.reason}`);
            } catch (error) {
              meta.redirect = { target: redirect.target, applied: false, reason: error instanceof Error ? error.message : String(error) };
              result.notes.push(`${target} was archived, but DNS did not make it a redirect: ${meta.redirect.reason}`);
            }
            writeMeta(paths, meta);
          }
        }
        result.done.push(target);
      } catch (error) {
        result.failed.push({ target, error: error instanceof Error ? error.message : String(error) });
      }
    }
    const name = (target: string) => target.replace(/--\d{8}T\d{6}Z$/, "");
    if (result.failed.length && !result.done.length) throw new Error(result.failed.map((entry) => `${name(entry.target)}: ${entry.error}`).join("; "));
    return result;
  });
}

// ---------------------------------------------------------------------------
// Verbs
// ---------------------------------------------------------------------------

async function bodyOf(options: ArchiveOptions): Promise<Record<string, unknown>> {
  const raw = options.input ?? await Bun.stdin.text();
  if (Buffer.byteLength(raw) > MAX_BODY) failAction("the request is too large");
  try {
    const value = JSON.parse(raw);
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // Answered below.
  }
  failAction("the request must be a JSON object");
}

function queue(paths: ArchivePaths, options: ArchiveOptions, task: ArchiveJobView["task"], targets: string[], fields: Record<string, string> = {}): ArchiveJobView {
  if (!targets.length) failAction(task === "archive" ? "Select at least one site" : "Choose an archive");
  const running = activeJob(paths);
  if (running) failAction(`Wait for the ${running.task} job to finish`);
  mkdirSync(paths.jobsDir, { recursive: true, mode: 0o700 });
  const id = queueJob({
    addon: "archive", jobsDir: paths.jobsDir, fields: { task, targets: targets.join(","), ...fields },
    description: `clp-addons: Archive Sites ${task}`, actionBinary: CLI_BIN, runtimeSeconds: JOB_RUNTIME_SECONDS, start: options.start,
  });
  return jobView(paths, id)!;
}

export async function executeArchiveAction(argv: string[], options: ArchiveOptions = {}): Promise<unknown> {
  if ((options.processUid ?? process.getuid?.()) !== 0) failAction("Archive Sites actions must run as root");
  const [rawVerb, ...args] = argv;
  const verb = VERBS.find((candidate) => candidate === rawVerb);
  if (!verb) failAction(`usage: clp-addons action archive {${VERBS.join("|")}}`);
  const paths = { ...DEFAULT_ARCHIVE_PATHS, ...options.paths };
  if (verb === "list") return archiveState(paths);
  if (verb === "run" || verb === "job") {
    const id = jobIdArgument(args);
    if (verb === "run") return runJob(paths, id, options);
    const view = jobView(paths, id);
    if (!view) failAction(`no such job: ${id}`);
    return { job: view, log: readJobLog(jobDir(paths.jobsDir, id)) };
  }
  if (verb === "watch-job") failAction("watch-job is a stream; the gateway runs it");
  const body = await bodyOf(options);
  mkdirSync(join(paths.lockFile, ".."), { recursive: true, mode: 0o700 });
  return withFileLock(paths.lockFile, 30, "Archive Sites is busy; try again in a moment", async () => {
    if (verb === "archive") {
      if (!Array.isArray(body.domains)) failAction("Select at least one site");
      const domains = body.domains.map((domain) => {
        const valid = validateDomain(domain);
        if (!valid || !siteExists(paths, valid)) failAction(`CloudPanel has no site ${String(domain)}`);
        const blocked = blockedReason(paths, valid, standInDomains(paths.standIns, paths.rootUid));
        if (blocked) failAction(`${valid}: ${blocked}`);
        return valid;
      });
      const redirect = parseRedirectChoice(body.redirect);
      if (redirect && !dnsEnabled(paths)) failAction("Enable DNS to make an archived site a redirect");
      return { job: queue(paths, options, "archive", domains, { redirect: JSON.stringify(redirect) }) };
    }
    const id = typeof body.id === "string" ? body.id : "";
    readMeta(paths, id);
    return { job: queue(paths, options, verb, [id]) };
  });
}

export async function runArchiveAction(argv: string[], options: ArchiveOptions = {}): Promise<number> {
  const emit = options.emitReply !== false;
  try {
    if (argv[0] === "watch-job") {
      if ((options.processUid ?? process.getuid?.()) !== 0) failAction("Archive Sites actions must run as root");
      const paths = { ...DEFAULT_ARCHIVE_PATHS, ...options.paths };
      const id = jobIdArgument(argv.slice(1));
      if (!jobView(paths, id)) failAction(`no such job: ${id}`);
      const dir = jobDir(paths.jobsDir, id);
      await watchJobRecord({ dir, read: () => ({ job: jobView(paths, id), log: readJobLog(dir) }), emit: (data) => { if (emit) emitActionOk(data); } });
      return 0;
    }
    const data = await executeArchiveAction(argv, options);
    if (emit) emitActionOk(data ?? {});
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (emit) emitActionError(message, error instanceof ActionFailure ? error.data : undefined, "archive");
    else process.stderr.write(`[archive] ERROR: ${message}\n`);
    return 1;
  }
}

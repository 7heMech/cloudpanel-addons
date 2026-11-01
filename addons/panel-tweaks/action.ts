/**
 * The privileged half of Panel Tweaks: what the panel's own pages cannot ask
 * for themselves.
 *
 * The site-list tweaks would need no root if CloudPanel's Sites template
 * carried the values. It does not: the certificate, the runtime version and the
 * application are columns of a database the web manager cannot open, so the
 * site list is assembled here and sent as data the injected script paints.
 *
 * A disk measurement walks every site's home directory, which only root can
 * read across accounts. The page starts one as a background job with a fixed
 * shape, and it accepts no path. Automatic SSL submits CloudPanel's own certificate form from the
 * browser; here it is only a switch.
 */
import { Database } from "bun:sqlite";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ActionFailure, acquireFileLock, emitActionError, emitActionOk, failAction, runCommand, withFileLock,
  type CommandResult, type FileLockHandle,
} from "../../cli/action-common";
import {
  jobCommonFields, jobDir, jobIdArgument, jobSiteProgress, listJobIds, pruneJobs, queueJob, readJobLog,
  readJobResult, runSiteJob, watchJobRecord, type JobCommonFields, type JobSiteProgress, type startJobUnit,
} from "../../cli/job-store";
import { CLI_BIN, PANEL_DB, STATE_DIR } from "../../cli/paths";
import { standInDomains } from "../../cli/stand-ins";
import { writeFileAtomic } from "../../lib/atomic-write";
import { certificateIssuer, issuerLabel } from "../../lib/certificate-issuer";
import { PANEL_USER_NAME_RE, panelUserSites } from "../../lib/panel-users";

const TWEAKS_VERSION = 1;
const DISK_VERSION = 1;
const DISK_SCAN_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** A measurement's unit is stopped after this long, waiting for a scheduled sweep included. */
const MEASURE_RUNTIME_SECONDS = 3 * 60 * 60;
/** How long a measurement waits for a scheduled sweep that holds the disk lock. */
const MEASURE_LOCK_WAIT_SECONDS = 60 * 60;
const JOB_RETENTION_DAYS = 7;

/** `scan` is the repair timer's sweep; the page starts a `measure` job instead. */
export type PanelTweaksVerb = "state" | "set-tweaks" | "scan" | "measure";

/**
 * What the addon does, as independent modes.
 *
 * Separate rather than one switch because they do not cost the same: most are
 * markup, and `diskUsage` periodically walks the whole disk. An
 * operator who wants a filtered site list should not have to accept that. The
 * four narrow-screen and layout tweaks are separate for a different reason:
 * they change the shape of pages CloudPanel drew itself, and an operator who
 * likes the panel's own shape should be able to keep it.
 */
export interface PanelTweaks {
  /** Follow the device's light or dark preference on the panel's login page. */
  deviceTheme: boolean;
  /** Count, search, type filter, sorting, the extra columns and their picker. */
  sitesTable: boolean;
  /** One card per site on a narrow screen instead of a table that scrolls. */
  sitesMobile: boolean;
  /** The Sites table's action links, collected into a menu on each row. */
  actionMenu: boolean;
  /** CloudPanel's own header and dashboard, made to fit a narrow screen. */
  panelMobile: boolean;
  /** The measured-size column, and the sweep that fills it. */
  diskUsage: boolean;
  /** Offer a Let's Encrypt certificate after creating any native site. */
  autoSsl: boolean;
}

export const DEFAULT_TWEAKS: PanelTweaks = {
  deviceTheme: true,
  sitesTable: true,
  sitesMobile: true,
  actionMenu: true,
  panelMobile: true,
  // Off until asked for: it is the only tweak that reads the whole disk.
  diskUsage: false,
  autoSsl: false,
};

/**
 * The switches whose answer is baked into CloudPanel's own templates.
 *
 * The site-table and disk switches are read at request time. The login page
 * has no session to ask with, the layout switches decide the first paint, and
 * autoSsl decides whether the creation and completion scripts are present.
 */
export const TEMPLATE_TWEAK_KEYS: (keyof PanelTweaks)[] =
  ["deviceTheme", "sitesMobile", "actionMenu", "panelMobile", "autoSsl"];

export const TWEAK_KEYS = Object.keys(DEFAULT_TWEAKS) as (keyof PanelTweaks)[];

/**
 * The switches that mean nothing on their own.
 *
 * Measured sizes are a column of the enhanced Sites table, so they are turned
 * off with it rather than left on measuring a disk for a column no page draws.
 */
export const TWEAK_PARENTS: Partial<Record<keyof PanelTweaks, keyof PanelTweaks>> = {
  diskUsage: "sitesTable",
};

/** A switch whose parent is off is off, whichever of the two was just named. */
export function withTweakDependencies(tweaks: PanelTweaks): PanelTweaks {
  const settled = { ...tweaks };
  for (const [key, parent] of Object.entries(TWEAK_PARENTS) as [keyof PanelTweaks, keyof PanelTweaks][]) {
    if (!settled[parent]) settled[key] = false;
  }
  return settled;
}

/**
 * How CloudPanel's certificate types read to an operator.
 *
 * The column holds a number, not a name: these are `App\Entity\Certificate`'s
 * TYPE_SELF_SIGNED, TYPE_LETS_ENCRYPT and TYPE_IMPORTED, and the wording is the
 * panel's own from its certificates page. Shared with the script injected into
 * the Sites page, which is handed this object rather than a copy of it. A type
 * this does not know is printed as CloudPanel recorded it.
 */
export const CERTIFICATE_LABELS: Record<string, string> = {
  "1": "Self-Signed",
  "2": "Let's Encrypt",
  "3": "Imported",
};

/**
 * What a certificate type is called in a phone's card, where the badge is half
 * a card wide and the full name and the countdown together overrun it.
 *
 * Only a timed certificate is ever shortened. A type without an entry here
 * keeps the countdown alone rather than an abbreviation nobody would
 * recognise; the full name stays in the title and for screen readers.
 */
export const CERTIFICATE_SHORT_LABELS: Record<string, string> = {
  "2": "Let's Enc",
  "3": "Imported",
};

/**
 * The certificate CloudPanel puts on every new site. It is a certificate, but
 * it is not one a browser accepts, so it is never reported as a site being
 * covered -- only as the placeholder it is.
 */
export const SELF_SIGNED_CERTIFICATE = "1";

/**
 * The type CloudPanel gives a certificate an operator uploaded.
 *
 * The panel has one word for all of them, so this is the only type whose
 * issuer is read: a Cloudflare origin certificate and a public authority's are
 * both "imported" to it, and they are not the same thing to an operator.
 */
export const IMPORTED_CERTIFICATE = "3";

/**
 * The awkward spellings in CloudPanel's `application` column.
 *
 * For a PHP site the column holds the vhost template the site was created from,
 * which is an open set an operator can add to, so this renames the two the
 * panel ships run together rather than trying to know every name.
 */
export const APPLICATION_LABELS: Record<string, string> = {
  ReverseProxy: "Reverse Proxy",
  Nodejs: "Node.js",
};

export function applicationLabel(application: string, type: string): string {
  const name = application.trim();
  if (!name) return type.trim();
  return APPLICATION_LABELS[name] ?? name;
}

export function certificateLabel(type: string): string {
  return CERTIFICATE_LABELS[type.trim()] ?? (type.trim() || "Certificate");
}

/** What one site contributes to the enhanced Sites table. */
export interface TweakSiteView {
  domain: string;
  user: string;
  /** CloudPanel's own site type: php, static, reverse-proxy, nodejs, python. */
  type: string;
  /** The application CloudPanel recorded, such as WordPress. May be empty. */
  application: string;
  /** "PHP 8.2", "Node.js 20", "Python 3.11", or "" for a site with no runtime. */
  runtime: string;
  /** When CloudPanel created the site, as it recorded it. */
  createdAt: string;
  /** The panel's own per-site switches, for the columns that report them. */
  cloudflareOnly: boolean;
  varnish: boolean;
  certificate: {
    type: string;
    expiresAt: string;
    /** Who issued an imported certificate; absent when the panel's own name stands. */
    issuer?: string;
  } | null;
  /** Bytes under the site's home, and under its databases, when measured. */
  disk: { bytes: number; databaseBytes: number; measuredAt: string } | null;
}

export interface PanelTweaksState {
  tweaks: PanelTweaks;
  sites: TweakSiteView[];
  /** When the disk sweep last completed; "" when it never has. */
  diskMeasuredAt: string;
  /** The measurement an operator started and the page follows; an administrator's state only. */
  measuring: MeasureJobView | null;
}

export interface ScanResult {
  measured: number;
  skipped: number;
  measuredAt: string;
}

/** A measurement an operator started, as the page follows it. */
export interface MeasureJobView extends JobCommonFields, JobSiteProgress {
  id: string;
  result: ScanResult | null;
}

export interface PanelTweaksActionPaths {
  panelDb: string;
  tweaksFile: string;
  diskFile: string;
  lockFile: string;
  /** Held for a whole disk measurement, so switches still change meanwhile. */
  scanLockFile: string;
  jobsDir: string;
  /** Held while a measurement is recorded, so there is never a second. */
  jobsLockFile: string;
  /** What systemd runs for a measurement. */
  actionBinary: string;
  /** Where MySQL keeps one directory per database, when the box has MySQL. */
  mysqlDir: string;
  passwd: string;
  rootUid: number;
}

export interface PanelTweaksActionOptions {
  paths?: Partial<PanelTweaksActionPaths>;
  input?: string;
  emitReply?: boolean;
  processUid?: number;
  run?: (command: string, args: string[]) => CommandResult;
  now?: () => Date;
  onProgress?: (progress: JobSiteProgress) => void;
  /** Test-only; production hands a measurement to systemd. */
  startJob?: typeof startJobUnit;
}

export const DEFAULT_PANEL_TWEAKS_PATHS: PanelTweaksActionPaths = {
  panelDb: PANEL_DB,
  tweaksFile: `${STATE_DIR}/panel-tweaks/tweaks.json`,
  diskFile: `${STATE_DIR}/panel-tweaks/disk-usage.json`,
  lockFile: "/run/lock/clp-addons/panel-tweaks.lock",
  scanLockFile: "/run/lock/clp-addons/panel-tweaks-scan.lock",
  jobsDir: `${STATE_DIR}/panel-tweaks/jobs`,
  jobsLockFile: "/run/lock/clp-addons/panel-tweaks-jobs.lock",
  actionBinary: CLI_BIN,
  mysqlDir: "/var/lib/mysql",
  passwd: "/etc/passwd",
  rootUid: 0,
};

function pathsFor(options: PanelTweaksActionOptions): PanelTweaksActionPaths {
  return { ...DEFAULT_PANEL_TWEAKS_PATHS, ...options.paths };
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nowIso(options: PanelTweaksActionOptions): string {
  return (options.now?.() ?? new Date()).toISOString();
}

// --- stored state ---------------------------------------------------------

function trustedFile(path: string, expectedUid: number): boolean {
  const stat = lstatSync(path);
  return stat.isFile() && !stat.isSymbolicLink() && stat.uid === expectedUid && (stat.mode & 0o022) === 0;
}

function readJsonFile(path: string, expectedUid: number, what: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    if (!trustedFile(path, expectedUid)) failAction(`the ${what} file is not a trusted regular file`);
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ActionFailure) throw error;
    // A half-written or hand-edited file reads as absent rather than failing
    // every page that wants the site list: both files are a cache of decisions
    // the operator can make again.
    return null;
  }
}

export function readTweaks(paths: PanelTweaksActionPaths): PanelTweaks {
  const stored = readJsonFile(paths.tweaksFile, paths.rootUid, "panel tweaks");
  const tweaks = { ...DEFAULT_TWEAKS };
  if (stored?.version !== TWEAKS_VERSION) return tweaks;
  for (const key of TWEAK_KEYS) if (typeof stored[key] === "boolean") tweaks[key] = stored[key];
  return withTweakDependencies(tweaks);
}

function writeTweaks(paths: PanelTweaksActionPaths, tweaks: PanelTweaks): void {
  const body: Record<string, unknown> = { version: TWEAKS_VERSION };
  for (const key of TWEAK_KEYS) body[key] = tweaks[key];
  writeFileAtomic(paths.tweaksFile, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600, createParent: true });
}

interface DiskCacheEntry {
  bytes: number;
  databaseBytes: number;
  measuredAt: string;
}

interface DiskCache {
  measuredAt: string;
  /** Sites the sweep could not measure, for a measurement that waited on it to report. */
  skipped: number;
  sites: Record<string, DiskCacheEntry>;
}

function readDiskCache(paths: PanelTweaksActionPaths): DiskCache {
  const empty: DiskCache = { measuredAt: "", skipped: 0, sites: {} };
  const stored = readJsonFile(paths.diskFile, paths.rootUid, "disk usage");
  if (stored?.version !== DISK_VERSION || typeof stored.sites !== "object" || stored.sites === null) return empty;
  const sites: Record<string, DiskCacheEntry> = {};
  for (const [domain, value] of Object.entries(stored.sites as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const entry = value as Partial<DiskCacheEntry>;
    if (!Number.isFinite(entry.bytes) || typeof entry.measuredAt !== "string") continue;
    sites[domain] = {
      bytes: Number(entry.bytes),
      databaseBytes: Number.isFinite(entry.databaseBytes) ? Number(entry.databaseBytes) : 0,
      measuredAt: entry.measuredAt,
    };
  }
  return {
    measuredAt: typeof stored.measuredAt === "string" ? stored.measuredAt : "",
    skipped: Number.isSafeInteger(stored.skipped) && Number(stored.skipped) >= 0 ? Number(stored.skipped) : 0,
    sites,
  };
}

function writeDiskCache(paths: PanelTweaksActionPaths, cache: DiskCache): void {
  writeFileAtomic(
    paths.diskFile,
    `${JSON.stringify({ version: DISK_VERSION, ...cache }, null, 2)}\n`,
    { mode: 0o600, createParent: true },
  );
}

// --- panel database -------------------------------------------------------

interface PanelSiteRow {
  domain_name: string;
  user: string;
  type: string;
  created_at: string | null;
  allow_traffic_from_cloudflare_only: number | null;
  varnish_cache: number | null;
  application: string | null;
  root_directory: string | null;
  php_version: string | null;
  nodejs_version: string | null;
  python_version: string | null;
  certificate_type: string | null;
  certificate_expires_at: string | null;
  certificate_pem: string | null;
}

function openPanelDatabase(path: string): Database {
  try {
    const db = new Database(path, { readonly: true });
    db.exec("PRAGMA busy_timeout = 5000;");
    return db;
  } catch (error) {
    failAction(`CloudPanel database could not be opened: ${reason(error)}`);
  }
}

/**
 * One query for everything the Sites table shows.
 *
 * The runtime tables and the certificate table arrived at different CloudPanel
 * versions, and SQLite refuses to prepare a statement that names a table the
 * database does not have -- an outer join is not enough. So the joins a build
 * can support are asked for and the rest are selected as NULL: a panel without
 * `python_settings` reports no Python runtime rather than failing the list.
 * `site.certificate_id` rather than the newest certificate row, because that
 * column is the certificate the panel is actually serving.
 */
const OPTIONAL_JOINS = [
  { table: "php_settings", alias: "p", select: "php_version", on: "p.site_id = s.id" },
  { table: "nodejs_settings", alias: "n", select: "nodejs_version", on: "n.site_id = s.id" },
  { table: "python_settings", alias: "y", select: "python_version", on: "y.site_id = s.id" },
  // The certificate itself is read for its issuer, and is asked for only where
  // the column is there: a table can predate one of its columns as easily as a
  // database can predate a table.
  { table: "certificate", alias: "c",
    select: "type AS certificate_type, c.expires_at AS certificate_expires_at",
    absent: "NULL AS certificate_type, NULL AS certificate_expires_at",
    optionalColumns: [{ column: "certificate", as: "certificate_pem" }],
    on: "c.id = s.certificate_id" },
];

/**
 * Columns of `site` a column of the table reports, and which the oldest
 * CloudPanel a box may be running might not have. Named the same way the joins
 * are: what is there is selected, what is not is selected as NULL, because one
 * missing column would otherwise cost the whole site list.
 */
const OPTIONAL_SITE_COLUMNS = ["created_at", "allow_traffic_from_cloudflare_only", "varnish_cache"];

function presentColumns(db: Database, table: string): Set<string> {
  try {
    const rows = db.query<{ name: string }, []>(`PRAGMA table_info(${table});`).all();
    return new Set(rows.map((row) => row.name));
  } catch {
    return new Set();
  }
}

function presentTables(db: Database): Set<string> {
  try {
    const rows = db.query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE type IN ('table', 'view');`,
    ).all();
    return new Set(rows.map((row) => row.name));
  } catch {
    return new Set();
  }
}

function siteQuery(db: Database): string {
  const present = presentTables(db);
  const columns: string[] = [];
  const joins: string[] = [];
  for (const join of OPTIONAL_JOINS) {
    const here = present.has(join.table);
    if (here) {
      columns.push(`${join.alias}.${join.select}`);
      joins.push(`LEFT JOIN ${join.table} ${join.alias} ON ${join.on}`);
    } else {
      columns.push(join.absent ?? `NULL AS ${join.select}`);
    }
    const columnsHere = here ? presentColumns(db, join.table) : new Set<string>();
    for (const extra of join.optionalColumns ?? []) {
      columns.push(columnsHere.has(extra.column)
        ? `${join.alias}.${extra.column} AS ${extra.as}`
        : `NULL AS ${extra.as}`);
    }
  }
  const siteColumns = presentColumns(db, "site");
  const optional = OPTIONAL_SITE_COLUMNS.map((column) =>
    siteColumns.has(column) ? `s.${column}` : `NULL AS ${column}`);
  return `
  SELECT s.domain_name, s.user, s.type, s.application, s.root_directory,
         ${optional.join(", ")},
         ${columns.join(",\n         ")}
  FROM site s
  ${joins.join("\n  ")}
  ORDER BY s.domain_name;
`;
}

function panelSites(db: Database): PanelSiteRow[] {
  try {
    return db.query<PanelSiteRow, []>(siteQuery(db)).all();
  } catch (error) {
    failAction(`CloudPanel site list could not be read: ${reason(error)}`);
  }
}

function siteDatabases(db: Database): Map<string, string[]> {
  const names = new Map<string, string[]>();
  try {
    for (const row of db.query<{ domain_name: string; name: string }, []>(
      `SELECT s.domain_name, d."name" FROM "database" d JOIN site s ON s.id = d.site_id;`,
    ).all()) {
      const list = names.get(row.domain_name) ?? [];
      list.push(row.name);
      names.set(row.domain_name, list);
    }
  } catch {
    // A panel build without the table contributes no database sizes.
  }
  return names;
}

function runtimeOf(row: PanelSiteRow): string {
  if (row.php_version) return `PHP ${row.php_version}`;
  if (row.nodejs_version) return `Node.js ${row.nodejs_version}`;
  if (row.python_version) return `Python ${row.python_version}`;
  return "";
}

/**
 * What an imported certificate says about itself.
 *
 * Only an imported one is read: a self-signed certificate names the site it
 * was made for, and a Let's Encrypt certificate names whichever intermediate
 * signed it that month, so in both cases the panel's own word is the better
 * one. A certificate that cannot be parsed keeps it too.
 */
function issuerNames(row: PanelSiteRow): { issuer?: string } {
  if (row.certificate_type !== IMPORTED_CERTIFICATE || !row.certificate_pem) return {};
  const name = issuerLabel(certificateIssuer(row.certificate_pem));
  return name ? { issuer: name } : {};
}

function siteViews(rows: PanelSiteRow[], cache: DiskCache): TweakSiteView[] {
  // DNS's stand-ins are static sites that only serve a redirect.
  const standIns = standInDomains();
  return rows.map((row) => ({
    domain: row.domain_name,
    user: row.user,
    type: row.type,
    application: row.application ?? "",
    runtime: standIns.has(row.domain_name) ? "Redirect" : runtimeOf(row),
    createdAt: row.created_at ?? "",
    cloudflareOnly: Boolean(row.allow_traffic_from_cloudflare_only),
    varnish: Boolean(row.varnish_cache),
    certificate: row.certificate_type
      ? {
          type: row.certificate_type,
          expiresAt: row.certificate_expires_at ?? "",
          ...issuerNames(row),
        }
      : null,
    disk: cache.sites[row.domain_name] ?? null,
  }));
}

/**
 * The state the injected script is answered with.
 *
 * `asUser` narrows the site list to what CloudPanel would list for that panel
 * user, and is how a session without ROLE_ADMIN is served: the switches are the
 * box owner's and the same for everyone, but the rows are the reader's own. An
 * administrator's request carries no name and sees every site.
 */
function stateOf(paths: PanelTweaksActionPaths, asUser = ""): PanelTweaksState {
  const db = openPanelDatabase(paths.panelDb);
  try {
    const cache = readDiskCache(paths);
    let rows = panelSites(db);
    if (asUser) {
      const visible = panelUserSites(db, asUser);
      rows = visible === "all" ? rows : rows.filter((row) => visible?.has(row.domain_name) ?? false);
    }
    return {
      tweaks: readTweaks(paths),
      sites: siteViews(rows, cache),
      diskMeasuredAt: cache.measuredAt,
      // Which site it is on names a site, and the narrowed reader may not own it.
      measuring: asUser ? null : activeMeasurement(paths.jobsDir),
    };
  } finally {
    db.close();
  }
}

// --- the accounts sites run as -------------------------------------------

interface SiteAccount {
  uid: number;
  gid: number;
  home: string;
}

/**
 * A site's Unix account, read from /etc/passwd rather than resolved by name at
 * the point of use. Every path this action touches is built from the home
 * directory recorded there, so a site user whose account has gone contributes
 * nothing instead of a guessed `/home/<name>`.
 */
function siteAccounts(passwd: string): Map<string, SiteAccount> {
  const accounts = new Map<string, SiteAccount>();
  let content: string;
  try {
    content = readFileSync(passwd, "utf8");
  } catch (error) {
    failAction(`the account database could not be read: ${reason(error)}`);
  }
  for (const line of content.split("\n")) {
    const fields = line.split(":");
    if (fields.length < 6) continue;
    const uid = Number.parseInt(fields[2] ?? "", 10);
    const gid = Number.parseInt(fields[3] ?? "", 10);
    const home = fields[5] ?? "";
    if (!fields[0] || !Number.isInteger(uid) || !Number.isInteger(gid) || !home.startsWith("/")) continue;
    accounts.set(fields[0], { uid, gid, home });
  }
  return accounts;
}

function ownedDirectory(path: string, uid: number): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === uid;
  } catch {
    return false;
  }
}

// --- the disk sweep -------------------------------------------------------

/**
 * `du` on every site, politely.
 *
 * A recursive stat of a whole web root is the one thing this addon does that a
 * loaded box would feel, and it runs unattended about every six hours. So it
 * asks the kernel to schedule it last: idle I/O class, lowest CPU priority.
 * Where `ionice` is absent the measurement still happens, just without the
 * concession.
 */
function measure(path: string, run: (command: string, args: string[]) => CommandResult): number | null {
  const du = ["du", "-sb", "--one-file-system", "--", path];
  const polite = existsSync("/usr/bin/ionice")
    ? { command: "ionice", args: ["-c", "3", "nice", "-n", "19", ...du] }
    : { command: du[0]!, args: du.slice(1) };
  const result = run(polite.command, polite.args);
  // du exits non-zero for an unreadable subdirectory while still printing the
  // total it reached, so the number decides, not the exit code.
  const bytes = Number.parseInt(result.stdout.trim().split(/\s/)[0] ?? "", 10);
  return Number.isInteger(bytes) && bytes >= 0 ? bytes : null;
}

function scanDisk(
  paths: PanelTweaksActionPaths,
  options: PanelTweaksActionOptions,
): ScanResult {
  const run = options.run ?? runCommand;
  const db = openPanelDatabase(paths.panelDb);
  let rows: PanelSiteRow[];
  let databases: Map<string, string[]>;
  try {
    rows = panelSites(db);
    databases = siteDatabases(db);
  } finally {
    db.close();
  }

  const accounts = siteAccounts(paths.passwd);
  const measuredAt = nowIso(options);
  const sites: Record<string, DiskCacheEntry> = {};
  let skipped = 0;

  for (const [index, row] of rows.entries()) {
    options.onProgress?.({ completed: index, total: rows.length, site: row.domain_name });
    const account = accounts.get(row.user);
    if (!account || !ownedDirectory(account.home, account.uid)) {
      skipped++;
      continue;
    }
    const bytes = measure(account.home, run);
    if (bytes === null) {
      skipped++;
      continue;
    }
    let databaseBytes = 0;
    for (const name of databases.get(row.domain_name) ?? []) {
      // The database's own directory under the server's data directory. It is
      // the size MySQL is using for that schema, and reading it needs no
      // credentials -- which is the point, because the alternative is asking
      // CloudPanel for the master password.
      const directory = join(paths.mysqlDir, name);
      if (!name.includes("/") && existsSync(directory)) databaseBytes += measure(directory, run) ?? 0;
    }
    sites[row.domain_name] = { bytes, databaseBytes, measuredAt };
  }

  writeDiskCache(paths, { measuredAt, skipped, sites });
  return { measured: Object.keys(sites).length, skipped, measuredAt };
}

// --- request parsing ------------------------------------------------------

const MAX_INPUT_BYTES = 8 * 1024;

interface ParsedAction {
  verb: PanelTweaksVerb;
  /** The panel user the state is for, when it is not an administrator's. */
  asUser: string;
}

function parseAction(argv: string[]): ParsedAction {
  const [rawVerb, ...rest] = argv;
  const verbs: PanelTweaksVerb[] = ["state", "set-tweaks", "scan", "measure"];
  const verb = verbs.find((known) => known === rawVerb);
  if (!verb) failAction(`unknown panel tweaks verb '${rawVerb ?? ""}'`);

  let asUser = "";
  for (const argument of rest) {
    if (argument.startsWith("--as-user=")) {
      asUser = argument.slice("--as-user=".length);
      continue;
    }
    failAction(`unexpected argument '${argument}'`);
  }
  if (asUser && verb !== "state") failAction(`'${verb}' takes no --as-user`);
  if (asUser && !PANEL_USER_NAME_RE.test(asUser)) failAction("that is not a valid panel user name");
  return { verb, asUser };
}

async function requestTweaks(options: PanelTweaksActionOptions, current: PanelTweaks): Promise<PanelTweaks> {
  const raw = options.input !== undefined ? options.input : await Bun.stdin.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_INPUT_BYTES) failAction("the request is too large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    failAction("the request must be JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    failAction("the request must be a JSON object");
  }
  const body = parsed as Record<string, unknown>;
  const wanted = { ...current };
  let named = 0;
  for (const key of TWEAK_KEYS) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== "boolean") failAction(`${key} must be true or false`);
    wanted[key] = body[key];
    named++;
  }
  if (named === 0) failAction("no tweak was named");
  return withTweakDependencies(wanted);
}

export interface SetTweaksResult {
  tweaks: PanelTweaks;
  /** Whether what the panel has injected into its own templates must change. */
  reinject: boolean;
}

async function setTweaks(
  paths: PanelTweaksActionPaths,
  options: PanelTweaksActionOptions,
): Promise<SetTweaksResult> {
  return withFileLock(paths.lockFile, 15, "another panel tweaks change is still running", async () => {
    const current = readTweaks(paths);
    const wanted = await requestTweaks(options, current);
    writeTweaks(paths, wanted);
    return {
      tweaks: wanted,
      // The template switches are markup in a CloudPanel template, so moving one
      // of those means rewriting them. The rest are read by the injected script
      // at request time and take effect on the next page.
      reinject: TEMPLATE_TWEAK_KEYS.some((key) => current[key] !== wanted[key]),
    };
  });
}

// --- the measurement an operator starts -------------------------------------
//
// A sweep can take minutes, longer than a page request should be held open,
// so the page starts it as a background job and follows its record: a reload
// or another tab finds it again, and pressing Measure now meanwhile follows
// the one already running rather than starting a second.

export function measureJobView(jobsDir: string, id: string): MeasureJobView | null {
  const dir = jobDir(jobsDir, id);
  const common = jobCommonFields(dir);
  if (!common.state) return null;
  return { id, ...common, ...jobSiteProgress(dir), result: readJobResult<ScanResult>(dir) };
}

export function activeMeasurement(jobsDir: string): MeasureJobView | null {
  for (const id of listJobIds(jobsDir)) {
    const view = measureJobView(jobsDir, id);
    if (view && (view.state === "queued" || view.state === "running")) return view;
  }
  return null;
}

export interface MeasureStarted {
  job: MeasureJobView;
  /** The measurement was already running, and this is it. */
  attached: boolean;
}

async function startMeasurement(paths: PanelTweaksActionPaths, options: PanelTweaksActionOptions): Promise<MeasureStarted> {
  return withFileLock(paths.jobsLockFile, 15, "another measurement is being started", async () => {
    const running = activeMeasurement(paths.jobsDir);
    if (running) return { job: running, attached: true };
    const id = queueJob({
      addon: "panel-tweaks",
      jobsDir: paths.jobsDir,
      fields: {},
      description: "clp-addons: Panel Tweaks site size measurement",
      actionBinary: paths.actionBinary,
      runtimeSeconds: MEASURE_RUNTIME_SECONDS,
      start: options.startJob,
    });
    return { job: measureJobView(paths.jobsDir, id)!, attached: false };
  });
}

/** The disk lock, saying so in the job's step when a scheduled sweep has it. */
async function scanLock(paths: PanelTweaksActionPaths, wait: (step: string) => void): Promise<FileLockHandle> {
  try {
    return await acquireFileLock(paths.scanLockFile, 0, "the disk is being measured");
  } catch (error) {
    if (!(error instanceof ActionFailure)) throw error;
  }
  wait("Waiting for the scheduled measurement to finish");
  return acquireFileLock(paths.scanLockFile, MEASURE_LOCK_WAIT_SECONDS, "the scheduled measurement did not finish in time");
}

/** systemd's half. A sweep that finished while this waited for it is the answer. */
async function runMeasurement(paths: PanelTweaksActionPaths, id: string, options: PanelTweaksActionOptions): Promise<MeasureJobView | null> {
  if (!measureJobView(paths.jobsDir, id)) failAction(`no such job: ${id}`);
  await runSiteJob(jobDir(paths.jobsDir, id), "Measuring", async (onProgress, wait) => {
    const before = readDiskCache(paths).measuredAt;
    const lock = await scanLock(paths, wait);
    try {
      const cache = readDiskCache(paths);
      if (cache.measuredAt && cache.measuredAt !== before) {
        return { measured: Object.keys(cache.sites).length, skipped: cache.skipped, measuredAt: cache.measuredAt };
      }
      return scanDisk(paths, { ...options, onProgress });
    } finally {
      lock.release();
    }
  });
  return measureJobView(paths.jobsDir, id);
}

/** Expired measurements go, and one whose runner died is marked failed. */
function pruneMeasurements(paths: PanelTweaksActionPaths): void {
  pruneJobs({
    addon: "panel-tweaks",
    jobsDir: paths.jobsDir,
    retentionDays: JOB_RETENTION_DAYS,
    stuckMessage: "the measurement stopped without recording a result",
  });
}

export async function executePanelTweaksAction(
  argv: string[],
  options: PanelTweaksActionOptions = {},
): Promise<unknown> {
  if ((options.processUid ?? process.getuid?.()) !== 0) failAction("panel tweaks actions must run as root");
  const paths = pathsFor(options);
  if (argv[0] === "run") return runMeasurement(paths, jobIdArgument(argv.slice(1)), options);
  if (argv[0] === "job") {
    const id = jobIdArgument(argv.slice(1));
    const job = measureJobView(paths.jobsDir, id);
    if (!job) failAction(`no such job: ${id}`);
    return { job, log: readJobLog(jobDir(paths.jobsDir, id)) };
  }
  const { verb, asUser } = parseAction(argv);

  if (verb === "state") return stateOf(paths, asUser);
  if (verb === "set-tweaks") return setTweaks(paths, options);
  if (verb === "measure") return startMeasurement(paths, options);
  if (verb === "scan") {
    return withFileLock(paths.scanLockFile, 15, "a disk measurement is already running", async () =>
      scanDisk(paths, options));
  }
  verb satisfies never;
  failAction(`unknown panel tweaks verb '${verb}'`);
}

export async function runPanelTweaksAction(
  argv: string[],
  options: PanelTweaksActionOptions = {},
): Promise<number> {
  const emit = options.emitReply !== false;
  try {
    if (argv[0] === "watch-job") {
      if ((options.processUid ?? process.getuid?.()) !== 0) failAction("panel tweaks actions must run as root");
      const paths = pathsFor(options);
      const id = jobIdArgument(argv.slice(1));
      const dir = jobDir(paths.jobsDir, id);
      if (!measureJobView(paths.jobsDir, id)) failAction(`no such job: ${id}`);
      await watchJobRecord({
        dir,
        read: () => ({ job: measureJobView(paths.jobsDir, id), log: readJobLog(dir) }),
        emit: (data) => { if (emit) emitActionOk(data); },
      });
      return 0;
    }
    const data = await executePanelTweaksAction(argv, options);
    if (emit) emitActionOk(data);
    return 0;
  } catch (error) {
    const message = reason(error);
    if (emit) emitActionError(message, error instanceof ActionFailure ? error.data : undefined, "panel-tweaks");
    else process.stderr.write(`[panel-tweaks] ERROR: ${message}\n`);
    return 1;
  }
}

/** The repair hook: expire old measurements, and sweep the disk when due. */
export async function panelTweaksUpkeep(options: PanelTweaksActionOptions = {}): Promise<string | null> {
  // One whose runner died is marked failed, so the page stops following it.
  pruneMeasurements(pathsFor(options));
  return scanDiskUsage(options);
}

/** Checked every fifteen minutes, but a sweep runs only when due. */
export async function scanDiskUsage(options: PanelTweaksActionOptions = {}): Promise<string | null> {
  const paths = pathsFor(options);
  if (!readTweaks(paths).diskUsage) return null;
  // The measurement an operator started is about to refresh every size anyway.
  if (activeMeasurement(paths.jobsDir)) return null;
  const measuredAt = Date.parse(readDiskCache(paths).measuredAt);
  const now = (options.now ?? (() => new Date()))().getTime();
  const age = now - measuredAt;
  if (Number.isFinite(measuredAt) && age >= 0 && age < DISK_SCAN_INTERVAL_MS) return null;
  const result = await executePanelTweaksAction(["scan"], { ...options, emitReply: false }) as ScanResult;
  const measured = `${result.measured} site${result.measured === 1 ? "" : "s"} measured`;
  return result.skipped ? `${measured}, ${result.skipped} skipped` : measured;
}

/**
 * The privileged half of Panel UI tweaks: what the panel's own pages cannot ask
 * for themselves.
 *
 * Two of the three tweaks are decoration -- a count, a filter, two extra
 * columns -- and would need no root at all if CloudPanel's Sites template
 * carried the values. It does not: the certificate, the runtime version and the
 * application are columns of a database the web manager cannot open, so the
 * site list is assembled here and sent as data the injected script paints.
 *
 * The third does touch the host. A disk measurement walks every site's home
 * directory, which only root can read across accounts. It is a verb with a
 * fixed shape, and it accepts no path.
 */
import { Database } from "bun:sqlite";
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  ActionFailure, emitActionError, emitActionOk, failAction, runCommand, withFileLock,
  type CommandResult,
} from "../../cli/action-common";
import { PANEL_DB, STATE_DIR } from "../../cli/paths";
import { writeFileAtomic } from "../../lib/atomic-write";

const TWEAKS_VERSION = 1;
const DISK_VERSION = 1;

export type PanelTweaksVerb = "state" | "set-tweaks" | "scan";

/**
 * What the addon does, as independent modes.
 *
 * Separate rather than one switch because they do not cost the same: most are
 * markup, and `diskUsage` walks the whole disk every fifteen minutes. An
 * operator who wants a filtered site list should not have to accept that. The
 * four narrow-screen and layout tweaks are separate for a different reason:
 * they change the shape of pages CloudPanel drew itself, and an operator who
 * likes the panel's own shape should be able to keep it.
 */
export interface PanelTweaks {
  /** Follow the device's light or dark preference on the panel's login page. */
  deviceTheme: boolean;
  /** Count, search, type filter, sorting and the SSL and runtime columns. */
  sitesTable: boolean;
  /** One card per site on a narrow screen instead of a table that scrolls. */
  sitesMobile: boolean;
  /** The Sites table's action links, collected into a menu on each row. */
  actionMenu: boolean;
  /** CloudPanel's own header and dashboard, made to fit a narrow screen. */
  panelMobile: boolean;
  /** The measured-size column, and the sweep that fills it. */
  diskUsage: boolean;
}

export const DEFAULT_TWEAKS: PanelTweaks = {
  deviceTheme: true,
  sitesTable: true,
  sitesMobile: true,
  // Off until asked for: a menu is a click more than a link, and it is worth
  // that only once there is more than one thing behind it.
  actionMenu: false,
  panelMobile: true,
  // Off until asked for: it is the only tweak that reads the whole disk.
  diskUsage: false,
};

/**
 * The switches whose answer is baked into CloudPanel's own templates.
 *
 * Everything else is read at request time by the script on the Sites page.
 * These four cannot be: the login page has no session to ask with, and the
 * other three decide how the page is painted the first time, so waiting for a
 * reply would mean the reader watching the layout move.
 */
export const TEMPLATE_TWEAK_KEYS: (keyof PanelTweaks)[] =
  ["deviceTheme", "sitesMobile", "actionMenu", "panelMobile"];

export const TWEAK_KEYS = Object.keys(DEFAULT_TWEAKS) as (keyof PanelTweaks)[];

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
 * The certificate CloudPanel puts on every new site. It is a certificate, but
 * it is not one a browser accepts, so it is never reported as a site being
 * covered -- only as the placeholder it is.
 */
export const SELF_SIGNED_CERTIFICATE = "1";

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
  certificate: { type: string; expiresAt: string } | null;
  /** Bytes under the site's home, and under its databases, when measured. */
  disk: { bytes: number; databaseBytes: number; measuredAt: string } | null;
}

export interface PanelTweaksState {
  tweaks: PanelTweaks;
  sites: TweakSiteView[];
  /** When the disk sweep last completed; "" when it never has. */
  diskMeasuredAt: string;
}

export interface ScanResult {
  measured: number;
  skipped: number;
  measuredAt: string;
}

export interface PanelTweaksActionPaths {
  panelDb: string;
  tweaksFile: string;
  diskFile: string;
  lockFile: string;
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
}

export const DEFAULT_PANEL_TWEAKS_PATHS: PanelTweaksActionPaths = {
  panelDb: PANEL_DB,
  tweaksFile: `${STATE_DIR}/panel-tweaks/tweaks.json`,
  diskFile: `${STATE_DIR}/panel-tweaks/disk-usage.json`,
  lockFile: "/run/lock/clp-addons/panel-tweaks.lock",
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
  return tweaks;
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
  sites: Record<string, DiskCacheEntry>;
}

function readDiskCache(paths: PanelTweaksActionPaths): DiskCache {
  const empty: DiskCache = { measuredAt: "", sites: {} };
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
  return { measuredAt: typeof stored.measuredAt === "string" ? stored.measuredAt : "", sites };
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
  application: string | null;
  root_directory: string | null;
  php_version: string | null;
  nodejs_version: string | null;
  python_version: string | null;
  certificate_type: string | null;
  certificate_expires_at: string | null;
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
  { table: "php_settings", alias: "p", column: "php_version", on: "p.site_id = s.id" },
  { table: "nodejs_settings", alias: "n", column: "nodejs_version", on: "n.site_id = s.id" },
  { table: "python_settings", alias: "y", column: "python_version", on: "y.site_id = s.id" },
  { table: "certificate", alias: "c", column: "type AS certificate_type, c.expires_at AS certificate_expires_at",
    absent: "NULL AS certificate_type, NULL AS certificate_expires_at", on: "c.id = s.certificate_id" },
];

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
    if (present.has(join.table)) {
      columns.push(`${join.alias}.${join.column}`);
      joins.push(`LEFT JOIN ${join.table} ${join.alias} ON ${join.on}`);
    } else {
      columns.push(join.absent ?? `NULL AS ${join.column}`);
    }
  }
  return `
  SELECT s.domain_name, s.user, s.type, s.application, s.root_directory,
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

function siteViews(rows: PanelSiteRow[], cache: DiskCache): TweakSiteView[] {
  return rows.map((row) => ({
    domain: row.domain_name,
    user: row.user,
    type: row.type,
    application: row.application ?? "",
    runtime: runtimeOf(row),
    certificate: row.certificate_type
      ? { type: row.certificate_type, expiresAt: row.certificate_expires_at ?? "" }
      : null,
    disk: cache.sites[row.domain_name] ?? null,
  }));
}

function stateOf(paths: PanelTweaksActionPaths): PanelTweaksState {
  const db = openPanelDatabase(paths.panelDb);
  try {
    const cache = readDiskCache(paths);
    return {
      tweaks: readTweaks(paths),
      sites: siteViews(panelSites(db), cache),
      diskMeasuredAt: cache.measuredAt,
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
 * loaded box would feel, and it runs unattended every fifteen minutes. So it
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

  for (const row of rows) {
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

  writeDiskCache(paths, { measuredAt, sites });
  return { measured: Object.keys(sites).length, skipped, measuredAt };
}

// --- request parsing ------------------------------------------------------

const MAX_INPUT_BYTES = 8 * 1024;

interface ParsedAction {
  verb: PanelTweaksVerb;
}

function parseAction(argv: string[]): ParsedAction {
  const [rawVerb, ...rest] = argv;
  const verbs: PanelTweaksVerb[] = ["state", "set-tweaks", "scan"];
  const verb = verbs.find((known) => known === rawVerb);
  if (!verb) failAction(`unknown panel tweaks verb '${rawVerb ?? ""}'`);

  if (rest.length > 0) failAction(`unexpected argument '${rest[0]}'`);
  return { verb };
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
  return wanted;
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
      // Four of the switches are markup in a CloudPanel template, so moving one
      // of those means rewriting them. The rest are read by the injected script
      // at request time and take effect on the next page.
      reinject: TEMPLATE_TWEAK_KEYS.some((key) => current[key] !== wanted[key]),
    };
  });
}

export async function executePanelTweaksAction(
  argv: string[],
  options: PanelTweaksActionOptions = {},
): Promise<unknown> {
  if ((options.processUid ?? process.getuid?.()) !== 0) failAction("panel tweaks actions must run as root");
  const paths = pathsFor(options);
  const { verb } = parseAction(argv);

  if (verb === "state") return stateOf(paths);
  if (verb === "set-tweaks") return setTweaks(paths, options);
  return withFileLock(paths.lockFile, 15, "a disk measurement is already running", async () =>
    scanDisk(paths, options));
}

export async function runPanelTweaksAction(
  argv: string[],
  options: PanelTweaksActionOptions = {},
): Promise<number> {
  const emit = options.emitReply !== false;
  try {
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

/** The fifteen-minute sweep, when the operator asked for measured sizes. */
export async function scanDiskUsage(options: PanelTweaksActionOptions = {}): Promise<string | null> {
  const paths = pathsFor(options);
  if (!readTweaks(paths).diskUsage) return null;
  const result = await executePanelTweaksAction(["scan"], { ...options, emitReply: false }) as ScanResult;
  const measured = `${result.measured} site${result.measured === 1 ? "" : "s"} measured`;
  return result.skipped ? `${measured}, ${result.skipped} skipped` : measured;
}

/** Whether the file a site's `du` reads still exists; used by the tests. */
export function siteHomeExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

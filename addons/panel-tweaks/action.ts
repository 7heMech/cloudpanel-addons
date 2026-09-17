/**
 * The privileged half of Panel Tweaks: what the panel's own pages cannot ask
 * for themselves.
 *
 * Three of the four tweaks are decoration -- a count, a filter, two extra
 * columns -- and would need no root at all if CloudPanel's Sites template
 * carried the values. It does not: the certificate, the runtime version and the
 * application are columns of a database the web manager cannot open, so the
 * site list is assembled here and sent as data the injected script paints.
 *
 * The other two do change the host. A disk measurement walks every site's home
 * directory, which only root can read across accounts; the WordPress sign-in
 * writes two files into one site's own tree, as that site's user, and mints a
 * credential that lives for a minute. Both are verbs with a fixed shape, and
 * neither accepts a path.
 */
import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { chownSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  ActionFailure, emitActionError, emitActionOk, failAction, runCommand, validateDomain, withFileLock,
  type CommandResult,
} from "../../cli/action-common";
import { PANEL_DB, STATE_DIR } from "../../cli/paths";
import { writeFileAtomic } from "../../lib/atomic-write";

const TWEAKS_VERSION = 1;
const DISK_VERSION = 1;

export type PanelTweaksVerb = "state" | "set-tweaks" | "scan" | "wp-login";

/**
 * What the addon does, as four independent modes.
 *
 * Separate rather than one switch because they do not cost the same. The first
 * two are markup; `diskUsage` walks the disk every fifteen minutes, and
 * `wordpressLogin` is a way into somebody's WordPress. An operator who wants a
 * filtered site list should not have to accept either.
 */
export interface PanelTweaks {
  /** Follow the device's light or dark preference on the panel's login page. */
  deviceTheme: boolean;
  /** Count, search, type filter, sorting and the SSL and runtime columns. */
  sitesTable: boolean;
  /** The measured-size column, and the sweep that fills it. */
  diskUsage: boolean;
  /** The one-click administrator sign-in on WordPress sites. */
  wordpressLogin: boolean;
}

export const DEFAULT_TWEAKS: PanelTweaks = {
  deviceTheme: true,
  sitesTable: true,
  // Off until asked for: it is the only tweak that reads the whole disk.
  diskUsage: false,
  // Off until asked for: it writes into a site and signs an operator in as its
  // administrator. That is a decision, not a default.
  wordpressLogin: false,
};

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
  wordpress: boolean;
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

export interface WpLoginResult {
  domain: string;
  url: string;
  /** The single-use secret, only ever returned to the operator's own browser. */
  token: string;
  field: string;
  /** Seconds the token is good for, so the page can say so. */
  expiresIn: number;
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
  /** Test-only; production always guards against the panel's own hostname. */
  domainValidator?: (value: string) => string;
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
 * versions, so each is an outer join: a panel without one of them reports no
 * runtime rather than failing the list. `site.certificate_id` rather than the
 * newest certificate row, because that column is the certificate the panel is
 * actually serving.
 */
const SITE_QUERY = `
  SELECT s.domain_name, s.user, s.type, s.application, s.root_directory,
         p.php_version, n.nodejs_version, y.python_version,
         c.type AS certificate_type, c.expires_at AS certificate_expires_at
  FROM site s
  LEFT JOIN php_settings p ON p.site_id = s.id
  LEFT JOIN nodejs_settings n ON n.site_id = s.id
  LEFT JOIN python_settings y ON y.site_id = s.id
  LEFT JOIN certificate c ON c.id = s.certificate_id
  ORDER BY s.domain_name;
`;

function panelSites(db: Database): PanelSiteRow[] {
  try {
    return db.query<PanelSiteRow, []>(SITE_QUERY).all();
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

function isWordPress(row: PanelSiteRow): boolean {
  return (row.application ?? "").toLowerCase() === "wordpress";
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
    wordpress: isWordPress(row),
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

// --- the WordPress sign-in -----------------------------------------------

/** Where the loader and its one-time secret live inside a WordPress site. */
const MU_PLUGINS = "wp-content/mu-plugins";
const LOADER_FILE = `${MU_PLUGINS}/clp-addons-login.php`;
const SECRET_DIR = `${MU_PLUGINS}/clp-addons`;
const SECRET_FILE = `${SECRET_DIR}/token.php`;
/** The POST field the loader reads the secret from. */
export const WP_LOGIN_FIELD = "clp_addons_login";
/** How long a minted sign-in is good for. One use, and a minute to make it. */
export const WP_LOGIN_TTL_SECONDS = 60;

/**
 * The must-use plugin.
 *
 * Must-use rather than a normal plugin because it has to be there when the
 * request arrives and must not be something a site owner can deactivate by
 * accident, and because WordPress loads it before the plugins that would
 * otherwise redirect an anonymous request away.
 *
 * It is inert on every request but the one. Without a secret file on disk it
 * returns immediately, and the secret file only exists between an operator
 * pressing the button and the browser arriving -- at most a minute, and it is
 * removed before it is even checked, so a second attempt with the same value
 * has nothing to compare against.
 *
 * The secret lives in a subdirectory: WordPress auto-loads every PHP file
 * directly inside mu-plugins, and a data file that is also a plugin would be
 * executed on every request. It is a `.php` file rather than plain data so that
 * a request for it over HTTP runs it and prints nothing, instead of serving the
 * hash to whoever asked.
 */
const LOADER_PHP = `<?php
/*
 * Plugin Name: CloudPanel Addons sign-in
 * Description: Accepts one single-use administrator sign-in minted by CloudPanel. Installed and removed by the Panel Tweaks addon.
 */
add_action('init', function () {
    if (empty($_POST['${WP_LOGIN_FIELD}']) || !is_string($_POST['${WP_LOGIN_FIELD}'])) {
        return;
    }
    $file = __DIR__ . '/clp-addons/token.php';
    if (!is_readable($file)) {
        return;
    }
    $secret = include $file;
    // Removed before it is checked, so a failed attempt spends it too.
    @unlink($file);
    if (!is_array($secret) || empty($secret['hash']) || empty($secret['expires'])) {
        return;
    }
    if (time() > (int) $secret['expires']) {
        return;
    }
    $given = hash('sha256', (string) $_POST['${WP_LOGIN_FIELD}']);
    if (!hash_equals((string) $secret['hash'], $given)) {
        return;
    }
    $administrators = get_users(array(
        'role' => 'administrator',
        'number' => 1,
        'orderby' => 'ID',
        'order' => 'ASC',
        'fields' => 'ID',
    ));
    if (empty($administrators)) {
        return;
    }
    $user = (int) $administrators[0];
    wp_set_current_user($user);
    wp_set_auth_cookie($user, false);
    wp_safe_redirect(admin_url());
    exit;
}, 1);
`;

function siteRoot(account: SiteAccount, row: PanelSiteRow): string {
  // CloudPanel stores the root as a name under the account's htdocs, and falls
  // back to the domain when the column is empty.
  const directory = (row.root_directory ?? "").trim() || row.domain_name;
  if (directory.includes("/") || directory.includes("..")) {
    failAction(`the site root recorded for ${row.domain_name} is not a plain directory name`);
  }
  return join(account.home, "htdocs", directory);
}

function writeAsSite(path: string, content: string, account: SiteAccount, mode: number): void {
  writeFileAtomic(path, content, { mode, owner: { uid: account.uid, gid: account.gid } });
}

/**
 * One directory, owned by the site.
 *
 * Deliberately not recursive: mkdir runs as root, and a recursive create left
 * the site with a root-owned `wp-content` it could no longer write to. Each
 * level this creates is handed straight over, and a missing parent is a
 * refusal rather than something to invent.
 */
function ensureOwnedDirectory(path: string, account: SiteAccount): void {
  if (existsSync(path)) return;
  try {
    mkdirSync(path, { mode: 0o755 });
    chownSync(path, account.uid, account.gid);
  } catch (error) {
    failAction(`the site directory ${path} could not be created: ${reason(error)}`);
  }
}

function mintWpLogin(
  paths: PanelTweaksActionPaths,
  domain: string,
  options: PanelTweaksActionOptions,
): WpLoginResult {
  const db = openPanelDatabase(paths.panelDb);
  let row: PanelSiteRow | undefined;
  try {
    row = panelSites(db).find((site) => site.domain_name === domain);
  } finally {
    db.close();
  }
  if (!row) failAction(`CloudPanel has no site called ${domain}`);
  if (!isWordPress(row)) failAction(`${domain} is not a WordPress site`);

  const account = siteAccounts(paths.passwd).get(row.user);
  if (!account) failAction(`the site user ${row.user} has no account on this host`);
  const root = siteRoot(account, row);
  if (!existsSync(join(root, "wp-includes")) || !existsSync(join(root, "wp-content"))) {
    failAction(`${domain} does not look like a WordPress installation any more`);
  }

  ensureOwnedDirectory(join(root, MU_PLUGINS), account);
  ensureOwnedDirectory(join(root, SECRET_DIR), account);

  const loader = join(root, LOADER_FILE);
  // Rewritten only when it differs, so an untouched site keeps its file's mtime
  // and nothing reindexes it.
  let current = "";
  try {
    current = readFileSync(loader, "utf8");
  } catch {
    current = "";
  }
  if (current !== LOADER_PHP) writeAsSite(loader, LOADER_PHP, account, 0o644);

  const token = randomBytes(32).toString("hex");
  const hash = createHash("sha256").update(token).digest("hex");
  const expires = Math.floor((options.now?.() ?? new Date()).getTime() / 1000) + WP_LOGIN_TTL_SECONDS;
  writeAsSite(
    join(root, SECRET_FILE),
    `<?php return array('hash' => '${hash}', 'expires' => ${expires});\n`,
    account,
    0o600,
  );

  return {
    domain,
    url: `https://${domain}/`,
    token,
    field: WP_LOGIN_FIELD,
    expiresIn: WP_LOGIN_TTL_SECONDS,
  };
}

/**
 * Take the sign-in back out of every site that has it.
 *
 * Switching the tweak off is the removal path: leaving a loader behind in
 * somebody else's site because a switch moved would make this addon something
 * an operator cannot fully withdraw.
 */
function removeWpLogin(paths: PanelTweaksActionPaths): number {
  const db = openPanelDatabase(paths.panelDb);
  let rows: PanelSiteRow[];
  try {
    rows = panelSites(db);
  } finally {
    db.close();
  }
  const accounts = siteAccounts(paths.passwd);
  let removed = 0;
  for (const row of rows) {
    const account = accounts.get(row.user);
    if (!account) continue;
    let root: string;
    try {
      root = siteRoot(account, row);
    } catch {
      continue;
    }
    const loader = join(root, LOADER_FILE);
    if (!existsSync(loader)) continue;
    rmSync(loader, { force: true });
    rmSync(join(root, SECRET_DIR), { recursive: true, force: true });
    removed++;
  }
  return removed;
}

// --- request parsing ------------------------------------------------------

const MAX_INPUT_BYTES = 8 * 1024;

interface ParsedAction {
  verb: PanelTweaksVerb;
  domain: string;
}

function parseAction(argv: string[], options: PanelTweaksActionOptions): ParsedAction {
  const [rawVerb, ...rest] = argv;
  const verbs: PanelTweaksVerb[] = ["state", "set-tweaks", "scan", "wp-login"];
  const verb = verbs.find((known) => known === rawVerb);
  if (!verb) failAction(`unknown panel tweaks verb '${rawVerb ?? ""}'`);

  let domain = "";
  for (const argument of rest) {
    if (argument.startsWith("--domain=")) {
      domain = argument.slice("--domain=".length);
      continue;
    }
    failAction(`unexpected argument '${argument}'`);
  }
  if (verb === "wp-login") {
    // The panel's own hostname is refused here as it is everywhere else: the
    // panel is not a site, and nothing of ours writes into it.
    domain = (options.domainValidator ?? ((value: string) => validateDomain(value)))(domain);
  } else if (domain) {
    failAction(`'${verb}' takes no --domain`);
  }
  return { verb, domain };
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
  /** WordPress sites the sign-in was taken back out of. */
  wordpressRemoved: number;
}

async function setTweaks(
  paths: PanelTweaksActionPaths,
  options: PanelTweaksActionOptions,
): Promise<SetTweaksResult> {
  return withFileLock(paths.lockFile, 15, "another panel tweaks change is still running", async () => {
    const current = readTweaks(paths);
    const wanted = await requestTweaks(options, current);
    let wordpressRemoved = 0;
    if (current.wordpressLogin && !wanted.wordpressLogin) wordpressRemoved = removeWpLogin(paths);
    writeTweaks(paths, wanted);
    return {
      tweaks: wanted,
      // The login page's script is markup in a CloudPanel template, so only
      // that switch needs the templates rewritten. The rest are read by the
      // injected script at request time and take effect on the next page.
      reinject: current.deviceTheme !== wanted.deviceTheme,
      wordpressRemoved,
    };
  });
}

export async function executePanelTweaksAction(
  argv: string[],
  options: PanelTweaksActionOptions = {},
): Promise<unknown> {
  if ((options.processUid ?? process.getuid?.()) !== 0) failAction("panel tweaks actions must run as root");
  const paths = pathsFor(options);
  const { verb, domain } = parseAction(argv, options);

  if (verb === "state") return stateOf(paths);
  if (verb === "set-tweaks") return setTweaks(paths, options);
  if (verb === "scan") {
    return withFileLock(paths.lockFile, 15, "a disk measurement is already running", async () =>
      scanDisk(paths, options));
  }
  if (!readTweaks(paths).wordpressLogin) failAction("the WordPress sign-in is switched off");
  return mintWpLogin(paths, domain, options);
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

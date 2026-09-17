/**
 * Per-site PHP-FPM process limits, and the profile new sites start with.
 *
 * CloudPanel writes one pool file per PHP site from a template with fixed
 * numbers -- `pm = ondemand`, `pm.max_children = 250`, `pm.max_requests = 100`
 * -- and offers nothing that changes them. Its own PHP Settings form writes
 * `memory_limit` and friends into the site's Nginx vhost as `PHP_VALUE`, and
 * never touches the pool. So the pool file is the panel's blind spot, and it is
 * the only file this addon writes.
 *
 * It rewrites the directives it manages and leaves every other line alone. The
 * pool's identity -- its `[name]`, `listen`, `user`, `group` and
 * `listen.allowed_clients` -- belongs to CloudPanel, which reads the file back
 * to find the next free port; changing any of it here would make the panel and
 * the running pool disagree about the same site.
 */
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  ActionFailure, emitActionError, emitActionOk, failAction, runCommand, validateDomain, withFileLock,
  type CommandResult,
} from "../../cli/action-common";
import { PANEL_DB, STATE_DIR } from "../../cli/paths";
import { writeFileAtomic } from "../../lib/atomic-write";

const POLICY_VERSION = 1;

export type PhpResourcesVerb = "list" | "get" | "set" | "reset" | "default" | "reconcile";

/** The process manager modes php-fpm accepts. */
export const PM_MODES = ["static", "dynamic", "ondemand"] as const;
export type PmMode = (typeof PM_MODES)[number];

/**
 * The directives this addon owns. Everything else in a pool file is either
 * CloudPanel's or the operator's, and is copied through untouched.
 */
export interface PoolProfile {
  pm: PmMode;
  maxChildren: number;
  /** `dynamic` only; php-fpm rejects them under the other two modes. */
  startServers: number;
  minSpareServers: number;
  maxSpareServers: number;
  /** `ondemand` only, in seconds. */
  processIdleTimeout: number;
  /** Requests a worker serves before it is recycled; 0 never recycles. */
  maxRequests: number;
  /** Seconds a single request may run before the worker is killed; 0 is off. */
  requestTerminateTimeout: number;
  rlimitFiles: number;
}

/**
 * What CloudPanel's PoolBuilder writes for every new site. Reset restores
 * exactly this, and the forms start from it, so the addon never invents a
 * number the panel would not have written itself.
 */
export const STOCK_PROFILE: PoolProfile = {
  pm: "ondemand",
  maxChildren: 250,
  startServers: 2,
  minSpareServers: 1,
  maxSpareServers: 3,
  processIdleTimeout: 10,
  maxRequests: 100,
  requestTerminateTimeout: 7200,
  rlimitFiles: 131072,
};

export interface PoolSiteState {
  domain: string;
  siteUser: string;
  phpVersion: string;
  poolFile: string;
  /** What the pool file holds now. */
  current: PoolProfile;
  /** What this addon has saved for the site, or null when it manages none. */
  managed: PoolProfile | null;
  /** A managed site whose pool file no longer matches what was saved. */
  drifted: boolean;
}

export interface PhpResourcesState {
  sites: PoolSiteState[];
  /** Applied to sites created from now on, or null to leave them stock. */
  default: PoolProfile | null;
}

interface Policy {
  version: 1;
  default: PoolProfile | null;
  sites: Record<string, PoolProfile>;
  knownSiteIds: number[];
}

interface SiteRow {
  id: number;
  domain: string;
  user: string;
  phpVersion: string;
}

export interface PhpResourcesActionPaths {
  panelDb: string;
  /** Root of the per-version PHP trees, `/etc/php/<version>/fpm/pool.d`. */
  phpRoot: string;
  /** Directory holding `php-fpm<version>`, used for the config test. */
  sbinDir: string;
  policyFile: string;
  lockFile: string;
  systemctl: string;
  /** Owner every file this action trusts and writes must have. */
  rootUid: number;
}

export interface PhpResourcesActionOptions {
  paths?: Partial<PhpResourcesActionPaths>;
  input?: string;
  emitReply?: boolean;
  run?: (command: string, args: string[]) => CommandResult;
  /** Test-only process identity override; CLI and gateway callers omit it. */
  processUid?: number;
  /** Test-only validator override for fixtures with no panel identity file. */
  domainValidator?: (value: string) => string;
}

export const DEFAULT_PHP_RESOURCES_ACTION_PATHS: PhpResourcesActionPaths = {
  panelDb: PANEL_DB,
  phpRoot: "/etc/php",
  sbinDir: "/usr/sbin",
  policyFile: `${STATE_DIR}/php-resources/policy.json`,
  lockFile: "/run/lock/clp-addons/php-resources.lock",
  systemctl: "systemctl",
  rootUid: 0,
};

function pathsFor(options: PhpResourcesActionOptions): PhpResourcesActionPaths {
  return { ...DEFAULT_PHP_RESOURCES_ACTION_PATHS, ...options.paths };
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

interface Bound {
  min: number;
  max: number;
}

/**
 * Ranges wide enough to hold anything a real box might want and narrow enough
 * that a typo cannot ask php-fpm for a number it will refuse to start with.
 * They are not a recommendation: what a site should run is the operator's call.
 */
const BOUNDS: Record<Exclude<keyof PoolProfile, "pm">, Bound> = {
  maxChildren: { min: 1, max: 10_000 },
  startServers: { min: 1, max: 10_000 },
  minSpareServers: { min: 1, max: 10_000 },
  maxSpareServers: { min: 1, max: 10_000 },
  processIdleTimeout: { min: 1, max: 86_400 },
  maxRequests: { min: 0, max: 10_000_000 },
  requestTerminateTimeout: { min: 0, max: 86_400 },
  rlimitFiles: { min: 64, max: 1_048_576 },
};

const FIELD_LABELS: Record<keyof PoolProfile, string> = {
  pm: "process manager",
  maxChildren: "max children",
  startServers: "start servers",
  minSpareServers: "min spare servers",
  maxSpareServers: "max spare servers",
  processIdleTimeout: "process idle timeout",
  maxRequests: "max requests",
  requestTerminateTimeout: "request terminate timeout",
  rlimitFiles: "open file limit",
};

function wholeNumber(value: unknown, field: Exclude<keyof PoolProfile, "pm">): number {
  const label = FIELD_LABELS[field];
  if (typeof value !== "number" || !Number.isInteger(value)) failAction(`${label} must be a whole number`);
  const bound = BOUNDS[field];
  if (value < bound.min || value > bound.max) {
    failAction(`${label} must be between ${bound.min} and ${bound.max}`);
  }
  return value;
}

/** Reads one profile out of untrusted JSON, or refuses it with a reason. */
export function parseProfile(value: unknown): PoolProfile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    failAction("a profile must be a JSON object");
  }
  const raw = value as Record<string, unknown>;
  const pm = raw.pm;
  if (typeof pm !== "string" || !PM_MODES.includes(pm as PmMode)) {
    failAction(`process manager must be one of ${PM_MODES.join(", ")}`);
  }
  // The three dynamic-only fields are kept whatever the mode is, so switching
  // to `dynamic` and back does not lose what was typed. They are only written
  // to the pool file when the mode uses them.
  const profile: PoolProfile = {
    pm: pm as PmMode,
    maxChildren: wholeNumber(raw.maxChildren ?? STOCK_PROFILE.maxChildren, "maxChildren"),
    startServers: wholeNumber(raw.startServers ?? STOCK_PROFILE.startServers, "startServers"),
    minSpareServers: wholeNumber(raw.minSpareServers ?? STOCK_PROFILE.minSpareServers, "minSpareServers"),
    maxSpareServers: wholeNumber(raw.maxSpareServers ?? STOCK_PROFILE.maxSpareServers, "maxSpareServers"),
    processIdleTimeout: wholeNumber(raw.processIdleTimeout ?? STOCK_PROFILE.processIdleTimeout, "processIdleTimeout"),
    maxRequests: wholeNumber(raw.maxRequests ?? STOCK_PROFILE.maxRequests, "maxRequests"),
    requestTerminateTimeout: wholeNumber(raw.requestTerminateTimeout ?? STOCK_PROFILE.requestTerminateTimeout, "requestTerminateTimeout"),
    rlimitFiles: wholeNumber(raw.rlimitFiles ?? STOCK_PROFILE.rlimitFiles, "rlimitFiles"),
  };
  // php-fpm refuses to start on either of these, so refuse here instead: a
  // rejected form is recoverable, a pool that will not come back is not.
  if (profile.pm === "dynamic") {
    if (profile.minSpareServers > profile.maxSpareServers) {
      failAction("min spare servers cannot be greater than max spare servers");
    }
    if (profile.startServers < profile.minSpareServers || profile.startServers > profile.maxSpareServers) {
      failAction("start servers must be between min spare servers and max spare servers");
    }
    if (profile.maxSpareServers > profile.maxChildren) {
      failAction("max spare servers cannot be greater than max children");
    }
  }
  return profile;
}

export function profilesEqual(a: PoolProfile, b: PoolProfile): boolean {
  return (Object.keys(FIELD_LABELS) as (keyof PoolProfile)[]).every((key) => a[key] === b[key]);
}

// ---------------------------------------------------------------------------
// Pool files
// ---------------------------------------------------------------------------

const MANAGED_KEYS = [
  "pm",
  "pm.max_children",
  "pm.start_servers",
  "pm.min_spare_servers",
  "pm.max_spare_servers",
  "pm.process_idle_timeout",
  "pm.max_requests",
  "request_terminate_timeout",
  "rlimit_files",
] as const;

const MANAGED = new Set<string>(MANAGED_KEYS);

/** The directive a pool-file line sets, or null for a comment or blank. */
function directiveKey(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(";") || trimmed.startsWith("#") || trimmed.startsWith("[")) return null;
  const match = /^([A-Za-z0-9_.]+)\s*=/.exec(trimmed);
  return match ? match[1]! : null;
}

function directiveValue(line: string): string {
  return line.slice(line.indexOf("=") + 1).trim();
}

/** php-fpm durations: a bare number is seconds, a suffix scales it. */
function parseDuration(value: string, fallback: number): number {
  const match = /^([0-9]+)\s*([smhd])?$/i.exec(value.trim());
  if (!match) return fallback;
  const scale = { s: 1, m: 60, h: 3600, d: 86_400 }[(match[2] ?? "s").toLowerCase() as "s" | "m" | "h" | "d"];
  return Number(match[1]) * scale;
}

function parseInteger(value: string, fallback: number): number {
  return /^[0-9]+$/.test(value.trim()) ? Number(value.trim()) : fallback;
}

/**
 * What a pool file currently asks for.
 *
 * A directive the file does not set falls back to what php-fpm itself would
 * use, except for `pm` and `pm.max_children`, which php-fpm has no default for
 * and CloudPanel always writes; there the stock template's value stands in.
 */
export function readProfileFromPool(content: string): PoolProfile {
  const values = new Map<string, string>();
  for (const line of content.split("\n")) {
    const key = directiveKey(line);
    if (key && MANAGED.has(key)) values.set(key, directiveValue(line));
  }
  const pm = values.get("pm")?.trim().toLowerCase();
  return {
    pm: PM_MODES.includes(pm as PmMode) ? (pm as PmMode) : STOCK_PROFILE.pm,
    maxChildren: parseInteger(values.get("pm.max_children") ?? "", STOCK_PROFILE.maxChildren),
    startServers: parseInteger(values.get("pm.start_servers") ?? "", STOCK_PROFILE.startServers),
    minSpareServers: parseInteger(values.get("pm.min_spare_servers") ?? "", STOCK_PROFILE.minSpareServers),
    maxSpareServers: parseInteger(values.get("pm.max_spare_servers") ?? "", STOCK_PROFILE.maxSpareServers),
    processIdleTimeout: parseDuration(values.get("pm.process_idle_timeout") ?? "", 10),
    maxRequests: parseInteger(values.get("pm.max_requests") ?? "", 0),
    requestTerminateTimeout: parseDuration(values.get("request_terminate_timeout") ?? "", 0),
    rlimitFiles: parseInteger(values.get("rlimit_files") ?? "", STOCK_PROFILE.rlimitFiles),
  };
}

/**
 * The directives one profile writes, in pool-file order.
 *
 * A mode that does not use a directive does not get it: php-fpm warns on
 * `pm.start_servers` under `ondemand`, and a warning in the pool that serves a
 * customer's site is noise the operator did not ask for.
 */
export function poolDirectives(profile: PoolProfile): Map<string, string> {
  const out = new Map<string, string>([
    ["pm", profile.pm],
    ["pm.max_children", String(profile.maxChildren)],
  ]);
  if (profile.pm === "dynamic") {
    out.set("pm.start_servers", String(profile.startServers));
    out.set("pm.min_spare_servers", String(profile.minSpareServers));
    out.set("pm.max_spare_servers", String(profile.maxSpareServers));
  }
  if (profile.pm === "ondemand") {
    out.set("pm.process_idle_timeout", `${profile.processIdleTimeout}s`);
  }
  out.set("pm.max_requests", String(profile.maxRequests));
  out.set("request_terminate_timeout", `${profile.requestTerminateTimeout}s`);
  out.set("rlimit_files", String(profile.rlimitFiles));
  return out;
}

/**
 * The pool file with this addon's directives set to `profile`, and every other
 * line exactly where it was.
 *
 * A managed directive already in the file is rewritten in place, so the file
 * keeps CloudPanel's ordering; one that no longer applies to the chosen process
 * manager is dropped; one that applies and is absent is put back beside the
 * directive that precedes it in a stock pool file, rather than appended to the
 * end. That matters because switching the mode away and back is the ordinary
 * way a directive goes missing, and the file it lands in should still read like
 * the one CloudPanel wrote.
 */
export function renderPool(content: string, profile: PoolProfile): string {
  const desired = poolDirectives(profile);
  const out: string[] = [];
  const at = new Map<string, number>();

  for (const line of content.split("\n")) {
    const key = directiveKey(line);
    if (key !== null && MANAGED.has(key)) {
      const value = desired.get(key);
      if (value === undefined) continue;
      out.push(`${key} = ${value}`);
      at.set(key, out.length - 1);
      continue;
    }
    out.push(line);
  }

  /** The end of the file, ignoring the blank line a trailing newline leaves. */
  const tail = (): number => {
    let index = out.length;
    while (index > 0 && out[index - 1]!.trim() === "") index--;
    return index;
  };

  const order = [...desired.keys()];
  for (const [position, key] of order.entries()) {
    const known = at.get(key);
    if (known !== undefined) continue;
    // After the nearest directive that comes before this one in a stock pool
    // file, or failing that before the nearest one that comes after it.
    let insertAt = -1;
    for (let before = position - 1; before >= 0 && insertAt === -1; before--) {
      const anchor = at.get(order[before]!);
      if (anchor !== undefined) insertAt = anchor + 1;
    }
    for (let after = position + 1; after < order.length && insertAt === -1; after++) {
      const following = at.get(order[after]!);
      if (following !== undefined) insertAt = following;
    }
    if (insertAt === -1) insertAt = tail();
    out.splice(insertAt, 0, `${key} = ${desired.get(key)}`);
    for (const [name, index] of at) if (index >= insertAt) at.set(name, index + 1);
    at.set(key, insertAt);
  }
  return out.join("\n");
}

interface TrustedFile {
  path: string;
  content: string;
  mode: number;
  uid: number;
  gid: number;
}

function trustedPoolFile(path: string, expectedUid: number): TrustedFile {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    failAction(`this site has no PHP-FPM pool file: ${path}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== expectedUid || (stat.mode & 0o022) !== 0) {
    failAction(`refusing untrusted PHP-FPM pool file ${path}`);
  }
  return {
    path,
    content: readFileSync(path, "utf8"),
    mode: stat.mode & 0o777,
    uid: stat.uid,
    gid: stat.gid,
  };
}

function writeTrusted(file: TrustedFile, content: string): void {
  writeFileAtomic(file.path, content, { mode: file.mode, owner: { uid: file.uid, gid: file.gid } });
}

// ---------------------------------------------------------------------------
// Panel state
// ---------------------------------------------------------------------------

function openPanelDatabase(path: string): Database {
  try {
    const db = new Database(path, { readonly: true });
    db.exec("PRAGMA busy_timeout = 5000;");
    return db;
  } catch (error) {
    failAction(`CloudPanel database could not be opened: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Every site with a PHP-FPM pool, which is every site CloudPanel recorded PHP
 * settings for. The version comes from the same row, because that is what
 * decides which `/etc/php/<version>/fpm/pool.d` the pool file is in.
 */
function phpSiteRows(db: Database): SiteRow[] {
  try {
    return db.query<{ id: number; domain_name: string; user: string; php_version: string }, []>(
      `SELECT site.id AS id, site.domain_name AS domain_name, site.user AS user,
              php_settings.php_version AS php_version
         FROM site
         JOIN php_settings ON php_settings.site_id = site.id
        ORDER BY site.domain_name;`,
    ).all().map((row) => ({
      id: Number(row.id),
      domain: String(row.domain_name).toLowerCase(),
      user: String(row.user),
      phpVersion: String(row.php_version),
    }));
  } catch (error) {
    failAction(`CloudPanel does not expose its PHP settings: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Version strings name a directory under `/etc/php`, so bound them tightly. */
function validPhpVersion(value: string): boolean {
  return /^[0-9]+\.[0-9]+$/.test(value);
}

function poolFileFor(paths: PhpResourcesActionPaths, site: SiteRow): string {
  if (!validPhpVersion(site.phpVersion)) {
    failAction(`CloudPanel recorded an unusable PHP version for ${site.domain}: '${site.phpVersion}'`);
  }
  return join(paths.phpRoot, site.phpVersion, "fpm/pool.d", `${site.domain}.conf`);
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

function emptyPolicy(): Policy {
  return { version: POLICY_VERSION, default: null, sites: {}, knownSiteIds: [] };
}

function stablePolicy(value: Policy): Policy {
  return {
    version: POLICY_VERSION,
    default: value.default,
    sites: Object.fromEntries(Object.entries(value.sites).sort(([a], [b]) => a.localeCompare(b))),
    knownSiteIds: [...new Set(value.knownSiteIds.filter((id) => Number.isInteger(id) && id > 0))].sort((a, b) => a - b),
  };
}

function readPolicy(path: string, expectedUid: number): Policy {
  if (!existsSync(path)) return emptyPolicy();
  let raw: unknown;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== expectedUid || (stat.mode & 0o022) !== 0) {
      failAction("the PHP resources policy file is not a trusted regular file");
    }
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof ActionFailure) throw error;
    failAction(`the PHP resources policy could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) failAction("the PHP resources policy is malformed");
  const policy = raw as Partial<Policy>;
  if (policy.version !== POLICY_VERSION || typeof policy.sites !== "object" || policy.sites === null ||
      !Array.isArray(policy.knownSiteIds) || !policy.knownSiteIds.every(Number.isInteger)) {
    failAction("the PHP resources policy is malformed");
  }
  return stablePolicy({
    version: POLICY_VERSION,
    default: policy.default == null ? null : parseProfile(policy.default),
    sites: Object.fromEntries(Object.entries(policy.sites).map(([domain, profile]) => [domain, parseProfile(profile)])),
    knownSiteIds: policy.knownSiteIds,
  });
}

function writePolicy(path: string, policy: Policy, expectedUid: number): void {
  let uid = expectedUid;
  let gid = process.getgid?.() ?? 0;
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== expectedUid || (stat.mode & 0o022) !== 0) {
      failAction("the PHP resources policy file is not a trusted regular file");
    }
    uid = stat.uid;
    gid = stat.gid;
  }
  writeFileAtomic(path, `${JSON.stringify(stablePolicy(policy), null, 2)}\n`, {
    mode: 0o600,
    owner: { uid, gid },
    createParent: true,
  });
}

async function withPolicyLock<T>(paths: PhpResourcesActionPaths, body: () => Promise<T>): Promise<T> {
  mkdirSync(dirname(paths.lockFile), { recursive: true });
  chmodSync(dirname(paths.lockFile), 0o700);
  return withFileLock(paths.lockFile, 30, "another PHP resources operation is running", body);
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

function commandError(label: string, result: CommandResult): string {
  return `${label} failed: ${(result.stderr || result.stdout || `exit ${result.exitCode ?? "unknown"}`).trim()}`;
}

/**
 * Check the whole of one PHP version's configuration, then reload its service.
 *
 * The test is what makes a bad number recoverable: `systemctl reload` signals
 * php-fpm, which refuses a configuration it cannot parse and carries on with
 * the old one, reporting success to systemd all the same. Testing first is the
 * only place a refusal can still be turned into an error the operator sees.
 *
 * A version whose service is not running is not an error and is not started
 * here. CloudPanel starts a PHP version's service when it moves a site onto it,
 * and until then the pool file is simply what that service will read; starting
 * it would put a daemon on the box that the panel did not ask for.
 */
function applyPhpVersion(
  paths: PhpResourcesActionPaths,
  version: string,
  command: (command: string, args: string[]) => CommandResult,
): void {
  const binary = join(paths.sbinDir, `php-fpm${version}`);
  if (!existsSync(binary)) failAction(`PHP ${version} is not installed on this server`);
  const tested = command(binary, ["-t"]);
  if (!tested.ok) failAction(commandError(`PHP ${version} configuration test`, tested));
  const service = `php${version}-fpm`;
  if (!command(paths.systemctl, ["is-active", "--quiet", service]).ok) return;
  const reloaded = command(paths.systemctl, ["reload", service]);
  if (!reloaded.ok) failAction(commandError(`PHP ${version} reload`, reloaded));
}

/**
 * Write one site's pool file and reload its PHP version, or leave both as they
 * were. Returns whether the file changed.
 */
function applyToSite(
  paths: PhpResourcesActionPaths,
  site: SiteRow,
  profile: PoolProfile,
  command: (command: string, args: string[]) => CommandResult,
): boolean {
  const file = trustedPoolFile(poolFileFor(paths, site), paths.rootUid);
  const rendered = renderPool(file.content, profile);
  if (rendered === file.content) return false;
  writeTrusted(file, rendered);
  try {
    applyPhpVersion(paths, site.phpVersion, command);
  } catch (error) {
    writeTrusted(file, file.content);
    // Put the running pool back with the file: leaving the old numbers on disk
    // while the rejected ones are still what php-fpm holds would be worse than
    // either outcome on its own. A second failure here has nothing left to say
    // that the first one does not.
    try { applyPhpVersion(paths, site.phpVersion, command); } catch { /* reported below */ }
    throw error;
  }
  return true;
}

/**
 * The pool file's profile, or the stock one when there is nothing safe to read.
 * Display-only, so an unreadable file is reported as stock rather than refused:
 * the page still has to draw, and every write path checks the file again.
 */
function readableProfile(poolFile: string, expectedUid: number): PoolProfile {
  try {
    const stat = lstatSync(poolFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== expectedUid) return { ...STOCK_PROFILE };
    return readProfileFromPool(readFileSync(poolFile, "utf8"));
  } catch {
    return { ...STOCK_PROFILE };
  }
}

function stateFor(paths: PhpResourcesActionPaths, site: SiteRow, policy: Policy): PoolSiteState {
  const poolFile = poolFileFor(paths, site);
  const managed = policy.sites[site.domain] ?? null;
  const current = readableProfile(poolFile, paths.rootUid);
  return {
    domain: site.domain,
    siteUser: site.user,
    phpVersion: site.phpVersion,
    poolFile,
    current,
    managed,
    drifted: managed !== null && !profilesEqual(managed, current),
  };
}

function requireSite(rows: SiteRow[], domain: string): SiteRow {
  const site = rows.find((row) => row.domain === domain);
  if (!site) failAction(`no CloudPanel site with PHP settings was found for '${domain}'`);
  return site;
}

function panelSites(paths: PhpResourcesActionPaths): SiteRow[] {
  const db = openPanelDatabase(paths.panelDb);
  try {
    return phpSiteRows(db);
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Verbs
// ---------------------------------------------------------------------------

function listState(paths: PhpResourcesActionPaths): PhpResourcesState {
  const policy = readPolicy(paths.policyFile, paths.rootUid);
  return {
    sites: panelSites(paths).map((site) => stateFor(paths, site, policy)),
    default: policy.default,
  };
}

async function setSite(
  paths: PhpResourcesActionPaths,
  domain: string,
  profile: PoolProfile,
  command: (command: string, args: string[]) => CommandResult,
): Promise<PoolSiteState> {
  return withPolicyLock(paths, async () => {
    const site = requireSite(panelSites(paths), domain);
    const policy = readPolicy(paths.policyFile, paths.rootUid);
    applyToSite(paths, site, profile, command);
    policy.sites[domain] = profile;
    if (!policy.knownSiteIds.includes(site.id)) policy.knownSiteIds.push(site.id);
    writePolicy(paths.policyFile, policy, paths.rootUid);
    return stateFor(paths, site, policy);
  });
}

async function resetSite(
  paths: PhpResourcesActionPaths,
  domain: string,
  command: (command: string, args: string[]) => CommandResult,
): Promise<PoolSiteState> {
  return withPolicyLock(paths, async () => {
    const site = requireSite(panelSites(paths), domain);
    const policy = readPolicy(paths.policyFile, paths.rootUid);
    applyToSite(paths, site, STOCK_PROFILE, command);
    delete policy.sites[domain];
    writePolicy(paths.policyFile, policy, paths.rootUid);
    return stateFor(paths, site, policy);
  });
}

async function setDefault(
  paths: PhpResourcesActionPaths,
  profile: PoolProfile | null,
): Promise<{ default: PoolProfile | null }> {
  return withPolicyLock(paths, async () => {
    const policy = readPolicy(paths.policyFile, paths.rootUid);
    policy.default = profile;
    // The sites that exist now are not new sites. Recording them here is what
    // keeps a default from reaching back over a fleet that never asked for it.
    if (profile !== null) policy.knownSiteIds = panelSites(paths).map((site) => site.id);
    writePolicy(paths.policyFile, policy, paths.rootUid);
    return { default: policy.default };
  });
}

export interface ReconcileResult {
  /** Sites seen for the first time since the default was set. */
  discovered: number;
  /** New sites the default profile was written to. */
  applied: number;
  /** Managed sites whose pool file had drifted and was written again. */
  repaired: number;
}

/**
 * Give new sites the default profile, and put back what a managed site's pool
 * file lost.
 *
 * The second half is not housekeeping. Changing a site's PHP version in the
 * panel deletes its pool file and writes a fresh one from CloudPanel's fixed
 * template, so a site tuned here silently returns to `pm.max_children = 250`
 * the moment somebody moves it from 8.2 to 8.3.
 */
export async function reconcilePhpResources(
  paths: PhpResourcesActionPaths = DEFAULT_PHP_RESOURCES_ACTION_PATHS,
  command: (command: string, args: string[]) => CommandResult = runCommand,
): Promise<ReconcileResult> {
  return withPolicyLock(paths, async () => {
    const policy = readPolicy(paths.policyFile, paths.rootUid);
    const managesNothing = policy.default === null && Object.keys(policy.sites).length === 0;
    if (managesNothing) return { discovered: 0, applied: 0, repaired: 0 };

    const sites = panelSites(paths);
    const currentIds = new Set(sites.map((site) => site.id));
    const known = new Set(policy.knownSiteIds.filter((id) => currentIds.has(id)));
    const discovered = sites.filter((site) => !known.has(site.id));

    let applied = 0;
    let repaired = 0;
    const failures: string[] = [];

    for (const site of sites) {
      const isNew = !known.has(site.id);
      // A new site takes the default unless it already has a profile of its
      // own, which is what a site created and then tuned before the first
      // reconciliation run has.
      const wanted = policy.sites[site.domain]
        ?? (isNew && policy.default !== null ? policy.default : null);
      if (wanted === null) continue;
      try {
        const changed = applyToSite(paths, site, wanted, command);
        if (policy.sites[site.domain] === undefined) {
          policy.sites[site.domain] = wanted;
          applied++;
        } else if (changed) {
          repaired++;
        }
      } catch (error) {
        failures.push(`${site.domain}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // A site CloudPanel no longer has is a profile nothing can be applied to.
    const live = new Set(sites.map((site) => site.domain));
    for (const domain of Object.keys(policy.sites)) {
      if (!live.has(domain)) delete policy.sites[domain];
    }
    policy.knownSiteIds = sites.map((site) => site.id);
    writePolicy(paths.policyFile, policy, paths.rootUid);

    if (failures.length) failAction(`some sites could not be updated: ${failures.join("; ")}`);
    return { discovered: discovered.length, applied, repaired };
  });
}

interface ParsedAction {
  verb: PhpResourcesVerb;
  domain: string;
}

function parseAction(argv: string[], options: PhpResourcesActionOptions): ParsedAction {
  const normalized = argv.flatMap((arg) => arg.startsWith("--domain=")
    ? ["--domain", arg.slice("--domain=".length)]
    : [arg]);
  const verb = normalized[0] as PhpResourcesVerb | undefined;
  const perSite: PhpResourcesVerb[] = ["get", "set", "reset"];
  const fleet: PhpResourcesVerb[] = ["list", "default", "reconcile"];
  if (!verb || ![...perSite, ...fleet].includes(verb)) {
    failAction("usage: clp-addons action php-resources {list|default|reconcile} | {get|set|reset} --domain <domain>");
  }
  if (fleet.includes(verb)) {
    if (normalized.length > 1) failAction(`${verb} takes no arguments`);
    return { verb, domain: "" };
  }
  let domain = "";
  for (let i = 1; i < normalized.length; i++) {
    if (normalized[i] !== "--domain") failAction(`unknown argument: '${normalized[i]}'`);
    if (i + 1 >= normalized.length) failAction("--domain needs a value");
    domain = normalized[++i]!;
  }
  return {
    verb,
    domain: options.domainValidator ? options.domainValidator(domain) : validateDomain(domain),
  };
}

function readInput(options: PhpResourcesActionOptions): Promise<string> {
  if (options.input !== undefined) return Promise.resolve(options.input);
  return Bun.stdin.text();
}

async function requestedProfile(options: PhpResourcesActionOptions, allowNull: boolean): Promise<PoolProfile | null> {
  const raw = await readInput(options);
  if (Buffer.byteLength(raw, "utf8") > 16 * 1024) failAction("the profile request is too large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    failAction("the profile must be JSON");
  }
  const profile = (parsed as { profile?: unknown } | null)?.profile;
  if (profile == null) {
    if (allowNull) return null;
    failAction("a profile is required");
  }
  return parseProfile(profile);
}

export async function executePhpResourcesAction(
  argv: string[],
  options: PhpResourcesActionOptions = {},
): Promise<unknown> {
  if ((options.processUid ?? process.getuid?.()) !== 0) failAction("PHP resources actions must run as root");
  const paths = pathsFor(options);
  const command = options.run ?? runCommand;
  const { verb, domain } = parseAction(argv, options);

  if (verb === "list") return listState(paths);
  if (verb === "reconcile") return reconcilePhpResources(paths, command);
  if (verb === "default") return setDefault(paths, await requestedProfile(options, true));
  if (verb === "get") {
    const policy = readPolicy(paths.policyFile, paths.rootUid);
    return stateFor(paths, requireSite(panelSites(paths), domain), policy);
  }
  if (verb === "set") return setSite(paths, domain, (await requestedProfile(options, false))!, command);
  return resetSite(paths, domain, command);
}

export async function runPhpResourcesAction(
  argv: string[],
  options: PhpResourcesActionOptions = {},
): Promise<number> {
  const emit = options.emitReply !== false;
  try {
    const data = await executePhpResourcesAction(argv, options);
    if (emit) emitActionOk(data);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (emit) emitActionError(message, error instanceof ActionFailure ? error.data : undefined, "php-resources");
    else process.stderr.write(`[php-resources] ERROR: ${message}\n`);
    return 1;
  }
}

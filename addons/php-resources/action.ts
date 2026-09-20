/**
 * PHP-FPM process limits, kept as named categories a site is assigned to.
 *
 * CloudPanel writes one pool file per PHP site from a template with fixed
 * numbers -- `pm = ondemand`, `pm.max_children = 250`, `pm.max_requests = 100`
 * -- and offers nothing that changes them. Its own PHP Settings form writes
 * `memory_limit` and friends into the site's Nginx vhost as `PHP_VALUE`, and
 * never touches the pool. So the pool file is the panel's blind spot, and it is
 * the only file this addon writes.
 *
 * A site's pool follows the category it is in: editing the category rewrites
 * every pool assigned to it. That is the whole point -- a fleet is tuned by
 * deciding what "busy site" means once, not by opening eighty forms.
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

export type PhpResourcesVerb =
  | "list" | "site" | "save-category" | "delete-category" | "assign" | "set-default" | "reconcile";

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
 * What CloudPanel's PoolBuilder writes for every new site. Taking a site out of
 * a category restores exactly this, and a new category starts from it, so the
 * addon never invents a number the panel would not have written itself.
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

/** A named set of limits, and the sites assigned to it follow it. */
export interface PoolCategory {
  id: string;
  name: string;
  description: string;
  profile: PoolProfile;
}

/**
 * The categories a server starts with, as a starting point rather than a
 * recommendation: what a site should run is the operator's call, and every one
 * of these can be edited, renamed or deleted.
 *
 * They differ only in how many workers one site may run concurrently. All
 * start workers on demand and retire them after ten idle seconds: a category
 * applies per site, so a dynamic profile assigned across a fleet multiplies
 * its spare workers by every site in that category. Workers are recycled soon
 * enough to bound application and extension growth, and a request cannot hold
 * one for CloudPanel's stock two hours.
 */
export const PRESET_CATEGORIES: PoolCategory[] = [
  {
    id: "small-site",
    name: "Small site",
    description: "For most sites and safe fleet-wide use. Workers run only while requests need them, with up to 3 concurrent workers per site.",
    profile: { ...STOCK_PROFILE, pm: "ondemand", maxChildren: 3, processIdleTimeout: 10, maxRequests: 200, requestTerminateTimeout: 300 },
  },
  {
    id: "busy-site",
    name: "Busy site",
    description: "For sites with sustained parallel requests. Workers still run on demand, with up to 8 concurrent workers per site.",
    profile: { ...STOCK_PROFILE, pm: "ondemand", maxChildren: 8, processIdleTimeout: 10, maxRequests: 200, requestTerminateTimeout: 300 },
  },
  {
    id: "high-traffic",
    name: "High traffic",
    description: "For measured high concurrency. Assign sparingly: each site may run up to 12 workers and every worker holds application-specific memory.",
    profile: { ...STOCK_PROFILE, pm: "ondemand", maxChildren: 12, processIdleTimeout: 10, maxRequests: 200, requestTerminateTimeout: 300 },
  },
];

/** The safe starting point for an operator-created category. */
export const DEFAULT_CATEGORY_PROFILE: PoolProfile = { ...PRESET_CATEGORIES[0]!.profile };

export interface PoolSiteState {
  domain: string;
  siteUser: string;
  phpVersion: string;
  poolFile: string;
  /** What the pool file holds now. */
  current: PoolProfile;
  /** The category this site is in, or null when it is in none. */
  categoryId: string | null;
  categoryName: string | null;
  /** A site whose pool file no longer matches the category it is in. */
  drifted: boolean;
}

export interface PhpResourcesState {
  categories: PoolCategory[];
  /** The category a site created from now on joins, or null for none. */
  defaultCategoryId: string | null;
  sites: PoolSiteState[];
}

/** What a change answers with: the new state, and the sites it could not reach. */
export interface PhpResourcesResult extends PhpResourcesState {
  failures: string[];
}

interface Policy {
  version: 1;
  categories: PoolCategory[];
  defaultCategoryId: string | null;
  /** Domain to category id. A domain that is absent is in no category. */
  assignments: Record<string, string>;
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

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
// Categories
// ---------------------------------------------------------------------------

const MAX_CATEGORIES = 24;
const NAME_MAX = 40;
const DESCRIPTION_MAX = 240;

/** One line of plain text: no control characters, no runs of whitespace. */
function oneLine(value: unknown, what: string, max: number, required: boolean): string {
  if (value == null && !required) return "";
  if (typeof value !== "string") failAction(`${what} must be text`);
  const text = value.replace(/[ -]/g, " ").replace(/\s+/g, " ").trim();
  if (!text && required) failAction(`${what} is required`);
  if (text.length > max) failAction(`${what} must be at most ${max} characters`);
  return text;
}

/**
 * The stable identifier a category keeps for its whole life, derived from the
 * name it was created with. Renaming leaves it alone, so the sites assigned to
 * a category do not come loose when it is renamed.
 */
export function categoryIdFor(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, NAME_MAX).replace(/^-+|-+$/g, "");
  if (!slug) failAction("a category name needs at least one letter or digit");
  return slug;
}

function parseCategoryId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) {
    failAction("that is not a category identifier");
  }
  return value;
}

function findCategory(policy: Policy, id: string): PoolCategory {
  const category = policy.categories.find((candidate) => candidate.id === id);
  if (!category) failAction(`there is no category called '${id}'`);
  return category;
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
    failAction(`CloudPanel database could not be opened: ${reason(error)}`);
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
    failAction(`CloudPanel does not expose its PHP settings: ${reason(error)}`);
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

/**
 * What a server that has never saved anything has: the preset categories, with
 * nothing assigned to them. Seeding on read rather than on install means a read
 * never writes, and deleting a preset makes it stay deleted -- by then the file
 * exists and says so.
 */
function seededPolicy(): Policy {
  return {
    version: POLICY_VERSION,
    categories: PRESET_CATEGORIES.map((category) => ({ ...category, profile: { ...category.profile } })),
    defaultCategoryId: null,
    assignments: {},
    knownSiteIds: [],
  };
}

function stablePolicy(value: Policy): Policy {
  const ids = new Set(value.categories.map((category) => category.id));
  return {
    version: POLICY_VERSION,
    categories: value.categories,
    defaultCategoryId: value.defaultCategoryId && ids.has(value.defaultCategoryId) ? value.defaultCategoryId : null,
    assignments: Object.fromEntries(
      Object.entries(value.assignments)
        .filter(([, id]) => ids.has(id))
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
    knownSiteIds: [...new Set(value.knownSiteIds.filter((id) => Number.isInteger(id) && id > 0))].sort((a, b) => a - b),
  };
}

function parseCategory(value: unknown): PoolCategory {
  if (typeof value !== "object" || value === null || Array.isArray(value)) failAction("a category must be a JSON object");
  const raw = value as Record<string, unknown>;
  return {
    id: parseCategoryId(raw.id),
    name: oneLine(raw.name, "a category name", NAME_MAX, true),
    description: oneLine(raw.description, "a category description", DESCRIPTION_MAX, false),
    profile: parseProfile(raw.profile),
  };
}

function readPolicy(path: string, expectedUid: number): Policy {
  if (!existsSync(path)) return seededPolicy();
  let raw: unknown;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== expectedUid || (stat.mode & 0o022) !== 0) {
      failAction("the PHP resources policy file is not a trusted regular file");
    }
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof ActionFailure) throw error;
    failAction(`the PHP resources policy could not be read: ${reason(error)}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) failAction("the PHP resources policy is malformed");
  const policy = raw as Partial<Policy>;
  if (policy.version !== POLICY_VERSION || !Array.isArray(policy.categories) ||
      typeof policy.assignments !== "object" || policy.assignments === null ||
      !Array.isArray(policy.knownSiteIds) || !policy.knownSiteIds.every(Number.isInteger)) {
    failAction("the PHP resources policy is malformed");
  }
  return stablePolicy({
    version: POLICY_VERSION,
    categories: policy.categories.map(parseCategory),
    defaultCategoryId: policy.defaultCategoryId == null ? null : parseCategoryId(policy.defaultCategoryId),
    assignments: Object.fromEntries(
      Object.entries(policy.assignments).map(([domain, id]) => [domain, parseCategoryId(id)]),
    ),
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

interface ApplyOutcome {
  /** Domains whose pool file was rewritten. */
  changed: Set<string>;
  /** Domains left as they were, with the reason. */
  failed: Map<string, string>;
}

/**
 * Write a profile to each site's pool file, then reload each PHP version once.
 *
 * Once per version, not once per site: assigning forty sites to a category is
 * one decision, and it should cost one reload of each service rather than
 * forty. The rollback is per version for the same reason -- `php-fpm -t` tests
 * a version's whole configuration, so a refusal is about all of the files
 * written for it, and leaving some of them on disk would mean the running pools
 * and the files no longer agree.
 */
function applyMany(
  paths: PhpResourcesActionPaths,
  entries: { site: SiteRow; profile: PoolProfile }[],
  command: (command: string, args: string[]) => CommandResult,
): ApplyOutcome {
  const outcome: ApplyOutcome = { changed: new Set(), failed: new Map() };
  const byVersion = new Map<string, { site: SiteRow; profile: PoolProfile }[]>();
  for (const entry of entries) {
    const group = byVersion.get(entry.site.phpVersion);
    if (group) group.push(entry);
    else byVersion.set(entry.site.phpVersion, [entry]);
  }

  for (const [version, group] of byVersion) {
    const written: { file: TrustedFile; domain: string }[] = [];
    for (const entry of group) {
      try {
        const file = trustedPoolFile(poolFileFor(paths, entry.site), paths.rootUid);
        const rendered = renderPool(file.content, entry.profile);
        if (rendered === file.content) continue;
        writeTrusted(file, rendered);
        written.push({ file, domain: entry.site.domain });
      } catch (error) {
        outcome.failed.set(entry.site.domain, reason(error));
      }
    }
    if (!written.length) continue;
    try {
      applyPhpVersion(paths, version, command);
      for (const entry of written) outcome.changed.add(entry.domain);
    } catch (error) {
      for (const entry of written) writeTrusted(entry.file, entry.file.content);
      // Put the running pools back with the files: leaving the old numbers on
      // disk while the rejected ones are still what php-fpm holds would be
      // worse than either outcome on its own. A second failure here has nothing
      // left to say that the first one does not.
      try { applyPhpVersion(paths, version, command); } catch { /* reported below */ }
      for (const entry of written) outcome.failed.set(entry.domain, reason(error));
    }
  }
  return outcome;
}

function failureLines(outcome: ApplyOutcome): string[] {
  return [...outcome.failed].map(([domain, why]) => `${domain}: ${why}`);
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
  const assigned = policy.assignments[site.domain];
  const category = assigned ? policy.categories.find((candidate) => candidate.id === assigned) ?? null : null;
  const current = readableProfile(poolFile, paths.rootUid);
  return {
    domain: site.domain,
    siteUser: site.user,
    phpVersion: site.phpVersion,
    poolFile,
    current,
    categoryId: category?.id ?? null,
    categoryName: category?.name ?? null,
    drifted: category !== null && !profilesEqual(category.profile, current),
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

function stateOf(paths: PhpResourcesActionPaths, policy: Policy, sites?: SiteRow[]): PhpResourcesState {
  return {
    categories: policy.categories,
    defaultCategoryId: policy.defaultCategoryId,
    sites: (sites ?? panelSites(paths)).map((site) => stateFor(paths, site, policy)),
  };
}

// ---------------------------------------------------------------------------
// Verbs
// ---------------------------------------------------------------------------

interface CategoryRequest {
  id: string | null;
  name: string;
  description: string;
  profile: PoolProfile;
}

/**
 * Create a category, or change one and rewrite every pool assigned to it.
 *
 * Re-applying is the point of a category: an operator who decides a busy site
 * needs twenty workers rather than fifteen has decided it for all of them.
 */
async function saveCategory(
  paths: PhpResourcesActionPaths,
  request: CategoryRequest,
  command: (command: string, args: string[]) => CommandResult,
): Promise<PhpResourcesResult> {
  return withPolicyLock(paths, async () => {
    const policy = readPolicy(paths.policyFile, paths.rootUid);
    const clash = policy.categories.find((candidate) =>
      candidate.id !== request.id && candidate.name.toLowerCase() === request.name.toLowerCase());
    if (clash) failAction(`a category called '${clash.name}' already exists`);

    let id: string;
    if (request.id === null) {
      if (policy.categories.length >= MAX_CATEGORIES) failAction(`a server can hold at most ${MAX_CATEGORIES} categories`);
      id = categoryIdFor(request.name);
      if (policy.categories.some((candidate) => candidate.id === id)) {
        failAction(`a category called '${request.name}' already exists`);
      }
      policy.categories.push({ id, name: request.name, description: request.description, profile: request.profile });
    } else {
      const category = findCategory(policy, request.id);
      id = category.id;
      category.name = request.name;
      category.description = request.description;
      category.profile = request.profile;
    }

    const sites = panelSites(paths);
    const outcome = applyMany(
      paths,
      sites.filter((site) => policy.assignments[site.domain] === id).map((site) => ({ site, profile: request.profile })),
      command,
    );
    writePolicy(paths.policyFile, policy, paths.rootUid);
    return { ...stateOf(paths, policy, sites), failures: failureLines(outcome) };
  });
}

/**
 * Remove a category, and give the sites that were in it CloudPanel's own
 * limits back -- leaving them on numbers nothing any longer claims would make
 * the page lie about what the box is running.
 */
async function deleteCategory(
  paths: PhpResourcesActionPaths,
  id: string,
  command: (command: string, args: string[]) => CommandResult,
): Promise<PhpResourcesResult> {
  return withPolicyLock(paths, async () => {
    const policy = readPolicy(paths.policyFile, paths.rootUid);
    findCategory(policy, id);
    const sites = panelSites(paths);
    const released = sites.filter((site) => policy.assignments[site.domain] === id);
    const outcome = applyMany(paths, released.map((site) => ({ site, profile: STOCK_PROFILE })), command);
    for (const site of released) {
      if (!outcome.failed.has(site.domain)) delete policy.assignments[site.domain];
    }
    // A category still holding sites it could not release is not removed: the
    // alternative is a pool file running numbers with no name attached to them.
    if (outcome.failed.size === 0) {
      policy.categories = policy.categories.filter((candidate) => candidate.id !== id);
      if (policy.defaultCategoryId === id) policy.defaultCategoryId = null;
    }
    writePolicy(paths.policyFile, policy, paths.rootUid);
    return { ...stateOf(paths, policy, sites), failures: failureLines(outcome) };
  });
}

async function assignSites(
  paths: PhpResourcesActionPaths,
  domains: string[],
  categoryId: string | null,
  command: (command: string, args: string[]) => CommandResult,
): Promise<PhpResourcesResult> {
  return withPolicyLock(paths, async () => {
    const policy = readPolicy(paths.policyFile, paths.rootUid);
    const profile = categoryId === null ? STOCK_PROFILE : findCategory(policy, categoryId).profile;
    const sites = panelSites(paths);
    const targets = domains.map((domain) => requireSite(sites, domain));
    const outcome = applyMany(paths, targets.map((site) => ({ site, profile })), command);
    for (const site of targets) {
      if (outcome.failed.has(site.domain)) continue;
      if (categoryId === null) delete policy.assignments[site.domain];
      else policy.assignments[site.domain] = categoryId;
      // Assigning a site is a decision about it, including the decision to
      // leave it on CloudPanel's limits, so the default for new sites must not
      // reach it later.
      if (!policy.knownSiteIds.includes(site.id)) policy.knownSiteIds.push(site.id);
    }
    writePolicy(paths.policyFile, policy, paths.rootUid);
    if (outcome.failed.size === targets.length && targets.length > 0) {
      failAction(`no site could be updated: ${failureLines(outcome).join("; ")}`);
    }
    return { ...stateOf(paths, policy, sites), failures: failureLines(outcome) };
  });
}

async function setDefaultCategory(
  paths: PhpResourcesActionPaths,
  categoryId: string | null,
): Promise<PhpResourcesResult> {
  return withPolicyLock(paths, async () => {
    const policy = readPolicy(paths.policyFile, paths.rootUid);
    if (categoryId !== null) findCategory(policy, categoryId);
    policy.defaultCategoryId = categoryId;
    const sites = panelSites(paths);
    // The sites that exist now are not new sites. Recording them here is what
    // keeps a default from reaching back over a fleet that did not ask for it.
    if (categoryId !== null) policy.knownSiteIds = sites.map((site) => site.id);
    writePolicy(paths.policyFile, policy, paths.rootUid);
    return { ...stateOf(paths, policy, sites), failures: [] };
  });
}

export interface ReconcileResult {
  /** Sites seen for the first time since the default was set. */
  discovered: number;
  /** New sites that joined the default category. */
  applied: number;
  /** Assigned sites whose pool file had drifted and was written again. */
  repaired: number;
}

/**
 * Put new sites in the default category, and put back what an assigned site's
 * pool file lost.
 *
 * The second half is not housekeeping. Changing a site's PHP version in the
 * panel deletes its pool file and writes a fresh one from CloudPanel's fixed
 * template, so a site in a category silently returns to `pm.max_children = 250`
 * the moment somebody moves it from 8.2 to 8.3.
 */
export async function reconcilePhpResources(
  paths: PhpResourcesActionPaths = DEFAULT_PHP_RESOURCES_ACTION_PATHS,
  command: (command: string, args: string[]) => CommandResult = runCommand,
): Promise<ReconcileResult> {
  return withPolicyLock(paths, async () => {
    const policy = readPolicy(paths.policyFile, paths.rootUid);
    if (policy.defaultCategoryId === null && Object.keys(policy.assignments).length === 0) {
      return { discovered: 0, applied: 0, repaired: 0 };
    }

    const sites = panelSites(paths);
    const currentIds = new Set(sites.map((site) => site.id));
    const known = new Set(policy.knownSiteIds.filter((id) => currentIds.has(id)));
    const discovered = sites.filter((site) => !known.has(site.id));
    const byId = new Map(policy.categories.map((category) => [category.id, category]));

    const joining: SiteRow[] = [];
    const entries: { site: SiteRow; profile: PoolProfile }[] = [];
    for (const site of sites) {
      const assigned = policy.assignments[site.domain];
      if (assigned) {
        entries.push({ site, profile: byId.get(assigned)!.profile });
        continue;
      }
      if (known.has(site.id) || policy.defaultCategoryId === null) continue;
      joining.push(site);
      entries.push({ site, profile: byId.get(policy.defaultCategoryId)!.profile });
    }

    const outcome = applyMany(paths, entries, command);
    let applied = 0;
    for (const site of joining) {
      if (outcome.failed.has(site.domain)) continue;
      policy.assignments[site.domain] = policy.defaultCategoryId!;
      applied++;
    }
    const joined = new Set(joining.map((site) => site.domain));
    const repaired = [...outcome.changed].filter((domain) => !joined.has(domain)).length;

    // A site CloudPanel no longer has is an assignment nothing can be applied to.
    const live = new Set(sites.map((site) => site.domain));
    for (const domain of Object.keys(policy.assignments)) {
      if (!live.has(domain)) delete policy.assignments[domain];
    }
    policy.knownSiteIds = sites.map((site) => site.id);
    writePolicy(paths.policyFile, policy, paths.rootUid);

    if (outcome.failed.size) failAction(`some sites could not be updated: ${failureLines(outcome).join("; ")}`);
    return { discovered: discovered.length, applied, repaired };
  });
}

interface ParsedAction {
  verb: PhpResourcesVerb;
  domain: string;
}

const PER_SITE_VERBS: PhpResourcesVerb[] = ["site"];
const FLEET_VERBS: PhpResourcesVerb[] = ["list", "save-category", "delete-category", "assign", "set-default", "reconcile"];

function parseAction(argv: string[], options: PhpResourcesActionOptions): ParsedAction {
  const normalized = argv.flatMap((arg) => arg.startsWith("--domain=")
    ? ["--domain", arg.slice("--domain=".length)]
    : [arg]);
  const verb = normalized[0] as PhpResourcesVerb | undefined;
  if (!verb || ![...PER_SITE_VERBS, ...FLEET_VERBS].includes(verb)) {
    failAction("usage: clp-addons action php-resources {list|save-category|delete-category|assign|set-default|reconcile} | site --domain <domain>");
  }
  if (FLEET_VERBS.includes(verb)) {
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

/** The largest request any verb takes: `assign` naming a whole fleet. */
const MAX_INPUT_BYTES = 256 * 1024;

async function requestBody(options: PhpResourcesActionOptions): Promise<Record<string, unknown>> {
  const raw = options.input !== undefined ? options.input : await Bun.stdin.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_INPUT_BYTES) failAction("the request is too large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    failAction("the request must be JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) failAction("the request must be a JSON object");
  return parsed as Record<string, unknown>;
}

function categoryRequest(body: Record<string, unknown>): CategoryRequest {
  return {
    id: body.id == null ? null : parseCategoryId(body.id),
    name: oneLine(body.name, "a category name", NAME_MAX, true),
    description: oneLine(body.description, "a category description", DESCRIPTION_MAX, false),
    profile: parseProfile(body.profile),
  };
}

/** The most domains one assignment may name; a fleet, not an upload. */
const MAX_ASSIGN_DOMAINS = 2_000;

function assignRequest(
  body: Record<string, unknown>,
  options: PhpResourcesActionOptions,
): { domains: string[]; categoryId: string | null } {
  if (!Array.isArray(body.domains)) failAction("a list of domains is required");
  if (body.domains.length === 0) failAction("no sites were named");
  if (body.domains.length > MAX_ASSIGN_DOMAINS) failAction("too many sites were named at once");
  const validate = options.domainValidator ?? ((value: string) => validateDomain(value));
  const domains = [...new Set(body.domains.map((domain) => {
    if (typeof domain !== "string") failAction("a domain must be text");
    return validate(domain);
  }))];
  return { domains, categoryId: body.categoryId == null ? null : parseCategoryId(body.categoryId) };
}

export async function executePhpResourcesAction(
  argv: string[],
  options: PhpResourcesActionOptions = {},
): Promise<unknown> {
  if ((options.processUid ?? process.getuid?.()) !== 0) failAction("PHP resources actions must run as root");
  const paths = pathsFor(options);
  const command = options.run ?? runCommand;
  const { verb, domain } = parseAction(argv, options);

  if (verb === "list") return stateOf(paths, readPolicy(paths.policyFile, paths.rootUid));
  if (verb === "reconcile") return reconcilePhpResources(paths, command);
  if (verb === "site") {
    const policy = readPolicy(paths.policyFile, paths.rootUid);
    return stateFor(paths, requireSite(panelSites(paths), domain), policy);
  }
  const body = await requestBody(options);
  if (verb === "save-category") return saveCategory(paths, categoryRequest(body), command);
  if (verb === "delete-category") return deleteCategory(paths, parseCategoryId(body.id), command);
  if (verb === "assign") {
    const request = assignRequest(body, options);
    return assignSites(paths, request.domains, request.categoryId, command);
  }
  return setDefaultCategory(paths, body.categoryId == null ? null : parseCategoryId(body.categoryId));
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
    const message = reason(error);
    if (emit) emitActionError(message, error instanceof ActionFailure ? error.data : undefined, "php-resources");
    else process.stderr.write(`[php-resources] ERROR: ${message}\n`);
    return 1;
  }
}

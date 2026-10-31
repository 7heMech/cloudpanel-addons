import { MAINTENANCE_VERBS } from "./verbs";
import { Database } from "bun:sqlite";
import { standInDomains } from "../../cli/stand-ins";
import { isIP } from "node:net";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync,
} from "node:fs";
import { join } from "node:path";
import {
  ActionFailure, deletedSites, emitActionError, emitActionOk, failAction, normalizeIdentityHostname, withFileLock,
  validateDomain,
} from "../../cli/action-common";
import { MAINTENANCE_INCLUDE_PATH, maintenanceGap, maintenanceGaps } from "../../cli/maintenance-vhosts";
import { DISTRO_NGINX_SITES_DIR, NGINX_GLOBAL_SETTINGS, PANEL_IDENTITY_PATH } from "../../cli/paths";
import { writeAtomic } from "../../cli/util";
import DEFAULT_TEMPLATE from "./default.html" with { type: "text" };

const DEFAULT_MAINTENANCE_PAGE = DEFAULT_TEMPLATE as unknown as string;

export const MAX_TEMPLATE_BYTES = 256 * 1024;
export const MAX_BYPASS_IPS = 64;

export interface MaintenanceStatus {
  domain: string;
  enabled: boolean;
  customTemplate: boolean;
  bypasses: string[];
  /** Why Nginx runs no maintenance check for the site, so its setting does nothing; null when it does. */
  uncovered: string | null;
}

/** One row of `sites`: a site's status with what the panel says the site is. */
export interface MaintenanceSiteStatus extends MaintenanceStatus {
  type: string;
  user: string;
  error?: string;
}

export interface GlobalMaintenanceStatus {
  global: boolean;
  bypasses: string[];
}

export interface MaintenanceActionPaths {
  dataDir: string;
  lockDir: string;
  panelDb: string;
  panelIdentityFile: string;
  nginxVhostDir: string;
  nginxSettings: string;
  includePath: string;
}

export interface MaintenanceActionOptions {
  paths?: Partial<MaintenanceActionPaths>;
  input?: string;
  emitReply?: boolean;
  /** Test-only process identity override; CLI and gateway callers omit it. */
  rootUid?: number;
  /** Test-only validator override for fixtures that cannot create root-owned identity files. */
  domainValidator?: (value: string) => string;
  /** Test-only write override used to exercise replacement failure handling. */
  writeAtomicFn?: typeof writeAtomic;
  varnishPort?: number;
  fetchFn?: typeof fetch;
}

export const DEFAULT_MAINTENANCE_ACTION_PATHS: MaintenanceActionPaths = {
  dataDir: "/var/lib/clp-addons/maintenance",
  lockDir: "/run/lock/clp-addons",
  panelDb: "/home/clp/htdocs/app/data/db.sq3",
  panelIdentityFile: PANEL_IDENTITY_PATH,
  nginxVhostDir: DISTRO_NGINX_SITES_DIR,
  nginxSettings: NGINX_GLOBAL_SETTINGS,
  includePath: MAINTENANCE_INCLUDE_PATH,
};

type MaintenanceVerb = keyof typeof MAINTENANCE_VERBS;

interface ParsedAction {
  verb: MaintenanceVerb;
  domain: string;
}

function pathsFor(options?: MaintenanceActionOptions): MaintenanceActionPaths {
  return { ...DEFAULT_MAINTENANCE_ACTION_PATHS, ...options?.paths };
}

function requireRoot(options: MaintenanceActionOptions): void {
  if ((options.rootUid ?? process.getuid?.()) !== 0) failAction("maintenance actions must run as root");
}

function parseAction(argv: string[], paths: MaintenanceActionPaths, options: MaintenanceActionOptions): ParsedAction {
  argv = argv.flatMap((arg) => arg.startsWith("--domain=")
    ? ["--domain", arg.slice("--domain=".length)]
    : [arg]);
  const verb = argv[0] as MaintenanceVerb | undefined;
  const siteAllowed: MaintenanceVerb[] = [
    "status", "enable", "disable", "get-template", "set-template", "reset-template", "set-bypass",
  ];
  const globalAllowed: MaintenanceVerb[] = [
    "sites", "enable-many", "disable-many", "global-status", "global-enable", "global-disable", "global-set-bypass",
  ];
  if (verb && globalAllowed.includes(verb)) {
    if (argv.length > 1) failAction(`action ${verb} takes no arguments`);
    return { verb, domain: "" };
  }
  if (!verb || !siteAllowed.includes(verb)) {
    failAction("usage: clp-addons action maintenance {status|enable|disable|get-template|set-template|reset-template|set-bypass} --domain <domain> | {sites|enable-many|disable-many|global-status|global-enable|global-disable|global-set-bypass}");
  }
  let domain = "";
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    if (flag !== "--domain") failAction(`unknown argument: '${flag}'`);
    if (i + 1 >= argv.length) failAction("--domain needs a value");
    domain = argv[++i]!;
  }
  return {
    verb,
    domain: options.domainValidator
      ? options.domainValidator(domain)
      : validateDomain(domain, paths.panelIdentityFile),
  };
}

function assertPanelSite(paths: MaintenanceActionPaths, domain: string): void {
  let db: Database;
  try {
    db = new Database(paths.panelDb, { readonly: true });
  } catch {
    failAction("CloudPanel's site database is unavailable");
  }
  try {
    db.exec("PRAGMA busy_timeout = 5000;");
    const row = db.query<{ present: number }, [string]>(
      "SELECT 1 AS present FROM site WHERE lower(domain_name) = ? LIMIT 1",
    ).get(domain);
    if (!row) failAction(`CloudPanel site not found: '${domain}'`);
  } catch (error) {
    if (error instanceof ActionFailure) throw error;
    failAction("CloudPanel's site database could not be read");
  } finally {
    db.close();
  }
}

function assertDirectory(path: string): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) failAction(`unsafe maintenance state path: ${path}`);
}

function ensureDataDir(paths: MaintenanceActionPaths): void {
  assertDirectory(paths.dataDir);
  mkdirSync(paths.dataDir, { recursive: true, mode: 0o711 });
  chmodSync(paths.dataDir, 0o711);
  const defaultPath = join(paths.dataDir, "default.html");
  if (existsSync(defaultPath) && !safeRegularFile(defaultPath)) {
    failAction(`unsafe maintenance default template: ${defaultPath}`);
  }
  if (!existsSync(defaultPath) || readFileSync(defaultPath, "utf8") !== DEFAULT_MAINTENANCE_PAGE) {
    writeAtomic(defaultPath, DEFAULT_MAINTENANCE_PAGE, 0o644);
  } else {
    chmodSync(defaultPath, 0o644);
  }
}

export function ensureMaintenanceData(dataDir = DEFAULT_MAINTENANCE_ACTION_PATHS.dataDir): void {
  ensureDataDir({ ...DEFAULT_MAINTENANCE_ACTION_PATHS, dataDir });
}

function siteDir(paths: MaintenanceActionPaths, domain: string, create = false): string {
  const path = join(paths.dataDir, domain);
  assertDirectory(path);
  if (create) {
    ensureDataDir(paths);
    mkdirSync(path, { recursive: true, mode: 0o711 });
    chmodSync(path, 0o711);
  }
  return path;
}

function safeRegularFile(path: string, maxBytes = MAX_TEMPLATE_BYTES): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink() && stat.size <= maxBytes;
  } catch {
    return false;
  }
}

function normalizeIp(value: unknown): string {
  if (typeof value !== "string") failAction("every bypass entry must be an IP address");
  const candidate = value.trim();
  const version = isIP(candidate);
  if (version === 4) return candidate.split(".").map((part) => String(Number(part))).join(".");
  if (version === 6) {
    try {
      return new URL(`http://[${candidate}]/`).hostname.slice(1, -1).toLowerCase();
    } catch {
      // isIP accepted it, but do not keep a representation Nginx cannot reproduce.
    }
  }
  failAction(`invalid bypass IP address: '${candidate}'`);
}

function bypasses(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path)
    .filter((name) => name.startsWith("bypass_") && safeRegularFile(join(path, name), 0))
    .map((name) => name.slice("bypass_".length))
    .filter((ip) => isIP(ip) !== 0)
    .sort((a, b) => a.localeCompare(b));
}

async function replaceBypasses(
  paths: MaintenanceActionPaths, domain: string, options: MaintenanceActionOptions,
): Promise<string[]> {
  const raw = await readInput(options);
  if (Buffer.byteLength(raw, "utf8") > 16 * 1024) failAction("the bypass request is too large");
  let values: unknown;
  try {
    const parsed = JSON.parse(raw) as { ips?: unknown };
    values = parsed.ips;
  } catch {
    failAction("the bypass list must be JSON");
  }
  if (!Array.isArray(values)) failAction("the bypass list must contain an ips array");
  if (values.length > MAX_BYPASS_IPS) failAction(`at most ${MAX_BYPASS_IPS} bypass addresses are allowed`);
  const ips = values.map(normalizeIp);
  return writeBypasses(paths, domain, options, () => ips);
}

/** Adds one address to a site's bypasses, keeping the rest. */
export function addBypass(
  paths: MaintenanceActionPaths, domain: string, ip: string, options: MaintenanceActionOptions = {},
): Promise<string[]> {
  assertPanelSite(paths, domain);
  const address = normalizeIp(ip);
  return writeBypasses(paths, domain, options, (current) => [...current, address]);
}

function nginxFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Whether Nginx answers `ip` on `domain` with the maintenance page: the same
 * files its block tests, read the way its `-f` reads them.
 */
export function maintenanceBlocks(paths: MaintenanceActionPaths, domain: string, ip: string): boolean {
  const dirs = [join(paths.dataDir, "_global"), join(paths.dataDir, domain)];
  if (!dirs.some((dir) => nginxFile(join(dir, "on")))) return false;
  if (!isIP(ip)) return true;
  const bypass = `bypass_${normalizeIp(ip)}`;
  return !dirs.some((dir) => nginxFile(join(dir, bypass)));
}

/** Replaces a scope's bypasses with what `next` makes of the current list, under its lock. */
function writeBypasses(
  paths: MaintenanceActionPaths, domain: string, options: MaintenanceActionOptions,
  next: (current: string[]) => string[],
): Promise<string[]> {
  const dir = siteDir(paths, domain, true);
  assertDirectory(paths.lockDir);
  mkdirSync(paths.lockDir, { recursive: true, mode: 0o700 });
  chmodSync(paths.lockDir, 0o700);
  const lockKey = Bun.CryptoHasher.hash("sha256", domain, "hex");
  return withFileLock(
    join(paths.lockDir, `maintenance-${lockKey}.lock`),
    10,
    `another maintenance update is running for ${domain}`,
    async () => {
      const ips = [...new Set(next(bypasses(dir)))].sort((a, b) => a.localeCompare(b));
      if (ips.length > MAX_BYPASS_IPS) failAction(`at most ${MAX_BYPASS_IPS} bypass addresses are allowed`);
      const stage = mkdtempSync(join(dir, ".bypass-stage-"));
      try {
        for (const ip of ips) (options.writeAtomicFn ?? writeAtomic)(join(stage, ip), "", 0o600);
        for (const name of readdirSync(dir)) {
          if (name.startsWith("bypass_")) rmSync(join(dir, name), { force: true });
        }
        for (const ip of ips) renameSync(join(stage, ip), join(dir, `bypass_${ip}`));
      } finally {
        rmSync(stage, { recursive: true, force: true });
      }
      return bypasses(dir);
    },
  );
}

function coveragePaths(paths: MaintenanceActionPaths) {
  return { nginxVhostDir: paths.nginxVhostDir, includePath: paths.includePath, settingsMissing: !existsSync(paths.nginxSettings) };
}

/** What a site's state directory says, read the way Nginx reads it. */
function savedStatus(paths: MaintenanceActionPaths, domain: string, uncovered: string | null): MaintenanceStatus {
  const dir = siteDir(paths, domain);
  return {
    domain,
    enabled: safeRegularFile(join(dir, "on"), 0),
    customTemplate: safeRegularFile(join(dir, "maintenance.html")),
    bypasses: bypasses(dir),
    uncovered,
  };
}

export function maintenanceStatus(paths: MaintenanceActionPaths, domain: string): MaintenanceStatus {
  assertPanelSite(paths, domain);
  let uncovered: string | null = null;
  try {
    const db = new Database(paths.panelDb, { readonly: true });
    try { uncovered = maintenanceGap(db, domain, coveragePaths(paths)); } finally { db.close(); }
  } catch {
    // Coverage that cannot be checked is not claimed either way.
  }
  return savedStatus(paths, domain, uncovered);
}

/** Every site's status and Nginx coverage, from one read of the panel and of the state directory. */
function allStatuses(paths: MaintenanceActionPaths): { global: GlobalMaintenanceStatus; sites: MaintenanceSiteStatus[] } {
  let rows: { domain_name: string; type: unknown; user: unknown }[];
  let gaps: Map<string, string>;
  let db: Database;
  try {
    db = new Database(paths.panelDb, { readonly: true });
  } catch {
    failAction("CloudPanel's site database is unavailable");
  }
  try {
    db.exec("PRAGMA busy_timeout = 5000;");
    const standIns = standInDomains();
    rows = db.query<{ domain_name: string; type: unknown; user: unknown }, []>(
      "SELECT domain_name, type, user FROM site ORDER BY domain_name",
    ).all().filter((row) => !standIns.has(String(row.domain_name)));
    try { gaps = maintenanceGaps(db, coveragePaths(paths)); } catch { gaps = new Map(); }
  } catch {
    failAction("CloudPanel's site database could not be read");
  } finally {
    db.close();
  }
  const globalDir = siteDir(paths, "_global");
  const sites = rows.map((row): MaintenanceSiteStatus => {
    const type = typeof row.type === "string" ? row.type : "";
    const user = typeof row.user === "string" ? row.user : "";
    const domain = normalizeIdentityHostname(row.domain_name);
    const uncovered = gaps.get(row.domain_name) ?? null;
    try {
      if (!domain) failAction("CloudPanel records an invalid domain for this site");
      return { ...savedStatus(paths, domain, uncovered), type, user };
    } catch (error) {
      return {
        domain: row.domain_name, enabled: false, customTemplate: false, bypasses: [], uncovered, type, user,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
  return { global: { global: safeRegularFile(join(globalDir, "on"), 0), bypasses: bypasses(globalDir) }, sites };
}

/**
 * Removes the state of sites CloudPanel no longer has, so a domain created
 * again starts live with no bypasses or template. The global directory and
 * anything that is not a hostname's directory are left alone.
 */
export function pruneMaintenanceState(options: MaintenanceActionOptions = {}): string[] {
  const paths = pathsFor(options);
  let names: string[];
  try { names = readdirSync(paths.dataDir); } catch { return []; }
  const dirs = names.filter((name) => {
    if (normalizeIdentityHostname(name) !== name) return false;
    try { return lstatSync(join(paths.dataDir, name)).isDirectory(); } catch { return false; }
  });
  const gone = deletedSites(paths.panelDb, dirs);
  for (const name of gone) rmSync(join(paths.dataDir, name), { recursive: true, force: true });
  return gone;
}

/**
 * Invalidate CloudPanel's Varnish cache (if running on port 6081) for the domain.
 * Purges both the root host and its www/bare alias so visitors do not see stale
 * 200 responses when entering maintenance or stale 503 responses when leaving.
 */
export async function purgeVarnish(
  domain: string,
  port = 6081,
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  const hosts = [domain];
  if (domain.startsWith("www.")) {
    const bare = domain.slice(4);
    if (bare) hosts.push(bare);
  } else {
    hosts.push(`www.${domain}`);
  }

  const results = await Promise.all(
    hosts.map(async (host) => {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 1000);
        const res = await fetchFn(`http://127.0.0.1:${port}/`, {
          method: "PURGE",
          headers: { Host: host },
          signal: controller.signal,
        });
        clearTimeout(timeout);
        return res.ok;
      } catch {
        return false;
      }
    }),
  );

  return results.some(Boolean);
}

/**
 * Keep custom pages passive. Nginx also sends a restrictive CSP, but removing
 * active markup here makes the stored file safe if an operator serves it by
 * another path later.
 */
export function sanitizeTemplate(input: string): string {
  if (Buffer.byteLength(input, "utf8") > MAX_TEMPLATE_BYTES) {
    failAction(`the maintenance template may be at most ${MAX_TEMPLATE_BYTES} bytes`);
  }
  if (input.includes("\0")) failAction("the maintenance template contains a null byte");
  const forbidden = new Set([
    "script", "iframe", "object", "embed", "applet", "form", "base", "input",
    "button", "textarea", "select", "link",
  ]);
  const urlAttributes = new Set(["href", "src", "action", "formaction"]);
  const decodeAttribute = (value: string): string => value
    .replace(/&#(?:x([0-9a-f]+)|([0-9]+));?/gi, (_match, hex: string | undefined, decimal: string | undefined) => {
      const point = Number.parseInt(hex ?? decimal ?? "", hex ? 16 : 10);
      try { return Number.isInteger(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : ""; }
      catch { return ""; }
    })
    .replace(/&(colon|tab|newline);/gi, (entity) => {
      const name = entity.slice(1, -1).toLowerCase();
      return name === "colon" ? ":" : name === "tab" ? "\t" : "\n";
    });
  const html = new HTMLRewriter().on("*", {
    element(element) {
      const tag = element.tagName.toLowerCase();
      if (forbidden.has(tag)) {
        element.remove();
        return;
      }
      const httpEquiv = element.getAttribute("http-equiv");
      if (tag === "meta" && httpEquiv && decodeAttribute(httpEquiv).trim().toLowerCase() === "refresh") {
        element.remove();
        return;
      }
      for (const [rawName, rawValue] of element.attributes) {
        const name = rawName.toLowerCase();
        if (name.startsWith("on") || name === "srcdoc") {
          element.removeAttribute(rawName);
          continue;
        }
        if (!urlAttributes.has(name) && !name.endsWith(":href")) continue;
        const scheme = decodeAttribute(rawValue).replace(/[\u0000-\u0020]+/g, "").toLowerCase();
        if (scheme.startsWith("javascript:") || scheme.startsWith("vbscript:") || scheme.startsWith("data:text/html")) {
          element.removeAttribute(rawName);
        }
      }
    },
  }).transform(input);
  return html.trim() + "\n";
}

/** Purges the Varnish cache of each domain, eight at a time, within eight seconds. */
async function purgeVarnishMany(domains: string[], options: MaintenanceActionOptions): Promise<void> {
  const started = Date.now();
  let next = 0;
  const worker = async () => {
    while (next < domains.length && Date.now() - started < 8_000) {
      const domain = domains[next++];
      if (domain) await purgeVarnish(domain, options.varnishPort, options.fetchFn);
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, domains.length) }, () => worker()));
}

/** Turns maintenance on or off for many sites in one pass: one database read, one process. */
async function toggleMany(
  paths: MaintenanceActionPaths, enabled: boolean, input: string, options: MaintenanceActionOptions,
): Promise<{ enabled: boolean; updated: string[]; failed: { domain: string; error: string }[] }> {
  let requested: unknown;
  try { requested = (JSON.parse(input) as { domains?: unknown }).domains; } catch { failAction("expected JSON with a domains list"); }
  if (!Array.isArray(requested) || requested.length === 0) failAction("domains must list at least one site");
  let present: Set<string>;
  let db: Database;
  try {
    db = new Database(paths.panelDb, { readonly: true });
  } catch {
    failAction("CloudPanel's site database is unavailable");
  }
  try {
    db.exec("PRAGMA busy_timeout = 5000;");
    present = new Set(db.query<{ domain_name: string }, []>("SELECT lower(domain_name) AS domain_name FROM site").all()
      .map((row) => row.domain_name));
  } catch {
    failAction("CloudPanel's site database could not be read");
  } finally {
    db.close();
  }
  const updated: string[] = [];
  const failed: { domain: string; error: string }[] = [];
  for (const raw of requested) {
    const shown = typeof raw === "string" ? raw : String(raw);
    try {
      if (typeof raw !== "string") failAction("not a domain");
      const domain = options.domainValidator ? options.domainValidator(raw) : validateDomain(raw, paths.panelIdentityFile);
      if (!present.has(domain)) failAction(`CloudPanel site not found: '${domain}'`);
      const flag = join(siteDir(paths, domain, enabled), "on");
      if (enabled) writeAtomic(flag, "", 0o600);
      else rmSync(flag, { force: true });
      updated.push(domain);
    } catch (error) {
      failed.push({ domain: shown, error: error instanceof Error ? error.message : String(error) });
    }
  }
  await purgeVarnishMany(updated, options);
  return {
    enabled,
    updated: updated.sort((a, b) => a.localeCompare(b)),
    failed: failed.sort((a, b) => a.domain.localeCompare(b.domain)),
  };
}

function readInput(options: MaintenanceActionOptions): Promise<string> {
  if (options.input !== undefined) return Promise.resolve(options.input);
  return Bun.stdin.text();
}

export async function executeMaintenanceAction(
  argv: string[],
  options: MaintenanceActionOptions = {},
): Promise<unknown> {
  requireRoot(options);
  const paths = pathsFor(options);
  const { verb, domain } = parseAction(argv, paths, options);

  if (verb === "sites") return allStatuses(paths);
  if (verb === "enable-many" || verb === "disable-many") {
    return toggleMany(paths, verb === "enable-many", await readInput(options), options);
  }

  if (verb === "global-status") {
    const dir = siteDir(paths, "_global");
    return { global: safeRegularFile(join(dir, "on"), 0), bypasses: bypasses(dir) };
  }

  if (verb === "global-set-bypass") {
    const updated = await replaceBypasses(paths, "_global", options);
    return { global: safeRegularFile(join(paths.dataDir, "_global", "on"), 0), bypasses: updated };
  }

  if (verb === "global-enable" || verb === "global-disable") {
    ensureDataDir(paths);
    const globalDir = join(paths.dataDir, "_global");
    assertDirectory(globalDir);
    mkdirSync(globalDir, { recursive: true, mode: 0o711 });
    chmodSync(globalDir, 0o711);
    mkdirSync(paths.lockDir, { recursive: true, mode: 0o755 });
    const onPath = join(globalDir, "on");

    const enabled = verb === "global-enable";
    await withFileLock(
      join(paths.lockDir, "maintenance-_global.lock"),
      10,
      "another maintenance update is running for global fleet",
      async () => {
        if (enabled) {
          writeAtomic(onPath, "", 0o644);
        } else {
          if (existsSync(onPath)) rmSync(onPath, { force: true });
        }
      },
    );

    try {
      const db = new Database(paths.panelDb, { readonly: true });
      let domainNames: string[] = [];
      try {
        db.exec("PRAGMA busy_timeout = 5000;");
        domainNames = db.query<{ domain_name: string }, []>(
          "SELECT domain_name FROM site",
        ).all().map((r) => r.domain_name);
      } finally {
        db.close();
      }

      await purgeVarnishMany(domainNames, options);
    } catch {
      // panelDb may not exist in some unit tests or mock environments
    }

    return { ok: true, global: enabled };
  }

  assertPanelSite(paths, domain);

  if (verb === "status") return maintenanceStatus(paths, domain);

  if (verb === "enable" || verb === "disable") {
    const dir = siteDir(paths, domain, verb === "enable");
    const flag = join(dir, "on");
    if (verb === "enable") writeAtomic(flag, "", 0o600);
    else rmSync(flag, { force: true });
    await purgeVarnish(domain, options.varnishPort, options.fetchFn);
    return maintenanceStatus(paths, domain);
  }

  if (verb === "get-template") {
    ensureDataDir(paths);
    const custom = join(siteDir(paths, domain), "maintenance.html");
    return {
      domain,
      custom: safeRegularFile(custom),
      html: safeRegularFile(custom) ? readFileSync(custom, "utf8") : DEFAULT_MAINTENANCE_PAGE,
    };
  }

  if (verb === "set-template") {
    const input = await readInput(options);
    const html = sanitizeTemplate(input);
    writeAtomic(join(siteDir(paths, domain, true), "maintenance.html"), html, 0o644);
    return { domain, custom: true, html, removed: html.trim() !== input.trim() };
  }

  if (verb === "reset-template") {
    rmSync(join(siteDir(paths, domain), "maintenance.html"), { force: true });
    ensureDataDir(paths);
    return { domain, custom: false, html: DEFAULT_MAINTENANCE_PAGE };
  }

  await replaceBypasses(paths, domain, options);
  return maintenanceStatus(paths, domain);
}

export async function runMaintenanceAction(
  argv: string[],
  options: MaintenanceActionOptions = {},
): Promise<number> {
  try {
    const data = await executeMaintenanceAction(argv, options);
    if (options.emitReply !== false) emitActionOk(data);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.emitReply !== false) emitActionError(message, error instanceof ActionFailure ? error.data : undefined, "maintenance");
    return 1;
  }
}

export { DEFAULT_MAINTENANCE_PAGE as DEFAULT_MAINTENANCE_TEMPLATE };

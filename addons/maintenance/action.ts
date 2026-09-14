import { Database } from "bun:sqlite";
import { isIP } from "node:net";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync,
} from "node:fs";
import { join } from "node:path";
import {
  ActionFailure, emitActionError, emitActionOk, failAction, PANEL_IDENTITY_PATH, withFileLock,
  validateDomain,
} from "../../cli/action-common";
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
}

export interface MaintenanceActionPaths {
  dataDir: string;
  lockDir: string;
  panelDb: string;
  panelIdentityFile: string;
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
};

type MaintenanceVerb =
  | "status"
  | "enable"
  | "disable"
  | "get-template"
  | "set-template"
  | "reset-template"
  | "set-bypass"
  | "global-status"
  | "global-enable"
  | "global-disable";

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
    "global-status", "global-enable", "global-disable",
  ];
  if (verb && globalAllowed.includes(verb)) {
    if (argv.length > 1) failAction(`action ${verb} takes no arguments`);
    return { verb, domain: "" };
  }
  if (!verb || !siteAllowed.includes(verb)) {
    failAction("usage: clp-addons action maintenance {status|enable|disable|get-template|set-template|reset-template|set-bypass} --domain <domain> | {global-status|global-enable|global-disable}");
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

export function maintenanceStatus(paths: MaintenanceActionPaths, domain: string): MaintenanceStatus {
  assertPanelSite(paths, domain);
  const dir = siteDir(paths, domain);
  return {
    domain,
    enabled: safeRegularFile(join(dir, "on"), 0),
    customTemplate: safeRegularFile(join(dir, "maintenance.html")),
    bypasses: bypasses(dir),
  };
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

  if (verb === "global-status") {
    const onPath = join(paths.dataDir, "_global", "on");
    return { global: existsSync(onPath) && safeRegularFile(onPath) };
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

      const CONCURRENCY = 8;
      const PURGE_BUDGET_MS = 8_000;
      const start = Date.now();
      let idx = 0;

      const worker = async () => {
        while (idx < domainNames.length && Date.now() - start < PURGE_BUDGET_MS) {
          const domain = domainNames[idx++];
          if (domain) {
            await purgeVarnish(domain, options.varnishPort, options.fetchFn);
          }
        }
      };

      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, domainNames.length) }, () => worker()),
      );
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
    const html = sanitizeTemplate(await readInput(options));
    writeAtomic(join(siteDir(paths, domain, true), "maintenance.html"), html, 0o644);
    return { domain, custom: true, html };
  }

  if (verb === "reset-template") {
    rmSync(join(siteDir(paths, domain), "maintenance.html"), { force: true });
    ensureDataDir(paths);
    return { domain, custom: false, html: DEFAULT_MAINTENANCE_PAGE };
  }

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
  const ips = [...new Set(values.map(normalizeIp))].sort((a, b) => a.localeCompare(b));
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
      const stage = mkdtempSync(join(dir, ".bypass-stage-"));
      try {
        // Complete every fallible write before changing the active set.
        for (const ip of ips) (options.writeAtomicFn ?? writeAtomic)(join(stage, ip), "", 0o600);
        for (const name of readdirSync(dir)) {
          if (name.startsWith("bypass_")) rmSync(join(dir, name), { force: true });
        }
        for (const ip of ips) renameSync(join(stage, ip), join(dir, `bypass_${ip}`));
      } finally {
        rmSync(stage, { recursive: true, force: true });
      }
      return maintenanceStatus(paths, domain);
    },
  );
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

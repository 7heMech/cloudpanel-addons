import { Database } from "bun:sqlite";
import {
  chmodSync, chownSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  ActionFailure, emitActionError, emitActionOk, failAction, runCommand, validateFlag, withFileLock,
  type CommandResult,
} from "../../cli/action-common";
import { PANEL_DB, STATE_DIR } from "../../cli/paths";

const POLICY_VERSION = 1;
const MAX_SITES_PER_REQUEST = 10_000;
const HOST_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOST_RE = new RegExp(`^(?:${HOST_LABEL})(?:\\.${HOST_LABEL})+$`);
const CLOUDFLARE_INCLUDE = "include /etc/nginx/cloudflare/ips;";

export type CloudflareVerb = "list" | "set" | "policy" | "reconcile";

export interface CloudflareActionPaths {
  panelDb: string;
  nginxVhostDir: string;
  policyFile: string;
  lockFile: string;
  nginx: string;
  systemctl: string;
  vhostUid: number;
  stateUid: number;
}

export interface CloudflareActionOptions {
  paths?: Partial<CloudflareActionPaths>;
  input?: string;
  emitReply?: boolean;
  run?: (command: string, args: string[]) => CommandResult;
}

export interface CloudflareSiteView {
  domain: string;
  type: string;
  enabled: boolean;
  excludedFromAutomatic: boolean;
}

interface SiteRow {
  id: number;
  domain_name: string;
  user: string;
  type: string;
  allow_traffic_from_cloudflare_only: number | boolean;
}

interface Policy {
  version: 1;
  autoEnableNewSites: boolean;
  knownSiteIds: number[];
  excludedDomains: string[];
}

interface ParsedAction {
  verb: CloudflareVerb;
  enabled: boolean | null;
}

interface VhostBackup {
  path: string;
  content: string;
  mode: number;
  uid: number;
  gid: number;
}

export const DEFAULT_CLOUDFLARE_ACTION_PATHS: CloudflareActionPaths = {
  panelDb: PANEL_DB,
  nginxVhostDir: "/etc/nginx/sites-enabled",
  policyFile: `${STATE_DIR}/cloudflare-ips/policy.json`,
  lockFile: "/run/lock/clp-addons/cloudflare-ips.lock",
  nginx: "nginx",
  systemctl: "systemctl",
  vhostUid: 0,
  stateUid: 0,
};

function pathsFor(options: CloudflareActionOptions): CloudflareActionPaths {
  return { ...DEFAULT_CLOUDFLARE_ACTION_PATHS, ...options.paths };
}

function emptyPolicy(): Policy {
  return { version: POLICY_VERSION, autoEnableNewSites: false, knownSiteIds: [], excludedDomains: [] };
}

function normalizeDomain(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 253) return null;
  let domain = value.toLowerCase();
  if (domain.endsWith(".")) domain = domain.slice(0, -1);
  const match = domain.match(HOST_RE);
  return match?.[0] === domain ? domain : null;
}

function stablePolicy(value: Policy): Policy {
  return {
    version: POLICY_VERSION,
    autoEnableNewSites: value.autoEnableNewSites,
    knownSiteIds: [...new Set(value.knownSiteIds.filter((id) => Number.isInteger(id) && id > 0))].sort((a, b) => a - b),
    excludedDomains: [...new Set(value.excludedDomains.map(normalizeDomain).filter((v): v is string => v !== null))].sort(),
  };
}

function readPolicy(path: string, expectedUid: number): Policy {
  if (!existsSync(path)) return emptyPolicy();
  let raw: unknown;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== expectedUid || (stat.mode & 0o022) !== 0) {
      failAction("Cloudflare IP policy file is not a trusted regular file");
    }
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    failAction(`Cloudflare IP policy could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof raw !== "object" || raw === null) failAction("Cloudflare IP policy is malformed");
  const policy = raw as Partial<Policy>;
  if (
    policy.version !== POLICY_VERSION || typeof policy.autoEnableNewSites !== "boolean" ||
    !Array.isArray(policy.knownSiteIds) || !policy.knownSiteIds.every(Number.isInteger) ||
    !Array.isArray(policy.excludedDomains) || !policy.excludedDomains.every((item) => typeof item === "string")
  ) failAction("Cloudflare IP policy is malformed");
  return stablePolicy(policy as Policy);
}

function writeAtomicOwned(path: string, content: string, mode: number, uid: number, gid: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp.${process.pid}.${Math.random().toString(16).slice(2)}`;
  try {
    writeFileSync(temporary, content, { flag: "wx", mode });
    chmodSync(temporary, mode);
    chownSync(temporary, uid, gid);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function writePolicy(path: string, policy: Policy, expectedUid: number): void {
  let uid = expectedUid;
  let gid = process.getgid?.() ?? 0;
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== expectedUid || (stat.mode & 0o022) !== 0) {
      failAction("Cloudflare IP policy file is not a trusted regular file");
    }
    uid = stat.uid;
    gid = stat.gid;
  }
  writeAtomicOwned(path, `${JSON.stringify(stablePolicy(policy), null, 2)}\n`, 0o600, uid, gid);
}

function openPanelDatabase(path: string): Database {
  try {
    const db = new Database(path, { create: false, readwrite: true });
    db.exec("PRAGMA busy_timeout = 5000;");
    return db;
  } catch (error) {
    failAction(`CloudPanel database could not be opened: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function siteRows(db: Database): SiteRow[] {
  try {
    return db.query<SiteRow, []>(
      "SELECT id, domain_name, user, type, allow_traffic_from_cloudflare_only FROM site ORDER BY domain_name;",
    ).all().map((row) => ({ ...row, id: Number(row.id), domain_name: String(row.domain_name), user: String(row.user), type: String(row.type) }));
  } catch (error) {
    failAction(`CloudPanel does not expose the required Cloudflare site setting: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseAction(argv: string[]): ParsedAction {
  const verb = argv[0] as CloudflareVerb | undefined;
  if (!verb || !["list", "set", "policy", "reconcile"].includes(verb)) {
    failAction(`unknown Cloudflare IP action '${verb ?? ""}'`);
  }
  let enabled: boolean | null = null;
  if (verb === "set" || verb === "policy") {
    if (argv.length !== 3 || argv[1] !== "--enabled") failAction(`${verb} takes only --enabled yes|no`);
    enabled = validateFlag(argv[2]!, "enabled") === "yes";
  } else if (argv.length !== 1) {
    failAction(`${verb} takes no arguments`);
  }
  return { verb, enabled };
}

function requestedDomains(input: string | undefined): string[] {
  let raw: unknown;
  try {
    raw = JSON.parse(input ?? readFileSync(0, "utf8"));
  } catch {
    failAction("set input must be JSON");
  }
  const values = (raw as { domains?: unknown } | null)?.domains;
  if (!Array.isArray(values) || values.length === 0 || values.length > MAX_SITES_PER_REQUEST) {
    failAction(`set requires between 1 and ${MAX_SITES_PER_REQUEST} domains`);
  }
  const domains = values.map(normalizeDomain);
  if (domains.some((domain) => domain === null)) failAction("set input contains an invalid domain");
  return [...new Set(domains as string[])];
}

function trustedVhost(path: string, expectedUid: number): VhostBackup {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== expectedUid || (stat.mode & 0o022) !== 0) {
    failAction(`refusing untrusted Nginx vhost ${path}`);
  }
  return {
    path,
    content: readFileSync(path, "utf8"),
    mode: stat.mode & 0o777,
    uid: stat.uid,
    gid: stat.gid,
  };
}

function escapedRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Applies the same two rendered-vhost changes as CloudPanel's own form. */
export function transformVhost(content: string, siteUser: string, enabled: boolean): string {
  const access = new RegExp(
    `^([ \\t]*access_log[ \\t]+/home/${escapedRegex(siteUser)}/logs/nginx/access\\.log[ \\t]+)(main|cloudflare)([ \\t]*;[ \\t]*)$`,
    "gm",
  );
  const matches = [...content.matchAll(access)];
  if (matches.length !== 1) failAction("the site's generated Nginx access-log marker is missing or ambiguous");

  let result = content.replace(access, `$1${enabled ? "cloudflare" : "main"}$3`);
  const includeLine = new RegExp(`^[ \\t]*${escapedRegex(CLOUDFLARE_INCLUDE)}[ \\t]*(?:\\r?\\n|$)`, "gm");
  result = result.replace(includeLine, "");
  if (enabled) {
    access.lastIndex = 0;
    result = result.replace(access, (line) => `${line}\n  ${CLOUDFLARE_INCLUDE}`);
  }
  return result;
}

function commandError(label: string, result: CommandResult): string {
  return `${label} failed: ${(result.stderr || result.stdout || `exit ${result.exitCode ?? "unknown"}`).trim()}`;
}

function restoreVhosts(backups: VhostBackup[]): void {
  for (const backup of backups) {
    writeAtomicOwned(backup.path, backup.content, backup.mode, backup.uid, backup.gid);
  }
}

/** Updates selected DB rows and rendered vhosts, validating and reloading once. */
async function updateSites(
  paths: CloudflareActionPaths,
  domains: string[],
  enabled: boolean,
  command: (command: string, args: string[]) => CommandResult,
): Promise<{ changed: number; sites: SiteRow[] }> {
  const db = openPanelDatabase(paths.panelDb);
  const backups: VhostBackup[] = [];
  let wroteVhosts = false;
  let attemptedReload = false;
  try {
    db.exec("BEGIN IMMEDIATE;");
    const allSites = siteRows(db);
    const wanted = new Set(domains);
    const selected = allSites.filter((site) => wanted.has(site.domain_name));
    const found = new Set(selected.map((site) => site.domain_name));
    const missing = domains.filter((domain) => !found.has(domain));
    if (missing.length) failAction(`no CloudPanel site found for: ${missing.join(", ")}`);

    const staged = selected.map((site) => {
      const domain = normalizeDomain(site.domain_name);
      if (!domain || domain !== site.domain_name) failAction(`CloudPanel returned an invalid site domain '${site.domain_name}'`);
      const backup = trustedVhost(join(paths.nginxVhostDir, `${domain}.conf`), paths.vhostUid);
      backups.push(backup);
      return { backup, content: transformVhost(backup.content, site.user, enabled) };
    });

    const update = db.query("UPDATE site SET allow_traffic_from_cloudflare_only = ?, updated_at = CURRENT_TIMESTAMP WHERE domain_name = ?;");
    for (const site of selected) update.run(enabled ? 1 : 0, site.domain_name);
    for (const item of staged) {
      if (item.content === item.backup.content) continue;
      writeAtomicOwned(item.backup.path, item.content, item.backup.mode, item.backup.uid, item.backup.gid);
      wroteVhosts = true;
    }

    const checked = command(paths.nginx, ["-t"]);
    if (!checked.ok) throw new Error(commandError("Nginx validation", checked));
    const reloaded = command(paths.systemctl, ["reload", "nginx"]);
    attemptedReload = true;
    if (!reloaded.ok) throw new Error(commandError("Nginx reload", reloaded));
    db.exec("COMMIT;");

    return {
      changed: selected.filter((site) => Boolean(site.allow_traffic_from_cloudflare_only) !== enabled).length,
      sites: allSites.map((site) => wanted.has(site.domain_name)
        ? { ...site, allow_traffic_from_cloudflare_only: enabled ? 1 : 0 }
        : site),
    };
  } catch (error) {
    try { db.exec("ROLLBACK;"); } catch {}
    if (wroteVhosts) {
      try {
        restoreVhosts(backups);
        const restored = command(paths.nginx, ["-t"]);
        if (restored.ok && attemptedReload) command(paths.systemctl, ["reload", "nginx"]);
      } catch {}
    }
    throw error;
  } finally {
    db.close();
  }
}

function listState(paths: CloudflareActionPaths): { sites: CloudflareSiteView[]; autoEnableNewSites: boolean } {
  const db = openPanelDatabase(paths.panelDb);
  try {
    const policy = readPolicy(paths.policyFile, paths.stateUid);
    const excluded = new Set(policy.excludedDomains);
    return {
      sites: siteRows(db).map((site) => ({
        domain: site.domain_name,
        type: site.type,
        enabled: Boolean(site.allow_traffic_from_cloudflare_only),
        excludedFromAutomatic: excluded.has(site.domain_name),
      })),
      autoEnableNewSites: policy.autoEnableNewSites,
    };
  } finally {
    db.close();
  }
}

async function withPolicyLock<T>(paths: CloudflareActionPaths, body: () => Promise<T>): Promise<T> {
  mkdirSync(dirname(paths.lockFile), { recursive: true });
  chmodSync(dirname(paths.lockFile), 0o700);
  return withFileLock(paths.lockFile, 30, "another Cloudflare IP operation is running", body);
}

async function setPolicy(paths: CloudflareActionPaths, enabled: boolean): Promise<Policy> {
  return withPolicyLock(paths, async () => {
    const policy = readPolicy(paths.policyFile, paths.stateUid);
    const db = openPanelDatabase(paths.panelDb);
    try {
      policy.autoEnableNewSites = enabled;
      if (enabled) policy.knownSiteIds = siteRows(db).map((site) => site.id);
      writePolicy(paths.policyFile, policy, paths.stateUid);
      return stablePolicy(policy);
    } finally {
      db.close();
    }
  });
}

async function setSelected(
  paths: CloudflareActionPaths,
  domains: string[],
  enabled: boolean,
  command: (command: string, args: string[]) => CommandResult,
): Promise<{ changed: number }> {
  return withPolicyLock(paths, async () => {
    const before = existsSync(paths.policyFile) ? readFileSync(paths.policyFile, "utf8") : null;
    const policy = readPolicy(paths.policyFile, paths.stateUid);
    const excluded = new Set(policy.excludedDomains);
    for (const domain of domains) enabled ? excluded.delete(domain) : excluded.add(domain);
    policy.excludedDomains = [...excluded];

    const db = openPanelDatabase(paths.panelDb);
    try {
      const selected = siteRows(db).filter((site) => domains.includes(site.domain_name));
      policy.knownSiteIds.push(...selected.map((site) => site.id));
    } finally {
      db.close();
    }

    writePolicy(paths.policyFile, policy, paths.stateUid);
    try {
      const result = await updateSites(paths, domains, enabled, command);
      return { changed: result.changed };
    } catch (error) {
      try {
        if (before === null) rmSync(paths.policyFile, { force: true });
        else {
          const stat = lstatSync(paths.policyFile);
          writeAtomicOwned(paths.policyFile, before, 0o600, stat.uid, stat.gid);
        }
      } catch {}
      throw error;
    }
  });
}

export async function reconcileNewSites(
  paths: CloudflareActionPaths = DEFAULT_CLOUDFLARE_ACTION_PATHS,
  command: (command: string, args: string[]) => CommandResult = runCommand,
): Promise<{ discovered: number; enabled: number }> {
  return withPolicyLock(paths, async () => {
    const policy = readPolicy(paths.policyFile, paths.stateUid);
    if (!policy.autoEnableNewSites) return { discovered: 0, enabled: 0 };

    const db = openPanelDatabase(paths.panelDb);
    let sites: SiteRow[];
    try { sites = siteRows(db); } finally { db.close(); }
    const currentIds = new Set(sites.map((site) => site.id));
    const known = new Set(policy.knownSiteIds.filter((id) => currentIds.has(id)));
    const discovered = sites.filter((site) => !known.has(site.id));
    const excluded = new Set(policy.excludedDomains);
    const enable = discovered.filter((site) => !excluded.has(site.domain_name) && !Boolean(site.allow_traffic_from_cloudflare_only));

    if (enable.length) await updateSites(paths, enable.map((site) => site.domain_name), true, command);
    policy.knownSiteIds = sites.map((site) => site.id);
    writePolicy(paths.policyFile, policy, paths.stateUid);
    return { discovered: discovered.length, enabled: enable.length };
  });
}

function requireRoot(): void {
  if (process.getuid?.() !== 0) failAction("Cloudflare IP actions must run as root");
}

export async function runCloudflareAction(argv: string[], options: CloudflareActionOptions = {}): Promise<number> {
  const emit = options.emitReply !== false;
  try {
    requireRoot();
    const paths = pathsFor(options);
    const action = parseAction(argv);
    const command = options.run ?? runCommand;
    let data: unknown;
    if (action.verb === "list") data = listState(paths);
    else if (action.verb === "policy") {
      const policy = await setPolicy(paths, action.enabled!);
      data = { autoEnableNewSites: policy.autoEnableNewSites };
    } else if (action.verb === "set") {
      data = await setSelected(paths, requestedDomains(options.input), action.enabled!, command);
    } else data = await reconcileNewSites(paths, command);
    if (emit) emitActionOk(data);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (emit) emitActionError(message, error instanceof ActionFailure ? error.data : undefined, "cloudflare-ips");
    else process.stderr.write(`[cloudflare-ips] ERROR: ${message}\n`);
    return 1;
  }
}

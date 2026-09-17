import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import {
  chmodSync, closeSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, writeSync,
} from "node:fs";
import { join } from "node:path";
import { CLI_BIN } from "../../cli/paths";
import { writeFileAtomic } from "../../lib/atomic-write";
import {
  createJobDir, createJobLog, findOlderThan, jobCommonFields, jobDir as storeJobDir, jobGet, jobSet,
  jobTimestamp, listJobIds, newJobId, pruneJobs, readJobLog, startJobUnit, watchJobRecord,
} from "../../cli/job-store";
import {
  ActionCommandFailure, ActionFailure, acquireFileLock, actionErrorJson, commandFailure, emitActionError, emitActionOk,
  dbNameFor, dbUserFor, failAction, normalizeIdentityHostname, PANEL_IDENTITY_PATH, readable, readPanelIdentity,
  runCommand, siteUserFor, validateDomain, validateEmail, validateFlag, validateJob, validateMfa, validatePort,
  type CommandResult, type FileLockHandle,
} from "../../cli/action-common";

const JOB_RETENTION_DAYS = 14;
const PORT_MIN = 39000;
const PORT_MAX = 39999;
const CLONABLE_TYPES = ["php", "static", "reverse-proxy"] as const;

export type StagerVerb = "sites" | "jobs" | "prune" | "describe" | "clone" | "promote" | "run" | "job" | "watch-job";

/**
 * What a promote leaves behind from the live site rather than taking from the
 * staging copy.
 *
 * The configuration files carry the live database credentials and its key
 * material: taking the staging copy's would point the live site at the staging
 * database, which is worse than any missing edit. The uploads directory is
 * where the live site writes what its visitors send it, and none of that exists
 * on the staging copy.
 */
/**
 * What the live site owns and a promote must not replace with the staging
 * site's copy.
 *
 * Split by what it costs to have twice. The two configuration files are small
 * and are the ones whose absence is not a cosmetic fault: a document root with
 * no `wp-config.php` is a WordPress that offers its installer to whoever asks.
 * They are copied into the staged root before it goes live, so the root that
 * becomes live is complete at the instant it does. `wp-content/uploads` can be
 * gigabytes, so it is moved onto the new root after the switch; a moment
 * without it costs images, not a site.
 */
const PRESERVED_COPIED = ["wp-config.php", ".env"] as const;
const PRESERVED_MOVED = ["wp-content/uploads"] as const;
const PRESERVED_PATHS = [...PRESERVED_COPIED, ...PRESERVED_MOVED] as const;

export interface StagerActionPaths {
  lockDir: string;
  dataBaseDir: string;
  jobsDir: string;
  panelDb: string;
  clpctl: string;
  panelIdentityFile: string;
  nginxVhostDir: string;
  instaticDataDir: string;
  actionBinary: string;
  tempDir: string;
  sqlite3: string;
  emitReply?: boolean;
}

export const DEFAULT_STAGER_ACTION_PATHS: StagerActionPaths = {
  lockDir: "/run/lock/clp-addons",
  dataBaseDir: "/var/lib/clp-addons/stager",
  jobsDir: "/var/lib/clp-addons/stager/jobs",
  panelDb: "/home/clp/htdocs/app/data/db.sq3",
  clpctl: "/usr/bin/clpctl",
  panelIdentityFile: PANEL_IDENTITY_PATH,
  nginxVhostDir: "/etc/nginx/sites-enabled",
  instaticDataDir: "/var/lib/clp-addons/instatic",
  actionBinary: CLI_BIN,
  tempDir: "/tmp",
  sqlite3: "sqlite3",
};

export interface ParsedStagerAction {
  verb: StagerVerb;
  source: string;
  target: string;
  domain: string;
  job: string;
  tls: string;
  port: string;
  email: string;
  targetEmail: string;
}

export interface StagerActionOptions {
  paths?: Partial<StagerActionPaths>;
  /** Emit the action's JSON reply on stdout. Defaults to true for CLI callers. */
  emitReply?: boolean;
}

interface SiteRow {
  type: string;
  user: string;
  root: string;
  application: string;
}

interface InstaticBackend {
  port: string;
  tag: string;
}

let instaticReject = "";

interface JobResult {
  siteType: string;
  siteUser: string;
  phpVersion: string;
  vhostTemplate: string;
  vhostCarried: boolean;
  vhostCarriedBy: string;
  database: { source: string; name: string; user: string; password: string } | null;
  instatic: { port: number; tag: string; email: string; password: string } | null;
  notes: string[];
}

interface JobView {
  id: string;
  kind: string;
  source: string;
  target: string;
  port: number;
  state: string;
  step: string;
  error: string;
  createdAt: string;
  startedAt: string;
  finishedAt: string;
  result: unknown;
  panelSite: boolean | null;
}

function pathsFor(options?: StagerActionOptions): StagerActionPaths {
  return {
    ...DEFAULT_STAGER_ACTION_PATHS,
    ...options?.paths,
    emitReply: options?.emitReply !== false,
  };
}

function emitStagerOk(paths: StagerActionPaths, data: unknown): void {
  if (paths.emitReply !== false) emitActionOk(data);
}

function emitStagerError(message: string, data: unknown, emitReply: boolean): void {
  if (emitReply) {
    emitActionError(message, data, "stager");
  } else {
    process.stderr.write(`[stager] ERROR: ${message}\n`);
  }
}

function requireRoot(): void {
  if (process.getuid?.() !== 0) failAction("stager actions must run as root");
}

function parseAction(argv: string[], paths: StagerActionPaths): ParsedStagerAction {
  if (argv.length === 0) {
    failAction("usage: clp-addons action stager {sites|describe|clone|run|job|watch-job|jobs|prune} [options]");
  }

  const verb = argv[0] as string;
  let source = "";
  let target = "";
  let domain = "";
  let job = "";
  let tls = "no";
  let port = "";
  let email = "";
  let targetEmail = "";

  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag !== "--source" && flag !== "--target" && flag !== "--domain" && flag !== "--job" &&
        flag !== "--tls" && flag !== "--port" && flag !== "--email" && flag !== "--target-email") {
      failAction(`unknown argument: '${flag}'`);
    }
    const value = argv[i + 1];
    if (value === undefined) failAction(`${flag} needs a value`);
    i++;
    if (flag === "--source") source = value;
    else if (flag === "--target") target = value;
    else if (flag === "--domain") domain = value;
    else if (flag === "--job") job = value;
    else if (flag === "--tls") tls = value;
    else if (flag === "--port") port = value;
    else if (flag === "--email") email = value;
    else targetEmail = value;
  }

  switch (verb) {
    case "sites":
    case "jobs":
      break;
    case "prune":
      break;
    case "describe":
      domain = validateDomain(domain, paths.panelIdentityFile, "domain");
      break;
    case "clone":
      source = validateDomain(source, paths.panelIdentityFile, "source");
      target = validateDomain(target, paths.panelIdentityFile, "target");
      validateFlag(tls, "tls");
      if (port) validatePort(port);
      if (email) validateEmail(email);
      break;
    case "promote":
      source = validateDomain(source, paths.panelIdentityFile, "source");
      target = validateDomain(target, paths.panelIdentityFile, "target");
      if (email) validateEmail(email);
      if (targetEmail) validateEmail(targetEmail);
      break;
    case "run":
    case "job":
    case "watch-job":
      job = validateJob(job);
      break;
    default:
      failAction(`unknown verb: '${verb}'`);
  }

  switch (verb) {
    case "clone":
      if (domain || job || targetEmail) {
        failAction("clone takes --source, --target, --tls and, for an Instatic site, --port and --email");
      }
      break;
    case "promote":
      if (domain || job || tls !== "no" || port) {
        failAction("promote takes --source, --target and, for an Instatic site, --email and --target-email");
      }
      break;
    case "describe":
      if (source || target || job || tls !== "no" || port || email || targetEmail) failAction("describe takes only --domain");
      break;
    case "run":
    case "job":
    case "watch-job":
      if (source || target || domain || tls !== "no" || port || email || targetEmail) failAction(`${verb} takes only --job`);
      break;
    case "sites":
    case "jobs":
    case "prune":
      if (source || target || domain || job || tls !== "no" || port || email || targetEmail) {
        failAction(`${verb} takes no arguments`);
      }
      break;
  }

  return { verb: verb as StagerVerb, source, target, domain, job, tls, port, email, targetEmail };
}

function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function readFlatField(file: string, field: string): string {
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    return "";
  }
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`.*"${escaped}"\\s*:\\s*"?([^",}\\n]*)"?[^\\n]*$`);
  for (const line of content.split("\n")) {
    const match = line.match(pattern);
    if (match) return match[1] ?? "";
  }
  return "";
}

// The job record itself lives in cli/job-store; this only supplies the addon's
// jobs directory so the call sites can stay as they were.
function jobDir(paths: StagerActionPaths, id: string): string {
  return storeJobDir(paths.jobsDir, id);
}

function generatedPassword(): string {
  return `Aa1${randomBytes(24).toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 16)}!`;
}

function generatedDbPassword(): string {
  return randomBytes(24).toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 24);
}

function userTaken(user: string): boolean {
  return runCommand("getent", ["passwd", user]).ok;
}

function queryPanel<T>(paths: StagerActionPaths, query: (db: Database) => T): T {
  if (!readable(paths.panelDb)) throw new Error("panel database is not readable");
  const db = new Database(paths.panelDb, { readonly: true });
  try {
    return query(db);
  } finally {
    db.close();
  }
}

function siteExists(paths: StagerActionPaths, domain: string): boolean {
  if (!readable(paths.panelDb)) return false;
  try {
    const count = queryPanel(paths, (db) => {
      const row = db.query("SELECT COUNT(*) AS count FROM site WHERE domain_name = ?;").get(domain) as { count?: number | string } | null;
      return Number(row?.count ?? 0);
    });
    return count > 0;
  } catch {
    return false;
  }
}

function siteRow(paths: StagerActionPaths, domain: string): SiteRow | null {
  return queryPanel(paths, (db) => {
    const row = db.query(
      "SELECT type, user, root_directory, COALESCE(application, '') AS application FROM site WHERE domain_name = ?;",
    ).get(domain) as { type?: unknown; user?: unknown; root_directory?: unknown; application?: unknown } | null;
    if (!row) return null;
    return {
      type: typeof row.type === "string" ? row.type : "",
      user: typeof row.user === "string" ? row.user : "",
      root: typeof row.root_directory === "string" ? row.root_directory : "",
      application: typeof row.application === "string" ? row.application : "",
    };
  });
}

function phpVersionOf(paths: StagerActionPaths, domain: string): string {
  return queryPanel(paths, (db) => {
    const row = db.query(
      "SELECT p.php_version FROM php_settings p JOIN site s ON s.id = p.site_id WHERE s.domain_name = ?;",
    ).get(domain) as { php_version?: unknown } | null;
    return typeof row?.php_version === "string" ? row.php_version : String(row?.php_version ?? "");
  });
}

function databaseOf(paths: StagerActionPaths, domain: string): string {
  return queryPanel(paths, (db) => {
    const row = db.query(
      "SELECT d.name FROM database d JOIN site s ON s.id = d.site_id WHERE s.domain_name = ? ORDER BY d.id LIMIT 1;",
    ).get(domain) as { name?: unknown } | null;
    return typeof row?.name === "string" ? row.name : String(row?.name ?? "");
  });
}

function vhostOf(paths: StagerActionPaths, domain: string): string {
  return queryPanel(paths, (db) => {
    const row = db.query("SELECT vhost_template FROM site WHERE domain_name = ?;").get(domain) as { vhost_template?: unknown } | null;
    return typeof row?.vhost_template === "string" ? row.vhost_template : String(row?.vhost_template ?? "");
  });
}

function applicationOf(paths: StagerActionPaths, domain: string): string {
  return queryPanel(paths, (db) => {
    const row = db.query("SELECT COALESCE(application, '') AS application FROM site WHERE domain_name = ?;").get(domain) as { application?: unknown } | null;
    return typeof row?.application === "string" ? row.application : String(row?.application ?? "");
  });
}

function reverseProxyUrlOf(paths: StagerActionPaths, domain: string): string {
  return queryPanel(paths, (db) => {
    const row = db.query("SELECT COALESCE(reverse_proxy_url, '') AS url FROM site WHERE domain_name = ?;").get(domain) as { url?: unknown } | null;
    return typeof row?.url === "string" ? row.url : String(row?.url ?? "");
  });
}

function panelDomains(paths: StagerActionPaths): { readable: boolean; domains: Set<string> } {
  if (!readable(paths.panelDb)) return { readable: false, domains: new Set() };
  try {
    const rows = queryPanel(paths, (db) => db.query("SELECT domain_name FROM site;").all() as Array<{ domain_name?: unknown }>);
    return { readable: true, domains: new Set(rows.map((row) => typeof row.domain_name === "string" ? row.domain_name : "")) };
  } catch {
    return { readable: true, domains: new Set() };
  }
}

export function applicationOk(value: string): boolean {
  return /^[A-Za-z0-9]([A-Za-z0-9 ._-]{0,62}[A-Za-z0-9])?$/.test(value);
}

function typeIsClonable(type: string): boolean {
  return (CLONABLE_TYPES as readonly string[]).includes(type);
}

function instaticMeta(paths: StagerActionPaths, domain: string, field: string): string {
  return readFlatField(join(paths.instaticDataDir, domain, "meta.json"), field);
}

function instaticBackendOf(paths: StagerActionPaths, domain: string): InstaticBackend | null {
  instaticReject = "";
  try {
    if ((statSync(paths.actionBinary).mode & 0o111) === 0) {
      instaticReject = "the Instatic addon is not installed on this server, so there is no supported way to duplicate the backend";
      return null;
    }
  } catch {
    instaticReject = "the Instatic addon is not installed on this server, so there is no supported way to duplicate the backend";
    return null;
  }
  const meta = join(paths.instaticDataDir, domain, "meta.json");
  if (!isRegularFile(meta)) {
    instaticReject = "its backend is not an Instatic instance this box manages; cloning would point the staging hostname at the live application";
    return null;
  }
  const port = instaticMeta(paths, domain, "port");
  const tag = instaticMeta(paths, domain, "tag");
  if (!/^[0-9]{1,5}$/.test(port) || !/^\d+\.\d+\.\d+$/.test(tag)) {
    instaticReject = `the Instatic record for ${domain} is incomplete`;
    return null;
  }
  let url = "";
  try {
    url = reverseProxyUrlOf(paths, domain);
  } catch {
    url = "";
  }
  if (url !== `http://127.0.0.1:${port}`) {
    instaticReject = `it proxies '${url}' rather than the Instatic instance recorded for it; cloning would point the staging hostname at whatever that is`;
    return null;
  }
  return { port, tag };
}

function forwardCommandOutput(result: CommandResult): void {
  if (result.stdout) diagnostic(result.stdout);
  if (result.stderr) diagnostic(result.stderr);
}

function runStdoutAsDiagnostic(command: string, args: string[]): boolean {
  const result = runCommand(command, args);
  if (result.stdout) diagnostic(result.stdout);
  return result.ok;
}

/**
 * Create the empty file a command is about to write a secret into.
 *
 * Exclusive creation, not "w": between the unlink and the open, "w" would
 * follow a symlink left at that name, and curl would then write the response --
 * session cookies included -- wherever it pointed.
 */
function tempSecretFile(path: string): void {
  rmSync(path, { force: true });
  closeSync(openSync(path, "wx", 0o600));
}

/**
 * Persist a secret: an Instatic request body carrying a password.
 *
 * Through the atomic writer rather than a plain write, because writeFileSync
 * applies its mode only when it *creates* the file. Writing over a path that
 * already existed kept that path's old permissions, and the chmod that fixed
 * them ran after the secret was already on disk -- a window, however short, in
 * which the password sat in a file anyone could read.
 */
function writeSecretFile(path: string, value: string): void {
  writeFileAtomic(path, value, { mode: 0o600 });
}

function jsonField(path: string, field: string): string {
  return readFlatField(path, field);
}

let activeTranscript: JobTranscript | null = null;

function diagnostic(value: string): void {
  if (activeTranscript) activeTranscript.write(value);
  else process.stderr.write(value);
}

function logLine(value: string): void {
  diagnostic(`[stager] ${value}\n`);
}

function warnLine(value: string): void {
  diagnostic(`[stager] WARN: ${value}\n`);
}

class JobTranscript {
  private fd: number;

  constructor(readonly path: string) {
    this.fd = openSync(path, "a", 0o600);
    chmodSync(path, 0o600);
  }

  write(value: string): void {
    try {
      const bytes = Buffer.from(value);
      writeSync(this.fd, bytes);
    } catch {
      // A transcript write must never put a secret back on the system journal.
    }
  }

  close(): void {
    closeSync(this.fd);
  }
}

class JobFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobFailure";
  }
}

class RunReplyFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunReplyFailure";
  }
}

function failJob(ctx: { dir: string; failed: boolean }, message: string): never {
  ctx.failed = true;
  try {
    jobSet(ctx.dir, "error", message);
    jobSet(ctx.dir, "state", "failed");
  } catch {
    // Keep the original failure message; the rollback still removes secrets.
  }
  diagnostic(`[stager] ERROR: ${message}\n`);
  throw new JobFailure(message);
}

interface RunContext {
  id: string;
  dir: string;
  paths: StagerActionPaths;
  source: string;
  target: string;
  tls: string;
  port: string;
  email: string;
  mfa: string;
  step: string;
  rollbackActive: boolean;
  failed: boolean;
  siteCreated: boolean;
  siteViaInstatic: boolean;
  dbCreated: boolean;
  dumpFile: string;
  stgDbName: string;
  stgDbUser: string;
  stgDbPass: string;
  templateName: string;
  templateStage: string;
  templateFile: string;
  vhostStage: string;
  srcPort: string;
  srcTag: string;
  exportZip: string;
  srcUser: string;
  stgUser: string;
  srcType: string;
  srcRoot: string;
  srcApp: string;
  phpVersion: string;
  srcDb: string;
  cloneApplication: string;
  vhostCarried: boolean;
  vhostBy: string;
  notes: string[];
}

function setStep(ctx: { dir: string; step: string }, value: string): void {
  ctx.step = value;
  jobSet(ctx.dir, "step", value);
  logLine(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function hostnameBoundary(domain: string): RegExp {
  return new RegExp(`(^|[^A-Za-z0-9.-])${escapeRegExp(domain)}([^A-Za-z0-9-]|$)`, "g");
}

function stripTrailingNewlines(value: string): string {
  return value.replace(/\n+$/g, "");
}

export function stripRedirectBlock(body: string): string {
  const lines = body.split("\n");
  if (lines.length === 0 || !/^server \{/.test(lines[0]!)) return body;

  let depth = 1;
  let redirect = false;
  const block: string[] = [`${lines[0]}\n`];
  let index = 1;
  for (; index < lines.length; index++) {
    const line = lines[index]!;
    block.push(`${line}\n`);
    depth += (line.match(/\{/g) ?? []).length;
    depth -= (line.match(/\}/g) ?? []).length;
    if (line.includes("return 301")) redirect = true;
    if (depth === 0) {
      index++;
      break;
    }
  }
  if (depth !== 0) return "";
  return redirect ? lines.slice(index).join("\n") : block.join("") + lines.slice(index).join("\n");
}

export function takeRedirectBlock(body: string): string {
  const lines = body.split("\n");
  if (lines.length === 0 || !/^server \{/.test(lines[0]!)) return "";

  let depth = 1;
  let redirect = false;
  const block: string[] = [`${lines[0]}\n`];
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index]!;
    block.push(`${line}\n`);
    depth += (line.match(/\{/g) ?? []).length;
    depth -= (line.match(/\}/g) ?? []).length;
    if (line.includes("return 301")) redirect = true;
    if (depth === 0) return redirect ? block.join("").replace(/\n+$/g, "") : "";
  }
  return "";
}

export function foldServerName(body: string, domain: string, replacement: string): string {
  const escaped = escapeRegExp(domain);
  const generatedApex = new RegExp(`^(\\s*)server_name ${escaped} www1\\.${escaped};\\s*$`);
  const generatedSubdomain = new RegExp(`^(\\s*)server_name ${escaped};\\s*$`);
  return body.split("\n").map((line) => {
    const apex = line.match(generatedApex);
    if (apex) return `${apex[1]}${replacement}`;
    const subdomain = line.match(generatedSubdomain);
    return subdomain ? `${subdomain[1]}${replacement}` : line;
  }).join("\n");
}

export function generatedServerName(body: string, domain: string): string {
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line === `server_name ${domain};` || line === `server_name ${domain} www1.${domain};`) return line;
  }
  return "";
}

export function vhostShape(body: string, domain: string): string {
  const shaped = foldServerName(stripRedirectBlock(body), domain, "server_name {GENERATED};")
    .split("\n")
    .filter((line) => !/^\s*$/.test(line))
    .join("\n");
  return shaped;
}

function vhostDiffers(paths: StagerActionPaths, source: string, target: string, srcUser: string, stgUser: string): boolean {
  let sourceBody: string;
  let targetBody: string;
  try {
    sourceBody = stripTrailingNewlines(vhostOf(paths, source));
    targetBody = stripTrailingNewlines(vhostOf(paths, target));
  } catch {
    return false;
  }
  if (!sourceBody || !targetBody) return false;
  let left = vhostShape(sourceBody, source);
  const right = vhostShape(targetBody, target);
  if (!left || !right) return false;
  left = left.split(source).join(target).split(srcUser).join(stgUser);
  return left !== right;
}

let vhostTemplateReject = "";

function makeClpStage(paths: StagerActionPaths): string | null {
  try {
    const dir = mkdtempSync(join(paths.tempDir, "clp-stager-stage."));
    const owner = runCommand("chown", ["root:clp", dir]);
    if (!owner.ok) {
      rmSync(dir, { recursive: true, force: true });
      return null;
    }
    chmodSync(dir, 0o710);
    return dir;
  } catch {
    return null;
  }
}

function dropTemplateStage(ctx: RunContext): void {
  if (!ctx.templateStage) return;
  rmSync(ctx.templateStage, { recursive: true, force: true });
  ctx.templateStage = "";
  ctx.templateFile = "";
}

function dropVhostStage(ctx: RunContext): void {
  if (!ctx.vhostStage) return;
  rmSync(ctx.vhostStage, { recursive: true, force: true });
  ctx.vhostStage = "";
}

export function vhostTemplateBodyFromContent(body: string, source: string, target: string): string | null {
  if (!body) return null;
  let candidate = foldServerName(stripRedirectBlock(body), source, "{{server_name}}");
  candidate = candidate.replace(hostnameBoundary(source), `$1${target}$2`);
  return candidate || null;
}

function vhostTemplateBody(paths: StagerActionPaths, source: string, target: string): string | null {
  let body: string;
  try {
    body = stripTrailingNewlines(vhostOf(paths, source));
  } catch {
    return null;
  }
  return vhostTemplateBodyFromContent(body, source, target);
}

function buildVhostTemplate(ctx: RunContext): boolean {
  const candidate = vhostTemplateBody(ctx.paths, ctx.source, ctx.target);
  if (!candidate) return false;
  const stage = makeClpStage(ctx.paths);
  if (!stage) return false;
  const file = join(stage, "vhost.tpl");
  try {
    writeFileSync(file, `${candidate}\n`, { mode: 0o640 });
    const owner = runCommand("chown", ["root:clp", file]);
    if (!owner.ok) throw new Error("chown failed");
    chmodSync(file, 0o640);
  } catch {
    rmSync(stage, { recursive: true, force: true });
    return false;
  }
  ctx.templateStage = stage;
  ctx.templateFile = file;
  return true;
}

function vhostTemplateExists(paths: StagerActionPaths, name: string): boolean {
  if (!applicationOk(name)) return false;
  try {
    const count = queryPanel(paths, (db) => {
      const row = db.query("SELECT COUNT(*) AS count FROM vhost_template WHERE name = ?;").get(name) as { count?: number | string } | null;
      return Number(row?.count ?? 0);
    });
    return count > 0;
  } catch {
    return false;
  }
}

function vhostTemplateOk(file: string, source: string, target: string): boolean {
  vhostTemplateReject = "";
  let body: string;
  try {
    body = readFileSync(file, "utf8");
  } catch {
    vhostTemplateReject = "the source's vhost could not be read";
    return false;
  }
  const result = validateVhostTemplateBody(body, source, target);
  vhostTemplateReject = result.reason;
  return result.ok;
}

export function serverNameHosts(body: string): string[] {
  const hosts: string[] = [];
  let token = "";
  let naming = false;
  let quote = "";
  const flush = () => {
    if (!token) return;
    if (naming) hosts.push(token.toLowerCase());
    else if (token === "server_name") naming = true;
    token = "";
  };

  for (let index = 0; index < body.length; index++) {
    const character = body[index]!;
    if (quote) {
      if (character === "\\") {
        index++;
        token += body[index] ?? "";
        continue;
      }
      if (character === quote) {
        quote = "";
        continue;
      }
      token += character;
      continue;
    }
    if (character === '"' || character === "'") {
      if (token) return ["\u0001quote-inside-token"];
      quote = character;
      continue;
    }
    if (character === "#") {
      if (!token) {
        const newline = body.indexOf("\n", index);
        index = newline === -1 ? body.length : newline;
        continue;
      }
      token += character;
      continue;
    }
    if (character === ";" || character === "{" || character === "}") {
      flush();
      naming = false;
      continue;
    }
    if (character === " " || character === "\t" || character === "\r" || character === "\n") {
      flush();
      continue;
    }
    token += character;
  }
  flush();
  if (quote) hosts.push("\u0001unterminated-quote");
  return hosts;
}

let vhostReject = "";

function vhostBodyOk(body: string, source: string, target: string): boolean {
  vhostReject = "";
  const boundary = hostnameBoundary(source);
  const leak = new RegExp(boundary.source, "gi");
  leak.lastIndex = 0;
  const lines = body.split("\n");
  const leakedLines = lines.filter((line) => {
    leak.lastIndex = 0;
    return leak.test(line);
  }).length;
  if (leakedLines > 0) {
    vhostReject = `the source hostname still appears on ${leakedLines} line(s) after substitution`;
    return false;
  }

  const hosts = serverNameHosts(body);
  const normalizedTarget = target.toLowerCase();
  for (const token of hosts) {
    const host = token.startsWith("*.") ? token.slice(2) : token;
    if (host !== normalizedTarget && !host.endsWith(`.${normalizedTarget}`)) {
      vhostReject = `a server_name names '${token}', which is not ${target} or below it`;
      return false;
    }
  }
  return true;
}

export function validateVhostBody(body: string, source: string, target: string): { ok: boolean; reason: string } {
  const ok = vhostBodyOk(body, source, target);
  return { ok, reason: ok ? "" : vhostReject };
}

export function validateVhostTemplateBody(body: string, source: string, target: string): { ok: boolean; reason: string } {
  if (!body.includes("{{server_name}}")) {
    return {
      ok: false,
      reason: "the source's server_name is hand edited, so CloudPanel's {{server_name}} placeholder cannot be kept",
    };
  }
  return validateVhostBody(body, source, target);
}

export interface VhostMapResult {
  map: Map<string, string> | null;
  reason: string;
}

export function learnVhostMapContent(template: string, renderedInput: string): VhostMapResult {
  let rendered = renderedInput.replace(/\n$/, "");
  const reject = (reason: string): VhostMapResult => ({ map: null, reason });
  const literals: string[] = [];
  const keys: string[] = [];
  let rest = template;
  while (rest.includes("{{")) {
    const start = rest.indexOf("{{");
    literals.push(rest.slice(0, start));
    rest = rest.slice(start + 2);
    const end = rest.indexOf("}}");
    if (end === -1) return reject("the template has an invalid placeholder");
    const key = rest.slice(0, end);
    rest = rest.slice(end + 2);
    if (!/^[a-zA-Z0-9_]+$/.test(key)) return reject(`the template has an invalid placeholder {{${key}}}`);
    keys.push(key);
  }
  literals.push(rest);
  const count = keys.length;
  if (count === 0) return { map: new Map(), reason: "" };
  for (let index = 1; index < count; index++) {
    if (!literals[index]) return reject(`{{${keys[index - 1]}}} and {{${keys[index]}}} are next to each other`);
  }

  const forward = new Map<string, string>();
  let remaining = rendered;
  for (let index = 0; index < count; index++) {
    const key = keys[index]!;
    const literal = literals[index]!;
    if (!remaining.startsWith(literal)) return reject(`the rendered vhost does not start with the text before {{${key}}}`);
    remaining = remaining.slice(literal.length);
    let value: string;
    if (index + 1 < count) {
      const next = literals[index + 1]!;
      const position = remaining.indexOf(next);
      if (position === -1) return reject(`the rendered vhost does not contain the text after {{${key}}}`);
      value = remaining.slice(0, position);
    } else {
      const tail = literals[count]!;
      if (tail && !remaining.endsWith(tail)) return reject(`the rendered vhost does not end with the text after {{${key}}}`);
      value = tail ? remaining.slice(0, -tail.length) : remaining;
    }
    remaining = remaining.slice(value.length);
    const old = forward.get(key);
    if (old !== undefined && old !== value) return reject(`{{${key}}} resolves more than one way`);
    forward.set(key, value);
  }
  if (remaining !== literals[count]) return reject("the rendered vhost was not consumed completely");

  const backward = new Map<string, string>();
  let before = rendered;
  const finalLiteral = literals[count]!;
  if (finalLiteral) {
    if (!before.endsWith(finalLiteral)) return reject(`the rendered vhost does not end with the text after {{${keys[count - 1]}}}`);
    before = before.slice(0, -finalLiteral.length);
  }
  for (let index = count - 1; index >= 0; index--) {
    const key = keys[index]!;
    const literal = literals[index]!;
    let value: string;
    if (!literal) {
      value = before;
      before = "";
    } else {
      const position = before.lastIndexOf(literal);
      if (position === -1) return reject(`the rendered vhost does not contain the text before {{${key}}}`);
      value = before.slice(position + literal.length);
      before = before.slice(0, position);
    }
    const old = backward.get(key);
    if (old !== undefined && old !== value) return reject(`{{${key}}} resolves more than one way`);
    backward.set(key, value);
  }
  if (before) return reject("the rendered vhost was not consumed completely");

  const result = new Map<string, string>();
  for (const [key, value] of forward) {
    if (backward.get(key) !== value) return reject(`{{${key}}} resolves more than one way`);
    result.set(key, value);
  }
  return { map: result, reason: "" };
}

function learnVhostMap(storedPath: string, renderedPath: string): Map<string, string> | null {
  try {
    return learnVhostMapContent(readFileSync(storedPath, "utf8"), readFileSync(renderedPath, "utf8")).map;
  } catch {
    return null;
  }
}

export function renderVhostBodyResult(body: string, mapping: Map<string, string>): { value: string | null; reason: string } {
  let output = "";
  let rest = body;
  while (rest.includes("{{")) {
    const start = rest.indexOf("{{");
    output += rest.slice(0, start);
    rest = rest.slice(start + 2);
    const end = rest.indexOf("}}");
    if (end === -1) return { value: null, reason: "the template has an invalid placeholder" };
    const key = rest.slice(0, end);
    rest = rest.slice(end + 2);
    if (!/^[a-zA-Z0-9_]+$/.test(key)) return { value: null, reason: `the placeholder {{${key}}} is invalid` };
    if (!mapping.has(key)) return { value: null, reason: `the panel never fills the placeholder {{${key}}}` };
    output += mapping.get(key)!;
  }
  return { value: output + rest, reason: "" };
}

function renderVhostBody(body: string, mapping: Map<string, string>): string | null {
  return renderVhostBodyResult(body, mapping).value;
}

export function composeVhostBodyContent(sourceBodyInput: string, targetBodyInput: string, source: string, target: string): string | null {
  const sourceBody = stripTrailingNewlines(sourceBodyInput);
  const targetBody = stripTrailingNewlines(targetBodyInput);
  if (!sourceBody || !targetBody) return null;
  const nameLine = generatedServerName(targetBody, target);
  if (!nameLine) return null;

  let candidate = foldServerName(stripRedirectBlock(sourceBody), source, nameLine);
  candidate = candidate.replace(hostnameBoundary(source), `$1${target}$2`);
  const lines = candidate.split("\n");
  while (lines.length && /^\s*$/.test(lines[0]!)) lines.shift();
  candidate = lines.join("\n").replace(/\n+$/g, "");
  if (!candidate) return null;

  const redirect = takeRedirectBlock(targetBody);
  return redirect ? `${redirect}\n\n${candidate}` : candidate;
}

function composeVhostBody(paths: StagerActionPaths, source: string, target: string): string | null {
  let sourceBody: string;
  let targetBody: string;
  try {
    sourceBody = stripTrailingNewlines(vhostOf(paths, source));
    targetBody = stripTrailingNewlines(vhostOf(paths, target));
  } catch {
    return null;
  }
  return composeVhostBodyContent(sourceBody, targetBody, source, target);
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

let panelWriteReject = "";

function panelUpdateSite(ctx: RunContext, type: string, application: string, bodyFile = ""): boolean {
  panelWriteReject = "";
  if (!ctx.siteCreated) {
    panelWriteReject = "refusing to write the panel record of a site this job did not create";
    return false;
  }
  if (!readable(ctx.paths.panelDb)) {
    panelWriteReject = "the panel database is not readable";
    return false;
  }
  if (!applicationOk(application)) {
    panelWriteReject = `refusing to record '${application}' as the clone's application: not a name CloudPanel could have written`;
    return false;
  }
  if (bodyFile && !isRegularFile(bodyFile)) {
    panelWriteReject = "the composed vhost was not staged";
    return false;
  }

  const stage = makeClpStage(ctx.paths);
  if (!stage) {
    panelWriteReject = "a staging directory for the panel write could not be created";
    return false;
  }
  const appFile = join(stage, "application");
  try {
    // No trailing newline: this is compared byte-for-byte against SQLite.
    writeFileSync(appFile, application, { mode: 0o640 });
    const owner = runCommand("chown", ["root:clp", appFile]);
    if (owner.ok) chmodSync(appFile, 0o640);

    const setVhost = bodyFile ? `vhost_template = CAST(readfile(${sqlLiteral(bodyFile)}) AS TEXT), ` : "";
    const statement = [
      "PRAGMA busy_timeout=5000;",
      "UPDATE site",
      `   SET ${setVhost}application = CAST(readfile(${sqlLiteral(appFile)}) AS TEXT),`,
      "       updated_at = datetime('now')",
      ` WHERE domain_name = ${sqlLiteral(ctx.target)} AND type = ${sqlLiteral(type)};`,
    ].join("\n");
    // Keep the mutation in CloudPanel's clp-owned sqlite process. The panel
    // database uses rollback journals; a root-owned journal left by a crash
    // can prevent the clp-owned panel from recovering it. Readback below is
    // native Bun SQLite, so the CLI is needed only for this ownership boundary.
    const updated = runCommand("runuser", ["-u", "clp", "--", ctx.paths.sqlite3, ctx.paths.panelDb, statement]);
    if (updated.stderr) diagnostic(updated.stderr);
    if (!updated.ok) {
      panelWriteReject = "the panel database refused the update";
      return false;
    }

    const expectedVhost = bodyFile ? readFileSync(bodyFile, "utf8") : "";
    const check = queryPanel(ctx.paths, (db) => {
      const row = db.query(
        "SELECT application, vhost_template FROM site WHERE domain_name = ? AND type = ?;",
      ).get(ctx.target, type) as { application?: unknown; vhost_template?: unknown } | null;
      return row !== null
        && row.application === application
        && (!bodyFile || row.vhost_template === expectedVhost);
    });
    if (!check) {
      panelWriteReject = "the panel record does not read back as it was written";
      return false;
    }
    return true;
  } catch {
    panelWriteReject = "the panel database refused the update";
    return false;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

export function vhostBackupPath(paths: StagerActionPaths, domain: string): string {
  return join(paths.nginxVhostDir, `${domain}.conf.clp-stager-bak`);
}

function carryVhost(ctx: RunContext, type: string, application: string): { ok: boolean; reason: string } {
  const conf = join(ctx.paths.nginxVhostDir, `${ctx.target}.conf`);
  if (!isRegularFile(conf)) return { ok: false, reason: "CloudPanel wrote no vhost file for the clone" };

  dropVhostStage(ctx);
  const stage = makeClpStage(ctx.paths);
  if (!stage) return { ok: false, reason: "a staging directory could not be created" };
  ctx.vhostStage = stage;
  const stock = join(stage, "stock.tpl");
  const body = join(stage, "body.tpl");
  const rendered = join(stage, "rendered.conf");
  const backup = vhostBackupPath(ctx.paths, ctx.target);

  const restore = (row: boolean, reason: string) => {
    try {
      copyFileSync(backup, conf);
      const owner = runCommand("chown", ["root:root", conf]);
      if (owner.ok) chmodSync(conf, 0o644);
    } catch {
      warnLine(`could not restore the stock vhost for ${ctx.target}`);
    }
    rmSync(backup, { force: true });
    if (row && !panelUpdateSite(ctx, type, application, stock)) {
      warnLine(`the panel record for ${ctx.target} may still hold the carried vhost; check Site -> Vhost`);
    }
    return reason;
  };

  let vhostTemplate: string;
  try {
    vhostTemplate = vhostOf(ctx.paths, ctx.target);
  } catch {
    return { ok: false, reason: "the clone's own stored vhost could not be queried" };
  }
  if (!vhostTemplate) {
    return { ok: false, reason: "the clone's own stored vhost could not be read back" };
  }
  try {
    writeFileSync(stock, vhostTemplate, { mode: 0o640 });
    const stockOwner = runCommand("chown", ["root:clp", stock]);
    if (stockOwner.ok) chmodSync(stock, 0o640);
  } catch {
    return { ok: false, reason: "the clone's stock vhost could not be written to disk" };
  }

  const mapping = learnVhostMap(stock, conf);
  if (!mapping) return { ok: false, reason: "the clone's stored and rendered vhosts could not be matched" };
  const composed = composeVhostBody(ctx.paths, ctx.source, ctx.target);
  if (composed === null) return { ok: false, reason: "the source and clone vhosts could not be composed" };
  writeFileSync(body, composed, { mode: 0o640 });
  const bodyOwner = runCommand("chown", ["root:clp", body]);
  if (bodyOwner.ok) chmodSync(body, 0o640);

  if (!vhostBodyOk(composed, ctx.source, ctx.target)) return { ok: false, reason: vhostReject };
  const renderedBody = renderVhostBody(composed, mapping);
  if (renderedBody === null) return { ok: false, reason: "the composed vhost uses a placeholder the clone did not render" };
  writeFileSync(rendered, `${renderedBody}\n`, { mode: 0o640 });
  const renderedOwner = runCommand("chown", ["root:root", rendered]);
  if (renderedOwner.ok) chmodSync(rendered, 0o644);

  try {
    copyFileSync(conf, backup);
    chmodSync(backup, 0o600);
  } catch {
    return { ok: false, reason: "the clone's vhost could not be backed up" };
  }

  try {
    copyFileSync(rendered, conf);
    const owner = runCommand("chown", ["root:root", conf]);
    if (!owner.ok) throw new Error("chown failed");
    chmodSync(conf, 0o644);
  } catch {
    return { ok: false, reason: restore(false, "the carried vhost could not be written to the clone") };
  }

  const checked = runCommand("nginx", ["-t"]);
  if (!checked.ok) {
    if (checked.stdout) diagnostic(checked.stdout);
    if (checked.stderr) diagnostic(checked.stderr);
    return { ok: false, reason: restore(false, "nginx rejected the carried config, so the clone keeps the stock one") };
  }

  if (!panelUpdateSite(ctx, type, application, body)) {
    return { ok: false, reason: restore(true, panelWriteReject) };
  }

  const reloaded = runCommand("systemctl", ["reload", "nginx"]);
  if (reloaded.stdout) diagnostic(reloaded.stdout);
  if (reloaded.stderr) diagnostic(reloaded.stderr);
  if (!reloaded.ok) {
    const reason = restore(true, "nginx would not reload the carried config, so the clone keeps the stock one");
    const restored = runCommand("systemctl", ["reload", "nginx"]);
    if (restored.stdout) diagnostic(restored.stdout);
    if (restored.stderr) diagnostic(restored.stderr);
    if (!restored.ok) warnLine(`nginx did not reload after restoring ${ctx.target}`);
    return { ok: false, reason };
  }
  rmSync(backup, { force: true });
  return { ok: true, reason: "" };
}

export function jobStateFor(paths: StagerActionPaths, target: string): string {
  let entries: string[];
  try {
    entries = readdirSync(paths.jobsDir).sort().reverse();
  } catch {
    return "";
  }
  for (const entry of entries) {
    const dir = jobDir(paths, entry);
    if (!isDirectory(dir)) continue;
    if (jobGet(dir, "target") !== target) continue;
    if (jobGet(dir, "kind") === "promote") continue;
    return jobGet(dir, "state");
  }
  return "";
}

export function recoverCarriedVhosts(paths: StagerActionPaths): number {
  let entries: string[];
  try {
    entries = readdirSync(paths.nginxVhostDir).filter((name) => name.endsWith(".conf.clp-stager-bak"));
  } catch {
    return 0;
  }
  let recovered = 0;
  for (const entry of entries) {
    const backup = join(paths.nginxVhostDir, entry);
    if (!isRegularFile(backup)) continue;
    const domain = entry.slice(0, -".conf.clp-stager-bak".length);
    const state = jobStateFor(paths, domain);
    if (state === "queued" || state === "running") continue;
    if (state === "done") {
      rmSync(backup, { force: true });
      continue;
    }
    warnLine(`restoring the stock vhost for ${domain}: a clone was interrupted while carrying one across`);
    try {
      copyFileSync(backup, join(paths.nginxVhostDir, `${domain}.conf`));
      const owner = runCommand("chown", ["root:root", join(paths.nginxVhostDir, `${domain}.conf`)]);
      if (!owner.ok) throw new Error("chown failed");
      chmodSync(join(paths.nginxVhostDir, `${domain}.conf`), 0o644);
      recovered++;
    } catch {
      warnLine(`could not restore the stock vhost for ${domain}`);
    }
    rmSync(backup, { force: true });
  }
  if (recovered > 0) {
    const checked = runCommand("nginx", ["-t"]);
    if (checked.ok) {
      const reloaded = runCommand("systemctl", ["reload", "nginx"]);
      if (!reloaded.ok) warnLine(`nginx did not reload after recovering ${recovered} vhost(s)`);
    } else {
      warnLine(`nginx still rejects its configuration after recovering ${recovered} vhost(s); not reloading`);
    }
  }
  return recovered;
}

function instaticError(path: string): string {
  try {
    return readFileSync(path, "utf8").slice(0, 400).replace(/[\u0000-\u001f]/g, "") || "no response body";
  } catch {
    return "no response body";
  }
}

function instaticBody(path: string, body: unknown): void {
  writeSecretFile(path, JSON.stringify(body));
}

function instaticPost(
  ctx: { dir: string },
  port: string,
  domain: string,
  jar: string,
  path: string,
  contentType: string,
  request: string,
  output: string,
): string {
  tempSecretFile(output);
  const result = runCommand("curl", [
    "-sS", "--max-time", "900", "-o", output, "-w", "%{http_code}",
    "-c", jar, "-b", jar, "-X", "POST", `http://127.0.0.1:${port}${path}`,
    "-H", `Origin: https://${domain}`, "-H", `Content-Type: ${contentType}`,
    "--data-binary", `@${request}`,
  ]);
  if (result.stderr) diagnostic(result.stderr);
  // curl prints 000 for a failed connection. A failed process without that
  // status has the same meaning to the caller and must not become an empty reply.
  return result.stdout.trim() || "000";
}

function instaticGet(ctx: { dir: string }, port: string, domain: string, jar: string, path: string, output: string): string {
  tempSecretFile(output);
  const result = runCommand("curl", [
    "-sS", "--max-time", "900", "-o", output, "-w", "%{http_code}",
    "-c", jar, "-b", jar, `http://127.0.0.1:${port}${path}`,
    "-H", `Origin: https://${domain}`,
  ]);
  if (result.stderr) diagnostic(result.stderr);
  return result.stdout.trim() || "000";
}

function instaticLogin(
  ctx: { dir: string },
  port: string,
  domain: string,
  jar: string,
  email: string,
  password: string,
  mfa: string,
  what: string,
): { ok: boolean; reason: string } {
  const request = join(ctx.dir, ".api-req");
  const output = join(ctx.dir, ".api-out");
  tempSecretFile(jar);
  instaticBody(request, { email, password });
  let code = instaticPost(ctx, port, domain, jar, "/admin/api/cms/login", "application/json", request, output);
  rmSync(request, { force: true });
  if (code !== "200") {
    const reason = `${what} refused the login (HTTP ${code}): ${instaticError(output)}`;
    rmSync(output, { force: true });
    return { ok: false, reason };
  }

  let response = "";
  try {
    response = readFileSync(output, "utf8");
  } catch {
    response = "";
  }
  if (response.includes('"mfaRequired":true')) {
    if (!mfa) {
      rmSync(output, { force: true });
      return { ok: false, reason: `${what} has multi-factor authentication enabled and no authentication code was supplied` };
    }
    instaticBody(request, { code: mfa });
    code = instaticPost(ctx, port, domain, jar, "/admin/api/cms/auth/mfa/verify", "application/json", request, output);
    rmSync(request, { force: true });
    if (code !== "200") {
      const reason = `${what} rejected the authentication code (HTTP ${code}): ${instaticError(output)}`;
      rmSync(output, { force: true });
      return { ok: false, reason };
    }
  }
  rmSync(output, { force: true });
  return { ok: true, reason: "" };
}

function instaticLogout(ctx: { dir: string }, port: string, domain: string, jar: string): void {
  if (!isRegularFile(jar)) return;
  const request = join(ctx.dir, ".api-req");
  const output = join(ctx.dir, ".api-out");
  instaticBody(request, {});
  instaticPost(ctx, port, domain, jar, "/admin/api/cms/logout", "application/json", request, output);
  rmSync(request, { force: true });
  rmSync(output, { force: true });
  rmSync(jar, { force: true });
}

function instaticStepUp(
  ctx: { dir: string },
  port: string,
  domain: string,
  jar: string,
  password: string,
  mfa: string,
): { ok: boolean; reason: string } {
  const request = join(ctx.dir, ".api-req");
  const output = join(ctx.dir, ".api-out");
  instaticBody(request, mfa ? { password, mfaCode: mfa } : { password });
  const code = instaticPost(ctx, port, domain, jar, "/admin/api/cms/auth/step-up", "application/json", request, output);
  rmSync(request, { force: true });
  if (code !== "200") {
    const reason = `the clone refused to open a step-up window (HTTP ${code}): ${instaticError(output)}`;
    rmSync(output, { force: true });
    return { ok: false, reason };
  }
  rmSync(output, { force: true });
  return { ok: true, reason: "" };
}

function instaticSetup(
  ctx: { dir: string },
  port: string,
  domain: string,
  jar: string,
  email: string,
  password: string,
): { ok: boolean; reason: string } {
  const request = join(ctx.dir, ".api-req");
  const output = join(ctx.dir, ".api-out");
  tempSecretFile(jar);
  instaticBody(request, { siteName: domain, email, password });
  const code = instaticPost(ctx, port, domain, jar, "/admin/api/cms/setup", "application/json", request, output);
  rmSync(request, { force: true });
  if (code !== "201") {
    const reason = `the clone would not bootstrap its owner (HTTP ${code}): ${instaticError(output)}`;
    rmSync(output, { force: true });
    return { ok: false, reason };
  }
  rmSync(output, { force: true });
  return { ok: true, reason: "" };
}

function runWpSearchReplace(user: string, path: string, from: string, to: string): boolean {
  const args = ["-u", user, "--", "env", `HOME=/home/${user}`, "wp", `--path=${path}`, "--skip-plugins", "--skip-themes", "search-replace"];
  if (readFileSyncSafe(join(path, "wp-config.php")).includes("DOMAIN_CURRENT_SITE")) {
    args.push(from, to, "--network");
  } else {
    args.push(`https://${from}`, `https://${to}`);
  }
  const result = runCommand("runuser", args);
  forwardCommandOutput(result);
  return result.ok;
}

function readFileSyncSafe(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function rewriteWpConfig(file: string, target: string, ctx: RunContext): void {
  let content = readFileSync(file, "utf8");
  content = content
    .replace(/define\( *'DB_NAME', *'[^']*' *\);/g, `define('DB_NAME', '${ctx.stgDbName}');`)
    .replace(/define\( *'DB_USER', *'[^']*' *\);/g, `define('DB_USER', '${ctx.stgDbUser}');`)
    .replace(/define\( *'DB_PASSWORD', *'[^']*' *\);/g, `define('DB_PASSWORD', '${ctx.stgDbPass}');`);
  if (content.includes("WP_HOME")) {
    content = content
      .replace(/define\( *'WP_HOME', *'[^']*' *\);/g, `define('WP_HOME', 'https://${target}');`)
      .replace(/define\( *'WP_SITEURL', *'[^']*' *\);/g, `define('WP_SITEURL', 'https://${target}');`);
  } else {
    content = content.replace(
      /define\( *'DB_PASSWORD', *'[^']*' *\);/,
      (match) => `${match}\ndefine('WP_HOME', 'https://${target}');\ndefine('WP_SITEURL', 'https://${target}');`,
    );
  }
  if (content.includes("DOMAIN_CURRENT_SITE")) {
    content = content.replace(/define\( *'DOMAIN_CURRENT_SITE', *'[^']*' *\);/g, `define('DOMAIN_CURRENT_SITE', '${target}');`);
  }
  writeFileSync(file, content);
}

function rewriteDotenv(file: string, ctx: RunContext): void {
  const content = readFileSync(file, "utf8").replace(/^DB_DATABASE=.*/gm, `DB_DATABASE=${ctx.stgDbName}`)
    .replace(/^DB_USERNAME=.*/gm, `DB_USERNAME=${ctx.stgDbUser}`)
    .replace(/^DB_PASSWORD=.*/gm, `DB_PASSWORD=${ctx.stgDbPass}`);
  writeFileSync(file, content);
}

async function runTarCopy(source: string, destination: string): Promise<number> {
  let sender: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;
  let receiver: Bun.Subprocess<ReadableStream, "pipe", "pipe"> | null = null;
  try {
    sender = Bun.spawn({
      cmd: ["tar", "-C", source, "-cf", "-", "."],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });
    receiver = Bun.spawn({
      cmd: ["tar", "-xf", "-", "-C", destination],
      stdin: sender.stdout,
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });
    const [senderStderr, receiverStdout, receiverStderr, senderCode, receiverCode] = await Promise.all([
      sender.stderr.text(),
      receiver.stdout.text(),
      receiver.stderr.text(),
      sender.exited,
      receiver.exited,
    ]);
    if (senderStderr) diagnostic(senderStderr);
    if (receiverStdout) diagnostic(receiverStdout);
    if (receiverStderr) diagnostic(receiverStderr);
    // tar itself uses exit 1 for a non-fatal warning (a file changed while it was
    // being read); only 2 or higher is a real failure, so that -- not a plain
    // nonzero check -- is the threshold here.
    if (senderCode >= 2) return senderCode;
    if (receiverCode >= 2) return receiverCode;
    return 0;
  } catch {
    sender?.kill();
    receiver?.kill();
    return 2;
  }
}

function removePathPrefix(value: string, prefix: string): string {
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function callInstatic(
  ctx: RunContext,
  args: string[],
): { ok: boolean; data?: Record<string, unknown>; error: string } {
  const result = runCommand(ctx.paths.actionBinary, ["action", "instatic", ...args]);
  if (result.stderr) diagnostic(result.stderr);
  let reply: unknown = null;
  try {
    reply = JSON.parse(result.stdout.trim());
  } catch {
    reply = null;
  }
  if (!reply || typeof reply !== "object" || Array.isArray(reply) || typeof (reply as { ok?: unknown }).ok !== "boolean") {
    return { ok: false, error: "the Instatic addon returned a malformed reply" };
  }
  const record = reply as { ok: boolean; data?: unknown; error?: unknown };
  const data = record.data && typeof record.data === "object" && !Array.isArray(record.data)
    ? record.data as Record<string, unknown>
    : undefined;
  return {
    ok: record.ok && result.ok,
    ...(data ? { data } : {}),
    error: typeof record.error === "string" ? record.error : "the Instatic action failed",
  };
}

export function parseCloneCredentials(input: string): { password: string; mfa: string } {
  let supplied = input;
  // The service always frames the channel with a final newline (see
  // startClone in addons/stager/app/service.ts). Remove only that one final
  // framing newline, then require exactly one separator between the password
  // and the authentication code.
  if (supplied.endsWith("\n")) supplied = supplied.slice(0, -1);
  if ((supplied.match(/\n/g) ?? []).length !== 1) failAction("the credential channel takes exactly two lines");
  const separator = supplied.indexOf("\n");
  const password = supplied.slice(0, separator);
  const mfa = supplied.slice(separator + 1);
  if (!password) failAction("cloning an Instatic site needs the source instance's admin password on stdin");
  if (password.length > 256) failAction("the password is too long");
  if (mfa.includes("\n")) failAction("stdin holds more than a password and an authentication code");
  if (mfa) validateMfa(mfa);
  return { password, mfa };
}

function readCloneCredentials(): { password: string; mfa: string } {
  try {
    return parseCloneCredentials(readFileSync(0, "utf8"));
  } catch (error) {
    if (error instanceof ActionFailure) throw error;
    failAction("the credential channel takes exactly two lines");
  }
}

/**
 * The promote credential channel: four lines, always.
 *
 * A promote between Instatic sites signs in twice -- once to export the
 * staging copy and once to import into the live instance -- so the channel
 * carries two passwords and two authentication codes. Fixed field count for
 * the same reason the clone channel has one: a channel whose length varies
 * cannot tell a password containing a newline from a password followed by a
 * code.
 */
export function parsePromoteCredentials(input: string): {
  password: string; mfa: string; targetPassword: string; targetMfa: string;
} {
  let supplied = input;
  if (supplied.endsWith("\n")) supplied = supplied.slice(0, -1);
  const lines = supplied.split("\n");
  if (lines.length !== 4) failAction("the credential channel takes exactly four lines");
  const [password, mfa, targetPassword, targetMfa] = lines as [string, string, string, string];
  if (!password) failAction("promoting an Instatic site needs the staging instance's admin password on stdin");
  if (!targetPassword) failAction("promoting an Instatic site needs the live instance's admin password on stdin");
  if (password.length > 256 || targetPassword.length > 256) failAction("the password is too long");
  if (mfa) validateMfa(mfa);
  if (targetMfa) validateMfa(targetMfa);
  return { password, mfa, targetPassword, targetMfa };
}

function readPromoteCredentials(): { password: string; mfa: string; targetPassword: string; targetMfa: string } {
  try {
    return parsePromoteCredentials(readFileSync(0, "utf8"));
  } catch (error) {
    if (error instanceof ActionFailure) throw error;
    failAction("the credential channel takes exactly four lines");
  }
}

function cmdSites(paths: StagerActionPaths): void {
  let rows: Array<{ domain_name?: unknown; type?: unknown; user?: unknown; php_version?: unknown; application?: unknown; databases?: unknown }>;
  try {
    rows = queryPanel(paths, (db) => db.query(`
      SELECT s.domain_name, s.type, s.user, COALESCE(p.php_version, '') AS php_version,
             COALESCE(s.application, '') AS application,
             (SELECT COUNT(*) FROM database d WHERE d.site_id = s.id) AS databases
        FROM site s LEFT JOIN php_settings p ON p.site_id = s.id
       WHERE s.type IN ('php','static','reverse-proxy')
       ORDER BY s.domain_name;
    `).all() as typeof rows);
  } catch {
    failAction("cannot read the panel database");
  }

  const sites: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const domain = typeof row.domain_name === "string" ? row.domain_name : "";
    const type = typeof row.type === "string" ? row.type : "";
    if (!domain) continue;
    if (type === "reverse-proxy" && !instaticBackendOf(paths, domain)) continue;
    sites.push({
      domain,
      siteType: type,
      siteUser: typeof row.user === "string" ? row.user : "",
      phpVersion: typeof row.php_version === "string" ? row.php_version : String(row.php_version ?? ""),
      application: typeof row.application === "string" ? row.application : String(row.application ?? ""),
      databases: Number(row.databases ?? 0) || 0,
    });
  }
  emitStagerOk(paths, { sites });
}

function cmdDescribe(paths: StagerActionPaths, domain: string): void {
  let row: SiteRow | null;
  try {
    row = siteRow(paths, domain);
  } catch {
    failAction("cannot read the panel database");
  }
  if (!row) failAction(`no CloudPanel site for ${domain}`);
  const type = row.type;
  if (!typeIsClonable(type)) {
    failAction(`${domain} is a '${type}' site; only ${CLONABLE_TYPES.join(" ")} sites can be cloned`);
  }

  let instatic = false;
  if (type === "reverse-proxy") {
    if (!instaticBackendOf(paths, domain)) failAction(`${domain} cannot be cloned: ${instaticReject || "its backend is not an Instatic instance this box manages"}`);
    instatic = true;
  }
  let php = "";
  if (type === "php") {
    try {
      php = phpVersionOf(paths, domain);
    } catch {
      // The original bash wrapper terminated under `set -e` when this query
      // failed, before ever printing a reply. This binary keeps the synchronous
      // JSON contract instead, and reports the read error explicitly.
      failAction("cannot read the panel database");
    }
  }
  let database = "";
  try {
    database = databaseOf(paths, domain);
  } catch {
    failAction("cannot read the panel database");
  }

  let sizeMb = 0;
  const root = `/home/${row.user}/htdocs/${domain}`;
  if (isDirectory(root)) {
    const size = runCommand("du", ["-sm", root]);
    const match = size.stdout.trim().match(/^([0-9]+)/);
    sizeMb = match ? Number(match[1]) || 0 : 0;
  }
  emitStagerOk(paths, {
    domain,
    siteType: type,
    instatic,
    siteUser: row.user,
    phpVersion: php,
    application: row.application || "Generic",
    rootDirectory: row.root,
    database,
    sizeMb,
  });
}

function cmdClone(action: ParsedStagerAction, paths: StagerActionPaths, releaseLock: () => void): void {
  const { source, target, tls, port, email } = action;
  if (source === target) failAction("the source and the target are the same site");
  if (!siteExists(paths, source)) failAction(`no CloudPanel site for ${source}`);
  if (siteExists(paths, target)) failAction(`a CloudPanel site for ${target} already exists`);

  let row: SiteRow | null;
  try {
    row = siteRow(paths, source);
  } catch {
    failAction("cannot read the panel database");
  }
  if (!row) failAction(`no CloudPanel site for ${source}`);
  const type = row.type;
  if (!typeIsClonable(type)) {
    failAction(`${source} is a '${type}' site; only ${CLONABLE_TYPES.join(" ")} sites can be cloned`);
  }

  let password = "";
  let mfa = "";
  let backend: InstaticBackend | null = null;
  if (type === "reverse-proxy") {
    backend = instaticBackendOf(paths, source);
    if (!backend) failAction(`${source} cannot be cloned: ${instaticReject || "its backend is not an Instatic instance this box manages"}`);
    if (!port) failAction("cloning an Instatic site needs --port for the clone's own instance");
    if (!email) failAction("cloning an Instatic site needs --email for the source instance's admin account");
    ({ password, mfa } = readCloneCredentials());
  } else if (port || email) {
    failAction("--port and --email apply only to cloning an Instatic site");
  }

  const stagingUser = siteUserFor(target);
  if (userTaken(stagingUser)) failAction(`the site user ${stagingUser} already exists; ${target} may be half-created`);
  let entries: string[] = [];
  try {
    entries = readdirSync(paths.jobsDir);
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    const dir = jobDir(paths, entry);
    if (!isDirectory(dir) || jobGet(dir, "target") !== target) continue;
    const state = jobGet(dir, "state");
    if (state === "queued" || state === "running") failAction(`a clone into ${target} is already ${state}`);
  }

  const id = newJobId();
  const dir = createJobDir(paths.jobsDir, id);
  jobSet(dir, "source", source);
  jobSet(dir, "target", target);
  jobSet(dir, "tls", tls);
  if (port) jobSet(dir, "port", port);
  if (email) jobSet(dir, "email", email);
  if (mfa) jobSet(dir, "mfa", mfa);
  if (password) jobSet(dir, "srcPassword", password);
  jobSet(dir, "createdAt", jobTimestamp());
  jobSet(dir, "step", "queued");
  jobSet(dir, "state", "queued");
  createJobLog(dir);

  // run acquires the same target lock. Releasing it before the unit starts is
  // the deliberate handoff that prevents the child from waiting on its parent.
  releaseLock();
  const started = startJobUnit({
    addon: "stager",
    id,
    description: `clp-addons: cloning ${source} into ${target}`,
    actionBinary: paths.actionBinary,
  });
  forwardCommandOutput(started);
  if (!started.ok) {
    jobSet(dir, "error", "could not start the clone job");
    jobSet(dir, "state", "failed");
    rmSync(join(dir, "srcPassword"), { force: true });
    rmSync(join(dir, "mfa"), { force: true });
    failAction("systemd-run refused to start the clone job");
  }

  // Keep the local variables used to establish the preflight visible to the
  // type checker and make it explicit that the source backend is only used for
  // reverse-proxy clones. The stored job is the source of truth for run.
  void backend;
  emitStagerOk(paths, { job: id, source, target });
}

/**
 * Queue a promote: move the staging copy's files or content onto the live site.
 *
 * `source` is the staging copy the edits were made on and `target` is the live
 * site they are going to, which is the opposite direction from clone and the
 * reason both names stay. The live database is never part of this: it holds
 * what the site's visitors created since the clone was taken, and no amount of
 * table selection makes overwriting that safe. See docs/decisions/stager.md.
 */
function cmdPromote(action: ParsedStagerAction, paths: StagerActionPaths, releaseLock: () => void): void {
  const { source, target, email, targetEmail } = action;
  if (source === target) failAction("the staging site and the live site are the same site");
  if (!siteExists(paths, source)) failAction(`no CloudPanel site for ${source}`);
  if (!siteExists(paths, target)) failAction(`no CloudPanel site for ${target}`);

  let staging: SiteRow | null;
  let live: SiteRow | null;
  try {
    staging = siteRow(paths, source);
    live = siteRow(paths, target);
  } catch {
    failAction("cannot read the panel database");
  }
  if (!staging) failAction(`no CloudPanel site for ${source}`);
  if (!live) failAction(`no CloudPanel site for ${target}`);
  if (!typeIsClonable(staging.type)) {
    failAction(`${source} is a '${staging.type}' site; only ${CLONABLE_TYPES.join(" ")} sites can be promoted`);
  }
  if (staging.type !== live.type) {
    failAction(`${source} is a '${staging.type}' site and ${target} is a '${live.type}' site; a promote does not change a site's type`);
  }

  let password = "";
  let mfa = "";
  let targetPassword = "";
  let targetMfa = "";
  if (staging.type === "reverse-proxy") {
    if (!instaticBackendOf(paths, source)) {
      failAction(`${source} cannot be promoted: ${instaticReject || "its backend is not an Instatic instance this box manages"}`);
    }
    if (!instaticBackendOf(paths, target)) {
      failAction(`${target} cannot receive a promote: ${instaticReject || "its backend is not an Instatic instance this box manages"}`);
    }
    if (!email) failAction("promoting an Instatic site needs --email for the staging instance's admin account");
    if (!targetEmail) failAction("promoting an Instatic site needs --target-email for the live instance's admin account");
    ({ password, mfa, targetPassword, targetMfa } = readPromoteCredentials());
  } else {
    if (email || targetEmail) failAction("--email and --target-email apply only to promoting an Instatic site");
    if (!staging.user || !live.user) failAction("both sites must have a site user recorded");
    const stagingRoot = `/home/${staging.user}/htdocs/${source}`;
    const liveRoot = `/home/${live.user}/htdocs/${target}`;
    if (!isDirectory(stagingRoot)) failAction(`staging directory not found: ${stagingRoot}`);
    if (!isDirectory(liveRoot)) failAction(`live directory not found: ${liveRoot}`);
  }

  let entries: string[] = [];
  try {
    entries = readdirSync(paths.jobsDir);
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    const dir = jobDir(paths, entry);
    if (!isDirectory(dir)) continue;
    if (jobGet(dir, "target") !== target && jobGet(dir, "source") !== target) continue;
    const state = jobGet(dir, "state");
    if (state === "queued" || state === "running") failAction(`another stager job involving ${target} is already ${state}`);
  }

  const id = newJobId();
  const dir = createJobDir(paths.jobsDir, id);
  jobSet(dir, "kind", "promote");
  jobSet(dir, "source", source);
  jobSet(dir, "target", target);
  if (email) jobSet(dir, "email", email);
  if (targetEmail) jobSet(dir, "targetEmail", targetEmail);
  if (mfa) jobSet(dir, "mfa", mfa);
  if (targetMfa) jobSet(dir, "targetMfa", targetMfa);
  if (password) jobSet(dir, "srcPassword", password);
  if (targetPassword) jobSet(dir, "dstPassword", targetPassword);
  jobSet(dir, "createdAt", jobTimestamp());
  jobSet(dir, "step", "queued");
  jobSet(dir, "state", "queued");
  createJobLog(dir);

  releaseLock();
  const started = startJobUnit({
    addon: "stager",
    id,
    description: `clp-addons: promoting ${source} onto ${target}`,
    actionBinary: paths.actionBinary,
  });
  forwardCommandOutput(started);
  if (!started.ok) {
    jobSet(dir, "error", "could not start the promote job");
    jobSet(dir, "state", "failed");
    for (const name of ["srcPassword", "dstPassword", "mfa", "targetMfa"]) rmSync(join(dir, name), { force: true });
    failAction("systemd-run refused to start the promote job");
  }
  emitStagerOk(paths, { job: id, source, target });
}

function runReplyError(ctx: RunContext, message: string): never {
  diagnostic(`[stager] ERROR: ${message}\n`);
  diagnostic(`${actionErrorJson(message)}\n`);
  throw new RunReplyFailure(message);
}

function rollbackRun(ctx: RunContext): void {
  warnLine(`clone failed during '${ctx.step}', unwinding`);
  if (ctx.dumpFile) rmSync(ctx.dumpFile, { force: true });

  if (ctx.srcPort && isRegularFile(join(ctx.dir, "cookies-src"))) {
    warnLine(`revoking the session this run opened on ${ctx.source}`);
    try { instaticLogout(ctx, ctx.srcPort, ctx.source, join(ctx.dir, "cookies-src")); } catch { /* best effort */ }
  }
  if (ctx.port && isRegularFile(join(ctx.dir, "cookies-dst"))) {
    try { instaticLogout(ctx, ctx.port, ctx.target, join(ctx.dir, "cookies-dst")); } catch { /* best effort */ }
  }
  for (const name of ["srcPassword", "mfa", "site-bundle.zip", "cookies-src", "cookies-dst", ".api-req", ".api-out"]) {
    rmSync(join(ctx.dir, name), { force: true });
  }
  if (ctx.dbCreated) {
    warnLine("removing the staging database this run created");
    const removed = runCommand(ctx.paths.clpctl, ["db:delete", `--databaseName=${ctx.stgDbName}`, "--force"]);
    if (removed.stdout) diagnostic(removed.stdout);
    if (removed.stderr) diagnostic(removed.stderr);
  }
  dropTemplateStage(ctx);
  dropVhostStage(ctx);
  if (ctx.templateName) {
    runStdoutAsDiagnostic(ctx.paths.clpctl, ["vhost-template:delete", `--name=${ctx.templateName}`]);
    ctx.templateName = "";
  }
  if (ctx.siteViaInstatic) {
    warnLine("removing the staging Instatic instance this run created");
    callInstatic(ctx, ["delete", "--domain", ctx.target, "--confirm", ctx.target]);
  } else if (ctx.siteCreated) {
    warnLine("removing the staging site this run created");
    runStdoutAsDiagnostic(ctx.paths.clpctl, ["site:delete", `--domainName=${ctx.target}`, "--force"]);
  }
  if (jobGet(ctx.dir, "state") !== "failed") {
    try {
      jobSet(ctx.dir, "error", `clone failed during '${ctx.step}'`);
      jobSet(ctx.dir, "state", "failed");
    } catch {
      // Nothing useful can be done if the record itself is no longer writable.
    }
  }
}

function newRunContext(id: string, dir: string, paths: StagerActionPaths): RunContext {
  return {
    id, dir, paths,
    source: "", target: "", tls: "", port: "", email: "", mfa: "", step: "",
    rollbackActive: false, failed: false, siteCreated: false, siteViaInstatic: false,
    dbCreated: false, dumpFile: "", stgDbName: "", stgDbUser: "", stgDbPass: "",
    templateName: "", templateStage: "", templateFile: "", vhostStage: "",
    srcPort: "", srcTag: "", exportZip: "", srcUser: "", stgUser: "", srcType: "",
    srcRoot: "", srcApp: "", phpVersion: "", srcDb: "", cloneApplication: "",
    vhostCarried: false, vhostBy: "stock", notes: [],
  };
}

async function cmdRun(id: string, paths: StagerActionPaths): Promise<void> {
  const dir = jobDir(paths, id);
  if (!isDirectory(dir)) failAction(`no such job: ${id}`);
  // Records written before promote existed carry no kind, and they are all clones.
  if (jobGet(dir, "kind") === "promote") return cmdRunPromote(id, dir, paths);
  const transcript = new JobTranscript(join(dir, "log"));
  const previousTranscript = activeTranscript;
  activeTranscript = transcript;
  const ctx = newRunContext(id, dir, paths);
  try {
    ctx.source = jobGet(dir, "source");
    ctx.target = jobGet(dir, "target");
    ctx.tls = jobGet(dir, "tls");
    ctx.port = jobGet(dir, "port");
    ctx.email = jobGet(dir, "email");
    ctx.mfa = jobGet(dir, "mfa");
    if (!ctx.source || !ctx.target) failJob(ctx, "job record is incomplete");

    try {
      ctx.source = validateDomain(ctx.source, paths.panelIdentityFile, "source");
      ctx.target = validateDomain(ctx.target, paths.panelIdentityFile, "target");
      validateJob(id);
      if (ctx.port) validatePort(ctx.port);
      if (ctx.email) validateEmail(ctx.email);
      if (ctx.mfa) validateMfa(ctx.mfa);
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid job record";
      runReplyError(ctx, message);
    }

    const state = jobGet(dir, "state");
    if (state !== "queued") failJob(ctx, `job ${id} is ${state}, not queued`);
    if (siteExists(paths, ctx.target)) {
      failJob(ctx, `a CloudPanel site for ${ctx.target} appeared after this clone was queued; nothing was changed`);
    }

    jobSet(dir, "state", "running");
    jobSet(dir, "startedAt", jobTimestamp());
    ctx.rollbackActive = true;

    let row: SiteRow | null;
    try {
      setStep(ctx, "reading the source site");
      row = siteRow(paths, ctx.source);
    } catch {
      failJob(ctx, "cannot read the panel database");
    }
    if (!row) failJob(ctx, `no CloudPanel site for ${ctx.source}`);
    ctx.srcType = row.type;
    ctx.srcUser = row.user;
    ctx.srcRoot = row.root;
    ctx.srcApp = row.application;
    if (!typeIsClonable(ctx.srcType)) {
      failJob(ctx, `${ctx.source} is a '${ctx.srcType}' site; only ${CLONABLE_TYPES.join(" ")} sites can be cloned`);
    }
    if (!ctx.srcUser) failJob(ctx, `${ctx.source} has no site user recorded`);
    if (ctx.srcType === "php") {
      try { ctx.phpVersion = phpVersionOf(paths, ctx.source); } catch { failJob(ctx, `cannot determine the PHP version of ${ctx.source}`); }
      if (!ctx.phpVersion) failJob(ctx, `cannot determine the PHP version of ${ctx.source}`);
    }
    try { ctx.srcDb = databaseOf(paths, ctx.source); } catch { failJob(ctx, "cannot read the panel database"); }

    if (ctx.srcApp && !applicationOk(ctx.srcApp)) {
      ctx.notes.push(`${ctx.source} records an application name this addon will not put in a query or a command line, so the clone was built from Generic instead; check Site -> Vhost on ${ctx.source}`);
      warnLine(`${ctx.source} has an unusable site.application; falling back to Generic`);
      ctx.srcApp = "";
    }
    if (!ctx.srcApp) ctx.srcApp = "Generic";

    if (ctx.srcType === "reverse-proxy") {
      const backend = instaticBackendOf(paths, ctx.source);
      if (!backend) failJob(ctx, `${ctx.source} cannot be cloned: ${instaticReject || "its backend is not an Instatic instance this box manages"}`);
      ctx.srcPort = backend.port;
      ctx.srcTag = backend.tag;
      if (!ctx.port) failJob(ctx, "no port was allocated for the clone's Instatic instance");
      if (!ctx.email) failJob(ctx, "cloning an Instatic site needs the source instance's admin email address");
      const passwordPath = join(dir, "srcPassword");
      if (!isRegularFile(passwordPath) || statSync(passwordPath).size === 0) {
        failJob(ctx, "cloning an Instatic site needs the source instance's admin password");
      }
      const sourcePassword = readFileSync(passwordPath, "utf8").replace(/\n+$/g, "");
      setStep(ctx, `signing in to ${ctx.source}`);
      const login = instaticLogin(ctx, ctx.srcPort, ctx.source, join(dir, "cookies-src"), ctx.email, sourcePassword, ctx.mfa, ctx.source);
      if (!login.ok) failJob(ctx, login.reason);
      rmSync(join(dir, "srcPassword"), { force: true });
      rmSync(join(dir, "mfa"), { force: true });
      ctx.mfa = "";

      setStep(ctx, `exporting ${ctx.source}'s content`);
      ctx.exportZip = join(dir, "site-bundle.zip");
      const exportCode = instaticGet(ctx, ctx.srcPort, ctx.source, join(dir, "cookies-src"), "/admin/api/cms/export?includeSite=1&includeMedia=1", ctx.exportZip);
      if (!/^2/.test(exportCode)) failJob(ctx, `${ctx.source} refused the export (HTTP ${exportCode}): ${instaticError(ctx.exportZip)}`);
      instaticLogout(ctx, ctx.srcPort, ctx.source, join(dir, "cookies-src"));
      let bytes = 0;
      try { bytes = statSync(ctx.exportZip).size; } catch { bytes = 0; }
      logLine(`exported ${bytes} bytes of site bundle`);
    } else {
      const sourceDir = `/home/${ctx.srcUser}/htdocs/${ctx.source}`;
      if (!isDirectory(sourceDir)) failJob(ctx, `source directory not found: ${sourceDir}`);
    }

    let baseTemplate = ctx.srcApp;
    let baseMissing = false;
    let templateRoute = false;
    let templateReject = "";
    let vhostTemplate = baseTemplate;
    if (ctx.srcType === "php") {
      if (!vhostTemplateExists(paths, baseTemplate)) {
        baseMissing = true;
        baseTemplate = "Generic";
        vhostTemplate = baseTemplate;
      }
      if (buildVhostTemplate(ctx) && vhostTemplateOk(ctx.templateFile, ctx.source, ctx.target)) {
        const candidate = `clp-stager-${id}`;
        const added = runCommand(paths.clpctl, ["vhost-template:add", `--name=${candidate}`, `--file=${ctx.templateFile}`]);
        forwardCommandOutput(added);
        if (added.ok) {
          ctx.templateName = candidate;
          vhostTemplate = candidate;
          templateRoute = true;
          logLine(`carrying ${ctx.source}'s vhost across through CloudPanel's own template mechanism`);
        } else {
          templateReject = `CloudPanel would not accept a vhost template built from ${ctx.source}`;
        }
      } else {
        templateReject = vhostTemplateReject || "the stored vhost could not be read";
      }
      dropTemplateStage(ctx);
    }

    ctx.stgUser = siteUserFor(ctx.target);
    if (userTaken(ctx.stgUser)) failJob(ctx, `the site user ${ctx.stgUser} already exists; ${ctx.target} may be half-created`);
    const stagingPassword = generatedPassword();
    if (ctx.srcType === "php") {
      setStep(ctx, `creating the staging site ${ctx.target} on PHP ${ctx.phpVersion}`);
      const created = runCommand(paths.clpctl, [
        "site:add:php", `--domainName=${ctx.target}`, `--phpVersion=${ctx.phpVersion}`,
        `--vhostTemplate=${vhostTemplate}`, `--siteUser=${ctx.stgUser}`, `--siteUserPassword=${stagingPassword}`,
      ]);
      forwardCommandOutput(created);
      if (!created.ok) failJob(ctx, `clpctl site:add:php failed for ${ctx.target}`);
      ctx.siteCreated = true;
    } else if (ctx.srcType === "static") {
      setStep(ctx, `creating the staging site ${ctx.target}`);
      const created = runCommand(paths.clpctl, [
        "site:add:static", `--domainName=${ctx.target}`, `--siteUser=${ctx.stgUser}`, `--siteUserPassword=${stagingPassword}`,
      ]);
      forwardCommandOutput(created);
      if (!created.ok) failJob(ctx, `clpctl site:add:static failed for ${ctx.target}`);
      ctx.siteCreated = true;
    } else {
      setStep(ctx, `creating the staging Instatic instance ${ctx.target} on port ${ctx.port}`);
      const created = callInstatic(ctx, ["create", "--domain", ctx.target, "--port", ctx.port, "--tag", ctx.srcTag]);
      if (!created.ok) failJob(ctx, `the Instatic addon could not create an instance for ${ctx.target}`);
      ctx.siteViaInstatic = true;
      if (created.data?.siteCreatedByAddon === true) ctx.siteCreated = true;
      else ctx.notes.push(`the CloudPanel site for ${ctx.target} already existed and was adopted rather than created, so its vhost and panel record were left as they were`);
    }

    if (ctx.templateName) {
      const removed = runCommand(paths.clpctl, ["vhost-template:delete", `--name=${ctx.templateName}`]);
      if (removed.stdout) diagnostic(removed.stdout);
      if (removed.stderr) diagnostic(removed.stderr);
      if (!removed.ok) warnLine(`could not remove the temporary vhost template ${ctx.templateName}`);
      ctx.templateName = "";
    }

    try {
      const user = queryPanel(paths, (db) => {
        const result = db.query("SELECT user FROM site WHERE domain_name = ?;").get(ctx.target) as { user?: unknown } | null;
        return typeof result?.user === "string" ? result.user : "";
      });
      if (user) ctx.stgUser = user;
    } catch {
      // On failure this falls back to the derived account name computed earlier,
      // the same degrade the original bash wrapper used.
    }
    const destination = `/home/${ctx.stgUser}/htdocs/${ctx.target}`;
    if (!isDirectory(destination)) failJob(ctx, `CloudPanel did not create ${destination}`);

    try { ctx.cloneApplication = applicationOf(paths, ctx.target); } catch { ctx.cloneApplication = ""; }
    if (ctx.cloneApplication && !applicationOk(ctx.cloneApplication)) ctx.cloneApplication = "";
    if (!ctx.cloneApplication) ctx.cloneApplication = "Generic";
    if (ctx.srcType === "php") ctx.cloneApplication = baseTemplate;

    if (templateRoute) {
      ctx.vhostCarried = true;
      ctx.vhostBy = "template";
      let currentApplication = "";
      try { currentApplication = applicationOf(paths, ctx.target); } catch { currentApplication = ""; }
      if (currentApplication !== ctx.cloneApplication && !panelUpdateSite(ctx, ctx.srcType, ctx.cloneApplication)) {
        ctx.notes.push(`the clone's Vhost tab still names the temporary template this job used: ${panelWriteReject}`);
      }
    } else {
      setStep(ctx, `carrying ${ctx.source}'s vhost onto the clone`);
      const carried = carryVhost(ctx, ctx.srcType, ctx.cloneApplication);
      if (carried.ok) {
        ctx.vhostCarried = true;
        ctx.vhostBy = "rendered";
        logLine(`carried ${ctx.source}'s vhost across by writing the clone's panel record and rendering its file`);
      } else {
        ctx.notes.push(`${ctx.source}'s vhost was not carried across: ${carried.reason}. The clone keeps the stock ${ctx.cloneApplication} vhost; copy the edits across in Site -> Vhost`);
        if (templateReject) ctx.notes.push(`CloudPanel's own template route was not taken either: ${templateReject}`);
      }
      dropVhostStage(ctx);
    }
    if (baseMissing) ctx.notes.push(`${ctx.source} names a vhost template the panel no longer has, so ${baseTemplate} was used instead`);

    if (ctx.srcDb) {
      ctx.stgDbName = dbNameFor(ctx.target);
      ctx.stgDbUser = dbUserFor(ctx.target);
      ctx.stgDbPass = generatedDbPassword();
      ctx.dumpFile = join(dir, "dump.sql.gz");
      setStep(ctx, `exporting ${ctx.srcDb}`);
      const exported = runCommand(paths.clpctl, ["db:export", `--databaseName=${ctx.srcDb}`, `--file=${ctx.dumpFile}`]);
      forwardCommandOutput(exported);
      if (!exported.ok) failJob(ctx, `clpctl db:export failed for ${ctx.srcDb}`);
      chmodSync(ctx.dumpFile, 0o600);
      setStep(ctx, `creating the staging database ${ctx.stgDbName}`);
      const added = runCommand(paths.clpctl, [
        "db:add", `--domainName=${ctx.target}`, `--databaseName=${ctx.stgDbName}`,
        `--databaseUserName=${ctx.stgDbUser}`, `--databaseUserPassword=${ctx.stgDbPass}`,
      ]);
      forwardCommandOutput(added);
      if (!added.ok) failJob(ctx, `clpctl db:add failed for ${ctx.stgDbName}`);
      ctx.dbCreated = true;
      setStep(ctx, `importing into ${ctx.stgDbName}`);
      const imported = runCommand(paths.clpctl, ["db:import", `--databaseName=${ctx.stgDbName}`, `--file=${ctx.dumpFile}`]);
      forwardCommandOutput(imported);
      if (!imported.ok) failJob(ctx, `clpctl db:import failed for ${ctx.stgDbName}`);
      rmSync(ctx.dumpFile, { force: true });
      ctx.dumpFile = "";
    } else {
      logLine("the source site has no database; skipping the database steps");
    }

    if (ctx.srcType === "reverse-proxy") {
      logLine("the source is a reverse proxy; its content moves through the site bundle rather than through its document root");
    } else {
      setStep(ctx, "copying files");
      const sourceDir = `/home/${ctx.srcUser}/htdocs/${ctx.source}`;
      const copyCode = await runTarCopy(sourceDir, destination);
      if (copyCode >= 2) failJob(ctx, `copying files failed (tar exit ${copyCode})`);
      const owner = runCommand("chown", ["-R", `${ctx.stgUser}:${ctx.stgUser}`, destination]);
      if (owner.stdout) diagnostic(owner.stdout);
      if (owner.stderr) diagnostic(owner.stderr);
      if (!owner.ok) failJob(ctx, `could not chown ${destination}`);
    }

    let instaticEmail = "";
    let instaticPassword = "";
    if (ctx.srcType === "reverse-proxy") {
      instaticEmail = `admin@${ctx.target}`;
      instaticPassword = generatedPassword();
      setStep(ctx, "bootstrapping the clone's Instatic owner");
      const setup = instaticSetup(ctx, ctx.port, ctx.target, join(dir, "cookies-dst"), instaticEmail, instaticPassword);
      if (!setup.ok) failJob(ctx, setup.reason);
      setStep(ctx, "signing in to the clone");
      const login = instaticLogin(ctx, ctx.port, ctx.target, join(dir, "cookies-dst"), instaticEmail, instaticPassword, "", "the clone");
      if (!login.ok) failJob(ctx, login.reason);
      const stepUp = instaticStepUp(ctx, ctx.port, ctx.target, join(dir, "cookies-dst"), instaticPassword, "");
      if (!stepUp.ok) failJob(ctx, stepUp.reason);
      setStep(ctx, `importing ${ctx.source}'s content into the clone`);
      const output = join(dir, ".api-out");
      const importCode = instaticPost(ctx, ctx.port, ctx.target, join(dir, "cookies-dst"), "/admin/api/cms/import/archive?strategy=replace", "application/zip", ctx.exportZip, output);
      if (!/^2/.test(importCode)) failJob(ctx, `the clone refused the import (HTTP ${importCode}): ${instaticError(output)}`);
      const tables = jsonField(output, "tablesAffected") || "?";
      const rows = jsonField(output, "rowsInserted") || "?";
      const media = jsonField(output, "mediaImported") || "?";
      logLine(`import: ${instaticError(output)}`);
      rmSync(output, { force: true });
      ctx.notes.push(`the import reported ${tables} table(s), ${rows} row(s) and ${media} media file(s); that is everything the export contained, so check it against ${ctx.source} rather than against what you expect`);
      instaticLogout(ctx, ctx.port, ctx.target, join(dir, "cookies-dst"));
      rmSync(ctx.exportZip, { force: true });
      ctx.exportZip = "";
      ctx.notes.push(`the clone's PUBLIC_ORIGIN is https://${ctx.target}, but absolute links typed into a page still name ${ctx.source}; the bundle carries content, not a URL rewrite`);
      ctx.notes.push(`integration secrets such as API keys and TOTP seeds are encrypted under ${ctx.source}'s own key and are deliberately absent from the bundle; re-enter them on the clone`);
      ctx.notes.push(`publish the clone in its own admin before using it: the site bundle carries content, not the runtime assets a publish produces, so /_instatic/assets/* on ${ctx.target} will 404 until it has been published once`);
      ctx.notes.push(`plugins are not part of the site bundle, so any plugin installed on ${ctx.source} has to be installed again on the clone`);
      ctx.notes.push(`the export contains only the rows the account you signed in as may see: without the content.manage capability Instatic exports that account's own rows and still answers 200, so compare the clone's pages against ${ctx.source}'s before trusting it`);
    }

    if (ctx.srcDb) {
      setStep(ctx, "rewriting the application's database credentials");
      const wpConfig = join(destination, "wp-config.php");
      const dotenv = join(destination, ".env");
      if (isRegularFile(wpConfig)) {
        rewriteWpConfig(wpConfig, ctx.target, ctx);
        if (Bun.which("wp")) {
          setStep(ctx, "rewriting URLs with wp-cli");
          if (!runWpSearchReplace(ctx.stgUser, destination, ctx.source, ctx.target)) {
            ctx.notes.push("wp-cli search-replace reported problems; check the log");
          }
        } else {
          ctx.notes.push(`wp-cli is not installed, so URLs inside the database still name ${ctx.source}`);
        }
      } else if (isRegularFile(dotenv)) {
        rewriteDotenv(dotenv, ctx);
      } else {
        ctx.notes.push("no wp-config.php or .env found, so the database credentials were not written into the application; they are in this job's result");
      }
    }

    let stagingRoot = "";
    try {
      stagingRoot = queryPanel(paths, (db) => {
        const result = db.query("SELECT root_directory FROM site WHERE domain_name = ?;").get(ctx.target) as { root_directory?: unknown } | null;
        return typeof result?.root_directory === "string" ? result.root_directory : "";
      });
    } catch {
      failJob(ctx, "cannot read the panel database");
    }
    if (ctx.srcRoot && stagingRoot && removePathPrefix(ctx.srcRoot, ctx.source) !== removePathPrefix(stagingRoot, ctx.target)) {
      ctx.notes.push(`the source's root directory is '${ctx.srcRoot}' but the clone's is '${stagingRoot}'; set it in Site -> Settings`);
    }
    if (ctx.vhostCarried && vhostDiffers(paths, ctx.source, ctx.target, ctx.srcUser, ctx.stgUser)) {
      ctx.notes.push(`${ctx.source}'s vhost still differs from the clone's after carrying it across. Compare them in Site -> Vhost`);
    }

    if (ctx.tls === "yes") {
      setStep(ctx, `requesting a Let's Encrypt certificate for ${ctx.target}`);
      const certificate = runCommand(paths.clpctl, ["lets-encrypt:install:certificate", `--domainName=${ctx.target}`]);
      forwardCommandOutput(certificate);
      if (!certificate.ok) ctx.notes.push(`the certificate request failed; point ${ctx.target} at this server and retry from Site -> SSL/TLS`);
    } else {
      ctx.notes.push(`no certificate was requested; ${ctx.target} is served with CloudPanel's self-signed one until you issue one`);
    }

    setStep(ctx, "recording the result");
    const result: JobResult = {
      siteType: ctx.srcType,
      siteUser: ctx.stgUser,
      phpVersion: ctx.phpVersion,
      vhostTemplate: ctx.cloneApplication,
      vhostCarried: ctx.vhostCarried,
      vhostCarriedBy: ctx.vhostBy,
      database: ctx.srcDb ? { source: ctx.srcDb, name: ctx.stgDbName, user: ctx.stgDbUser, password: ctx.stgDbPass } : null,
      instatic: ctx.srcType === "reverse-proxy" ? { port: Number(ctx.port), tag: ctx.srcTag, email: instaticEmail, password: instaticPassword } : null,
      notes: ctx.notes,
    };
    writeFileSync(join(dir, "result.json"), `${JSON.stringify(result)}\n`, { mode: 0o600 });
    chmodSync(join(dir, "result.json"), 0o600);
    jobSet(dir, "finishedAt", jobTimestamp());
    jobSet(dir, "state", "done");
    ctx.rollbackActive = false;
    logLine(`clone complete: ${ctx.target}`);
  } catch (error) {
    if (error instanceof RunReplyFailure) throw error;
    if (ctx.rollbackActive) rollbackRun(ctx);
    if (!(error instanceof JobFailure) && !ctx.failed) {
      const message = error instanceof Error ? error.message : "clone failed";
      try {
        jobSet(dir, "error", message);
        jobSet(dir, "state", "failed");
      } catch {
        // Keep the stderr-only failure contract even if the record is damaged.
      }
      diagnostic(`[stager] ERROR: ${message}\n`);
    }
    if (error instanceof JobFailure) throw error;
    throw new JobFailure(error instanceof Error ? error.message : "clone failed");
  } finally {
    activeTranscript = previousTranscript;
    transcript.close();
  }
}

interface PromoteResult {
  siteType: string;
  siteUser: string;
  /** The live document root as it was before the switch, kept for the job's retention. */
  previousRoot: string;
  /** Paths taken from the live site rather than from the staging copy. */
  preserved: string[];
  /** The live database dump taken before anything was touched, or null. */
  databaseBackup: string | null;
  /** The live instance's own content export, taken before the import. */
  contentBackup: string | null;
  notes: string[];
}

interface PromoteContext {
  id: string;
  dir: string;
  paths: StagerActionPaths;
  /** The staging copy the edits were made on. */
  source: string;
  /** The live site they are going to. */
  target: string;
  step: string;
  failed: boolean;
  rollbackActive: boolean;
  siteType: string;
  srcUser: string;
  dstUser: string;
  srcRoot: string;
  dstRoot: string;
  stageRoot: string;
  prevRoot: string;
  swapped: boolean;
  movedPreserved: string[];
  copiedPreserved: string[];
  dbBackup: string;
  contentBackup: string;
  exportZip: string;
  srcPort: string;
  dstPort: string;
  notes: string[];
}

function newPromoteContext(id: string, dir: string, paths: StagerActionPaths): PromoteContext {
  return {
    id, dir, paths, source: "", target: "", step: "", failed: false, rollbackActive: false,
    siteType: "", srcUser: "", dstUser: "", srcRoot: "", dstRoot: "", stageRoot: "", prevRoot: "",
    swapped: false, movedPreserved: [], copiedPreserved: [], dbBackup: "", contentBackup: "", exportZip: "",
    srcPort: "", dstPort: "", notes: [],
  };
}

function htdocsOf(user: string): string {
  return `/home/${user}/htdocs`;
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Move one preserved path from `from` into `to`.
 *
 * A rename rather than a copy: both sides are in the same site user's htdocs,
 * so this is instant however large an uploads directory has grown, and it does
 * not need a second copy of it on disk. The consequence is deliberate and
 * documented -- the retained previous root holds the code that was replaced,
 * not a second copy of the live site's user data, which stays on the live site
 * throughout.
 */
function movePreserved(from: string, to: string, relative: string): boolean {
  const origin = join(from, relative);
  if (!pathExists(origin)) return false;
  const destination = join(to, relative);
  try {
    const parent = destination.slice(0, destination.lastIndexOf("/"));
    mkdirSync(parent, { recursive: true });
    rmSync(destination, { recursive: true, force: true });
    renameSync(origin, destination);
    return true;
  } catch {
    return false;
  }
}

function rollbackPromote(ctx: PromoteContext): void {
  warnLine(`promote failed during '${ctx.step}', unwinding`);
  for (const name of ["srcPassword", "dstPassword", "mfa", "targetMfa", "cookies-src", "cookies-dst", ".api-req", ".api-out"]) {
    rmSync(join(ctx.dir, name), { force: true });
  }
  if (ctx.exportZip) rmSync(ctx.exportZip, { force: true });

  if (ctx.swapped) {
    warnLine(`putting ${ctx.target}'s own document root back`);
    // The preserved paths were moved onto the new root; they belong to the
    // live site either way, so they go back with it.
    for (const relative of ctx.movedPreserved) movePreserved(ctx.dstRoot, ctx.prevRoot, relative);
    // Derived from prevRoot, not from stageRoot: the successful swap cleared
    // stageRoot, and a discard path of ".discard" would be relative to nothing.
    const discard = `${ctx.prevRoot}.discard`;
    try {
      renameSync(ctx.dstRoot, discard);
      renameSync(ctx.prevRoot, ctx.dstRoot);
      jobSet(ctx.dir, "swap", "rolled-back");
      rmSync(discard, { recursive: true, force: true });
      ctx.swapped = false;
    } catch {
      warnLine(`could not put ${ctx.dstRoot} back; ${ctx.prevRoot} still holds what was there before`);
    }
  } else if (ctx.prevRoot && pathExists(ctx.prevRoot) && !pathExists(ctx.dstRoot)) {
    try {
      renameSync(ctx.prevRoot, ctx.dstRoot);
      jobSet(ctx.dir, "swap", "rolled-back");
    } catch {
      warnLine(`could not put ${ctx.dstRoot} back; ${ctx.prevRoot} still holds what was there before`);
    }
  }
  if (ctx.stageRoot) rmSync(ctx.stageRoot, { recursive: true, force: true });

  if (jobGet(ctx.dir, "state") !== "failed") {
    try {
      jobSet(ctx.dir, "error", `promote failed during '${ctx.step}'`);
      jobSet(ctx.dir, "state", "failed");
    } catch {
      // Nothing useful can be done if the record itself is no longer writable.
    }
  }
}

async function promoteFiles(ctx: PromoteContext): Promise<void> {
  const paths = ctx.paths;
  ctx.srcRoot = join(htdocsOf(ctx.srcUser), ctx.source);
  ctx.dstRoot = join(htdocsOf(ctx.dstUser), ctx.target);
  if (!isDirectory(ctx.srcRoot)) failJob(ctx, `staging directory not found: ${ctx.srcRoot}`);
  if (!isDirectory(ctx.dstRoot)) failJob(ctx, `live directory not found: ${ctx.dstRoot}`);

  // Taken before anything is touched, and taken even though this promote never
  // writes to the database: the code being promoted can run a destructive
  // migration on its first request, and by then the only copy of what the
  // database held is this one.
  let liveDb = "";
  try { liveDb = databaseOf(paths, ctx.target); } catch { failJob(ctx, "cannot read the panel database"); }
  if (liveDb) {
    setStep(ctx, `backing up the live database ${liveDb}`);
    const backup = join(ctx.dir, "live-db.sql.gz");
    const exported = runCommand(paths.clpctl, ["db:export", `--databaseName=${liveDb}`, `--file=${backup}`]);
    forwardCommandOutput(exported);
    if (!exported.ok) failJob(ctx, `clpctl db:export failed for ${liveDb}; nothing was changed`);
    chmodSync(backup, 0o600);
    ctx.dbBackup = backup;
  } else {
    logLine("the live site has no database, so there was nothing to back up");
  }

  setStep(ctx, "assembling the new release");
  ctx.stageRoot = join(htdocsOf(ctx.dstUser), `.clp-stager-promote-${ctx.id}`);
  rmSync(ctx.stageRoot, { recursive: true, force: true });
  mkdirSync(ctx.stageRoot, { recursive: true, mode: 0o755 });
  const copyCode = await runTarCopy(ctx.srcRoot, ctx.stageRoot);
  if (copyCode >= 2) failJob(ctx, `copying the staging files failed (tar exit ${copyCode})`);
  // Whatever the staging copy holds at these paths is dropped here rather than
  // after the switch, so the release that goes live never contains the staging
  // site's database credentials even for an instant.
  for (const relative of PRESERVED_PATHS) rmSync(join(ctx.stageRoot, relative), { recursive: true, force: true });

  // Then the live site's own copies go in, so the root that becomes live has
  // them from its first served request. lstat rather than stat: a symlink at
  // this name in the live root would otherwise be resolved and its target
  // copied into the new release under a configuration file's name.
  for (const relative of PRESERVED_COPIED) {
    const origin = join(ctx.dstRoot, relative);
    let info;
    try { info = lstatSync(origin); } catch { continue; }
    if (!info.isFile()) {
      warnLine(`${ctx.target}'s ${relative} is not a plain file, so it was left where it is`);
      continue;
    }
    try {
      copyFileSync(origin, join(ctx.stageRoot, relative));
      chmodSync(join(ctx.stageRoot, relative), info.mode & 0o7777);
      ctx.copiedPreserved.push(relative);
      logLine(`kept the live site's own ${relative}`);
    } catch {
      failJob(ctx, `could not copy ${ctx.target}'s own ${relative}; nothing was changed`);
    }
  }

  // Before the switch, not after: a recursive chown over the whole release is
  // the slowest step here, and running it on the live root would leave the site
  // being served out of a tree whose ownership is still moving. It also turns a
  // chown failure into one that changed nothing.
  const staged = runCommand("chown", ["-R", `${ctx.dstUser}:${ctx.dstUser}`, ctx.stageRoot]);
  if (staged.stdout) diagnostic(staged.stdout);
  if (staged.stderr) diagnostic(staged.stderr);
  if (!staged.ok) failJob(ctx, `could not chown the new release; nothing was changed`);

  setStep(ctx, `switching ${ctx.target} over`);
  ctx.prevRoot = join(htdocsOf(ctx.dstUser), `.clp-stager-prev-${ctx.target}-${ctx.id}`);
  jobSet(ctx.dir, "liveRoot", ctx.dstRoot);
  jobSet(ctx.dir, "prevRoot", ctx.prevRoot);
  try {
    renameSync(ctx.dstRoot, ctx.prevRoot);
  } catch {
    failJob(ctx, `could not move ${ctx.dstRoot} aside; nothing was changed`);
  }
  jobSet(ctx.dir, "swap", "moved");
  try {
    renameSync(ctx.stageRoot, ctx.dstRoot);
  } catch {
    failJob(ctx, `could not put the new release in place at ${ctx.dstRoot}`);
  }
  jobSet(ctx.dir, "swap", "done");
  ctx.swapped = true;
  ctx.stageRoot = "";

  setStep(ctx, "restoring what the live site owns");
  for (const relative of PRESERVED_MOVED) {
    if (movePreserved(ctx.prevRoot, ctx.dstRoot, relative)) {
      ctx.movedPreserved.push(relative);
      logLine(`kept the live site's own ${relative}`);
    } else if (pathExists(join(ctx.dstRoot, relative))) {
      // Only reachable if the path appeared between the strip above and here.
      rmSync(join(ctx.dstRoot, relative), { recursive: true, force: true });
    }
  }
  if (ctx.copiedPreserved.length === 0) {
    ctx.notes.push(`${ctx.target} had neither a wp-config.php nor a .env of its own, so the promoted release has none either; if the application needs one, write it with the live database's credentials`);
  }

  ctx.notes.push(`the live database was not touched: it holds what ${ctx.target}'s own visitors created since the staging copy was taken, and no part of a promote can tell that apart from a stale row`);
  ctx.notes.push(`absolute URLs written into the live database still name whatever was there before; a promote moves files, not database content`);
  if (ctx.dbBackup) {
    ctx.notes.push(`a dump of the live database was taken before the switch and is kept with this job for ${JOB_RETENTION_DAYS} days`);
  }
  ctx.notes.push(`${ctx.prevRoot} holds the document root that was replaced, for ${JOB_RETENTION_DAYS} days; it still has ${ctx.target}'s own configuration files, which were copied onto the new release, but not ${PRESERVED_MOVED.join(" or ")}, which were moved`);
}

function promoteInstatic(ctx: PromoteContext, email: string, targetEmail: string): void {
  const dir = ctx.dir;
  const paths = ctx.paths;
  const sourceBackend = instaticBackendOf(paths, ctx.source);
  if (!sourceBackend) failJob(ctx, `${ctx.source} cannot be promoted: ${instaticReject || "its backend is not an Instatic instance this box manages"}`);
  const targetBackend = instaticBackendOf(paths, ctx.target);
  if (!targetBackend) failJob(ctx, `${ctx.target} cannot receive a promote: ${instaticReject || "its backend is not an Instatic instance this box manages"}`);
  ctx.srcPort = sourceBackend.port;
  ctx.dstPort = targetBackend.port;
  if (!email || !targetEmail) failJob(ctx, "promoting an Instatic site needs both instances' admin email addresses");

  const sourcePasswordPath = join(dir, "srcPassword");
  const targetPasswordPath = join(dir, "dstPassword");
  if (!isRegularFile(sourcePasswordPath) || statSync(sourcePasswordPath).size === 0) {
    failJob(ctx, "promoting an Instatic site needs the staging instance's admin password");
  }
  if (!isRegularFile(targetPasswordPath) || statSync(targetPasswordPath).size === 0) {
    failJob(ctx, "promoting an Instatic site needs the live instance's admin password");
  }
  const sourcePassword = readFileSync(sourcePasswordPath, "utf8").replace(/\n+$/g, "");
  const targetPassword = readFileSync(targetPasswordPath, "utf8").replace(/\n+$/g, "");
  const sourceMfa = jobGet(dir, "mfa");
  const targetMfa = jobGet(dir, "targetMfa");

  setStep(ctx, `signing in to ${ctx.source}`);
  const sourceLogin = instaticLogin(ctx, ctx.srcPort, ctx.source, join(dir, "cookies-src"), email, sourcePassword, sourceMfa, ctx.source);
  if (!sourceLogin.ok) failJob(ctx, sourceLogin.reason);
  rmSync(sourcePasswordPath, { force: true });

  setStep(ctx, `exporting ${ctx.source}'s content`);
  ctx.exportZip = join(dir, "site-bundle.zip");
  const exportCode = instaticGet(ctx, ctx.srcPort, ctx.source, join(dir, "cookies-src"), "/admin/api/cms/export?includeSite=1&includeMedia=1", ctx.exportZip);
  if (!/^2/.test(exportCode)) failJob(ctx, `${ctx.source} refused the export (HTTP ${exportCode}): ${instaticError(ctx.exportZip)}`);
  instaticLogout(ctx, ctx.srcPort, ctx.source, join(dir, "cookies-src"));
  let bytes = 0;
  try { bytes = statSync(ctx.exportZip).size; } catch { bytes = 0; }
  logLine(`exported ${bytes} bytes of site bundle`);

  setStep(ctx, `signing in to ${ctx.target}`);
  const targetLogin = instaticLogin(ctx, ctx.dstPort, ctx.target, join(dir, "cookies-dst"), targetEmail, targetPassword, targetMfa, ctx.target);
  if (!targetLogin.ok) failJob(ctx, targetLogin.reason);
  const stepUp = instaticStepUp(ctx, ctx.dstPort, ctx.target, join(dir, "cookies-dst"), targetPassword, targetMfa);
  if (!stepUp.ok) failJob(ctx, stepUp.reason);
  rmSync(targetPasswordPath, { force: true });
  rmSync(join(dir, "mfa"), { force: true });
  rmSync(join(dir, "targetMfa"), { force: true });

  // The import replaces the live instance's content wholesale, so its own
  // export is taken first. It is the only way back.
  setStep(ctx, `backing up ${ctx.target}'s current content`);
  const backup = join(dir, "live-bundle.zip");
  const backupCode = instaticGet(ctx, ctx.dstPort, ctx.target, join(dir, "cookies-dst"), "/admin/api/cms/export?includeSite=1&includeMedia=1", backup);
  if (!/^2/.test(backupCode)) failJob(ctx, `${ctx.target} refused to export its current content (HTTP ${backupCode}): ${instaticError(backup)}; nothing was changed`);
  ctx.contentBackup = backup;

  setStep(ctx, `importing ${ctx.source}'s content into ${ctx.target}`);
  const output = join(dir, ".api-out");
  const importCode = instaticPost(ctx, ctx.dstPort, ctx.target, join(dir, "cookies-dst"), "/admin/api/cms/import/archive?strategy=replace", "application/zip", ctx.exportZip, output);
  if (!/^2/.test(importCode)) failJob(ctx, `${ctx.target} refused the import (HTTP ${importCode}): ${instaticError(output)}`);
  const tables = jsonField(output, "tablesAffected") || "?";
  const rows = jsonField(output, "rowsInserted") || "?";
  const media = jsonField(output, "mediaImported") || "?";
  logLine(`import: ${instaticError(output)}`);
  rmSync(output, { force: true });
  instaticLogout(ctx, ctx.dstPort, ctx.target, join(dir, "cookies-dst"));
  rmSync(ctx.exportZip, { force: true });
  ctx.exportZip = "";

  ctx.notes.push(`the import reported ${tables} table(s), ${rows} row(s) and ${media} media file(s)`);
  ctx.notes.push(`the import replaced ${ctx.target}'s content: anything written on the live instance since the staging copy was taken is gone, and ${backup} is the copy taken just before it`);
  ctx.notes.push(`publish ${ctx.target} in its own admin before trusting it: the site bundle carries content, not the runtime assets a publish produces`);
  ctx.notes.push(`integration secrets such as API keys and TOTP seeds are encrypted under each instance's own key and are not part of a bundle, so ${ctx.target} keeps the ones it already had`);
  ctx.notes.push(`plugins are not part of the site bundle, so a plugin installed on ${ctx.source} has to be installed again on ${ctx.target}`);
}

async function cmdRunPromote(id: string, dir: string, paths: StagerActionPaths): Promise<void> {
  const transcript = new JobTranscript(join(dir, "log"));
  const previousTranscript = activeTranscript;
  activeTranscript = transcript;
  const ctx = newPromoteContext(id, dir, paths);
  try {
    ctx.source = jobGet(dir, "source");
    ctx.target = jobGet(dir, "target");
    const email = jobGet(dir, "email");
    const targetEmail = jobGet(dir, "targetEmail");
    if (!ctx.source || !ctx.target) failJob(ctx, "job record is incomplete");
    try {
      ctx.source = validateDomain(ctx.source, paths.panelIdentityFile, "source");
      ctx.target = validateDomain(ctx.target, paths.panelIdentityFile, "target");
      validateJob(id);
      if (email) validateEmail(email);
      if (targetEmail) validateEmail(targetEmail);
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid job record";
      diagnostic(`[stager] ERROR: ${message}\n`);
      diagnostic(`${actionErrorJson(message)}\n`);
      throw new RunReplyFailure(message);
    }

    const state = jobGet(dir, "state");
    if (state !== "queued") failJob(ctx, `job ${id} is ${state}, not queued`);

    jobSet(dir, "state", "running");
    jobSet(dir, "startedAt", jobTimestamp());
    ctx.rollbackActive = true;

    setStep(ctx, "reading both sites");
    let staging: SiteRow | null;
    let live: SiteRow | null;
    try {
      staging = siteRow(paths, ctx.source);
      live = siteRow(paths, ctx.target);
    } catch {
      failJob(ctx, "cannot read the panel database");
    }
    if (!staging) failJob(ctx, `no CloudPanel site for ${ctx.source}`);
    if (!live) failJob(ctx, `no CloudPanel site for ${ctx.target}`);
    if (!typeIsClonable(staging.type)) {
      failJob(ctx, `${ctx.source} is a '${staging.type}' site; only ${CLONABLE_TYPES.join(" ")} sites can be promoted`);
    }
    if (staging.type !== live.type) {
      failJob(ctx, `${ctx.source} is a '${staging.type}' site and ${ctx.target} is a '${live.type}' site; a promote does not change a site's type`);
    }
    ctx.siteType = staging.type;
    ctx.srcUser = staging.user;
    ctx.dstUser = live.user;
    if (!ctx.srcUser || !ctx.dstUser) failJob(ctx, "both sites must have a site user recorded");

    if (ctx.siteType === "reverse-proxy") {
      promoteInstatic(ctx, email, targetEmail);
    } else {
      await promoteFiles(ctx);
    }

    setStep(ctx, "recording the result");
    const result: PromoteResult = {
      siteType: ctx.siteType,
      siteUser: ctx.dstUser,
      previousRoot: ctx.prevRoot,
      preserved: [...ctx.copiedPreserved, ...ctx.movedPreserved],
      databaseBackup: ctx.dbBackup || null,
      contentBackup: ctx.contentBackup || null,
      notes: ctx.notes,
    };
    writeFileSync(join(dir, "result.json"), `${JSON.stringify(result)}\n`, { mode: 0o600 });
    chmodSync(join(dir, "result.json"), 0o600);
    jobSet(dir, "finishedAt", jobTimestamp());
    jobSet(dir, "state", "done");
    ctx.rollbackActive = false;
    logLine(`promote complete: ${ctx.source} onto ${ctx.target}`);
  } catch (error) {
    if (error instanceof RunReplyFailure) throw error;
    if (ctx.rollbackActive) rollbackPromote(ctx);
    if (!(error instanceof JobFailure) && !ctx.failed) {
      const message = error instanceof Error ? error.message : "promote failed";
      try {
        jobSet(dir, "error", message);
        jobSet(dir, "state", "failed");
      } catch {
        // Keep the stderr-only failure contract even if the record is damaged.
      }
      diagnostic(`[stager] ERROR: ${message}\n`);
    }
    if (error instanceof JobFailure) throw error;
    throw new JobFailure(error instanceof Error ? error.message : "promote failed");
  } finally {
    activeTranscript = previousTranscript;
    transcript.close();
  }
}

/**
 * Put back a document root whose promote died between the two renames.
 *
 * The window is one rename wide, but a site with no document root at all is
 * the worst state this addon can leave behind, so the maintenance pass looks
 * for it explicitly rather than waiting for an operator to notice.
 */
export function recoverInterruptedPromotions(paths: StagerActionPaths): number {
  let recovered = 0;
  for (const id of listJobIds(paths.jobsDir)) {
    const dir = jobDir(paths, id);
    if (jobGet(dir, "kind") !== "promote") continue;
    const state = jobGet(dir, "state");
    if (state === "queued" || state === "running") continue;
    if (jobGet(dir, "swap") !== "moved") continue;
    const liveRoot = jobGet(dir, "liveRoot");
    const prevRoot = jobGet(dir, "prevRoot");
    if (!liveRoot || !prevRoot) continue;
    if (pathExists(liveRoot) || !pathExists(prevRoot)) continue;
    warnLine(`restoring ${liveRoot}: a promote was interrupted while switching it over`);
    try {
      renameSync(prevRoot, liveRoot);
      jobSet(dir, "swap", "rolled-back");
      recovered++;
    } catch {
      warnLine(`could not restore ${liveRoot} from ${prevRoot}`);
    }
  }
  return recovered;
}

/**
 * Drop the replaced document roots of jobs whose records are about to expire.
 *
 * Driven from the records rather than from a directory scan, because the
 * record is what says which path this addon put there. It runs before
 * pruneJobs for the same reason: once the record is gone nothing knows the
 * path was ours.
 */
export function dropExpiredPromoteRoots(paths: StagerActionPaths): number {
  let removed = 0;
  for (const id of listJobIds(paths.jobsDir)) {
    const dir = jobDir(paths, id);
    if (jobGet(dir, "kind") !== "promote") continue;
    const state = jobGet(dir, "state");
    if (state === "queued" || state === "running") continue;
    if (!findOlderThan(dir, 24 * 60 * 60 * 1000, JOB_RETENTION_DAYS)) continue;
    const prevRoot = jobGet(dir, "prevRoot");
    if (!prevRoot || !prevRoot.includes("/.clp-stager-prev-")) continue;
    if (!isDirectory(prevRoot)) continue;
    rmSync(prevRoot, { recursive: true, force: true });
    removed++;
  }
  return removed;
}

function readJobResult(dir: string): unknown {
  const raw = readFileSyncSafe(join(dir, "result.json")).trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // A killed writer can leave a partial result. Returning null keeps the
    // outer job reply a single valid JSON object; the failed/incomplete record
    // remains visible through its state and log.
    return null;
  }
}

function jobJson(paths: StagerActionPaths, dir: string, id: string, hasPanelDb: boolean, panelSites: Set<string>): JobView {
  const target = jobGet(dir, "target");
  let panelSite: boolean | null = null;
  if (hasPanelDb && jobGet(dir, "state") === "done" && target) panelSite = panelSites.has(target);
  const portText = jobGet(dir, "port");
  return {
    id,
    kind: jobGet(dir, "kind") || "clone",
    source: jobGet(dir, "source"),
    target,
    port: /^\d+$/.test(portText) ? Number(portText) || 0 : 0,
    ...jobCommonFields(dir),
    result: readJobResult(dir),
    panelSite,
  };
}

function cmdJob(paths: StagerActionPaths, id: string): void {
  const dir = jobDir(paths, id);
  if (!isDirectory(dir)) failAction(`no such job: ${id}`);
  const panel = panelDomains(paths);
  emitStagerOk(paths, { job: jobJson(paths, dir, id, panel.readable, panel.domains), log: readJobLog(dir) });
}

async function cmdWatchJob(paths: StagerActionPaths, id: string): Promise<void> {
  const dir = jobDir(paths, id);
  if (!isDirectory(dir)) failAction(`no such job: ${id}`);
  await watchJobRecord({
    dir,
    read: () => {
      const panel = jobGet(dir, "state") === "done"
        ? panelDomains(paths)
        : { readable: false, domains: new Set<string>() };
      return { job: jobJson(paths, dir, id, panel.readable, panel.domains), log: readJobLog(dir) };
    },
    emit: (data) => emitStagerOk(paths, data),
  });
}

function cmdJobs(paths: StagerActionPaths): void {
  const panel = panelDomains(paths);
  const jobs = listJobIds(paths.jobsDir).map((id) =>
    jobJson(paths, jobDir(paths, id), id, panel.readable, panel.domains));
  emitStagerOk(paths, { jobs });
}

function cmdPrune(paths: StagerActionPaths): void {
  const promotionsRecovered = recoverInterruptedPromotions(paths);
  const rootsRemoved = dropExpiredPromoteRoots(paths);
  const { removed, stuck } = pruneJobs({
    addon: "stager",
    jobsDir: paths.jobsDir,
    retentionDays: JOB_RETENTION_DAYS,
    stuckMessage: "the clone job stopped without recording a result",
    onStuck: (id, state) =>
      warnLine(`job ${id} is recorded as ${state} but nothing is running it; marking it failed`),
  });

  const vhostsRecovered = recoverCarriedVhosts(paths);
  try {
    for (const entry of readdirSync(paths.tempDir)) {
      if (!entry.startsWith("clp-stager-stage.")) continue;
      const path = join(paths.tempDir, entry);
      if (isDirectory(path) && findOlderThan(path, 60 * 1000, 1440)) rmSync(path, { recursive: true, force: true });
    }
  } catch {
    // Stale staging cleanup is best effort: a failure here must not fail the
    // whole prune.
  }
  emitStagerOk(paths, { removed, stuck, vhostsRecovered, promotionsRecovered, rootsRemoved });
}

async function dispatch(action: ParsedStagerAction, paths: StagerActionPaths, releaseLock: () => void): Promise<void> {
  switch (action.verb) {
    case "sites": cmdSites(paths); return;
    case "jobs": cmdJobs(paths); return;
    case "prune": cmdPrune(paths); return;
    case "describe": cmdDescribe(paths, action.domain); return;
    case "clone": cmdClone(action, paths, releaseLock); return;
    case "promote": cmdPromote(action, paths, releaseLock); return;
    case "run": await cmdRun(action.job, paths); return;
    case "job": cmdJob(paths, action.job); return;
    case "watch-job": await cmdWatchJob(paths, action.job); return;
  }
}

export function validateStagerDomain(value: string, identityPath = PANEL_IDENTITY_PATH): string {
  return validateDomain(value, identityPath, "domain");
}

export function normalizeStagerIdentity(value: string): string | null {
  return normalizeIdentityHostname(value);
}

export function parseStagerAction(argv: string[], options?: StagerActionOptions): ParsedStagerAction {
  return parseAction(argv, pathsFor(options));
}

export async function runStagerAction(argv: string[], options?: StagerActionOptions): Promise<number> {
  const emitReply = options?.emitReply !== false;
  try {
    requireRoot();
    const paths = pathsFor(options);
    const action = parseAction(argv, paths);
    if (action.verb === "prune" && !readPanelIdentity(paths.panelIdentityFile)) {
      failAction("the CloudPanel panel identity is missing or malformed");
    }
    mkdirSync(paths.lockDir, { recursive: true });
    mkdirSync(paths.jobsDir, { recursive: true });
    chmodSync(paths.lockDir, 0o700);
    chmodSync(paths.jobsDir, 0o700);

    let lock: FileLockHandle | null = null;
    const releaseLock = () => {
      lock?.release();
      lock = null;
    };
    try {
      if (action.verb === "clone" || action.verb === "promote") {
        lock = await acquireFileLock(
          join(paths.lockDir, `stager-${action.target}.lock`),
          30,
          `another operation is already running for ${action.target}`,
        );
      } else if (action.verb === "run") {
        const target = jobGet(jobDir(paths, action.job), "target");
        if (target) {
          const normalized = validateDomain(target, paths.panelIdentityFile, "target");
          lock = await acquireFileLock(
            join(paths.lockDir, `stager-${normalized}.lock`),
            30,
            `another operation is already running for ${normalized}`,
          );
        }
      }
      await dispatch(action, paths, releaseLock);
      return 0;
    } finally {
      releaseLock();
    }
  } catch (error) {
    if (error instanceof JobFailure || error instanceof RunReplyFailure) return 1;
    if (error instanceof ActionFailure) {
      emitStagerError(error.message, error.data, emitReply);
      return 1;
    }
    if (error instanceof ActionCommandFailure) {
      emitStagerError(error.message, undefined, emitReply);
      return 1;
    }
    const message = error instanceof Error ? error.message : "stager action failed";
    emitStagerError(message, undefined, emitReply);
    return 1;
  }
}

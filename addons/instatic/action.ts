import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import {
  chmodSync, closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync,
  renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActionCommandFailure, ActionFailure, commandFailure, emitActionError, emitActionOk,
  failAction, forwardCommandOutput, normalizeIdentityHostname,
  PANEL_IDENTITY_PATH,
  readable, runCommand, siteUserFor, validateDomain, validateFlag, validatePort, validateTag,
  withFileLock,
} from "../../cli/action-common";

const REGISTRY_IMAGE = "ghcr.io/corebunch/instatic";
const CONTAINER_PORT = 3001;
const HEALTH_TIMEOUT = 60;

export interface InstaticActionPaths {
  lockDir: string;
  dataBaseDir: string;
  backupDir: string;
  panelDb: string;
  clpctl: string;
  panelIdentityFile: string;
  sqlite3: string;
}

export const DEFAULT_INSTATIC_ACTION_PATHS: InstaticActionPaths = {
  lockDir: "/run/lock/clp-addons",
  dataBaseDir: "/var/lib/clp-addons/instatic",
  backupDir: "/var/backups/clp-addons/instatic",
  panelDb: "/home/clp/htdocs/app/data/db.sq3",
  clpctl: "/usr/bin/clpctl",
  panelIdentityFile: PANEL_IDENTITY_PATH,
  sqlite3: "sqlite3",
};

export type InstaticVerb = "list" | "create" | "update" | "start" | "stop" | "restart" | "recreate" | "snapshot" | "status" | "logs" | "delete";

export interface ParsedInstaticAction {
  verb: InstaticVerb;
  domain: string;
  port: string;
  tag: string;
  confirm: string;
  tls: string;
}

export interface InstaticActionOptions {
  paths?: Partial<InstaticActionPaths>;
}

interface SiteProxyCheck {
  ok: boolean;
  reason: string;
}

interface PanelSiteQuery {
  ok: boolean;
  exists: boolean;
}

function pathsFor(options?: InstaticActionOptions): InstaticActionPaths {
  return { ...DEFAULT_INSTATIC_ACTION_PATHS, ...options?.paths };
}

function requireRoot(): void {
  if (process.getuid?.() !== 0) failAction("instatic actions must run as root");
}

function parseAction(argv: string[], paths: InstaticActionPaths): ParsedInstaticAction {
  if (argv.length === 0) {
    failAction("usage: clp-addons action instatic {list|create|update|recreate|start|stop|restart|delete|snapshot|status|logs} [options]");
  }

  const verb = argv[0] as string;
  let domain = "";
  let port = "";
  let tag = "";
  let confirm = "";
  let tls = "no";

  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--domain" || flag === "--port" || flag === "--tag" || flag === "--confirm" || flag === "--tls") {
      if (i + 1 >= argv.length) failAction(`${flag} needs a value`);
      const value = argv[++i]!;
      if (flag === "--domain") domain = value;
      else if (flag === "--port") port = value;
      else if (flag === "--tag") tag = value;
      else if (flag === "--confirm") confirm = value;
      else tls = value;
    } else {
      failAction(`unknown argument: '${flag}'`);
    }
  }

  let normalizedDomain = domain;
  switch (verb) {
    case "list":
      break;
    case "create":
      normalizedDomain = validateDomain(domain, paths.panelIdentityFile);
      validatePort(port);
      validateTag(tag);
      validateFlag(tls, "tls");
      break;
    case "update":
      normalizedDomain = validateDomain(domain, paths.panelIdentityFile);
      validateTag(tag);
      break;
    case "start":
    case "stop":
    case "restart":
    case "recreate":
    case "snapshot":
    case "status":
    case "logs":
      normalizedDomain = validateDomain(domain, paths.panelIdentityFile);
      break;
    case "delete":
      normalizedDomain = validateDomain(domain, paths.panelIdentityFile);
      break;
    default:
      failAction(`unknown verb: '${verb}'`);
  }

  switch (verb) {
    case "list":
      // This intentionally omits --tls, matching the standalone wrapper's
      // accepted-but-ignored option.
      if (domain || port || tag || confirm) failAction("list takes no arguments");
      break;
    case "update":
      if (port) failAction("update does not take --port");
      break;
    case "delete":
      if (port || tag) failAction("delete takes only --domain and --confirm");
      break;
    case "create":
      // --confirm is accepted and ignored by the existing wrapper.
      break;
    default:
      if (port || tag || confirm) failAction(`${verb} takes only --domain`);
      break;
  }

  return { verb: verb as InstaticVerb, domain: normalizedDomain, port, tag, confirm, tls };
}

function containerName(domain: string): string {
  return `instatic-${domain}`;
}

function instanceDir(domain: string, paths: InstaticActionPaths): string {
  return join(paths.dataBaseDir, domain);
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
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

function readMeta(key: string, file: string): string {
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    return "";
  }
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`.*"${escapedKey}"\\s*:\\s*"?([^",}]*)"?[^\\n]*$`);
  for (const line of content.split("\n")) {
    const match = line.match(pattern);
    if (match) return match[1] ?? "";
  }
  return "";
}

function queryPanel<T>(paths: InstaticActionPaths, query: (db: Database) => T): T {
  if (!readable(paths.panelDb)) throw new Error("panel database is not readable");
  const db = new Database(paths.panelDb, { readonly: true });
  try {
    return query(db);
  } finally {
    db.close();
  }
}

function panelSiteExists(domain: string, paths: InstaticActionPaths): PanelSiteQuery {
  if (!readable(paths.panelDb)) return { ok: false, exists: false };
  try {
    const count = queryPanel(paths, (db) => {
      const row = db.query("SELECT COUNT(*) AS count FROM site WHERE domain_name = ?;").get(domain) as { count?: number | string } | null;
      return Number(row?.count ?? 0);
    });
    return { ok: true, exists: count > 0 };
  } catch {
    return { ok: false, exists: false };
  }
}

function panelSiteDomains(paths: InstaticActionPaths): { readable: boolean; domains: Set<string> } {
  if (!readable(paths.panelDb)) return { readable: false, domains: new Set() };
  try {
    const rows = queryPanel(paths, (db) => db.query("SELECT domain_name FROM site;").all() as Array<{ domain_name?: unknown }>);
    return {
      readable: true,
      domains: new Set(rows.map((row) => typeof row.domain_name === "string" ? row.domain_name : "")),
    };
  } catch {
    // The shell wrapper records that the database was readable before the
    // query, so a failed query reports panelSite=false rather than null.
    return { readable: true, domains: new Set() };
  }
}

function siteIsOurProxy(domain: string, port: string | number, paths: InstaticActionPaths): SiteProxyCheck {
  if (!readable(paths.panelDb)) return { ok: false, reason: "the panel database could not be read" };
  try {
    const row = queryPanel(paths, (db) => db.query(
      "SELECT type, COALESCE(reverse_proxy_url, '') AS url FROM site WHERE domain_name = ?;",
    ).get(domain) as { type?: unknown; url?: unknown } | null);
    const type = typeof row?.type === "string" ? row.type : "";
    const url = typeof row?.url === "string" ? row.url : "";
    if (type !== "reverse-proxy") return { ok: false, reason: `it is a '${type}' site, not a reverse proxy` };
    const expected = `http://127.0.0.1:${String(port)}`;
    if (url !== expected) return { ok: false, reason: `it proxies '${url}' rather than ${expected}` };
    return { ok: true, reason: "" };
  } catch {
    return { ok: false, reason: "the panel database could not be read" };
  }
}

function siteUserOf(domain: string, paths: InstaticActionPaths): string | null {
  if (!readable(paths.panelDb)) return null;
  try {
    const user = queryPanel(paths, (db) => {
      const row = db.query("SELECT user FROM site WHERE domain_name = ?;").get(domain) as { user?: unknown } | null;
      return typeof row?.user === "string" ? row.user : "";
    });
    return user || null;
  } catch {
    return null;
  }
}

function siteUserTaken(user: string): boolean {
  return runCommand("getent", ["passwd", user]).ok;
}

function commandCombinedOutput(command: string, args: string[]): string {
  let directory = "";
  let fd = -1;
  try {
    directory = mkdtempSync(join(tmpdir(), ".clp-addons-output-"));
    const output = join(directory, "output");
    fd = openSync(output, "w", 0o600);
    try {
      // Bash's `2>&1` preserves the relative order of Docker's two streams.
      // Pointing both descriptors at one open file description retains that
      // ordering without introducing a shell or exposing output on stdout.
      Bun.spawnSync([command, ...args], {
        stdin: "ignore",
        stdout: fd,
        stderr: fd,
        env: process.env,
      });
    } catch {
      // The wrapper uses `|| true` for log collection: an unavailable or
      // failing log command contributes whatever output it managed to write.
    }
    closeSync(fd);
    fd = -1;
    return readFileSync(output, "utf8").replace(/\n+$/g, "");
  } catch {
    return "";
  } finally {
    if (fd !== -1) closeSync(fd);
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
}

function containerExists(name: string): boolean {
  const result = runCommand("docker", ["ps", "-a", "--format", "{{.Names}}"]);
  if (!result.ok && result.stderr) process.stderr.write(result.stderr);
  return result.ok && result.stdout.split(/\r?\n/).some((line) => line === name);
}

function runDiagnostic(command: string, args: string[]): boolean {
  const result = runCommand(command, args);
  forwardCommandOutput(result);
  return result.ok;
}

function runStdoutAsDiagnostic(command: string, args: string[]): boolean {
  const result = runCommand(command, args);
  if (result.stdout) process.stderr.write(result.stdout);
  return result.ok;
}

export function portHolder(port: number, self: string, paths: InstaticActionPaths): string | null {
  let entries: string[] = [];
  try {
    entries = readdirSync(paths.dataBaseDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name);
  } catch {
    entries = [];
  }

  for (const domain of entries) {
    if (domain === self) continue;
    const meta = join(paths.dataBaseDir, domain, "meta.json");
    if (!isRegularFile(meta)) continue;
    if (readMeta("port", meta) === String(port)) return `the instance for ${domain}`;
  }

  const listening = runCommand("ss", ["-ltnH", `sport = :${port}`]);
  if (listening.stdout.trim()) return `something already listening on 127.0.0.1:${port}`;
  return null;
}

function generatedPassword(): string {
  const raw = randomBytes(24).toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 16);
  return `Aa1${raw}!`;
}

function writeEnvFile(file: string, key: string, port: number, domain: string): void {
  const temporary = `${file}.tmp`;
  const content = [
    `PORT=${CONTAINER_PORT}`,
    "NODE_ENV=production",
    "DATABASE_URL=sqlite:/app/data/instatic.db",
    "UPLOADS_DIR=/app/uploads",
    `INSTATIC_SECRET_KEY=${key}`,
    `PUBLIC_ORIGIN=https://${domain}`,
    `VITE_ALLOWED_ORIGIN=https://${domain}`,
    "",
  ].join("\n");
  withUmask(0o077, () => writeFileSync(temporary, content, { mode: 0o600 }));
  chmodSync(temporary, 0o600);
  renameSync(temporary, file);
}

function ensureEnvFile(dir: string, port: number, domain: string): void {
  const file = join(dir, "instatic.env");
  if (isRegularFile(file)) {
    let key = "";
    try {
      key = readFileSync(file, "utf8").split(/\r?\n/)
        .find((line) => line.startsWith("INSTATIC_SECRET_KEY="))?.slice("INSTATIC_SECRET_KEY=".length) ?? "";
    } catch {
      key = "";
    }
    if (!key) failAction(`instatic.env for ${domain} has no INSTATIC_SECRET_KEY; refusing to generate a new one over existing data`);
    writeEnvFile(file, key, port, domain);
    return;
  }

  process.stderr.write(`[instatic] generating a master key for ${domain}\n`);
  writeEnvFile(file, randomBytes(32).toString("base64"), port, domain);
}

function resolveOwner(domain: string, paths: InstaticActionPaths): string {
  const user = siteUserOf(domain, paths);
  if (!user) failAction(`no CloudPanel site user for ${domain}; the site must exist before the instance runs`);

  const uidResult = runCommand("id", ["-u", user]);
  const gidResult = runCommand("id", ["-g", user]);
  const uid = uidResult.ok ? uidResult.stdout.trim() : "";
  const gid = gidResult.ok ? gidResult.stdout.trim() : "";
  if (!/^\d+$/.test(uid) || !/^\d+$/.test(gid)) {
    failAction(`CloudPanel lists site user '${user}' for ${domain} but the account does not exist`);
  }
  if (user === "clp" || Number(uid) < 1000) {
    failAction(`refusing to run ${domain} as '${user}' (uid ${uid}): not a site account`);
  }
  return `${uid}:${gid}`;
}

function enforceOwnership(dir: string, owner: string): void {
  mkdirSync(join(dir, "data"), { recursive: true });
  mkdirSync(join(dir, "uploads"), { recursive: true });
  if (!runDiagnostic("chown", ["-R", owner, join(dir, "data"), join(dir, "uploads")])) {
    throw new ActionCommandFailure("chown");
  }
  if (!runDiagnostic("chmod", ["750", join(dir, "data"), join(dir, "uploads")])) {
    throw new ActionCommandFailure("chmod");
  }
  const env = join(dir, "instatic.env");
  if (isRegularFile(env)) {
    if (!runDiagnostic("chown", ["root:root", env])) throw new ActionCommandFailure("chown");
    if (!runDiagnostic("chmod", ["600", env])) throw new ActionCommandFailure("chmod");
  }
}

function runContainer(name: string, port: number, tag: string, domain: string, dir: string, paths: InstaticActionPaths): void {
  const owner = resolveOwner(domain, paths);
  ensureEnvFile(dir, port, domain);
  enforceOwnership(dir, owner);
  const result = runCommand("docker", [
    "run", "-d",
    "--name", name,
    "--user", owner,
    "--restart", "unless-stopped",
    "--label", "clp-addon=instatic",
    "-p", `127.0.0.1:${port}:${CONTAINER_PORT}`,
    "--env-file", join(dir, "instatic.env"),
    "-v", `${join(dir, "data")}:/app/data`,
    "-v", `${join(dir, "uploads")}:/app/uploads`,
    `${REGISTRY_IMAGE}:${tag}`,
  ]);
  forwardCommandOutput(result);
  if (!result.ok) throw commandFailure("docker", result);
}

async function healthCheck(port: number, domain: string): Promise<boolean> {
  let code = "";
  for (let i = 0; i < HEALTH_TIMEOUT; i++) {
    const result = runCommand("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "3", `http://127.0.0.1:${port}/`]);
    if (result.stderr) process.stderr.write(result.stderr);
    code = result.stdout.trim();
    if (/^[23]/.test(code)) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!/^[23]/.test(code)) {
    process.stderr.write(`[instatic] WARN: container did not answer on 127.0.0.1:${port} (last: ${code || "none"})\n`);
    return false;
  }

  for (let i = 0; i < 15; i++) {
    const result = runCommand("curl", ["-sk", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "5", "--resolve", `${domain}:443:127.0.0.1`, `https://${domain}/`]);
    if (result.stderr) process.stderr.write(result.stderr);
    code = result.stdout.trim();
    if (/^[23]/.test(code)) return true;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  process.stderr.write(`[instatic] WARN: container is up but nginx did not serve ${domain} (last: ${code || "none"})\n`);
  return false;
}

function sqliteBackup(source: string, destination: string, sqlite3 = "sqlite3"): boolean {
  const escaped = destination.replaceAll("'", "''");
  const result = runCommand(sqlite3, [source, `.backup '${escaped}'`]);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.ok;
}

function withUmask<T>(mask: number, body: () => T): T {
  const previous = process.umask(mask);
  try {
    return body();
  } finally {
    process.umask(previous);
  }
}

function fileHeader(path: string): string {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(15);
    const length = readSync(fd, buffer, 0, buffer.length, null);
    return buffer.subarray(0, length).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

export function makeSnapshot(dir: string, out: string, sqlite3 = "sqlite3"): boolean {
  let stage: string;
  try {
    stage = mkdtempSync(join(dir, ".snap.XXXXXX"));
  } catch {
    return false;
  }

  const cleanup = () => rmSync(stage, { recursive: true, force: true });
  try {
    mkdirSync(join(stage, "data"), { recursive: true });
    const dataDir = join(dir, "data");
    if (isDirectory(dataDir)) {
      for (const entry of readdirSync(dataDir, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        if (!isRegularFile(join(dataDir, entry.name))) continue;
        if (entry.name.endsWith("-wal") || entry.name.endsWith("-shm")) continue;
        const source = join(dataDir, entry.name);
        const destination = join(stage, "data", entry.name);
        let header = "";
        try {
          header = fileHeader(source);
        } catch {
          cleanup();
          return false;
        }
        if (header === "SQLite format 3") {
          if (!sqliteBackup(source, destination, sqlite3)) {
            process.stderr.write(`[instatic] WARN: sqlite backup failed for ${entry.name}\n`);
            cleanup();
            return false;
          }
        } else {
          try {
            cpSync(source, join(stage, "data"), { recursive: true, preserveTimestamps: true });
          } catch {
            cleanup();
            return false;
          }
        }
      }
    }

    const uploads = join(dir, "uploads");
    if (isDirectory(uploads)) {
      try {
        cpSync(uploads, join(stage, "uploads"), { recursive: true, preserveTimestamps: true });
      } catch {
        cleanup();
        return false;
      }
    }
    const env = join(dir, "instatic.env");
    if (isRegularFile(env)) {
      try {
        cpSync(env, join(stage, "instatic.env"), { recursive: true, preserveTimestamps: true });
      } catch {
        cleanup();
        return false;
      }
    }

    const result = withUmask(0o077, () => runCommand("tar", ["-czf", out, "-C", stage, "."]));
    forwardCommandOutput(result);
    if (!result.ok) {
      process.stderr.write(`[instatic] WARN: tar failed writing ${out}\n`);
      cleanup();
      rmSync(out, { force: true });
      return false;
    }
    chmodSync(out, 0o600);
    cleanup();
    return true;
  } catch {
    cleanup();
    rmSync(out, { force: true });
    return false;
  }
}

export function pruneSnapshots(dir: string): void {
  if (!isDirectory(dir)) return;
  const files = readdirSync(dir)
    .filter((name) => !name.startsWith(".") && name.endsWith(".tar.gz"))
    .map((name) => {
      const path = join(dir, name);
      try {
        return { path, mtime: statSync(path).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((item): item is { path: string; mtime: number } => item !== null)
    .sort((a, b) => b.mtime - a.mtime);
  for (const file of files.slice(5)) rmSync(file.path, { force: true });
}

function dateStamp(utc = false): string {
  const result = runCommand("date", utc ? ["-u", "+%Y-%m-%dT%H:%M:%SZ"] : ["+%Y%m%d%H%M%S"]);
  if (!result.ok) throw commandFailure("date", result);
  return result.stdout.trim();
}

function cleanupCreate(name: string, dir: string, domain: string, siteCreated: boolean, paths: InstaticActionPaths): void {
  process.stderr.write("[instatic] WARN: create failed, unwinding\n");
  runStdoutAsDiagnostic("docker", ["rm", "-f", name]);
  if (siteCreated) {
    process.stderr.write("[instatic] WARN: removing the CloudPanel site this run created\n");
    runStdoutAsDiagnostic(paths.clpctl, ["site:delete", `--domainName=${domain}`, "--force"]);
  }
  rmSync(dir, { recursive: true, force: true });
}

async function cmdCreate(action: ParsedInstaticAction, paths: InstaticActionPaths): Promise<void> {
  const { domain, tag, tls } = action;
  const port = validatePort(action.port);
  const name = containerName(domain);
  const dir = instanceDir(domain, paths);
  if (containerExists(name)) failAction(`container '${name}' already exists`);
  if (existsSync(join(dir, "meta.json"))) failAction(`instance '${domain}' already exists`);

  const holder = portHolder(port, domain, paths);
  if (holder) failAction(`port ${port} is already taken by ${holder}; retry, or pick a hostname whose instance can have a port of its own`);

  let siteCreated = false;
  let cleanupActive = true;
  try {
    const existing = panelSiteExists(domain, paths);
    if (existing.ok && existing.exists) {
      const proxy = siteIsOurProxy(domain, port, paths);
      if (!proxy.ok) {
        failAction(`a CloudPanel site for ${domain} already exists and cannot be adopted: ${proxy.reason}. Delete it, or use a hostname of its own for this instance`);
      }
      process.stderr.write(`[instatic] CloudPanel site ${domain} already exists as the right reverse proxy; adopting it\n`);
    } else {
      process.stderr.write(`[instatic] creating CloudPanel reverse-proxy site for ${domain}\n`);
      const siteUser = siteUserFor(domain);
      if (siteUserTaken(siteUser)) failAction(`the site user ${siteUser} already exists; a site for ${domain} may be half-created`);
      const password = generatedPassword();
      const result = runCommand(paths.clpctl, [
        "site:add:reverse-proxy",
        `--domainName=${domain}`,
        `--reverseProxyUrl=http://127.0.0.1:${port}`,
        `--siteUser=${siteUser}`,
        `--siteUserPassword=${password}`,
      ]);
      forwardCommandOutput(result);
      if (!result.ok) failAction(`clpctl site:add:reverse-proxy failed for ${domain}`);
      siteCreated = true;
    }

    process.stderr.write("[instatic] preparing instance storage\n");
    mkdirSync(join(dir, "data"), { recursive: true });
    mkdirSync(join(dir, "uploads"), { recursive: true });
    mkdirSync(join(dir, "snapshots"), { recursive: true });
    chmodSync(dir, 0o750);
    chmodSync(join(dir, "data"), 0o750);
    chmodSync(join(dir, "uploads"), 0o750);
    chmodSync(join(dir, "snapshots"), 0o700);

    process.stderr.write(`[instatic] pulling ${REGISTRY_IMAGE}:${tag}\n`);
    const pull = runCommand("docker", ["pull", `${REGISTRY_IMAGE}:${tag}`]);
    forwardCommandOutput(pull);
    if (!pull.ok) failAction(`failed to pull ${REGISTRY_IMAGE}:${tag}`);

    process.stderr.write(`[instatic] starting ${name} on 127.0.0.1:${port}\n`);
    try {
      runContainer(name, port, tag, domain, dir, paths);
    } catch (error) {
      if (error instanceof ActionFailure) throw error;
      failAction(`failed to start container ${name}`);
    }

    process.stderr.write("[instatic] health checking\n");
    if (!(await healthCheck(port, domain))) failAction(`health check failed for ${domain}`);

    const siteUserFinal = siteUserOf(domain, paths) ?? "";
    const meta = [
      "{",
      `  \"domain\": ${JSON.stringify(domain)},`,
      `  \"port\": ${port},`,
      `  \"tag\": ${JSON.stringify(tag)},`,
      `  \"container\": ${JSON.stringify(name)},`,
      `  \"siteUser\": ${JSON.stringify(siteUserFinal)},`,
      `  \"siteCreatedByAddon\": ${siteCreated},`,
      `  \"createdAt\": ${JSON.stringify(dateStamp(true))}`,
      "}",
      "",
    ].join("\n");
    writeFileSync(join(dir, "meta.json"), meta);
    cleanupActive = false;

    if (tls === "yes") {
      process.stderr.write(`[instatic] requesting a Let's Encrypt certificate for ${domain}\n`);
      const certificate = runCommand(paths.clpctl, ["lets-encrypt:install:certificate", `--domainName=${domain}`]);
      forwardCommandOutput(certificate);
      if (!certificate.ok) {
        process.stderr.write(`[instatic] WARN: the certificate request failed; point ${domain} at this server and retry from Site -> SSL/TLS\n`);
      }
    }

    emitActionOk({ domain, port, tag, container: name, siteUser: siteUserFinal, siteCreatedByAddon: siteCreated, status: "running" });
  } catch (error) {
    if (cleanupActive) cleanupCreate(name, dir, domain, siteCreated, paths);
    throw error;
  }
}

function rollbackUpdate(name: string, dir: string, snapshot: string, owner: string, previousTag: string): void {
  process.stderr.write(`[instatic] WARN: rolling back to ${previousTag}\n`);
  runStdoutAsDiagnostic("docker", ["rm", "-f", name]);
  rmSync(join(dir, "data"), { recursive: true, force: true });
  rmSync(join(dir, "uploads"), { recursive: true, force: true });
  const restored = runCommand("tar", ["-xzf", snapshot, "-C", dir]);
  forwardCommandOutput(restored);
  try {
    enforceOwnership(dir, owner);
  } catch {
    // The shell rollback continues after ownership repair fails; the old
    // container is still renamed back and restarted below.
  }
  runDiagnostic("docker", ["rename", `${name}-prev`, name]);
  const started = runDiagnostic("docker", ["start", name]);
  if (!started) process.stderr.write("[instatic] WARN: could not restart the previous container\n");
}

async function cmdUpdate(action: ParsedInstaticAction, paths: InstaticActionPaths): Promise<void> {
  const { domain, tag } = action;
  const name = containerName(domain);
  const dir = instanceDir(domain, paths);
  const meta = join(dir, "meta.json");
  if (!isRegularFile(meta)) failAction(`no such instance: ${domain}`);

  const owner = resolveOwner(domain, paths);
  const curTag = readMeta("tag", meta);
  const curPort = readMeta("port", meta);
  if (!curTag || !curPort) failAction(`instance metadata is corrupt for ${domain}`);
  validateTag(curTag);
  const port = validatePort(curPort);
  if (curTag === tag) failAction(`already running tag ${tag}`);

  process.stderr.write("[instatic] snapshotting before update\n");
  mkdirSync(join(dir, "snapshots"), { recursive: true });
  chmodSync(join(dir, "snapshots"), 0o700);
  const snapshot = join(dir, "snapshots", `pre-update-${curTag}-${dateStamp()}.tar.gz`);
  if (!makeSnapshot(dir, snapshot, paths.sqlite3)) failAction(`could not snapshot ${domain} before updating; refusing to continue`);
  pruneSnapshots(join(dir, "snapshots"));

  process.stderr.write(`[instatic] pulling ${REGISTRY_IMAGE}:${tag}\n`);
  const pull = runCommand("docker", ["pull", `${REGISTRY_IMAGE}:${tag}`]);
  forwardCommandOutput(pull);
  if (!pull.ok) failAction(`failed to pull ${REGISTRY_IMAGE}:${tag}`);

  runDiagnostic("docker", ["stop", name]);
  runStdoutAsDiagnostic("docker", ["rm", "-f", `${name}-prev`]);
  const renamed = runCommand("docker", ["rename", name, `${name}-prev`]);
  forwardCommandOutput(renamed);
  if (!renamed.ok) throw commandFailure("docker", renamed);

  try {
    runContainer(name, port, tag, domain, dir, paths);
  } catch (error) {
    if (error instanceof ActionFailure) throw error;
    const startLogs = commandCombinedOutput("docker", ["logs", "--tail", "200", name]);
    rollbackUpdate(name, dir, snapshot, owner, curTag);
    failAction(`failed to start ${tag}; rolled back to ${curTag}`, { failedTag: tag, restoredTag: curTag, logs: startLogs });
  }

  if (!(await healthCheck(port, domain))) {
    process.stderr.write("[instatic] capturing failed container logs before rollback\n");
    const failedLogs = commandCombinedOutput("docker", ["logs", "--tail", "200", name]);
    process.stderr.write(`${failedLogs}\n`);
    rollbackUpdate(name, dir, snapshot, owner, curTag);
    failAction(`health check failed on ${tag}; rolled back to ${curTag}`, { failedTag: tag, restoredTag: curTag, logs: failedLogs });
  }

  runStdoutAsDiagnostic("docker", ["rm", "-f", `${name}-prev`]);
  const temporary = `${dir}/.meta.${process.pid}.${randomBytes(6).toString("hex")}`;
  const original = readFileSync(meta, "utf8");
  const rewritten = original.replace(/"tag"\s*:\s*"[^"]*"/, `"tag": "${tag}"`);
  writeFileSync(temporary, rewritten, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, meta);

  emitActionOk({ domain, previousTag: curTag, newTag: tag, status: "running" });
}

async function cmdLifecycle(action: ParsedInstaticAction, paths: InstaticActionPaths): Promise<void> {
  const { verb, domain } = action;
  const name = containerName(domain);
  const dir = instanceDir(domain, paths);
  if (!containerExists(name)) failAction(`no such container for ${domain}`);
  if (verb !== "stop" && isDirectory(dir)) {
    const owner = resolveOwner(domain, paths);
    enforceOwnership(dir, owner);
  }
  const result = runCommand("docker", [verb, name]);
  forwardCommandOutput(result);
  if (!result.ok) failAction(`docker ${verb} failed for ${domain}`);
  emitActionOk({ domain, action: verb });
}

async function cmdRecreate(action: ParsedInstaticAction, paths: InstaticActionPaths): Promise<void> {
  const { domain } = action;
  const name = containerName(domain);
  const dir = instanceDir(domain, paths);
  const meta = join(dir, "meta.json");
  if (!isRegularFile(meta)) failAction(`no such instance: ${domain}`);
  const tag = validateTag(readMeta("tag", meta));
  const port = validatePort(readMeta("port", meta));
  const owner = resolveOwner(domain, paths);

  process.stderr.write(`[instatic] recreating ${name} at ${tag} as uid ${owner}\n`);
  runStdoutAsDiagnostic("docker", ["rm", "-f", name]);
  try {
    runContainer(name, port, tag, domain, dir, paths);
  } catch (error) {
    if (error instanceof ActionFailure) throw error;
    const logs = commandCombinedOutput("docker", ["logs", "--tail", "200", name]);
    failAction(`failed to recreate ${domain} at ${tag}`, { tag, logs });
  }
  if (!(await healthCheck(port, domain))) failAction(`health check failed after recreating ${domain}`);
  emitActionOk({ domain, tag, port, owner, status: "running" });
}

export function deleteInstaticInstance(
  action: Pick<ParsedInstaticAction, "domain" | "confirm">,
  paths: InstaticActionPaths,
): void {
  const { domain, confirm } = action;
  if (!confirm) failAction("missing --confirm");
  if (domain !== confirm) failAction("--confirm must equal --domain");

  const name = containerName(domain);
  const dir = instanceDir(domain, paths);
  const meta = join(dir, "meta.json");
  if (!isRegularFile(meta)) failAction(`no such instance: ${domain}`);

  let count: number;
  try {
    count = queryPanel(paths, (db) => {
      const row = db.query("SELECT COUNT(*) AS count FROM site WHERE domain_name = ?;").get(domain) as { count?: number | string } | null;
      return Number(row?.count ?? 0);
    });
  } catch {
    failAction("cannot read CloudPanel sites; nothing was deleted");
  }
  if (count !== 0 && count !== 1) failAction("unexpected CloudPanel site count; nothing was deleted");

  const created = readMeta("siteCreatedByAddon", meta) === "true";
  const portText = readMeta("port", meta);
  if (count === 1 && created) {
    const proxy = siteIsOurProxy(domain, portText, paths);
    if (!proxy.ok) failAction(`refusing to delete a changed CloudPanel site: ${proxy.reason}`);
  }

  process.stderr.write("[instatic] archiving instance data before deletion\n");
  mkdirSync(paths.backupDir, { recursive: true });
  chmodSync(paths.backupDir, 0o700);
  const backup = join(paths.backupDir, `${domain}-deleted-${dateStamp()}.tar.gz`);
  if (!makeSnapshot(dir, backup, paths.sqlite3)) failAction("final archive failed; nothing was deleted");

  const containers = runCommand("docker", ["ps", "-a", "--format", "{{.Names}}"]);
  if (containers.stderr) process.stderr.write(containers.stderr);
  if (!containers.ok) failAction("cannot query Docker; data preserved");
  if (containers.stdout.split(/\r?\n/).some((line) => line === name)) {
    const removed = runCommand("docker", ["rm", "-f", name]);
    forwardCommandOutput(removed);
    if (!removed.ok) failAction("container removal failed; data preserved");
  }

  if (created && count === 1) {
    const removed = runCommand(paths.clpctl, ["site:delete", `--domainName=${domain}`, "--force"]);
    forwardCommandOutput(removed);
    if (!removed.ok) failAction("CloudPanel site deletion failed; archive and instance data preserved; retry Delete");
  }
  rmSync(dir, { recursive: true, force: true });
}

function cmdDelete(action: ParsedInstaticAction, paths: InstaticActionPaths): void {
  deleteInstaticInstance(action, paths);
  emitActionOk({ domain: action.domain, status: "deleted" });
}

function cmdSnapshot(action: ParsedInstaticAction, paths: InstaticActionPaths): void {
  const { domain } = action;
  const dir = instanceDir(domain, paths);
  if (!isDirectory(dir)) failAction(`no such instance: ${domain}`);
  mkdirSync(join(dir, "snapshots"), { recursive: true });
  chmodSync(join(dir, "snapshots"), 0o700);
  const out = join(dir, "snapshots", `snapshot-${dateStamp()}.tar.gz`);
  if (!makeSnapshot(dir, out, paths.sqlite3)) failAction(`snapshot failed for ${domain}`);
  pruneSnapshots(join(dir, "snapshots"));
  emitActionOk({ domain, snapshot: out });
}

function containerState(name: string): string {
  const result = runCommand("docker", ["inspect", "-f", "{{.State.Status}}", name]);
  return result.stdout.replace(/\s/g, "") || "absent";
}

function cmdStatus(action: ParsedInstaticAction): void {
  const domain = action.domain;
  const name = containerName(domain);
  emitActionOk({ domain, container: name, state: containerState(name) });
}

function cmdList(paths: InstaticActionPaths): void {
  const panel = panelSiteDomains(paths);
  const instances: Array<Record<string, unknown>> = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(paths.dataBaseDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();
  } catch {
    entries = [];
  }

  for (const entry of entries) {
    const meta = join(paths.dataBaseDir, entry, "meta.json");
    if (!isRegularFile(meta)) continue;
    const domain = readMeta("domain", meta);
    if (!domain) continue;
    const portText = readMeta("port", meta);
    const port = /^\d+$/.test(portText) ? Number(portText) : 0;
    instances.push({
      domain,
      port,
      tag: readMeta("tag", meta),
      container: containerName(domain),
      siteUser: readMeta("siteUser", meta),
      createdAt: readMeta("createdAt", meta),
      state: containerState(containerName(domain)),
      panelSite: panel.readable ? panel.domains.has(domain) : null,
    });
  }
  emitActionOk({ instances });
}

function cmdLogs(action: ParsedInstaticAction): void {
  const domain = action.domain;
  const name = containerName(domain);
  if (!containerExists(name)) failAction(`no such container for ${domain}`);
  const logs = commandCombinedOutput("docker", ["logs", "--tail", "200", name]);
  emitActionOk({ domain, logs });
}

async function dispatch(action: ParsedInstaticAction, paths: InstaticActionPaths): Promise<void> {
  switch (action.verb) {
    case "list": cmdList(paths); return;
    case "create": await cmdCreate(action, paths); return;
    case "update": await cmdUpdate(action, paths); return;
    case "start":
    case "stop":
    case "restart": await cmdLifecycle(action, paths); return;
    case "recreate": await cmdRecreate(action, paths); return;
    case "delete": cmdDelete(action, paths); return;
    case "snapshot": cmdSnapshot(action, paths); return;
    case "status": cmdStatus(action); return;
    case "logs": cmdLogs(action); return;
  }
}

export function validateInstaticDomain(value: string, identityPath = PANEL_IDENTITY_PATH): string {
  return validateDomain(value, identityPath);
}

export function panelIdentityForInstatic(value: string): string | null {
  return normalizeIdentityHostname(value);
}

export function parseInstaticAction(argv: string[], options?: InstaticActionOptions): ParsedInstaticAction {
  return parseAction(argv, pathsFor(options));
}

export async function runInstaticAction(argv: string[], options?: InstaticActionOptions): Promise<number> {
  try {
    requireRoot();
    const paths = pathsFor(options);
    const action = parseAction(argv, paths);
    mkdirSync(paths.lockDir, { recursive: true });
    chmodSync(paths.lockDir, 0o700);
    mkdirSync(paths.dataBaseDir, { recursive: true });

    if (action.verb === "list") {
      await dispatch(action, paths);
    } else {
      const lock = join(paths.lockDir, `${action.domain}.lock`);
      await withFileLock(lock, 300, `another operation is already running for ${action.domain}`, () => dispatch(action, paths));
    }
    return 0;
  } catch (error) {
    if (error instanceof ActionFailure) {
      emitActionError(error.message, error.data);
      return 1;
    }
    if (error instanceof ActionCommandFailure) {
      emitActionError(error.message);
      return 1;
    }
    const message = error instanceof Error ? error.message : "instatic action failed";
    emitActionError(message);
    return 1;
  }
}

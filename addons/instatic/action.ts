import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  chmodSync,
  readdirSync,
  statSync,
  rmSync,
  mkdtempSync,
  openSync,
  readSync,
  closeSync,
  cpSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { Database } from "bun:sqlite";
import {
  createActionContext,
  validateDomain,
  validatePort,
  validateTag,
  validateFlag,
  withDomainLock,
  type ActionContext,
} from "../../lib/action-common";

export const REGISTRY_IMAGE = "ghcr.io/corebunch/instatic";
export const CONTAINER_PORT = 3001;
export function getDataBaseDir(): string { return process.env.DATA_BASE_DIR || "/var/lib/clp-addons/instatic"; }
export const BACKUP_DIR = process.env.BACKUP_DIR || "/var/backups/clp-addons/instatic";
export const PANEL_DB = process.env.PANEL_DB || "/home/clp/htdocs/app/data/db.sq3";
export const CLPCTL = process.env.CLPCTL || "/usr/bin/clpctl";
export const HEALTH_TIMEOUT = 60;

function containerName(domain: string): string {
  return `instatic-${domain}`;
}

function instDir(domain: string): string {
  return `${getDataBaseDir()}/${domain}`;
}

export function siteUserFor(domain: string): string {
  const d = domain.toLowerCase();
  const readable = d.replace(/[^a-z0-9]/g, "").slice(0, 8);
  const hash = Bun.CryptoHasher.hash("sha256", d, "hex").slice(0, 6);
  return `addon-${readable}-${hash}`;
}

function siteUserTaken(user: string): boolean {
  try {
    execFileSync("getent", ["passwd", user], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function panelSiteExists(domain: string): boolean {
  if (!existsSync(PANEL_DB)) return false;
  try {
    const db = new Database(PANEL_DB, { readonly: true });
    try {
      const row = db
        .query("SELECT COUNT(*) as count FROM site WHERE domain_name = ?")
        .get(domain) as { count: number } | null;
      return (row?.count ?? 0) > 0;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

function siteIsOurProxy(
  domain: string,
  port: number,
): { ok: boolean; rejectReason?: string } {
  if (!existsSync(PANEL_DB)) {
    return { ok: false, rejectReason: "the panel database could not be read" };
  }
  try {
    const db = new Database(PANEL_DB, { readonly: true });
    try {
      const row = db
        .query("SELECT type, COALESCE(reverse_proxy_url, '') as url FROM site WHERE domain_name = ?")
        .get(domain) as { type: string; url: string } | null;
      if (!row) {
        return { ok: false, rejectReason: "the panel database could not be read" };
      }
      if (row.type !== "reverse-proxy") {
        return { ok: false, rejectReason: `it is a '${row.type}' site, not a reverse proxy` };
      }
      if (row.url !== `http://127.0.0.1:${port}`) {
        return {
          ok: false,
          rejectReason: `it proxies '${row.url}' rather than http://127.0.0.1:${port}`,
        };
      }
      return { ok: true };
    } finally {
      db.close();
    }
  } catch {
    return { ok: false, rejectReason: "the panel database could not be read" };
  }
}

function siteUserOf(domain: string): string | null {
  if (!existsSync(PANEL_DB)) return null;
  try {
    const db = new Database(PANEL_DB, { readonly: true });
    try {
      const row = db
        .query("SELECT user FROM site WHERE domain_name = ?")
        .get(domain) as { user: string } | null;
      return row?.user || null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

interface ResolvedOwner {
  uid: number;
  gid: number;
  ownerStr: string;
}

function resolveOwner(domain: string, ctx: ActionContext): ResolvedOwner {
  const user = siteUserOf(domain);
  if (!user) {
    ctx.emitErr(
      `no CloudPanel site user for ${domain}; the site must exist before the instance runs`,
    );
  }

  let uid: number;
  let gid: number;
  try {
    uid = parseInt(
      execFileSync("id", ["-u", user], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim(),
      10,
    );
    gid = parseInt(
      execFileSync("id", ["-g", user], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim(),
      10,
    );
  } catch {
    ctx.emitErr(
      `CloudPanel lists site user '${user}' for ${domain} but the account does not exist`,
    );
  }

  if (isNaN(uid) || isNaN(gid)) {
    ctx.emitErr(
      `CloudPanel lists site user '${user}' for ${domain} but the account does not exist`,
    );
  }

  if (user === "clp" || uid < 1000) {
    ctx.emitErr(
      `refusing to run ${domain} as '${user}' (uid ${uid}): not a site account`,
    );
  }

  return { uid, gid, ownerStr: `${uid}:${gid}` };
}

function enforceOwnership(dir: string, owner: ResolvedOwner): void {
  mkdirSync(`${dir}/data`, { recursive: true });
  mkdirSync(`${dir}/uploads`, { recursive: true });
  try {
    execFileSync("chown", ["-R", owner.ownerStr, `${dir}/data`, `${dir}/uploads`], {
      stdio: ["ignore", 2, 2],
    });
  } catch {}
  chmodSync(`${dir}/data`, 0o750);
  chmodSync(`${dir}/uploads`, 0o750);
  if (existsSync(`${dir}/instatic.env`)) {
    try {
      execFileSync("chown", ["root:root", `${dir}/instatic.env`], {
        stdio: ["ignore", 2, 2],
      });
    } catch {}
    chmodSync(`${dir}/instatic.env`, 0o600);
  }
}

export function portHolder(port: number, selfDomain: string): string | null {
  if (existsSync(getDataBaseDir())) {
    for (const entry of readdirSync(getDataBaseDir(), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const metaPath = join(getDataBaseDir(), entry.name, "meta.json");
      if (!existsSync(metaPath)) continue;
      if (entry.name === selfDomain) continue;
      try {
        const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
        if (meta.port === port || parseInt(meta.port, 10) === port) {
          return `the instance for ${entry.name}`;
        }
      } catch {}
    }
  }
  try {
    const out = execFileSync("ss", ["-ltnH", `sport = :${port}`], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (out) return `something already listening on 127.0.0.1:${port}`;
  } catch {}
  return null;
}

function genPassword(): string {
  const raw = randomBytes(24).toString("base64").replace(/[^a-zA-Z0-9]/g, "");
  return `Aa1${raw.slice(0, 16)}!`;
}

function writeEnvFile(envFile: string, key: string, port: number, domain: string): void {
  const content = [
    `PORT=${CONTAINER_PORT}`,
    `NODE_ENV=production`,
    `DATABASE_URL=sqlite:/app/data/instatic.db`,
    `UPLOADS_DIR=/app/uploads`,
    `INSTATIC_SECRET_KEY=${key}`,
    `PUBLIC_ORIGIN=https://${domain}`,
    `VITE_ALLOWED_ORIGIN=https://${domain}`,
    "",
  ].join("\n");
  const tmp = `${envFile}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, envFile);
  chmodSync(envFile, 0o600);
}

function ensureEnvFile(dir: string, port: number, domain: string, ctx: ActionContext): void {
  const file = `${dir}/instatic.env`;
  if (existsSync(file)) {
    const content = readFileSync(file, "utf-8");
    const match = content.match(/^INSTATIC_SECRET_KEY=(.*)$/m);
    const key = match?.[1]?.trim();
    if (!key) {
      ctx.emitErr(
        `instatic.env for ${domain} has no INSTATIC_SECRET_KEY; refusing to generate a new one over existing data`,
      );
    }
    writeEnvFile(file, key, port, domain);
    return;
  }
  ctx.log(`generating a master key for ${domain}`);
  const key = randomBytes(32).toString("base64");
  writeEnvFile(file, key, port, domain);
}

function containerExists(name: string): boolean {
  try {
    const out = execFileSync("docker", ["ps", "-a", "--format", "{{.Names}}"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out
      .split("\n")
      .map((s) => s.trim())
      .includes(name);
  } catch {
    return false;
  }
}

function containerStatus(name: string): string {
  try {
    const out = execFileSync(
      "docker",
      ["inspect", "-f", "{{.State.Status}}", name],
      {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
    return out || "absent";
  } catch {
    return "absent";
  }
}

function runContainer(
  name: string,
  port: number,
  tag: string,
  domain: string,
  dir: string,
  ctx: ActionContext,
): void {
  const owner = resolveOwner(domain, ctx);
  ensureEnvFile(dir, port, domain, ctx);
  enforceOwnership(dir, owner);
  execFileSync(
    "docker",
    [
      "run",
      "-d",
      "--name",
      name,
      "--user",
      owner.ownerStr,
      "--restart",
      "unless-stopped",
      "--label",
      "clp-addon=instatic",
      "-p",
      `127.0.0.1:${port}:${CONTAINER_PORT}`,
      "--env-file",
      `${dir}/instatic.env`,
      "-v",
      `${dir}/data:/app/data`,
      "-v",
      `${dir}/uploads:/app/uploads`,
      `${REGISTRY_IMAGE}:${tag}`,
    ],
    { stdio: ["ignore", 2, 2] },
  );
}

async function healthCheck(port: number, domain: string, ctx: ActionContext): Promise<boolean> {
  let lastCode = "";
  for (let i = 0; i < HEALTH_TIMEOUT; i++) {
    try {
      const out = execFileSync(
        "curl",
        [
          "-s",
          "-o",
          "/dev/null",
          "-w",
          "%{http_code}",
          "--max-time",
          "3",
          `http://127.0.0.1:${port}/`,
        ],
        { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
      lastCode = out;
      if (out.startsWith("2") || out.startsWith("3")) {
        break;
      }
    } catch {}
    await Bun.sleep(1000);
  }
  if (!lastCode.startsWith("2") && !lastCode.startsWith("3")) {
    ctx.warn(`container did not answer on 127.0.0.1:${port} (last: ${lastCode || "none"})`);
    return false;
  }

  let nginxCode = "";
  for (let i = 0; i < 15; i++) {
    try {
      const out = execFileSync(
        "curl",
        [
          "-sk",
          "-o",
          "/dev/null",
          "-w",
          "%{http_code}",
          "--max-time",
          "5",
          "--resolve",
          `${domain}:443:127.0.0.1`,
          `https://${domain}/`,
        ],
        { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
      nginxCode = out;
      if (out.startsWith("2") || out.startsWith("3")) {
        return true;
      }
    } catch {}
    await Bun.sleep(1000);
  }
  ctx.warn(`container is up but nginx did not serve ${domain} (last: ${nginxCode || "none"})`);
  return false;
}

export function makeSnapshot(dir: string, out: string, ctx: ActionContext): boolean {
  const stage = mkdtempSync(join(dir, ".snap."));
  try {
    mkdirSync(join(stage, "data"), { recursive: true });
    const dataDir = join(dir, "data");
    if (existsSync(dataDir)) {
      for (const file of readdirSync(dataDir)) {
        const filePath = join(dataDir, file);
        const stat = statSync(filePath);
        if (!stat.isFile()) continue;
        if (file.endsWith("-wal") || file.endsWith("-shm")) continue;

        let isSqlite = false;
        try {
          const headBuf = Buffer.alloc(15);
          const fd = openSync(filePath, "r");
          readSync(fd, headBuf, 0, 15, 0);
          closeSync(fd);
          isSqlite = headBuf.toString("utf-8") === "SQLite format 3";
        } catch {}

        if (isSqlite) {
          try {
            execFileSync(
              "sqlite3",
              [filePath, `.backup '${join(stage, "data", file)}'`],
              { stdio: ["ignore", 2, 2] },
            );
          } catch {
            ctx.warn(`sqlite backup failed for ${file}`);
            rmSync(stage, { recursive: true, force: true });
            return false;
          }
        } else {
          cpSync(filePath, join(stage, "data", file));
        }
      }
    }

    const uploadsDir = join(dir, "uploads");
    if (existsSync(uploadsDir)) {
      cpSync(uploadsDir, join(stage, "uploads"), { recursive: true });
    }
    const envFile = join(dir, "instatic.env");
    if (existsSync(envFile)) {
      cpSync(envFile, join(stage, "instatic.env"));
    }

    execFileSync("tar", ["-czf", out, "-C", stage, "."], {
      stdio: ["ignore", 2, 2],
    });
    chmodSync(out, 0o600);
    return true;
  } catch {
    ctx.warn(`tar failed writing ${out}`);
    rmSync(out, { force: true });
    return false;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

export function pruneSnapshots(dir: string, keep = 5): void {
  if (!existsSync(dir)) return;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".tar.gz"))
    .map((f) => ({
      path: join(dir, f),
      mtime: statSync(join(dir, f)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);
  for (let i = keep; i < files.length; i++) {
    rmSync(files[i]!.path, { force: true });
  }
}

// ----------------- Verbs -----------------

async function cmdList(ctx: ActionContext): Promise<void> {
  let panelSites: Set<string> | null = null;
  if (existsSync(PANEL_DB)) {
    try {
      const db = new Database(PANEL_DB, { readonly: true });
      try {
        const rows = db.query("SELECT domain_name FROM site").all() as { domain_name: string }[];
        panelSites = new Set(rows.map((r) => r.domain_name));
      } finally {
        db.close();
      }
    } catch {}
  }

  const instances: Array<{
    domain: string;
    port: number;
    tag: string;
    container: string;
    siteUser: string;
    createdAt: string;
    state: string;
    panelSite: boolean | null;
  }> = [];

  if (existsSync(getDataBaseDir())) {
    for (const entry of readdirSync(getDataBaseDir(), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const metaPath = join(getDataBaseDir(), entry.name, "meta.json");
      if (!existsSync(metaPath)) continue;
      try {
        const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
        const domain = meta.domain;
        if (!domain) continue;
        const name = containerName(domain);
        const state = containerStatus(name);
        const portNum = parseInt(meta.port, 10);
        instances.push({
          domain,
          port: isNaN(portNum) ? 0 : portNum,
          tag: meta.tag ?? "",
          container: meta.container ?? name,
          siteUser: meta.siteUser ?? "",
          createdAt: meta.createdAt ?? "",
          state,
          panelSite: panelSites ? panelSites.has(domain) : null,
        });
      } catch {}
    }
  }

  ctx.emitOk({ instances });
}

function captureDockerLogs(name: string, tail = "200"): string {
  try {
    const res = spawnSync("docker", ["logs", "--tail", tail, name], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return (res.stdout || "") + (res.stderr || "");
  } catch {
    return "";
  }
}

async function cmdCreate(
  domain: string,
  port: number,
  tag: string,
  tls: string,
  ctx: ActionContext,
): Promise<void> {
  const name = containerName(domain);
  const dir = instDir(domain);

  if (containerExists(name)) {
    ctx.emitErr(`container '${name}' already exists`);
  }
  if (existsSync(`${dir}/meta.json`)) {
    ctx.emitErr(`instance '${domain}' already exists`);
  }

  const holder = portHolder(port, domain);
  if (holder) {
    ctx.emitErr(
      `port ${port} is already taken by ${holder}; retry, or pick a hostname whose instance can have a port of its own`,
    );
  }

  let siteCreated = false;
  let unwound = false;
  const unwind = () => {
    if (unwound) return;
    unwound = true;
    ctx.warn("create failed, unwinding");
    try {
      execFileSync("docker", ["rm", "-f", name], { stdio: ["ignore", 2, 2] });
    } catch {}
    if (siteCreated) {
      ctx.warn("removing the CloudPanel site this run created");
      try {
        execFileSync(CLPCTL, ["site:delete", `--domainName=${domain}`, "--force"], {
          stdio: ["ignore", 2, 2],
        });
      } catch {}
    }
    rmSync(dir, { recursive: true, force: true });
  };

  const createCtx: ActionContext = {
    ...ctx,
    emitErr(msg: string, data?: unknown): never {
      unwind();
      ctx.emitErr(msg, data);
    },
  };

  try {
    if (panelSiteExists(domain)) {
      const proxyCheck = siteIsOurProxy(domain, port);
      if (!proxyCheck.ok) {
        createCtx.emitErr(
          `a CloudPanel site for ${domain} already exists and cannot be adopted: ${proxyCheck.rejectReason}. Delete it, or use a hostname of its own for this instance`,
        );
      }
      ctx.log(`CloudPanel site ${domain} already exists as the right reverse proxy; adopting it`);
    } else {
      ctx.log(`creating CloudPanel reverse-proxy site for ${domain}`);
      const siteUser = siteUserFor(domain);
      if (siteUserTaken(siteUser)) {
        createCtx.emitErr(
          `the site user ${siteUser} already exists; a site for ${domain} may be half-created`,
        );
      }
      try {
        execFileSync(
          CLPCTL,
          [
            "site:add:reverse-proxy",
            `--domainName=${domain}`,
            `--reverseProxyUrl=http://127.0.0.1:${port}`,
            `--siteUser=${siteUser}`,
            `--siteUserPassword=${genPassword()}`,
          ],
          { stdio: ["ignore", 2, 2] },
        );
        siteCreated = true;
      } catch {
        createCtx.emitErr(`clpctl site:add:reverse-proxy failed for ${domain}`);
      }
    }

    mkdirSync(`${dir}/data`, { recursive: true });
    mkdirSync(`${dir}/uploads`, { recursive: true });
    mkdirSync(`${dir}/snapshots`, { recursive: true });
    chmodSync(dir, 0o750);
    chmodSync(`${dir}/data`, 0o750);
    chmodSync(`${dir}/uploads`, 0o750);
    chmodSync(`${dir}/snapshots`, 0o700);

    ctx.log(`pulling ${REGISTRY_IMAGE}:${tag}`);
    try {
      execFileSync("docker", ["pull", `${REGISTRY_IMAGE}:${tag}`], {
        stdio: ["ignore", 2, 2],
      });
    } catch {
      createCtx.emitErr(`failed to pull ${REGISTRY_IMAGE}:${tag}`);
    }

    ctx.log(`starting ${name} on 127.0.0.1:${port}`);
    try {
      runContainer(name, port, tag, domain, dir, createCtx);
    } catch {
      createCtx.emitErr(`failed to start container ${name}`);
    }

    ctx.log("health checking");
    const healthy = await healthCheck(port, domain, createCtx);
    if (!healthy) {
      createCtx.emitErr(`health check failed for ${domain}`);
    }

    const siteUser = siteUserOf(domain) || "";
    const meta = {
      domain,
      port,
      tag,
      container: name,
      siteUser,
      siteCreatedByAddon: siteCreated,
      createdAt: new Date().toISOString(),
    };
    const tmpMeta = `${dir}/meta.json.tmp`;
    writeFileSync(tmpMeta, JSON.stringify(meta, null, 2) + "\n");
    renameSync(tmpMeta, `${dir}/meta.json`);
    unwound = true;

    if (tls === "yes") {
      ctx.log(`requesting a Let's Encrypt certificate for ${domain}`);
      try {
        execFileSync(CLPCTL, ["lets-encrypt:install:certificate", `--domainName=${domain}`], {
          stdio: ["ignore", 2, 2],
        });
      } catch {
        ctx.warn(
          `the certificate request failed; point ${domain} at this server and retry from Site -> SSL/TLS`,
        );
      }
    }

    ctx.emitOk({
      domain,
      port,
      tag,
      container: name,
      siteUser,
      siteCreatedByAddon: siteCreated,
      status: "running",
    });
  } catch (err) {
    unwind();
    throw err;
  }
}

async function cmdUpdate(domain: string, tag: string, ctx: ActionContext): Promise<void> {
  const dir = instDir(domain);
  const metaPath = `${dir}/meta.json`;
  if (!existsSync(metaPath)) {
    ctx.emitErr(`no such instance: ${domain}`);
  }

  const owner = resolveOwner(domain, ctx);

  let meta: { port: number; tag: string; [key: string]: unknown };
  try {
    meta = JSON.parse(readFileSync(metaPath, "utf-8"));
  } catch {
    ctx.emitErr(`instance metadata is corrupt for ${domain}`);
  }

  const curTag = meta.tag;
  const curPort = meta.port;
  if (!curTag || !curPort) {
    ctx.emitErr(`instance metadata is corrupt for ${domain}`);
  }
  validateTag(curTag, ctx);
  validatePort(curPort.toString(), ctx);

  if (curTag === tag) {
    ctx.emitErr(`already running tag ${tag}`);
  }

  ctx.log("snapshotting before update");
  mkdirSync(`${dir}/snapshots`, { recursive: true });
  chmodSync(`${dir}/snapshots`, 0o700);
  const snapDate = new Date().toISOString().replace(/[:.]/g, "-");
  const snap = `${dir}/snapshots/pre-update-${curTag}-${snapDate}.tar.gz`;

  if (!makeSnapshot(dir, snap, ctx)) {
    ctx.emitErr(`could not snapshot ${domain} before updating; refusing to continue`);
  }
  pruneSnapshots(`${dir}/snapshots`);

  ctx.log(`pulling ${REGISTRY_IMAGE}:${tag}`);
  try {
    execFileSync("docker", ["pull", `${REGISTRY_IMAGE}:${tag}`], {
      stdio: ["ignore", 2, 2],
    });
  } catch {
    ctx.emitErr(`failed to pull ${REGISTRY_IMAGE}:${tag}`);
  }

  const name = containerName(domain);
  try {
    execFileSync("docker", ["stop", name], { stdio: ["ignore", 2, 2] });
  } catch {}
  try {
    execFileSync("docker", ["rm", "-f", `${name}-prev`], { stdio: ["ignore", 2, 2] });
  } catch {}
  try {
    execFileSync("docker", ["rename", name, `${name}-prev`], { stdio: ["ignore", 2, 2] });
  } catch {}

  const rollback = () => {
    ctx.warn(`rolling back to ${curTag}`);
    try {
      execFileSync("docker", ["rm", "-f", name], { stdio: ["ignore", 2, 2] });
    } catch {}
    rmSync(`${dir}/data`, { recursive: true, force: true });
    rmSync(`${dir}/uploads`, { recursive: true, force: true });
    try {
      execFileSync("tar", ["-xzf", snap, "-C", dir], { stdio: ["ignore", 2, 2] });
    } catch {}
    enforceOwnership(dir, owner);
    try {
      execFileSync("docker", ["rename", `${name}-prev`, name], { stdio: ["ignore", 2, 2] });
    } catch {}
    try {
      execFileSync("docker", ["start", name], { stdio: ["ignore", 2, 2] });
    } catch {
      ctx.warn("could not restart the previous container");
    }
  };

  try {
    runContainer(name, curPort, tag, domain, dir, ctx);
  } catch {
    const startLogs = captureDockerLogs(name, "200");
    rollback();
    ctx.emitErr(`failed to start ${tag}; rolled back to ${curTag}`, {
      failedTag: tag,
      restoredTag: curTag,
      logs: startLogs,
    });
  }

  const healthy = await healthCheck(curPort, domain, ctx);
  if (!healthy) {
    ctx.log("capturing failed container logs before rollback");
    const failedLogs = captureDockerLogs(name, "200");
    if (failedLogs) {
      process.stderr.write(failedLogs);
    }
    rollback();
    ctx.emitErr(`health check failed on ${tag}; rolled back to ${curTag}`, {
      failedTag: tag,
      restoredTag: curTag,
      logs: failedLogs,
    });
  }

  try {
    execFileSync("docker", ["rm", "-f", `${name}-prev`], { stdio: ["ignore", 2, 2] });
  } catch {}

  meta.tag = tag;
  const tmpMeta = `${dir}/meta.json.tmp`;
  writeFileSync(tmpMeta, JSON.stringify(meta, null, 2) + "\n");
  renameSync(tmpMeta, metaPath);

  ctx.emitOk({
    domain,
    previousTag: curTag,
    newTag: tag,
    status: "running",
  });
}

async function cmdLifecycle(domain: string, action: "start" | "stop" | "restart", ctx: ActionContext): Promise<void> {
  const name = containerName(domain);
  if (!containerExists(name)) {
    ctx.emitErr(`no such container for ${domain}`);
  }

  const dir = instDir(domain);
  if (action !== "stop" && existsSync(dir)) {
    const owner = resolveOwner(domain, ctx);
    enforceOwnership(dir, owner);
  }

  try {
    execFileSync("docker", [action, name], { stdio: ["ignore", 2, 2] });
  } catch {
    ctx.emitErr(`docker ${action} failed for ${domain}`);
  }

  ctx.emitOk({ domain, action });
}

async function cmdRecreate(domain: string, ctx: ActionContext): Promise<void> {
  const dir = instDir(domain);
  const metaPath = `${dir}/meta.json`;
  if (!existsSync(metaPath)) {
    ctx.emitErr(`no such instance: ${domain}`);
  }

  let meta: { tag: string; port: number; [key: string]: unknown };
  try {
    meta = JSON.parse(readFileSync(metaPath, "utf-8"));
  } catch {
    ctx.emitErr(`instance metadata is corrupt for ${domain}`);
  }

  const tag = meta.tag;
  const port = meta.port;
  validateTag(tag, ctx);
  validatePort(port.toString(), ctx);

  const owner = resolveOwner(domain, ctx);
  const name = containerName(domain);

  ctx.log(`recreating ${name} at ${tag} as uid ${owner.ownerStr}`);
  try {
    execFileSync("docker", ["rm", "-f", name], { stdio: ["ignore", 2, 2] });
  } catch {}

  try {
    runContainer(name, port, tag, domain, dir, ctx);
  } catch {
    const startLogs = captureDockerLogs(name, "200");
    ctx.emitErr(`failed to recreate ${domain} at ${tag}`, { tag, logs: startLogs });
  }

  const healthy = await healthCheck(port, domain, ctx);
  if (!healthy) {
    ctx.emitErr(`health check failed after recreating ${domain}`);
  }

  ctx.emitOk({
    domain,
    tag,
    port,
    owner: owner.ownerStr,
    status: "running",
  });
}

async function cmdDelete(domain: string, confirm: string | undefined, ctx: ActionContext): Promise<void> {
  if (!confirm) {
    ctx.emitErr("missing --confirm");
  }
  if (domain !== confirm) {
    ctx.emitErr("--confirm must equal --domain");
  }

  const dir = instDir(domain);
  const metaPath = `${dir}/meta.json`;
  if (!existsSync(metaPath)) {
    ctx.emitErr(`no such instance: ${domain}`);
  }

  if (!existsSync(PANEL_DB)) {
    ctx.emitErr("cannot read the panel database");
  }

  let count = 0;
  try {
    const db = new Database(PANEL_DB, { readonly: true });
    try {
      const row = db
        .query("SELECT COUNT(*) as count FROM site WHERE domain_name = ?")
        .get(domain) as { count: number } | null;
      count = row?.count ?? 0;
    } finally {
      db.close();
    }
  } catch {
    ctx.emitErr("cannot read the panel database");
  }

  if (count !== 0 && count !== 1) {
    ctx.emitErr("unexpected CloudPanel site count; nothing was deleted");
  }

  let createdByAddon = false;
  let port = 0;
  try {
    const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
    createdByAddon = meta.siteCreatedByAddon === true;
    port = parseInt(meta.port, 10) || 0;
  } catch {}

  if (count === 1 && createdByAddon) {
    const proxyCheck = siteIsOurProxy(domain, port);
    if (!proxyCheck.ok) {
      ctx.emitErr(`refusing to delete a changed CloudPanel site: ${proxyCheck.rejectReason}`);
    }
  }

  ctx.log("archiving instance data before deletion");
  mkdirSync(BACKUP_DIR, { recursive: true });
  chmodSync(BACKUP_DIR, 0o700);
  const delDate = new Date().toISOString().replace(/[:.]/g, "-");
  const archive = `${BACKUP_DIR}/${domain}-deleted-${delDate}.tar.gz`;

  if (!makeSnapshot(dir, archive, ctx)) {
    ctx.emitErr("final archive failed; nothing was deleted");
  }

  const name = containerName(domain);
  let containers: string[] = [];
  try {
    const out = execFileSync("docker", ["ps", "-a", "--format", "{{.Names}}"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", 2],
    });
    containers = out.split("\n").map((s) => s.trim());
  } catch {
    ctx.emitErr("cannot query Docker; data preserved");
  }
  if (containers.includes(name)) {
    try {
      execFileSync("docker", ["rm", "-f", name], { stdio: ["ignore", 2, 2] });
    } catch {
      ctx.emitErr("container removal failed; data preserved");
    }
  }

  if (createdByAddon && count === 1) {
    try {
      execFileSync(CLPCTL, ["site:delete", `--domainName=${domain}`, "--force"], {
        stdio: ["ignore", 2, 2],
      });
    } catch {
      ctx.emitErr(
        "CloudPanel site deletion failed; archive and instance data preserved; retry Delete",
      );
    }
  }

  rmSync(dir, { recursive: true, force: true });
  ctx.emitOk({ domain, status: "deleted" });
}

async function cmdSnapshot(domain: string, ctx: ActionContext): Promise<void> {
  const dir = instDir(domain);
  if (!existsSync(dir)) {
    ctx.emitErr(`no such instance: ${domain}`);
  }

  mkdirSync(`${dir}/snapshots`, { recursive: true });
  chmodSync(`${dir}/snapshots`, 0o700);
  const snapDate = new Date().toISOString().replace(/[:.]/g, "-");
  const out = `${dir}/snapshots/snapshot-${snapDate}.tar.gz`;

  if (!makeSnapshot(dir, out, ctx)) {
    ctx.emitErr(`snapshot failed for ${domain}`);
  }
  pruneSnapshots(`${dir}/snapshots`);

  ctx.emitOk({ domain, snapshot: out });
}

async function cmdStatus(domain: string, ctx: ActionContext): Promise<void> {
  const name = containerName(domain);
  const state = containerStatus(name);
  ctx.emitOk({ domain, container: name, state });
}

async function cmdLogs(domain: string, ctx: ActionContext): Promise<void> {
  const name = containerName(domain);
  if (!containerExists(name)) {
    ctx.emitErr(`no such container for ${domain}`);
  }

  const res = spawnSync("docker", ["logs", "--tail", "200", name], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.error || (res.status !== 0 && !res.stdout && !res.stderr)) {
    ctx.emitErr(`failed to fetch logs for ${domain}`);
  }

  const body = (res.stdout || "") + (res.stderr || "");
  ctx.emitOk({ domain, logs: body });
}

// ----------------- Entrypoint -----------------

export async function handleInstaticAction(args: string[]): Promise<void> {
  const ctx = createActionContext("instatic");

  if (args.length === 0) {
    ctx.emitErr(
      "usage: clp-action-instatic {list|create|update|recreate|start|stop|restart|delete|snapshot|status|logs} [options]",
    );
  }

  const verb = args[0]!;
  const rest = args.slice(1);

  let rawDomain: string | undefined;
  let rawPort: string | undefined;
  let rawTag: string | undefined;
  let rawConfirm: string | undefined;
  let rawTls = "no";
  let hasTls = false;

  let i = 0;
  while (i < rest.length) {
    const arg = rest[i]!;
    if (arg === "--domain") {
      if (i + 1 >= rest.length) ctx.emitErr("--domain needs a value");
      rawDomain = rest[i + 1];
      i += 2;
    } else if (arg === "--port") {
      if (i + 1 >= rest.length) ctx.emitErr("--port needs a value");
      rawPort = rest[i + 1];
      i += 2;
    } else if (arg === "--tag") {
      if (i + 1 >= rest.length) ctx.emitErr("--tag needs a value");
      rawTag = rest[i + 1];
      i += 2;
    } else if (arg === "--confirm") {
      if (i + 1 >= rest.length) ctx.emitErr("--confirm needs a value");
      rawConfirm = rest[i + 1];
      i += 2;
    } else if (arg === "--tls") {
      if (i + 1 >= rest.length) ctx.emitErr("--tls needs a value");
      rawTls = rest[i + 1]!;
      hasTls = true;
      i += 2;
    } else {
      ctx.emitErr(`unknown argument: '${arg}'`);
    }
  }

  const validVerbs = [
    "list",
    "create",
    "update",
    "recreate",
    "start",
    "stop",
    "restart",
    "delete",
    "snapshot",
    "status",
    "logs",
  ];
  if (!validVerbs.includes(verb)) {
    ctx.emitErr(`unknown verb: '${verb}'`);
  }

  let domain = "";
  let port = 0;
  let tag = "";
  let tls = "no";

  switch (verb) {
    case "list":
      if (rawDomain || rawPort || rawTag || rawConfirm || hasTls) {
        ctx.emitErr("list takes no arguments");
      }
      return await cmdList(ctx);

    case "create":
      domain = validateDomain(rawDomain, ctx);
      port = validatePort(rawPort, ctx);
      tag = validateTag(rawTag, ctx);
      tls = validateFlag(rawTls, "tls", ctx);
      if (rawConfirm) {
        ctx.emitErr("unknown argument: '--confirm'");
      }
      return await withDomainLock(domain, ctx, () =>
        cmdCreate(domain, port, tag, tls, ctx),
      );

    case "update":
      domain = validateDomain(rawDomain, ctx);
      tag = validateTag(rawTag, ctx);
      if (rawPort) {
        ctx.emitErr("update does not take --port");
      }
      if (rawConfirm || hasTls) {
        ctx.emitErr("update takes only --domain and --tag");
      }
      return await withDomainLock(domain, ctx, () =>
        cmdUpdate(domain, tag, ctx),
      );

    case "delete":
      domain = validateDomain(rawDomain, ctx);
      if (rawPort || rawTag) {
        ctx.emitErr("delete takes only --domain and --confirm");
      }
      if (hasTls) {
        ctx.emitErr("delete takes only --domain and --confirm");
      }
      return await withDomainLock(domain, ctx, () =>
        cmdDelete(domain, rawConfirm, ctx),
      );

    case "start":
    case "stop":
    case "restart":
      domain = validateDomain(rawDomain, ctx);
      if (rawPort || rawTag || rawConfirm || hasTls) {
        ctx.emitErr(`${verb} takes only --domain`);
      }
      return await withDomainLock(domain, ctx, () =>
        cmdLifecycle(domain, verb as "start" | "stop" | "restart", ctx),
      );

    case "recreate":
      domain = validateDomain(rawDomain, ctx);
      if (rawPort || rawTag || rawConfirm || hasTls) {
        ctx.emitErr("recreate takes only --domain");
      }
      return await withDomainLock(domain, ctx, () =>
        cmdRecreate(domain, ctx),
      );

    case "snapshot":
    case "status":
    case "logs":
      domain = validateDomain(rawDomain, ctx);
      if (rawPort || rawTag || rawConfirm || hasTls) {
        ctx.emitErr(`${verb} takes only --domain`);
      }
      if (verb === "snapshot") {
        return await withDomainLock(domain, ctx, () => cmdSnapshot(domain, ctx));
      } else if (verb === "status") {
        return await withDomainLock(domain, ctx, () => cmdStatus(domain, ctx));
      } else {
        return await withDomainLock(domain, ctx, () => cmdLogs(domain, ctx));
      }
  }
}

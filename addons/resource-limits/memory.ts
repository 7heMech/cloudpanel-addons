/**
 * Memory limits sized to the server: MySQL's buffer pool, connections and
 * per-connection buffers, a cap on Redis, and which processes the kernel kills
 * first when memory runs out. What is saved is a profile, never a number: the
 * numbers come from the RAM the server has when each service starts, so a
 * server resized up or down picks them up at its next boot. See "Memory
 * limits" in docs/decisions/resource-limits.md.
 */
import { errorMessage } from "../../lib/errors";
import { addonStateDir, CLI_BIN, LOCK_DIR, SYSTEMD_DIR } from "../../lib/paths";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { failAction } from "../../lib/action";
import { runCommand, type CommandResult } from "../../lib/command";
import { withFileLockSync } from "../../lib/file-lock";
import { writeFileAtomic } from "../../lib/atomic-write";
import { COMMAND_MS } from "./limits";

export const MEMORY_PROFILES = ["balanced", "database", "cache"] as const;
export type MemoryProfile = typeof MEMORY_PROFILES[number];

export interface MemorySettings {
  profile: MemoryProfile;
  /** Size MySQL from the server's RAM instead of CloudPanel's fixed values. */
  mysql: boolean;
  /** Cap Redis and evict its least recently used keys at the cap. */
  redis: boolean;
  /** Have the kernel kill a site's PHP worker before MySQL or nginx. */
  oom: boolean;
}

export const DEFAULT_MEMORY: MemorySettings = { profile: "balanced", mysql: false, redis: false, oom: true };

export const MEMORY_ERROR = "profile must be balanced, database or cache, and mysql, redis and oom true or false";

export function memoryChange(body: Record<string, unknown>): Partial<MemorySettings> | null {
  const change: Partial<MemorySettings> = {};
  if (body.profile !== undefined) {
    if (!(MEMORY_PROFILES as readonly unknown[]).includes(body.profile)) return null;
    change.profile = body.profile as MemoryProfile;
  }
  for (const key of ["mysql", "redis", "oom"] as const) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== "boolean") return null;
    change[key] = body[key];
  }
  return Object.keys(change).length ? change : null;
}

export function validMemorySettings(value: unknown): value is MemorySettings {
  if (!value || typeof value !== "object") return false;
  const stored = value as Record<string, unknown>;
  return (MEMORY_PROFILES as readonly unknown[]).includes(stored.profile)
    && typeof stored.mysql === "boolean" && typeof stored.redis === "boolean" && typeof stored.oom === "boolean";
}

// --- Sizing ----------------------------------------------------------------

/** Shares of the server's RAM. */
const SHARES: Record<MemoryProfile, { pool: number; connections: number; redis: number }> = {
  balanced: { pool: 0.25, connections: 0.15, redis: 0.10 },
  database: { pool: 0.40, connections: 0.20, redis: 0.05 },
  cache: { pool: 0.15, connections: 0.10, redis: 0.20 },
};

/** What one connection can hold at once with the buffers below, in MB, rounded up. */
export const CONNECTION_MB = 8;
const MIN_CONNECTIONS = 100;
const MAX_CONNECTIONS = 512;
/** InnoDB grows the pool in 128 MB chunks per instance, and rounds a size up to them. */
const CHUNK_MB = 128;

interface MemoryPlan {
  ramMb: number;
  bufferPoolMb: number;
  poolInstances: number;
  maxConnections: number;
  /** MySQL 8's cap on all in-memory temporary tables together. */
  tempTableRamMb: number;
  redisMb: number;
}

export function memoryPlan(ramMb: number, profile: MemoryProfile): MemoryPlan {
  const share = SHARES[profile];
  const wanted = Math.max(CHUNK_MB, Math.floor(ramMb * share.pool));
  // One instance per GB, as MySQL itself uses a single one below 1 GB.
  const poolInstances = Math.min(8, Math.max(1, Math.floor(wanted / 1024)));
  const unit = CHUNK_MB * poolInstances;
  return {
    ramMb,
    bufferPoolMb: Math.max(unit, Math.floor(wanted / unit) * unit),
    poolInstances,
    maxConnections: Math.min(MAX_CONNECTIONS, Math.max(MIN_CONNECTIONS, Math.floor(ramMb * share.connections / CONNECTION_MB))),
    tempTableRamMb: Math.min(1024, Math.max(64, Math.floor(ramMb * 0.05))),
    redisMb: Math.max(64, Math.floor(ramMb * share.redis)),
  };
}

export const MYSQL_MARKER = "# Managed by clp-addons Resource Limits: MySQL memory sized for this server.";

/**
 * Read after CloudPanel's own mysqld.cnf, so these win. `loose-` options are
 * ones MariaDB does not know; it warns and starts.
 */
export function mysqlOptionFile(plan: MemoryPlan, profile: MemoryProfile): string {
  return [
    MYSQL_MARKER,
    `# The ${profile} profile for ${plan.ramMb} MB of RAM, worked out again each time MySQL starts. Switching it off removes this file.`,
    "[mysqld]",
    `innodb_buffer_pool_size = ${plan.bufferPoolMb}M`,
    `loose-innodb_buffer_pool_instances = ${plan.poolInstances}`,
    `max_connections = ${plan.maxConnections}`,
    "sort_buffer_size = 2M",
    "join_buffer_size = 2M",
    "read_buffer_size = 1M",
    "read_rnd_buffer_size = 1M",
    "tmp_table_size = 32M",
    "max_heap_table_size = 32M",
    `loose-temptable_max_ram = ${plan.tempTableRamMb}M`,
    "",
  ].join("\n");
}

/** Lower is killed later; PHP-FPM's site pools go first, so one request fails instead of every site. */
const OOM_SCORES = { mysql: -600, nginx: -500, php: 300 } as const;
const REDIS_POLICY = "allkeys-lru";

// --- Context ---------------------------------------------------------------

const DEFAULT_MEMORY_PATHS = {
  meminfo: "/proc/meminfo",
  /** The directories MySQL and MariaDB read last on Debian and Ubuntu; the first that exists is used. */
  confDirs: ["/etc/mysql/mariadb.conf.d", "/etc/mysql/mysql.conf.d", "/etc/mysql/conf.d"],
  mysqlFile: "zz-clp-addons-memory.cnf",
  servers: ["/usr/sbin/mariadbd", "/usr/sbin/mysqld"],
  mysqlUnit: "mysql.service",
  redisUnit: "redis-server.service",
  redisConf: "/etc/redis/redis.conf",
  redisCli: "/usr/bin/redis-cli",
  nginxUnit: "nginx.service",
  varnishUnit: "varnish.service",
  memcachedConf: "/etc/memcached.conf",
  phpRoot: "/etc/php",
  systemdDir: SYSTEMD_DIR,
  cgroupRoot: "/sys/fs/cgroup",
  procRoot: "/proc",
  /** When this addon last took its MySQL file away, so the page can say the old values are still running. */
  stateFile: `${addonStateDir("resource-limits")}/memory.json`,
  /** Held while memory.json is read and rewritten: the page, repair and Redis's start hook all write it. */
  stateLock: `${LOCK_DIR}/resource-limits-memory.lock`,
  bin: CLI_BIN,
};

type MemoryPaths = typeof DEFAULT_MEMORY_PATHS;

export interface MemoryOptions {
  paths?: Partial<MemoryPaths>;
  run?: (command: string, args: string[], timeoutMs: number) => CommandResult;
  now?: () => number;
  /** When every command must have finished, in ms since the epoch; each one gets what is left, at most COMMAND_MS. */
  deadline?: number;
}

interface Context {
  paths: MemoryPaths;
  run: (command: string, args: string[]) => CommandResult;
  now: () => number;
}

function contextOf(options: MemoryOptions): Context {
  const run = options.run ?? runCommand;
  const now = options.now ?? Date.now;
  const { deadline } = options;
  return {
    paths: { ...DEFAULT_MEMORY_PATHS, ...options.paths },
    run: deadline === undefined ? (command, args) => run(command, args, COMMAND_MS) : (command, args) => {
      const remaining = deadline - now();
      if (remaining <= 0) failAction("the memory change ran out of time; repair finishes it");
      return run(command, args, Math.min(COMMAND_MS, remaining));
    },
    now,
  };
}

const DROP_IN = "zz-clp-addons-memory.conf";
const OOM_DROP_IN = "zz-clp-addons-oom.conf";

function text(path: string): string | null {
  try { return readFileSync(path, "utf8"); } catch { return null; }
}

function put(path: string, content: string | null): boolean {
  if (text(path) === content) return false;
  if (content === null) rmSync(path, { force: true });
  else writeFileAtomic(path, content, { mode: 0o644, createParent: true });
  return true;
}

function commandError(result: CommandResult): string {
  return (result.stderr || result.stdout).trim().split("\n")[0] || `exit ${result.exitCode ?? "unknown"}`;
}

/** MemTotal, in MB. */
export function ramMb(options: MemoryOptions = {}): number {
  const { paths } = contextOf(options);
  const kb = Number(/^MemTotal:\s+(\d+)\s+kB/m.exec(text(paths.meminfo) ?? "")?.[1]);
  if (!Number.isFinite(kb) || kb <= 0) throw new Error(`could not read the server's memory from ${paths.meminfo}`);
  return Math.floor(kb / 1024);
}

interface Unit {
  id: string;
  loaded: boolean;
  active: boolean;
  /** Starting: a unit's ExecStartPost runs while it is still activating. */
  activating: boolean;
  controlGroup: string;
  oomScore: number;
  /** When its main process started, in whole seconds as systemd shows it. */
  startedAt: number | null;
}

const UNIT_PROPERTIES = ["Id", "LoadState", "ActiveState", "ControlGroup", "OOMScoreAdjust", "ExecMainStartTimestamp"];

/**
 * systemd prints a timestamp as `Thu 2026-11-05 06:53:12 UTC` in the zone TZ names. `--timestamp=unix`
 * would be simpler, but needs systemd 251, newer than Ubuntu 22.04's 249.
 */
function startSeconds(value: string): number | null {
  const at = /^\w+ (\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) UTC$/.exec(value);
  const ms = at ? Date.parse(`${at[1]}T${at[2]}Z`) : NaN;
  return Number.isFinite(ms) ? ms / 1000 : null;
}

/** One `systemctl show` for all of them; it prints a block per unit, in order, blank-line separated. */
function units(ctx: Context, names: string[]): Unit[] {
  if (!names.length) return [];
  const shown = ctx.run("env", ["TZ=UTC", "systemctl", "show", ...UNIT_PROPERTIES.flatMap((key) => ["-p", key]), ...names]);
  // A unit that is not installed shows LoadState=not-found; a failure is not one.
  if (!shown.ok) throw new Error(`systemctl show failed: ${commandError(shown)}`);
  const blocks = shown.stdout.split(/\n\s*\n/);
  return names.map((name, index) => {
    const block = blocks[index] ?? "";
    const value = (key: string) => block.split("\n").find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1).trim() ?? "";
    return {
      id: value("Id") || name,
      loaded: value("LoadState") === "loaded",
      active: value("ActiveState") === "active",
      activating: value("ActiveState") === "activating",
      controlGroup: value("ControlGroup"),
      oomScore: Number(value("OOMScoreAdjust")) || 0,
      startedAt: startSeconds(value("ExecMainStartTimestamp")),
    };
  });
}

function unit(ctx: Context, name: string): Unit {
  return units(ctx, [name])[0]!;
}

function dropInPath(ctx: Context, unitId: string, file: string): string {
  return join(ctx.paths.systemdDir, `${unitId}.d`, file);
}

function daemonReload(ctx: Context): void {
  const reloaded = ctx.run("systemctl", ["daemon-reload"]);
  if (!reloaded.ok) throw new Error(`systemctl daemon-reload failed: ${commandError(reloaded)}`);
}

// --- MySQL -----------------------------------------------------------------

function optionFile(ctx: Context): string | null {
  const dir = ctx.paths.confDirs.find((path) => existsSync(path));
  return dir ? join(dir, ctx.paths.mysqlFile) : null;
}

function hookDropIn(bin: string, line: "ExecStartPre" | "ExecStartPost", kind: "mysql" | "redis"): string {
  return [
    `# Managed by clp-addons Resource Limits: sizes ${kind === "mysql" ? "MySQL" : "Redis"} to this server's memory each time it starts.`,
    "[Service]",
    // `-`: a failure leaves the last file in place and never stops the service starting.
    `${line}=-+${bin} sync-memory ${kind}`,
    "",
  ].join("\n");
}

/** Writes or removes the option file for the saved choice, without a restart. Returns whether it changed. */
function reconcileMysqlFile(ctx: Context, settings: MemorySettings, check: boolean): boolean {
  const file = optionFile(ctx);
  if (!file) {
    if (settings.mysql) throw new Error(`no MySQL or MariaDB config directory: looked for ${ctx.paths.confDirs.join(", ")}`);
    return false;
  }
  const before = text(file);
  if (before !== null && !before.startsWith(MYSQL_MARKER) && !before.startsWith("# Managed by clp-addons System Tweaks: MySQL memory sized for this server.")) {
    if (!settings.mysql) return false;
    throw new Error(`${file} is not this addon's; move it away to let Resource Limits manage it`);
  }
  const plan = settings.mysql ? memoryPlan(ramMb({ paths: ctx.paths }), settings.profile) : null;
  const after = plan ? mysqlOptionFile(plan, settings.profile) : null;
  // Renaming the owner in a comment alone must not invent a pending MySQL restart.
  const commentOnly = before !== null && after !== null && before.slice(before.indexOf("\n")) === after.slice(after.indexOf("\n"));
  const times = commentOnly ? statSync(file) : null;
  if (!put(file, after)) return false;
  if (times) utimesSync(file, times.atime, times.mtime);
  if (!plan) recordRemoval(ctx);
  else if (check) {
    try { checkEffective(ctx, plan, file); }
    catch (error) { put(file, before); throw error; }
  }
  return true;
}

/**
 * Asks the server program how it parses its options now, so a later file or
 * startup option that overrides these is caught before the next restart
 * quietly ignores them. Help mode starts no server.
 */
function checkEffective(ctx: Context, plan: MemoryPlan, file: string): void {
  for (const program of ctx.paths.servers.filter((path) => existsSync(path))) {
    const shown = ctx.run(program, ["--verbose", "--help"]);
    if (!shown.ok) continue;
    const value = (name: string) => new RegExp(`^${name}\\s+(\\S+)\\s*$`, "m").exec(shown.stdout)?.[1];
    const pool = value("innodb-buffer-pool-size");
    const connections = value("max-connections");
    if (pool !== undefined && Number(pool) !== plan.bufferPoolMb * 1048576) {
      failAction(`MySQL's buffer pool would be ${Math.round(Number(pool) / 1048576)} MB after reading ${file}; another option file overrides it`);
    }
    if (connections !== undefined && Number(connections) !== plan.maxConnections) {
      failAction(`MySQL's max_connections would be ${connections} after reading ${file}; another option file overrides it`);
    }
    return;
  }
}

/**
 * What this addon did that the box does not show: when it took its MySQL file
 * away, and whether the running Redis holds a cap it set, so switching off
 * restores only what it changed.
 */
interface MemoryState { mysqlRemovedAt?: number; redisCapped?: boolean }

function readState(ctx: Context): MemoryState {
  try {
    const stored = JSON.parse(text(ctx.paths.stateFile) ?? "") as Record<string, unknown>;
    return {
      ...(typeof stored.mysqlRemovedAt === "number" ? { mysqlRemovedAt: stored.mysqlRemovedAt } : {}),
      ...(stored.redisCapped === true ? { redisCapped: true } : {}),
    };
  } catch {
    return {};
  }
}

function writeState(ctx: Context, change: MemoryState): void {
  withFileLockSync(ctx.paths.stateLock, 10, "another memory limits change is still running", () => {
    const next: MemoryState = { ...readState(ctx), ...change };
    if (!next.redisCapped) delete next.redisCapped;
    writeFileAtomic(ctx.paths.stateFile, `${JSON.stringify(next)}\n`, { mode: 0o600, createParent: true });
  });
}

function recordRemoval(ctx: Context): void {
  try {
    writeState(ctx, { mysqlRemovedAt: ctx.now() });
  } catch {
    // Unrecorded only means the page cannot say the old values are still running.
  }
}

function removedAt(ctx: Context): number | null {
  return readState(ctx).mysqlRemovedAt ?? null;
}

function modifiedAt(path: string): number | null {
  try { return statSync(path).mtimeMs; } catch { return null; }
}

// --- Redis -----------------------------------------------------------------

interface RedisConf { args: string[]; password: boolean; maxmemory: string; policy: string }

function sizeBytes(value: string): number {
  const match = /^(\d+)\s*(b|k|kb|m|mb|g|gb)?$/i.exec(value.trim());
  if (!match) return 0;
  const unit = (match[2] ?? "b").toLowerCase();
  const factor = { b: 1, k: 1000, kb: 1024, m: 1_000_000, mb: 1024 ** 2, g: 1_000_000_000, gb: 1024 ** 3 }[unit] ?? 1;
  return Number(match[1]) * factor;
}

/** How to reach the server, and the values its own file gives, which switching off puts back. */
function redisConf(ctx: Context): RedisConf {
  const settings = new Map<string, string>();
  for (const raw of (text(ctx.paths.redisConf) ?? "").split("\n")) {
    const match = /^\s*([A-Za-z-]+)\s+(.+?)\s*$/.exec(raw);
    if (match && !raw.trim().startsWith("#")) settings.set(match[1]!.toLowerCase(), match[2]!.replace(/^"(.*)"$/, "$1"));
  }
  const port = settings.get("port") ?? "6379";
  const socket = settings.get("unixsocket");
  return {
    args: port !== "0" ? ["-h", "127.0.0.1", "-p", port] : socket ? ["-s", socket] : ["-h", "127.0.0.1"],
    password: settings.has("requirepass"),
    maxmemory: String(sizeBytes(settings.get("maxmemory") ?? "0")),
    policy: settings.get("maxmemory-policy") ?? "noeviction",
  };
}

function redisCli(ctx: Context, conf: RedisConf, args: string[]): CommandResult {
  return ctx.run(ctx.paths.redisCli, [...conf.args, ...args]);
}

interface RedisLive { maxmemory: number; policy: string; used: number }

function redisLive(ctx: Context, conf: RedisConf): RedisLive {
  const got = redisCli(ctx, conf, ["CONFIG", "GET", "maxmemory*"]);
  if (!got.ok || /^(?:ERR|NOAUTH|NOPERM)/m.test(got.stdout)) throw new Error(`Redis did not answer CONFIG GET: ${commandError(got)}`);
  const lines = got.stdout.split("\n").map((line) => line.trim());
  const config = (key: string) => {
    const at = lines.indexOf(key);
    return at >= 0 ? lines[at + 1] ?? "" : "";
  };
  const info = redisCli(ctx, conf, ["INFO", "memory"]);
  return {
    maxmemory: Number(config("maxmemory")) || 0,
    policy: config("maxmemory-policy"),
    used: Number(/^used_memory:(\d+)/m.exec(info.stdout)?.[1]) || 0,
  };
}

function redisSet(ctx: Context, conf: RedisConf, key: string, value: string): void {
  const set = redisCli(ctx, conf, ["CONFIG", "SET", key, value]);
  if (!set.ok || set.stdout.trim() !== "OK") throw new Error(`Redis refused CONFIG SET ${key}: ${commandError(set)}`);
}

/**
 * CONFIG SET only: CONFIG REWRITE would edit redis.conf, a package conffile,
 * and stop the next security update at a prompt unattended-upgrades skips.
 */
function reconcileRedisLive(ctx: Context, settings: MemorySettings, redisUnit: Unit): boolean {
  const capped = readState(ctx).redisCapped === true;
  if (!redisUnit.active && !redisUnit.activating) {
    // A stopped Redis forgets CONFIG SET, so there is no cap of ours left to take off.
    if (!settings.redis && capped) writeState(ctx, { redisCapped: false });
    return false;
  }
  // Off and never capped by this addon: the live values are the operator's, CONFIG SET included.
  if (!settings.redis && !capped) return false;
  const conf = redisConf(ctx);
  if (conf.password) {
    if (settings.redis) throw new Error("Redis has a password in redis.conf, so Resource Limits leaves it alone");
    return false;
  }
  const live = redisLive(ctx, conf);
  // Recorded before any CONFIG SET, so a cap set just before a failure is still
  // taken off later; but only once Redis answers, so one that never does is
  // not left looking capped by this addon.
  if (settings.redis && !capped) writeState(ctx, { redisCapped: true });
  const wanted = settings.redis
    ? { maxmemory: String(memoryPlan(ramMb({ paths: ctx.paths }), settings.profile).redisMb * 1024 * 1024), policy: REDIS_POLICY }
    : { maxmemory: conf.maxmemory, policy: conf.policy };
  let changed = false;
  if (String(live.maxmemory) !== wanted.maxmemory) { redisSet(ctx, conf, "maxmemory", wanted.maxmemory); changed = true; }
  if (live.policy !== wanted.policy) { redisSet(ctx, conf, "maxmemory-policy", wanted.policy); changed = true; }
  if (!settings.redis) writeState(ctx, { redisCapped: false });
  return changed;
}

// --- Out-of-memory priority -------------------------------------------------

function phpUnits(ctx: Context): string[] {
  if (!existsSync(ctx.paths.phpRoot)) return [];
  return readdirSync(ctx.paths.phpRoot)
    .filter((version) => /^[0-9]+\.[0-9]+$/.test(version) && existsSync(join(ctx.paths.phpRoot, version, "fpm")))
    .sort()
    .map((version) => `php${version}-fpm.service`);
}

function oomTargets(ctx: Context, mysqlUnit: Unit): { unit: Unit; score: number }[] {
  const php = phpUnits(ctx);
  const [nginx, ...pools] = units(ctx, [ctx.paths.nginxUnit, ...php]);
  return [
    { unit: mysqlUnit, score: OOM_SCORES.mysql },
    { unit: nginx!, score: OOM_SCORES.nginx },
    ...pools.map((pool) => ({ unit: pool, score: OOM_SCORES.php })),
  ].filter((target) => target.unit.loaded);
}

function oomDropIn(score: number): string {
  return `# Managed by clp-addons Resource Limits: when memory runs out, the kernel kills site PHP before MySQL and nginx.\n[Service]\nOOMScoreAdjust=${score}\n`;
}

/** Running processes keep the score they started with, so it is written to each one too. */
function scoreRunning(ctx: Context, target: Unit, score: number): void {
  if (!target.active || !target.controlGroup) return;
  const procs = text(join(ctx.paths.cgroupRoot, target.controlGroup, "cgroup.procs"))
    ?? text(join(ctx.paths.cgroupRoot, "systemd", target.controlGroup, "cgroup.procs")) ?? "";
  for (const pid of procs.split("\n").filter((line) => /^\d+$/.test(line))) {
    try { writeFileSync(join(ctx.paths.procRoot, pid, "oom_score_adj"), String(score)); } catch { /* gone meanwhile */ }
  }
}

function reconcileOom(ctx: Context, on: boolean, mysqlUnit: Unit): boolean {
  const targets = oomTargets(ctx, mysqlUnit);
  let changed = false;
  for (const { unit: target, score } of targets) {
    if (put(dropInPath(ctx, target.id, OOM_DROP_IN), on ? oomDropIn(score) : null)) changed = true;
  }
  // A PHP version removed since leaves its drop-in directory behind.
  if (!on && existsSync(ctx.paths.systemdDir)) {
    for (const dir of readdirSync(ctx.paths.systemdDir).filter((name) => name.endsWith(".service.d"))) {
      const file = join(ctx.paths.systemdDir, dir, OOM_DROP_IN);
      if (existsSync(file)) { rmSync(file, { force: true }); changed = true; }
    }
  }
  if (!changed) return false;
  daemonReload(ctx);
  // After the reload, systemd shows each unit's own score again once the drop-in is gone.
  const reloaded = units(ctx, targets.map(({ unit: target }) => target.id));
  targets.forEach(({ unit: target, score }, index) => scoreRunning(ctx, target, on ? score : reloaded[index]!.oomScore));
  return true;
}

function oomInPlace(ctx: Context, mysqlUnit: Unit): boolean {
  return oomTargets(ctx, mysqlUnit).every(({ unit: target, score }) => text(dropInPath(ctx, target.id, OOM_DROP_IN)) === oomDropIn(score));
}

// --- Applying ----------------------------------------------------------------

/**
 * Puts the box in line with the settings: MySQL's option file and start hook,
 * Redis's live cap and start hook, and the kill priorities. MySQL is never
 * restarted; its file applies at its next start. Returns what changed.
 */
export function applyMemory(settings: MemorySettings, options: MemoryOptions = {}, check = true): string[] {
  const ctx = contextOf(options);
  const [mysqlUnit, redisUnit] = units(ctx, [ctx.paths.mysqlUnit, ctx.paths.redisUnit]) as [Unit, Unit];
  if (settings.mysql && !mysqlUnit.loaded) failAction(`${ctx.paths.mysqlUnit} is not installed`);
  if (settings.redis && !redisUnit.loaded) failAction(`${ctx.paths.redisUnit} is not installed`);
  const changed: string[] = [];
  if (reconcileMysqlFile(ctx, settings, check)) changed.push(settings.mysql ? "MySQL memory file written" : "MySQL memory file removed");
  let reload = false;
  if (mysqlUnit.loaded && put(dropInPath(ctx, mysqlUnit.id, DROP_IN), settings.mysql ? hookDropIn(ctx.paths.bin, "ExecStartPre", "mysql") : null)) reload = true;
  if (redisUnit.loaded && put(dropInPath(ctx, redisUnit.id, DROP_IN), settings.redis ? hookDropIn(ctx.paths.bin, "ExecStartPost", "redis") : null)) reload = true;
  if (reload) daemonReload(ctx);
  // A Redis that refuses does not hold back the kill priorities.
  let redisFailure: unknown = null;
  try {
    if (redisUnit.loaded && reconcileRedisLive(ctx, settings, redisUnit)) changed.push(settings.redis ? "Redis capped" : "Redis back on its own limit");
  } catch (error) { redisFailure = error; }
  if (reconcileOom(ctx, settings.oom, mysqlUnit)) changed.push(settings.oom ? "out-of-memory priorities set" : "out-of-memory priorities removed");
  if (redisFailure) throw redisFailure;
  return changed;
}

/**
 * What the units' start hooks run. MySQL's runs before the server reads its
 * options, so a resized server starts on numbers for its new RAM.
 */
export function syncMemory(kind: "mysql" | "redis", settings: MemorySettings, options: MemoryOptions = {}): boolean {
  const ctx = contextOf(options);
  if (kind === "mysql") return reconcileMysqlFile(ctx, settings, false);
  return reconcileRedisLive(ctx, settings, unit(ctx, ctx.paths.redisUnit));
}

// --- Status ------------------------------------------------------------------

export interface MemoryStatus {
  plan: MemoryPlan;
  mysql: {
    installed: boolean;
    /** The file is in place with this profile's numbers for the RAM now. */
    inPlace: boolean;
    /** The running server started before the last change, so it applies at its next restart. */
    pending: boolean;
  };
  redis: {
    installed: boolean;
    /** The running server's cap, in MB; 0 is none. */
    maxmemoryMb: number | null;
    policy: string;
    usedMb: number | null;
    capped: boolean;
    problem: string;
  };
  oom: { inPlace: boolean };
  /** Caches CloudPanel sizes itself, which the budget counts as they are. */
  varnishMb: number | null;
  memcachedMb: number | null;
}

function varnishMb(ctx: Context): number | null {
  const shown = ctx.run("systemctl", ["show", ctx.paths.varnishUnit, "-p", "ExecStart", "-p", "ActiveState"]);
  if (!shown.ok || !/^ActiveState=active$/m.test(shown.stdout)) return null;
  const size = /-s\s+malloc,(\d+[kKmMgG]?)/.exec(shown.stdout)?.[1];
  if (!size) return null;
  const unit = size.slice(-1).toLowerCase();
  const number = Number.parseInt(size, 10);
  return unit === "g" ? number * 1024 : unit === "k" ? Math.ceil(number / 1024) : unit === "m" ? number : Math.ceil(number / 1048576);
}

function memcachedMb(ctx: Context): number | null {
  const conf = text(ctx.paths.memcachedConf);
  if (conf === null) return null;
  const size = /^\s*-m\s+(\d+)/m.exec(conf)?.[1];
  return size ? Number(size) : 64;
}

export function memoryStatus(settings: MemorySettings, options: MemoryOptions = {}): MemoryStatus {
  const ctx = contextOf(options);
  const plan = memoryPlan(ramMb(options), settings.profile);
  const [mysqlUnit, redisUnit] = units(ctx, [ctx.paths.mysqlUnit, ctx.paths.redisUnit]) as [Unit, Unit];
  const file = optionFile(ctx);
  const inPlace = file !== null && text(file) === mysqlOptionFile(plan, settings.profile);
  // On: the file is newer than the running server. Off: the file went after it started. In whole
  // seconds, as systemd shows the start: the start hook writes the file in the second MySQL starts.
  const changedAt = settings.mysql ? (inPlace && file ? modifiedAt(file) : null) : (file && !existsSync(file) ? removedAt(ctx) : null);
  const pending = mysqlUnit.active && mysqlUnit.startedAt !== null && changedAt !== null && Math.floor(changedAt / 1000) > mysqlUnit.startedAt;
  const redis: MemoryStatus["redis"] = { installed: redisUnit.loaded, maxmemoryMb: null, policy: "", usedMb: null, capped: false, problem: "" };
  if (redisUnit.active) {
    try {
      const conf = redisConf(ctx);
      if (conf.password) redis.problem = "Redis has a password in redis.conf, so Resource Limits leaves it alone.";
      else {
        const live = redisLive(ctx, conf);
        redis.maxmemoryMb = Math.round(live.maxmemory / 1048576);
        redis.policy = live.policy;
        redis.usedMb = Math.round(live.used / 1048576);
        redis.capped = live.maxmemory === plan.redisMb * 1048576 && live.policy === REDIS_POLICY;
      }
    } catch (error) {
      redis.problem = errorMessage(error);
    }
  }
  return {
    plan,
    mysql: { installed: mysqlUnit.loaded, inPlace, pending },
    redis,
    oom: { inPlace: oomInPlace(ctx, mysqlUnit) },
    varnishMb: varnishMb(ctx),
    memcachedMb: memcachedMb(ctx),
  };
}

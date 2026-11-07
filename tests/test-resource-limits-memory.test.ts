import { dashboardView } from "../addons/resource-limits/app/views";
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResult } from "../cli/action-common";
import {
  DEFAULT_MEMORY, MYSQL_MARKER, applyMemory, memoryChange, memoryPlan, memoryStatus, mysqlOptionFile, syncMemory,
  type MemoryOptions, type MemorySettings,
} from "../addons/resource-limits/memory";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const MB = 1024 * 1024;

interface FakeUnit { loaded: boolean; active: boolean; activating?: boolean; oom: number; startedAt: number; pids: number[] }

/**
 * A server with MySQL, Redis, nginx and PHP 8.1 and 8.3: systemctl reports the
 * units, redis-cli keeps its two settings, and mysqld --verbose --help reads
 * back the option file this addon wrote, unless `overrideConnections` stands in
 * for a later file.
 */
function server(ramMb = 3819) {
  const dir = mkdtempSync(join(tmpdir(), "clp-memory-"));
  dirs.push(dir);
  const conf = join(dir, "mysql.conf.d");
  mkdirSync(conf);
  const phpRoot = join(dir, "php");
  for (const version of ["8.1", "8.3"]) mkdirSync(join(phpRoot, version, "fpm"), { recursive: true });
  const meminfo = join(dir, "meminfo");
  const setRam = (mb: number) => writeFileSync(meminfo, `MemTotal:       ${mb * 1024} kB\nMemFree:          1024 kB\n`);
  setRam(ramMb);
  const redisConf = join(dir, "redis.conf");
  writeFileSync(redisConf, "bind 127.0.0.1 -::1\nport 6379\n# maxmemory <bytes>\n");
  writeFileSync(join(dir, "memcached.conf"), "-d\n-m 64\n-p 11211\n");
  const cgroup = join(dir, "cgroup");
  const proc = join(dir, "proc");
  const units: Record<string, FakeUnit> = {
    "mysql.service": { loaded: true, active: true, oom: 0, startedAt: 1_000, pids: [101] },
    "redis-server.service": { loaded: true, active: true, oom: 0, startedAt: 1_000, pids: [102] },
    "nginx.service": { loaded: true, active: true, oom: 0, startedAt: 1_000, pids: [103, 104] },
    "php8.1-fpm.service": { loaded: true, active: true, oom: 0, startedAt: 1_000, pids: [105] },
    "php8.3-fpm.service": { loaded: true, active: true, oom: 0, startedAt: 1_000, pids: [106, 107] },
    "varnish.service": { loaded: true, active: true, oom: 0, startedAt: 1_000, pids: [] },
  };
  for (const [name, unit] of Object.entries(units)) {
    mkdirSync(join(cgroup, "system.slice", name), { recursive: true });
    writeFileSync(join(cgroup, "system.slice", name, "cgroup.procs"), unit.pids.map((pid) => `${pid}\n`).join(""));
    for (const pid of unit.pids) {
      mkdirSync(join(proc, String(pid)), { recursive: true });
      writeFileSync(join(proc, String(pid), "oom_score_adj"), "0");
    }
  }
  const redis = { maxmemory: 0, policy: "noeviction", used: 200 * MB, password: false };
  const s = {
    dir, conf, file: join(conf, "zz-clp-addons-memory.cnf"), systemd: join(dir, "systemd"), proc, units, redis, setRam,
    calls: [] as string[][], overrideConnections: null as number | null, reloads: 0,
    options: {} as MemoryOptions,
  };
  const ok = (stdout = ""): CommandResult => ({ ok: true, stdout, stderr: "" });
  const run = (program: string, given: string[]): CommandResult => {
    s.calls.push([program, ...given]);
    // Unit queries run as `env TZ=UTC systemctl show …`.
    const [command, args] = program === "env" ? [given[1]!, given.slice(2)] : [program, given];
    if (command === "systemctl" && args[0] === "daemon-reload") { s.reloads++; return ok(); }
    if (command === "systemctl" && args[0] === "show" && args.includes("ExecStart")) {
      return ok("ExecStart={ path=/usr/sbin/varnishd ; argv[]=/usr/sbin/varnishd -a :6081 -f /etc/varnish/default.vcl -s malloc,512m ; }\nActiveState=active\n");
    }
    if (command === "systemctl" && args[0] === "show") {
      const names = args.slice(1).filter((arg, index, all) => !arg.startsWith("-") && all[index - 1] !== "-p");
      return ok(names.map((name) => {
        const unit = units[name];
        if (!unit?.loaded) return `Id=${name}\nLoadState=not-found\nActiveState=inactive\n`;
        // With its drop-in, systemd reports the drop-in's score.
        const dropIn = join(s.systemd, `${name}.d`, "zz-clp-addons-oom.conf");
        const score = existsSync(dropIn) ? /OOMScoreAdjust=(-?\d+)/.exec(readFileSync(dropIn, "utf8"))![1] : String(unit.oom);
        return `Id=${name}\nLoadState=loaded\nActiveState=${unit.activating ? "activating" : unit.active ? "active" : "inactive"}\nControlGroup=/system.slice/${name}\nOOMScoreAdjust=${score}\nExecMainStartTimestamp=${utc(unit.startedAt)}\n`;
      }).join("\n"));
    }
    if (command.endsWith("redis-cli")) {
      const rest = args.slice(args.indexOf("6379") + 1);
      if (redis.password) return ok("NOAUTH Authentication required.\n");
      if (rest[0] === "CONFIG" && rest[1] === "GET") return ok(`maxmemory\n${redis.maxmemory}\nmaxmemory-policy\n${redis.policy}\n`);
      if (rest[0] === "CONFIG" && rest[1] === "SET") {
        if (rest[2] === "maxmemory") redis.maxmemory = Number(rest[3]);
        else redis.policy = rest[3]!;
        return ok("OK\n");
      }
      if (rest[0] === "INFO") return ok(`# Memory\r\nused_memory:${redis.used}\r\n`);
    }
    if (command.endsWith("mysqld") && args[0] === "--verbose") {
      const text = existsSync(s.file) ? readFileSync(s.file, "utf8") : "";
      const pool = Number(/innodb_buffer_pool_size = (\d+)M/.exec(text)?.[1] ?? 512) * MB;
      const connections = s.overrideConnections ?? Number(/max_connections = (\d+)/.exec(text)?.[1] ?? 512);
      return ok(`innodb-buffer-pool-size  ${pool}\nmax-connections  ${connections}\n`);
    }
    return ok();
  };
  const mysqld = join(dir, "mysqld");
  writeFileSync(mysqld, "");
  s.options = {
    run,
    now: () => 5_000,
    paths: {
      meminfo, confDirs: [join(dir, "missing.conf.d"), conf], servers: [mysqld], redisConf, redisCli: "/usr/bin/redis-cli",
      memcachedConf: join(dir, "memcached.conf"), phpRoot, systemdDir: s.systemd, cgroupRoot: cgroup, procRoot: proc,
      stateFile: join(dir, "memory.json"), stateLock: join(dir, "memory.lock"), bin: "/usr/local/bin/clp-addons",
    },
  };
  return s;
}

/** A time as systemd prints it with TZ=UTC: `Thu 2026-11-05 06:53:12 UTC`. */
function utc(ms: number): string {
  const iso = new Date(ms).toISOString();
  return `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(ms).getUTCDay()]} ${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}

const on = (change: Partial<MemorySettings> = {}): MemorySettings => ({ ...DEFAULT_MEMORY, mysql: true, redis: true, ...change });
const score = (s: ReturnType<typeof server>, pid: number) => readFileSync(join(s.proc, String(pid), "oom_score_adj"), "utf8");

test("each profile's shares, rounded to InnoDB's chunks and kept within bounds", () => {
  expect(memoryPlan(3819, "balanced")).toEqual({
    ramMb: 3819, bufferPoolMb: 896, poolInstances: 1, maxConnections: 100, tempTableRamMb: 190, redisMb: 381,
  });
  // 25% of 16 GB is 4 GB: four instances, so 512 MB steps.
  expect(memoryPlan(16384, "balanced")).toMatchObject({ bufferPoolMb: 4096, poolInstances: 4, maxConnections: 307, redisMb: 1638 });
  expect(memoryPlan(16384, "database")).toMatchObject({ bufferPoolMb: 6144, poolInstances: 6, maxConnections: 409, redisMb: 819 });
  expect(memoryPlan(16384, "cache")).toMatchObject({ bufferPoolMb: 2304, poolInstances: 2, maxConnections: 204, redisMb: 3276 });
  // A small server still gets a working pool and enough connections; a large one stops at 8 instances and 512 connections.
  expect(memoryPlan(512, "cache")).toMatchObject({ bufferPoolMb: 128, poolInstances: 1, maxConnections: 100, redisMb: 102, tempTableRamMb: 64 });
  expect(memoryPlan(131072, "database")).toMatchObject({ poolInstances: 8, maxConnections: 512, tempTableRamMb: 1024 });
  for (const ram of [1024, 2048, 6000, 24576, 65536]) {
    for (const profile of ["balanced", "database", "cache"] as const) {
      const plan = memoryPlan(ram, profile);
      expect(plan.bufferPoolMb % (128 * plan.poolInstances)).toBe(0);
    }
  }
});

test("only well-formed changes are accepted, and a body must name one", () => {
  expect(memoryChange({ profile: "cache" })).toEqual({ profile: "cache" });
  expect(memoryChange({ mysql: true, oom: false })).toEqual({ mysql: true, oom: false });
  expect(memoryChange({})).toBeNull();
  expect(memoryChange({ profile: "huge" })).toBeNull();
  expect(memoryChange({ redis: "yes" })).toBeNull();
});

test("switching MySQL on writes the option file and the start hook, without a restart; off removes both", () => {
  const s = server();
  expect(applyMemory(on({ redis: false }), s.options)).toContain("MySQL memory file written");
  const file = readFileSync(s.file, "utf8");
  expect(file).toBe(mysqlOptionFile(memoryPlan(3819, "balanced"), "balanced"));
  expect(file).toContain("innodb_buffer_pool_size = 896M\n");
  expect(file).toContain("max_connections = 100\n");
  expect(readFileSync(join(s.systemd, "mysql.service.d", "zz-clp-addons-memory.conf"), "utf8"))
    .toContain("ExecStartPre=-+/usr/local/bin/clp-addons sync-memory mysql\n");
  expect(s.calls.some((call) => call[0] === "systemctl" && ["restart", "stop", "start"].includes(call[1]!))).toBe(false);
  expect(s.calls).toContainEqual([join(s.dir, "mysqld"), "--verbose", "--help"]);

  // Nothing to do the second time.
  expect(applyMemory(on({ redis: false }), s.options)).toEqual([]);

  expect(applyMemory({ ...DEFAULT_MEMORY }, s.options)).toContain("MySQL memory file removed");
  expect(existsSync(s.file)).toBe(false);
  expect(existsSync(join(s.systemd, "mysql.service.d", "zz-clp-addons-memory.conf"))).toBe(false);
});

test("an option file that overrides these is caught, and the previous file is put back", () => {
  const s = server();
  s.overrideConnections = 1000;
  expect(() => applyMemory(on({ redis: false }), s.options)).toThrow("max_connections would be 1000");
  expect(existsSync(s.file)).toBe(false);
});

test("someone else's file of that name is refused when switching on and left alone otherwise", () => {
  const s = server();
  writeFileSync(s.file, "[mysqld]\nmax_connections = 50\n");
  expect(() => applyMemory(on({ redis: false }), s.options)).toThrow("is not this addon's");
  expect(applyMemory({ ...DEFAULT_MEMORY }, s.options)).toEqual(expect.not.arrayContaining(["MySQL memory file removed"]));
  expect(readFileSync(s.file, "utf8")).toBe("[mysqld]\nmax_connections = 50\n");
});

test("a resized server gets new numbers when MySQL next starts, before it reads its options", () => {
  const s = server(3819);
  applyMemory(on({ redis: false }), s.options);
  s.setRam(16384);
  // MySQL's ExecStartPre at the first boot on the bigger server.
  expect(syncMemory("mysql", on({ redis: false }), s.options)).toBe(true);
  expect(readFileSync(s.file, "utf8")).toContain("innodb_buffer_pool_size = 4096M\n");
  // Shrinking matters most: a pool sized for the old RAM must not outlive it.
  s.setRam(2048);
  syncMemory("mysql", on({ redis: false }), s.options);
  expect(readFileSync(s.file, "utf8")).toContain("innodb_buffer_pool_size = 512M\n");
  // Switched off meanwhile: the hook takes the file away instead.
  syncMemory("mysql", { ...DEFAULT_MEMORY }, s.options);
  expect(existsSync(s.file)).toBe(false);
});

test("the page says a file newer than the running server applies at its next restart", () => {
  const s = server();
  applyMemory(on({ redis: false }), s.options);
  // The server started at 1 s; the file is from now.
  expect(memoryStatus(on({ redis: false }), s.options).mysql).toEqual({ installed: true, inPlace: true, pending: true });
  // After a restart it is in force, even though the start hook wrote it in the second MySQL started.
  s.units["mysql.service"]!.startedAt = Math.floor(Date.now() / 1000) * 1000;
  syncMemory("mysql", on({ redis: false }), s.options);
  expect(memoryStatus(on({ redis: false }), s.options).mysql.pending).toBe(false);
  s.units["mysql.service"]!.startedAt = Date.now() + 60_000;
  // Switched off after that start: CloudPanel's values come back at the next one.
  const later = { ...s.options, now: () => Date.now() + 120_000 };
  applyMemory({ ...DEFAULT_MEMORY }, later);
  expect(memoryStatus({ ...DEFAULT_MEMORY }, later).mysql).toEqual({ installed: true, inPlace: false, pending: true });
  // A file edited since by hand is not ours to call in place.
  applyMemory(on({ redis: false }), s.options);
  writeFileSync(s.file, `${MYSQL_MARKER}\n[mysqld]\nmax_connections = 9\n`);
  utimesSync(s.file, new Date(0), new Date(0));
  expect(memoryStatus(on({ redis: false }), s.options).mysql.inPlace).toBe(false);
});

test("Redis is capped at once and on every start, and switching off gives it its own file's values", () => {
  const s = server();
  expect(applyMemory(on({ mysql: false }), s.options)).toContain("Redis capped");
  expect(s.redis).toMatchObject({ maxmemory: 381 * MB, policy: "allkeys-lru" });
  expect(readFileSync(join(s.systemd, "redis-server.service.d", "zz-clp-addons-memory.conf"), "utf8"))
    .toContain("ExecStartPost=-+/usr/local/bin/clp-addons sync-memory redis\n");
  // Never CONFIG REWRITE: redis.conf is a package conffile.
  expect(s.calls.some((call) => call.includes("REWRITE"))).toBe(false);
  expect(memoryStatus(on({ mysql: false }), s.options).redis).toMatchObject({ capped: true, maxmemoryMb: 381, usedMb: 200 });

  // A restart forgets CONFIG SET; the start hook puts it back, while the unit is still activating.
  s.redis.maxmemory = 0;
  s.redis.policy = "noeviction";
  s.units["redis-server.service"]!.active = false;
  s.units["redis-server.service"]!.activating = true;
  expect(syncMemory("redis", on({ mysql: false }), s.options)).toBe(true);
  expect(s.redis).toMatchObject({ maxmemory: 381 * MB, policy: "allkeys-lru" });
  s.units["redis-server.service"]!.activating = false;
  s.units["redis-server.service"]!.active = true;

  writeFileSync(join(s.dir, "redis.conf"), "port 6379\nmaxmemory 256mb\nmaxmemory-policy volatile-lru\n");
  expect(applyMemory({ ...DEFAULT_MEMORY }, s.options)).toContain("Redis back on its own limit");
  expect(s.redis).toMatchObject({ maxmemory: 256 * MB, policy: "volatile-lru" });
  expect(existsSync(join(s.systemd, "redis-server.service.d", "zz-clp-addons-memory.conf"))).toBe(false);
});

test("with Cap Redis off and never on, Redis's live values are the operator's and are left alone", () => {
  const s = server();
  // Set at runtime by the operator; redis.conf says nothing.
  s.redis.maxmemory = 128 * MB;
  s.redis.policy = "volatile-ttl";
  expect(applyMemory({ ...DEFAULT_MEMORY }, s.options)).not.toContain("Redis back on its own limit");
  expect(s.redis).toMatchObject({ maxmemory: 128 * MB, policy: "volatile-ttl" });
  expect(s.calls.some((call) => call[0]!.endsWith("redis-cli"))).toBe(false);

  // A cap of ours that a Redis restart already dropped is not taken off later either.
  applyMemory(on({ mysql: false }), s.options);
  s.units["redis-server.service"]!.active = false;
  applyMemory({ ...DEFAULT_MEMORY }, s.options);
  s.units["redis-server.service"]!.active = true;
  s.redis.maxmemory = 128 * MB;
  s.redis.policy = "volatile-ttl";
  expect(applyMemory({ ...DEFAULT_MEMORY }, s.options)).toEqual([]);
  expect(s.redis).toMatchObject({ maxmemory: 128 * MB, policy: "volatile-ttl" });
});

test("a systemctl that fails is reported, not taken for services that are not installed", () => {
  const s = server();
  applyMemory(on(), s.options);
  const run = s.options.run!;
  s.options.run = (command, args, timeoutMs) => command === "env" && args[2] === "show"
    ? { ok: false, stdout: "", stderr: "Failed to connect to bus: Connection refused" } : run(command, args, timeoutMs);
  expect(() => applyMemory({ ...DEFAULT_MEMORY }, s.options)).toThrow("systemctl show failed: Failed to connect to bus");
  // Its start hooks stay, so nothing is left half-removed.
  expect(existsSync(join(s.systemd, "mysql.service.d", "zz-clp-addons-memory.conf"))).toBe(true);
  expect(() => memoryStatus(on(), s.options)).toThrow("systemctl show failed");
});

test("a Redis with a password is left alone and says why", () => {
  const s = server();
  writeFileSync(join(s.dir, "redis.conf"), "port 6379\nrequirepass secret\n");
  expect(() => applyMemory(on({ mysql: false }), s.options)).toThrow("has a password");
  expect(s.calls.some((call) => call.includes("SET"))).toBe(false);
  expect(memoryStatus(on({ mysql: false }), s.options).redis.problem).toContain("has a password");
});

test("kill priorities go on MySQL, nginx and every site PHP-FPM, running processes included, and come off again", () => {
  const s = server();
  expect(applyMemory({ ...DEFAULT_MEMORY }, s.options)).toContain("out-of-memory priorities set");
  const dropIn = (unit: string) => readFileSync(join(s.systemd, `${unit}.d`, "zz-clp-addons-oom.conf"), "utf8");
  expect(dropIn("mysql.service")).toContain("OOMScoreAdjust=-600\n");
  expect(dropIn("nginx.service")).toContain("OOMScoreAdjust=-500\n");
  expect(dropIn("php8.1-fpm.service")).toContain("OOMScoreAdjust=300\n");
  expect(dropIn("php8.3-fpm.service")).toContain("OOMScoreAdjust=300\n");
  expect(existsSync(join(s.systemd, "redis-server.service.d", "zz-clp-addons-oom.conf"))).toBe(false);
  expect([101, 103, 104, 105, 106, 107].map((pid) => score(s, pid))).toEqual(["-600", "-500", "-500", "300", "300", "300"]);
  expect(score(s, 102)).toBe("0");
  expect(memoryStatus({ ...DEFAULT_MEMORY }, s.options).oom.inPlace).toBe(true);

  // A PHP version installed later gets one at the next repair.
  mkdirSync(join(s.dir, "php", "8.4", "fpm"), { recursive: true });
  s.units["php8.4-fpm.service"] = { loaded: true, active: false, oom: 0, startedAt: 1_000, pids: [] };
  expect(memoryStatus({ ...DEFAULT_MEMORY }, s.options).oom.inPlace).toBe(false);
  expect(applyMemory({ ...DEFAULT_MEMORY }, s.options)).toEqual(["out-of-memory priorities set"]);

  expect(applyMemory({ ...DEFAULT_MEMORY, oom: false }, s.options)).toEqual(["out-of-memory priorities removed"]);
  expect(existsSync(join(s.systemd, "mysql.service.d", "zz-clp-addons-oom.conf"))).toBe(false);
  expect([101, 103, 105, 107].map((pid) => score(s, pid))).toEqual(["0", "0", "0", "0"]);
});

test("a switch asked for a service that is not installed is refused", () => {
  const s = server();
  s.units["redis-server.service"]!.loaded = false;
  expect(() => applyMemory(on(), s.options)).toThrow("redis-server.service is not installed");
  expect(memoryStatus({ ...DEFAULT_MEMORY }, s.options).redis.installed).toBe(false);
});

test("under a deadline each command gets what is left of it, and none runs once it has passed", () => {
  const s = server();
  const timeouts: number[] = [];
  const run = s.options.run!;
  let clock = 0;
  const bounded: MemoryOptions = {
    ...s.options, now: () => clock, deadline: 45_000,
    run: (command, args, timeoutMs) => { timeouts.push(timeoutMs); return run(command, args, timeoutMs); },
  };
  applyMemory(on({ redis: false }), bounded);
  // Capped at a single command's 30 s guard, which is less than the 45 s left.
  expect(new Set(timeouts)).toEqual(new Set([30_000]));
  clock = 30_000;
  timeouts.length = 0;
  applyMemory(on({ redis: false }), bounded);
  expect(Math.max(...timeouts)).toBe(15_000);
  clock = 45_000;
  const calls = s.calls.length;
  expect(() => applyMemory({ ...DEFAULT_MEMORY }, bounded)).toThrow("ran out of time");
  expect(s.calls.length).toBe(calls);
  expect(existsSync(s.file)).toBe(true);
});

test("memory sizing can be off while its profile is saved and Redis has its own matching limit", async () => {
  const base = { categories: [], defaultCategoryId: null, sites: [] };
  const plan = memoryPlan(3819, "balanced");
  const memory = {
    settings: { ...DEFAULT_MEMORY }, plan,
    mysql: { installed: true, inPlace: false, pending: true },
    redis: { installed: true, maxmemoryMb: plan.redisMb, policy: "allkeys-lru", usedMb: 1, capped: true, problem: "" },
    oom: { inPlace: true }, varnishMb: 512, memcachedMb: 64,
  };
  const html = dashboardView({ ...base, memory });
  expect(html).toContain("Sizing off</span>");
  expect(html).toContain("The profile is saved; MySQL sizing and Cap Redis are both off.");
  expect(html).toContain("CloudPanel's values come back at MySQL's next restart.");
  expect(html).toContain(`with Redis's own limit of ${plan.redisMb} MB`);
  expect(html).toMatch(/data-setting="memory-oom"[^>]* checked/);
  expect(html).not.toMatch(/data-setting="memory-(?:mysql|redis)"[^>]* checked/);

  const enabled = dashboardView({ ...base, memory: { ...memory, settings: { ...memory.settings, redis: true } } });
  expect(enabled).not.toContain("Sizing off</span>");
  expect(enabled).toContain(`Using 1 MB of ${plan.redisMb} MB`);
  expect(enabled).not.toContain("with Redis's own limit");
});

function resourceOptions(s: ReturnType<typeof server>) {
  writeFileSync(join(s.dir, "enabled.conf"), "enabled");
  return {
    memory: s.options,
    memorySettings: {
      settingsFile: join(s.dir, "settings.json"), lockFile: join(s.dir, "settings.lock"),
      enabledConfig: join(s.dir, "enabled.conf"), rootUid: process.getuid?.() ?? 0,
    },
  };
}

test("memory policy saves partial changes, preserves Off, and rolls back a refused change", async () => {
  const { executeResourceLimitsAction } = await import("../addons/resource-limits/action");
  const { readMemorySettings, resourceMemoryState } = await import("../addons/resource-limits/memory-settings");
  const s = server();
  const options = resourceOptions(s);
  const change = (body: unknown) => executeResourceLimitsAction(["set-memory"], { ...options, processUid: 0, input: JSON.stringify(body) });
  expect(await change({ mysql: true, profile: "database" })).toEqual({ memory: { ...DEFAULT_MEMORY, mysql: true, profile: "database" } });
  expect(resourceMemoryState(options)).toMatchObject({ settings: { mysql: true, profile: "database" }, mysql: { inPlace: true } });
  writeFileSync(s.options.paths!.redisConf!, "port 6379\nrequirepass secret\n");
  await expect(change({ redis: true })).rejects.toThrow("has a password");
  expect(readMemorySettings(options).redis).toBe(false);
  await expect(change({ profile: "huge" })).rejects.toThrow("profile must be");
  await change({ mysql: false, redis: false, oom: false });
  await change({ profile: "cache" });
  expect(readMemorySettings(options)).toEqual({ profile: "cache", mysql: false, redis: false, oom: false });
  expect(existsSync(s.file)).toBe(false);
});

test("activation, upkeep and new PHP versions retain OOM protection; disabled start hooks do nothing", async () => {
  const { restoreResourceMemory, withdrawResourceMemory, resourceLimitsMemory } = await import("../addons/resource-limits/memory-settings");
  const s = server();
  const options = resourceOptions(s);
  writeFileSync(options.memorySettings.enabledConfig, "enabled");
  restoreResourceMemory(options);
  expect(score(s, 101)).toBe("-600");
  const phpDir = join(s.options.paths!.phpRoot!, "8.4", "fpm");
  mkdirSync(phpDir, { recursive: true });
  s.units["php8.4-fpm.service"] = { loaded: true, active: false, oom: 0, startedAt: 1000, pids: [] };
  restoreResourceMemory(options);
  expect(readFileSync(join(s.systemd, "php8.4-fpm.service.d/zz-clp-addons-oom.conf"), "utf8")).toContain("OOMScoreAdjust=300");
  rmSync(options.memorySettings.enabledConfig);
  withdrawResourceMemory(options);
  expect(score(s, 101)).toBe("0");
  const before = s.calls.length;
  expect(resourceLimitsMemory("mysql", options)).toBe(false);
  expect(resourceLimitsMemory("redis", options)).toBe(false);
  expect(restoreResourceMemory(options)).toEqual([]);
  expect(s.calls.length).toBe(before);
  writeFileSync(options.memorySettings.enabledConfig, "enabled");
  restoreResourceMemory(options);
  withdrawResourceMemory(options); // A late hook must not undo re-enabling.
  expect(score(s, 101)).toBe("-600");
});

test("old MySQL ownership marker is rewritten without restarting the server", () => {
  const s = server();
  writeFileSync(s.file, mysqlOptionFile(memoryPlan(3819, "balanced"), "balanced").replace("Resource Limits", "System Tweaks"));
  utimesSync(s.file, 0, 0);
  applyMemory(on(), s.options);
  expect(memoryStatus(on(), s.options).mysql.pending).toBe(false);
  expect(readFileSync(s.file, "utf8")).toStartWith(MYSQL_MARKER);
  expect(s.calls.some((call) => call.includes("restart"))).toBe(false);
});

test("the shared budget counts current PHP workers and flags unlimited or unreadable PHP settings", async () => {
  const { memoryCard } = await import("../addons/resource-limits/app/memory-view");
  const { STOCK_PROFILE, phpMemoryLimitMb } = await import("../addons/resource-limits/action");
  const s = server(8192);
  const memory = { ...memoryStatus(on(), s.options), settings: on() };
  const site = {
    domain: "shop.example.com", siteUser: "shop", phpVersion: "8.3", poolFile: "pool.conf", memoryLimitMb: 256,
    current: { ...STOCK_PROFILE, maxChildren: 3 }, categoryId: null, categoryName: null, drifted: false,
  };
  expect(memoryCard(memory, [site])).toContain("PHP workers × memory_limit</dt><dd>768 MB");
  expect(memoryCard(memory, [{ ...site, memoryLimitMb: -1 }])).toContain("1 site(s) have unlimited PHP memory");
  expect(memoryCard(memory, [{ ...site, memoryLimitMb: null }])).toContain("1 have no readable limit");
  expect(memoryCard(memory, [{ ...site, memoryLimitMb: 4096 }])).toContain("These add up to more");
  expect(phpMemoryLimitMb("256M")).toBe(256);
  expect(phpMemoryLimitMb("2G")).toBe(2048);
  expect(phpMemoryLimitMb("262144K")).toBe(256);
  expect(phpMemoryLimitMb("268435456")).toBe(256);
  expect(phpMemoryLimitMb("-1")).toBe(-1);
  expect(phpMemoryLimitMb("broken")).toBeNull();
});

test("a MySQL or Redis start does not wait for a memory change that holds the lock", async () => {
  const { resourceLimitsMemory } = await import("../addons/resource-limits/memory-settings");
  const { withFileLockSync } = await import("../cli/action-common");
  const s = server();
  const options = resourceOptions(s);
  writeFileSync(options.memorySettings.enabledConfig, "enabled");
  withFileLockSync(options.memorySettings.lockFile, 1, "held", () => {
    const started = Date.now();
    resourceLimitsMemory("mysql", options);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

test("repair and new sites leave memory to a change that holds the lock, instead of failing", async () => {
  const { restoreResourceMemory } = await import("../addons/resource-limits/memory-settings");
  const { withFileLockSync } = await import("../cli/action-common");
  const s = server();
  const options = resourceOptions(s);
  writeFileSync(options.memorySettings.enabledConfig, "enabled");
  withFileLockSync(options.memorySettings.lockFile, 1, "held", () => {
    const started = Date.now();
    expect(restoreResourceMemory(options, true)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

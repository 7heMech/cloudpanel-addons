import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResult } from "../cli/action-common";
import {
  DEFAULT_MEMORY, MYSQL_MARKER, applyMemory, memoryChange, memoryPlan, memoryStatus, mysqlOptionFile, syncMemory,
  type MemoryOptions, type MemorySettings,
} from "../addons/system-tweaks/memory";

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
  const run = (command: string, args: string[]): CommandResult => {
    s.calls.push([command, ...args]);
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
        return `Id=${name}\nLoadState=loaded\nActiveState=${unit.activating ? "activating" : unit.active ? "active" : "inactive"}\nControlGroup=/system.slice/${name}\nOOMScoreAdjust=${score}\nExecMainStartTimestamp=@${Math.floor(unit.startedAt / 1000)}\n`;
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
      stateFile: join(dir, "memory.json"), bin: "/usr/local/bin/clp-addons",
    },
  };
  return s;
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

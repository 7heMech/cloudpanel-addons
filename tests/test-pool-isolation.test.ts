import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResult } from "../cli/action-common";
import {
  installPoolIsolation, listenPort, phpPools, poolDropIn, poolIsolationStatus, poolRuleset, removePoolIsolation, syncPoolIsolation,
  type PoolIsolationOptions,
} from "../addons/system-tweaks/pool-isolation";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "clp-pools-"));
  dirs.push(dir);
  const phpRoot = join(dir, "php");
  const pool = (version: string, file: string, text: string) => {
    mkdirSync(join(phpRoot, version, "fpm", "pool.d"), { recursive: true });
    writeFileSync(join(phpRoot, version, "fpm", "pool.d", file), text);
  };
  pool("8.3", "global.conf", "[global]\nemergency_restart_threshold = 10\n");
  pool("8.3", "default.conf", "[default]\nlisten = 127.0.0.1:18000\nuser = www-data\n");
  pool("8.3", "shop.example.com.conf", "[shop.example.com]\nlisten = 127.0.0.1:18001\nuser = shop\ngroup = shop\nlisten.allowed_clients = 127.0.0.1\n");
  pool("8.2", "blog.example.com.conf", "; CloudPanel\n[blog.example.com]\nuser = blog\nlisten = 127.0.0.1:17001\n");
  pool("8.2", "socket.conf", "[socket]\nlisten = /run/php/socket.sock\nuser = blog\n");
  writeFileSync(join(dir, "passwd"), "root:x:0:0::/root:/bin/bash\nclp:x:1000:1000::/home/clp:/bin/bash\nwww-data:x:33:33::/var/www:/usr/sbin/nologin\nshop:x:1001:1001::/home/shop:/bin/bash\nblog:x:1002:1002::/home/blog:/bin/bash\n");
  writeFileSync(join(dir, "nginx.conf"), "user root;\nworker_processes auto;\n");
  // As Ubuntu's php*-fpm packages ship it.
  const unit = join(dir, "php-fpm.service");
  writeFileSync(unit, "[Service]\nType=notify\nExecStart=/usr/sbin/php-fpm --nodaemonize\nExecReload=/bin/kill -USR2 $MAINPID\n");
  const units = { fragment: unit, dropIns: [] as string[], showFails: false };
  const nft = { loaded: false, loads: 0, fail: false };
  const commands: string[] = [];
  const run = (command: string, args: string[]): CommandResult => {
    commands.push([command, ...args].join(" "));
    if (command === "systemctl" && args[0] === "show") {
      return units.showFails ? { ok: false, stdout: "", stderr: "" } : { ok: true, stdout: `FragmentPath=${units.fragment}\nDropInPaths=${units.dropIns.join(" ")}\n`, stderr: "" };
    }
    if (command === "nft" && args[0] === "list") return { ok: nft.loaded, stdout: "", stderr: nft.loaded ? "" : "No such file or directory" };
    if (command === "nft" && args[0] === "-f") {
      if (nft.fail) return { ok: false, stdout: "", stderr: "Error: syntax error" };
      nft.loaded = true;
      nft.loads++;
    }
    if (command === "nft" && args[0] === "delete") nft.loaded = false;
    return { ok: true, stdout: "", stderr: "" };
  };
  const options: PoolIsolationOptions = {
    run,
    paths: {
      phpRoot, passwdFile: join(dir, "passwd"), nginxConf: join(dir, "nginx.conf"), systemdDir: join(dir, "systemd"),
      rulesFile: join(dir, "state", "php-pools.nft"), bin: "/usr/local/bin/clp-addons", panelUser: "clp",
    },
  };
  return { dir, phpRoot, pool, nft, units, commands, options };
}

test("listen values that reach a TCP port, and sockets left out", () => {
  expect(listenPort("127.0.0.1:18001")).toBe(18001);
  expect(listenPort("9000")).toBe(9000);
  expect(listenPort("0.0.0.0:9000")).toBe(9000);
  expect(listenPort("localhost:9000")).toBe(9000);
  expect(listenPort("[::1]:9000")).toBe(9000);
  expect(listenPort('"127.0.0.1:9000"')).toBe(9000);
  expect(listenPort("/run/php/php8.3-fpm.sock")).toBeNull();
  expect(listenPort("127.0.0.1:99999")).toBeNull();
});

test("pools are read from every PHP version, without [global] or Unix sockets", () => {
  const f = fixture();
  expect(phpPools(f.options)).toEqual([
    { version: "8.2", name: "blog.example.com", port: 17001, user: "blog" },
    { version: "8.3", name: "default", port: 18000, user: "www-data" },
    { version: "8.3", name: "shop.example.com", port: 18001, user: "shop" },
  ]);
});

test("each port accepts root, the panel, nginx and its own pool's user, and refuses everyone else on this host", () => {
  const users = new Map([["clp", 1000], ["www-data", 33], ["shop", 1001], ["blog", 1002]]);
  const rules = poolRuleset([
    { version: "8.3", name: "shop", port: 18001, user: "shop" },
    { version: "8.2", name: "blog", port: 17001, user: "blog" },
    { version: "8.2", name: "gone", port: 17002, user: "nobody-here" },
  ], users, ["clp", "root"]);
  expect(rules).toContain("set ports { type inet_service; elements = { 17001, 17002, 18001 }; }");
  expect(rules).toContain("set owners { type inet_service . uid; elements = { 17001 . 1002, 18001 . 1001 }; }");
  expect(rules).toContain('oifname "lo" tcp dport @ports meta skuid { 0, 1000 } accept');
  expect(rules).toContain('oifname "lo" tcp dport . meta skuid @owners accept');
  expect(rules).toContain('oifname "lo" tcp dport @ports reject with tcp reset');
  // Loaded in one transaction, whether or not the table is there yet.
  expect(rules).toMatch(/^# .*\ntable inet clp_addons_php_pools\ndelete table inet clp_addons_php_pools\ntable inet clp_addons_php_pools \{/);
  expect(poolRuleset([], users, [])).toContain("set ports { type inet_service; }");
});

test("install puts a drop-in on every PHP-FPM unit and loads the table; a new pool is picked up by the next sync", () => {
  const f = fixture();
  expect(poolIsolationStatus(f.options).active).toBe(false);
  expect(installPoolIsolation(f.options)).toBe(true);
  for (const version of ["8.2", "8.3"]) {
    expect(readFileSync(join(f.dir, "systemd", `php${version}-fpm.service.d`, "zz-clp-addons-php-pools.conf"), "utf8")).toBe([
      "# Managed by clp-addons System Tweaks: refreshes which accounts reach each PHP pool's port.",
      "[Service]",
      "ExecStartPre=-/usr/local/bin/clp-addons sync-php-pools",
      "ExecReload=",
      "ExecReload=-/usr/local/bin/clp-addons sync-php-pools --before-reload",
      "ExecReload=/bin/kill -USR2 $MAINPID",
      "ExecReload=-/usr/local/bin/clp-addons sync-php-pools",
      "",
    ].join("\n"));
  }
  expect(f.commands).toContain("systemctl daemon-reload");
  expect(poolIsolationStatus(f.options)).toEqual({ active: true, problem: "" });
  expect(installPoolIsolation(f.options)).toBe(false);
  expect(f.nft.loads).toBe(1);

  f.pool("8.3", "new.example.com.conf", "[new.example.com]\nlisten = 127.0.0.1:18002\nuser = shop\n");
  expect(poolIsolationStatus(f.options).active).toBe(false);
  expect(syncPoolIsolation(f.options)).toBe(true);
  expect(readFileSync(join(f.dir, "state", "php-pools.nft"), "utf8")).toContain("18000, 18001, 18002");
  expect(poolIsolationStatus(f.options).active).toBe(true);

  // After a reboot the table is gone; each PHP-FPM start loads it again first.
  f.nft.loaded = false;
  expect(poolIsolationStatus(f.options).active).toBe(false);
  expect(syncPoolIsolation(f.options)).toBe(true);
  expect(f.nft.loaded).toBe(true);
});

test("a ruleset nft refuses is not recorded as loaded", () => {
  const f = fixture();
  f.nft.fail = true;
  expect(() => installPoolIsolation(f.options)).toThrow("nft refused the PHP pool rules: Error: syntax error");
  expect(existsSync(join(f.dir, "state", "php-pools.nft"))).toBe(false);
  expect(poolIsolationStatus(f.options).active).toBe(false);
});

test("remove takes out the drop-ins and the table", () => {
  const f = fixture();
  installPoolIsolation(f.options);
  expect(removePoolIsolation(f.options)).toBe(true);
  expect(existsSync(join(f.dir, "systemd", "php8.3-fpm.service.d", "zz-clp-addons-php-pools.conf"))).toBe(false);
  expect(f.nft.loaded).toBe(false);
  expect(existsSync(join(f.dir, "state", "php-pools.nft"))).toBe(false);
  expect(removePoolIsolation(f.options)).toBe(false);
});

test("before a reload the new pool's port is closed and the old one stays closed; after it, only the pool files' ports are", () => {
  const f = fixture();
  installPoolIsolation(f.options);
  const rules = () => readFileSync(join(f.dir, "state", "php-pools.nft"), "utf8");
  // CloudPanel moves shop's pool from 18001 to 18005, then reloads PHP-FPM 8.3.
  f.pool("8.3", "shop.example.com.conf", "[shop.example.com]\nlisten = 127.0.0.1:18005\nuser = shop\n");
  expect(syncPoolIsolation(f.options, true)).toBe(true);
  expect(rules()).toContain("set ports { type inet_service; elements = { 17001, 18000, 18001, 18005 }; }");
  expect(rules()).toContain("set owners { type inet_service . uid; elements = { 17001 . 1002, 18000 . 33, 18001 . 1001, 18005 . 1001 }; }");
  expect(poolIsolationStatus(f.options).active).toBe(false);
  expect(syncPoolIsolation(f.options)).toBe(true);
  expect(rules()).toContain("set ports { type inet_service; elements = { 17001, 18000, 18005 }; }");
  expect(poolIsolationStatus(f.options).active).toBe(true);
  // Nothing new: the sync before the reload changes nothing.
  expect(syncPoolIsolation(f.options, true)).toBe(false);

  // After a reboot the recorded ports are stale, so the sync before a start uses the pool files alone.
  f.nft.loaded = false;
  f.pool("8.3", "shop.example.com.conf", "[shop.example.com]\nlisten = 127.0.0.1:18006\nuser = shop\n");
  syncPoolIsolation(f.options, true);
  expect(rules()).toContain("set ports { type inet_service; elements = { 17001, 18000, 18006 }; }");
});

test("the drop-in keeps the reload lines other drop-ins give the unit, and syncs after the reload only when it cannot read them", () => {
  const f = fixture();
  const other = join(f.dir, "10-local.conf");
  writeFileSync(other, "[Service]\nExecReload=\nExecReload=/usr/local/bin/before-reload\nExecReload=/bin/kill -USR2 $MAINPID\n");
  f.units.dropIns = [other, join(f.dir, "systemd", "php8.3-fpm.service.d", "zz-clp-addons-php-pools.conf")];
  installPoolIsolation(f.options);
  const dropIn = () => readFileSync(join(f.dir, "systemd", "php8.3-fpm.service.d", "zz-clp-addons-php-pools.conf"), "utf8");
  expect(dropIn()).toContain("ExecReload=-/usr/local/bin/clp-addons sync-php-pools --before-reload\nExecReload=/usr/local/bin/before-reload\nExecReload=/bin/kill -USR2 $MAINPID\nExecReload=-/usr/local/bin/clp-addons sync-php-pools\n");
  expect(poolIsolationStatus(f.options).active).toBe(true);

  // A package update changes the unit's reload: the page is not "On" until repair rewrites the drop-in.
  writeFileSync(other, "[Service]\nExecReload=/bin/kill -HUP $MAINPID\n");
  expect(poolIsolationStatus(f.options).active).toBe(false);
  expect(installPoolIsolation(f.options)).toBe(true);
  expect(dropIn()).toContain("ExecReload=/bin/kill -USR2 $MAINPID\nExecReload=/bin/kill -HUP $MAINPID\nExecReload=-/usr/local/bin/clp-addons sync-php-pools\n");

  f.units.showFails = true;
  installPoolIsolation(f.options);
  expect(dropIn()).toBe(poolDropIn("/usr/local/bin/clp-addons", null));
  expect(dropIn()).not.toContain("ExecReload=\n");
  expect(dropIn()).toContain("ExecStartPre=-/usr/local/bin/clp-addons sync-php-pools\nExecReload=-/usr/local/bin/clp-addons sync-php-pools\n");
});

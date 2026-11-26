import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResult } from "../lib/command";
import { FIREWALL_ADDON } from "../addons/firewall/addon";
import { migrateVisitorIp, visitorIpMigrationPending } from "../addons/firewall/migration";
import {
  applyVisitorIp, keepVisitorIp, MAPS_MARKER, releaseVisitorIp, restoreVisitorIp, setVisitorIpEnabled,
  visitorIpState, visitorIpStatus, withdrawVisitorIp, type VisitorIpOptions,
} from "../addons/firewall/visitor-ip";
import { lockedAddons } from "../lib/root-locks";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const NGINX = `http {
    set_real_ip_from 127.0.0.1;
    set_real_ip_from 10.0.0.0/8;
    log_format main '$remote_addr - $remote_user [$time_local] "$request" '
                    '$status';
    log_format cloudflare '$http_cf_connecting_ip - $remote_user [$time_local] "$request" '
                          '$status';
}
`;
const FASTCGI = "fastcgi_param\tREMOTE_ADDR\t\t$remote_addr;\nfastcgi_param\tREMOTE_PORT\t\t$remote_port;\n";

function box() {
  const dir = mkdtempSync(join(tmpdir(), "clp-visitor-ip-"));
  dirs.push(dir);
  const paths = {
    nginxConf: join(dir, "nginx.conf"), fastcgiParams: join(dir, "fastcgi_params"), maps: join(dir, "maps.conf"),
    cloudflareIps: join(dir, "ips"), stateFile: join(dir, "visitor-ip.json"), lockFile: join(dir, "visitor-ip.lock"),
    rootUid: process.getuid!(),
  };
  writeFileSync(paths.nginxConf, NGINX, { mode: 0o644 });
  writeFileSync(paths.fastcgiParams, FASTCGI, { mode: 0o644 });
  writeFileSync(paths.cloudflareIps, "allow 173.245.48.0/20;\nallow 2400:cb00::/32;\nallow 999.1.1.1;\nallow 1.2.3.4/8/9;\ndeny all;\n");
  const nginx = { fail: false, commands: [] as string[] };
  const run = (command: string, args: string[]): CommandResult => {
    nginx.commands.push(`${command} ${args.join(" ")}`);
    return nginx.fail && command === "nginx" ? { ok: false, stdout: "", stderr: "emerg" } : { ok: true, stdout: "", stderr: "" };
  };
  const options: VisitorIpOptions = { paths, run };
  return { paths, nginx, options };
}

test("on points the log formats and PHP at the map, and off gives every file back as it shipped", () => {
  const b = box();
  expect(visitorIpStatus(b.options)).toEqual({ applied: false, problem: "" });
  expect(applyVisitorIp(true, b.options)).toBe(true);
  expect(b.nginx.commands).toEqual(["nginx -t", "systemctl reload nginx"]);
  expect(readFileSync(b.paths.nginxConf, "utf8")).toBe(NGINX
    .replace("    set_real_ip_from 127.0.0.1;", "    #clp-addons:hop set_real_ip_from 127.0.0.1;")
    .replace("main '$remote_addr", "main '$clp_visitor_ip")
    .replace("cloudflare '$http_cf_connecting_ip", "cloudflare '$clp_visitor_ip"));
  expect(readFileSync(b.paths.fastcgiParams, "utf8")).toBe(FASTCGI.replace("\t$remote_addr;", "\t$clp_visitor_ip;"));
  const maps = readFileSync(b.paths.maps, "utf8");
  expect(maps).toContain("    173.245.48.0/20 cloudflare;\n");
  expect(maps).toContain("    2400:cb00::/32 1;\n");
  expect(maps).not.toContain("999.1.1.1");
  expect(maps).not.toContain("1.2.3.4");
  expect(maps).toContain("    default $remote_addr;\n");
  expect(visitorIpStatus(b.options)).toEqual({ applied: true, problem: "" });
  expect(applyVisitorIp(true, b.options)).toBe(false);

  writeFileSync(b.paths.cloudflareIps, "allow 104.16.0.0/13;\ndeny all;\n");
  expect(visitorIpStatus(b.options).applied).toBe(false);
  expect(applyVisitorIp(true, b.options)).toBe(true);
  expect(readFileSync(b.paths.maps, "utf8")).toContain("104.16.0.0/13 cloudflare;");

  expect(applyVisitorIp(false, b.options)).toBe(true);
  expect(readFileSync(b.paths.nginxConf, "utf8")).toBe(NGINX);
  expect(readFileSync(b.paths.fastcgiParams, "utf8")).toBe(FASTCGI);
  expect(existsSync(b.paths.maps)).toBe(false);
});

test("a change Nginx rejects leaves every file as it was", () => {
  const b = box();
  b.nginx.fail = true;
  expect(() => applyVisitorIp(true, b.options)).toThrow("Nginx validation failed");
  expect(readFileSync(b.paths.nginxConf, "utf8")).toBe(NGINX);
  expect(readFileSync(b.paths.fastcgiParams, "utf8")).toBe(FASTCGI);
  expect(existsSync(b.paths.maps)).toBe(false);
});

test("an upgrade run gets one conffile back unreloaded, and the map stays for the other", () => {
  const b = box();
  applyVisitorIp(true, b.options);
  b.nginx.commands.length = 0;
  expect(releaseVisitorIp("nginxConf", b.options)).toBe(true);
  expect(readFileSync(b.paths.nginxConf, "utf8")).toBe(NGINX);
  expect(readFileSync(b.paths.fastcgiParams, "utf8")).toContain("$clp_visitor_ip");
  expect(existsSync(b.paths.maps)).toBe(true);
  expect(b.nginx.commands).toEqual([]);
  expect(applyVisitorIp(true, b.options)).toBe(true);
  expect(visitorIpStatus(b.options).applied).toBe(true);
});

test("off keeps the map while a hand edit still names it, and a map clp-addons did not write is refused", () => {
  const b = box();
  applyVisitorIp(true, b.options);
  writeFileSync(b.paths.nginxConf, `${readFileSync(b.paths.nginxConf, "utf8")}# set $x $clp_visitor_ip;\n`);
  applyVisitorIp(false, b.options);
  expect(existsSync(b.paths.maps)).toBe(true);

  writeFileSync(b.paths.maps, "map $a $b {}\n");
  expect(() => applyVisitorIp(true, b.options)).toThrow("clp-addons did not write it");
  // The row names the file rather than asking for a repair that would refuse it again.
  expect(visitorIpStatus(b.options)).toEqual({ applied: false, problem: `${b.paths.maps} was not written by clp-addons; move it away, then run clp-addons repair` });
  // Switching off, as disabling the addon does, still gives the files back and leaves that map alone.
  writeFileSync(b.paths.nginxConf, NGINX.replace("main '$remote_addr", "main '$clp_visitor_ip"));
  applyVisitorIp(false, b.options);
  expect(readFileSync(b.paths.nginxConf, "utf8")).toBe(NGINX);
  expect(readFileSync(b.paths.maps, "utf8")).toBe("map $a $b {}\n");
});

test("a line the setting does not recognise is reported, not shown as on", () => {
  const b = box();
  writeFileSync(b.paths.nginxConf, NGINX.replace("log_format main '$remote_addr", "log_format main\n    '$remote_addr"));
  applyVisitorIp(true, b.options);
  expect(visitorIpStatus(b.options)).toEqual({ applied: false, problem: `${b.paths.nginxConf} has no line with $remote_addr` });
});

test("switching off with nothing to undo checks no file, as disabling the addon on a box with another owner's nginx does", () => {
  const b = box();
  const options = { ...b.options, paths: { ...b.options.paths, rootUid: process.getuid!() + 1 } };
  expect(applyVisitorIp(false, options)).toBe(false);
  expect(b.nginx.commands).toEqual([]);
});

test("a directive the file repeats is edited on every line, and off gives each back", () => {
  const b = box();
  const twice = NGINX.replace("    set_real_ip_from 10.0.0.0/8;", "    set_real_ip_from 10.0.0.0/8;\n    server {\n        set_real_ip_from 127.0.0.1;\n    }");
  writeFileSync(b.paths.nginxConf, twice);
  expect(applyVisitorIp(true, b.options)).toBe(true);
  const on = readFileSync(b.paths.nginxConf, "utf8");
  expect(on.match(/#clp-addons:hop set_real_ip_from 127\.0\.0\.1;/g)?.length).toBe(2);
  expect(visitorIpStatus(b.options)).toEqual({ applied: true, problem: "" });
  expect(applyVisitorIp(true, b.options)).toBe(false);
  expect(applyVisitorIp(false, b.options)).toBe(true);
  expect(readFileSync(b.paths.nginxConf, "utf8")).toBe(twice);
});

test("setVisitorIpEnabled persists the choice, respects Firewall's root lock, and keepVisitorIp reapplies only while on", () => {
  const b = box();
  const dir = mkdtempSync(join(tmpdir(), "clp-vip-lock-"));
  dirs.push(dir);
  const locksFile = join(dir, "locks.json");
  writeFileSync(locksFile, JSON.stringify({ addons: ["firewall"] }), { mode: 0o644 });
  const locked: VisitorIpOptions = { ...b.options, locks: { file: locksFile, rootUid: process.getuid!() } };

  // Defaults on, keepVisitorIp applies it.
  expect(visitorIpState(b.options)).toEqual({ enabled: true, applied: false, problem: "" });
  expect(keepVisitorIp(b.options)).toBe("Cloudflare visitor IPs reapplied");
  expect(visitorIpState(b.options)).toEqual({ enabled: true, applied: true, problem: "" });
  expect(keepVisitorIp(b.options)).toBeNull();

  // Root lock blocks switching off but permits switching on.
  expect(() => setVisitorIpEnabled(false, locked)).toThrow("root has locked firewall");
  expect(setVisitorIpEnabled(true, locked)).toEqual({ enabled: true, applied: true, problem: "" });

  // Unlocked can switch off, keepVisitorIp stays silent, withdraw and restore follow preference.
  expect(setVisitorIpEnabled(false, b.options)).toEqual({ enabled: false, applied: false, problem: "" });
  expect(keepVisitorIp(b.options)).toBeNull();
  restoreVisitorIp(b.options);
  expect(visitorIpStatus(b.options).applied).toBe(false);

  expect(setVisitorIpEnabled(true, b.options)).toEqual({ enabled: true, applied: true, problem: "" });
  withdrawVisitorIp(b.options);
  expect(visitorIpStatus(b.options).applied).toBe(false);
  restoreVisitorIp(b.options);
  expect(visitorIpStatus(b.options).applied).toBe(true);
});

test("migrateVisitorIp moves System Tweaks' setting to Firewall, enables Firewall safely, and rolls back cleanly", () => {
  const dir = mkdtempSync(join(tmpdir(), "clp-vip-mig-"));
  dirs.push(dir);
  const stSettings = join(dir, "system-tweaks", "settings.json");
  const stConfig = join(dir, "etc", "system-tweaks.conf");
  const fwConfig = join(dir, "etc", "firewall.conf");
  const fwStateDir = join(dir, "firewall");
  const fwPolicy = join(fwStateDir, "policy.json");
  const vipState = join(fwStateDir, "visitor-ip.json");
  mkdirSync(join(dir, "system-tweaks"), { recursive: true });
  mkdirSync(join(dir, "etc"), { recursive: true });
  mkdirSync(fwStateDir, { recursive: true });

  const originalSettings = `${JSON.stringify({ version: 1, blockForgedRealIp: true, cloudflareVisitorIp: true }, null, 2)}\n`;
  const dormantPolicy = `${JSON.stringify({ version: 1, autoEnableNewSites: true, knownSiteIds: [], disabledDomains: [] }, null, 2)}\n`;
  writeFileSync(stSettings, originalSettings, { mode: 0o600 });
  writeFileSync(stConfig, "enabled=1\n", { mode: 0o644 });
  writeFileSync(fwPolicy, dormantPolicy, { mode: 0o600 });

  let enabledCount = 0;
  const paths = {
    systemTweaksSettings: stSettings,
    systemTweaksConfig: stConfig,
    firewallConfig: fwConfig,
    firewallPolicy: fwPolicy,
    firewallStateDir: fwStateDir,
    visitorIpState: vipState,
    visitorIpMaps: join(dir, "maps.conf"),
    locksFile: join(dir, "etc", "locks.json"),
    locksLock: join(dir, "locks.lock"),
    rootUid: process.getuid!(),
  };
  const undo = migrateVisitorIp(() => {
    enabledCount++;
    writeFileSync(fwConfig, "enabled=1\n", { mode: 0o644 });
  }, paths);

  expect(undo).not.toBeNull();
  expect(enabledCount).toBe(1);
  expect(existsSync(fwConfig)).toBe(true);
  expect(JSON.parse(readFileSync(vipState, "utf8"))).toEqual({ version: 1, enabled: true });
  expect(JSON.parse(readFileSync(stSettings, "utf8"))).toEqual({ version: 1, blockForgedRealIp: true });
  // Dormant autoEnableNewSites was cleared before enabling Firewall.
  expect(JSON.parse(readFileSync(fwPolicy, "utf8")).autoEnableNewSites).toBe(false);
  // Second call is a no-op.
  expect(migrateVisitorIp(() => { enabledCount++; }, paths)).toBeNull();

  // Rollback restores everything cleanly.
  undo!();
  expect(readFileSync(stSettings, "utf8")).toBe(originalSettings);
  expect(readFileSync(fwPolicy, "utf8")).toBe(dormantPolicy);
  expect(existsSync(vipState)).toBe(false);
  expect(existsSync(fwConfig)).toBe(false);

  // When cloudflareVisitorIp was false, Firewall is NOT enabled.
  writeFileSync(stSettings, `${JSON.stringify({ version: 1, cloudflareVisitorIp: false }, null, 2)}\n`, { mode: 0o600 });
  enabledCount = 0;
  const undoOff = migrateVisitorIp(() => { enabledCount++; }, paths);
  expect(undoOff).not.toBeNull();
  expect(enabledCount).toBe(0);
  expect(JSON.parse(readFileSync(vipState, "utf8"))).toEqual({ version: 1, enabled: false });
});

test("migrateVisitorIp handles unsaved default-on visitor IPs, carries System Tweaks' root lock, and rolls both back", () => {
  const dir = mkdtempSync(join(tmpdir(), "clp-vip-default-"));
  dirs.push(dir);
  const stSettings = join(dir, "system-tweaks", "settings.json");
  const stConfig = join(dir, "etc", "system-tweaks.conf");
  const fwConfig = join(dir, "etc", "firewall.conf");
  const fwStateDir = join(dir, "firewall");
  const fwPolicy = join(fwStateDir, "policy.json");
  const vipState = join(fwStateDir, "visitor-ip.json");
  const vipMaps = join(dir, "00-clp-addons-visitor-ip.conf");
  const locksFile = join(dir, "etc", "locks.json");
  const locksLock = join(dir, "locks.lock");
  const uid = process.getuid!();
  mkdirSync(join(dir, "etc"), { recursive: true });
  chmodSync(join(dir, "etc"), 0o755);
  writeFileSync(stConfig, "enabled=1\n", { mode: 0o644 });
  writeFileSync(locksFile, `${JSON.stringify({ addons: ["system-tweaks"] }, null, 2)}\n`, { mode: 0o644 });

  const paths = {
    systemTweaksSettings: stSettings,
    systemTweaksConfig: stConfig,
    firewallConfig: fwConfig,
    firewallPolicy: fwPolicy,
    firewallStateDir: fwStateDir,
    visitorIpState: vipState,
    visitorIpMaps: vipMaps,
    locksFile,
    locksLock,
    rootUid: uid,
  };

  // Without the legacy key or the applied map (e.g. a fresh install on v2.3), nothing migrates.
  expect(visitorIpMigrationPending(paths)).toBe(false);
  expect(migrateVisitorIp(() => { throw new Error("must not enable"); }, paths)).toBeNull();

  // With the map written by System Tweaks' unsaved default (and no settings.json), migration runs and enables Firewall.
  writeFileSync(vipMaps, `${MAPS_MARKER}\nmap $remote_addr $clp_visitor_ip { default $remote_addr; }\n`, { mode: 0o644 });
  expect(visitorIpMigrationPending(paths)).toBe(true);
  let enabled = 0;
  const undo = migrateVisitorIp(() => {
    enabled++;
    writeFileSync(fwConfig, "enabled=1\n", { mode: 0o644 });
  }, paths);
  expect(undo).not.toBeNull();
  expect(enabled).toBe(1);
  expect(JSON.parse(readFileSync(vipState, "utf8"))).toEqual({ version: 1, enabled: true });
  expect(lockedAddons(locksFile, uid)).toEqual(["firewall", "system-tweaks"]);
  expect(visitorIpMigrationPending(paths)).toBe(false);

  // Rollback removes visitor-ip.json, firewall.conf, and the carried firewall lock while preserving system-tweaks' lock.
  undo!();
  expect(existsSync(vipState)).toBe(false);
  expect(existsSync(fwConfig)).toBe(false);
  expect(lockedAddons(locksFile, uid)).toEqual(["system-tweaks"]);

  // When Firewall was ALREADY enabled before upgrading and System Tweaks had unsaved default-on visitor IPs,
  // migration still records visitor-ip.json and carries System Tweaks' root lock without re-enabling Firewall.
  writeFileSync(fwConfig, "enabled=1\n", { mode: 0o644 });
  expect(visitorIpMigrationPending({ ...paths, firewallWasEnabled: true })).toBe(true);
  const undoAlreadyEnabled = migrateVisitorIp(() => { throw new Error("firewall is already enabled"); }, {
    ...paths,
    firewallWasEnabled: true,
  });
  expect(undoAlreadyEnabled).not.toBeNull();
  expect(JSON.parse(readFileSync(vipState, "utf8"))).toEqual({ version: 1, enabled: true });
  expect(lockedAddons(locksFile, uid)).toEqual(["firewall", "system-tweaks"]);
  expect(visitorIpMigrationPending({ ...paths, firewallWasEnabled: true })).toBe(false);
  undoAlreadyEnabled!();
  expect(existsSync(vipState)).toBe(false);
  expect(existsSync(fwConfig)).toBe(true);
  expect(lockedAddons(locksFile, uid)).toEqual(["system-tweaks"]);

  // When an earlier migration in the same pass (such as protocol migration) already created firewall.conf,
  // passing firewallWasEnabled: false still migrates the unsaved default and carries System Tweaks' root lock.
  const undoAfterProtocols = migrateVisitorIp(() => { throw new Error("firewall is already enabled"); }, {
    ...paths,
    firewallWasEnabled: false,
  });
  expect(undoAfterProtocols).not.toBeNull();
  expect(JSON.parse(readFileSync(vipState, "utf8"))).toEqual({ version: 1, enabled: true });
  expect(lockedAddons(locksFile, uid)).toEqual(["firewall", "system-tweaks"]);
  undoAfterProtocols!();
  expect(existsSync(vipState)).toBe(false);
  expect(existsSync(fwConfig)).toBe(true);
  expect(lockedAddons(locksFile, uid)).toEqual(["system-tweaks"]);
});

test("restoreVisitorIp persists visitor-ip.json on a fresh install so later repair never mistakes it for a legacy migration", () => {
  const b = box();
  const dir = mkdtempSync(join(tmpdir(), "clp-vip-fresh-"));
  dirs.push(dir);
  const stConfig = join(dir, "system-tweaks.conf");
  const fwConfig = join(dir, "firewall.conf");
  writeFileSync(stConfig, "enabled=1\n", { mode: 0o644 });
  writeFileSync(fwConfig, "enabled=1\n", { mode: 0o644 });

  restoreVisitorIp(b.options);
  expect(existsSync(b.paths.stateFile)).toBe(true);
  expect(visitorIpMigrationPending({
    systemTweaksSettings: join(dir, "missing-settings.json"),
    systemTweaksConfig: stConfig,
    firewallConfig: fwConfig,
    firewallPolicy: join(dir, "policy.json"),
    firewallStateDir: dir,
    visitorIpState: b.paths.stateFile,
    visitorIpMaps: b.paths.maps,
    locksFile: join(dir, "locks.json"),
    locksLock: join(dir, "locks.lock"),
    rootUid: process.getuid!(),
  })).toBe(false);
});

test("Firewall declares both nginx.conf and fastcgi_params conffiles for apt-hook release", () => {
  const paths = (FIREWALL_ADDON.conffiles ?? []).map((entry) => entry.path);
  expect(paths).toEqual(["/etc/nginx/nginx.conf", "/etc/nginx/fastcgi_params"]);
});

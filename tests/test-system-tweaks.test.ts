import { afterEach, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync,
  writeFileSync,
} from "node:fs";
import { X509Certificate } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runCommand, type CommandResult } from "../lib/command";
import { inspectPhpGuard, reconcilePhpGuard, type PhpGuardOptions } from "../lib/php-guard";
import {
  executeSystemTweaksAction, lockSettingsStep, readSettings, restoreSystemTweaks, systemTweaksMaintenance, systemTweaksMotd, systemTweaksPhpGuardOff, systemTweaksPhpMyAdmin, systemTweaksPhpPools, systemTweaksUpkeep, withdrawSystemTweaks,
  type SystemTweaksOptions, type SystemTweaksPaths,
} from "../addons/system-tweaks/action";
import { LOCK_SETTINGS, type SystemTweaksState } from "../addons/system-tweaks/registry";
import {
  allowedPatterns, coverageOf, dropInFor, fnmatch, parseAptConfig, parsePolicy, updatesStatus, DEFAULT_UPDATE_SETTINGS, type UpdatesStatus,
} from "../addons/system-tweaks/updates";
import { iniBoolean, iniSetting, uploadProgressStatus } from "../addons/system-tweaks/upload-progress";
import { dashboardView } from "../addons/system-tweaks/app/views";
import { isSwitchVerb } from "../addons/system-tweaks/app/service";
import { releaseRealIp } from "../addons/system-tweaks/real-ip";
import { releaseVisitorIp } from "../addons/system-tweaks/visitor-ip";
import WRAPPER_SCRIPT from "../addons/system-tweaks/clpctl-wrapper.sh" with { type: "text" };
import { DEFAULT_BACKUP_COMPRESSION } from "../addons/system-tweaks/backup-compression";
import { MOTD_SCRIPT, applyMotd } from "../addons/system-tweaks/motd";
import { DATABASE_FILE } from "../addons/system-tweaks/database";
import { SYSTEM_TWEAKS_VERBS } from "../addons/system-tweaks/verbs";
import { TWEAK_ROW_JS } from "../lib/app-ui";
import { lockedAddons } from "../lib/root-locks";

// CloudPanel's original /usr/bin/clpctlWrapper (cloudpanel 2.5.4-3), whose SHA-256
// is in KNOWN_ORIGINAL_SHA256, so the guard treats it as a known original.
const CLPCTL_ORIGINAL = Buffer.from(
  "IyEvYmluL2Jhc2gKYWRkc2xhc2hlcygpewogIGxvY2FsIGlucHV0PSIkMSIKICBsb2NhbCBlc2Nh" +
  "cGVkPSIke2lucHV0Ly9cXC9cXFxcfSIKICBlc2NhcGVkPSIke2VzY2FwZWQvL1xgL1xcXGB9Igog" +
  "IGVzY2FwZWQ9IiR7ZXNjYXBlZC8vXCgvXFxcKH0iCiAgZXNjYXBlZD0iJHtlc2NhcGVkLy9cKS9c" +
  "XFwpfSIKICBlc2NhcGVkPSIke2VzY2FwZWQvL1wkL1xcXCR9IgogIGVzY2FwZWQ9IiR7ZXNjYXBl" +
  "ZC8vXFxcIi9cXFxcXCJ9IgogIGVjaG8gIiRlc2NhcGVkIgp9CmlmIFsgIiQjIiAtZXEgMCBdOyB0" +
  "aGVuCiAgQ09NTUFORD0iL3Vzci9iaW4vcGhwOC4xIC1jIC9ob21lL2NscC9zZXJ2aWNlcy9waHAt" +
  "ZnBtL2NsaS9waHAuaW5pIC9ob21lL2NscC9odGRvY3MvYXBwL2ZpbGVzL2Jpbi9jbHBjdGwgJEAi" +
  "CmVsc2UKICBhcmdzPSQoYWRkc2xhc2hlcyAiJChwcmludGYgJyAiJXEiJyAiJEAiKSIpCiAgaWYg" +
  "ZWNobyAiJGFyZ3MiIHwgZ3JlcCAtcSAnXFxuJzt0aGVuCiAgICBlY2hvICJJbnZhbGlkIGNvbW1h" +
  "bmQiO2V4aXQKICBlbGlmIGVjaG8gIiRhcmdzIiB8IGdyZXAgLXEgJ1xccic7dGhlbgogICAgZWNo" +
  "byAiSW52YWxpZCBjb21tYW5kIjtleGl0CiAgZmkKICBDT01NQU5EPSIvdXNyL2Jpbi9waHA4LjEg" +
  "LWMgL2hvbWUvY2xwL3NlcnZpY2VzL3BocC1mcG0vY2xpL3BocC5pbmkgL2hvbWUvY2xwL2h0ZG9j" +
  "cy9hcHAvZmlsZXMvYmluL2NscGN0bCAkYXJncyIKZmkKc3UgLXMgL2Jpbi9iYXNoIC1jICIkQ09N" +
  "TUFORCIgY2xw",
  "base64",
).toString("utf8");

const dirs: string[] = [];
const listeners: { stop(): void }[] = [];
afterEach(() => {
  for (const listener of listeners.splice(0)) listener.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "clp-system-tweaks-"));
  dirs.push(dir);
  return dir;
}

const DEBIAN_POLICY = `Package files:
 100 /var/lib/dpkg/status
     release a=now
1000 https://d17k9fuiwb52nc.cloudfront.net bookworm/php-8.3 amd64 Packages
     release o=packages-v1.cloudpanel.io,n=bookworm,c=php-8.3,b=amd64
     origin d17k9fuiwb52nc.cloudfront.net
1000 https://d17k9fuiwb52nc.cloudfront.net bookworm/php-8.1 amd64 Packages
     release o=packages-v1.cloudpanel.io,n=bookworm,c=php-8.1,b=amd64
     origin d17k9fuiwb52nc.cloudfront.net
1000 https://d17k9fuiwb52nc.cloudfront.net bookworm/nginx amd64 Packages
     release o=packages-v1.cloudpanel.io,n=bookworm,c=nginx,b=amd64
     origin d17k9fuiwb52nc.cloudfront.net
1000 https://d17k9fuiwb52nc.cloudfront.net bookworm/percona-server-server-8.0 amd64 Packages
     release o=packages-v1.cloudpanel.io,n=bookworm,c=percona-server-server-8.0,b=amd64
     origin d17k9fuiwb52nc.cloudfront.net
1000 https://d17k9fuiwb52nc.cloudfront.net bookworm/main amd64 Packages
     release o=packages-v1.cloudpanel.io,n=bookworm,c=main,b=amd64
     origin d17k9fuiwb52nc.cloudfront.net
 500 http://mirror.hetzner.com/debian/security bookworm-security/main amd64 Packages
     release v=12,o=Debian,a=oldstable-security,n=bookworm-security,l=Debian-Security,c=main,b=amd64
     origin mirror.hetzner.com
 500 http://mirror.hetzner.com/debian/packages bookworm-updates/main amd64 Packages
     release v=12-updates,o=Debian,a=oldstable-updates,n=bookworm-updates,l=Debian,c=main,b=amd64
     origin mirror.hetzner.com
 500 http://mirror.hetzner.com/debian/packages bookworm/main amd64 Packages
     release v=12.15,o=Debian,a=oldstable,n=bookworm,l=Debian,c=main,b=amd64
     origin mirror.hetzner.com
Pinned packages:
`;

const DEBIAN_STOCK_DUMP = `APT::Periodic::Update-Package-Lists "0";
APT::Periodic::Unattended-Upgrade "0";
Unattended-Upgrade::Origins-Pattern "";
Unattended-Upgrade::Origins-Pattern:: "origin=Debian,codename=\${distro_codename},label=Debian";
Unattended-Upgrade::Origins-Pattern:: "origin=Debian,codename=\${distro_codename},label=Debian-Security";
Unattended-Upgrade::Origins-Pattern:: "origin=Debian,codename=\${distro_codename}-security,label=Debian-Security";
`;

const debian = { id: "Debian", codename: "bookworm" };

function covered(rows: ReturnType<typeof coverageOf>): Record<string, string> {
  return Object.fromEntries(rows.map((row) => [row.name, row.covered]));
}

test("Debian's own patterns leave every CloudPanel repository uncovered", () => {
  const rows = coverageOf(parsePolicy(DEBIAN_POLICY), allowedPatterns(parseAptConfig(DEBIAN_STOCK_DUMP)), debian);
  expect(covered(rows)).toEqual({
    "CloudPanel PHP": "none",
    Nginx: "none",
    MySQL: "none",
    CloudPanel: "none",
    "Debian bookworm-security": "all",
    "Debian bookworm-updates": "none",
    "Debian bookworm": "all",
  });
  expect(rows.find((row) => row.name === "CloudPanel PHP")!.detail).toBe("8.1, 8.3");
});

test("CloudPanel's other repositories get product names and Debian's components keep their own order", () => {
  const source = (component: string, origin = "packages-v1.cloudpanel.io", n = "bookworm") =>
    ({ origin, label: "", archive: "", codename: n, component, site: "" });
  const rows = coverageOf([
    source("varnish-7"), source("proftpd"),
    ...["non-free", "contrib", "main", "non-free-firmware"].map((c) => source(c, "Debian", "bookworm-security")),
  ], [], debian);
  expect(rows.map((row) => [row.name, row.detail])).toEqual([
    ["Varnish", "varnish-7"], ["ProFTPD", "proftpd"], ["Debian bookworm-security", "main, contrib, non-free, non-free-firmware"],
  ]);
});

test("the drop-in adds PHP and Nginx by default, and the database and panel only when asked", () => {
  const patterns = (settings: typeof DEFAULT_UPDATE_SETTINGS) => [
    ...allowedPatterns(parseAptConfig(DEBIAN_STOCK_DUMP)),
    ...[...dropInFor(settings, "Debian").matchAll(/^\t"(.*)";$/gm)].map((match) => match[1]!),
  ];
  const sources = parsePolicy(DEBIAN_POLICY);
  const defaults = covered(coverageOf(sources, patterns({ ...DEFAULT_UPDATE_SETTINGS, enabled: true }), debian));
  expect(defaults["CloudPanel PHP"]).toBe("all");
  expect(defaults.Nginx).toBe("all");
  expect(defaults.MySQL).toBe("none");
  expect(defaults.CloudPanel).toBe("none");
  const everything = covered(coverageOf(sources, patterns({ ...DEFAULT_UPDATE_SETTINGS, enabled: true, database: true, panel: true }), debian));
  expect(everything.MySQL).toBe("all");
  expect(everything.CloudPanel).toBe("all");
  expect(dropInFor(DEFAULT_UPDATE_SETTINGS, "Debian")).toContain('Unattended-Upgrade::Automatic-Reboot "false";');
});

test("Ubuntu's Allowed-Origins and the drop-in's Ubuntu pattern both match its security pocket", () => {
  const sources = parsePolicy(` 500 http://security.ubuntu.com/ubuntu jammy-security/main amd64 Packages
     release v=22.04,o=Ubuntu,a=jammy-security,n=jammy,l=Ubuntu,c=main,b=amd64
     origin security.ubuntu.com
 500 http://archive.ubuntu.com/ubuntu jammy-backports/main amd64 Packages
     release v=22.04,o=Ubuntu,a=jammy-backports,n=jammy,l=Ubuntu,c=main,b=amd64
     origin archive.ubuntu.com
`);
  const ubuntu = { id: "Ubuntu", codename: "jammy" };
  const stock = allowedPatterns(parseAptConfig('Unattended-Upgrade::Allowed-Origins:: "${distro_id}:${distro_codename}-security";\n'));
  expect(stock).toEqual(["o=${distro_id},a=${distro_codename}-security"]);
  expect(coverageOf(sources, stock, ubuntu).map((row) => [row.name, row.covered])).toEqual([
    ["Ubuntu jammy-security", "all"],
    ["Ubuntu jammy-backports", "none"],
  ]);
  const ours = [...dropInFor(DEFAULT_UPDATE_SETTINGS, "Ubuntu").matchAll(/^\t"(.*)";$/gm)].map((match) => match[1]!);
  expect(coverageOf(sources, ours, ubuntu).map((row) => row.covered)).toEqual(["all", "none"]);
});

test("fnmatch follows Python's fnmatchcase", () => {
  expect(fnmatch("php-8.3", "php-*")).toBe(true);
  expect(fnmatch("php8.3", "php-*")).toBe(false);
  expect(fnmatch("PHP-8.3", "php-*")).toBe(false);
  expect(fnmatch("a.b", "a?b")).toBe(true);
  expect(fnmatch("axb", "a.b")).toBe(false);
  expect(fnmatch("c", "[abc]")).toBe(true);
  expect(fnmatch("c", "[!abc]")).toBe(false);
});

// --- a fake box ---------------------------------------------------------------

interface Box {
  options: SystemTweaksOptions;
  /** What started the reconcile service, as a failed withdrawal does. */
  reconcile: string[];
  pools: { loaded: boolean; loads: number };
  aptDir: string;
  dropIn: string;
  commands: string[];
  timers: Map<string, string>;
  phpRoot: string;
  guardConfig: string;
  settingsFile: string;
  installed: { value: boolean };
  nginxConf: string;
  panelConf: string;
  cloudflareIps: string;
  nginx: { fail: boolean; failPanel: boolean; commands: string[] };
  fpm: { failTest: boolean; status: number; loaded: boolean; commands: string[] };
  vhostGuardPaths: { script: string; pool: string };
  fm: { failTest: boolean; status: number; loaded: boolean; commands: string[] };
  fileManagerGuardPaths: { script: string; pool: string; socket: string };
  valuesDb: string;
  varnish: { failDaemonReload: boolean };
  panelVhost: string;
  agent: { installed: boolean; loaded: boolean; probe: "refused" | "sent" | "unit-failed"; control: "refused" | "sent"; commands: string[] };
  agentDropIn: string;
  motdBanner: string;
  motdScript: string;
}

const VALUES_SCHEMA = `
CREATE TABLE site (id INTEGER PRIMARY KEY, domain_name TEXT, user TEXT, root_directory TEXT, reverse_proxy_url TEXT, basic_auth_id INTEGER, varnish_cache INTEGER DEFAULT 0, vhost_template TEXT DEFAULT '');
CREATE TABLE blocked_bot (id INTEGER PRIMARY KEY, site_id INTEGER, name TEXT);
CREATE TABLE blocked_ip (id INTEGER PRIMARY KEY, site_id INTEGER, ip TEXT);
CREATE TABLE basic_auth (id INTEGER PRIMARY KEY, whitelisted_ips TEXT);
CREATE TABLE php_settings (id INTEGER PRIMARY KEY, site_id INTEGER, additional_configuration TEXT);
CREATE TABLE nodejs_settings (id INTEGER PRIMARY KEY, site_id INTEGER, port INTEGER);
CREATE TABLE python_settings (id INTEGER PRIMARY KEY, site_id INTEGER, port INTEGER);
`;

const PANEL_NGINX_CONF = `http {
    real_ip_recursive on;

    set_real_ip_from 127.0.0.1;
    set_real_ip_from 10.0.0.0/8;
    set_real_ip_from 0.0.0.0/0;
    real_ip_header X-Forwarded-For;
}
`;

const PANEL_VHOST = `server {
  listen 8443 ssl;
  set $basicAuth "off";
  if (-f /home/clp/services/nginx/basic-auth/credentials) {
    set $basicAuth "on";
  }
  if ($request_uri ~ ^/phpmyadmin) {
    set $basicAuth "off";
  }
  auth_basic $basicAuth;
  auth_basic_user_file /home/clp/services/nginx/basic-auth/credentials;
}
`;

const CLOUDPANEL_NGINX_CONF = `http {
    real_ip_recursive on;

    set_real_ip_from 127.0.0.1;
    set_real_ip_from 10.0.0.0/8;
    set_real_ip_from 172.16.0.0/12;
    set_real_ip_from 192.168.0.0/16;
    set_real_ip_from 0.0.0.0/0;
    #real_ip_header X-Forwarded-For;
}
`;

/** apt-config dump over the box's files, enough of apt's syntax for these drop-ins. */
function dumpOf(aptDir: string): string {
  const out: string[] = [];
  for (const name of readdirSync(aptDir).sort()) {
    const text = readFileSync(join(aptDir, name), "utf8");
    let list = "";
    for (const line of text.split("\n")) {
      const open = /^(\S+) \{$/.exec(line.trim());
      if (open) { list = open[1]!; continue; }
      if (line.trim() === "};") { list = ""; continue; }
      const item = /^"(.*)";$/.exec(line.trim());
      if (list && item) { out.push(`${list}:: "${item[1]}";`); continue; }
      const scalar = /^(\S+) "(.*)";$/.exec(line.trim());
      if (scalar) out.push(`${scalar[1]} "${scalar[2]}";`);
    }
  }
  return out.join("\n");
}

function box(options: { installed?: boolean; timers?: Record<string, string>; failEnable?: string[]; log?: string } = {}): Box {
  const dir = tempDir();
  const aptDir = join(dir, "apt.conf.d");
  mkdirSync(aptDir);
  writeFileSync(join(aptDir, "20auto-upgrades"), 'APT::Periodic::Update-Package-Lists "0";\nAPT::Periodic::Unattended-Upgrade "0";\n');
  writeFileSync(join(aptDir, "50unattended-upgrades"), 'Unattended-Upgrade::Origins-Pattern {\n\t"origin=Debian,codename=${distro_codename}-security,label=Debian-Security";\n};\n');
  const phpRoot = join(dir, "php");
  const sbin = join(dir, "sbin");
  mkdirSync(sbin);
  for (const version of ["8.1", "8.3"]) {
    mkdirSync(join(phpRoot, version, "fpm", "conf.d"), { recursive: true });
    mkdirSync(join(phpRoot, version, "fpm", "pool.d"), { recursive: true });
    writeFileSync(join(phpRoot, version, "fpm", "php.ini"), "[Session]\n;session.upload_progress.enabled = On\n");
    writeFileSync(join(sbin, `php-fpm${version}`), "");
  }
  if (options.log) {
    mkdirSync(join(dir, "log"));
    writeFileSync(join(dir, "log", "unattended-upgrades.log"), options.log);
  }
  const timers = new Map(Object.entries(options.timers ?? { "apt-daily.timer": "enabled", "apt-daily-upgrade.timer": "enabled" }));
  const installed = { value: options.installed !== false };
  const commands: string[] = [];
  const reconcile: string[] = [];
  const ok = (stdout = ""): CommandResult => ({ ok: true, stdout, stderr: "" });
  const run = (command: string, args: string[]): CommandResult => {
    commands.push(`${command} ${args.join(" ")}`);
    if (command === "dpkg-query") return installed.value ? ok("install ok installed\t2.9.1+nmu3") : { ok: false, stdout: "", stderr: "" };
    if (command === "lsb_release") return ok(args[0] === "-i" ? "Debian\n" : "bookworm\n");
    if (command === "apt-config") return ok(dumpOf(aptDir));
    if (command === "apt-cache") return ok(DEBIAN_POLICY);
    if (command === "apt-get") {
      if (args[0] === "install") installed.value = true;
      return ok();
    }
    if (command === "systemctl" && args[0] === "is-enabled") return ok(`${timers.get(args[1]!) ?? ""}\n`);
    if (command === "systemctl" && args[0] === "enable") {
      if (options.failEnable?.includes(args[2]!)) return { ok: false, stdout: "", stderr: "Failed to enable unit" };
      timers.set(args[2]!, "enabled");
      return ok();
    }
    if (command === "systemctl" && args[0] === "disable") { timers.set(args[2]!, "disabled"); return ok(); }
    if (command === "systemctl" && args[0] === "show" && args[1] === "clp-php-fpm.service") {
      return ok(`{ path=${sbin}/php-fpm8.3 ; argv[]=${sbin}/php-fpm8.3 -R -F -y ${dir}/clp/php-fpm.conf -c ${dir}/clp/php.ini ; ignore_errors=no }`);
    }
    if (command === "systemctl" && args[0] === "show") return ok("Sat 2026-10-24 06:32:16 UTC\n");
    return ok();
  };
  mkdirSync(join(dir, "clp", "pool.d"), { recursive: true });
  writeFileSync(join(dir, "clp", "php.ini"), "");
  const guardConfig = join(dir, "system-tweaks.conf");
  writeFileSync(guardConfig, "");
  const settingsFile = join(dir, "state", "settings.json");
  const uid = process.getuid!();
  const nginxConf = join(dir, "nginx.conf");
  writeFileSync(nginxConf, CLOUDPANEL_NGINX_CONF, { mode: 0o644 });
  const panelConf = join(dir, "clp-nginx.conf");
  writeFileSync(panelConf, PANEL_NGINX_CONF);
  chmodSync(panelConf, 0o770);
  const cloudflareIps = join(dir, "cloudflare-ips");
  const panelVhost = join(dir, "cloudpanel.conf");
  writeFileSync(panelVhost, PANEL_VHOST);
  chmodSync(panelVhost, 0o770);
  writeFileSync(cloudflareIps, "allow 173.245.48.0/20;\nallow 2400:cb00::/32;\ndeny all;\n");
  const nginx = { fail: false, failPanel: false, commands: [] as string[] };
  const nginxRun = (command: string, args: string[]): CommandResult => {
    nginx.commands.push(`${command} ${args.join(" ")}`);
    if (command !== "nginx" || args[0] !== "-t") return ok();
    const panel = args[1] === "-c";
    const failing = panel ? nginx.failPanel : nginx.fail;
    return failing && readFileSync(panel ? panelConf : nginxConf, "utf8").includes("#clp-addons:untrusted") ? { ok: false, stdout: "", stderr: "emerg" } : ok();
  };
  // `loaded` is the pool file the fake FPM read at its last reload.
  const fpm = { failTest: false, status: 200, loaded: false, commands: [] as string[] };
  const fpmRun = (command: string, args: string[]): CommandResult => {
    fpm.commands.push(`${command} ${args.join(" ")}`);
    if (command === "systemctl" && args[0] === "show") {
      return ok(`{ path=${sbin}/php-fpm8.3 ; argv[]=${sbin}/php-fpm8.3 -R -F -y ${dir}/clp/php-fpm.conf -c ${dir}/clp/php.ini ; ignore_errors=no }`);
    }
    if (command.endsWith("php-fpm8.3") && fpm.failTest) return { ok: false, stdout: "", stderr: "ERROR: bad pool" };
    if (command === "systemctl" && args[0] === "reload") fpm.loaded = existsSync(vhostGuardPaths.pool);
    return ok();
  };
  const vhostGuardPaths = {
    script: join(dir, "clp", "clp-addons-vhost-guard.php"),
    pool: join(dir, "clp", "pool.d", "zz-clp-addons-vhost-guard.conf"),
    lockFile: join(dir, "panel-php.lock"),
    rootUid: uid,
  };
  // The File Manager pool reloads through its own fake, so the vhost guard's commands stay its own.
  const fm = { failTest: false, status: 200, loaded: false, commands: [] as string[] };
  const fmRun = (command: string, args: string[]): CommandResult => {
    fm.commands.push(`${command} ${args.join(" ")}`);
    if (command === "systemctl" && args[0] === "show") {
      return ok(`{ path=${sbin}/php-fpm8.3 ; argv[]=${sbin}/php-fpm8.3 -R -F -y ${dir}/clp/php-fpm.conf -c ${dir}/clp/php.ini ; ignore_errors=no }`);
    }
    if (command.endsWith("php-fpm8.3") && fm.failTest) return { ok: false, stdout: "", stderr: "ERROR: bad pool" };
    if (command === "systemctl" && args[0] === "reload") fm.loaded = existsSync(fileManagerGuardPaths.pool);
    return ok();
  };
  const fileManagerGuardPaths = {
    script: join(dir, "clp", "clp-addons-file-manager-guard.php"),
    pool: join(dir, "clp", "pool.d", "zz-clp-addons-file-manager-guard.conf"),
    socket: join(dir, "fm.sock"),
    lockFile: join(dir, "panel-php.lock"),
    rootUid: uid,
    panelUid: uid,
    panelGid: process.getgid!(),
  };
  listeners.push(Bun.listen({ unix: fileManagerGuardPaths.socket, socket: { data() {} } }));
  chmodSync(fileManagerGuardPaths.socket, 0o660);
  // CloudPanel's tables the stored-value check reads, with one clean site.
  const valuesDb = join(dir, "values.sq3");
  const values = new Database(valuesDb, { create: true });
  values.exec(VALUES_SCHEMA);
  values.exec("INSERT INTO site (id, domain_name, user, root_directory) VALUES (1, 'example.com', 'example', 'example.com');");
  values.close();
  const nginxUnit = join(dir, "nginx.service");
  writeFileSync(nginxUnit, "[Service]\nExecStartPre=/usr/sbin/nginx -t -q\nExecReload=/usr/sbin/nginx -s reload\n");
  const varnish = { failDaemonReload: false };
  const varnishRun = (command: string, args: string[]): CommandResult => {
    if (command === "systemctl" && args[0] === "show") return ok(`${nginxUnit}\n`);
    if (command === "systemctl" && args[0] === "daemon-reload" && varnish.failDaemonReload) return { ok: false, stdout: "", stderr: "Access denied" };
    return ok();
  };
  const tmpRoot = join(dir, "tmp-cleanup");
  mkdirSync(join(tmpRoot, "tmp"), { recursive: true });
  mkdirSync(join(tmpRoot, "proc"));
  writeFileSync(join(tmpRoot, "passwd"), "");
  const panelDb = join(tmpRoot, "db.sq3");
  const db = new Database(panelDb, { create: true });
  db.exec("CREATE TABLE site (id INTEGER PRIMARY KEY, user TEXT); CREATE TABLE php_settings (site_id INTEGER);");
  db.close();
  // nft as a flag: whether the PHP pool table is loaded.
  const pools = { loaded: false, loads: 0 };
  const poolsRun = (command: string, args: string[]): CommandResult => {
    if (command !== "nft") return ok();
    if (args[0] === "list") return pools.loaded ? ok() : { ok: false, stdout: "", stderr: "No such file or directory" };
    if (args[0] === "-f") { pools.loaded = true; pools.loads++; }
    if (args[0] === "delete") pools.loaded = false;
    return ok();
  };
  // systemd as two flags: whether clp-agent is installed and whether the drop-in is loaded.
  const agentDropIn = join(dir, "clp-agent.service.d", "zz-clp-addons-telemetry.conf");
  // `probe` is what the filtered test send meets; `control` the same send outside the filter.
  const agent = {
    installed: true, loaded: false, commands: [] as string[],
    probe: "refused" as "refused" | "sent" | "unit-failed", control: "sent" as "refused" | "sent",
  };
  const sendResult = (outcome: "refused" | "sent") =>
    ok(outcome === "sent" ? "clp-addons-probe:sent\n" : "clp-addons-probe:refused:/bin/bash: line 1: echo: write error: Operation not permitted\n");
  const agentRun = (command: string, args: string[]): CommandResult => {
    agent.commands.push(`${command} ${args.join(" ")}`);
    if (command === "systemd-run") {
      return agent.probe === "unit-failed"
        ? { ok: false, stdout: "", stderr: "Failed to start transient service unit: Operation not permitted" }
        : sendResult(agent.probe);
    }
    if (command === "/bin/bash") return sendResult(agent.control);
    if (args[0] === "daemon-reload") agent.loaded = existsSync(agentDropIn);
    if (args[0] !== "show") return ok();
    return ok([
      `LoadState=${agent.installed ? "loaded" : "not-found"}`,
      `IPAddressDeny=${agent.loaded ? "0.0.0.0/0 ::/0" : ""}`,
      `DropInPaths=${agent.loaded ? agentDropIn : ""}`,
    ].join("\n"));
  };
  writeFileSync(join(dir, "meminfo"), "MemTotal:        3911232 kB\n");
  const motdBanner = join(dir, "update-motd.d", "10-cloudpanel");
  const motdScript = join(dir, "update-motd.d", "10-clp-addons-server-info");
  mkdirSync(dirname(motdBanner));
  writeFileSync(motdBanner, "#!/bin/bash\necho CloudPanel\n", { mode: 0o775 });
  const phpGuard: PhpGuardOptions = {
    run: () => ({ ok: true, out: "" }),
    isActive: () => false,
    paths: { phpRoot, fpmBinDir: sbin, rootUid: uid },
  };
  return {
    reconcile, pools, aptDir, commands, timers, phpRoot, guardConfig, settingsFile, installed, nginxConf, panelConf, cloudflareIps, nginx, fpm, panelVhost, vhostGuardPaths, valuesDb, varnish,
    fm, fileManagerGuardPaths, agent, agentDropIn, motdBanner, motdScript,
    dropIn: join(aptDir, "52clp-addons-unattended-upgrades"),
    options: {
      processUid: 0,
      reconcile: { run: (command, args) => { reconcile.push(`${command} ${args.join(" ")}`); return ok(); } },
      paths: { settingsFile, lockFile: join(dir, "lock"), rootUid: uid },
      updates: {
        run,
        paths: {
          aptConfDir: aptDir, aptConf: join(dir, "apt.conf"), dropIn: join(aptDir, "52clp-addons-unattended-upgrades"),
          rebootRequired: join(dir, "reboot-required"), logFile: join(dir, "log", "unattended-upgrades.log"),
          osRelease: join(dir, "os-release"),
        },
      },
      uploadProgress: { run, paths: { phpRoot, fpmBinDir: sbin, panelUnit: "clp-php-fpm.service" } },
      phpGuard,
      panelPhp: {
        run: () => ({ ok: false, stdout: "", stderr: "no panel unit in this fixture" }),
        paths: {
          stateFile: join(dir, "panel-php.json"), lockFile: join(dir, "panel-php.lock"),
          dropInFile: join(dir, "panel-php.conf"), configFile: guardConfig,
          fpmBinDir: sbin, procRoot: join(dir, "proc"), rootUid: uid,
        },
      },
      realIp: { run: nginxRun, paths: { nginxConf, panelConf, cloudflareIps, panelUid: uid, panelGid: process.getgid!(), rootUid: uid, rootGid: process.getgid!() } },
      visitorIp: { run: () => ok(), paths: { nginxConf, fastcgiParams: join(dir, "fastcgi_params"), maps: join(dir, "visitor-ip.conf"), cloudflareIps, rootUid: uid } },
      phpMyAdmin: { run: () => ok(), paths: { vhost: panelVhost, panelConf, panelUid: uid, panelGid: process.getgid!(), rootUid: uid, rootGid: process.getgid!() } },
      // No panel server block until a test writes one.
      panelCert: {
        run: (command, args) => command === "openssl" ? runCommand(command, args) : nginxRun(command, args),
        hostname: () => "panel", addresses: () => ["203.0.113.10"],
        paths: {
          vhost: join(dir, "cloudpanel.conf"), panelConf, cert: join(dir, "cert.crt"), key: join(dir, "private.key"),
          storedCert: join(dir, "state", "panel-cert.crt"), storedKey: join(dir, "state", "panel-cert.key"),
          customDomainVhost: join(dir, "custom-domain.conf"), panelUid: uid, rootUid: uid,
        },
      },
      vhostGuard: {
        run: fpmRun, paths: vhostGuardPaths, sleep: async () => {}, healthTimeoutMs: 0,
        request: async (_socket, params) => ({
          status: params.QUERY_STRING === "vhost-template=" ? (fpm.loaded ? 403 : 200) : fpm.status, headers: {}, body: "",
        }),
      },
      fileManagerGuard: {
        run: fmRun, paths: fileManagerGuardPaths, sleep: async () => {}, healthTimeoutMs: 0,
        request: async (_socket, params) => ({
          status: params.HTTP_COOKIE === "cloudpanel=../x" ? (fm.loaded ? 403 : 200) : fm.status, headers: {}, body: "",
        }),
      },
      vhostValues: { panelDb: valuesDb, homeRoot: join(dir, "home") },
      varnishBackend: {
        run: varnishRun,
        paths: {
          panelDb: valuesDb, homeRoot: join(dir, "home"), vhostDir: join(dir, "sites-enabled"),
          includeDir: join(dir, "varnish"), logDir: join(dir, "nginx-logs"), logrotateDir: join(dir, "logrotate.d"), passwdFile: join(dir, "passwd"), dropIn: join(dir, "nginx.service.d", "zz-clp-addons-varnish.conf"), vhostUid: uid,
        },
      },
      phpPools: {
        run: poolsRun,
        paths: {
          phpRoot, passwdFile: join(dir, "passwd"), nginxConf, systemdDir: join(dir, "systemd"),
          rulesFile: join(dir, "php-pools.nft"), bin: "/usr/local/bin/clp-addons",
        },
      },
      clpctlGuard: { version: null, paths: { wrapper: join(dir, "clpctlWrapper"), backup: join(dir, "clpctlWrapper.orig"), rootUid: uid } },
      telemetry: { run: agentRun, paths: { dropIn: agentDropIn } },
      motd: { paths: { banner: motdBanner, script: motdScript, marker: join(dir, "state", "motd-banner-off") } },
      tmpCleanup: { paths: { tmpDir: join(tmpRoot, "tmp"), procDir: join(tmpRoot, "proc"), passwd: join(tmpRoot, "passwd") }, panelDb },
      // No fail2ban in this fixture; tests/test-login-jails.test.ts covers it.
      loginJails: {
        run: () => ({ ok: false, stdout: "", stderr: "not installed" }),
        paths: {
          fail2banDir: join(dir, "fail2ban"), panelConf: null, panelUid: uid, panelGid: process.getgid!(), rootGid: process.getgid!(), cloudflareIps,
          domainVhost: join(dir, "custom-domain.conf"), sitesConf: nginxConf, domainUid: 0, rootUid: uid,
        },
      },
      // No MySQL in this fixture; tests/test-system-tweaks-database.test.ts covers it.
      database: {
        run: () => ({ ok: false, stdout: "", stderr: "no MySQL in this fixture" }),
        paths: { confDirs: [join(dir, "mysql.conf.d")], checkFile: join(dir, "database-check.json") },
      },
      // No ufw in this fixture; tests/test-firewall.test.ts covers it.
      firewall: {
        paths: {
          stateFile: join(dir, "firewall.json"), lockFile: join(dir, "firewall.lock"), panelDb,
          userRules: join(dir, "ufw", "user.rules"), user6Rules: join(dir, "ufw", "user6.rules"), rootUid: uid,
        },
      },
    },
  };
}

async function act(b: Box, argv: string[], input?: unknown): Promise<SystemTweaksState> {
  return executeSystemTweaksAction(argv, { ...b.options, input: input === undefined ? undefined : JSON.stringify(input) }) as Promise<SystemTweaksState>;
}

for (const codename of ["jammy", "noble", "resolute"]) {
  test(`Ubuntu ${codename}: preserve stock security and ESM origins, add CloudPanel PHP, and restore either on or off`, async () => {
    for (const originallyOn of [true, false]) {
      const b = box();
      const periodic = `APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "${originallyOn ? 1 : 0}";\n`;
      const stock = 'Unattended-Upgrade::Allowed-Origins {\n' + [
        "${distro_id}:${distro_codename}", "${distro_id}:${distro_codename}-security",
        "${distro_id}ESMApps:${distro_codename}-apps-security", "${distro_id}ESM:${distro_codename}-infra-security",
      ].map((value) => `\t"${value}";`).join("\n") + '\n};\n';
      writeFileSync(join(b.aptDir, "20auto-upgrades"), periodic);
      writeFileSync(join(b.aptDir, "50unattended-upgrades"), stock);
      const baseRun = b.options.updates!.run!;
      const policy = [
        ["Ubuntu", codename], ["Ubuntu", `${codename}-security`], ["Ubuntu", `${codename}-updates`],
        ["Ubuntu", `${codename}-backports`], ["UbuntuESMApps", `${codename}-apps-security`],
        ["UbuntuESM", `${codename}-infra-security`],
      ].map(([origin, archive]) => ` 500 https://example.test/ubuntu ${archive}/main amd64 Packages\n     release o=${origin},a=${archive},n=${codename},l=${origin},c=main,b=amd64\n     origin example.test\n`).join("") +
        DEBIAN_POLICY.slice(DEBIAN_POLICY.indexOf("1000"), DEBIAN_POLICY.indexOf(" 500")).replaceAll("bookworm", codename);
      b.options.updates!.run = (command, args, env) => {
        if (command === "lsb_release") return { ok: true, stdout: args[0] === "-i" ? "Ubuntu" : codename, stderr: "" };
        if (command === "apt-cache") return { ok: true, stdout: policy, stderr: "" };
        return baseRun(command, args, env);
      };
      const before = await act(b, ["state"]);
      expect(before.updates.enabled).toBe(originallyOn);
      expect(before.updates.managed).toBe(false);
      const enabled = await act(b, ["set-updates"], { enabled: true });
      expect(enabled.updates.enabled).toBe(true);
      expect(covered(enabled.updates.coverage)).toMatchObject({
        [`Ubuntu ${codename}-security`]: "all",
        [`Ubuntu ${codename}-updates`]: "none",
        [`Ubuntu ${codename}-backports`]: "none",
        [`UbuntuESMApps ${codename}-apps-security`]: "all",
        [`UbuntuESM ${codename}-infra-security`]: "all",
        "CloudPanel PHP": "all", Nginx: "all", MySQL: "none", CloudPanel: "none",
      });
      const restored = await act(b, ["set-updates"], { enabled: false });
      expect(restored.updates.enabled).toBe(originallyOn);
      expect(restored.updates.coverage).toEqual(before.updates.coverage);
      expect(restored.updates.outsideSource).toBe(originallyOn ? "20auto-upgrades" : "");
      expect(readFileSync(join(b.aptDir, "20auto-upgrades"), "utf8")).toBe(periodic);
      expect(readFileSync(join(b.aptDir, "50unattended-upgrades"), "utf8")).toBe(stock);
      expect(b.timers.get("apt-daily-upgrade.timer")).toBe("enabled");
    }
  });
}

test("a box whose operator already turned updates on reads as configured outside System Tweaks", async () => {
  const b = box();
  writeFileSync(join(b.aptDir, "20auto-upgrades"), 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n');
  const state = await act(b, ["state"]);
  expect(state.updates.enabled).toBe(true);
  expect(state.updates.managed).toBe(false);
  expect(state.updates.outsideSource).toBe("20auto-upgrades");
  expect(state.settings.enabled).toBe(false);
  expect(dashboardView(state)).toContain("Configured outside System Tweaks in 20auto-upgrades");
});

test("root's lock keeps the protections that are on, on, and leaves the rest of the page as it was", async () => {
  const state = await act(box(), ["state"]);
  const open = dashboardView(state);
  const locked = dashboardView(state, Date.now(), "locked");
  const damaged = dashboardView(state, Date.now(), "damaged");
  const switchOf = (html: string, key: string) => html.match(new RegExp(`data-setting="${key}"[^>]*>`))![0];
  expect(open).not.toContain("clp-addons unlock system-tweaks");
  expect(locked).toContain("<code>clp-addons unlock system-tweaks</code>");
  // On by default: read-only under a lock.
  for (const key of ["confineFileManager", "blockVhostInjection", "panel"]) {
    expect(switchOf(open, key)).not.toContain("disabled");
    expect(switchOf(locked, key)).toContain("disabled");
    expect(switchOf(damaged, key)).toContain("disabled");
  }
  // Off by default: it can still be switched on.
  expect(switchOf(locked, "ssh")).not.toContain("disabled");
  expect(switchOf(damaged, "ssh")).not.toContain("disabled");
  expect(switchOf(locked, "enabled")).not.toContain("disabled");
  expect(damaged).toContain("Root's lock file cannot be trusted");
  expect(damaged).toContain("<code>clp-addons lock</code>");
});

test("Hardening's header offers Lock settings until root's lock is there, then shows it", async () => {
  const state = await act(box(), ["state"]);
  const header = (html: string) => html.slice(html.indexOf("<h2>Hardening</h2>"), html.indexOf("</div>", html.indexOf("<h2>Hardening</h2>")));
  const pageHeading = (html: string) => html.slice(html.indexOf('<div class="page-heading">'), html.indexOf('<div class="card">'));
  expect(header(dashboardView(state))).toContain('onclick="lockSettings(this)">Lock settings</button>');
  // The lock leaves the page's other settings alone, so it is not at the top of the page.
  expect(pageHeading(dashboardView(state))).not.toContain("lockSettings");
  for (const lock of ["locked", "damaged"] as const) {
    const html = dashboardView(state, Date.now(), lock);
    expect(html).not.toContain("lockSettings(this)");
    expect(header(html)).toContain(">Locked by root</span>");
    expect(pageHeading(html)).not.toContain("notice");
    expect(html.indexOf('class="notice st-lock-notice"')).toBeGreaterThan(html.indexOf("<h2>Hardening</h2>"));
  }
});

test("switching on writes only the drop-in, and switching off restores the operator's own setup", async () => {
  const b = box();
  const before = readFileSync(join(b.aptDir, "20auto-upgrades"), "utf8");
  let state = await act(b, ["set-updates"], { enabled: true });
  expect(existsSync(b.dropIn)).toBe(true);
  expect(state.updates.enabled).toBe(true);
  expect(state.updates.managed).toBe(true);
  expect(state.updates.coverage.find((row) => row.name === "CloudPanel PHP")!.covered).toBe("all");
  expect(state.updates.coverage.find((row) => row.name === "MySQL")!.covered).toBe("none");

  state = await act(b, ["set-updates"], { enabled: false });
  expect(existsSync(b.dropIn)).toBe(false);
  expect(state.updates.enabled).toBe(false);
  expect(readFileSync(join(b.aptDir, "20auto-upgrades"), "utf8")).toBe(before);
});

test("the first switch-on keeps the reboot policy the box already had", async () => {
  const b = box();
  writeFileSync(join(b.aptDir, "60reboot"), 'Unattended-Upgrade::Automatic-Reboot "true";\n');
  const state = await act(b, ["set-updates"], { enabled: true });
  expect(state.settings.reboot).toBe(true);
  expect(readFileSync(b.dropIn, "utf8")).toContain('Automatic-Reboot "true"');
});

test("a later operator file that turns updates off is named", async () => {
  const b = box();
  await act(b, ["set-updates"], { enabled: true });
  writeFileSync(join(b.aptDir, "99local"), 'APT::Periodic::Unattended-Upgrade "0";\n');
  const state = await act(b, ["state"]);
  expect(state.updates.managed).toBe(true);
  expect(state.updates.enabled).toBe(false);
  expect(state.updates.overriddenBy).toBe("99local");
});

test("timers that were off are enabled with the switch and disabled again without it", async () => {
  const b = box({ timers: { "apt-daily.timer": "enabled", "apt-daily-upgrade.timer": "disabled" } });
  await act(b, ["set-updates"], { enabled: true });
  expect(b.timers.get("apt-daily-upgrade.timer")).toBe("enabled");
  expect(JSON.parse(readFileSync(b.settingsFile, "utf8")).enabledTimers).toEqual(["apt-daily-upgrade.timer"]);
  await act(b, ["set-updates"], { enabled: false });
  expect(b.timers.get("apt-daily-upgrade.timer")).toBe("disabled");
  expect(b.timers.get("apt-daily.timer")).toBe("enabled");
});

test("a masked timer is refused before anything is written or enabled", async () => {
  const b = box({ timers: { "apt-daily.timer": "disabled", "apt-daily-upgrade.timer": "masked" } });
  await expect(act(b, ["set-updates"], { enabled: true })).rejects.toThrow("apt-daily-upgrade.timer is masked");
  expect(existsSync(b.dropIn)).toBe(false);
  expect(b.timers.get("apt-daily.timer")).toBe("disabled");
  expect((await act(b, ["state"])).settings.enabled).toBe(false);
});

test("a timer that cannot be enabled undoes the drop-in and the timers enabled before it", async () => {
  const b = box({
    timers: { "apt-daily.timer": "disabled", "apt-daily-upgrade.timer": "disabled" },
    failEnable: ["apt-daily-upgrade.timer"],
  });
  await expect(act(b, ["set-updates"], { enabled: true })).rejects.toThrow("apt-daily-upgrade.timer could not be enabled");
  expect(existsSync(b.dropIn)).toBe(false);
  expect(b.timers.get("apt-daily.timer")).toBe("disabled");
  expect(existsSync(b.settingsFile)).toBe(false);
});

test("a panel refusal puts a half-edited sites file back exactly, without reopening what was closed", async () => {
  const b = box();
  const half = CLOUDPANEL_NGINX_CONF.replace("    set_real_ip_from 0.0.0.0/0;\n", "    #clp-addons:untrusted set_real_ip_from 0.0.0.0/0;\n    set_real_ip_from ::/0;\n");
  writeFileSync(b.nginxConf, half);
  b.nginx.failPanel = true;
  await expect(act(b, ["set-real-ip"], { enabled: true })).rejects.toThrow("Nginx validation failed");
  expect(readFileSync(b.nginxConf, "utf8")).toBe(half);
});

test("a panel Nginx that rejects the change takes the sites' half back too", async () => {
  const b = box();
  b.nginx.failPanel = true;
  await expect(act(b, ["set-real-ip"], { enabled: true })).rejects.toThrow("Nginx validation failed");
  expect(readFileSync(b.nginxConf, "utf8")).toBe(CLOUDPANEL_NGINX_CONF);
  expect(readFileSync(b.panelConf, "utf8")).toBe(PANEL_NGINX_CONF);
});

test("an upgrade run gets the sites' conffile back unreloaded, and the panel's file keeps its edit", async () => {
  const b = box();
  restoreSystemTweaks(b.options);
  b.nginx.commands.length = 0;
  expect(releaseRealIp(b.options.realIp)).toBe(true);
  expect(releaseVisitorIp("nginxConf", b.options.visitorIp)).toBe(true);
  expect(readFileSync(b.nginxConf, "utf8")).toBe(CLOUDPANEL_NGINX_CONF);
  expect(readFileSync(b.panelConf, "utf8")).toContain("#clp-addons:untrusted");
  expect(b.nginx.commands).toEqual([]);
  expect(systemTweaksUpkeep(b.options)).toBe("visitor-IP trust narrowed again; Cloudflare visitor IPs reapplied");
  expect(readFileSync(b.nginxConf, "utf8")).toContain("#clp-addons:untrusted");
});

test("the gateway waits for the longest an install can take", async () => {
  const gatewayTimeouts: number[] = [];
  // Module mocks outlive the test in the same process, so the real client goes back after it.
  const realGateway = { ...(await import("../lib/gateway-client")) };
  mock.module("../lib/gateway-client", () => ({
    ...realGateway,
    callGatewayAction: async (_addon: string, _verb: string, _args: string[], _input?: string, options?: { timeout?: number }) => {
      gatewayTimeouts.push(options?.timeout ?? 60_000);
      return { ok: true };
    },
  }));
  const { systemTweaksService } = await import("../addons/system-tweaks/app/service");
  try {
    await systemTweaksService.installUpdates();
  } finally {
    mock.module("../lib/gateway-client", () => realGateway);
  }

  // Every command hangs until it is stopped, and the first install fails, so
  // the action takes the update and the retry too: as long as it ever can.
  const b = box({ installed: false });
  const base = b.options.updates!.run!;
  let clock = 0;
  let installs = 0;
  const hanging = (command: string, args: string[], env?: Record<string, string>, timeoutMs?: number): CommandResult => {
    clock += timeoutMs ?? (command === "apt-get" ? 280_000 : 30_000);
    if (command === "apt-get" && args[0] === "install" && installs++ === 0) return { ok: false, stdout: "", stderr: "404" };
    return base(command, args, env);
  };
  b.options = {
    ...b.options,
    now: () => clock,
    updates: { ...b.options.updates, run: hanging },
    uploadProgress: { ...b.options.uploadProgress, run: hanging },
  };
  await act(b, ["install-updates"]).catch(() => {});
  expect(clock).toBeGreaterThan(0);
  expect(clock).toBeLessThan(gatewayTimeouts[0]!);
});

/** The page's script against a stand-in DOM: each POST waits for `replies` to answer it. */
function systemTweaksClient() {
  // As the page has it: working() is shared, in TWEAK_ROW_JS.
  const source = TWEAK_ROW_JS + readFileSync(join(import.meta.dir, "../addons/system-tweaks/app/views.client.js"), "utf8");
  const events: string[] = [];
  const replies: { path: string; body: string; answer: (body: unknown) => void }[] = [];
  const lines: { textContent: string; removed: boolean }[] = [];
  const row = {
    querySelector: () => ({ after: (line: { textContent: string }) => events.push(`working: ${line.textContent}`) }),
  };
  const control = (label: string) => ({
    dataset: {} as Record<string, string>, type: "checkbox", checked: true, id: "",
    getAttribute: () => label, closest: (selector: string) => (selector === ".tweak-row" ? row : null),
  });
  const document = {
    createElement: () => {
      const line = { textContent: "", removed: false, className: "", innerHTML: "", setAttribute() {},
        append(text: string) { line.textContent += text; }, remove() { line.removed = true; } };
      lines.push(line);
      return line;
    },
  };
  const client = new Function("call", "busy", "notify", "clearNotice", "repaintView", "CLP_ROOT", "clpFlashTimer", "document", "location", "confirmAction",
    `${source}\nreturn { installUpdates, setUpdates, setPanelPhp, setSwitch, lockSettings };`)(
    (path: string, options: { body: string }) => new Promise((answer) => {
      events.push(`POST ${path} ${options.body}`);
      replies.push({ path, body: options.body, answer });
    }),
    (on: boolean) => events.push(on ? "busy" : "idle"),
    (message: string, kind: string) => events.push(`${kind}: ${message}`),
    () => {},
    (_holder: unknown, html: string) => events.push(`repaint: ${html}`),
    { getElementById: () => ({}), querySelector: () => null, querySelectorAll: () => [] },
    0,
    document,
    // The page is repainted from each reply; reloading it would lose the notice.
    { reload: () => events.push("reload") },
    async () => true,
  ) as Record<"installUpdates" | "setUpdates" | "setPanelPhp" | "lockSettings", (control: unknown) => Promise<void>> & { setSwitch: (control: unknown, name: string) => Promise<void> };
  return { client, control, events, replies, lines };
}

test("a change says it is running on its own row, and repaints the page from its reply", async () => {
  const { client, control, events, replies, lines } = systemTweaksClient();
  const pending = client.installUpdates(control("Install unattended-upgrades"));
  await Bun.sleep(0);
  expect(events).toEqual(["busy", "working: Installing unattended-upgrades…", 'POST /api/install-updates {}']);
  replies[0]!.answer({ ok: true, html: "<p>installed</p>" });
  await pending;
  expect(events.slice(3)).toEqual(["idle", "repaint: <p>installed</p>", "ok: unattended-upgrades is installed."]);
  expect(lines.every((line) => line.removed)).toBe(true);
});


test("every on/off switch on the page posts to a route that runs its verb", async () => {
  const names = [...dashboardView(await act(box(), ["state"])).matchAll(/setSwitch\(this, '([a-z-]+)'\)/g)].map((match) => match[1]!);
  expect(names).toContain("motd");
  expect(names.filter((name) => !isSwitchVerb(`set-${name}`))).toEqual([]);
  const { client, control, replies } = systemTweaksClient();
  const pending = client.setSwitch(control("Server info at SSH login"), "motd");
  await Bun.sleep(0);
  expect(replies[0]).toMatchObject({ path: "/api/motd", body: '{"enabled":true}' });
  replies[0]!.answer({ ok: true, html: "" });
  await pending;
});

// The header button is in no row, so its working line once had nowhere to go:
// the page froze with every control held and nothing posted.
test("Lock settings in Hardening's header posts and says it is running under the header", async () => {
  const { client, events, replies } = systemTweaksClient();
  const heading = { after: (line: { textContent: string }) => events.push(`heading: ${line.textContent}`) };
  const button = { dataset: {}, type: "button", closest: (selector: string) => (selector.includes(".card-header") ? heading : null) };
  const pending = client.lockSettings(button);
  await Bun.sleep(0);
  expect(events).toEqual(["busy", "heading: Switching everything on, then locking…", "POST /api/lock-settings {}"]);
  replies[0]!.answer({ ok: true, html: "<p>locked</p>" });
  await pending;
  expect(events.slice(3)).toEqual(["idle", "repaint: <p>locked</p>", "ok: Hardening and Failed logins are on and locked."]);
});

// Switching updates on and then the panel's PHP, before the first answered, let
// the first reply repaint the PHP picker back as if its change had stopped.
test("a second change waits for the first, so neither reply repaints over the other", async () => {
  const { client, control, events, replies } = systemTweaksClient();
  const updates = control("Install updates automatically");
  const php = { ...control("Panel PHP"), type: "select-one", value: "8.4", selectedIndex: 0, options: [{ textContent: "PHP 8.4" }] };
  const first = client.setUpdates({ ...updates, dataset: { setting: "enabled" } });
  const second = client.setPanelPhp(php);
  await Bun.sleep(0);
  expect(replies.map((reply) => reply.path)).toEqual(["/api/updates"]);
  replies[0]!.answer({ ok: true, html: "<p>updates on</p>" });
  await first;
  await Bun.sleep(0);
  expect(replies.map((reply) => reply.path)).toEqual(["/api/updates", "/api/panel-php"]);
  expect(events).toContain("working: Switching the panel to PHP 8.4…");
  replies[1]!.answer({ ok: true, html: "<p>php 8.4</p>" });
  await second;
  expect(events.filter((event) => event.startsWith("repaint") || event.startsWith("ok"))).toEqual([
    "repaint: <p>updates on</p>", "ok: Saved.", "repaint: <p>php 8.4</p>", "ok: The panel answers on PHP 8.4.",
  ]);
});

test("a missing package is reported, refused, and installed only when asked", async () => {
  const b = box({ installed: false });
  let state = await act(b, ["state"]);
  expect(state.updates.installed).toBe(false);
  expect(b.commands.some((command) => command.startsWith("apt-get"))).toBe(false);
  await expect(act(b, ["set-updates"], { enabled: true })).rejects.toThrow("not installed");
  state = await act(b, ["install-updates"]);
  expect(b.commands).toContain("apt-get install -y -o DPkg::Lock::Timeout=120 unattended-upgrades");
  expect(state.updates.installed).toBe(true);
  expect(state.updates.enabled).toBe(false);
});

test("the last run and a pending reboot are read from the log and the flag file", async () => {
  const b = box({
    log: [
      "2026-10-22 06:10:01,100 INFO Starting unattended upgrades script",
      "2026-10-22 06:10:05,100 INFO No packages found that can be upgraded unattended and no pending auto-removals",
      "2026-10-23 06:12:01,123 INFO Starting unattended upgrades script",
      "2026-10-23 06:12:03,000 INFO Packages that will be upgraded: php8.3-cli php8.3-fpm",
      "2026-10-23 06:12:40,000 INFO All upgrades installed",
    ].join("\n"),
  });
  writeFileSync(b.options.updates!.paths!.rebootRequired!, "");
  writeFileSync(`${b.options.updates!.paths!.rebootRequired!}.pkgs`, "linux-image-6.1.0-53-amd64\nlinux-image-6.1.0-53-amd64\n");
  const status = updatesStatus(b.options.updates);
  expect(status.lastRun).toEqual({ at: "2026-10-23 06:12:01", outcome: "upgraded", packages: ["php8.3-cli", "php8.3-fpm"], message: "" });
  expect(status.rebootRequired?.packages).toEqual(["linux-image-6.1.0-53-amd64"]);
});

test("disabling the addon withdraws the drop-in and enabling it again restores it", async () => {
  const b = box();
  await act(b, ["set-updates"], { enabled: true, database: true });
  withdrawSystemTweaks(b.options);
  expect(existsSync(b.dropIn)).toBe(false);
  restoreSystemTweaks(b.options);
  expect(readFileSync(b.dropIn, "utf8")).toContain("component=percona-*");
});

// --- X-Real-IP ---------------------------------------------------------------

test("forged visitor IPs are blocked by default and switching off restores CloudPanel's exact file", async () => {
  const b = box();
  expect((await act(b, ["state"])).realIp).toEqual({ blockForged: true, trustsAnyAddress: true, problem: "" });
  restoreSystemTweaks(b.options);
  const blocked = readFileSync(b.nginxConf, "utf8");
  expect(blocked).toContain("    #clp-addons:untrusted set_real_ip_from 0.0.0.0/0;\n");
  expect(blocked).toContain("    set_real_ip_from 10.0.0.0/8;\n");
  expect(blocked).toContain("    #clp-addons:hop set_real_ip_from 127.0.0.1;\n");
  expect(readFileSync(b.panelConf, "utf8")).toContain([
    "    #clp-addons:untrusted set_real_ip_from 0.0.0.0/0;",
    "    # clp-addons:cloudflare-proxies:start",
    "    set_real_ip_from 173.245.48.0/20;",
    "    set_real_ip_from 2400:cb00::/32;",
    "    # clp-addons:cloudflare-proxies:end",
    "    real_ip_header X-Forwarded-For;\n",
  ].join("\n"));
  expect(blocked).not.toContain("cloudflare-proxies");
  expect(b.nginx.commands).toEqual([
    "nginx -t", "systemctl reload nginx", `nginx -t -c ${b.panelConf}`, "systemctl reload clp-nginx",
  ]);
  expect((await act(b, ["state"])).realIp.trustsAnyAddress).toBe(false);

  const off = await act(b, ["set-real-ip"], { enabled: false });
  expect(off.realIp).toEqual({ blockForged: false, trustsAnyAddress: true, problem: "" });
  // Cloudflare visitor IPs keeps its own edit.
  expect(readFileSync(b.nginxConf, "utf8")).toBe(CLOUDPANEL_NGINX_CONF.replace("    set_real_ip_from 127.0.0.1;", "    #clp-addons:hop set_real_ip_from 127.0.0.1;"));
  expect(readFileSync(b.panelConf, "utf8")).toBe(PANEL_NGINX_CONF);
  b.nginx.commands.length = 0;
  expect(systemTweaksUpkeep(b.options)).toBeNull();
  expect(b.nginx.commands).toEqual([]);
});

test("repair narrows the trust again after CloudPanel rewrites nginx.conf, and disabling the addon puts it back", async () => {
  const b = box();
  await act(b, ["set-real-ip"], { enabled: true });
  await act(b, ["set-visitor-ip"], { enabled: false });
  writeFileSync(b.nginxConf, CLOUDPANEL_NGINX_CONF);
  expect(systemTweaksUpkeep(b.options)).toBe("visitor-IP trust narrowed again");
  expect(readFileSync(b.nginxConf, "utf8")).toContain("#clp-addons:untrusted set_real_ip_from 0.0.0.0/0;");
  withdrawSystemTweaks(b.options);
  expect(readFileSync(b.nginxConf, "utf8")).toBe(CLOUDPANEL_NGINX_CONF);
});

test("a map file clp-addons did not write fails its own upkeep step only, and enabling the addon only warns", () => {
  const b = box();
  restoreSystemTweaks(b.options);
  const maps = b.options.visitorIp!.paths!.maps!;
  writeFileSync(maps, "map $a $b {}\n");
  writeFileSync(b.nginxConf, CLOUDPANEL_NGINX_CONF);
  // The steps after it still run, and real-IP's line is reported beside the failure.
  expect(() => systemTweaksUpkeep(b.options)).toThrow(/^Cloudflare visitor IPs: .*did not write it.*; visitor-IP trust narrowed again/);
  expect(readFileSync(b.nginxConf, "utf8")).toContain("#clp-addons:untrusted set_real_ip_from 0.0.0.0/0;");
  expect(() => restoreSystemTweaks(b.options, true)).not.toThrow();
});

test("the panel follows CloudPanel's Cloudflare list, keeping only well-formed entries", async () => {
  const b = box();
  restoreSystemTweaks(b.options);
  writeFileSync(b.cloudflareIps, "allow 104.16.0.0/13;\nallow 999.1.1.1;\nallow 10.0.0.0/99;\ndeny all;\n");
  expect(systemTweaksUpkeep(b.options)).toBe("visitor-IP trust narrowed again; Cloudflare visitor IPs reapplied");
  const panel = readFileSync(b.panelConf, "utf8");
  expect(panel).toContain("    set_real_ip_from 104.16.0.0/13;\n");
  expect(panel).not.toContain("173.245.48.0/20");
  expect(panel).not.toContain("999.1.1.1");
  expect(panel).not.toContain("10.0.0.0/99");
  expect(panel.match(/cloudflare-proxies:start/g)).toHaveLength(1);
  expect((await act(b, ["state"])).realIp.trustsAnyAddress).toBe(false);
});

test("a change Nginx rejects leaves the file and the saved choice as they were", async () => {
  const b = box();
  b.nginx.fail = true;
  await expect(act(b, ["set-real-ip"], { enabled: true })).rejects.toThrow("Nginx validation failed");
  expect(readFileSync(b.nginxConf, "utf8")).toBe(CLOUDPANEL_NGINX_CONF);
  expect(existsSync(b.settingsFile)).toBe(false);
});

// --- phpMyAdmin --------------------------------------------------------------

test("phpMyAdmin is locked down by default, comes back after CloudPanel rewrites its vhost, and goes with the addon", async () => {
  const b = box();
  expect((await act(b, ["state"])).phpMyAdmin).toEqual({ enabled: true, active: false, problem: "" });
  restoreSystemTweaks(b.options);
  expect(readFileSync(b.panelVhost, "utf8")).toContain("# clp-addons:phpmyadmin:start");
  expect((await act(b, ["state"])).phpMyAdmin.active).toBe(true);
  writeFileSync(b.panelVhost, PANEL_VHOST);
  expect(systemTweaksPhpMyAdmin(b.options)).toBe("phpMyAdmin rules put back");
  expect(systemTweaksPhpMyAdmin(b.options)).toBeNull();
  withdrawSystemTweaks(b.options);
  expect(readFileSync(b.panelVhost, "utf8")).toBe(PANEL_VHOST);
});

test("switching phpMyAdmin's lockdown off restores the vhost and repair leaves it off", async () => {
  const b = box();
  await act(b, ["set-phpmyadmin"], { enabled: true });
  const off = await act(b, ["set-phpmyadmin"], { enabled: false });
  expect(off.phpMyAdmin).toEqual({ enabled: false, active: false, problem: "" });
  expect(readFileSync(b.panelVhost, "utf8")).toBe(PANEL_VHOST);
  expect(systemTweaksPhpMyAdmin(b.options)).toBeNull();
  expect(readFileSync(b.panelVhost, "utf8")).toBe(PANEL_VHOST);
});

// --- Panel certificate ---------------------------------------------------------

/** A stand-in for CloudPanel's shared pair, made fresh so no key is committed. */
function sharedPanelCert(b: Box): { cert: string; key: string } {
  const paths = b.options.panelCert!.paths!;
  const made = runCommand("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
    "-days", "30", "-subj", "/CN=cloudpanel.clp", "-keyout", paths.key!, "-out", paths.cert!]);
  if (!made.ok) throw new Error(made.stderr);
  writeFileSync(paths.vhost!, `server {\n  listen 8443 ssl;\n  ssl_certificate_key ${paths.key};\n  ssl_certificate ${paths.cert};\n  set $basicAuth "off";\n  if (-f /home/clp/services/nginx/basic-auth/credentials) {\n    set $basicAuth "on";\n  }\n  if ($request_uri ~ ^/phpmyadmin) {\n    set $basicAuth "off";\n  }\n  auth_basic $basicAuth;\n  auth_basic_user_file /home/clp/services/nginx/basic-auth/credentials;\n}\n`);
  const cert = readFileSync(paths.cert!, "utf8");
  b.options.panelCert!.sharedFingerprint = new X509Certificate(cert).fingerprint256;
  return { cert, key: readFileSync(paths.key!, "utf8") };
}

test("the shared panel certificate is replaced on activation and repair, and off stops only that", async () => {
  const b = box();
  const shared = sharedPanelCert(b);
  const certFile = b.options.panelCert!.paths!.cert!;
  expect((await act(b, ["state"])).panelCert).toMatchObject({ kind: "shared", replace: true });
  restoreSystemTweaks(b.options);
  expect((await act(b, ["state"])).panelCert).toMatchObject({ kind: "generated", replace: true, names: ["panel", "203.0.113.10"] });
  const generated = readFileSync(certFile, "utf8");

  writeFileSync(certFile, shared.cert);
  writeFileSync(b.options.panelCert!.paths!.key!, shared.key);
  expect(await systemTweaksMaintenance(b.options)).toContain("panel's shared certificate replaced");
  expect(readFileSync(certFile, "utf8")).toBe(generated);

  // Neither switching off nor disabling puts the published key back.
  const off = await act(b, ["set-panel-cert"], { enabled: false });
  expect(off.panelCert).toMatchObject({ kind: "generated", replace: false });
  withdrawSystemTweaks(b.options);
  expect(readFileSync(certFile, "utf8")).toBe(generated);
  writeFileSync(certFile, shared.cert);
  writeFileSync(b.options.panelCert!.paths!.key!, shared.key);
  expect(await systemTweaksMaintenance(b.options) ?? "").not.toContain("certificate");
  expect(readFileSync(certFile, "utf8")).toBe(shared.cert);

  // Withdrawn, a change from the panel is refused, even one that waited on the settings lock; enabling again clears that.
  await expect(act(b, ["set-panel-cert"], { enabled: true })).rejects.toThrow("System Tweaks is disabled");
  expect(readFileSync(certFile, "utf8")).toBe(shared.cert);
  restoreSystemTweaks(b.options, true);
  expect((await act(b, ["set-panel-cert"], { enabled: true })).panelCert).toMatchObject({ kind: "generated", replace: true });
  expect(readFileSync(certFile, "utf8")).toBe(generated);
});

test("a panel certificate Nginx rejects keeps the switch where it was", async () => {
  const b = box();
  const shared = sharedPanelCert(b);
  await act(b, ["set-panel-cert"], { enabled: false });
  b.options.panelCert!.run = (command, args) => command === "openssl" ? runCommand(command, args)
    : { ok: command !== "nginx", stdout: "", stderr: "emerg" };
  await expect(act(b, ["set-panel-cert"], { enabled: true })).rejects.toThrow("Nginx validation failed");
  expect(readFileSync(b.options.panelCert!.paths!.cert!, "utf8")).toBe(shared.cert);
  expect(readSettings({ settingsFile: b.settingsFile, lockFile: "", rootUid: process.getuid!() }).replacePanelCert).toBe(false);
});

// --- Vhost injection guard ----------------------------------------------------

test("the vhost guard is on by default: repair installs it and reloads the panel's FPM once", async () => {
  const b = box();
  expect((await act(b, ["state"])).vhostGuard).toMatchObject({ enabled: true, active: false });
  restoreSystemTweaks(b.options);
  expect(b.fpm.commands).toEqual(["systemctl start --no-block clp-addons-reconcile.service"]);
  expect(existsSync(b.vhostGuardPaths.pool)).toBe(false);

  b.fpm.commands.length = 0;
  expect(await systemTweaksMaintenance(b.options)).toContain("vhost guard put back");
  expect(readFileSync(b.vhostGuardPaths.pool, "utf8")).toBe([
    "; Managed by clp-addons System Tweaks: checks panel input before CloudPanel writes it into a vhost.",
    "[clp]",
    `php_admin_value[auto_prepend_file] = ${b.vhostGuardPaths.script}`,
    "",
  ].join("\n"));
  expect(readFileSync(b.vhostGuardPaths.script, "utf8")).toStartWith("<?php\n// Managed by clp-addons System Tweaks");
  expect(b.fpm.commands.slice(1)).toEqual([
    `${b.options.vhostGuard!.paths!.script!.replace(/clp\/clp-addons-vhost-guard.php$/, "sbin/php-fpm8.3")} -t -R -F -y ${b.vhostGuardPaths.pool.replace(/pool.d\/.*$/, "php-fpm.conf")} -c ${b.vhostGuardPaths.pool.replace(/pool.d\/.*$/, "php.ini")}`,
    "systemctl reload clp-php-fpm.service",
  ]);
  expect((await act(b, ["state"])).vhostGuard).toMatchObject({ enabled: true, active: true });

  b.fpm.commands.length = 0;
  expect(await systemTweaksMaintenance(b.options) ?? "").not.toContain("vhost guard");
  expect(b.fpm.commands).toEqual([]);
});

test("repair reloads after rewriting a changed script or a missing pool file, and when the files are right but not loaded", async () => {
  const b = box();
  await act(b, ["set-vhost-guard"], { enabled: true });
  for (const drift of [
    () => writeFileSync(b.vhostGuardPaths.script, "<?php\n"),
    () => rmSync(b.vhostGuardPaths.pool),
    // An install killed between writing the files and reloading.
    () => { b.fpm.loaded = false; },
  ]) {
    drift();
    b.fpm.commands.length = 0;
    expect(await systemTweaksMaintenance(b.options)).toContain("vhost guard put back");
    expect(b.fpm.commands.at(-1)).toBe("systemctl reload clp-php-fpm.service");
    expect(b.fpm.loaded).toBe(true);
  }
});

test("a pool file PHP-FPM rejects, or a panel that stops answering, is removed again", async () => {
  for (const fault of ["config", "health"] as const) {
    const b = box();
    if (fault === "config") b.fpm.failTest = true;
    else b.fpm.status = 500;
    await expect(act(b, ["set-vhost-guard"], { enabled: true })).rejects.toThrow(
      fault === "config" ? "the panel's PHP-FPM rejected its config: ERROR: bad pool; it was removed again"
        : "the panel did not come back with the vhost guard: the login page answered 500; it was removed again");
    expect(existsSync(b.vhostGuardPaths.pool)).toBe(false);
    expect(b.fpm.commands.at(-1)).toBe("systemctl reload clp-php-fpm.service");
    expect(existsSync(b.settingsFile)).toBe(false);
  }
});

test("a repair that fails puts back its own files, which the running FPM may still use, and nothing else", async () => {
  const b = box();
  await act(b, ["set-vhost-guard"], { enabled: true });
  const pool = readFileSync(b.vhostGuardPaths.pool, "utf8");
  // CloudPanel's update chowns /home/clp, which repair reads as untrusted.
  chmodSync(b.vhostGuardPaths.pool, 0o664);
  writeFileSync(b.vhostGuardPaths.script, "<?php // an earlier release\n");
  b.fpm.failTest = true;
  await expect(systemTweaksMaintenance(b.options)).rejects.toThrow("the previous files were put back");
  expect(readFileSync(b.vhostGuardPaths.pool, "utf8")).toBe(pool);
  expect(readFileSync(b.vhostGuardPaths.script, "utf8")).toBe("<?php // an earlier release\n");

  // A pool file that is not ours is not kept.
  writeFileSync(b.vhostGuardPaths.pool, "[clp]\nphp_admin_value[auto_prepend_file] = /elsewhere.php\n");
  await expect(systemTweaksMaintenance(b.options)).rejects.toThrow("it was removed again");
  expect(existsSync(b.vhostGuardPaths.pool)).toBe(false);
});

test("switching the vhost guard off removes both files and repair leaves it off; disabling the addon removes it too", async () => {
  const b = box();
  await act(b, ["set-vhost-guard"], { enabled: true });
  const off = await act(b, ["set-vhost-guard"], { enabled: false });
  expect(off.vhostGuard).toMatchObject({ enabled: false, active: false });
  expect(existsSync(b.vhostGuardPaths.pool)).toBe(false);
  expect(existsSync(b.vhostGuardPaths.script)).toBe(false);
  expect(await systemTweaksMaintenance(b.options) ?? "").not.toContain("vhost guard");
  expect(existsSync(b.vhostGuardPaths.pool)).toBe(false);

  await act(b, ["set-vhost-guard"], { enabled: true });
  withdrawSystemTweaks(b.options);
  expect(existsSync(b.vhostGuardPaths.pool)).toBe(false);
  expect(existsSync(b.vhostGuardPaths.script)).toBe(false);
});

test("the page says the guard is on only while the running pool refuses, and removal reloads even when the pool file has gone", async () => {
  const b = box();
  await act(b, ["set-vhost-guard"], { enabled: true });
  b.fpm.loaded = false;
  expect((await act(b, ["state"])).vhostGuard).toMatchObject({ enabled: true, active: false });
  b.fpm.loaded = true;
  rmSync(b.vhostGuardPaths.pool);
  b.fpm.commands.length = 0;
  withdrawSystemTweaks(b.options);
  expect(b.fpm.commands.at(-1)).toBe("systemctl reload clp-php-fpm.service");
  expect(existsSync(b.vhostGuardPaths.script)).toBe(false);
});

test("a reload that fails while removing the guard puts the pool file back and keeps the script", async () => {
  const b = box();
  await act(b, ["set-vhost-guard"], { enabled: true });
  b.fpm.failTest = true;
  await expect(act(b, ["set-vhost-guard"], { enabled: false })).rejects.toThrow("rejected its config");
  expect(existsSync(b.vhostGuardPaths.pool)).toBe(true);
  expect(existsSync(b.vhostGuardPaths.script)).toBe(true);
  expect((await act(b, ["state"])).vhostGuard).toMatchObject({ enabled: true, active: true });
});

test("Varnish backends that cannot be removed put the guard back, since the setting stays on", async () => {
  const b = box();
  await act(b, ["set-vhost-guard"], { enabled: true });
  b.varnish.failDaemonReload = true;
  await expect(act(b, ["set-vhost-guard"], { enabled: false })).rejects.toThrow("daemon-reload failed");
  expect(existsSync(b.vhostGuardPaths.pool)).toBe(true);
  expect(existsSync(b.vhostGuardPaths.script)).toBe(true);
  expect(readSettings({ settingsFile: b.settingsFile, lockFile: "", rootUid: process.getuid!() }).blockVhostInjection).toBe(true);
});

test("both guards install as one file each, with the shared session reader in place of its include", async () => {
  const b = box();
  await systemTweaksMaintenance(b.options);
  for (const path of [b.vhostGuardPaths.script, b.fileManagerGuardPaths.script]) {
    const text = readFileSync(path, "utf8");
    expect(text).not.toContain("panel-session.php");
    // One file: nothing beside it left to include, and the cookie is read in place.
    expect(text).not.toMatch(/\b(require|include)(_once)?\s*\(?\s*__DIR__/);
    expect(text).toContain("$_COOKIE['cloudpanel']");
  }
});

// --- File Manager guard -------------------------------------------------------

const socketMode = (b: Box) => lstatSync(b.fileManagerGuardPaths.socket).mode & 0o777;

test("the File Manager guard is on by default: repair installs it, leaves the socket to clp, and then has nothing to do", async () => {
  const b = box();
  expect((await act(b, ["state"])).fileManagerGuard).toEqual({ enabled: true, active: false });
  restoreSystemTweaks(b.options);
  expect(b.fm.commands).toEqual(["systemctl start --no-block clp-addons-reconcile.service"]);

  b.fm.commands.length = 0;
  expect(await systemTweaksMaintenance(b.options)).toContain("File Manager guard put back");
  expect(readFileSync(b.fileManagerGuardPaths.pool, "utf8")).toBe([
    "; Managed by clp-addons System Tweaks: keeps the File Manager in the site's home, and its socket to clp.",
    "[clp-file-manager]",
    `php_admin_value[auto_prepend_file] = ${b.fileManagerGuardPaths.script}`,
    "listen.owner = clp",
    "listen.mode = 0600",
    "",
  ].join("\n"));
  expect(readFileSync(b.fileManagerGuardPaths.script, "utf8")).toStartWith("<?php\n// Managed by clp-addons System Tweaks");
  expect(b.fm.commands.at(-1)).toBe("systemctl reload clp-php-fpm.service");
  expect(socketMode(b)).toBe(0o600);
  expect((await act(b, ["state"])).fileManagerGuard).toEqual({ enabled: true, active: true });

  b.fm.commands.length = 0;
  expect(await systemTweaksMaintenance(b.options) ?? "").not.toContain("File Manager guard");
  expect(b.fm.commands).toEqual([]);

  // A socket FPM made again from CloudPanel's own pool file.
  chmodSync(b.fileManagerGuardPaths.socket, 0o660);
  expect((await act(b, ["state"])).fileManagerGuard).toEqual({ enabled: true, active: false });
  expect(await systemTweaksMaintenance(b.options)).toContain("File Manager guard put back");
  expect(socketMode(b)).toBe(0o600);
});

test("switching the File Manager guard off removes it and gives the socket back to group clp; the vhost guard stays", async () => {
  const b = box();
  await systemTweaksMaintenance(b.options);
  const off = await act(b, ["set-file-manager-guard"], { enabled: false });
  expect(off.fileManagerGuard).toEqual({ enabled: false, active: false });
  expect(off.vhostGuard).toMatchObject({ enabled: true, active: true });
  expect(existsSync(b.fileManagerGuardPaths.pool)).toBe(false);
  expect(existsSync(b.fileManagerGuardPaths.script)).toBe(false);
  expect(socketMode(b)).toBe(0o660);
  expect(await systemTweaksMaintenance(b.options) ?? "").not.toContain("File Manager guard");
  expect(existsSync(b.fileManagerGuardPaths.pool)).toBe(false);

  expect((await act(b, ["set-file-manager-guard"], { enabled: true })).fileManagerGuard).toEqual({ enabled: true, active: true });
  withdrawSystemTweaks(b.options);
  expect(existsSync(b.fileManagerGuardPaths.pool)).toBe(false);
  expect(socketMode(b)).toBe(0o660);
});

test("a File Manager guard the pool rejects, or that does not refuse, is removed again and the socket left as it was", async () => {
  for (const fault of ["config", "health"] as const) {
    const b = box();
    if (fault === "config") b.fm.failTest = true;
    else b.fm.status = 500;
    await expect(act(b, ["set-file-manager-guard"], { enabled: true })).rejects.toThrow(
      fault === "config" ? "the panel's PHP-FPM rejected its config: ERROR: bad pool; it was removed again"
        : "the panel did not come back with the File Manager guard: the File Manager answered 500; it was removed again");
    expect(existsSync(b.fileManagerGuardPaths.pool)).toBe(false);
    expect(socketMode(b)).toBe(0o660);
    expect(readSettings({ settingsFile: b.settingsFile, lockFile: "", rootUid: process.getuid!() }).confineFileManager).toBe(true);
  }
});

test("switching the File Manager guard off records the opt-out first, and a removal that fails puts the setting back on", async () => {
  const b = box();
  await act(b, ["set-file-manager-guard"], { enabled: true });
  const settingsDir = join(b.settingsFile, "..");
  const confined = () => readSettings({ settingsFile: b.settingsFile, lockFile: "", rootUid: process.getuid!() }).confineFileManager;

  // A save that fails leaves both the guard and the setting on.
  chmodSync(settingsDir, 0o500);
  try {
    await expect(act(b, ["set-file-manager-guard"], { enabled: false })).rejects.toThrow();
  } finally {
    chmodSync(settingsDir, 0o700);
  }
  expect(existsSync(b.fileManagerGuardPaths.pool)).toBe(true);
  expect(confined()).toBe(true);

  // A reload that fails keeps the guard, so the setting goes back to on.
  b.fm.failTest = true;
  await expect(act(b, ["set-file-manager-guard"], { enabled: false })).rejects.toThrow("rejected its config");
  expect(existsSync(b.fileManagerGuardPaths.pool)).toBe(true);
  expect(confined()).toBe(true);
});

test("a withdrawal that fails after the File Manager guard is gone starts repair, which puts it back unless it was switched off", async () => {
  for (const confine of [true, false]) {
    const b = box();
    await act(b, ["set-vhost-guard"], { enabled: true });
    await act(b, ["set-file-manager-guard"], { enabled: confine });
    b.varnish.failDaemonReload = true;
    expect(() => withdrawSystemTweaks(b.options)).toThrow("daemon-reload failed");
    expect(existsSync(b.fileManagerGuardPaths.pool)).toBe(false);
    expect(b.reconcile).toEqual(["systemctl start --no-block clp-addons-reconcile.service"]);
    await systemTweaksMaintenance(b.options).catch(() => null);
    expect(existsSync(b.fileManagerGuardPaths.pool)).toBe(confine);
  }
});

test("repair still re-applies later guards when MySQL cannot be inspected", () => {
  const b = box();
  const guardPaths = { wrapper: join(tempDir(), "clpctlWrapper"), backup: join(tempDir(), "clpctlWrapper.orig"), rootUid: process.getuid!() };
  b.options.clpctlGuard = { version: "2.5.4-3", paths: guardPaths };
  writeFileSync(guardPaths.wrapper, CLPCTL_ORIGINAL, { mode: 0o700 });
  mkdirSync(b.options.database!.paths!.confDirs![0]!, { recursive: true });
  mkdirSync(dirname(b.settingsFile), { recursive: true, mode: 0o700 });
  writeFileSync(b.settingsFile, JSON.stringify({ version: 1, databaseLoopback: true }), { mode: 0o600 });
  // The fixture's systemctl fails, as `systemctl show` does for a unit that is mid-restart.
  restoreSystemTweaks(b.options);
  expect(readFileSync(guardPaths.wrapper, "utf8")).toBe(WRAPPER_SCRIPT);
});

test("a withdrawal that fails after restoring the wrapper puts the hardened wrapper back", async () => {
  const b = box();
  const uid = process.getuid!();
  const guardPaths = { wrapper: join(tempDir(), "clpctlWrapper"), backup: join(tempDir(), "clpctlWrapper.orig"), rootUid: uid };
  b.options.clpctlGuard = { version: "2.5.4-3", paths: guardPaths };
  // Start with our hardened wrapper installed over a saved known original.
  writeFileSync(guardPaths.wrapper, WRAPPER_SCRIPT, { mode: 0o700 });
  writeFileSync(guardPaths.backup, CLPCTL_ORIGINAL, { mode: 0o700 });
  // Install the Varnish backends so their removal is what fails during withdrawal,
  // after the wrapper has already been restored.
  await act(b, ["set-vhost-guard"], { enabled: true });
  b.varnish.failDaemonReload = true;
  expect(() => withdrawSystemTweaks(b.options)).toThrow();
  // The wrapper is hardened again, not left as CloudPanel's vulnerable original.
  expect(readFileSync(guardPaths.wrapper, "utf8")).toBe(WRAPPER_SCRIPT);
  expect(readFileSync(guardPaths.backup, "utf8")).toBe(CLPCTL_ORIGINAL);
});

test("a withdrawal that fails at PHP pool isolation queues the guards back and puts the hardened wrapper back", async () => {
  const b = box();
  const guardPaths = { wrapper: join(tempDir(), "clpctlWrapper"), backup: join(tempDir(), "clpctlWrapper.orig"), rootUid: process.getuid!() };
  b.options.clpctlGuard = { version: "2.5.4-3", paths: guardPaths };
  writeFileSync(guardPaths.wrapper, WRAPPER_SCRIPT, { mode: 0o700 });
  writeFileSync(guardPaths.backup, CLPCTL_ORIGINAL, { mode: 0o700 });
  await act(b, ["set-vhost-guard"], { enabled: true });
  await act(b, ["set-php-pools"], { enabled: true });
  const run = b.options.phpPools!.run!;
  b.options.phpPools = { ...b.options.phpPools, run: (command, args) => command === "nft" && args[0] === "delete" ? { ok: false, stdout: "", stderr: "busy" } : run(command, args) };
  expect(() => withdrawSystemTweaks(b.options)).toThrow("nft could not remove the PHP pool rules");
  // Both guards were already removed, so repair runs now rather than at its next turn.
  expect(existsSync(b.vhostGuardPaths.pool)).toBe(false);
  expect(b.reconcile).toEqual(["systemctl start --no-block clp-addons-reconcile.service"]);
  expect(readFileSync(guardPaths.wrapper, "utf8")).toBe(WRAPPER_SCRIPT);
});

test("a withdrawal that fails at the login jails starts repair for the visitor-IP and phpMyAdmin rules it already removed", async () => {
  const b = box();
  await systemTweaksMaintenance(b.options).catch(() => null);
  expect(readFileSync(b.nginxConf, "utf8")).toContain("#clp-addons:untrusted");
  // fail2ban ran before System Tweaks, so withdrawing puts it back, which this fixture's systemctl refuses.
  mkdirSync(dirname(b.settingsFile), { recursive: true, mode: 0o700 });
  writeFileSync(b.settingsFile, JSON.stringify({ version: 1, fail2banBefore: { enabled: true, active: true } }), { mode: 0o600 });
  expect(() => withdrawSystemTweaks(b.options)).toThrow("systemctl restart fail2ban");
  expect(readFileSync(b.nginxConf, "utf8")).not.toContain("#clp-addons:untrusted");
  expect(b.reconcile).toEqual(["systemctl start --no-block clp-addons-reconcile.service"]);
  // The repair it starts narrows the trust again.
  await systemTweaksMaintenance(b.options).catch(() => null);
  expect(readFileSync(b.nginxConf, "utf8")).toContain("#clp-addons:untrusted");
});

test("repair keeps the timers it enables while it reconciles the login jails", async () => {
  const b = box();
  await act(b, ["set-updates"], { enabled: true });
  expect(JSON.parse(readFileSync(b.settingsFile, "utf8")).enabledTimers).toEqual([]);
  b.timers.set("apt-daily.timer", "disabled");
  systemTweaksUpkeep(b.options);
  expect(b.timers.get("apt-daily.timer")).toBe("enabled");
  expect(JSON.parse(readFileSync(b.settingsFile, "utf8")).enabledTimers).toEqual(["apt-daily.timer"]);
  // So switching updates off disables it again.
  await act(b, ["set-updates"], { enabled: false });
  expect(b.timers.get("apt-daily.timer")).toBe("disabled");
});

test("settings.json keeps its format and the state names its parts in a fixed order", async () => {
  const b = box();
  const state = await act(b, ["set-motd"], { enabled: false });
  const text = readFileSync(b.settingsFile, "utf8");
  const saved = JSON.parse(text);
  expect(text).toBe(`${JSON.stringify(saved, null, 2)}\n`);
  expect(Object.keys(saved)).toEqual([
    "version", "updates", "enabledTimers", "uploadProgressGuard", "blockForgedRealIp", "cloudflareVisitorIp", "blockVhostInjection", "isolatePhpPools",
    "protectPhpMyAdmin", "confineFileManager", "replacePanelCert", "loginJails", "fail2banBefore", "databaseLoopback",
    "blockClpctlInjection", "blockTelemetry", "serverInfoMotd", "backupCompression",
  ]);
  expect(saved).toMatchObject({
    version: 1, enabledTimers: [], uploadProgressGuard: true, loginJails: { panel: true, ssh: false }, fail2banBefore: null,
    databaseLoopback: false, serverInfoMotd: false, backupCompression: DEFAULT_BACKUP_COMPRESSION,
  });
  expect(Object.keys(state)).toEqual([
    "updates", "settings", "uploadProgress", "realIp", "visitorIp", "phpMyAdmin", "panelCert", "vhostGuard", "phpPools", "fileManagerGuard",
    "clpctlGuard", "panelPhp", "firewall", "loginJails", "database", "backupCompression", "telemetry", "motd",
  ]);
});

test("the page shows the vhost guard as on, waiting for repair, or off", () => {
  const html = (partial: Omit<SystemTweaksState["vhostGuard"], "homeLogs" | "ownLogrotate"> & { homeLogs?: string[]; ownLogrotate?: string[] }) => dashboardView({
    updates: updatesStatus({ run: () => ({ ok: false, stdout: "", stderr: "" }) }), settings: { ...DEFAULT_UPDATE_SETTINGS },
    uploadProgress: { guard: true, fpms: [] }, realIp: { blockForged: true, trustsAnyAddress: false, problem: "" }, visitorIp: { enabled: true, applied: true, problem: "" }, phpMyAdmin: { enabled: true, active: true, problem: "" }, vhostGuard: { homeLogs: [], ownLogrotate: [], ...partial }, phpPools: { enabled: true, active: true, problem: "" }, fileManagerGuard: { enabled: true, active: true }, panelCert: { kind: "generated" as const, replace: true }, backupCompression: { enabled: false, level: 3, threads: 1, active: false, supported: true, installed: true, problem: "" }, telemetry: { enabled: true, agent: true, blocked: true, problem: "" }, motd: { enabled: true, script: true, banner: false }, clpctlGuard: { error: "" }, panelPhp: { error: "" }, firewall: { error: "" }, loginJails: { error: "" }, database: { error: "" },
  });
  expect(html({ enabled: true, active: true, stored: [] })).toContain("Panel input is checked before CloudPanel writes it into a vhost.");
  expect(html({ enabled: true, active: false, stored: [] })).toContain("Not applied");
  expect(html({ enabled: false, active: false, stored: [] })).toContain("Any panel account with a site can write nginx config");
  const flagged = html({ enabled: true, active: true, stored: [{ domain: "shop.example.com", field: "Root Directory" }] });
  expect(flagged).toContain("These saved site settings would be refused now, so they may hold nginx directives: shop.example.com: Root Directory.");
  expect(html({ enabled: true, active: false, stored: [], homeLogs: ["shop.example.com"] }))
    .toContain("These sites' vhosts still write nginx logs in the site user's home, where that user can point them at any file: shop.example.com.");
  expect(html({ enabled: true, active: true, stored: { error: "panel database is not readable" } })).toContain("Stored site settings could not be checked: panel database is not readable");
});





test("PHP pool isolation switches from the page, repair puts it back, and the PHP-FPM hook follows the setting", async () => {
  const b = box();
  // On by default: repair loads it.
  await systemTweaksMaintenance(b.options).catch(() => null);
  expect(b.pools.loaded).toBe(true);
  const off = await act(b, ["set-php-pools"], { enabled: false });
  expect(off.phpPools).toEqual({ enabled: false, active: false, problem: "" });
  expect(b.pools.loaded).toBe(false);
  // A PHP-FPM reload while it is off loads nothing.
  expect(systemTweaksPhpPools(b.options)).toBe(false);
  expect(b.pools.loaded).toBe(false);
  const on = await act(b, ["set-php-pools"], { enabled: true });
  expect(on.phpPools).toEqual({ enabled: true, active: true, problem: "" });
  // After a reboot, the first PHP-FPM start loads it again.
  b.pools.loaded = false;
  expect(systemTweaksPhpPools(b.options)).toBe(true);
  expect(b.pools.loaded).toBe(true);
  withdrawSystemTweaks(b.options);
  expect(b.pools.loaded).toBe(false);
});

test("the page shows PHP pool isolation as on, waiting for repair, or off", () => {
  const html = (phpPools: SystemTweaksState["phpPools"]) => dashboardView({
    updates: updatesStatus({ run: () => ({ ok: false, stdout: "", stderr: "" }) }), settings: { ...DEFAULT_UPDATE_SETTINGS },
    uploadProgress: { guard: true, fpms: [] }, realIp: { blockForged: true, trustsAnyAddress: false, problem: "" }, visitorIp: { enabled: true, applied: true, problem: "" },
    phpMyAdmin: { enabled: true, active: true, problem: "" }, vhostGuard: { enabled: true, active: true, stored: [], homeLogs: [], ownLogrotate: [] }, phpPools, fileManagerGuard: { enabled: true, active: true }, panelCert: { kind: "generated" as const, replace: true }, backupCompression: { enabled: false, level: 3, threads: 1, active: false, supported: true, installed: true, problem: "" }, telemetry: { enabled: true, agent: true, blocked: true, problem: "" }, motd: { enabled: true, script: true, banner: false }, clpctlGuard: { error: "" }, panelPhp: { error: "" }, firewall: { error: "" }, loginJails: { error: "" }, database: { error: "" },
  });
  expect(html({ enabled: true, active: true, problem: "" })).toContain("Each pool's port answers only nginx and the pool's own user.");
  expect(html({ enabled: true, active: false, problem: "" })).toContain("Run clp-addons repair.");
  expect(html({ enabled: true, active: false, problem: "nft is not installed." })).toContain("nft is not installed.");
  expect(html({ enabled: false, active: false, problem: "" })).toContain("Any account on the server can run PHP as any site through its pool's port.");
});

test("CloudPanel telemetry is blocked by default, switches off and back, and goes with the addon", async () => {
  const b = box();
  await systemTweaksMaintenance(b.options).catch(() => null);
  expect(readFileSync(b.agentDropIn, "utf8")).toContain("IPAddressDeny=any\nIPAddressAllow=localhost\n");
  expect(b.agent.commands).toContain("systemctl try-restart clp-agent.service");
  // Nothing to do once systemd has loaded it.
  b.agent.commands.length = 0;
  await systemTweaksMaintenance(b.options).catch(() => null);
  expect(b.agent.commands.filter((command) => !command.includes(" show "))).toEqual([]);

  const off = await act(b, ["set-telemetry"], { enabled: false });
  expect(off.telemetry).toEqual({ enabled: false, agent: true, blocked: false, problem: "" });
  expect(existsSync(b.agentDropIn)).toBe(false);
  expect(b.agent.commands.at(-2)).toBe("systemctl try-restart clp-agent.service");
  await systemTweaksMaintenance(b.options).catch(() => null);
  expect(existsSync(b.agentDropIn)).toBe(false);

  const on = await act(b, ["set-telemetry"], { enabled: true });
  expect(on.telemetry).toEqual({ enabled: true, agent: true, blocked: true, problem: "" });
  withdrawSystemTweaks(b.options);
  expect(existsSync(b.agentDropIn)).toBe(false);
  restoreSystemTweaks(b.options);
  expect((await act(b, ["state"])).telemetry.blocked).toBe(true);
});

test("a drop-in systemd has not loaded is reloaded, and a box without clp-agent restarts nothing", async () => {
  const b = box();
  await act(b, ["set-telemetry"], { enabled: true });
  b.agent.loaded = false;
  expect((await act(b, ["state"])).telemetry).toEqual({ enabled: true, agent: true, blocked: false, problem: "" });
  b.agent.commands.length = 0;
  expect(await systemTweaksMaintenance(b.options).catch((error: Error) => error.message)).toContain("CloudPanel telemetry blocked again");
  expect(b.agent.commands).toContain("systemctl daemon-reload");

  const bare = box();
  bare.agent.installed = false;
  await act(bare, ["set-telemetry"], { enabled: true });
  expect(existsSync(bare.agentDropIn)).toBe(true);
  expect(bare.agent.commands.some((command) => command.includes("try-restart"))).toBe(false);
  expect((await act(bare, ["state"])).telemetry).toEqual({ enabled: true, agent: false, blocked: false, problem: "" });
});

test("a loaded block the kernel does not enforce is not called blocked, and one that cannot be removed does not stop deactivation", async () => {
  const b = box();
  await act(b, ["set-telemetry"], { enabled: true });
  b.agent.probe = "sent";
  const state = (await act(b, ["state"])).telemetry;
  expect(state.blocked).toBe(false);
  expect(state.problem).toContain("does not enforce IP filters");
  // A unit that never ran proves nothing, even when its error reads like the filter's.
  b.agent.probe = "unit-failed";
  expect((await act(b, ["state"])).telemetry).toMatchObject({ blocked: false, problem: expect.stringContaining("could not be checked") });
  // Refused inside and outside the filter: something else refuses it.
  b.agent.probe = "refused";
  b.agent.control = "refused";
  expect((await act(b, ["state"])).telemetry).toMatchObject({ blocked: false, problem: expect.stringContaining("also refuses the test send") });

  b.agent.control = "sent";
  b.options.telemetry!.run = (command, args) => args[0] === "daemon-reload" ? { ok: false, stdout: "", stderr: "Access denied" } : { ok: true, stdout: "", stderr: "" };
  expect(() => withdrawSystemTweaks(b.options)).not.toThrow();
  expect(b.pools.loaded).toBe(false);
});

test("the page shows telemetry as blocked, waiting for repair, sending, or without an agent", () => {
  const html = (telemetry: SystemTweaksState["telemetry"]) => dashboardView({
    updates: updatesStatus({ run: () => ({ ok: false, stdout: "", stderr: "" }) }), settings: { ...DEFAULT_UPDATE_SETTINGS },
    uploadProgress: { guard: true, fpms: [] }, realIp: { blockForged: true, trustsAnyAddress: false, problem: "" }, visitorIp: { enabled: true, applied: true, problem: "" },
    phpMyAdmin: { enabled: true, active: true, problem: "" }, vhostGuard: { enabled: true, active: true, stored: [], homeLogs: [], ownLogrotate: [] }, phpPools: { enabled: true, active: true, problem: "" }, fileManagerGuard: { enabled: true, active: true }, panelCert: { kind: "generated" as const, replace: true }, backupCompression: { enabled: false, level: 3, threads: 1, active: false, supported: true, installed: true, problem: "" }, telemetry, motd: { enabled: true, script: true, banner: false }, clpctlGuard: { error: "" }, panelPhp: { error: "" }, firewall: { error: "" }, loginJails: { error: "" }, database: { error: "" },
  });
  expect(html({ enabled: true, agent: true, blocked: true, problem: "" })).toContain("clp-agent can reach only this server.");
  expect(html({ enabled: true, agent: true, blocked: false, problem: "" })).toContain("Not applied");
  expect(html({ enabled: false, agent: true, blocked: false, problem: "" })).toContain("every panel user's name and email once a day");
  expect(html({ enabled: true, agent: false, blocked: false, problem: "" })).toContain("clp-agent is not installed here");
});

test("server info replaces CloudPanel's login banner by default, survives its upgrades, and goes with the addon", async () => {
  const b = box();
  const mode = (path: string) => lstatSync(path).mode & 0o777;
  await systemTweaksMaintenance(b.options).catch(() => null);
  expect(readFileSync(b.motdScript, "utf8")).toBe(MOTD_SCRIPT);
  expect(mode(b.motdScript)).toBe(0o755);
  expect(mode(b.motdBanner)).toBe(0o644);
  expect((await act(b, ["state"])).motd).toEqual({ enabled: true, script: true, banner: false });

  // A CloudPanel upgrade empties the directory and puts its banner back.
  rmSync(b.motdScript);
  chmodSync(b.motdBanner, 0o775);
  expect((await act(b, ["state"])).motd).toEqual({ enabled: true, script: false, banner: true });
  expect(systemTweaksMotd(b.options)).toBe("server info at SSH login put back");
  expect(systemTweaksMotd(b.options)).toBeNull();

  const off = await act(b, ["set-motd"], { enabled: false });
  expect(off.motd).toEqual({ enabled: false, script: false, banner: true });
  expect(mode(b.motdBanner)).toBe(0o775);
  expect(systemTweaksMotd(b.options)).toBeNull();
  expect(existsSync(b.motdScript)).toBe(false);

  await act(b, ["set-motd"], { enabled: true });
  withdrawSystemTweaks(b.options);
  expect(existsSync(b.motdScript)).toBe(false);
  expect(mode(b.motdBanner)).toBe(0o775);
  restoreSystemTweaks(b.options);
  expect((await act(b, ["state"])).motd).toEqual({ enabled: true, script: true, banner: false });
});

test("a server-info script that cannot be written leaves CloudPanel's banner on", () => {
  const b = box();
  // A directory in the script's place makes the write fail.
  mkdirSync(join(b.motdScript, "x"), { recursive: true });
  expect(() => applyMotd(true, b.options.motd)).toThrow();
  expect(statSync(b.motdBanner).mode & 0o777).toBe(0o775);
  expect(existsSync(b.options.motd!.paths!.marker!)).toBe(false);
});

test("switching server info off leaves a banner the operator turned off alone", () => {
  const b = box();
  chmodSync(b.motdBanner, 0o644);
  expect(applyMotd(true, b.options.motd)).toBe(true);
  expect(applyMotd(false, b.options.motd)).toBe(true);
  expect(existsSync(b.motdScript)).toBe(false);
  expect(lstatSync(b.motdBanner).mode & 0o777).toBe(0o644);
});

test("the server info script is valid sh", () => {
  expect(runCommand("sh", ["-n", "-c", MOTD_SCRIPT]).ok).toBe(true);
});

test("the page shows the login message as server info, waiting for repair, or CloudPanel's banner", () => {
  const html = (motd: SystemTweaksState["motd"]) => dashboardView({
    updates: updatesStatus({ run: () => ({ ok: false, stdout: "", stderr: "" }) }), settings: { ...DEFAULT_UPDATE_SETTINGS },
    uploadProgress: { guard: true, fpms: [] }, realIp: { blockForged: true, trustsAnyAddress: false, problem: "" }, visitorIp: { enabled: true, applied: true, problem: "" },
    phpMyAdmin: { enabled: true, active: true, problem: "" }, vhostGuard: { enabled: true, active: true, stored: [], homeLogs: [], ownLogrotate: [] }, phpPools: { enabled: true, active: true, problem: "" }, fileManagerGuard: { enabled: true, active: true }, panelCert: { kind: "generated" as const, replace: true }, backupCompression: { enabled: false, level: 3, threads: 1, active: false, supported: true, installed: true, problem: "" }, telemetry: { enabled: true, agent: true, blocked: true, problem: "" }, motd, clpctlGuard: { error: "" }, panelPhp: { error: "" }, firewall: { error: "" }, loginJails: { error: "" }, database: { error: "" },
  });
  expect(html({ enabled: true, script: true, banner: false })).toContain("SSH logins show this server's state.");
  expect(html({ enabled: true, script: true, banner: true })).toContain("Run clp-addons repair.");
  expect(html({ enabled: false, script: false, banner: true })).toContain("SSH logins show CloudPanel's banner.");
  expect(html({ enabled: false, script: false, banner: false })).toContain("chmod 775 /etc/update-motd.d/10-cloudpanel");
});

test("the page shows forged IPs as blocked, or as trusted and needing repair", async () => {
  const b = box();
  const state = await act(b, ["state"]);
  expect(dashboardView(state)).toContain("Any client can set its own IP with a header. Run clp-addons repair.");
  restoreSystemTweaks(b.options);
  expect(dashboardView(await act(b, ["state"]))).toContain("Only CloudPanel's own proxying and private-network proxies can set the visitor IP.");
});

// --- upload progress ----------------------------------------------------------

test("ini values are read the way PHP reads them", () => {
  expect(iniSetting("session.upload_progress.enabled = Off ; mitigated\n")).toBe("Off");
  expect(iniSetting('session.upload_progress.enabled="1"\n')).toBe("1");
  expect(iniSetting("[PATH=/var/www]\nsession.upload_progress.enabled = On\n")).toBeUndefined();
  expect(iniSetting("[PHP]\nsession.upload_progress.enabled = 0\n[Session]\nsession.upload_progress.enabled = yes\n")).toBe("yes");
  expect(["On", "1", "yes", "TRUE", "2"].map(iniBoolean)).toEqual([true, true, true, true, true]);
  expect(["Off", "0", "", "none", "false"].map(iniBoolean)).toEqual([false, false, false, false, false]);
});

test("each FPM's effective state says who set it, the panel's own FPM included", () => {
  const b = box();
  const conf = (version: string) => join(b.phpRoot, version, "fpm", "conf.d");
  writeFileSync(join(conf("8.1"), "99-clp-addons-upload-progress.ini"), "session.upload_progress.enabled = Off\n");
  writeFileSync(join(conf("8.1"), "30-custom.ini"), "session.upload_progress.enabled = Off\n");
  writeFileSync(join(conf("8.3"), "30-custom.ini"), "session.upload_progress.enabled = Off\n");
  // Sorted after the guard, so it wins.
  writeFileSync(join(conf("8.3"), "99-zz-local.ini"), "session.upload_progress.enabled = On\n");
  writeFileSync(join(b.phpRoot, "8.3", "fpm", "pool.d", "site.conf"), "[site]\nphp_admin_flag[session.upload_progress.enabled] = on\n");
  const rows = uploadProgressStatus(b.options.uploadProgress);
  expect(rows.map((row) => [row.label, row.enabled, row.setBy])).toEqual([
    ["PHP 8.1", false, "clp-addons"],
    ["PHP 8.3", true, "config"],
    ["CloudPanel (PHP 8.3)", true, "config"],
  ]);
  expect(rows[0]!.offWithoutGuard).toBe(true);
  expect(rows[1]!.source).toEndWith("99-zz-local.ini");
  expect(rows[1]!.poolsOn).toEqual(["site"]);
  expect(rows[2]!.poolsOn).toEqual([]);
});

test("with nothing set anywhere PHP's default leaves it on", () => {
  const b = box();
  expect(uploadProgressStatus(b.options.uploadProgress)[0]).toMatchObject({ enabled: true, setBy: "default", offWithoutGuard: false });
});

// --- guard continuity ---------------------------------------------------------

function guardFile(b: Box, version: string): string {
  return join(b.phpRoot, version, "fpm", "conf.d", "99-clp-addons-upload-progress.ini");
}

/** What the platform passes the guard: System Tweaks' switch counts while its config exists, as the catalog asks it. */
function platformGuard(b: Box): PhpGuardOptions {
  return { ...b.options.phpGuard, optedOut: existsSync(b.guardConfig) && systemTweaksPhpGuardOff(b.options) };
}

test("an existing installation keeps the guard without System Tweaks", () => {
  const b = box();
  rmSync(b.guardConfig);
  reconcilePhpGuard(true, true, platformGuard(b));
  expect(existsSync(guardFile(b, "8.1"))).toBe(true);
  // A stored opt-out counts for nothing while System Tweaks is not enabled.
  mkdirSync(join(b.settingsFile, ".."), { recursive: true });
  writeFileSync(b.settingsFile, JSON.stringify({ version: 1, uploadProgressGuard: false }), { mode: 0o600 });
  reconcilePhpGuard(true, true, platformGuard(b));
  expect(existsSync(guardFile(b, "8.3"))).toBe(true);
  expect(inspectPhpGuard(platformGuard(b)).optedOut).toBe(false);
});

test("opting out in System Tweaks removes the guard, and repair keeps it removed", async () => {
  const b = box();
  reconcilePhpGuard(true, true, platformGuard(b));
  writeFileSync(join(b.phpRoot, "8.3", "fpm", "conf.d", "30-custom.ini"), "session.upload_progress.enabled = Off\n");
  const state = await act(b, ["set-upload-guard"], { enabled: false });
  expect(state.uploadProgress.guard).toBe(false);
  expect(existsSync(guardFile(b, "8.1"))).toBe(false);
  expect(state.uploadProgress.fpms.map((row) => [row.label, row.enabled, row.setBy])).toEqual([
    ["PHP 8.1", true, "default"],
    ["PHP 8.3", false, "config"],
    ["CloudPanel (PHP 8.3)", false, "config"],
  ]);
  reconcilePhpGuard(true, true, platformGuard(b));
  expect(existsSync(guardFile(b, "8.1"))).toBe(false);
  expect(inspectPhpGuard(platformGuard(b)).optedOut).toBe(true);

  // Without System Tweaks' config the opt-out no longer counts.
  rmSync(b.guardConfig);
  reconcilePhpGuard(true, true, platformGuard(b));
  expect(existsSync(guardFile(b, "8.1"))).toBe(true);

  // Enabling it again honours the stored opt-out.
  writeFileSync(b.guardConfig, "");
  restoreSystemTweaks(b.options);
  expect(existsSync(guardFile(b, "8.1"))).toBe(false);
});

test("a guard change that fails to reload keeps the previous setting", async () => {
  const b = box();
  reconcilePhpGuard(true, true, b.options.phpGuard);
  b.options.phpGuard = { ...b.options.phpGuard, run: () => ({ ok: false, out: "bad config" }) };
  await expect(act(b, ["set-upload-guard"], { enabled: false })).rejects.toThrow("rejected the config");
  expect(existsSync(guardFile(b, "8.1"))).toBe(true);
  expect(JSON.parse(readFileSync(b.settingsFile, "utf8")).uploadProgressGuard).toBe(true);
});

test("actions refuse to run as anyone but root", async () => {
  const b = box();
  await expect(executeSystemTweaksAction(["state"], { ...b.options, processUid: 1000 })).rejects.toThrow("must run as root");
  await expect(act(b, ["state", "--extra"])).rejects.toThrow("unexpected argument");
});


test("failed downloads retain the package URL in expandable details and escape the log", () => {
  const b = box({ log: `2026-10-23 16:11:29,000 INFO Starting unattended upgrades script
2026-10-23 16:12:44,000 ERROR An error occurred: 404 Not Found [IP: 2001:db8::1 443]
2026-10-23 16:12:44,001 ERROR The URI https://packages.example.test/php8.2-bcmath.deb failed to download, aborting <script>
` });
  const updates = updatesStatus(b.options.updates);
  expect(updates.lastRun?.outcome).toBe("failed");
  expect(updates.lastRun?.message).toContain("php8.2-bcmath.deb");
  const html = dashboardView({ updates, settings: { ...DEFAULT_UPDATE_SETTINGS }, uploadProgress: { guard: true, fpms: [] }, realIp: { blockForged: true, trustsAnyAddress: false, problem: "" }, visitorIp: { enabled: true, applied: true, problem: "" }, phpMyAdmin: { enabled: true, active: true, problem: "" }, vhostGuard: { enabled: true, active: true, stored: [], homeLogs: [], ownLogrotate: [] }, phpPools: { enabled: true, active: true, problem: "" }, fileManagerGuard: { enabled: true, active: true }, panelCert: { kind: "generated" as const, replace: true }, backupCompression: { enabled: false, level: 3, threads: 1, active: false, supported: true, installed: true, problem: "" }, telemetry: { enabled: true, agent: true, blocked: true, problem: "" }, motd: { enabled: true, script: true, banner: false }, clpctlGuard: { error: "" }, panelPhp: { error: "" }, firewall: { error: "" }, loginJails: { error: "" }, database: { error: "" } });
  expect(html).toContain("A package download failed (HTTP 404).");
  expect(html).toContain('<details class="st-run-details"><summary>Failure details</summary>');
  expect(html).toContain("php8.2-bcmath.deb failed to download, aborting &lt;script&gt;");
  expect(html).not.toContain("<script>");
});

test("the first switch-on copies the box's reboot time, and switching off gives the outside policy back", async () => {
  const b = box();
  const outside = 'Unattended-Upgrade::Automatic-Reboot "true";\nUnattended-Upgrade::Automatic-Reboot-Time "04:15";\n';
  writeFileSync(join(b.aptDir, "50unattended-upgrades"), outside);
  let state = await act(b, ["set-updates"], { enabled: true });
  expect(state.settings).toMatchObject({ reboot: true, rebootTime: "04:15" });
  expect(readFileSync(b.dropIn, "utf8")).toContain('Unattended-Upgrade::Automatic-Reboot-Time "04:15";');
  for (const time of ["00:00", "03:30", "23:59", "now"]) {
    state = await act(b, ["set-updates"], { rebootTime: time });
    expect(state.settings.rebootTime).toBe(time);
    expect(state.updates.rebootTime).toBe(time);
    expect(JSON.parse(readFileSync(b.settingsFile, "utf8")).updates.rebootTime).toBe(time);
    expect(readFileSync(join(b.aptDir, "50unattended-upgrades"), "utf8")).toBe(outside);
  }
  await act(b, ["set-updates"], { rebootTime: "03:30" });
  withdrawSystemTweaks(b.options);
  expect(updatesStatus(b.options.updates).rebootTime).toBe("04:15");
  restoreSystemTweaks(b.options);
  expect(updatesStatus(b.options.updates).rebootTime).toBe("03:30");
  state = await act(b, ["set-updates"], { enabled: false });
  expect(state.updates.rebootTime).toBe("04:15");
  expect(b.commands.some(command => /shutdown|reboot/.test(command))).toBe(false);
});

test("a reboot time this cannot express starts as right after the run, and a later apt file still wins", async () => {
  const b = box();
  writeFileSync(join(b.aptDir, "40operator"), 'Unattended-Upgrade::Automatic-Reboot-Time "+15";\n');
  let state = await act(b, ["set-updates"], { enabled: true, reboot: true });
  expect(state.settings.rebootTime).toBe("now");
  writeFileSync(join(b.aptDir, "90operator"), 'Unattended-Upgrade::Automatic-Reboot-Time "+15";\n');
  state = await act(b, ["set-updates"], { rebootTime: "02:00" });
  expect(state.updates.rebootTime).toBe("+15");
  const html = dashboardView(state);
  expect(html).toContain("Another apt file sets it to 15 minutes after the run, and wins.");
  expect(html).toContain(`<span class="hint">${state.updates.timezone}</span>`);
});

test("invalid reboot times cannot change settings or inject apt directives", async () => {
  const b = box();
  await act(b, ["set-updates"], { enabled: true });
  const before = readFileSync(b.dropIn, "utf8");
  const settings = readFileSync(b.settingsFile, "utf8");
  for (const rebootTime of ["", null, "3:30", "24:00", "12:60", "+5", false, 330, '03:30";\nAPT::Periodic::Enable "0']) {
    await expect(act(b, ["set-updates"], { rebootTime })).rejects.toThrow("rebootTime must be");
    expect(readFileSync(b.dropIn, "utf8")).toBe(before);
    expect(readFileSync(b.settingsFile, "utf8")).toBe(settings);
  }
});

test("the reboot-time API validates input and returns replacement HTML from the action reply", async () => {
  const { handle } = await import("../addons/system-tweaks/app");
  const { systemTweaksService } = await import("../addons/system-tweaks/app/service");
  const b = box();
  const state = await act(b, ["set-updates"], { enabled: true, reboot: true, rebootTime: "03:30" });
  const original = systemTweaksService.setUpdates;
  const calls: unknown[] = [];
  systemTweaksService.setUpdates = async (body) => { calls.push(body); return { ok: true, data: state }; };
  const request = (rebootTime: unknown, csrf = true) => new Request("https://panel.example.com/addons/system-tweaks/api/updates", {
    method: "POST",
    headers: { Host: "panel.example.com", Origin: "https://panel.example.com", "Content-Type": "application/json",
      ...(csrf ? { Cookie: `clp_addons_csrf=${"a".repeat(64)}`, "X-CLP-Addons-CSRF": "a".repeat(64) } : {}) },
    body: JSON.stringify({ rebootTime }),
  });
  try {
    expect((await handle(request("03:30", false), "/api/updates")).status).toBe(403);
    expect((await handle(request("24:30"), "/api/updates")).status).toBe(400);
    expect((await handle(request(null), "/api/updates")).status).toBe(400);
    expect(calls).toEqual([]);
    for (const rebootTime of ["03:30", "now"]) {
      const response = await handle(request(rebootTime), "/api/updates");
      expect(response.status).toBe(200);
      expect((await response.json() as { html: string }).html).toBe(dashboardView(state));
    }
    expect(calls).toEqual([{ rebootTime: "03:30" }, { rebootTime: "now" }]);
  } finally { systemTweaksService.setUpdates = original; }
});



test("System Tweaks exposes panel PHP state and validates its change action", async () => {
  const b = box();
  const state = await act(b, ["state"]);
  expect(state.panelPhp).toMatchObject({ wanted: "", stock: null, choices: [] });
  await expect(act(b, ["set-panel-php"], { php: 8.4 })).rejects.toThrow("php must be a version");
  await expect(act(b, ["set-panel-php"], { php: "8.4" })).rejects.toThrow("is not the CloudPanel PHP-FPM unit");
  expect(dashboardView(state)).toContain("<h3>Panel PHP<button");
});

test("systemTweaksMaintenance still reconciles panel PHP when upkeep fails", async () => {
  const b = box();
  writeFileSync(b.nginxConf, CLOUDPANEL_NGINX_CONF);
  b.nginx.fail = true;
  writeFileSync(b.options.panelPhp!.paths!.stateFile!, JSON.stringify({ version: 1, php: "8.4" }), { mode: 0o600 });
  let phpCalled = false;
  b.options.panelPhp = {
    ...b.options.panelPhp,
    run: () => {
      phpCalled = true;
      return { ok: false, stdout: "", stderr: "no panel unit in this fixture" };
    },
  };
  await expect(systemTweaksMaintenance(b.options)).rejects.toThrow(
    "forged visitor IPs: Nginx validation failed: emerg; Cloudflare visitor IPs reapplied; panel PHP: clp-php-fpm.service is not the CloudPanel PHP-FPM unit this addon knows",
  );
  expect(phpCalled).toBe(true);
});



test("systemTweaksMaintenance reports a /tmp cleanup that cannot read CloudPanel's sites, and still runs the rest", async () => {
  const b = box();
  writeFileSync(b.nginxConf, CLOUDPANEL_NGINX_CONF);
  b.nginx.fail = true;
  b.options.tmpCleanup = { ...b.options.tmpCleanup, panelDb: join(b.aptDir, "missing", "db.sq3") };
  await expect(systemTweaksMaintenance(b.options)).rejects.toThrow(/^\/tmp cleanup: .+; forged visitor IPs: Nginx validation failed: emerg/);
});

test("the page shows update options only once updates are on, and says what silently goes uncovered", () => {
  const updates: UpdatesStatus = {
    installed: true, version: "2.9.1", distro: { id: "Debian", codename: "bookworm" }, managed: false, enabled: true,
    outsideSource: "20auto-upgrades", overriddenBy: "", listsUpdated: true, reboot: false, rebootTime: "", rebootWithUsers: true, timezone: "UTC",
    timer: { state: "enabled", next: "" },
    coverage: [
      { name: "CloudPanel PHP", detail: "8.3", covered: "none" }, { name: "Debian bookworm-security", detail: "main", covered: "all" },
      { name: "Debian bookworm", detail: "main, contrib", covered: "some" },
    ],
    lastRun: null, rebootRequired: { since: "2026-10-01T00:00:00Z", packages: ["linux-image-6.1.0-53-amd64"] },
  };
  const state = {
    updates, settings: { ...DEFAULT_UPDATE_SETTINGS },
    uploadProgress: { guard: true, fpms: [{
      label: "PHP 8.2", version: "8.2", enabled: false, setBy: "clp-addons" as const,
      source: "/etc/php/8.2/fpm/conf.d/99-clp-addons-upload-progress.ini", offWithoutGuard: false, poolsOn: ["legacy.example.com"],
    }] }, realIp: { blockForged: true, trustsAnyAddress: false, problem: "" }, visitorIp: { enabled: true, applied: true, problem: "" }, phpMyAdmin: { enabled: true, active: true, problem: "" }, vhostGuard: { enabled: true, active: true, stored: [], homeLogs: [], ownLogrotate: [] }, phpPools: { enabled: true, active: true, problem: "" }, fileManagerGuard: { enabled: true, active: true }, panelCert: { kind: "generated" as const, replace: true }, backupCompression: { enabled: false, level: 3, threads: 1, active: false, supported: true, installed: true, problem: "" }, telemetry: { enabled: true, agent: true, blocked: true, problem: "" }, motd: { enabled: true, script: true, banner: false }, clpctlGuard: { error: "" }, panelPhp: { error: "" }, firewall: { error: "" }, loginJails: { error: "" }, database: { error: "" },
  };
  const now = Date.parse("2026-10-25T00:00:00Z");
  const outside = dashboardView(state, now);
  expect(outside).not.toContain('data-setting="nginx"');
  expect(outside).toContain("Switch on Install updates automatically to also get CloudPanel's PHP security updates.");
  expect(outside).not.toContain("skip CloudPanel's PHP");
  // Partly covered is not covered, and a pool that turns upload progress back on is not Off.
  expect(outside).toContain("Repositories: 1 of 3 covered, 1 partly");
  expect(outside).toContain('<span class="badge tone-warn">Partly</span>');
  expect(outside).toContain("Off on its one PHP-FPM, on again in 1 pool");
  expect(outside).toContain("A reboot has been needed since 2026-10-01 and automatic reboot is off, so the server still runs the old kernel.");
  expect(dashboardView(state, Date.parse("2026-10-03T00:00:00Z"))).not.toContain("A reboot has been needed");

  const managed = dashboardView({
    ...state,
    settings: { ...DEFAULT_UPDATE_SETTINGS, enabled: true, reboot: true },
    updates: { ...updates, managed: true, reboot: true, coverage: updates.coverage.map((row) => ({ ...row, covered: "all" as const })) },
  }, now);
  expect(managed).toContain('data-setting="nginx"');
  expect(managed).toContain('<option value="now" selected>Right after the update run</option>');
  expect(managed).not.toContain("skip CloudPanel's PHP");
  expect(managed).not.toContain("A reboot has been needed");
  expect(outside).not.toContain("Automatic reboot is on");
  expect(managed).toContain("Automatic reboot is on: the next update run restarts the server.");

  // A required reboot says when the box restarts by itself.
  const rebootAt = (rebootTime: string, next = "Sat 2026-10-24 06:32:16 UTC") => dashboardView({
    ...state,
    settings: { ...DEFAULT_UPDATE_SETTINGS, enabled: true, reboot: true },
    updates: { ...updates, managed: true, reboot: true, rebootTime, timezone: "Europe/Berlin", timer: { state: "enabled", next } },
  }, now);
  expect(rebootAt("04:00")).toContain(
    "Automatic reboot is on: the next update run (Sat 2026-10-24 06:32:16 UTC) schedules a restart for 04:00 Europe/Berlin.");
  expect(rebootAt("+15", "")).toContain("Automatic reboot is on: the server restarts 15 minutes after the next update run.");
  expect(rebootAt("04:00")).not.toContain("logged in");
  // apt can be told to skip the reboot while someone is logged in.
  expect(dashboardView({
    ...state,
    settings: { ...DEFAULT_UPDATE_SETTINGS, enabled: true, reboot: true },
    updates: { ...updates, managed: true, reboot: true, rebootTime: "now", rebootWithUsers: false },
  }, now)).toContain("restarts the server. It is skipped while anyone is logged in.");
});

test("the page names the UDP ports CloudPanel's Firewall page opens, in one line", () => {
  const b = box();
  const base = {
    updates: updatesStatus(b.options.updates), settings: { ...DEFAULT_UPDATE_SETTINGS }, uploadProgress: { guard: true, fpms: [] },
    realIp: { blockForged: true, trustsAnyAddress: false, problem: "" }, visitorIp: { enabled: true, applied: true, problem: "" }, phpMyAdmin: { enabled: true, active: true, problem: "" }, vhostGuard: { enabled: true, active: true, stored: [], homeLogs: [], ownLogrotate: [] }, phpPools: { enabled: true, active: true, problem: "" }, fileManagerGuard: { enabled: true, active: true }, panelCert: { kind: "generated" as const, replace: true }, backupCompression: { enabled: false, level: 3, threads: 1, active: false, supported: true, installed: true, problem: "" }, telemetry: { enabled: true, agent: true, blocked: true, problem: "" }, motd: { enabled: true, script: true, banner: false }, clpctlGuard: { error: "" }, panelPhp: { error: "" }, loginJails: { error: "" }, database: { error: "" } as const,
  };
  const open = dashboardView({ ...base, firewall: { available: true, protocols: { 5: "udp" }, udpPorts: ["53", "3478-3479"] } });
  expect(open).toContain(`<br>UDP ports open from CloudPanel's <a href="/admin/firewall">Firewall</a> page: 53, 3478-3479.</p>`);
  expect(dashboardView({ ...base, firewall: { available: true, protocols: {}, udpPorts: [] } })).toContain("can open UDP ports too");
  expect(dashboardView({ ...base, firewall: { available: false, protocols: {}, udpPorts: [] } })).not.toContain("/admin/firewall");
  expect(dashboardView({ ...base, firewall: { error: "no" } })).not.toContain("/admin/firewall");
});

test("set-login-jails stores the jails, and without fail2ban the page offers to install it", async () => {
  const b = box();
  expect(readSettings(b.options.paths as never).loginJails).toEqual({ panel: true, ssh: false });
  await expect(act(b, ["set-login-jails"], {})).rejects.toThrow("no jail was named");
  await expect(act(b, ["set-login-jails"], { ssh: "yes" })).rejects.toThrow("ssh must be true or false");
  const state = await act(b, ["set-login-jails"], { ssh: true });
  expect(state.loginJails).toMatchObject({ panel: true, ssh: true, missing: ["fail2ban", "python3-systemd", "nftables"], running: [] });
  expect(JSON.parse(readFileSync(b.settingsFile, "utf8"))).toMatchObject({ loginJails: { panel: true, ssh: true }, fail2banBefore: null });
  const html = dashboardView(state);
  expect(html).toContain("Install fail2ban");
  expect(html).toContain("fail2ban, python3-systemd, nftables are not installed.");
});

test("the Failed logins card lists bans with an Unblock each, and warns about what sshd accepts", () => {
  const b = box();
  const base = {
    updates: updatesStatus(b.options.updates), settings: { ...DEFAULT_UPDATE_SETTINGS }, uploadProgress: { guard: true, fpms: [] },
    realIp: { blockForged: true, trustsAnyAddress: false, problem: "" }, visitorIp: { enabled: true, applied: true, problem: "" }, phpMyAdmin: { enabled: true, active: true, problem: "" }, vhostGuard: { enabled: true, active: true, stored: [], homeLogs: [], ownLogrotate: [] }, phpPools: { enabled: true, active: true, problem: "" }, fileManagerGuard: { enabled: true, active: true }, panelCert: { kind: "generated" as const, replace: true }, backupCompression: { enabled: false, level: 3, threads: 1, active: false, supported: true, installed: true, problem: "" }, telemetry: { enabled: true, agent: true, blocked: true, problem: "" }, motd: { enabled: true, script: true, banner: false }, clpctlGuard: { error: "" }, panelPhp: { error: "" }, firewall: { error: "" }, database: { error: "" },
  };
  const jails = {
    panel: true, ssh: false, missing: [], service: "active" as const, running: ["clp-addons-panel", "clp-addons-domain"], panelLog: true, problem: "",
    customDomain: null as { name: string; logged: boolean; supported: boolean } | null,
    bans: [{ jail: "clp-addons-panel", ip: "203.0.113.7", until: "2026-11-04 12:18:24" }],
    sshd: { password: true, rootLogin: "yes" },
  };
  const html = dashboardView({ ...base, loginJails: jails });
  expect(html).toContain(`data-jail="clp-addons-panel" data-ip="203.0.113.7" onclick="unban(this)">Unblock</button>`);
  expect(html).toContain("Panel, until 2026-11-04 12:18:24");
  expect(html).toContain(`<details class="st-fold" id="st-bans">`);
  expect(html).toContain("SSH accepts passwords, and root can log in with a password.");
  expect(html).toContain("fail2ban is watching.");
  const quiet = dashboardView({ ...base, loginJails: { ...jails, bans: [], sshd: { password: false, rootLogin: "prohibit-password" } } });
  expect(quiet).toContain("Blocked addresses: none");
  expect(quiet).not.toContain("SSH accepts");
  expect(dashboardView({ ...base, loginJails: { ...jails, panelLog: null } })).toContain("no separate panel nginx");
  const domain = (customDomain: typeof jails.customDomain) => dashboardView({ ...base, loginJails: { ...jails, customDomain } });
  expect(domain({ name: "cp.example.com", logged: true, supported: true })).toContain("Logins through cp.example.com count too. A block for those covers HTTPS on port 443 for every site");
  expect(domain({ name: "cp.example.com", logged: false, supported: true })).toContain("Logins through cp.example.com are not counted yet. Run clp-addons repair.");
  expect(domain({ name: "cp.example.com", logged: false, supported: false })).toContain("more than one server block");
  expect(dashboardView({ ...base, loginJails: { ...jails, panelLog: false } })).toContain("Not running</span> <span>Run clp-addons repair.");
  expect(dashboardView({ ...base, loginJails: { ...jails, problem: "refusing /x: it is a symlink" } })).toContain("refusing /x: it is a symlink");
});


test("remote backup compression saves only after validation, survives repair, and withdraws with the addon", async () => {
  const b = box();
  const dir = tempDir();
  const remoteCommand = join(dir, "RemoteBackupCreateCommand.php");
  const tarCommand = join(dir, "TarCreateCommand.php");
  const original = "<?php $tarCreator->create($sources, $destinationFile, $excludes);";
  writeFileSync(remoteCommand, original);
  writeFileSync(tarCommand, "tar fixture");
  b.options.backupCompression = {
    paths: { remoteCommand, tarCommand }, version: "2.5.4-3",
    fingerprints: { remote: Bun.CryptoHasher.hash("sha256", original, "hex"), tar: Bun.CryptoHasher.hash("sha256", "tar fixture", "hex") },
    run: () => ({ ok: true, stdout: "", stderr: "" }),
  };
  const on = { enabled: true, level: 3, threads: 1 };
  b.options.backupCompression.version = "next";
  await expect(act(b, ["set-backup-compression"], on)).rejects.toThrow("has not been checked");
  expect(JSON.parse(readFileSync(b.settingsFile, "utf8")).backupCompression).toEqual(DEFAULT_BACKUP_COMPRESSION);
  expect(readFileSync(remoteCommand, "utf8")).toBe(original);
  b.options.backupCompression.version = "2.5.4-3";
  const state = await act(b, ["set-backup-compression"], on);
  expect(state.backupCompression).toMatchObject({ ...on, active: true });
  const html = dashboardView(state);
  expect(html).toContain("Compress remote backups with Zstandard");
  expect(html).toContain("Worker threads");
  expect(html).toContain("Restore .tar.zst archives over SSH");
  writeFileSync(remoteCommand, original);
  await systemTweaksMaintenance(b.options);
  expect(readFileSync(remoteCommand, "utf8")).toContain("clp-addons:backup-zstd:3:1");
  withdrawSystemTweaks(b.options);
  expect(readFileSync(remoteCommand, "utf8")).toBe(original);
  restoreSystemTweaks(b.options);
  expect(readFileSync(remoteCommand, "utf8")).toContain("clp-addons:backup-zstd:3:1");
  await act(b, ["set-backup-compression"], DEFAULT_BACKUP_COMPRESSION);
  await systemTweaksMaintenance(b.options);
  expect(readFileSync(remoteCommand, "utf8")).toBe(original);

  // A CloudPanel past the supported version gets the stock command back, and repair still finishes.
  await act(b, ["set-backup-compression"], on);
  b.options.backupCompression.version = "next";
  restoreSystemTweaks(b.options);
  expect(readFileSync(remoteCommand, "utf8")).toBe(original);
  // An edited command stops withdrawal before any other protection comes off.
  b.options.backupCompression.version = "2.5.4-3";
  restoreSystemTweaks(b.options);
  writeFileSync(remoteCommand, `${readFileSync(remoteCommand, "utf8")}\n// edited`);
  expect(existsSync(b.fileManagerGuardPaths.pool)).toBe(true);
  expect(() => withdrawSystemTweaks(b.options)).toThrow();
  expect(existsSync(b.fileManagerGuardPaths.pool)).toBe(true);
});

test("the backup compression API forwards the validated selection and repaints its actual state", async () => {
  const { handle } = await import("../addons/system-tweaks/app");
  const { systemTweaksService } = await import("../addons/system-tweaks/app/service");
  const state = await act(box(), ["state"]);
  const original = systemTweaksService.setBackupCompression;
  const calls: unknown[] = [];
  systemTweaksService.setBackupCompression = async (settings) => { calls.push(settings); return { ok: true, data: state }; };
  const body = { enabled: true, level: 6, threads: 2 };
  const csrf = "a".repeat(64);
  try {
    const req = new Request("https://panel.example.com/addons/system-tweaks/api/backup-compression", {
      method: "POST", headers: { Host: "panel.example.com", Origin: "https://panel.example.com", "Content-Type": "application/json",
        Cookie: `clp_addons_csrf=${csrf}`, "X-CLP-Addons-CSRF": csrf }, body: JSON.stringify(body),
    });
    const response = await handle(req, "/api/backup-compression");
    expect(response.status).toBe(200);
    expect((await response.json() as { html: string }).html).toBe(dashboardView(state));
    expect(calls).toEqual([body]);
  } finally { systemTweaksService.setBackupCompression = original; }
});

// --- root's lock ------------------------------------------------------------------

const ALL_OFF = {
  version: 1, uploadProgressGuard: false, blockForgedRealIp: false, blockVhostInjection: false, isolatePhpPools: false,
  protectPhpMyAdmin: false, confineFileManager: false, replacePanelCert: false, loginJails: { panel: false, ssh: false },
  databaseLoopback: false, blockClpctlInjection: false, blockTelemetry: false, serverInfoMotd: false, cloudflareVisitorIp: false,
};

/** The box with root's lock file of its own, and with MySQL already bound to loopback, so switching that on restarts nothing. */
function lockableBox(): Box & { locks: { file: string; rootUid: number; lockFile: string } } {
  const b = box();
  const dir = dirname(b.settingsFile);
  mkdirSync(dir, { recursive: true });
  const confDir = b.options.database!.paths!.confDirs![0]!;
  mkdirSync(confDir, { recursive: true });
  writeFileSync(join(confDir, "zz-clp-addons-loopback.cnf"), DATABASE_FILE);
  b.options.database = {
    ...b.options.database,
    run: (command, args) => command === "ss" ? { ok: true, stdout: "", stderr: "" }
      : command === "systemctl" && args[0] === "show" ? { ok: true, stdout: "Id=mysql.service\nMainPID=2000\nTriggeredBy=\nActiveState=active\n", stderr: "" }
      : { ok: false, stdout: "", stderr: "no MySQL in this fixture" },
  };
  // A directory of their own: mkdtemp's is the user's alone, as a lock directory must be.
  const own = tempDir();
  const locks = { file: join(own, "etc", "locks.json"), rootUid: process.getuid!(), lockFile: join(own, "locks.lock") };
  b.options.locks = locks;
  // fail2ban installed and running, so the jails really come on.
  for (const sub of ["jail.d", "filter.d"]) mkdirSync(join(b.options.loginJails!.paths!.fail2banDir!, sub), { recursive: true });
  b.options.loginJails = {
    ...b.options.loginJails,
    run: (command, args) => ({
      ok: true, stderr: "",
      stdout: command === "dpkg-query" ? "install ok installed\t1.1.0-1" : command === "systemctl" && args[0] === "is-enabled" ? "enabled\n"
        : command === "systemctl" && args[0] === "is-active" ? "active\n" : command === "fail2ban-client" ? "Jail list:\t\n" : "",
    }),
  };
  writeFileSync(b.settingsFile, JSON.stringify(ALL_OFF), { mode: 0o600 });
  return Object.assign(b, { locks });
}

test("Lock settings switches every lockable switch on, then locks", async () => {
  const b = lockableBox();
  await act(b, ["lock-settings"]);
  const settings = readSettings(b.options.paths as SystemTweaksPaths);
  expect(settings).toMatchObject({
    uploadProgressGuard: true, blockForgedRealIp: true, cloudflareVisitorIp: true, blockVhostInjection: true, isolatePhpPools: true,
    protectPhpMyAdmin: true, confineFileManager: true, replacePanelCert: true, loginJails: { panel: true, ssh: true }, databaseLoopback: true,
    blockClpctlInjection: true, blockTelemetry: true,
  });
  // Not a protection, so not touched.
  expect(settings.serverInfoMotd).toBe(false);
  expect(lockedAddons(b.locks.file, b.locks.rootUid)).toEqual(["system-tweaks"]);
});

test("Lock settings covers every switch root's lock holds", () => {
  const turnsOn = [...LOCK_SETTINGS.first, ...LOCK_SETTINGS.last].map((tweak): string => lockSettingsStep(tweak).verb);
  const held = Object.entries(SYSTEM_TWEAKS_VERBS).filter(([, declared]) => (declared as { lock?: string }).lock === "on").map(([verb]) => verb);
  expect(turnsOn.sort()).toEqual(held.sort());
});

test("Lock settings refuses a lock file root cannot trust before it changes anything", async () => {
  const b = lockableBox();
  mkdirSync(dirname(b.locks.file), { mode: 0o755 });
  writeFileSync(b.locks.file, JSON.stringify({ addons: [] }), { mode: 0o666 });
  chmodSync(b.locks.file, 0o666);
  await expect(act(b, ["lock-settings"])).rejects.toThrow("not a trusted regular file");
  expect(readSettings(b.options.paths as SystemTweaksPaths).confineFileManager).toBe(false);
});

test("a switch that does not come on leaves nothing locked", async () => {
  const b = lockableBox();
  b.options.database = box().options.database;
  await expect(act(b, ["lock-settings"])).rejects.toThrow("nothing was locked, because not every setting could be switched on: database-loopback:");
  expect(existsSync(b.locks.file)).toBe(false);
  // The rest came on; only the lock waits.
  expect(readSettings(b.options.paths as SystemTweaksPaths)).toMatchObject({ confineFileManager: true, databaseLoopback: false });
});

// MySQL's restart cuts remote clients, so it is not spent on a lock that will be refused.
test("a switch that fails first leaves MySQL alone", async () => {
  const b = lockableBox();
  const database: string[] = [];
  const run = b.options.database!.run!;
  b.options.database = { ...b.options.database, run: (command, args) => { database.push(command); return run(command, args); } };
  b.options.telemetry = { ...b.options.telemetry, run: () => ({ ok: false, stdout: "", stderr: "Access denied" }) };
  await expect(act(b, ["lock-settings"])).rejects.toThrow(/^nothing was locked, because not every setting could be switched on: telemetry:[^;]*$/);
  expect(database).toEqual([]);
  expect(existsSync(b.locks.file)).toBe(false);
  expect(readSettings(b.options.paths as SystemTweaksPaths).databaseLoopback).toBe(false);
});

// Jails saved without fail2ban run nowhere, so the page would call them on and locked when they are not.
test("Lock settings without fail2ban changes and locks nothing", async () => {
  const b = lockableBox();
  b.options.loginJails = box().options.loginJails;
  await expect(act(b, ["lock-settings"])).rejects.toThrow("nothing was changed or locked: fail2ban is not installed");
  expect(existsSync(b.locks.file)).toBe(false);
  expect(readSettings(b.options.paths as SystemTweaksPaths)).toMatchObject({ confineFileManager: false, loginJails: { panel: false } });
});

test("under root's lock a switch goes on but not off, even asked at root's action directly", async () => {
  const b = lockableBox();
  await act(b, ["lock-settings"]);
  await expect(act(b, ["set-file-manager-guard"], { enabled: false })).rejects.toThrow("root has locked system-tweaks");
  await expect(act(b, ["set-login-jails"], { ssh: false })).rejects.toThrow("root has locked system-tweaks");
  expect(readSettings(b.options.paths as SystemTweaksPaths)).toMatchObject({ confineFileManager: true, loginJails: { ssh: true } });
  await act(b, ["set-file-manager-guard"], { enabled: true });
  // The rest of the page is not held.
  await act(b, ["set-motd"], { enabled: false });
});

test("System Tweaks enabled under root's lock starts from its defaults", () => {
  const b = lockableBox();
  mkdirSync(dirname(b.locks.file), { mode: 0o755 });
  writeFileSync(b.locks.file, JSON.stringify({ addons: ["system-tweaks"] }), { mode: 0o644 });
  writeFileSync(b.settingsFile, JSON.stringify({ ...ALL_OFF, databaseLoopback: true }), { mode: 0o600 });
  restoreSystemTweaks(b.options);
  expect(readSettings(b.options.paths as SystemTweaksPaths)).toMatchObject({
    uploadProgressGuard: true, blockForgedRealIp: true, blockVhostInjection: true, isolatePhpPools: true, protectPhpMyAdmin: true,
    confineFileManager: true, replacePanelCert: true, loginJails: { panel: true, ssh: false },
    // Off by default, but never switched off by this.
    databaseLoopback: true,
    blockClpctlInjection: true, blockTelemetry: true, serverInfoMotd: false,
  });

  // Unlocked, it keeps what was chosen.
  const open = lockableBox();
  restoreSystemTweaks(open.options);
  expect(readSettings(open.options.paths as SystemTweaksPaths).confineFileManager).toBe(false);
});

// Re-running the installer activates an addon that is already on; a switch root locked off stays off.
test("System Tweaks already on under root's lock keeps its switches when activated again", () => {
  const b = lockableBox();
  mkdirSync(dirname(b.locks.file), { mode: 0o755 });
  writeFileSync(b.locks.file, JSON.stringify({ addons: ["system-tweaks"] }), { mode: 0o644 });
  restoreSystemTweaks(b.options, true);
  expect(readSettings(b.options.paths as SystemTweaksPaths)).toMatchObject({ confineFileManager: false, isolatePhpPools: false });
});

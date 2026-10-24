import { afterEach, expect, mock, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResult } from "../cli/action-common";
import { inspectPhpGuard, reconcilePhpGuard, type PhpGuardOptions } from "../cli/php-guard";
import {
  executeSystemTweaksAction, restoreSystemTweaks, systemTweaksUpkeep, withdrawSystemTweaks,
  type SystemTweaksOptions, type SystemTweaksState,
} from "../addons/system-tweaks/action";
import {
  allowedPatterns, coverageOf, dropInFor, fnmatch, parseAptConfig, parsePolicy, updatesStatus, DEFAULT_UPDATE_SETTINGS,
} from "../addons/system-tweaks/updates";
import { iniBoolean, iniSetting, uploadProgressStatus } from "../addons/system-tweaks/upload-progress";
import { dashboardView } from "../addons/system-tweaks/app/views";
import { releaseRealIp } from "../addons/system-tweaks/real-ip";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

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
  nginx: { fail: boolean; failPanel: boolean; commands: string[] };
}

const PANEL_NGINX_CONF = `http {
    real_ip_recursive on;

    set_real_ip_from 127.0.0.1;
    set_real_ip_from 10.0.0.0/8;
    set_real_ip_from 0.0.0.0/0;
    real_ip_header X-Forwarded-For;
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
  const nginx = { fail: false, failPanel: false, commands: [] as string[] };
  const nginxRun = (command: string, args: string[]): CommandResult => {
    nginx.commands.push(`${command} ${args.join(" ")}`);
    if (command !== "nginx" || args[0] !== "-t") return ok();
    const panel = args[1] === "-c";
    const failing = panel ? nginx.failPanel : nginx.fail;
    return failing && readFileSync(panel ? panelConf : nginxConf, "utf8").includes("#clp-addons:untrusted") ? { ok: false, stdout: "", stderr: "emerg" } : ok();
  };
  const phpGuard: PhpGuardOptions = {
    run: () => ({ ok: true, out: "" }),
    isActive: () => false,
    paths: { phpRoot, fpmBinDir: sbin, rootUid: uid, optOutConfig: guardConfig, optOutSettings: settingsFile },
  };
  return {
    aptDir, commands, timers, phpRoot, guardConfig, settingsFile, installed, nginxConf, panelConf, nginx,
    dropIn: join(aptDir, "52clp-addons-unattended-upgrades"),
    options: {
      processUid: 0,
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
      realIp: { run: nginxRun, paths: { nginxConf, panelConf, panelUid: uid, rootUid: uid } },
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
  expect(readFileSync(b.nginxConf, "utf8")).toBe(CLOUDPANEL_NGINX_CONF);
  expect(readFileSync(b.panelConf, "utf8")).toContain("#clp-addons:untrusted");
  expect(b.nginx.commands).toEqual([]);
  expect(systemTweaksUpkeep(b.options)).toBe("visitor-IP trust narrowed again");
  expect(readFileSync(b.nginxConf, "utf8")).toContain("#clp-addons:untrusted");
});

test("the gateway waits for the longest an install can take", async () => {
  const gatewayTimeouts: number[] = [];
  mock.module("../lib/gateway-client", () => ({
    callGatewayAction: async (_addon: string, _verb: string, _args: string[], _input?: string, options?: { timeout?: number }) => {
      gatewayTimeouts.push(options?.timeout ?? 60_000);
      return { ok: true };
    },
  }));
  const { systemTweaksService } = await import("../addons/system-tweaks/app/service");
  await systemTweaksService.installUpdates();

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

test("the install notice stays up until the reply, which repaints the page", async () => {
  const source = readFileSync(join(import.meta.dir, "../addons/system-tweaks/app/views.client.js"), "utf8");
  const events: string[] = [];
  let reply!: (body: unknown) => void;
  const client = new Function("call", "busy", "notify", "clearNotice", "repaintView", "CLP_ROOT", "clpFlashTimer",
    `${source}\nreturn { installUpdates };`)(
    () => new Promise((resolve) => { reply = resolve; }),
    () => {},
    (message: string, kind: string) => events.push(`${kind}: ${message}`),
    () => events.push("cleared"),
    (_holder: unknown, html: string) => events.push(`repaint: ${html}`),
    { getElementById: () => ({}) },
    0,
  ) as { installUpdates: () => Promise<void> };

  const pending = client.installUpdates();
  await Promise.resolve();
  expect(events).toEqual(["warn: Installing unattended-upgrades…"]);
  reply({ ok: true, html: "<p>installed</p>" });
  await pending;
  expect(events).toEqual([
    "warn: Installing unattended-upgrades…",
    "repaint: <p>installed</p>",
    "ok: unattended-upgrades is installed.",
  ]);
  expect(source).not.toContain("location.reload");
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
  expect(readFileSync(b.panelConf, "utf8")).toContain("    #clp-addons:untrusted set_real_ip_from 0.0.0.0/0;\n    real_ip_header X-Forwarded-For;\n");
  expect(b.nginx.commands).toEqual([
    "nginx -t", "systemctl reload nginx", `nginx -t -c ${b.panelConf}`, "systemctl reload clp-nginx",
  ]);
  expect((await act(b, ["state"])).realIp.trustsAnyAddress).toBe(false);

  const off = await act(b, ["set-real-ip"], { enabled: false });
  expect(off.realIp).toEqual({ blockForged: false, trustsAnyAddress: true, problem: "" });
  expect(readFileSync(b.nginxConf, "utf8")).toBe(CLOUDPANEL_NGINX_CONF);
  expect(readFileSync(b.panelConf, "utf8")).toBe(PANEL_NGINX_CONF);
  b.nginx.commands.length = 0;
  expect(systemTweaksUpkeep(b.options)).toBeNull();
  expect(b.nginx.commands).toEqual([]);
});

test("repair narrows the trust again after CloudPanel rewrites nginx.conf, and disabling the addon puts it back", async () => {
  const b = box();
  await act(b, ["set-real-ip"], { enabled: true });
  writeFileSync(b.nginxConf, CLOUDPANEL_NGINX_CONF);
  expect(systemTweaksUpkeep(b.options)).toBe("visitor-IP trust narrowed again");
  expect(readFileSync(b.nginxConf, "utf8")).toContain("#clp-addons:untrusted set_real_ip_from 0.0.0.0/0;");
  withdrawSystemTweaks(b.options);
  expect(readFileSync(b.nginxConf, "utf8")).toBe(CLOUDPANEL_NGINX_CONF);
});

test("a change Nginx rejects leaves the file and the saved choice as they were", async () => {
  const b = box();
  b.nginx.fail = true;
  await expect(act(b, ["set-real-ip"], { enabled: true })).rejects.toThrow("Nginx validation failed");
  expect(readFileSync(b.nginxConf, "utf8")).toBe(CLOUDPANEL_NGINX_CONF);
  expect(existsSync(b.settingsFile)).toBe(false);
});

test("the page shows forged IPs as blocked, or as trusted and needing repair", async () => {
  const b = box();
  const state = await act(b, ["state"]);
  expect(dashboardView(state)).toContain("Any client can set its own IP with a header. Run clp-addons repair.");
  restoreSystemTweaks(b.options);
  expect(dashboardView(await act(b, ["state"]))).toContain("Only local and private-network proxies can set the visitor IP.");
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

test("an existing installation keeps the guard without System Tweaks", () => {
  const b = box();
  rmSync(b.guardConfig);
  reconcilePhpGuard(true, true, b.options.phpGuard);
  expect(existsSync(guardFile(b, "8.1"))).toBe(true);
  // A stored opt-out counts for nothing while System Tweaks is not enabled.
  mkdirSync(join(b.settingsFile, ".."), { recursive: true });
  writeFileSync(b.settingsFile, JSON.stringify({ version: 1, uploadProgressGuard: false }), { mode: 0o600 });
  reconcilePhpGuard(true, true, b.options.phpGuard);
  expect(existsSync(guardFile(b, "8.3"))).toBe(true);
  expect(inspectPhpGuard(b.options.phpGuard).optedOut).toBe(false);
});

test("opting out in System Tweaks removes the guard, and repair keeps it removed", async () => {
  const b = box();
  reconcilePhpGuard(true, true, b.options.phpGuard);
  writeFileSync(join(b.phpRoot, "8.3", "fpm", "conf.d", "30-custom.ini"), "session.upload_progress.enabled = Off\n");
  const state = await act(b, ["set-upload-guard"], { enabled: false });
  expect(state.uploadProgress.guard).toBe(false);
  expect(existsSync(guardFile(b, "8.1"))).toBe(false);
  expect(state.uploadProgress.fpms.map((row) => [row.label, row.enabled, row.setBy])).toEqual([
    ["PHP 8.1", true, "default"],
    ["PHP 8.3", false, "config"],
    ["CloudPanel (PHP 8.3)", false, "config"],
  ]);
  reconcilePhpGuard(true, true, b.options.phpGuard);
  expect(existsSync(guardFile(b, "8.1"))).toBe(false);
  expect(inspectPhpGuard(b.options.phpGuard).optedOut).toBe(true);

  // Without System Tweaks' config the opt-out no longer counts.
  rmSync(b.guardConfig);
  reconcilePhpGuard(true, true, b.options.phpGuard);
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
  const html = dashboardView({ updates, settings: { ...DEFAULT_UPDATE_SETTINGS }, uploadProgress: { guard: true, fpms: [] }, realIp: { blockForged: true, trustsAnyAddress: false, problem: "" } });
  expect(html).toContain("A package download failed (HTTP 404).");
  expect(html).toContain('<details class="st-run-details"><summary>Failure details</summary>');
  expect(html).toContain("php8.2-bcmath.deb failed to download, aborting &lt;script&gt;");
  expect(html).not.toContain("<script>");
});

test("reboot timing preserves outside policy until explicitly set, and restores it on removal", async () => {
  const b = box();
  const outside = 'Unattended-Upgrade::Automatic-Reboot "true";\nUnattended-Upgrade::Automatic-Reboot-Time "04:15";\n';
  writeFileSync(join(b.aptDir, "50unattended-upgrades"), outside);
  let state = await act(b, ["set-updates"], { enabled: true });
  expect(state.settings.rebootTime).toBe(null);
  expect(state.updates.rebootTime).toBe("04:15");
  expect(readFileSync(b.dropIn, "utf8")).not.toContain("Automatic-Reboot-Time");
  for (const time of ["00:00", "03:30", "23:59", "now"]) {
    state = await act(b, ["set-updates"], { rebootTime: time });
    expect(state.settings.rebootTime).toBe(time);
    expect(state.updates.rebootTime).toBe(time);
    expect(JSON.parse(readFileSync(b.settingsFile, "utf8")).updates.rebootTime).toBe(time);
    expect(readFileSync(join(b.aptDir, "50unattended-upgrades"), "utf8")).toBe(outside);
  }
  state = await act(b, ["set-updates"], { rebootTime: null });
  expect(state.updates.rebootTime).toBe("04:15");
  await act(b, ["set-updates"], { rebootTime: "03:30" });
  withdrawSystemTweaks(b.options);
  expect(updatesStatus(b.options.updates).rebootTime).toBe("04:15");
  restoreSystemTweaks(b.options);
  expect(updatesStatus(b.options.updates).rebootTime).toBe("03:30");
  state = await act(b, ["set-updates"], { enabled: false });
  expect(state.updates.rebootTime).toBe("04:15");
  expect(dashboardView(state)).not.toContain("overrides your saved reboot time");
  expect(b.commands.some(command => /shutdown|reboot/.test(command))).toBe(false);
});

test("invalid reboot times cannot change settings or inject apt directives", async () => {
  const b = box();
  await act(b, ["set-updates"], { enabled: true });
  const before = readFileSync(b.dropIn, "utf8");
  const settings = readFileSync(b.settingsFile, "utf8");
  for (const rebootTime of ["", "3:30", "24:00", "12:60", "+5", false, 330, '03:30";\nAPT::Periodic::Enable "0']) {
    await expect(act(b, ["set-updates"], { rebootTime })).rejects.toThrow("rebootTime must be");
    expect(readFileSync(b.dropIn, "utf8")).toBe(before);
    expect(readFileSync(b.settingsFile, "utf8")).toBe(settings);
  }
});

test("old saved settings preserve outside timing and later apt files remain authoritative", async () => {
  const b = box();
  await act(b, ["set-updates"], { enabled: true, reboot: true });
  const saved = JSON.parse(readFileSync(b.settingsFile, "utf8"));
  delete saved.updates.rebootTime;
  writeFileSync(b.settingsFile, JSON.stringify(saved));
  writeFileSync(join(b.aptDir, "90operator"), 'Unattended-Upgrade::Automatic-Reboot-Time "+15";\n');
  let state = await act(b, ["state"]);
  expect(state.settings.rebootTime).toBe(null);
  expect(state.updates.rebootTime).toBe("+15");
  state = await act(b, ["set-updates"], { rebootTime: "02:00" });
  expect(state.updates.rebootTime).toBe("+15");
  const html = dashboardView(state);
  expect(html).toContain("overrides your saved reboot time");
  expect(html).toContain("15 minutes after the run");
  expect(html).toContain(`Server timezone: ${state.updates.timezone}`);
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
    expect(calls).toEqual([]);
    for (const rebootTime of ["03:30", "now", null]) {
      const response = await handle(request(rebootTime), "/api/updates");
      expect(response.status).toBe(200);
      expect((await response.json() as { html: string }).html).toBe(dashboardView(state));
    }
    expect(calls).toEqual([{ rebootTime: "03:30" }, { rebootTime: "now" }, { rebootTime: null }]);
  } finally { systemTweaksService.setUpdates = original; }
});

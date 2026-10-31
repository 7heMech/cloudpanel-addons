import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeWpToolsAction, reconcileWpVarnish, type WpJobView, type WpToolsActionOptions, type WpSiteView } from "../addons/wp-tools/action";
import { commandOutput, readVarnishState, type WpCommand, type VarnishSyncResult } from "../addons/wp-tools/varnish";
import { handle } from "../addons/wp-tools/app/index";
import { dashboardView, layout } from "../addons/wp-tools/app/views";
import { emptyMainwpState, mainwpView, saveMainwpState } from "../addons/wp-tools/mainwp";
import { WP_TOOLS_ADDON } from "../addons/wp-tools/addon";
import type { WpDashboard } from "../addons/wp-tools/app/service";
import { webVerb } from "../lib/gateway-protocol";
import { withFileLock } from "../cli/action-common";
import { jobDir, jobSet } from "../cli/job-store";
import { wpJobView } from "../addons/wp-tools/jobs";

let root = "";
let commands: WpCommand[];
let statuses: Record<string, "active" | "inactive" | "missing">;
let multisite: Set<string>;
let failures: Set<string>;
let started: Parameters<NonNullable<WpToolsActionOptions["startJob"]>>[0][];

function options(): WpToolsActionOptions {
  return {
    processUid: 0,
    paths: {
      configFile: join(root, "wp-tools.conf"), panelDb: join(root, "panel.sq3"), passwd: join(root, "passwd"),
      lockFile: join(root, "wp.lock"), varnishState: join(root, "varnish.json"), varnishLockFile: join(root, "wp-varnish.lock"),
      mainwpState: join(root, "mainwp.json"), mainwpLockFile: join(root, "wp-mainwp.lock"),
      jobsDir: join(root, "jobs"), jobsLockFile: join(root, "wp-jobs.lock"), actionBinary: "/usr/local/bin/clp-addons",
    },
    startJob: (unit) => { started.push(unit); return { ok: true, stdout: "", stderr: "" }; },
    domainValidator: (domain) => domain,
    runWpCommand: async (command) => {
      commands.push(command);
      const domain = command.argv.find((arg) => arg.startsWith("--url="))!.slice("--url=https://".length);
      if (failures.has(domain)) throw new Error("download failed");
      // Whatever the site's own code prints comes before the marked reply.
      if (command.argv.includes("eval")) return `Notice: a must-use plugin talks\nCLP-ADDONS-VARNISH-STATUS:${JSON.stringify({ status: statuses[domain] ?? "missing", multisite: multisite.has(domain) })}`;
      statuses[domain] = "active";
      return "Success";
    },
  };
}

async function act<T = unknown>(...argv: string[]): Promise<T> {
  return await executeWpToolsAction(argv, options()) as T;
}

function dbRun(sql: string): void {
  const db = new Database(join(root, "panel.sq3"));
  try { db.exec(sql); } finally { db.close(); }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "clp-wp-varnish-"));
  writeFileSync(join(root, "wp-tools.conf"), "");
  commands = [];
  statuses = {};
  multisite = new Set();
  failures = new Set();
  started = [];
  const db = new Database(join(root, "panel.sq3"), { create: true });
  db.exec(`
    CREATE TABLE site (id INTEGER PRIMARY KEY, type TEXT, domain_name TEXT, root_directory TEXT, user TEXT, application TEXT, varnish_cache INTEGER);
    CREATE TABLE php_settings (site_id INTEGER, php_version TEXT);
    INSERT INTO site VALUES (1, 'php', 'shop.example.com', 'shop.example.com', 'shop', 'WordPress', 1);
    INSERT INTO site VALUES (2, 'php', 'blog.example.com', 'blog.example.com', 'blog', 'Generic', 0);
    INSERT INTO site VALUES (3, 'static', 'docs.example.com', 'docs.example.com', 'docs', 'Static', 1);
    INSERT INTO php_settings VALUES (1, '8.2'), (2, '8.3');
  `);
  db.close();
  writeFileSync(join(root, "passwd"), ["shop", "blog", "docs"].map((user, i) => `${user}:x:${1100 + i}:${1100 + i}::${join(root, "home", user)}:/bin/sh`).join("\n"));
  for (const [user, domain] of [["shop", "shop.example.com"], ["blog", "blog.example.com"]]) {
    for (const directory of ["wp-includes", "wp-content"]) mkdirSync(join(root, "home", user!, "htdocs", domain!, directory), { recursive: true });
  }
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

test("automation defaults off, and listing sites never executes WordPress", async () => {
  const view = await act<{ sites: WpSiteView[]; varnish: { enabled: boolean } }>("sites");
  expect(view.varnish.enabled).toBe(false);
  expect(view.sites.find((site) => site.domain === "shop.example.com")?.varnishCache).toBe(true);
  expect(view.sites.find((site) => site.domain === "blog.example.com")?.varnishCache).toBe(false);
  expect((await reconcileWpVarnish(options())).checked).toBe(0);
  expect(commands).toEqual([]);
});

test("enabled automation installs only missing plugins on WordPress with Varnish enabled", async () => {
  await act("varnish-settings", "--enabled=true");
  expect(statSync(join(root, "varnish.json")).mode & 0o777).toBe(0o600);
  const result = await act<VarnishSyncResult>("varnish-sync");
  expect(result).toEqual({ installed: 1, checked: 1, pending: 0, failed: [] });
  const install = commands.find((command) => command.argv.includes("install"))!;
  expect(install.argv.slice(0, 4)).toEqual(["/usr/sbin/runuser", "-u", "shop", "--"]);
  expect(install.argv).toContain("/usr/bin/php8.2");
  expect(install.argv.slice(-4)).toEqual(["plugin", "install", "clp-varnish-cache", "--activate"]);
  expect(install.env).toEqual({ HOME: join(root, "home/shop"), PATH: "/usr/local/bin:/usr/bin:/bin", WP_CLI_CONFIG_PATH: "/dev/null" });
  expect(install.argv).not.toContain("--allow-root");
  expect(install.argv).not.toContain("--force");
  commands = [];
  expect((await act<VarnishSyncResult>("varnish-sync")).installed).toBe(0);
  expect(commands.every((command) => command.argv.includes("eval"))).toBe(true);
});

test("plugin installation can proceed independently of the sign-in lock", async () => {
  await withFileLock(options().paths!.lockFile!, 1, "sign-in locked", async () => {
    expect((await act<VarnishSyncResult>("varnish-install", "--domain=shop.example.com")).installed).toBe(1);
  });
});

test("the queued pass skips a page's running check", async () => {
  await act("varnish-settings", "--enabled=true");
  await withFileLock(options().paths!.varnishLockFile!, 1, "a page's check", async () => {
    const started = Date.now();
    await expect(reconcileWpVarnish(options(), { dueOnly: true })).rejects.toThrow("still running");
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

test("repair queues nothing while both policies are off", async () => {
  const spawn = Bun.spawnSync;
  const calls: string[][] = [];
  try {
    // @ts-expect-error test mock
    Bun.spawnSync = (args: string[]) => {
      calls.push(args);
      return { success: true, stdout: "", stderr: "", exitCode: 0 };
    };
    expect(await WP_TOOLS_ADDON.maintenance!.run(options() as Record<string, unknown>)).toBeNull();
    expect(calls).toEqual([]);
  } finally {
    Bun.spawnSync = spawn;
  }
});

test("repair queues a bounded policy pass without running site code", async () => {
  await act("varnish-settings", "--enabled=true");
  const spawn = Bun.spawnSync;
  const calls: string[][] = [];
  try {
    // @ts-expect-error test mock
    Bun.spawnSync = (args: string[]) => {
      calls.push(args);
      return { success: args[0] === "systemd-run", stdout: "", stderr: "", exitCode: 0 };
    };
    expect(await WP_TOOLS_ADDON.maintenance!.run(options() as Record<string, unknown>)).toBe("plugin policy pass queued");
    expect(calls).toHaveLength(2);
    const queued = calls[1]!;
    expect(queued).toContain("--no-block");
    expect(queued).toContain("--property=RuntimeMaxSec=180");
    expect(queued.slice(queued.indexOf("--") + 1)).toEqual(["/usr/local/bin/clp-addons", "action", "wp-tools", "sync"]);
    expect(commands).toEqual([]);
  } finally {
    Bun.spawnSync = spawn;
  }
});

test("a queued pass leaves absent policy state off without discovering sites", async () => {
  rmSync(join(root, "panel.sq3"));
  await act("sync");
  expect(commands).toEqual([]);
  expect(existsSync(join(root, "varnish.json"))).toBe(false);
  expect(existsSync(join(root, "mainwp.json"))).toBe(false);
});

test("a queued pass skips disabled or uninstalled addons before reading state or sites", async () => {
  await act("varnish-settings", "--enabled=true");
  const state = { ...emptyMainwpState(), enabled: true, dashboard: "blog.example.com", cleanup: true };
  saveMainwpState(join(root, "mainwp.json"), state);
  const varnish = readFileSync(join(root, "varnish.json"), "utf8");
  rmSync(join(root, "wp-tools.conf"));
  rmSync(join(root, "panel.sq3"));
  await act("sync");
  expect(commands).toEqual([]);
  expect(readFileSync(join(root, "varnish.json"), "utf8")).toBe(varnish);
  expect(JSON.parse(readFileSync(join(root, "mainwp.json"), "utf8"))).toEqual(state);
  rmSync(join(root, "mainwp.json"));
  rmSync(join(root, "varnish.json"));
  await act("sync");
  expect(existsSync(join(root, "varnish.json"))).toBe(false);
  expect(existsSync(join(root, "mainwp.json"))).toBe(false);
});

test("a Varnish failure does not prevent the queued MainWP pass", async () => {
  writeFileSync(join(root, "varnish.json"), "invalid");
  saveMainwpState(join(root, "mainwp.json"), { ...emptyMainwpState(), enabled: true, dashboard: "blog.example.com" });
  const checked: string[] = [];
  const config = options();
  config.runWpCommand = async (command) => {
    const input = JSON.parse(command.stdin!);
    checked.push(input.op);
    const reply = input.op === "dashboard-status" ? { sites: { "shop.example.com": null } } : {
      multisite: true, installed: false, files: false, active: false, key: "", securityId: "", admin: "admin", fingerprint: "",
    };
    return `CLP-ADDONS-MAINWP:${JSON.stringify(reply)}`;
  };
  await expect(executeWpToolsAction(["sync"], config)).rejects.toThrow();
  expect(checked).toEqual(["dashboard-status", "status"]);
});

test("the periodic verb refuses arguments and stays outside the gateway", async () => {
  expect((webVerb("wp-tools", "sync") !== null)).toBe(false);
  for (const arg of ["--domain=shop.example.com", "--enabled=true", "--as-user=admin"]) {
    await expect(act("sync", arg)).rejects.toThrow();
  }
});

test("a Generic WordPress becomes eligible when CloudPanel enables Varnish", async () => {
  await act("varnish-settings", "--enabled=true");
  await act("varnish-sync");
  dbRun("UPDATE site SET varnish_cache = 1 WHERE domain_name = 'blog.example.com';");
  const result = await reconcileWpVarnish(options());
  expect(result.installed).toBe(1);
  expect(statuses["blog.example.com"]).toBe("active");
});

test("an exclusion list left in the state is ignored and dropped on the next write", async () => {
  writeFileSync(join(root, "varnish.json"), '{"enabled":true,"excluded":["shop.example.com"],"sites":{}}');
  expect((await act<VarnishSyncResult>("varnish-sync")).installed).toBe(1);
  expect(readFileSync(join(root, "varnish.json"), "utf8")).not.toContain("excluded");
  await expect(act("varnish-site", "--domain=shop.example.com", "--excluded=true")).rejects.toThrow("unknown WordPress Tools verb");
  for (const verb of ["varnish-site", "mainwp-site"]) expect((webVerb("wp-tools", verb) !== null)).toBe(false);
});

test("existing inactive plugins and subsequently removed plugins require explicit action", async () => {
  statuses["shop.example.com"] = "inactive";
  await act("varnish-settings", "--enabled=true");
  expect((await act<VarnishSyncResult>("varnish-sync")).installed).toBe(0);
  expect(statuses["shop.example.com"]).toBe("inactive");
  await act("varnish-install", "--domain=shop.example.com");
  expect(commands.at(-2)?.argv.slice(-3)).toEqual(["plugin", "activate", "clp-varnish-cache"]);
  statuses["shop.example.com"] = "missing";
  commands = [];
  await act("varnish-sync");
  expect(commands).toHaveLength(1);
  expect(readVarnishState(join(root, "varnish.json")).sites["shop.example.com"]?.seen).toBe(true);
  await act("varnish-install", "--domain=shop.example.com");
  expect(String(statuses["shop.example.com"])).toBe("active");
});

test("a multisite network gets the plugin network-activated, and privileged Unix accounts get nothing", async () => {
  multisite.add("shop.example.com");
  expect((await act<VarnishSyncResult>("varnish-install", "--domain=shop.example.com")).installed).toBe(1);
  expect(commands.find((command) => command.argv.includes("install"))!.argv.slice(-4)).toEqual(["plugin", "install", "clp-varnish-cache", "--activate-network"]);
  expect(readVarnishState(join(root, "varnish.json")).sites["shop.example.com"]).toMatchObject({ status: "active", network: true });
  // A network where the plugin is active only on some of its sites counts as inactive, and Activate activates it network-wide.
  statuses["shop.example.com"] = "inactive";
  commands = [];
  await act("varnish-install", "--domain=shop.example.com");
  expect(commands[1]!.argv.slice(-4)).toEqual(["plugin", "activate", "clp-varnish-cache", "--network"]);
  multisite.clear();
  writeFileSync(join(root, "passwd"), `shop:x:0:0::${join(root, "home/shop") }:/bin/sh\n`);
  commands = [];
  await expect(act("varnish-install", "--domain=shop.example.com")).rejects.toThrow("not eligible");
  expect(commands).toEqual([]);
});

test("one site's failure does not block the rest of the fleet and is visible on the page", async () => {
  failures.add("shop.example.com");
  dbRun("UPDATE site SET varnish_cache = 1 WHERE domain_name = 'blog.example.com';");
  await act("varnish-settings", "--enabled=true");
  const result = await act<VarnishSyncResult>("varnish-sync");
  expect(result.installed).toBe(1);
  expect(result.failed).toEqual(["shop.example.com: download failed"]);
  expect(dashboardView(await act<WpDashboard>("sites"))).toContain("download failed");
  expect(statuses["blog.example.com"]).toBe("active");
});

test("missing WordPress, disabled Varnish and nonexistent domains cannot be explicitly installed", async () => {
  for (const domain of ["docs.example.com", "blog.example.com", "absent.example.com"]) {
    await expect(act("varnish-install", `--domain=${domain}`)).rejects.toThrow("not eligible");
  }
  rmSync(join(root, "home/shop/htdocs/shop.example.com/wp-content"), { recursive: true });
  await expect(act("varnish-install", "--domain=shop.example.com")).rejects.toThrow("not eligible");
  expect(commands).toEqual([]);
});

test("old panel schemas retain sign-in listing but offer no eligible Varnish sites", async () => {
  dbRun("ALTER TABLE site DROP COLUMN varnish_cache; DROP TABLE php_settings;");
  expect((await act<{ sites: WpSiteView[] }>("sites")).sites.every((site) => !site.varnishCache)).toBe(true);
  await act("varnish-settings", "--enabled=true");
  expect((await act<VarnishSyncResult>("varnish-sync")).checked).toBe(0);
});

test("intent is saved before installing, and a failed download is retried on the next pass", async () => {
  const config = options();
  const successfulRunner = config.runWpCommand!;
  let seenDuringInstall: boolean | undefined;
  config.runWpCommand = async (command) => {
    if (!command.argv.includes("install")) return successfulRunner(command);
    // What a pass killed at this point would leave behind.
    seenDuringInstall = readVarnishState(join(root, "varnish.json")).sites["shop.example.com"]?.seen;
    throw new Error("download failed");
  };
  await act("varnish-settings", "--enabled=true");
  const result = await executeWpToolsAction(["varnish-sync"], config) as VarnishSyncResult;
  expect(result.failed).toEqual(["shop.example.com: download failed"]);
  expect(seenDuringInstall).toBe(true);
  expect(readVarnishState(join(root, "varnish.json")).sites["shop.example.com"]).toMatchObject({ status: "error", seen: false });
  expect((await reconcileWpVarnish(options(), { dueOnly: true })).installed).toBe(1);
});

test("the timer checks only sites automation can still act on", async () => {
  dbRun("UPDATE site SET varnish_cache = 1 WHERE domain_name = 'blog.example.com';");
  statuses["blog.example.com"] = "inactive";
  await act("varnish-settings", "--enabled=true");
  expect((await act<VarnishSyncResult>("varnish-sync")).checked).toBe(2);
  commands = [];
  expect((await reconcileWpVarnish(options(), { dueOnly: true })).checked).toBe(0);
  expect(commands).toEqual([]);
  expect((await act<VarnishSyncResult>("varnish-sync")).checked).toBe(2);
});

test("state for a domain the panel no longer has is dropped", async () => {
  await act("varnish-settings", "--enabled=true");
  await act("varnish-sync");
  expect(readVarnishState(join(root, "varnish.json")).sites["shop.example.com"]).toBeDefined();
  dbRun("DELETE FROM site WHERE domain_name = 'shop.example.com';");
  await act("varnish-sync");
  expect(readVarnishState(join(root, "varnish.json")).sites["shop.example.com"]).toBeUndefined();
});

test("unreadable Varnish settings leave sign-in on the page", async () => {
  writeFileSync(join(root, "varnish.json"), "{");
  const view = await act<WpDashboard>("sites");
  expect(view.sites.map((site) => site.domain)).toContain("shop.example.com");
  expect(view.varnishError).toContain("cannot be read");
  const html = dashboardView(view);
  expect(html).toContain("signIn(this)");
  expect(html).not.toContain("setAutomatic(this)");
  expect(html).not.toContain("installPlugin(this)");
  await expect(act("varnish-sync")).rejects.toThrow();
});

test("a process the site detaches cannot hold the root action past its deadline", async () => {
  const started = Date.now();
  const detached = { cwd: "/", env: { PATH: "/usr/bin:/bin" }, timeoutMs: 1000 };
  await expect(commandOutput({ ...detached, argv: ["/bin/sh", "-c", "setsid sleep 3 </dev/null & echo started"] }))
    .rejects.toThrow("WP-CLI timed out");
  expect(Date.now() - started).toBeLessThan(5000);
  await expect(commandOutput({ ...detached, argv: ["/bin/sh", "-c", "printf 'bad\\033[2Jnews\\n' >&2; exit 3"] }))
    .rejects.toThrow("WP-CLI failed: bad [2Jnews");
});

test("invalid persisted state and invalid PHP versions do not execute plugin commands", async () => {
  writeFileSync(join(root, "varnish.json"), '{"enabled":true,"sites":{"shop.example.com":{"status":"active"}}}');
  await expect(act("varnish-sync")).rejects.toThrow("site record is invalid");
  expect(commands).toEqual([]);
  rmSync(join(root, "varnish.json"));
  dbRun("UPDATE php_settings SET php_version = '../../bin/sh' WHERE site_id = 1;");
  const result = await act<VarnishSyncResult>("varnish-install", "--domain=shop.example.com");
  expect(result.failed[0]).toContain("PHP version is unavailable");
  expect(commands).toEqual([]);
});

test("Varnish verbs reject missing, duplicate and unrelated arguments", async () => {
  for (const args of [
    ["varnish-settings"], ["varnish-settings", "--enabled=yes"],
    ["varnish-settings", "--enabled=true", "--enabled=false"],
    ["varnish-sync", "--enabled=true"], ["varnish-install", "--domain=shop.example.com", "--as-user=boss"],
  ]) await expect(act(...args)).rejects.toThrow();
  expect((webVerb("wp-tools", "varnish-settings") !== null)).toBe(true);
  // The page starts checks and installations as background jobs instead.
  for (const verb of ["varnish-install", "varnish-sync"]) expect((webVerb("wp-tools", verb) !== null)).toBe(false);
});

test("Varnish routes remain administrator-only", async () => {
  const token = "a".repeat(64);
  for (const path of ["settings", "install", "sync"]) {
    const request = new Request(`https://panel.example.com/addons/wp-tools/api/varnish-${path}`, {
      method: "POST", headers: { Host: "panel.example.com", Origin: "https://panel.example.com", Cookie: `clp_addons_csrf=${token}`, "X-CLP-Addons-CSRF": token },
    });
    const response = await handle(request, `/api/varnish-${path}`, undefined, undefined, { user: "site-manager", roles: ["ROLE_SITE_MANAGER"] });
    expect(response.status).toBe(404);
  }
  const dashboard = new Request("https://panel.example.com/addons/wp-tools/api/dashboard", { headers: { Host: "panel.example.com" } });
  expect((await handle(dashboard, "/api/dashboard", undefined, undefined, { user: "site-manager", roles: ["ROLE_SITE_MANAGER"] })).status).toBe(404);
});

test("the WordPress Tools page emits a valid script with sign-in and Varnish actions", () => {
  const html = layout("WordPress Tools", dashboardView({ sites: [], varnish: { enabled: false, sites: {} }, varnishError: "", mainwp: mainwpView(emptyMainwpState()), mainwpError: "", domainLink: { signIn: true }, domainLinkError: "", jobs: { varnish: null, mainwp: null } }));
  for (const source of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) expect(() => new Function(source[1]!)).not.toThrow();
  expect(html).toContain("/api/sign-in");
  expect(html).toContain("/api/varnish-settings");
  expect(html).toContain("/api/dashboard");
  expect(html).not.toContain("location.reload");
  expect(readFileSync(join(import.meta.dir, "../addons/wp-tools/app/views.client.js"), "utf8")).toContain("target.close()");
});

test("Check now runs as a background job that the page can find again and follow to its result", async () => {
  type Started = { job: WpJobView };
  const { job } = await act<Started>("start", "--task=varnish-check");
  expect(job).toMatchObject({ task: "varnish-check", policy: "varnish", state: "queued" });
  expect(started).toEqual([{
    addon: "wp-tools", id: job.id, description: "clp-addons: WordPress Tools varnish-check",
    actionBinary: "/usr/local/bin/clp-addons", properties: ["RuntimeMaxSec=3600"],
  }]);
  // A reload finds it, and a second check is refused while it runs.
  expect((await act<WpDashboard>("sites")).jobs.varnish?.id).toBe(job.id);
  await expect(act("start", "--task=varnish-check")).rejects.toThrow("already running");
  expect(commands).toEqual([]);

  // systemd's half, as the unit calls it.
  const done = await act<WpJobView>("run", "--job", job.id);
  expect(done).toMatchObject({ state: "done", completed: 1, total: 1, site: "", result: { checked: 1, installed: 0, failed: [] } });
  // With automation off a check only records what each site has.
  expect(readVarnishState(join(root, "varnish.json")).sites["shop.example.com"]).toMatchObject({ status: "missing", seen: false });
  expect(statuses["shop.example.com"]).toBeUndefined();
  expect((await act<{ job: WpJobView }>("job", `--job=${job.id}`)).job.state).toBe("done");
  expect((await act<WpDashboard>("sites")).jobs.varnish).toBeNull();
  await expect(act("run", "--job", job.id)).rejects.toThrow("already done");
  // The page's next check is a new job.
  expect((await act<Started>("start", "--task=varnish-check")).job.id).not.toBe(job.id);
});

test("a job that fails says why, and the next one starts", async () => {
  writeFileSync(join(root, "varnish.json"), '{"enabled":true,"sites":{"shop.example.com":{"status":"active"}}}');
  const { job } = await act<{ job: WpJobView }>("start", "--task=varnish-install", "--domains=shop.example.com");
  expect(await act<WpJobView>("run", `--job=${job.id}`)).toMatchObject({ state: "failed", error: "the WordPress Varnish site record is invalid" });
  expect((await act<WpDashboard>("sites")).jobs.varnish).toBeNull();
});

test("a job starts only with its own fixed arguments", async () => {
  for (const args of [
    [], ["--task=varnish-sync"], ["--task=mainwp-cleanup", "--domains=shop.example.com"], ["--task=varnish-install"],
    ["--task=varnish-install", "--domains=shop.example.com,blog.example.com"], ["--task=mainwp-connect", "--domains=shop.example.com"],
    ["--task=mainwp-connect", "--confirm=connect"], ["--task=mainwp-cleanup"], ["--task=mainwp-check", "--confirm=mainwp"],
    ["--task=varnish-check", "--task=mainwp-check"], ["--task=varnish-check", "--path=/etc"],
  ]) await expect(act("start", ...args)).rejects.toThrow();
  for (const args of [[], ["--job=../../etc"], ["--job"], ["--job=20260101T000000Z-abcdef", "--job=20260101T000000Z-abcdef"]]) {
    await expect(act("run", ...args)).rejects.toThrow();
  }
  expect(started).toEqual([]);
  rmSync(join(root, "wp-tools.conf"));
  await expect(act("start", "--task=varnish-check")).rejects.toThrow("enabled");
  for (const verb of ["start", "job", "watch-job"]) expect((webVerb("wp-tools", verb) !== null)).toBe(true);
  expect((webVerb("wp-tools", "run") !== null)).toBe(false);
});

test("multisite records an earlier version skipped are checked again", async () => {
  writeFileSync(join(root, "varnish.json"), JSON.stringify({ enabled: true, sites: {
    "shop.example.com": { status: "unsupported", seen: false, checkedAt: "2026-01-01T00:00:00Z", error: "" },
  } }));
  expect(readVarnishState(join(root, "varnish.json")).sites["shop.example.com"]).toBeUndefined();
  multisite.add("shop.example.com");
  expect((await reconcileWpVarnish(options(), { dueOnly: true })).installed).toBe(1);
  expect(readVarnishState(join(root, "varnish.json")).sites["shop.example.com"]).toMatchObject({ status: "active", network: true });
  expect(dashboardView(await act<WpDashboard>("sites"))).toContain("Network active");
});

test("an unchecked site offers no Install, and a running job disables what it would race", async () => {
  const view = await act<WpDashboard>("sites");
  expect(dashboardView(view)).toContain("Not checked");
  expect(dashboardView(view)).not.toContain("installPlugin(this)");
  const { job } = await act<{ job: WpJobView }>("start", "--task=varnish-check");
  const running = dashboardView(await act<WpDashboard>("sites"));
  expect(running).toContain(`data-job="${job.id}"`);
  expect(running).toMatch(/id="varnish-check" type="button" disabled/);
  expect(running).toMatch(/id="varnish-automatic"[^>]* disabled/);
});

test("a batch job reads back every site it was given", () => {
  const jobsDir = mkdtempSync(join(tmpdir(), "wp-jobs-"));
  try {
    const domains = Array.from({ length: 400 }, (_, index) => `site-${index}.customer-example.com`);
    const id = "20260101T000000Z-abcdef";
    const dir = jobDir(jobsDir, id);
    mkdirSync(dir, { recursive: true });
    jobSet(dir, "task", "mainwp-connect");
    jobSet(dir, "domains", domains.join(","));
    expect(wpJobView(jobsDir, id)?.domains).toEqual(domains);
  } finally {
    rmSync(jobsDir, { recursive: true, force: true });
  }
});

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeWpLoginAction, reconcileWpVarnish, type WpLoginActionOptions, type WpSiteView } from "../addons/wp-login/action";
import { readVarnishState, type WpCommand, type VarnishSyncResult } from "../addons/wp-login/varnish";
import { handle } from "../addons/wp-login/app/index";
import { dashboardView, layout } from "../addons/wp-login/app/views";
import { WP_LOGIN_ALLOWED_VERBS } from "../lib/gateway-protocol";
import { withFileLock } from "../cli/action-common";

let root = "";
let commands: WpCommand[];
let statuses: Record<string, "active" | "inactive" | "missing">;
let multisite: Set<string>;
let failures: Set<string>;

function options(): WpLoginActionOptions {
  return {
    processUid: 0,
    paths: { panelDb: join(root, "panel.sq3"), passwd: join(root, "passwd"), lockFile: join(root, "wp.lock"), varnishState: join(root, "varnish.json"), varnishLockFile: join(root, "wp-varnish.lock") },
    domainValidator: (domain) => domain,
    runWpCommand: async (command) => {
      commands.push(command);
      const domain = command.argv.find((arg) => arg.startsWith("--url="))!.slice("--url=https://".length);
      if (failures.has(domain)) throw new Error("download failed");
      if (command.argv.includes("eval")) return JSON.stringify({ status: statuses[domain] ?? "missing", multisite: multisite.has(domain) });
      statuses[domain] = "active";
      return "Success";
    },
  };
}

async function act<T = unknown>(...argv: string[]): Promise<T> {
  return await executeWpLoginAction(argv, options()) as T;
}

function dbRun(sql: string): void {
  const db = new Database(join(root, "panel.sq3"));
  try { db.exec(sql); } finally { db.close(); }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "clp-wp-varnish-"));
  commands = [];
  statuses = {};
  multisite = new Set();
  failures = new Set();
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

test("a Generic WordPress becomes eligible when CloudPanel enables Varnish", async () => {
  await act("varnish-settings", "--enabled=true");
  await act("varnish-sync");
  dbRun("UPDATE site SET varnish_cache = 1 WHERE domain_name = 'blog.example.com';");
  const result = await reconcileWpVarnish(options());
  expect(result.installed).toBe(1);
  expect(statuses["blog.example.com"]).toBe("active");
});

test("site exclusions survive setting changes and reject explicit installation", async () => {
  await act("varnish-site", "--domain=shop.example.com", "--excluded=true");
  await act("varnish-settings", "--enabled=true");
  expect((await act<VarnishSyncResult>("varnish-sync")).checked).toBe(0);
  await expect(act("varnish-install", "--domain=shop.example.com")).rejects.toThrow("not eligible");
  await act("varnish-settings", "--enabled=false");
  expect(readVarnishState(join(root, "varnish.json")).excluded).toEqual(["shop.example.com"]);
  await act("varnish-site", "--domain=shop.example.com", "--excluded=false");
  expect((await act<VarnishSyncResult>("varnish-install", "--domain=shop.example.com")).installed).toBe(1);
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

test("multisite and privileged Unix accounts cannot receive plugin installations", async () => {
  multisite.add("shop.example.com");
  expect((await act<VarnishSyncResult>("varnish-install", "--domain=shop.example.com")).installed).toBe(0);
  expect(readVarnishState(join(root, "varnish.json")).sites["shop.example.com"]?.status).toBe("unsupported");
  expect(commands).toHaveLength(1);
  multisite.clear();
  writeFileSync(join(root, "passwd"), `shop:x:0:0::${join(root, "home/shop") }:/bin/sh\n`);
  commands = [];
  const result = await act<VarnishSyncResult>("varnish-install", "--domain=shop.example.com");
  expect(result.failed[0]).toContain("Unix account is invalid");
  expect(commands).toEqual([]);
});

test("one site's failure does not block the rest of the fleet and is visible on the page", async () => {
  failures.add("shop.example.com");
  dbRun("UPDATE site SET varnish_cache = 1 WHERE domain_name = 'blog.example.com';");
  await act("varnish-settings", "--enabled=true");
  const result = await act<VarnishSyncResult>("varnish-sync");
  expect(result.installed).toBe(1);
  expect(result.failed).toEqual(["shop.example.com: download failed"]);
  const view = await act<{ sites: WpSiteView[] }>("sites");
  expect(dashboardView(view.sites)).toContain("download failed");
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

test("interrupted installation records intent and never silently retries a removed plugin", async () => {
  const config = options();
  const successfulRunner = config.runWpCommand!;
  config.runWpCommand = async (command) => {
    if (command.argv.includes("install")) throw new Error("download interrupted");
    return successfulRunner(command);
  };
  await act("varnish-settings", "--enabled=true");
  const result = await executeWpLoginAction(["varnish-sync"], config) as VarnishSyncResult;
  expect(result.failed).toEqual(["shop.example.com: download interrupted"]);
  expect(readVarnishState(join(root, "varnish.json")).sites["shop.example.com"]?.seen).toBe(true);
  commands = [];
  expect((await act<VarnishSyncResult>("varnish-sync")).installed).toBe(0);
  expect(commands.every((command) => command.argv.includes("eval"))).toBe(true);
  expect((await act<VarnishSyncResult>("varnish-install", "--domain=shop.example.com")).installed).toBe(1);
});

test("invalid persisted state and invalid PHP versions do not execute plugin commands", async () => {
  writeFileSync(join(root, "varnish.json"), '{"enabled":true,"excluded":[],"sites":{"shop.example.com":{"status":"active"}}}');
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
    ["varnish-site", "--domain=shop.example.com"], ["varnish-sync", "--enabled=true"],
    ["varnish-install", "--domain=shop.example.com", "--as-user=boss"],
  ]) await expect(act(...args)).rejects.toThrow();
  for (const verb of ["varnish-settings", "varnish-site", "varnish-install", "varnish-sync"]) expect(WP_LOGIN_ALLOWED_VERBS.has(verb)).toBe(true);
});

test("Varnish routes remain administrator-only", async () => {
  const token = "a".repeat(64);
  for (const path of ["settings", "site", "install", "sync"]) {
    const request = new Request(`https://panel.example.com/addons/wp-login/api/varnish-${path}`, {
      method: "POST", headers: { Host: "panel.example.com", Origin: "https://panel.example.com", Cookie: `clp_addons_csrf=${token}`, "X-CLP-Addons-CSRF": token },
    });
    const response = await handle(request, `/api/varnish-${path}`, undefined, undefined, { user: "site-manager", roles: ["ROLE_SITE_MANAGER"] });
    expect(response.status).toBe(404);
  }
});

test("the WordPress Tools page emits a valid script with sign-in and Varnish actions", () => {
  const html = layout("WordPress Tools", dashboardView([]));
  for (const source of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) expect(() => new Function(source[1]!)).not.toThrow();
  expect(html).toContain("/api/sign-in");
  expect(html).toContain("/api/varnish-settings");
  expect(readFileSync(join(import.meta.dir, "../addons/wp-login/app/views.client.js"), "utf8")).toContain("target.close()");
});

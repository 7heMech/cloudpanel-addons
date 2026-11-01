import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  executeWpToolsAction, reconcileWpNewSites, type WpJobView, type WpNewSiteEvent, type WpNewSitesResult, type WpToolsActionOptions,
} from "../addons/wp-tools/action";
import { WP_TOOLS_ADDON } from "../addons/wp-tools/addon";
import { emptyMainwpState, mainwpOwesSite, saveMainwpState, type MainwpState } from "../addons/wp-tools/mainwp";
import { NEW_SITE_PENDING_MS, readNewSitesState, type NewSitesState } from "../addons/wp-tools/new-sites";
import { readVarnishState, type WpCommand } from "../addons/wp-tools/varnish";
import { ADDONS, addonCertificates, addonNewSites } from "../cli/addon-catalog";
import { certificateUnits } from "../cli/provision";

let root = "";
let now = 0;
let commands: WpCommand[];
let installed: Set<string>;
let started: Parameters<NonNullable<WpToolsActionOptions["startJob"]>>[0][];
/** Who owns each file the tests cannot chown: root unless handed over. */
let owners: Map<string, number>;
let uids: Map<string, number>;

const T0 = Date.parse("2026-10-29T12:00:00Z");

function options(): WpToolsActionOptions {
  return {
    processUid: 0,
    now: () => new Date(now),
    paths: {
      configFile: join(root, "wp-tools.conf"), panelDb: join(root, "panel.sq3"), passwd: join(root, "passwd"),
      lockFile: join(root, "wp.lock"), varnishState: join(root, "varnish.json"), varnishLockFile: join(root, "wp-varnish.lock"),
      mainwpState: join(root, "mainwp.json"), mainwpLockFile: join(root, "wp-mainwp.lock"),
      jobsDir: join(root, "jobs"), jobsLockFile: join(root, "wp-jobs.lock"),
      newSitesState: join(root, "new-sites.json"), newSitesLockFile: join(root, "wp-new-sites.lock"),
      certificatesDir: join(root, "certs"), nginxVhostDir: join(root, "vhosts"), actionBinary: "/usr/local/bin/clp-addons",
    },
    startJob: (unit) => { started.push(unit); return { ok: true, stdout: "", stderr: "" }; },
    domainValidator: (domain) => domain,
    fileOwner: (path) => {
      if (!existsSync(path)) throw new Error("missing");
      return owners.get(path) ?? 0;
    },
    runWpCommand: async (command) => {
      commands.push(command);
      const domain = command.argv.find((arg) => arg.startsWith("--url="))!.slice("--url=https://".length);
      if (!command.argv.includes("eval")) installed.add(domain);
      return `CLP-ADDONS-VARNISH-STATUS:${JSON.stringify({ status: installed.has(domain) ? "active" : "missing", multisite: false })}`;
    },
  };
}

function event(kind: WpNewSiteEvent = "sites"): Promise<WpNewSitesResult> {
  return reconcileWpNewSites(options(), kind);
}

const NOTHING: WpNewSitesResult = { added: [], queued: {}, pending: [], waiting: [], failed: [] };

function state(): NewSitesState {
  return readNewSitesState(join(root, "new-sites.json"))!;
}

function dbRun(sql: string): void {
  const db = new Database(join(root, "panel.sq3"));
  try { db.exec(sql); } finally { db.close(); }
}

let nextId = 10;
/** CloudPanel creating a site: the account and the row, then its vhost; WordPress comes later. */
function addSite(domain: string, user: string, { type = "php", application = "WordPress", varnish = 1 } = {}): void {
  uids.set(user, 1100 + nextId);
  writeFileSync(join(root, "passwd"), `${readFileSync(join(root, "passwd"), "utf8")}\n${user}:x:${1100 + nextId}:${1100 + nextId}::${join(root, "home", user)}:/bin/sh`);
  dbRun(`INSERT INTO site VALUES (${nextId}, '${type}', '${domain}', '${domain}', '${user}', '${application}', ${varnish});
    INSERT INTO php_settings VALUES (${nextId}, '8.3');`);
  nextId++;
  mkdirSync(join(root, "vhosts"), { recursive: true });
  writeFileSync(join(root, "vhosts", `${domain}.conf`), "server {}\n");
  certificate(domain, "self-signed");
}

/**
 * WordPress's files and configuration, written by CloudPanel's installer as
 * root; the configuration is handed to the site user once the installation ends.
 */
function installWordPress(user: string, domain: string, { finished = true } = {}): void {
  const site = join(root, "home", user, "htdocs", domain);
  for (const directory of ["wp-includes", "wp-content"]) mkdirSync(join(site, directory), { recursive: true });
  writeFileSync(join(site, "wp-config.php"), "<?php\n");
  if (finished) owners.set(join(site, "wp-config.php"), uids.get(user)!);
}

let stamp = 0;
function certificate(domain: string, body: string): void {
  mkdirSync(join(root, "certs"), { recursive: true });
  writeFileSync(join(root, "certs", `${domain}.crt`), body);
  // Each write a distinct moment, as CloudPanel's are.
  const at = new Date(T0 + ++stamp * 1000);
  utimesSync(join(root, "certs", `${domain}.crt`), at, at);
}

function jobs(): string[] {
  return existsSync(join(root, "jobs")) ? readdirSync(join(root, "jobs")) : [];
}

function finishJobs(): void {
  for (const job of jobs()) writeFileSync(join(root, "jobs", job, "state"), "done\n");
}

const DASHBOARD: MainwpState = { ...emptyMainwpState(), enabled: true, dashboard: "shop.example.com" };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "clp-wp-new-sites-"));
  now = T0;
  stamp = 0;
  commands = [];
  installed = new Set();
  started = [];
  owners = new Map();
  uids = new Map([["shop", 1100]]);
  writeFileSync(join(root, "wp-tools.conf"), "");
  writeFileSync(join(root, "varnish.json"), JSON.stringify({ enabled: true, sites: {} }));
  const db = new Database(join(root, "panel.sq3"), { create: true });
  db.exec(`
    CREATE TABLE site (id INTEGER PRIMARY KEY, type TEXT, domain_name TEXT, root_directory TEXT, user TEXT, application TEXT, varnish_cache INTEGER);
    CREATE TABLE php_settings (site_id INTEGER, php_version TEXT);
    CREATE TABLE user (id INTEGER PRIMARY KEY, user_name TEXT, role TEXT, status INTEGER);
    CREATE TABLE user_sites (user_id INTEGER, site_id INTEGER);
    INSERT INTO site VALUES (1, 'php', 'shop.example.com', 'shop.example.com', 'shop', 'WordPress', 1);
    INSERT INTO php_settings VALUES (1, '8.2');
    INSERT INTO user VALUES (1, 'owner', 'ROLE_USER', 1), (2, 'nosy', 'ROLE_USER', 1);
  `);
  db.close();
  writeFileSync(join(root, "passwd"), `shop:x:1100:1100::${join(root, "home", "shop")}:/bin/sh`);
  installWordPress("shop", "shop.example.com");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

test("the first look learns the sites there are, and a vhost rewrite with nothing pending changes nothing", async () => {
  expect(await event()).toEqual(NOTHING);
  expect(state()).toEqual({ known: ["shop.example.com"], pending: [] });
  const written = statSync(join(root, "new-sites.json")).mtimeMs;
  const before = readFileSync(join(root, "new-sites.json"), "utf8");
  now += 60_000;
  expect(await event()).toEqual(NOTHING);
  expect(readFileSync(join(root, "new-sites.json"), "utf8")).toBe(before);
  expect(statSync(join(root, "new-sites.json")).mtimeMs).toBe(written);
  // With nothing pending, a wake, a certificate or a job ending reads only the state file.
  rmSync(join(root, "panel.sq3"));
  for (const kind of ["wake", "certificates", "job"] as const) expect(await event(kind)).toEqual(NOTHING);
  expect(started).toEqual([]);
  expect(commands).toEqual([]);
});

test("repair makes the baseline once, so the watcher's first wake is not every site", async () => {
  // With both policies off, upkeep queues no 15-minute pass, so nothing here reaches systemd.
  writeFileSync(join(root, "varnish.json"), JSON.stringify({ enabled: false, sites: {} }));
  expect(await WP_TOOLS_ADDON.repair!.run(options() as Record<string, unknown>)).toBeNull();
  expect(state().known).toEqual(["shop.example.com"]);
  addSite("new.example.com", "newsite");
  await event("seed");
  expect(state().known).toEqual(["shop.example.com"]);
  expect((await event()).added).toEqual(["new.example.com"]);
});

test("a new WordPress site is checked once CloudPanel hands its configuration to the site user", async () => {
  await event();
  const waiting = WP_TOOLS_ADDON.newSites!.resumePending!;
  // The row's commit: no WordPress yet, so nothing is queued, and the watcher keeps waking.
  addSite("new.example.com", "newsite");
  expect(await WP_TOOLS_ADDON.newSites!.run(options() as Record<string, unknown>)).toBe("new.example.com waits for WordPress");
  expect(state().pending).toEqual([{ domain: "new.example.com", since: T0, tried: {} }]);
  expect(await waiting(options() as Record<string, unknown>)).toEqual({ waiting: true, line: null });
  // The installer writes wp-config.php as root while WordPress is still being installed.
  installWordPress("newsite", "new.example.com", { finished: false });
  expect(await event("wake")).toMatchObject({ queued: {}, waiting: ["new.example.com"] });
  expect(await event("certificates")).toMatchObject({ queued: {}, waiting: ["new.example.com"] });

  // Its last step hands the configuration over, and the next wake queues the check.
  installWordPress("newsite", "new.example.com");
  now += 10_000;
  expect(await waiting(options() as Record<string, unknown>)).toEqual({ waiting: false, line: "CLP Varnish Cache check queued for new.example.com" });
  expect(commands).toEqual([]);
  expect(started.map((unit) => unit.description)).toEqual(["clp-addons: WordPress Tools varnish-check"]);
  expect(state().pending).toEqual([{ domain: "new.example.com", since: T0, wordpress: true, tried: { "varnish-check": "wordpress" } }]);
  // Nothing waits for WordPress now, so a wake reads only the state file; other events queue nothing again.
  rmSync(join(root, "panel.sq3"), { force: true });
  expect(await event("wake")).toEqual(NOTHING);
  expect(await waiting(options() as Record<string, unknown>)).toEqual({ waiting: false, line: null });
});

test("a checked site's job end drops it once automation owes it nothing", async () => {
  await event();
  addSite("new.example.com", "newsite");
  await event();
  installWordPress("newsite", "new.example.com");
  expect((await event("wake")).queued).toEqual({ "varnish-check": ["new.example.com"] });
  expect((await event()).queued).toEqual({});
  expect((await event("certificates")).queued).toEqual({});
  const done = await executeWpToolsAction(["run", "--job", jobs()[0]!], options()) as WpJobView;
  expect(done).toMatchObject({ task: "varnish-check", domains: ["new.example.com"], state: "done", result: { checked: 1, installed: 1 } });
  expect(new Set(commands.map((command) => command.argv[2]))).toEqual(new Set(["newsite"]));
  expect(readVarnishState(join(root, "varnish.json")).sites["new.example.com"]).toMatchObject({ status: "active", seen: true });
  expect(state().pending).toEqual([]);
  expect(started).toHaveLength(1);
});

test("MainWP's check is queued again when the site's certificate changes, until it is connected", async () => {
  await event();
  saveMainwpState(join(root, "mainwp.json"), DASHBOARD);
  writeFileSync(join(root, "varnish.json"), JSON.stringify({ enabled: false, sites: {} }));
  addSite("new.example.com", "newsite");
  installWordPress("newsite", "new.example.com");
  // On its self-signed certificate: one try, which a site behind Cloudflare's proxy can pass.
  expect((await event()).queued).toEqual({ "mainwp-check": ["new.example.com"] });
  finishJobs();
  expect((await event("certificates")).queued).toEqual({});

  // CloudPanel installs the real certificate.
  certificate("new.example.com", "lets-encrypt");
  expect(await WP_TOOLS_ADDON.certificates!.run(options() as Record<string, unknown>)).toBe("MainWP Child check queued for new.example.com");
  finishJobs();
  expect((await event("certificates")).queued).toEqual({});

  saveMainwpState(join(root, "mainwp.json"), {
    ...DASHBOARD,
    sites: { "new.example.com": { status: "connected", seen: true, checkedAt: "", error: "", ownedPlugin: true, ownedConnection: true } },
  });
  expect(await event("certificates")).toMatchObject({ queued: {}, pending: [] });
});

test("a policy's running job is not doubled; its end checks the waiting site", async () => {
  await event();
  const { job } = await executeWpToolsAction(["start", "--task=varnish-install", "--domains=shop.example.com"], options()) as { job: WpJobView };
  addSite("busy.example.com", "busy");
  installWordPress("busy", "busy.example.com");
  expect(await event()).toMatchObject({ queued: {}, pending: ["busy.example.com"], failed: [] });
  expect(state().pending[0]!.tried).toEqual({});
  // The page's check runs to its end, which checks the pending sites again.
  await executeWpToolsAction(["run", "--job", job.id], options());
  expect(started.map((unit) => unit.description)).toEqual(["clp-addons: WordPress Tools varnish-install", "clp-addons: WordPress Tools varnish-check"]);
  expect(state().pending[0]!.tried).toEqual({ "varnish-check": "wordpress" });
});

test("with automation off, for a site that cannot be a WordPress, or after an hour, nothing is queued", async () => {
  await event();
  addSite("static.example.com", "static", { type: "static", application: "Static" });
  expect(await event()).toMatchObject({ added: ["static.example.com"], queued: {}, pending: [] });
  addSite("static2.example.com", "static2", { type: "static", application: "Static" });
  expect(await WP_TOOLS_ADDON.newSites!.run(options() as Record<string, unknown>)).toBeNull();
  // A PHP site that is not CloudPanel's WordPress keeps nothing waiting.
  addSite("php.example.com", "php", { application: "PHP" });
  expect(await event()).toMatchObject({ added: ["php.example.com"], queued: {}, pending: [], waiting: [] });
  // Without Varnish on the site, its check is not owed.
  addSite("plain.example.com", "plain", { varnish: 0 });
  installWordPress("plain", "plain.example.com");
  expect(await event()).toMatchObject({ queued: {}, pending: [] });
  // A site whose WordPress never comes is the 15-minute pass's after an hour.
  addSite("late.example.com", "late");
  expect(await event()).toMatchObject({ pending: ["late.example.com"], waiting: ["late.example.com"] });
  now += NEW_SITE_PENDING_MS;
  installWordPress("late", "late.example.com");
  expect(await event("certificates")).toMatchObject({ queued: {}, pending: [], waiting: [] });
  writeFileSync(join(root, "varnish.json"), JSON.stringify({ enabled: false, sites: {} }));
  addSite("off.example.com", "off");
  installWordPress("off", "off.example.com");
  expect(await event()).toMatchObject({ added: ["off.example.com"], queued: {}, pending: [] });
  expect(started).toEqual([]);
  // A disabled addon looks at nothing.
  rmSync(join(root, "wp-tools.conf"));
  addSite("later.example.com", "later");
  expect(await event()).toEqual(NOTHING);
});

test("what MainWP automation still owes a site", () => {
  const record = { status: "waiting-https" as const, seen: true, checkedAt: "", error: "", ownedPlugin: true, ownedConnection: false };
  const waiting = { ...DASHBOARD, sites: { "new.example.com": record } };
  expect(mainwpOwesSite(waiting, "new.example.com")).toBe(true);
  expect(mainwpOwesSite({ ...waiting, sites: { "new.example.com": { ...record, status: "connected" } } }, "new.example.com")).toBe(false);
  expect(mainwpOwesSite({ ...waiting, sites: { "new.example.com": { ...record, status: "unsupported" } } }, "new.example.com")).toBe(false);
  expect(mainwpOwesSite(waiting, "shop.example.com")).toBe(false);
  expect(mainwpOwesSite({ ...waiting, cleanup: true }, "new.example.com")).toBe(false);
  expect(mainwpOwesSite({ ...waiting, enabled: false }, "new.example.com")).toBe(false);
  // A Dashboard elsewhere needs only the Child, installed once.
  expect(mainwpOwesSite({ ...waiting, remote: true }, "new.example.com")).toBe(false);
  expect(mainwpOwesSite({ ...waiting, remote: true, sites: {} }, "new.example.com")).toBe(true);
});

test("the watchers run WP Tools, and the certificate watcher watches CloudPanel's certificates", () => {
  expect(addonNewSites([ADDONS["wp-tools"]!]).map((spec) => spec.name)).toEqual(["wp-tools"]);
  expect(addonCertificates(Object.values(ADDONS)).map((spec) => spec.name)).toEqual(["wp-tools"]);
  const units = certificateUnits();
  expect(units.path).toContain("PathChanged=/etc/nginx/ssl-certificates");
  expect(units.path).toContain("Unit=clp-addons-certificates.service");
  // The key and the certificate are separate writes, so it looks twice.
  expect(units.service).toMatch(/ExecStart=-\S+ sync-certificates\nExecStart=\/bin\/sleep 3\nExecStart=\/\S+ sync-certificates\n/);
});

// CloudPanel removes a site's vhost and certificate before its row, and the
// certificate going wakes the certificate watcher while the row is still there.
test("a pending site being deleted gets no check", async () => {
  await event();
  saveMainwpState(join(root, "mainwp.json"), DASHBOARD);
  addSite("gone.example.com", "gone");
  await event();
  installWordPress("gone", "gone.example.com");
  rmSync(join(root, "vhosts", "gone.example.com.conf"));
  rmSync(join(root, "certs", "gone.example.com.crt"));
  expect(await event("certificates")).toMatchObject({ queued: {}, pending: ["gone.example.com"] });
  // Then the row goes, and so does the site.
  dbRun("DELETE FROM site WHERE domain_name = 'gone.example.com';");
  expect(await event()).toMatchObject({ queued: {}, pending: [] });
  expect(started).toEqual([]);
});

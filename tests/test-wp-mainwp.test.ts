import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureMainwp, emptyMainwpState, mainwpAction, mainwpView, readMainwpState, requireMainwpSettled, saveMainwpState, syncMainwp, type MainwpRun } from "../addons/wp-tools/mainwp";
import type { WpCommand } from "../addons/wp-tools/wp-cli";
import { commandOutput } from "../addons/wp-tools/wp-cli";
import { handle } from "../addons/wp-tools/app/index";
import { dashboardView } from "../addons/wp-tools/app/views";

let root: string;
let run: MainwpRun;
let commands: WpCommand[];
const key = "a".repeat(64);
const snapshot = () => ({ options: {}, meta: { passwordAuth: null }, admin: 1, active: false, cron: {}, tables: [], uploads: false });
const status = () => ({ multisite: false, installed: false, files: false, active: false, key: "", securityId: "", admin: "owner", snapshot: snapshot(), auth: true });
let children: Record<string, ReturnType<typeof status>>;
let connections: Record<string, { id: number; key: string } | null>;
let fail: string;
let httpsReady: boolean;
let nextId: number;
const options = { runWpCommand: async (command: WpCommand) => {
  commands.push(command);
  const domain = command.argv.find((arg) => arg.startsWith("--url="))!.slice("--url=https://".length);
  if (command.argv.includes("install")) {
    if (fail === "install") throw new Error("download unavailable");
    if (fail === "partial-install") { children[domain]!.files = true; throw new Error("incomplete download"); }
    children[domain]!.installed = true; children[domain]!.files = true; return "installed";
  }
  const input = JSON.parse(command.stdin!);
  const child = children[domain];
  let reply: unknown = { ok: true };
  switch (input.op) {
    case "status": reply = { ...structuredClone(child), fingerprint: JSON.stringify([child!.snapshot, child!.auth, child!.securityId]) }; break;
    case "snapshot": reply = { snapshot: structuredClone(child!.snapshot) }; break;
    case "dashboard-status": reply = { ok: true, sites: Object.fromEntries(input.domains.map((d: string) => [d, connections[d] || null])) }; break;
    case "dashboard-ready": reply = { ready: httpsReady }; break;
    case "prepare":
      if (fail === "prepare") throw new Error("activation unavailable");
      child!.active = true; child!.auth = false; child!.securityId = input.token; break;
    case "activate":
      if (fail === "activate") throw new Error("activation unavailable");
      child!.active = true; break;
    case "restore-auth":
      if (fail === "restore") throw new Error("interrupted");
      child!.auth = true;
      break;
    case "dashboard-add":
      children[input.name]!.key = key;
      connections[input.name] = { id: nextId++, key };
      if (fail === "add") throw new Error("interrupted after registration");
      break;
    case "cleanup":
      if (fail === "cleanup") throw new Error("site unavailable");
      if (child!.key && child!.key !== input.key) throw new Error("ownership changed");
      child!.key = ""; child!.securityId = ""; child!.auth = true;
      child!.active = input.snapshot.active;
      if (input.removePlugin) { child!.installed = false; child!.files = false; }
      break;
    case "dashboard-remove":
      for (const [domain, record] of Object.entries(connections)) if (record?.id === input.id && record?.key === input.key) delete connections[domain];
      break;
  }
  return `Notice from a must-use plugin\nCLP-ADDONS-MAINWP:${JSON.stringify(reply)}\nmore site output`;
} };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "clp-mainwp-"));
  commands = []; children = {}; connections = {}; fail = ""; httpsReady = true; nextId = 2;
  run = { statePath: join(root, "mainwp.json"), runuser: "/usr/sbin/runuser", domains: new Set(["dashboard.test", "new.test", "manual.test", "connected.test", "network.test"]),
    sites: ["dashboard.test", "new.test", "manual.test", "connected.test", "network.test"].map((domain, i) => ({ domain, user: `wp${i}`, home: `/home/wp${i}`, root: `/home/wp${i}/htdocs/${domain}`, phpVersion: "8.3" })) };
  for (const site of run.sites) children[site.domain] = status();
  children["manual.test"]!.installed = true; children["manual.test"]!.files = true;
  children["connected.test"]!.installed = true; children["connected.test"]!.files = true; children["connected.test"]!.active = true; children["connected.test"]!.key = key;
  connections["connected.test"] = { id: 1, key };
  children["network.test"]!.multisite = true;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
async function configured() { await configureMainwp(run, options, true, "dashboard.test"); commands = []; }

test("defaults off; only unseen missing children enroll; manual and connected sites stay operator-owned", async () => {
  expect(readMainwpState(run.statePath).enabled).toBe(false);
  expect((await syncMainwp({ ...run, dueOnly: true }, options)).checked).toBe(0);
  expect(commands).toHaveLength(0);
  await configured();
  const result = await syncMainwp(run, options);
  expect(result).toMatchObject({ checked: 4, connected: 1, failed: [] });
  const state = readMainwpState(run.statePath);
  expect(state.sites["new.test"]).toMatchObject({ seen: true, status: "connected", ownedPlugin: true, ownedConnection: true });
  expect(state.sites["manual.test"]).toMatchObject({ status: "not-connected", ownedPlugin: false, ownedConnection: false });
  expect(state.sites["connected.test"]).toMatchObject({ status: "connected", ownedConnection: false });
  expect(state.sites["network.test"]!.status).toBe("unsupported");
  expect(children["new.test"]!.auth).toBe(true);
  expect(statSync(run.statePath).mode & 0o777).toBe(0o600);
  const secretCommand = commands.find((c) => c.stdin?.includes('"op":"prepare"'))!;
  const token = JSON.parse(secretCommand.stdin!).token;
  expect(secretCommand.argv.join(" ")).not.toContain(token);
  expect(secretCommand.env).toEqual({ HOME: "/home/wp1", PATH: "/usr/local/bin:/usr/bin:/bin", WP_CLI_CONFIG_PATH: "/dev/null" });
  expect(secretCommand.argv).toContain("--skip-plugins");
  expect(secretCommand.argv).not.toContain("--allow-root");
  expect(JSON.stringify(mainwpView(state))).not.toContain(token);
  expect(JSON.stringify(mainwpView(state))).not.toContain("snapshot");
});

test("the timer and Check now never reinstall an observed Child that the operator removed", async () => {
  await configured(); await syncMainwp(run, options);
  children["new.test"]!.installed = false; children["new.test"]!.files = false; children["new.test"]!.key = "";
  commands = [];
  expect((await syncMainwp({ ...run, dueOnly: true }, options)).checked).toBe(0);
  expect(commands).toHaveLength(0);
  await syncMainwp(run, options);
  expect(children["new.test"]!.installed).toBe(false);
  expect(readMainwpState(run.statePath).sites["new.test"]).toMatchObject({ status: "missing", seen: true });
  expect(commands.some((c) => c.argv.includes("install") || c.stdin?.includes('"op":"dashboard-ready"'))).toBe(false);
  await configureMainwp(run, options, false);
  await syncMainwp(run, options);
  expect(children["new.test"]!.installed).toBe(false);
});

test("a new site waits for Dashboard-side HTTPS without intent or a failure, then the timer connects it", async () => {
  await configured(); httpsReady = false;
  const waiting = await syncMainwp({ ...run, dueOnly: true }, options);
  expect(waiting).toMatchObject({ connected: 0, failed: [] });
  expect(readMainwpState(run.statePath).sites["new.test"]).toMatchObject({ status: "waiting-https", seen: false, ownedPlugin: false, ownedConnection: false, error: "" });
  expect(readMainwpState(run.statePath).sites["new.test"]!.snapshot).toBeUndefined();
  expect(children["new.test"]!.installed).toBe(false);
  expect(commands.some((c) => c.argv.includes("install") || c.stdin?.includes('"op":"prepare"'))).toBe(false);
  const request = commands.find((c) => c.stdin?.includes('"op":"dashboard-ready"'))!;
  expect(request.argv).toContain("wp0");
  expect(JSON.parse(request.stdin!)).toEqual({ op: "dashboard-ready", url: "https://new.test" });
  expect(request.timeoutMs).toBeLessThanOrEqual(13_000);
  httpsReady = true; commands = [];
  expect(await syncMainwp({ ...run, dueOnly: true }, options)).toMatchObject({ checked: 1, connected: 1, failed: [] });
  expect(readMainwpState(run.statePath).sites["new.test"]).toMatchObject({ status: "connected", seen: true, ownedPlugin: true, ownedConnection: true });
});

test("an outright install failure restores intent and ownership so the next timer pass succeeds", async () => {
  await configured(); fail = "install";
  expect((await syncMainwp({ ...run, dueOnly: true }, options)).failed).toHaveLength(1);
  const record = readMainwpState(run.statePath).sites["new.test"]!;
  expect(record).toMatchObject({ status: "error", seen: false, ownedPlugin: false, ownedConnection: false });
  expect(record.snapshot).toBeUndefined(); expect(record.token).toBeUndefined(); expect(record.phase).toBeUndefined();
  expect(children["new.test"]!.installed).toBe(false);
  fail = "";
  expect(await syncMainwp({ ...run, dueOnly: true }, options)).toMatchObject({ checked: 1, connected: 1, failed: [] });
});

test("an unchanged failed row connection restores its previous ownership and still requires explicit Connect", async () => {
  await configured(); await syncMainwp(run, options); fail = "prepare";
  expect((await syncMainwp({ ...run, domain: "manual.test" }, options)).failed).toHaveLength(1);
  const record = readMainwpState(run.statePath).sites["manual.test"]!;
  expect(record).toMatchObject({ status: "error", seen: true, ownedPlugin: false, ownedConnection: false });
  expect(record.snapshot).toBeUndefined(); expect(record.phase).toBeUndefined();
  fail = "";
  expect((await syncMainwp({ ...run, dueOnly: true }, options)).checked).toBe(0);
  expect((await syncMainwp({ ...run, domain: "manual.test" }, options)).connected).toBe(1);
});

test("partial installation keeps its recovery journal and needs Retry", async () => {
  await configured(); fail = "partial-install";
  expect((await syncMainwp({ ...run, dueOnly: true }, options)).failed).toHaveLength(1);
  const record = readMainwpState(run.statePath).sites["new.test"]!;
  expect(record).toMatchObject({ status: "error", seen: true, ownedPlugin: true, error: "incomplete download" });
  expect(record.phase).toBeUndefined();
  fail = ""; commands = [];
  await syncMainwp({ ...run, dueOnly: true }, options);
  expect(commands).toHaveLength(0);
  expect((await syncMainwp({ ...run, domain: "new.test" }, options)).connected).toBe(1);
  expect(commands.find((c) => c.argv.includes("install"))!.argv).toContain("--force");
});

test("an enrollment cut off before its setting was restored is reported as interrupted", async () => {
  await configured(); fail = "restore";
  await syncMainwp({ ...run, domain: "manual.test" }, options);
  connections["manual.test"] = null; children["manual.test"]!.key = "";
  fail = "";
  await syncMainwp({ ...run, dueOnly: true }, options);
  expect(readMainwpState(run.statePath).sites["manual.test"]).toMatchObject({ status: "error", error: "Enrollment was interrupted. Retry to continue." });
  expect(children["manual.test"]!.auth).toBe(true);
});

test("row Connect owns the new connection but preserves an existing plugin and activation state on cleanup", async () => {
  await configured();
  expect((await mainwpAction(run, ["mainwp-connect", "--domain=manual.test", "--confirm=manual.test"], options, (d) => d) as { connected: number }).connected).toBe(1);
  expect(readMainwpState(run.statePath).sites["manual.test"]).toMatchObject({ ownedPlugin: false, ownedConnection: true });
  const result = await syncMainwp(run, options, true);
  expect(result.failed).toEqual([]);
  expect(children["manual.test"]).toMatchObject({ installed: true, active: false, key: "", auth: true });
  expect(connections["manual.test"]).toBeUndefined();
  expect(connections["connected.test"]).toEqual({ id: 1, key });
  expect(readMainwpState(run.statePath)).toMatchObject({ cleanup: false, enabled: false });
});

test("a crash after registration restores authentication and recovers ownership without creating a duplicate", async () => {
  await configured(); fail = "restore";
  const first = await syncMainwp({ ...run, domain: "new.test" }, options);
  expect(first.failed).toHaveLength(1);
  expect(children["new.test"]!.auth).toBe(false);
  expect(readMainwpState(run.statePath).sites["new.test"]!.phase).toBe("connect");
  await configureMainwp(run, options, false);
  fail = ""; commands = [];
  await syncMainwp({ ...run, dueOnly: true }, options);
  expect(children["new.test"]!.auth).toBe(true);
  expect(readMainwpState(run.statePath).sites["new.test"]).toMatchObject({ status: "connected", ownedConnection: true });
  expect(commands.some((c) => c.stdin?.includes('"op":"dashboard-add"'))).toBe(false);
});

test("cleanup is resumable; a failed child never hides its pending state or removes manual connections", async () => {
  await configured(); await syncMainwp(run, options);
  fail = "cleanup";
  expect((await syncMainwp(run, options, true)).failed).toHaveLength(1);
  expect(readMainwpState(run.statePath).cleanup).toBe(true);
  fail = "";
  expect((await syncMainwp(run, options, true)).failed).toEqual([]);
  expect(children["new.test"]!.installed).toBe(false);
  expect(connections["new.test"]).toBeUndefined();
  expect(children["connected.test"]!.key).toBe(key);
  expect(connections["connected.test"]).toEqual({ id: 1, key });
});

test("exclusions and foreign connections are honored; switching Dashboard requires cleanup", async () => {
  await configured();
  await mainwpAction(run, ["mainwp-site", "--domain=new.test", "--excluded=true"], options, (d) => d);
  await syncMainwp(run, options);
  expect(children["new.test"]!.installed).toBe(false);
  children["manual.test"]!.key = "b".repeat(64);
  expect((await syncMainwp({ ...run, domain: "manual.test" }, options)).failed).toHaveLength(1);
  expect(children["manual.test"]!.key).toBe("b".repeat(64));
  await mainwpAction(run, ["mainwp-site", "--domain=new.test", "--excluded=false"], options, (d) => d);
  await syncMainwp({ ...run, domain: "new.test" }, options);
  await expect(configureMainwp(run, options, true, "manual.test")).rejects.toThrow("clean up");
});

test("removed panel domains are pruned and their owned Dashboard records are retired safely", async () => {
  await configured(); await syncMainwp(run, options);
  run.domains.delete("new.test"); run.sites = run.sites.filter((s) => s.domain !== "new.test");
  await syncMainwp(run, options);
  expect(readMainwpState(run.statePath).sites["new.test"]).toBeUndefined();
  expect(connections["new.test"]).toBeUndefined();
});

test("invalid state and unconfirmed or malformed verbs fail closed", async () => {
  await configured();
  for (const argv of [["mainwp-cleanup"], ["mainwp-connect", "--domain=manual.test"], ["mainwp-settings", "--enabled=true", "--enabled=false"], ["mainwp-sync", "--domain=new.test"], ["mainwp-site", "--domain=new.test"]]) await expect(mainwpAction(run, argv, options, (d) => d)).rejects.toThrow();
  const state = emptyMainwpState();
  state.sites["new.test"] = { status: "missing", seen: true, checkedAt: "", error: "", ownedPlugin: true, ownedConnection: false };
  saveMainwpState(run.statePath, state);
  expect(() => readMainwpState(run.statePath)).toThrow("record is invalid");
});

test("MainWP routes require administrator, CSRF, and confirmation before reaching the gateway", async () => {
  for (const path of ["settings", "site", "sync", "connect", "cleanup"]) {
    const response = await handle(new Request(`https://panel.test/addons/wp-tools/api/mainwp-${path}`, { method: "POST", headers: { Host: "panel.test", origin: "https://panel.test", cookie: `clp_addons_csrf=${"a".repeat(64)}`, "X-CLP-Addons-CSRF": "a".repeat(64), "Content-Type": "application/json" }, body: "{}" }), `/api/mainwp-${path}`, undefined, undefined, { user: "manager", roles: ["ROLE_SITE_MANAGER"] });
    expect(response.status).toBe(404);
  }
  const denied = await handle(new Request("https://panel.test/addons/wp-tools/api/mainwp-cleanup", { method: "POST", body: "{}" }), "/api/mainwp-cleanup", undefined, undefined, { user: "admin", roles: ["ROLE_ADMIN"] });
  expect(denied.status).toBe(403);
});

test("the UI has row Connect, a pause switch and explicit cleanup, with no secrets or selection UI", () => {
  const state = emptyMainwpState(); state.dashboard = "dashboard.test"; state.cleanup = true;
  state.sites["new.test"] = { status: "waiting-https", seen: false, checkedAt: "", error: "", ownedPlugin: false, ownedConnection: false };
  const html = dashboardView({ sites: run.sites.map((s) => ({ domain: s.domain, user: s.user, helper: false, varnishCache: false, varnishExcluded: false, varnishPlugin: null })), varnish: { enabled: false, excluded: [], sites: {} }, varnishError: "", mainwp: mainwpView(state), mainwpError: "" });
  expect(html).toContain("Waiting for HTTPS"); expect(html).toContain("Cleanup pending"); expect(html).toContain("mainwp-automatic"); expect(html).not.toContain("Select all");
});

test("the page puts sites first and draws only the controls that do something", () => {
  const site = (domain: string, varnishCache = false, helper = false) =>
    ({ domain, user: domain.split(".")[0]!, helper, varnishCache, varnishExcluded: false, varnishPlugin: null });
  const page = (sites: ReturnType<typeof site>[], mainwp: ReturnType<typeof emptyMainwpState>, varnish = false) => dashboardView({
    sites, varnish: { enabled: varnish, excluded: [], sites: {} }, varnishError: "", mainwp: mainwpView(mainwp), mainwpError: "",
  });
  const sites = [site("dashboard.test"), site("new.test", true, true), site("manual.test")];

  // No Dashboard yet: no MainWP column, no MainWP switch, only the picker.
  const fresh = page(sites, emptyMainwpState());
  expect(fresh.indexOf("wp-site-table")).toBeLessThan(fresh.indexOf("Automation"));
  expect(fresh).not.toContain('<th scope="col">MainWP</th>');
  expect(fresh).not.toContain("mainwp-automatic");
  expect(fresh).toContain('id="mainwp-dashboard"');
  expect(fresh).not.toContain("Application");
  expect(fresh).not.toContain("On another server");
  // A site without Varnish has an empty cell, and Automatic switches wait for their automation.
  expect(fresh).toContain('<td data-label="Varnish"></td>');
  expect(fresh).not.toContain("Varnish off");
  expect(fresh).not.toContain("setSiteAutomatic(this)");
  expect(fresh).toContain("Sign-in helper on 1 site · ");
  expect(page([site("a.test")], emptyMainwpState())).not.toContain("Sign-in helper");

  const chosen = emptyMainwpState(); chosen.dashboard = "dashboard.test";
  const off = page(sites, chosen);
  const heads = [...off.matchAll(/<th scope="col"[^>]*>([^<]*)<\/th>/g)].map((match) => match[1]);
  expect(heads).toEqual(["Site", "Varnish", "MainWP", ""]);
  expect(off).toContain("mainwp-automatic");
  expect(off).not.toContain("setMainwpSite(this)");
  expect(off).toMatch(/data-domain="new.test" onclick="connectMainwp\(this\)">Connect</);
  chosen.enabled = true;
  const on = page(sites, chosen, true);
  expect(on).toContain('id="mainwp-auto-new.test"');
  expect(on).not.toContain('id="mainwp-auto-dashboard.test"');
  expect(on).toContain('id="varnish-auto-new.test"');
  expect(on).not.toContain('id="varnish-auto-manual.test"');

  // A deleted Dashboard leaves the Child plugins the addon installed for cleanup to remove,
  // and automation without a Dashboard reads as off.
  const orphaned = emptyMainwpState(); orphaned.enabled = true;
  orphaned.sites["new.test"] = { status: "inactive", seen: true, checkedAt: "", error: "", ownedPlugin: true, ownedConnection: false,
    snapshot: { options: {}, meta: {}, admin: 1, active: false, tables: [], cron: {}, uploads: false } };
  saveMainwpState(run.statePath, orphaned);
  const reread = readMainwpState(run.statePath);
  expect(reread.enabled).toBe(false);
  const leftover = page(sites, reread);
  expect(leftover).toContain("cleanupMainwp()");
  expect(leftover).not.toContain("mainwp-automatic");

  // The shared search appears from six sites.
  expect(fresh).not.toContain('id="fleet-find"');
  const many = ["a", "b", "c", "d", "e", "f"].map((name) => site(`${name}.test`));
  expect(page(many, emptyMainwpState())).toContain('id="fleet-find"');
});

test("the shared runner does not disclose secret-bearing stderr", async () => {
  await expect(commandOutput({ argv: ["/bin/sh", "-c", "echo SECRET >&2; exit 1"], cwd: "/", env: {}, timeoutMs: 1000, stdin: "private", sensitive: true })).rejects.toThrow("the WordPress operation failed");
});

test("empty PHP arrays are valid baselines and registration interrupted before readback is recovered", async () => {
  await configured();
  children["new.test"]!.snapshot.options = [] as unknown as Record<string, string>;
  fail = "add";
  expect((await syncMainwp({ ...run, domain: "new.test" }, options)).failed).toHaveLength(1);
  fail = ""; commands = [];
  await syncMainwp({ ...run, domain: "new.test" }, options);
  expect(readMainwpState(run.statePath).sites["new.test"]).toMatchObject({ status: "connected", ownedConnection: true });
  expect(commands.some((c) => c.stdin?.includes('"op":"dashboard-add"'))).toBe(false);
});

test("pausing and excluding an interrupted site cannot prevent authentication recovery", async () => {
  await configured(); fail = "restore";
  await syncMainwp({ ...run, domain: "new.test" }, options);
  await configureMainwp(run, options, false);
  await mainwpAction(run, ["mainwp-site", "--domain=new.test", "--excluded=true"], options, (d) => d);
  fail = ""; commands = [];
  await syncMainwp({ ...run, dueOnly: true }, options);
  expect(children["new.test"]!.auth).toBe(true);
  expect(commands.filter((c) => c.stdin?.includes('"op":"status"'))).toHaveLength(1);
});

test("changing Dashboard preserves the seen bit for a manually removed plugin", async () => {
  await configured();
  const state = readMainwpState(run.statePath);
  state.sites["new.test"] = { status: "missing", seen: true, checkedAt: "", error: "", ownedPlugin: false, ownedConnection: false };
  saveMainwpState(run.statePath, state);
  await configureMainwp(run, options, true, "manual.test");
  await syncMainwp(run, options);
  expect(children["new.test"]!.installed).toBe(false);
  expect(readMainwpState(run.statePath).sites["new.test"]!.seen).toBe(true);
});

test("a large fleet leaves a bounded batch pending for the next pass", async () => {
  await configured();
  for (let i = 0; i < 80; i++) {
    const domain = `fleet${i}.test`;
    run.sites.push({ ...run.sites[1]!, domain }); run.domains.add(domain); children[domain] = status(); children[domain]!.installed = true;
  }
  const result = await syncMainwp(run, options);
  expect(result.pending).toBeGreaterThan(0);
  const request = commands.find((c) => c.stdin?.includes('"op":"dashboard-status"'))!;
  expect(JSON.parse(request.stdin!).domains.length).toBeLessThanOrEqual(64);
});

test("cleanup leaves a site connected since by someone else, and lets automation reinstall what it removed", async () => {
  await configured(); await syncMainwp(run, options);
  await mainwpAction(run, ["mainwp-connect", "--domain=manual.test", "--confirm=manual.test"], options, (d) => d);
  children["manual.test"]!.key = "b".repeat(64);
  const result = await syncMainwp(run, options, true);
  expect(result.failed).toEqual([]);
  expect(children["manual.test"]).toMatchObject({ installed: true, key: "b".repeat(64) });
  expect(children["new.test"]!.installed).toBe(false);
  const state = readMainwpState(run.statePath);
  expect(state.sites["manual.test"]).toMatchObject({ status: "not-connected", ownedConnection: false });
  expect(state.sites["manual.test"]!.snapshot).toBeUndefined();
  expect(state.sites["new.test"]).toMatchObject({ status: "missing", seen: false });
  expect(connections["manual.test"]).toBeUndefined();
});

test("a deleted Dashboard does not leave cleanup pending for ever", async () => {
  await configured(); await syncMainwp(run, options);
  run.domains.delete("dashboard.test"); run.sites = run.sites.filter((s) => s.domain !== "dashboard.test");
  expect((await syncMainwp(run, options, true)).failed).toEqual([]);
  expect(children["new.test"]!.installed).toBe(false);
  expect(readMainwpState(run.statePath)).toMatchObject({ cleanup: false, dashboard: "", enabled: false });
});

test("cleanup resumes after the Dashboard row disappears and preserves plugin removal intent", async () => {
  await configured();
  await syncMainwp(run, options);
  let artifact = true;
  let interrupted = true;
  const retryOptions = { runWpCommand: async (command: WpCommand) => {
    const reply = await options.runWpCommand(command);
    if (command.stdin && JSON.parse(command.stdin).op === "dashboard-remove") {
      if (interrupted) throw new Error("the Dashboard key file could not be removed");
      artifact = false;
    }
    return reply;
  } };
  expect((await syncMainwp(run, retryOptions, true)).failed).toHaveLength(1);
  expect(connections["new.test"]).toBeUndefined();
  expect(children["new.test"]!.installed).toBe(false);
  expect(readMainwpState(run.statePath).sites["new.test"]).toMatchObject({ seen: false, phase: "cleanup" });
  expect(artifact).toBe(true);
  interrupted = false;
  expect((await syncMainwp(run, retryOptions, true)).failed).toEqual([]);
  expect(artifact).toBe(false);
  expect(readMainwpState(run.statePath).cleanup).toBe(false);
  await configureMainwp(run, options, true);
  expect((await syncMainwp({ ...run, dueOnly: true }, options)).connected).toBe(1);
});

test("an unreadable MainWP state holds up disabling and says how to proceed", () => {
  writeFileSync(run.statePath, "{");
  expect(() => requireMainwpSettled(run.statePath)).toThrow(`${run.statePath} cannot be read`);
  expect(() => requireMainwpSettled(run.statePath)).toThrow("restore it from a backup and retry");
});

test("only an interrupted enrollment holds up disabling or uninstalling", async () => {
  await configured(); await syncMainwp(run, options);
  expect(() => requireMainwpSettled(run.statePath)).not.toThrow();
  fail = "restore";
  await syncMainwp({ ...run, domain: "manual.test" }, options);
  expect(() => requireMainwpSettled(run.statePath)).toThrow("interrupted");
  fail = "";
  await syncMainwp({ ...run, dueOnly: true }, options);
  expect(() => requireMainwpSettled(run.statePath)).not.toThrow();
  expect(readMainwpState(run.statePath).enabled).toBe(true);
});

test("cleanup restores children while the Dashboard is down and removes its records once it answers", async () => {
  await configured(); await syncMainwp(run, options);
  expect(connections["new.test"]).toBeDefined();
  const unavailable = { runWpCommand: async (command: WpCommand) => {
    if (command.stdin && JSON.parse(command.stdin).op === "dashboard-status") return 'CLP-ADDONS-MAINWP:{"error":"dashboard-unavailable"}';
    return options.runWpCommand(command);
  } };
  await syncMainwp(run, unavailable, true);
  expect(children["new.test"]).toMatchObject({ installed: false, key: "" });
  expect(readMainwpState(run.statePath)).toMatchObject({ cleanup: true, retired: [{ domain: "new.test" }] });
  expect(connections["new.test"]).toBeDefined();
  await syncMainwp(run, options, true);
  expect(connections["new.test"]).toBeUndefined();
  expect(connections["connected.test"]).toEqual({ id: 1, key });
  expect(readMainwpState(run.statePath)).toMatchObject({ cleanup: false, retired: [] });
});

test("cleanup waits for the Dashboard when only it can name an unconfirmed enrollment's record", async () => {
  await configured(); fail = "add";
  await syncMainwp({ ...run, domain: "new.test" }, options);
  fail = "";
  expect(readMainwpState(run.statePath).sites["new.test"]).toMatchObject({ ownedConnection: false });
  expect(connections["new.test"]).toBeDefined();
  const unavailable = { runWpCommand: async (command: WpCommand) => {
    if (command.stdin && JSON.parse(command.stdin).op === "dashboard-status") return 'CLP-ADDONS-MAINWP:{"error":"dashboard-unavailable"}';
    return options.runWpCommand(command);
  } };
  expect((await syncMainwp(run, unavailable, true)).failed).toHaveLength(1);
  expect(readMainwpState(run.statePath).sites["new.test"]!.token).toBeDefined();
  expect(readMainwpState(run.statePath).cleanup).toBe(true);
  await syncMainwp(run, options, true);
  expect(connections["new.test"]).toBeUndefined();
  expect(readMainwpState(run.statePath)).toMatchObject({ cleanup: false, retired: [] });
});

test("restoring authentication permits withdrawal even while the Dashboard is unavailable", async () => {
  await configured();
  fail = "restore";
  await syncMainwp({ ...run, domain: "manual.test" }, options);
  expect(() => requireMainwpSettled(run.statePath)).toThrow("interrupted");
  fail = "";
  const unavailable = { runWpCommand: async (command: WpCommand) => {
    if (command.stdin && JSON.parse(command.stdin).op === "dashboard-status") {
      return 'CLP-ADDONS-MAINWP:{"error":"dashboard-unavailable"}';
    }
    return options.runWpCommand(command);
  } };
  await syncMainwp({ ...run, dueOnly: true }, unavailable);
  expect(children["manual.test"]!.auth).toBe(true);
  expect(() => requireMainwpSettled(run.statePath)).not.toThrow();
  expect(readMainwpState(run.statePath).sites["manual.test"]).toMatchObject({ phase: "restored", ownedConnection: true });
  commands = [];
  await syncMainwp({ ...run, dueOnly: true }, unavailable);
  expect(commands.some((command) => command.stdin?.includes('"op":"restore-auth"'))).toBe(false);
  await syncMainwp({ ...run, dueOnly: true }, options);
  expect(readMainwpState(run.statePath).sites["manual.test"]!.phase).toBeUndefined();
});

test("a Dashboard timeout cannot spend the budget before interrupted authentication is recovered", async () => {
  await configured();
  fail = "restore";
  await syncMainwp({ ...run, domain: "manual.test" }, options);
  fail = "";
  for (let index = 0; index < 80; index++) {
    const domain = `pending${index}.test`;
    run.sites.push({ ...run.sites[1]!, domain });
    run.domains.add(domain);
    children[domain] = status();
  }
  const realNow = Date.now;
  let elapsed = 0;
  const operations: string[] = [];
  const timeout = { runWpCommand: async (command: WpCommand) => {
    const operation = JSON.parse(command.stdin!).op;
    operations.push(operation);
    if (operation === "dashboard-status") {
      elapsed += 25_000;
      throw new Error("WP-CLI timed out");
    }
    return options.runWpCommand(command);
  } };
  try {
    Date.now = () => realNow() + elapsed;
    for (let pass = 0; pass < 3; pass++) {
      await syncMainwp({ ...run, dueOnly: true }, timeout);
      expect(children["manual.test"]!.auth).toBe(true);
      expect(() => requireMainwpSettled(run.statePath)).not.toThrow();
    }
  } finally {
    Date.now = realNow;
  }
  expect(operations[0]).toBe("restore-auth");
  expect(operations.filter((operation) => operation === "restore-auth")).toHaveLength(1);
});

test("a login the Dashboard would store is checked, and a site's own error text is never repeated", async () => {
  await configured();
  children["new.test"]!.admin = "<script>";
  expect((await syncMainwp({ ...run, domain: "new.test" }, options)).failed[0]).toContain("no administrator");
  expect(commands.some((c) => c.stdin?.includes('"op":"dashboard-add"'))).toBe(false);
  const spoofing = { runWpCommand: async () => `CLP-ADDONS-MAINWP:${JSON.stringify({ error: "token 0123 leaked" })}` };
  expect((await syncMainwp({ ...run, domain: "manual.test" }, spoofing)).failed[0]).not.toContain("leaked");
});


test("an unconfirmed registration ties the addon to its Dashboard until cleanup", async () => {
  await configured(); fail = "add";
  await syncMainwp({ ...run, domain: "new.test" }, options);
  fail = "";
  expect(readMainwpState(run.statePath).sites["new.test"]).toMatchObject({ ownedConnection: false });
  expect(mainwpView(readMainwpState(run.statePath)).connections).toBe(1);
  await expect(configureMainwp(run, options, false, "manual.test")).rejects.toThrow("clean up the MainWP connections");
});


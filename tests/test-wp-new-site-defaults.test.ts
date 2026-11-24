import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeWpToolsAction, pruneWpJobs, type AccountPluginDefaults, type WpToolsActionOptions } from "../addons/wp-tools/action";
import { handle } from "../addons/wp-tools/app/index";
import { wpToolsService } from "../addons/wp-tools/app/service";
import { emptyMainwpState } from "../addons/wp-tools/mainwp";
import { webVerb } from "../lib/gateway-protocol";
import { acquireFileLockSync } from "../lib/file-lock";
import { dashboardBody } from "../addons/wp-tools/app/views";
import type { WpDashboard } from "../addons/wp-tools/app/service";
import { readPluginDefaults } from "../addons/wp-tools/new-site-defaults";

let root = "";

function options(extra: Partial<WpToolsActionOptions> = {}): WpToolsActionOptions {
  return {
    processUid: 0,
    paths: {
      configFile: join(root, "wp-tools.conf"), panelDb: join(root, "panel.sq3"), passwd: join(root, "passwd"),
      lockFile: join(root, "wp.lock"), varnishState: join(root, "varnish.json"), varnishLockFile: join(root, "wp-varnish.lock"),
      mainwpState: join(root, "mainwp.json"), mainwpLockFile: join(root, "wp-mainwp.lock"), domainLinkState: join(root, "domain-link.json"),
      jobsDir: join(root, "jobs"), jobsLockFile: join(root, "wp-jobs.lock"), uploadsDir: join(root, "uploads"),
      pluginsLockFile: join(root, "wp-plugins.lock"), newSiteAccessState: join(root, "new-site-access.json"),
      pluginDefaultsState: join(root, "plugin-defaults.json"), pluginDefaultsLockFile: join(root, "wp-plugin-defaults.lock"),
    },
    ...extra,
  };
}

async function act<T = unknown>(argv: string[], input?: unknown): Promise<T> {
  return await executeWpToolsAction(argv, options(input === undefined ? {} : { input: JSON.stringify(input) })) as T;
}

const yoast = { slug: "wordpress-seo", name: "Yoast SEO", activate: true };
const forms = { slug: "contact-form-7", name: "Contact Form 7", activate: false };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "clp-wp-defaults-"));
  writeFileSync(join(root, "wp-tools.conf"), "");
  writeFileSync(join(root, "passwd"), "");
  const db = new Database(join(root, "panel.sq3"), { create: true });
  db.exec(`
    CREATE TABLE site (id INTEGER PRIMARY KEY, type TEXT, domain_name TEXT, root_directory TEXT, user TEXT, application TEXT, varnish_cache INTEGER, created_at TEXT);
    CREATE TABLE user (id INTEGER PRIMARY KEY, user_name TEXT, role TEXT, status INTEGER);
    INSERT INTO user VALUES (1, 'admin', 'ROLE_ADMIN', 1), (2, 'mgr', 'ROLE_SITE_MANAGER', 1), (3, 'client', 'ROLE_USER', 1),
      (4, 'gone', 'ROLE_SITE_MANAGER', 0), (5, '__proto__', 'ROLE_ADMIN', 1), (6, 'other', 'ROLE_ADMIN', 1);
  `);
  db.close();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test("the gateway reads whose default it is from the session, and only an administrator sets the server's", () => {
  expect(webVerb("wp-tools", "new-site-defaults")?.web).toBe("admin");
  expect(webVerb("wp-tools", "my-new-site-defaults")?.web).toBe("own-account");
  expect(webVerb("wp-tools", "save-my-new-site-defaults")?.web).toBe("own-account");
});

test("the server's default is WordPress.org plugins, kept in root-only storage and shown on the page", async () => {
  const saved = await act<{ pluginDefaults: { server: unknown[]; automatic: string[] } }>(["new-site-defaults"], { plugins: [yoast, { ...forms, name: "  Contact\nForm 7 " }] });
  expect(saved.pluginDefaults).toEqual({ server: [yoast, forms], automatic: [] });
  expect(statSync(join(root, "plugin-defaults.json")).mode & 0o777).toBe(0o600);
  expect(await act(["sites"])).toMatchObject({ pluginDefaults: { server: [yoast, forms], automatic: [] }, pluginDefaultsError: "" });

  const refused: [unknown, string][] = [
    [{ plugins: [{ ...yoast, slug: "../x" }] }, "not a WordPress.org plugin slug"],
    [{ plugins: [{ ...yoast, slug: "Woo" }] }, "not a WordPress.org plugin slug"],
    [{ plugins: [{ ...yoast, activate: "yes" }] }, "activate must be true or false"],
    [{ plugins: [yoast, yoast] }, "twice"],
    [{ plugins: Array.from({ length: 21 }, (_, i) => ({ slug: `p${i}`, name: "", activate: true })) }, "at most 20"],
    [{ plugins: "wordpress-seo" }, "must be a list"],
  ];
  for (const [input, error] of refused) await expect(act(["new-site-defaults"], input)).rejects.toThrow(error);
  await expect(act(["new-site-defaults", "--plugins=wordpress-seo:1"], { plugins: [] })).rejects.toThrow("on stdin");
  await expect(act(["new-site-defaults", "--panel-user=admin"], { plugins: [] })).rejects.toThrow("on stdin");
  rmSync(join(root, "wp-tools.conf"));
  await expect(act(["new-site-defaults"], { plugins: [] })).rejects.toThrow("must be enabled");
});

test("a plugin automation installs on every new site cannot be a default while that automation is on", async () => {
  writeFileSync(join(root, "varnish.json"), JSON.stringify({ enabled: true, sites: {} }));
  writeFileSync(join(root, "mainwp.json"), JSON.stringify({ ...emptyMainwpState(), enabled: true, dashboard: "dashboard.example.com" }));
  for (const slug of ["clp-varnish-cache", "mainwp-child"]) {
    const plugins = [yoast, { slug, name: slug, activate: true }];
    await expect(act(["new-site-defaults"], { plugins })).rejects.toThrow(`${slug} is installed on new sites by WordPress Tools' automation`);
    await expect(act(["save-my-new-site-defaults", "--panel-user=admin"], { plugins })).rejects.toThrow(`${slug} is installed on new sites`);
  }
  // Saved before automation was on, it stays, and the form is told to leave it to automation.
  writeFileSync(join(root, "plugin-defaults.json"), JSON.stringify({ server: [{ slug: "mainwp-child", name: "MainWP Child", activate: true }], accounts: [] }));
  expect(await act<AccountPluginDefaults>(["my-new-site-defaults", "--panel-user=admin"])).toEqual({
    server: [{ slug: "mainwp-child", name: "MainWP Child", activate: true }], account: null, automatic: ["clp-varnish-cache", "mainwp-child"],
  });
});

test("an account's own default is its own, distinct from an empty one, and reset follows the server's again", async () => {
  await act(["new-site-defaults"], { plugins: [yoast] });
  expect(await act<AccountPluginDefaults>(["my-new-site-defaults", "--panel-user=admin"])).toEqual({ server: [yoast], account: null, automatic: [] });
  expect(await act<AccountPluginDefaults>(["save-my-new-site-defaults", "--panel-user=admin"], { plugins: [] })).toEqual({ server: [yoast], account: [], automatic: [] });
  expect((await act<AccountPluginDefaults>(["my-new-site-defaults", "--panel-user=admin"])).account).toEqual([]);
  // Another account, and one whose name is an object's own key, keep theirs apart.
  await act(["save-my-new-site-defaults", "--panel-user=__proto__"], { plugins: [forms] });
  expect((await act<AccountPluginDefaults>(["my-new-site-defaults", "--panel-user=__proto__"])).account).toEqual([forms]);
  expect((await act<AccountPluginDefaults>(["my-new-site-defaults", "--panel-user=other"])).account).toBeNull();
  // The server's default changing leaves the accounts' own alone.
  await act(["new-site-defaults"], { plugins: [forms] });
  expect(await act<AccountPluginDefaults>(["my-new-site-defaults", "--panel-user=__proto__"])).toEqual({ server: [forms], account: [forms], automatic: [] });
  expect(await act<AccountPluginDefaults>(["save-my-new-site-defaults", "--panel-user=admin"], { plugins: null })).toEqual({ server: [forms], account: null, automatic: [] });
  expect(JSON.parse(readFileSync(join(root, "plugin-defaults.json"), "utf8")).accounts).toEqual([{ user: "__proto__", plugins: [forms] }]);
});

test("an account's default is an administrator's, or a site manager's only while allowed, and named only by the gateway", async () => {
  await expect(act(["my-new-site-defaults", "--panel-user=mgr"])).rejects.toThrow("has not let site managers");
  await expect(act(["save-my-new-site-defaults", "--panel-user=mgr"], { plugins: [yoast] })).rejects.toThrow("has not let site managers");
  await act(["new-site-settings", "--site-managers=true"]);
  expect(await act<AccountPluginDefaults>(["save-my-new-site-defaults", "--panel-user=mgr"], { plugins: [yoast] })).toMatchObject({ account: [yoast] });
  // CloudPanel's own record of the account decides, not the session that named it.
  for (const user of ["client", "gone", "nobody"]) {
    await expect(act(["my-new-site-defaults", `--panel-user=${user}`])).rejects.toThrow("only administrators and site managers");
    await expect(act(["save-my-new-site-defaults", `--panel-user=${user}`], { plugins: [] })).rejects.toThrow("only administrators and site managers");
  }
  for (const argv of [
    ["my-new-site-defaults"], ["my-new-site-defaults", "--panel-user=bad name"], ["my-new-site-defaults", "--panel-user=../admin"],
    ["my-new-site-defaults", "--panel-user=admin", "--as-user=mgr"], ["save-my-new-site-defaults", "--as-user=admin"],
  ]) {
    await expect(act(argv, { plugins: [] })).rejects.toThrow("takes only --panel-user");
  }
  writeFileSync(join(root, "plugin-defaults.json"), "{");
  await expect(act(["my-new-site-defaults", "--panel-user=admin"])).rejects.toThrow("cannot be read");
  await expect(act(["save-my-new-site-defaults", "--panel-user=admin"], { plugins: [] })).rejects.toThrow("cannot be read");
  expect(((await act<{ pluginDefaultsError: string }>(["sites"])).pluginDefaultsError)).toContain("cannot be read");
  // Saving the server's default is how an administrator replaces it.
  await act(["new-site-defaults"], { plugins: [yoast] });
  expect(await act<AccountPluginDefaults>(["my-new-site-defaults", "--panel-user=admin"])).toEqual({ server: [yoast], account: null, automatic: [] });
});

test("a site manager's own default is refused again once the switch is off, and kept for when it is back on", async () => {
  await act(["new-site-settings", "--site-managers=true"]);
  await act(["save-my-new-site-defaults", "--panel-user=mgr"], { plugins: [yoast] });
  await act(["new-site-settings", "--site-managers=false"]);
  await expect(act(["my-new-site-defaults", "--panel-user=mgr"])).rejects.toThrow("has not let site managers");
  await expect(act(["save-my-new-site-defaults", "--panel-user=mgr"], { plugins: null })).rejects.toThrow("has not let site managers");
  await act(["new-site-settings", "--site-managers=true"]);
  expect((await act<AccountPluginDefaults>(["my-new-site-defaults", "--panel-user=mgr"])).account).toEqual([yoast]);
});

test("a state file of any other shape cannot be read", () => {
  for (const content of ["null", "[]", "{}", '{"server":[],"accounts":{}}', '{"server":[],"accounts":[{"user":1,"plugins":[]}]}', '{"server":[{"slug":"../x","activate":true}],"accounts":[]}']) {
    writeFileSync(join(root, "plugin-defaults.json"), content);
    expect(() => readPluginDefaults(join(root, "plugin-defaults.json"))).toThrow();
  }
  rmSync(join(root, "plugin-defaults.json"));
  expect(readPluginDefaults(join(root, "plugin-defaults.json"))).toEqual({ server: [], accounts: [] });
});

test("repair's upkeep drops the own default of an account CloudPanel no longer has", async () => {
  await act(["save-my-new-site-defaults", "--panel-user=admin"], { plugins: [yoast] });
  await act(["save-my-new-site-defaults", "--panel-user=other"], { plugins: [forms] });
  const db = new Database(join(root, "panel.sq3"));
  db.run("DELETE FROM user WHERE user_name = 'other'");
  db.close();
  pruneWpJobs(options());
  expect(JSON.parse(readFileSync(join(root, "plugin-defaults.json"), "utf8")).accounts).toEqual([{ user: "admin", plugins: [yoast] }]);
  // A panel that lists no account is a bad read, not a reason to forget them all.
  const empty = new Database(join(root, "panel.sq3"));
  empty.run("DELETE FROM user");
  empty.close();
  pruneWpJobs(options());
  expect(JSON.parse(readFileSync(join(root, "plugin-defaults.json"), "utf8")).accounts).toHaveLength(1);
  // A file it cannot read is left for an administrator to replace.
  writeFileSync(join(root, "plugin-defaults.json"), "{");
  pruneWpJobs(options());
  expect(readFileSync(join(root, "plugin-defaults.json"), "utf8")).toBe("{");
});

test("defaults use their own lock file so plugin uploads and choices never contend with them", async () => {
  const pluginsLock = acquireFileLockSync(join(root, "wp-plugins.lock"), 1, "busy");
  try {
    expect(await act<{ pluginDefaults: { server: unknown[] } }>(["new-site-defaults"], { plugins: [yoast] }))
      .toMatchObject({ pluginDefaults: { server: [yoast] } });
    expect(await act<AccountPluginDefaults>(["save-my-new-site-defaults", "--panel-user=admin"], { plugins: [forms] }))
      .toMatchObject({ account: [forms] });
  } finally {
    pluginsLock.release();
  }
});

test("the WordPress Tools page draws the server's default, escaped, with a plugin automation installs marked as such", () => {
  const data = {
    sites: [], varnish: { enabled: true, sites: {} }, varnishError: "", mainwp: emptyMainwpState() as never, mainwpError: "",
    domainLink: { signIn: true }, domainLinkError: "", jobs: { varnish: null, mainwp: null },
    pluginDefaults: { server: [{ slug: "clp-varnish-cache", name: "CLP Varnish Cache", activate: true }, { slug: "evil", name: "<img src=x onerror=alert(1)>", activate: false }], automatic: ["clp-varnish-cache"] },
    pluginDefaultsError: "",
  } as unknown as WpDashboard;
  const html = dashboardBody(data);
  const rows = [...html.matchAll(/<li data-slug="([^"]+)"[\s\S]*?<\/li>/g)].map((match) => match[0]);
  expect(rows).toHaveLength(2);
  expect(rows[0]).toContain(">Automatic</span>");
  expect(rows[0]).not.toContain('type="checkbox"');
  expect(rows[1]).toContain('type="checkbox" onchange="setDefaultActivate(this)"');
  expect(html).not.toContain("<img src=x");
  expect(html).toContain('id="wp-default-plugins"');
  expect(html).toContain('data-automatic="clp-varnish-cache"');
  expect(html).not.toMatch(/data-section-tab="new-sites"[^>]*>[^<]*<span class="section-dot/);
  const broken = dashboardBody({ ...data, pluginDefaults: { server: [], automatic: [] }, pluginDefaultsError: "/var/lib/clp-addons/wp-tools/plugin-defaults.json cannot be read: x" });
  expect(broken).toContain("Adding a plugin below replaces the file, and with it each account's own default.");
  expect(broken).toMatch(/data-section-tab="new-sites"[^>]*>New sites<span class="section-dot tone-bad"/);
});

// --- the manager's routes -------------------------------------------------

const originals = { ...wpToolsService };
afterEach(() => Object.assign(wpToolsService, originals));

const SESSION = "abc123,def";
const userOf = (roles: string[]) => roles.includes("ROLE_ADMIN") ? "admin" : roles.includes("ROLE_SITE_MANAGER") ? "mgr" : "someone";

function request(method: string, path: string, roles: string[], body?: unknown, session = true) {
  const csrf = "a".repeat(64);
  const cookies = [`clp_addons_csrf=${csrf}`, ...(session ? [`cloudpanel=${SESSION}`] : [])].join("; ");
  return handle(new Request(`https://panel.example.com/addons/wp-tools${path}`, {
    method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: { Host: "panel.example.com", Origin: "https://panel.example.com", Cookie: cookies, "X-CLP-Addons-CSRF": csrf, "Content-Type": "application/json" },
  }), path, undefined, undefined, { user: userOf(roles), roles });
}

test("a panel user reaches no default, and only an administrator sets the server's", async () => {
  const called: unknown[] = [];
  wpToolsService.myNewSiteDefaults = async (session) => { called.push(["mine", session]); return { ok: true }; };
  wpToolsService.saveMyNewSiteDefaults = async (session, plugins) => { called.push(["save", session, plugins]); return { ok: true }; };
  wpToolsService.saveNewSiteDefaults = async (plugins) => { called.push(["server", plugins]); return { ok: true }; };
  for (const roles of [["ROLE_USER"], ["ROLE_SITE_MANAGER"]]) {
    expect((await request("POST", "/api/new-site-defaults", roles, { plugins: [yoast] })).status).toBe(404);
  }
  expect((await request("GET", "/api/my-new-site-defaults", ["ROLE_USER"])).status).toBe(404);
  expect((await request("POST", "/api/my-new-site-defaults", ["ROLE_USER"], { plugins: [] })).status).toBe(404);
  // Without the panel's session cookie there is nothing for the gateway to check.
  expect((await request("GET", "/api/my-new-site-defaults", ["ROLE_SITE_MANAGER"], undefined, false)).status).toBe(404);
  expect(called).toEqual([]);
});

test("the default routes check the list before root sees it and hand on the session, never a name", async () => {
  const called: unknown[] = [];
  wpToolsService.myNewSiteDefaults = async (session) => { called.push(["mine", session]); return { ok: true, data: { server: [], account: null, automatic: [] } }; };
  wpToolsService.saveMyNewSiteDefaults = async (session, plugins) => { called.push(["save", session, plugins]); return { ok: true }; };
  wpToolsService.saveNewSiteDefaults = async (plugins) => { called.push(["server", plugins]); return { ok: true }; };
  for (const body of [{ plugins: [{ ...yoast, slug: "../x" }] }, { plugins: [yoast, yoast] }, {}, { plugins: null }]) {
    expect((await request("POST", "/api/my-new-site-defaults", ["ROLE_SITE_MANAGER"], body)).status).toBe(400);
    expect((await request("POST", "/api/new-site-defaults", ["ROLE_ADMIN"], body)).status).toBe(400);
  }
  expect(called).toEqual([]);
  expect((await request("GET", "/api/my-new-site-defaults", ["ROLE_SITE_MANAGER"])).status).toBe(200);
  expect((await request("POST", "/api/my-new-site-defaults", ["ROLE_SITE_MANAGER"], { plugins: [yoast] })).status).toBe(200);
  expect((await request("POST", "/api/my-new-site-defaults", ["ROLE_ADMIN"], { reset: true })).status).toBe(200);
  expect((await request("POST", "/api/new-site-defaults", ["ROLE_ADMIN"], { plugins: [forms] })).status).toBe(200);
  expect(called).toEqual([["mine", SESSION], ["save", SESSION, [yoast]], ["save", SESSION, null], ["server", [forms]]]);
  // A cross-site write is refused before anything is read.
  const forged = await handle(new Request("https://panel.example.com/addons/wp-tools/api/my-new-site-defaults", {
    method: "POST", body: JSON.stringify({ plugins: [] }), headers: { Host: "panel.example.com", Origin: "https://evil.example", Cookie: `cloudpanel=${SESSION}` },
  }), "/api/my-new-site-defaults", undefined, undefined, { user: "admin", roles: ["ROLE_ADMIN"] });
  expect(forged.status).toBe(403);
  expect(called).toHaveLength(4);
});

// --- the form's script ----------------------------------------------------

interface FakeNode {
  [key: string]: any;
}

/**
 * What WordPress Tools answers the form: data, an Error for a refusal, or
 * undefined for a request that has not answered yet.
 */
type Respond = (path: string, body: unknown) => unknown;

/** The New WordPress Site form's script against a stand-in document. */
function formScript(stored: Record<string, string>, respond: Respond, options: { admin?: boolean } = {}) {
  const listeners: Record<string, ((event: unknown) => void)[]> = {};
  const node = (): FakeNode => ({
    hidden: false, textContent: "", value: "", style: {}, files: [] as unknown[], children: [] as FakeNode[], disabled: false,
    classList: { add() {}, remove() {} },
    addEventListener(type: string, fn: (event: unknown) => void) { (this.listeners ??= {})[type] = [...(this.listeners[type] ?? []), fn]; },
    appendChild(child: FakeNode) { this.children.push(child); }, setAttribute() {}, getAttribute: () => "/addons/wp-tools", querySelectorAll: () => [],
  });
  const form = node();
  const domain = Object.assign(node(), { value: "new.example.test" });
  form.querySelector = () => domain;
  let resubmitted = 0;
  form.requestSubmit = () => { resubmitted++; };
  const ids = ["clp-wp-plugins", "clp-wp-plugin-search", "clp-wp-plugin-results", "clp-wp-plugin-chosen", "clp-wp-plugins-error",
    "clp-wp-plugins-defaults", "clp-wp-plugins-origin", "clp-wp-plugins-save", "clp-wp-plugins-reset", ...(options.admin ? ["clp-wp-plugin-file"] : [])];
  const nodes: Record<string, FakeNode> = Object.fromEntries(ids.map((id) => [id, node()]));
  nodes["clp-wp-plugins"]!.closest = () => form;
  const chosen = nodes["clp-wp-plugin-chosen"]!;
  Object.defineProperty(chosen, "textContent", { set() { chosen.children = []; }, get: () => "" });
  const document = {
    cookie: "clp_addons_csrf=token", getElementById: (id: string) => nodes[id], createElement: node,
    addEventListener: (type: string, fn: (event: unknown) => void) => { (listeners[type] ??= []).push(fn); },
  };
  const storage = new Map(Object.entries(stored));
  const sessionStorage = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) };
  const sent: { path: string; body?: unknown }[] = [];
  const fetch = (url: string, init?: { body?: unknown }) => {
    const path = url.slice("/addons/wp-tools".length);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    sent.push({ path, body });
    const answer = respond(path, body);
    if (answer === undefined) return new Promise(() => {});
    const wrap = (value: unknown) => ({ json: () => Promise.resolve(value instanceof Error ? { ok: false, error: value.message } : { ok: true, data: value }) });
    return answer instanceof Promise ? answer.then(wrap) : Promise.resolve(wrap(answer));
  };
  const source = readFileSync(join(import.meta.dir, "../addons/wp-tools/inject/new-site.client.js"), "utf8");
  new Function("document", "sessionStorage", "fetch", source)(document, sessionStorage, fetch);
  const rows = () => chosen.children.map((row: FakeNode) => row.children[0].textContent + ((row.children.some((child: FakeNode) => child.className === "clp-wp-plugin-automatic") ? " (automatic)" : "")));
  const submit = () => {
    let stopped = false;
    const event = { target: form, preventDefault() { stopped = true; }, stopImmediatePropagation() {} };
    for (const fn of listeners.submit!) fn(event);
    return stopped;
  };
  const click = (id: string) => nodes[id]!.listeners.click[0]();
  const remove = (name: string) => {
    const row = chosen.children.find((entry: FakeNode) => entry.children[0].textContent === name);
    row.children[row.children.length - 1].listeners.click[0]();
  };
  const shown = (id: string) => !nodes[id]!.hidden;
  return { nodes, storage, sent, rows, submit, click, remove, shown, resubmitted: () => resubmitted };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
const mine = { slug: "woocommerce", name: "WooCommerce", activate: true };
const CHOICE = "clp-addons-new-site-plugins";
const JOB = "clp-addons-new-site-job";
/** Answers the defaults, and records anything else. */
const defaultsOf = (defaults: unknown, saved?: (body: any) => unknown): Respond => (path, body) =>
  path === "/api/my-new-site-defaults" ? (body && saved ? saved(body) : defaults) : path === "/api/new-site" ? { job: null } : undefined;

test("the form starts from the account's own default, else the server's, and a form sent back keeps its own choice once", async () => {
  const server = formScript({}, defaultsOf({ server: [yoast, forms], account: null, automatic: [] }));
  await settle();
  expect(server.rows()).toEqual(["Yoast SEO", "Contact Form 7"]);
  expect([server.nodes["clp-wp-plugins-origin"]!.textContent, server.shown("clp-wp-plugins-save"), server.shown("clp-wp-plugins-reset")]).toEqual(["Server default", false, false]);

  const own = formScript({}, defaultsOf({ server: [yoast], account: [mine], automatic: [] }));
  await settle();
  expect(own.rows()).toEqual(["WooCommerce"]);
  expect([own.nodes["clp-wp-plugins-origin"]!.textContent, own.shown("clp-wp-plugins-reset")]).toEqual(["Your default", true]);

  // An own default that is empty is not the server's.
  const none = formScript({}, defaultsOf({ server: [yoast], account: [], automatic: [] }));
  await settle();
  expect(none.rows()).toEqual([]);

  // A form CloudPanel sent back keeps what was chosen on it, even nothing, and only that once.
  const kept = formScript({ [CHOICE]: JSON.stringify([{ source: "wordpress.org", ...forms }]) }, defaultsOf({ server: [yoast], account: [mine], automatic: [] }));
  await settle();
  expect(kept.rows()).toEqual(["Contact Form 7"]);
  expect(kept.shown("clp-wp-plugins-save")).toBe(true);
  expect(kept.storage.has(CHOICE)).toBe(false);
  const emptied = formScript({ [CHOICE]: "[]" }, defaultsOf({ server: [yoast], account: null, automatic: [] }));
  await settle();
  expect(emptied.rows()).toEqual([]);
});

test("a choice is left for the form CloudPanel may send back only as the form goes, so an abandoned one is not", async () => {
  const form = formScript({}, defaultsOf({ server: [yoast, forms], account: null, automatic: [] }));
  await settle();
  form.remove("Yoast SEO");
  expect(form.storage.has(CHOICE)).toBe(false);
  expect(form.submit()).toBe(true);
  await settle();
  expect(JSON.parse(form.storage.get(CHOICE)!)).toEqual([{ source: "wordpress.org", ...forms }]);
  expect(form.resubmitted()).toBe(1);

  // Sent with nothing on it, CloudPanel's own submit goes ahead, and a form it sends back stays empty.
  const empty = formScript({}, defaultsOf({ server: [yoast], account: null, automatic: [] }));
  await settle();
  empty.remove("Yoast SEO");
  expect(empty.submit()).toBe(false);
  expect(empty.storage.get(CHOICE)).toBe("[]");
});

test("a submit made before the defaults answer waits for them", async () => {
  let answer: unknown;
  const form = formScript({}, (path) => path === "/api/my-new-site-defaults" ? answer : path === "/api/new-site" ? { job: { id: "j1" } } : undefined);
  expect(form.submit()).toBe(true);
  expect(form.sent.some((call) => call.path === "/api/new-site")).toBe(false);
  expect(form.resubmitted()).toBe(0);
  answer = { server: [yoast], account: null, automatic: [] };
  const late = formScript({}, (path) => path === "/api/my-new-site-defaults" ? answer : path === "/api/new-site" ? { job: { id: "j1" } } : undefined);
  late.submit();
  await settle();
  expect(late.resubmitted()).toBe(1);
  // Resubmitted, the form goes with the defaults on it.
  late.submit();
  await settle();
  expect(late.sent.find((call) => call.path === "/api/new-site")?.body).toEqual({ domain: "new.example.test", plugins: [{ slug: "wordpress-seo", activate: true }], uploads: [] });

  // Defaults that cannot be loaded say so, and the form still works without them.
  const failed = formScript({}, (path) => path === "/api/my-new-site-defaults" ? new Error("the default plugins cannot be read") : undefined);
  await settle();
  expect(failed.nodes["clp-wp-plugins-error"]!.textContent).toBe("The default plugins could not be loaded: the default plugins cannot be read.");
  expect(failed.submit()).toBe(false);

  // Even a malformed reply that throws while applying defaults still clears loading so Create is never stuck.
  const broken = formScript({}, (path) => path === "/api/my-new-site-defaults" ? { server: "not-a-list", account: null, automatic: [] } : undefined);
  expect(broken.submit()).toBe(true);
  await settle();
  expect(broken.resubmitted()).toBe(1);
  expect(broken.submit()).toBe(false);
});

test("a default plugin automation now installs is shown as such, left out of what the form sends, and can be dropped from a default", async () => {
  const automatic = { slug: "clp-varnish-cache", name: "CLP Varnish Cache", activate: true };
  const saves: unknown[] = [];
  const form = formScript({}, defaultsOf({ server: [yoast], account: [automatic, yoast], automatic: ["clp-varnish-cache"] }, (body) => {
    saves.push(body);
    return { server: [yoast], account: [yoast], automatic: ["clp-varnish-cache"] };
  }));
  await settle();
  expect(form.rows()).toEqual(["CLP Varnish Cache (automatic)", "Yoast SEO"]);
  expect(form.shown("clp-wp-plugins-save")).toBe(false);
  // Removing it is a change to the default that can be saved.
  form.remove("CLP Varnish Cache");
  expect(form.shown("clp-wp-plugins-save")).toBe(true);
  form.click("clp-wp-plugins-save");
  await settle();
  expect(saves).toEqual([{ plugins: [yoast] }]);
  expect([form.nodes["clp-wp-plugins-origin"]!.textContent, form.shown("clp-wp-plugins-save")]).toEqual(["Saved as your default", false]);

  // Saved with it still on the form, it is left out of the default and taken off the form.
  const restored = formScript({ [CHOICE]: JSON.stringify([{ source: "wordpress.org", ...automatic }, { source: "wordpress.org", ...yoast }]) },
    defaultsOf({ server: [], account: null, automatic: ["clp-varnish-cache"] }, (body) => { saves.push(body); return { server: [], account: [yoast], automatic: ["clp-varnish-cache"] }; }));
  await settle();
  restored.click("clp-wp-plugins-save");
  await settle();
  expect(saves[1]).toEqual({ plugins: [yoast] });
  expect(restored.rows()).toEqual(["Yoast SEO"]);

  // Only plugins automation installs left on the form: nothing is sent, but an earlier choice for the domain is cleared.
  const only = formScript({ [JOB]: JSON.stringify({ domain: "new.example.test", id: "j0" }) }, defaultsOf({ server: [automatic], account: null, automatic: ["clp-varnish-cache"] }));
  await settle();
  expect(only.submit()).toBe(true);
  await settle();
  expect(only.sent.find((call) => call.path === "/api/new-site")?.body).toEqual({ domain: "new.example.test", plugins: [], uploads: [] });
});

test("Reset fills the row from the server's default, keeping uploaded zips and never naming a plugin twice", async () => {
  const form = formScript({ [CHOICE]: JSON.stringify([
    { source: "wordpress.org", ...mine },
    { source: "upload", slug: "wordpress-seo", name: "Yoast SEO Premium", activate: true, id: "a".repeat(32) },
  ]) }, defaultsOf({ server: [yoast, forms], account: [mine], automatic: [] }, () => ({ server: [yoast, forms], account: null, automatic: [] })), { admin: true });
  await settle();
  form.click("clp-wp-plugins-reset");
  await settle();
  // The upload of the same plugin wins over the server's WordPress.org copy.
  expect(form.rows()).toEqual(["Contact Form 7", "Yoast SEO Premium"]);
  expect(form.shown("clp-wp-plugins-reset")).toBe(false);
  expect(form.storage.has(CHOICE)).toBe(false);

  // While a zip is still uploading its slug is unknown, so Reset waits for the upload first.
  let finishUpload!: (value: unknown) => void;
  const uploading = formScript({}, (path, body) => {
    if (path === "/api/plugin-upload") return new Promise((resolve) => { finishUpload = resolve; });
    return defaultsOf({ server: [yoast, forms], account: [mine], automatic: [] }, () => ({ server: [yoast, forms], account: null, automatic: [] }))(path, body);
  }, { admin: true });
  await settle();
  const file = uploading.nodes["clp-wp-plugin-file"]!;
  file.files = [{ name: "yoast-premium.zip", size: 1024 }];
  file.listeners.change[0]();
  expect(uploading.rows()).toEqual(["WooCommerce", "yoast-premium.zip"]);
  uploading.click("clp-wp-plugins-reset");
  await settle();
  expect(uploading.nodes["clp-wp-plugins-error"]!.textContent).toBe("Wait for the upload to finish, then reset.");
  expect(uploading.sent.some((call) => call.path === "/api/my-new-site-defaults" && call.body !== undefined)).toBe(false);
  expect(uploading.rows()).toEqual(["WooCommerce", "yoast-premium.zip"]);
  // Once the upload finishes, Reset keeps it and drops the server default with the same slug.
  finishUpload({ upload: { id: "b".repeat(32), slug: "wordpress-seo", name: "Yoast SEO Premium", version: "2.0" } });
  await settle();
  uploading.click("clp-wp-plugins-reset");
  await settle();
  expect(uploading.rows()).toEqual(["Contact Form 7", "Yoast SEO Premium 2.0"]);
  expect(uploading.shown("clp-wp-plugins-reset")).toBe(false);
});

test("Create still waits for an upload in progress when defaults are on the form", async () => {
  const form = formScript({}, defaultsOf({ server: [yoast], account: null, automatic: [] }), { admin: true });
  await settle();
  const file = form.nodes["clp-wp-plugin-file"]!;
  file.files = [{ name: "big.zip", size: 1024 }];
  file.listeners.change[0]();
  expect(form.rows()).toEqual(["Yoast SEO", "big.zip"]);
  expect(form.submit()).toBe(true);
  expect(form.nodes["clp-wp-plugins-error"]!.textContent).toBe("Wait for the upload to finish, then create the site.");
  expect(form.sent.some((call) => call.path === "/api/new-site")).toBe(false);
});

// --- the admin page's defaults editor -------------------------------------

function dashboardHtml(server: { slug: string; name: string; activate: boolean }[], automatic: string[] = []): string {
  return dashboardBody({
    sites: [], varnish: { enabled: automatic.includes("clp-varnish-cache"), sites: {} }, varnishError: "",
    mainwp: emptyMainwpState() as never, mainwpError: "", domainLink: { signIn: true }, domainLinkError: "",
    jobs: { varnish: null, mainwp: null }, pluginDefaults: { server, automatic }, pluginDefaultsError: "",
  } as unknown as WpDashboard);
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

interface AdminClient {
  addDefault: (plugin: { slug: string; name: string }) => void;
  removeDefault: (button: unknown) => void;
  setDefaultActivate: (input: unknown) => Promise<void>;
  findDefault: () => Promise<void>;
  jobFinished: (job: unknown) => Promise<void>;
  defaultPlugins: () => { slug: string; name: string; activate: boolean; automatic: boolean }[];
}

function adminScript(
  initialHtml: string,
  callImpl: (path: string, options?: { method?: string; body?: string }) => Promise<unknown>,
) {
  const node = (): FakeNode => {
    const el: FakeNode = {
      hidden: false, textContent: "", value: "", className: "", type: "", title: "", disabled: false,
      children: [] as FakeNode[], attrs: {} as Record<string, string>, dataset: {} as Record<string, string>,
      setAttribute(name: string, val: string) { el.attrs[name] = val; },
      hasAttribute(name: string) { return name in el.attrs; },
      appendChild(child: FakeNode) { el.children.push(child); return child; },
      append(...items: FakeNode[]) { el.children.push(...items); },
      addEventListener(type: string, fn: (event?: unknown) => void) { (el.listeners ??= {})[type] = [...(el.listeners[type] ?? []), fn]; },
    };
    return el;
  };
  const dashboard = node();
  const search = Object.assign(node(), { value: "" });
  const results = Object.assign(node(), { hidden: true });
  Object.defineProperty(results, "textContent", { set() { results.children = []; }, get: () => "" });
  let listNode = node();
  let listRows: FakeNode[] = [];

  const applyHtml = (html: string) => {
    const autoMatch = /id="wp-default-list"[^>]*data-automatic="([^"]*)"/.exec(html);
    listNode = Object.assign(node(), { dataset: { automatic: autoMatch?.[1] ?? "" } });
    listRows = [...html.matchAll(/<li data-slug="([^"]+)" data-name="([^"]+)"([^>]*)>/g)].map((match) => {
      const attrs: Record<string, string> = {};
      if (match[3]!.includes("data-activate")) attrs["data-activate"] = "";
      if (match[3]!.includes("data-automatic")) attrs["data-automatic"] = "";
      return Object.assign(node(), { dataset: { slug: match[1]!, name: match[2]! }, attrs });
    });
    // Replacing #wp-dashboard innerHTML recreates #wp-default-results empty and hidden.
    results.children = [];
    results.hidden = true;
    search.attrs["aria-expanded"] = "false";
  };
  applyHtml(initialHtml);

  const byId: Record<string, () => FakeNode> = {
    "wp-dashboard": () => dashboard,
    "wp-default-list": () => listNode,
    "wp-default-search": () => search,
    "wp-default-results": () => results,
  };
  const rootEl = {
    getElementById: (id: string) => byId[id]?.() ?? null,
    querySelector: () => null,
    querySelectorAll: (selector: string) => selector === "#wp-default-list > li[data-slug]" ? listRows : [],
  };
  const notifications: { text: string; kind: string }[] = [];
  const repaints: string[] = [];
  const source = readFileSync(join(import.meta.dir, "../addons/wp-tools/app/views.client.js"), "utf8");
  const api = new Function(
    "CLP_BASE", "CLP_ROOT", "document", "call", "busy", "notify", "clearNotice", "repaintView", "followJobProgress", "plural",
    `${source}\nreturn { addDefault, removeDefault, setDefaultActivate, findDefault, jobFinished, defaultPlugins };`,
  )(
    "/addons/wp-tools",
    rootEl,
    { createElement: node },
    callImpl,
    () => {},
    (text: string, kind: string) => notifications.push({ text, kind }),
    () => {},
    (_holder: unknown, html: string) => { repaints.push(html); applyHtml(html); },
    () => {},
    (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`,
  ) as AdminClient;
  const resultStates = () => results.children.map((row: FakeNode) => {
    const pick = row.children[0];
    return { name: pick.children[0].textContent, state: pick.children[2].textContent, disabled: pick.disabled };
  });
  const domSlugs = () => listRows.map((row) => row.dataset.slug);
  return { api, search, results, notifications, repaints, resultStates, domSlugs, listRows: () => listRows };
}

test("a failed dashboard refresh after saving server defaults keeps the saved list for the next edit", async () => {
  const posts: unknown[] = [];
  let failDashboard = true;
  const admin = adminScript(dashboardHtml([yoast]), async (path, opts) => {
    if (path.startsWith("/api/plugin-search")) {
      return { ok: true, data: { plugins: [
        { slug: yoast.slug, name: yoast.name, author: "Yoast" },
        { slug: forms.slug, name: forms.name, author: "Takayuki" },
        { slug: mine.slug, name: mine.name, author: "Automattic" },
      ] } };
    }
    if (path === "/api/new-site-defaults") {
      const body = JSON.parse(opts!.body!);
      posts.push(body.plugins);
      return { ok: true, data: { pluginDefaults: { server: body.plugins, automatic: [] } } };
    }
    if (path === "/api/dashboard") {
      if (failDashboard) throw new Error("gateway unavailable");
      const current = (posts[posts.length - 1] as typeof yoast[]) ?? [yoast];
      return { ok: true, data: { html: dashboardHtml(current) } };
    }
    throw new Error(`unexpected ${path}`);
  });

  admin.search.value = "shop";
  await admin.api.findDefault();
  expect(admin.resultStates()).toEqual([
    { name: "Yoast SEO", state: "Added", disabled: true },
    { name: "Contact Form 7", state: "Add", disabled: false },
    { name: "WooCommerce", state: "Add", disabled: false },
  ]);

  // First save succeeds, but /api/dashboard fails so DOM still shows only Yoast SEO.
  admin.api.addDefault(forms);
  await settle();
  expect(posts).toEqual([[yoast, { ...forms, activate: true }]]);
  expect(admin.domSlugs()).toEqual(["wordpress-seo"]);
  expect(admin.notifications[admin.notifications.length - 1]).toEqual({
    text: "Contact Form 7 is a default plugin now. The page may be out of date: gateway unavailable",
    kind: "warn",
  });
  // Search results still reflect the saved plugin as Added.
  expect(admin.resultStates()[1]).toEqual({ name: "Contact Form 7", state: "Added", disabled: true });

  // Second edit builds on the authoritative saved defaults instead of the stale DOM rows.
  failDashboard = false;
  admin.api.addDefault(mine);
  await settle();
  expect(posts[1]).toEqual([yoast, { ...forms, activate: true }, mine]);
  expect(admin.domSlugs()).toEqual(["wordpress-seo", "contact-form-7", "woocommerce"]);

  // After a successful repaint, DOM is authoritative again (removing reads from DOM).
  const row = admin.listRows()[0]!;
  admin.api.removeDefault({ closest: () => row });
  await settle();
  expect(posts[2]).toEqual([{ ...forms, activate: true }, mine]);
  expect(admin.domSlugs()).toEqual(["contact-form-7", "woocommerce"]);
});

test("an older dashboard refresh from jobFinished cannot overwrite a newer defaults save or wipe unsynced defaults", async () => {
  const dashboards: Deferred<{ ok: boolean; data: { html: string } }>[] = [];
  const posts: unknown[] = [];
  const admin = adminScript(dashboardHtml([yoast]), (path, opts) => {
    if (path === "/api/new-site-defaults") {
      const body = JSON.parse(opts!.body!);
      posts.push(body.plugins);
      return Promise.resolve({ ok: true, data: { pluginDefaults: { server: body.plugins, automatic: [] } } });
    }
    if (path === "/api/dashboard") {
      const next = deferred<{ ok: boolean; data: { html: string } }>();
      dashboards.push(next);
      return next.promise;
    }
    return Promise.reject(new Error(`unexpected ${path}`));
  });

  const job = { task: "varnish-check", state: "done", domains: [], result: { checked: 1, installed: 0, pending: 0, failed: [] } };
  // jobFinished starts an older dashboard read (#0) before the save runs.
  const firstJob = admin.api.jobFinished(job);
  expect(dashboards).toHaveLength(1);

  // User adds Contact Form 7; its newer dashboard read (#1) resolves first.
  admin.api.addDefault(forms);
  await settle();
  expect(dashboards).toHaveLength(2);
  dashboards[1]!.resolve({ ok: true, data: { html: dashboardHtml([yoast, { ...forms, activate: true }]) } });
  await settle();
  expect(admin.domSlugs()).toEqual(["wordpress-seo", "contact-form-7"]);

  // The older jobFinished read (#0) now resolves with stale [yoast] HTML and must be ignored.
  dashboards[0]!.resolve({ ok: true, data: { html: dashboardHtml([yoast]) } });
  await firstJob;
  expect(admin.domSlugs()).toEqual(["wordpress-seo", "contact-form-7"]);
  expect(admin.repaints).toHaveLength(1);

  // Same when the save's own refresh fails: an older jobFinished read still must not clear savedDefaults.
  const secondJob = admin.api.jobFinished(job);
  expect(dashboards).toHaveLength(3);
  admin.api.addDefault(mine);
  await settle();
  expect(dashboards).toHaveLength(4);
  dashboards[3]!.reject(new Error("refresh failed"));
  await settle();
  dashboards[2]!.resolve({ ok: true, data: { html: dashboardHtml([yoast]) } });
  await secondJob;
  expect(admin.domSlugs()).toEqual(["wordpress-seo", "contact-form-7"]);
  expect(admin.api.defaultPlugins().map((plugin) => plugin.slug)).toEqual(["wordpress-seo", "contact-form-7", "woocommerce"]);
});

test("jobFinished repaints open default-plugin search results after replacing the dashboard", async () => {
  const varnish = { slug: "clp-varnish-cache", name: "CLP Varnish Cache", author: "CloudPanel" };
  const admin = adminScript(dashboardHtml([yoast]), async (path) => {
    if (path.startsWith("/api/plugin-search")) {
      return { ok: true, data: { plugins: [{ slug: yoast.slug, name: yoast.name, author: "Yoast" }, varnish] } };
    }
    if (path === "/api/dashboard") {
      return { ok: true, data: { html: dashboardHtml([yoast], ["clp-varnish-cache"]) } };
    }
    throw new Error(`unexpected ${path}`);
  });

  admin.search.value = "cache";
  await admin.api.findDefault();
  expect(admin.results.hidden).toBe(false);
  expect(admin.resultStates()).toEqual([
    { name: "Yoast SEO", state: "Added", disabled: true },
    { name: "CLP Varnish Cache", state: "Add", disabled: false },
  ]);

  await admin.api.jobFinished({ task: "varnish-check", state: "done", domains: [], result: { checked: 1, installed: 1, pending: 0, failed: [] } });
  expect(admin.repaints).toHaveLength(1);
  expect(admin.results.hidden).toBe(false);
  expect(admin.resultStates()).toEqual([
    { name: "Yoast SEO", state: "Added", disabled: true },
    { name: "CLP Varnish Cache", state: "Automatic", disabled: true },
  ]);
});

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applicationLabel, DEFAULT_TWEAKS, executePanelTweaksAction,
  type PanelTweaksActionOptions, type PanelTweaksState, type ScanResult, type SetTweaksResult,
} from "../addons/panel-tweaks/action";
import {
  PANEL_TWEAKS_TARGETS, deviceThemeSnippet, panelHeaderSnippet, sitesSnippet,
} from "../addons/panel-tweaks/inject/targets";
import type { PanelTweaks } from "../addons/panel-tweaks/action";

const loginTarget = PANEL_TWEAKS_TARGETS.find((target) => target.slug === "login-device-theme")!;
const sitesTarget = PANEL_TWEAKS_TARGETS.find((target) => target.slug === "sites-table")!;
const headerTargets = PANEL_TWEAKS_TARGETS.filter((target) => target.slug.startsWith("header-"));

function sites(wanted: Partial<PanelTweaks> = {}): string {
  return sitesSnippet("/addons/panel-tweaks", { ...DEFAULT_TWEAKS, ...wanted });
}

// --- the login page's device theme ---------------------------------------

interface Run {
  /** Whether the script put the page into dark mode. */
  dark: boolean;
  /** Everything written to document.cookie, in order. */
  cookies: string[];
  /** The local storage the script left behind. */
  store: Map<string, string>;
}

/**
 * Run the injected script against a minimal stand-in for the login page, so the
 * assertions below are about what a browser would actually do with it.
 */
function run(options: {
  cookie?: string;
  deviceDark?: boolean;
  https?: boolean;
  store?: Map<string, string>;
  noStorage?: boolean;
}): Run {
  const body = deviceThemeSnippet(true).replace(/^\s*<script>/, "").replace(/<\/script>\s*$/, "");
  const cookies: string[] = [];
  const store = options.store ?? new Map<string, string>();
  const classes = new Set<string>();
  let jar = options.cookie ?? "";
  const document = {
    get cookie() { return jar; },
    set cookie(value: string) { cookies.push(value); jar = value.split(";")[0] ?? ""; },
    documentElement: { classList: { add: (name: string) => { classes.add(name); } } },
  };
  const localStorage = options.noStorage
    ? { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } }
    : { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
  const window = { matchMedia: (query: string) => ({ matches: query.includes("dark") && options.deviceDark === true }) };
  const location = { protocol: options.https === false ? "http:" : "https:" };
  new Function("document", "window", "localStorage", "location", body)(document, window, localStorage, location);
  return { dark: classes.has("dark"), cookies, store };
}

test("the script is injected into the shared login layout, ahead of its stylesheets", () => {
  expect(loginTarget.template).toBe("Frontend/Login/layout.html.twig");
  expect(loginTarget.anchorBefore).toBe("{% block stylesheets %}");
  expect(loginTarget.required).toBe(true);
  const rendered = `${deviceThemeSnippet(true)}${loginTarget.anchorBefore}`;
  expect(rendered.indexOf("prefers-color-scheme: dark")).toBeLessThan(rendered.indexOf(loginTarget.anchorBefore!));
});

// The login page has no session, so the switch cannot be read at request time
// the way the other three are: off has to mean the markup is not there.
test("switching the device theme off leaves no script on the login page", () => {
  expect(deviceThemeSnippet(false)).toBe("");
});

test("a dark device with no saved theme gets the panel's dark setting", () => {
  const result = run({ deviceDark: true });
  expect(result.dark).toBe(true);
  expect(result.cookies).toHaveLength(1);
  expect(result.cookies[0]).toStartWith("theme=dark;");
  expect(result.store.get("clp_addons_device_theme")).toBe("1");
});

test("a light first visit records the default without setting a cookie", () => {
  const result = run({ deviceDark: false });
  expect(result.dark).toBe(false);
  expect(result.cookies).toHaveLength(0);
  expect(result.store.get("clp_addons_device_theme")).toBe("1");
});

test("a later device change does not replace the first-visit default", () => {
  const first = run({ deviceDark: false });
  const later = run({ deviceDark: true, store: first.store });
  expect(later.dark).toBe(false);
  expect(later.cookies).toHaveLength(0);
});

test("the cookie carries the same attributes as the panel's own theme switch", () => {
  const https = run({ deviceDark: true }).cookies[0] ?? "";
  expect(https).toContain("; path=/");
  expect(https).toContain("; secure");
  const expires = /expires=([^;]+)/.exec(https)?.[1] ?? "";
  const days = (Date.parse(expires) - Date.now()) / 864e5;
  expect(days).toBeGreaterThan(179);
  expect(days).toBeLessThan(181);
  // The panel hardcodes `secure: true`, which a browser drops over plain HTTP;
  // omitting it there is the only deviation, so the value actually sticks.
  expect(run({ deviceDark: true, https: false }).cookies[0] ?? "").not.toContain("secure");
});

test("a saved choice wins over the device preference", () => {
  // The panel renders html.dark from the cookie itself, so the script has
  // nothing left to do once one exists, whichever way the device leans. The
  // visit is still recorded so a later switch to light remains authoritative.
  for (const cookie of ["theme=dark", "PHPSESSID=x; theme=dark; n=1", "theme="]) {
    for (const deviceDark of [true, false]) {
      const result = run({ cookie, deviceDark });
      expect(result.cookies).toHaveLength(0);
      expect(result.store.get("clp_addons_device_theme")).toBe("1");
    }
  }
});

test("switching a pre-existing dark choice to light is not overridden", () => {
  const first = run({ cookie: "theme=dark", deviceDark: true });
  const afterSwitch = run({ deviceDark: true, store: first.store });
  expect(afterSwitch.dark).toBe(false);
  expect(afterSwitch.cookies).toHaveLength(0);
});

test("switching to light survives a return to the login page on a dark device", () => {
  // Seeded on the first visit, then the panel's switch deleted the cookie for
  // light. Re-seeding here is what used to drag the user back into dark mode.
  const store = new Map([["clp_addons_device_theme", "1"]]);
  const result = run({ deviceDark: true, store });
  expect(result.dark).toBe(false);
  expect(result.cookies).toHaveLength(0);
});

test("unusable local storage leaves the panel's own default in place", () => {
  const result = run({ deviceDark: true, noStorage: true });
  expect(result.dark).toBe(false);
  expect(result.cookies).toHaveLength(0);
});

// --- the sites page block -------------------------------------------------

test("the sites block is administrator-only and degrades rather than blocking an install", () => {
  const snippet = sites();
  expect(sitesTarget.template).toBe("Frontend/Site/index.html.twig");
  expect(sitesTarget.anchorBefore).toBe('<div class="card card-table">');
  expect(sitesTarget.required).toBe(false);
  expect(snippet).toContain("{% if is_granted('ROLE_ADMIN') %}");
  expect(snippet).toContain("{% endif %}");
  expect(snippet).toContain("/addons/panel-tweaks/api/panel");
});

// The old block waited for its data before rearranging the table, so a phone
// painted CloudPanel's four columns and then jumped to cards when the reply
// landed. The rules are keyed on the panel's own class instead, and are in
// force from the moment the browser parses them.
test("the narrow-screen layout needs no data and no class the script adds", () => {
  const snippet = sites({ sitesMobile: true });
  const mobile = snippet.slice(snippet.indexOf("table.table-sites, table.table-sites tbody"), snippet.indexOf("</style>"));
  expect(mobile).toContain("table.table-sites tr { display: flex");
  expect(mobile).not.toContain(".clp-tweaks-table tr {");
  // A separator between one site and the next, in whichever theme the panel is
  // showing, taken from the border the panel draws on its own table cells.
  expect(mobile).toContain("border-top: 1px solid #eaeaea");
  expect(mobile).toContain("html.dark table.table-sites tr { border-top-color: var(--clp-border-color); }");
});

// The block is rendered by Twig before a browser ever sees it, and Twig reads
// `{{`, `{%` and `{#` wherever they appear -- including inside a <script>.
test("nothing in the block is markup Twig would take for its own", () => {
  const body = sites({ actionMenu: true })
    .replace("{% if is_granted('ROLE_ADMIN') %}", "").replace("{% endif %}", "");
  for (const sequence of ["{{", "{%", "{#"]) expect(body).not.toContain(sequence);
});

// Each of these decides how the page is painted before any reply could arrive,
// so what the switch says has to be in the template rather than fetched.
test("the narrow-screen table, the row menu and the header are each in or out of the markup", () => {
  expect(sites({ sitesMobile: false })).not.toContain("table.table-sites, table.table-sites tbody");
  expect(sites({ sitesMobile: true })).toContain("table.table-sites, table.table-sites tbody");

  const off = sites({ actionMenu: false });
  expect(off).not.toContain('classList.add("clp-tweaks-menu")');
  expect(off).not.toContain("html.clp-tweaks-menu");
  const on = sites({ actionMenu: true });
  // The links are hidden by a class set before the table is parsed, not by one
  // the script adds once it has run, so nothing is seen and then taken away.
  expect(on).toContain('classList.add("clp-tweaks-menu")');
  expect(on).toContain("html.clp-tweaks-menu table.table-sites tbody td:last-child > a");
  expect(on.indexOf('classList.add("clp-tweaks-menu")'))
    .toBeLessThan(on.indexOf(String.raw`<div class="clp-tweaks-toolbar"`));

  expect(panelHeaderSnippet(false)).toBe("");
  expect(panelHeaderSnippet(true)).toContain("@media (max-width: 600px)");
});

// Both of CloudPanel's headers open with the same tag, and neither may stop an
// install: a release that renames the header costs the rules, not the addon.
test("the header rules go ahead of both headers and are not required", () => {
  expect(headerTargets.map((target) => target.template)).toEqual([
    "Frontend/Partial/header.html.twig",
    "Admin/Partial/header.html.twig",
  ]);
  for (const target of headerTargets) {
    expect(target.anchorBefore).toBe('<header class="header d-flex">');
    expect(target.required).toBe(false);
  }
});

// --- the privileged action ------------------------------------------------

let root = "";

function options(extra: Partial<PanelTweaksActionOptions> = {}): PanelTweaksActionOptions {
  return {
    processUid: 0,
    emitReply: false,
    paths: {
      panelDb: join(root, "panel.sq3"),
      tweaksFile: join(root, "state", "tweaks.json"),
      diskFile: join(root, "state", "disk-usage.json"),
      lockFile: join(root, "panel-tweaks.lock"),
      mysqlDir: join(root, "mysql"),
      passwd: join(root, "passwd"),
      rootUid: process.getuid?.() ?? 0,
    },
    ...extra,
  };
}

/** A panel database with the columns this addon reads, and nothing else. */
function seedPanel(): void {
  const db = new Database(join(root, "panel.sq3"), { create: true });
  db.exec(`
    CREATE TABLE site (id INTEGER PRIMARY KEY, type TEXT, domain_name TEXT, root_directory TEXT,
      user TEXT, application TEXT, certificate_id INTEGER);
    CREATE TABLE php_settings (id INTEGER PRIMARY KEY, site_id INTEGER, php_version TEXT);
    CREATE TABLE nodejs_settings (id INTEGER PRIMARY KEY, site_id INTEGER, nodejs_version TEXT);
    CREATE TABLE python_settings (id INTEGER PRIMARY KEY, site_id INTEGER, python_version TEXT);
    CREATE TABLE certificate (id INTEGER PRIMARY KEY, site_id INTEGER, type TEXT, expires_at TEXT);
    CREATE TABLE "database" (id INTEGER PRIMARY KEY, site_id INTEGER, name TEXT);
    INSERT INTO certificate VALUES (7, 1, '2', '2026-12-01 09:00:00');
    INSERT INTO site VALUES (1, 'php', 'shop.example.com', 'shop.example.com', 'shop', 'WordPress', 7);
    INSERT INTO site VALUES (2, 'static', 'docs.example.com', 'docs.example.com', 'docs', 'Static', NULL);
    INSERT INTO php_settings VALUES (1, 1, '8.3');
    INSERT INTO "database" VALUES (1, 1, 'shopdb');
  `);
  db.close();
}

function seedAccounts(): void {
  const uid = process.getuid?.() ?? 0;
  const gid = process.getgid?.() ?? 0;
  const lines = ["shop", "docs"].map((user) => `${user}:x:${uid}:${gid}::${join(root, "home", user)}:/bin/sh`);
  writeFileSync(join(root, "passwd"), `${lines.join("\n")}\n`);
  for (const user of ["shop", "docs"]) mkdirSync(join(root, "home", user), { recursive: true });
  // What a WordPress install always has, and what the sign-in refuses without:
  // wp-content is the site's own, never something this creates from nothing.
  for (const directory of ["wp-includes", "wp-content"]) {
    mkdirSync(join(root, "home", "shop", "htdocs", "shop.example.com", directory), { recursive: true });
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "clp-panel-tweaks-"));
  seedPanel();
  seedAccounts();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function act<T>(argv: string[], extra: Partial<PanelTweaksActionOptions> = {}): Promise<T> {
  return await executePanelTweaksAction(argv, options(extra)) as T;
}

test("the site list carries what CloudPanel's own template cannot", async () => {
  const state = await act<PanelTweaksState>(["state"]);
  expect(state.tweaks).toEqual(DEFAULT_TWEAKS);
  expect(state.sites.map((site) => site.domain)).toEqual(["docs.example.com", "shop.example.com"]);
  const shop = state.sites.find((site) => site.domain === "shop.example.com")!;
  expect(shop.runtime).toBe("PHP 8.3");
  expect(shop.application).toBe("WordPress");
  expect(shop.certificate).toEqual({ type: "2", expiresAt: "2026-12-01 09:00:00" });
  const docs = state.sites.find((site) => site.domain === "docs.example.com")!;
  expect(docs.runtime).toBe("");
  expect(docs.certificate).toBeNull();
});

// CloudPanel's own column prints the site type uppercased, so a reverse proxy
// reads as REVERSE-PROXY and a WordPress as PHP. The application it recorded is
// the more useful of the two, once the two run-together names are spaced out.
test("the applications CloudPanel records are named the way they are spelled", () => {
  expect(applicationLabel("ReverseProxy", "reverse-proxy")).toBe("Reverse Proxy");
  expect(applicationLabel("Nodejs", "nodejs")).toBe("Node.js");
  expect(applicationLabel("WooCommerce", "php")).toBe("WooCommerce");
  // An operator's own vhost template is a name this cannot know; it is printed
  // as they wrote it, and a site with no application falls back to its type.
  expect(applicationLabel("Acme Intranet", "php")).toBe("Acme Intranet");
  expect(applicationLabel("", "static")).toBe("static");
});

test("a switch is saved, and only the login page's one asks for the templates again", async () => {
  const sites = await act<SetTweaksResult>(["set-tweaks"], { input: JSON.stringify({ diskUsage: true }) });
  expect(sites.tweaks.diskUsage).toBe(true);
  expect(sites.reinject).toBe(false);

  const theme = await act<SetTweaksResult>(["set-tweaks"], { input: JSON.stringify({ deviceTheme: false }) });
  expect(theme.reinject).toBe(true);
  // The one that moved is saved beside the one that moved before it.
  expect(theme.tweaks).toEqual({ ...DEFAULT_TWEAKS, diskUsage: true, deviceTheme: false });
});

test("a request that names no tweak, or names one with the wrong type, is refused", async () => {
  await expect(act(["set-tweaks"], { input: "{}" })).rejects.toThrow("no tweak was named");
  await expect(act(["set-tweaks"], { input: '{"diskUsage":"yes"}' })).rejects.toThrow("must be true or false");
  await expect(act(["set-tweaks"], { input: "not json" })).rejects.toThrow("must be JSON");
});

test("the sweep measures every site's home and its databases, and caches the answer", async () => {
  mkdirSync(join(root, "mysql", "shopdb"), { recursive: true });
  const asked: string[][] = [];
  const result = await act<ScanResult>(["scan"], {
    run: (command, args) => {
      asked.push([command, ...args]);
      const path = args[args.length - 1] ?? "";
      const bytes = path.includes("mysql") ? 2048 : 4096;
      return { ok: true, stdout: `${bytes}\t${path}\n`, stderr: "", exitCode: 0 };
    },
  });
  expect(result.measured).toBe(2);
  expect(result.skipped).toBe(0);
  // The database directory is measured for the site that has one, and only for
  // that site: three `du` calls across two sites.
  expect(asked).toHaveLength(3);

  const state = await act<PanelTweaksState>(["state"]);
  const shop = state.sites.find((site) => site.domain === "shop.example.com")!;
  expect(shop.disk).toEqual({ bytes: 4096, databaseBytes: 2048, measuredAt: result.measuredAt });
  const docs = state.sites.find((site) => site.domain === "docs.example.com")!;
  expect(docs.disk?.databaseBytes).toBe(0);
});

test("a site whose account has gone is skipped rather than guessed at", async () => {
  writeFileSync(join(root, "passwd"), `shop:x:${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}::${join(root, "home", "shop")}:/bin/sh\n`);
  const result = await act<ScanResult>(["scan"], {
    run: () => ({ ok: true, stdout: "512\t/x\n", stderr: "", exitCode: 0 }),
  });
  expect(result.measured).toBe(1);
  expect(result.skipped).toBe(1);
});

test("an unknown verb, a stray argument and a non-root caller are all refused", async () => {
  await expect(act(["sweep"])).rejects.toThrow("unknown panel tweaks verb");
  await expect(act(["state", "--domain=shop.example.com"])).rejects.toThrow("unexpected argument");
  await expect(act(["state", "--all"])).rejects.toThrow("unexpected argument");
  await expect(executePanelTweaksAction(["state"], { ...options(), processUid: 1000 }))
    .rejects.toThrow("must run as root");
});

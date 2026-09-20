import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applicationLabel, DEFAULT_TWEAKS, executePanelTweaksAction,
  scanDiskUsage,
  type PanelTweaksActionOptions, type PanelTweaksState, type ScanResult, type SetTweaksResult,
} from "../addons/panel-tweaks/action";
import {
  PANEL_TWEAKS_TARGETS, deviceThemeSnippet, panelMobileSnippet, sitesSnippet,
} from "../addons/panel-tweaks/inject/targets";
import type { PanelTweaks } from "../addons/panel-tweaks/action";
import { previewPage } from "../addons/panel-tweaks/app/preview";
import { handle as handlePanelTweaks } from "../addons/panel-tweaks/app/index";
import { panelTweaksService } from "../addons/panel-tweaks/app/service";
import { dashboardView as panelTweaksDashboardView, layout as panelTweaksLayout } from "../addons/panel-tweaks/app/views";
import { STAGER_TARGETS } from "../addons/stager/inject/targets";
import { MENU_ONLY_CLASS, MENU_ONLY_STYLE, ROW_ACTION_CLASS, ROW_MENU_CLASS } from "../lib/row-actions";
import { CLOUDFLARE_ORIGIN } from "./fixtures/certificates";

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

test("the sites block serves every panel user and degrades rather than blocking an install", () => {
  const snippet = sites();
  expect(sitesTarget.template).toBe("Frontend/Site/index.html.twig");
  expect(sitesTarget.anchorBefore).toBe('<div class="card card-table">');
  expect(sitesTarget.required).toBe(false);
  // The Sites page is everyone's, and the reply the script reads is narrowed to
  // the rows CloudPanel drew for whoever asked.
  expect(snippet).not.toContain("is_granted");
  expect(snippet).toContain("/addons/panel-tweaks/api/panel");
});

// The old block waited for its data before rearranging the table, so a phone
// painted CloudPanel's four columns and then jumped to cards when the reply
// landed. The rules are keyed on the panel's own class instead, and are in
// force from the moment the browser parses them.
test("the narrow-screen layout needs no data and no class the script adds", () => {
  const snippet = sites({ sitesMobile: true });
  const mobile = snippet.slice(snippet.indexOf("table.table-sites, table.table-sites tbody"), snippet.indexOf("</style>"));
  // Details always use the full card width, while Application can use either a fitting
  // hostname row or the spare end of a detail heading.
  expect(mobile).toContain(".clp-tweaks-domain.clp-tweaks-type-at-host { display: grid");
  expect(mobile).toContain("grid-template-columns: repeat(2, minmax(0, 1fr))");
  expect(mobile).toContain(".clp-tweaks-detail-heading { display: flex");
  expect(mobile).toContain("min-height: 23px");
  expect(mobile).toContain("line-height: 17px");
  expect(mobile).toContain("box-shadow: inset 0 0 0 1px currentColor");
  expect(mobile).toContain("transform: translateY(calc(-100% + 15px))");
  expect(mobile).toContain("transform: translateY(calc(-100% - 12px))");
  expect(mobile).not.toContain(".clp-tweaks-mobile-type { display: block; float:");
  expect(snippet).toContain("hostWidth + tagWidth + 4 <= domain.clientWidth");
  expect(snippet).toContain("lines.length === 2 && lines[1].right + 4 <= domainRect.right - tagWidth");
  expect(snippet).toContain("if (visible.length > 1)");
  expect(snippet).toContain('tag.classList.add("clp-tweaks-type-in-empty-field")');
  expect(snippet).toContain("display: inline-block; vertical-align: top; padding: 2px 8px");
  expect(mobile).not.toContain(".clp-tweaks-table tr {");
  // A separator between one site and the next, in whichever theme the panel is
  // showing, taken from the border the panel draws on its own table cells.
  expect(mobile).toContain("border-top: 1px solid #eaeaea");
  expect(mobile).toContain("html.dark table.table-sites tr { border-top-color: var(--clp-border-color); }");
});

// Which columns a screen has room for is a question about the screen, so the
// answer is the browser's rather than the box's -- and a column that is off is
// hidden by a rule written before the table is parsed rather than by an
// attribute set on cells that have already been painted.
test("the column picker is in the block, and a switched-off column is never painted", () => {
  const snippet = sites({ sitesTable: true });
  expect(snippet).toContain('id="clp-tweaks-columns-button"');
  expect(snippet).toContain('id="clp-tweaks-columns-menu"');
  expect(snippet).toContain("var COLUMNS_ON = true;");
  expect(snippet).toContain("clp_tweaks_columns_narrow");
  expect(snippet).toContain("clp_tweaks_columns_wide");
  // A phone starts with the hostname, the certificate and the size, and the
  // three a desktop has room for are there to be asked for.
  expect(snippet).toContain('{ key: "user", label: "Site user", wide: true, narrow: false, native: 2 }');
  expect(snippet).toContain('{ key: "app", label: "Application", wide: true, narrow: false, native: 3 }');
  expect(snippet).toContain('{ key: "runtime", label: "Runtime", wide: true, narrow: false }');
  // Off, the whole thing is inert: no choice is read and no rule is written.
  expect(sites({ sitesTable: false })).toContain("var COLUMNS_ON = false;");
});

// The addon's own page shows the panel's Sites page in a frame, so an operator
// can see what a switch does without leaving the addon.
test("the preview frame is the panel's own page, with the injected block over it", () => {
  const state: PanelTweaksState = {
    tweaks: { ...DEFAULT_TWEAKS },
    diskMeasuredAt: "",
    sites: Array.from({ length: 7 }, (_, index) => ({
      domain: `site${index}.example.com`, user: `site${index}`, type: "php", application: "WordPress",
      runtime: "PHP 8.3", createdAt: "2026-01-01 00:00:00", cloudflareOnly: false, varnish: false,
      certificate: null, disk: null,
    })),
  };
  const page = previewPage(state);
  // CloudPanel's own stylesheets, not a copy of them kept here.
  expect(page).toContain('href="/assets/css/style.css"');
  expect(page).toContain('href="/assets/css/style-dark.css"');
  // The card and the class its dark theme keys the cell colour to.
  expect(page).toContain('<div class="card-body card-body-no-padding">');
  expect(page).toContain('<table class="table table-sites">');
  // The block the templates carry, without the Twig that guards it there.
  expect(page).toContain('id="clp-tweaks-toolbar"');
  for (const sequence of ["{{", "{%", "{#"]) expect(page).not.toContain(sequence);
  // A preview, not the list: five rows, and it says what it left out.
  expect(page.match(/<tr>/g)?.length).toBe(6);
  expect(page).toContain("2 more sites on the real page.");
  // The frame is measured by this wrapper, so it has to be there to find.
  expect(page).toContain('id="clp-preview"');
  expect(page).toContain("#clp-preview { max-width: 1200px; margin: 0 auto; padding: 20px 20px 24px; }");
  expect(page).toContain("#clp-preview { padding-right: 0; padding-left: 0; }");
  expect(page).toContain("html.clp-preview-framed-phone #clp-preview { padding-right: 20px; padding-left: 20px; }");
  expect(page).toContain("new MutationObserver(syncTheme)");
  for (const match of page.matchAll(/<script>([\s\S]*?)<\/script>/g)) expect(() => new Function(match[1]!)).not.toThrow();
});

test("the addon page keeps switches beside wrapping labels on a phone", () => {
  const page = panelTweaksDashboardView({ tweaks: { ...DEFAULT_TWEAKS }, diskMeasuredAt: "", sites: [] });
  expect(page).toContain("CloudPanel mobile layout");
  expect(page).toContain('id="tweak-category-sites"');
  expect(page).toContain('id="tweak-category-dashboard"');
  expect(page).toContain('id="tweak-category-login"');
  expect(page).toContain('class="tweak-row is-nested"');
  expect(page).toContain('class="tweak-scan"');
  expect(page).toContain("Measure now");
  expect(page).not.toContain("<h2>Measured sizes</h2>");
  const measuredOn = panelTweaksDashboardView({
    tweaks: { ...DEFAULT_TWEAKS, diskUsage: true }, diskMeasuredAt: "", sites: [],
  });
  expect(measuredOn).toContain('class="tweak-row is-nested is-enabled"');
  // Sites is the longest group, so it sits below the two short ones.
  expect(page.indexOf('id="tweak-category-sites"')).toBeGreaterThan(page.indexOf('id="tweak-category-login"'));
  expect(page.indexOf('id="tweak-category-login"')).toBeGreaterThan(page.indexOf('id="tweak-category-dashboard"'));
  // Measured sizes is unreachable while the table enhancement it belongs to is off.
  expect(page).toContain('data-tweak-parent="sitesTable" aria-label');
  const tableOff = panelTweaksDashboardView({
    tweaks: { ...DEFAULT_TWEAKS, sitesTable: false }, diskMeasuredAt: "", sites: [],
  });
  expect(tableOff).toContain('data-tweak-parent="sitesTable" disabled');
  const html = panelTweaksLayout("Panel Tweaks", page);
  expect(html).toContain(".tweak-heading { display: flex; align-items: center;");
  expect(html).toContain(".tweak-row .switch { flex: 0 0 auto; margin: 0; }");
  expect(html).toContain("top: -16px; left: 8px; width: 18px; height: 28px;");
  expect(html).toContain("key === 'diskUsage' && wanted");
  expect(page).toContain("Enabling starts a low-priority scan now");
  expect(page).toContain('</div>\n          <div class="tweak-scan"><span>Nothing measured yet.</span>');
  expect(page).not.toContain('<p>Enabling starts a low-priority scan now. It refreshes about every 6 hours, or whenever you choose Measure now. Each refresh walks the disk.</p><div class="tweak-scan">');
  expect(html).toContain("summary.textContent = event.measured + ' of ' + total");
  expect(html).toContain("sitesTable && sitesTable.checked && frame");
  expect(html).not.toContain("location.reload()");
  expect(html).toContain(".tweak-row .switch { flex: 0 0 auto;");
  expect(html).not.toContain(".tweak-row { flex-wrap: wrap; }");
  expect(html).toContain(".preview-widths { display: none; }");
  expect(html).toContain("position: absolute; inset: 0; display: flex");
  expect(html).toContain("'/preview?refresh=' + Date.now()");
  expect(html).toContain("classList.toggle('clp-preview-framed-phone'");
  for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) expect(() => new Function(match[1]!)).not.toThrow();
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

  expect(panelMobileSnippet(false)).toBe("");
  expect(panelMobileSnippet(true)).toContain("@media (max-width: 760px)");
});

test("a panel build without the runtime or certificate tables still lists its sites", async () => {
  seedOlderPanel();
  const state = await act<PanelTweaksState>(["state"]);
  expect(state.sites.map((site) => site.domain)).toEqual(["docs.example.com", "shop.example.com"]);
  expect(state.sites.find((site) => site.domain === "shop.example.com")?.runtime).toBe("PHP 8.3");
  expect(state.sites.every((site) => site.certificate === null)).toBe(true);
});

// The columns those three report arrived with later CloudPanel releases, and a
// statement naming a column the table has not got fails the same way one naming
// a missing table does -- which would cost the whole list, not one column.
test("a panel whose site table predates those columns still lists its sites", async () => {
  const db = new Database(join(panelRoot(), "panel.sq3"), { create: true });
  db.exec(`
    DROP TABLE site;
    CREATE TABLE site (id INTEGER PRIMARY KEY, type TEXT, domain_name TEXT, root_directory TEXT,
      user TEXT, application TEXT, certificate_id INTEGER);
    INSERT INTO site VALUES (1, 'php', 'shop.example.com', 'shop.example.com', 'shop', 'WordPress', 7);
  `);
  db.close();
  const state = await act<PanelTweaksState>(["state"]);
  const shop = state.sites.find((site) => site.domain === "shop.example.com")!;
  expect(shop.runtime).toBe("PHP 8.3");
  expect(shop.createdAt).toBe("");
  expect(shop.cloudflareOnly).toBe(false);
  expect(shop.varnish).toBe(false);
});

// The menu is a surface two addons share: one draws it, another puts an action
// in it that must not be a link in every row when there is no menu to hold it.
test("a menu-only action is hidden by its own addon and shown by the menu", () => {
  const clone = STAGER_TARGETS.find((target) => target.slug === "site-list-action")!;
  const style = STAGER_TARGETS.find((target) => target.slug === "site-list-style")!;
  expect(clone.snippet("/addons/stager")).toContain(`class="${MENU_ONLY_CLASS}"`);
  // Stager's own, not this addon's: a box without Panel Tweaks must not be
  // shown the link either.
  expect(style.snippet("/addons/stager")).toContain(MENU_ONLY_STYLE);
  expect(sites({ actionMenu: true })).not.toContain(MENU_ONLY_STYLE);

  // `.clp-addons-row-menu > a` outranks `.clp-addons-menu-only`, so the link
  // reappears once the menu has moved it inside, whichever order they load in.
  const menu = sites({ actionMenu: true });
  expect(menu).toContain(`.${ROW_MENU_CLASS} > a`);
  // Nothing an addon styled its inline link with survives into the menu.
  expect(menu).toContain("margin: 0; padding: 9px 18px");
  // The menu reads top to bottom, so it restores the order the row reverses:
  // the panel's own actions, then the addons' links, then the menu-only ones
  // nobody asked to have in the row -- whatever order the templates were
  // patched in.
  expect(menu).toContain(`if (link.classList.contains("${MENU_ONLY_CLASS}")) rare.push(link);`);
  expect(menu).toContain(`else if (link.classList.contains("${ROW_ACTION_CLASS}")) added.push(link);`);
  expect(menu).toContain("var actions = native.concat(added, rare);");

  // A filtered-out row is a block or a flex item in the card layout, which
  // ignores what the hidden attribute would otherwise do on its own.
  expect(sites({ sitesMobile: true })).toContain("table.table-sites tr[hidden]");
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

// Made on first use rather than before every test: most of the tests in this
// file read a string the injected block is built from and never open a
// database, and seeding one for them put a temporary directory and two SQLite
// databases in the way of each, which is enough for a slow runner's disk to
// time the hook out and fail a test that touches neither.
let root = "";

function panelRoot(): string {
  if (!root) {
    root = mkdtempSync(join(tmpdir(), "clp-panel-tweaks-"));
    seedPanel();
    seedAccounts();
  }
  return root;
}

function options(extra: Partial<PanelTweaksActionOptions> = {}): PanelTweaksActionOptions {
  return {
    processUid: 0,
    emitReply: false,
    paths: {
      panelDb: join(panelRoot(), "panel.sq3"),
      tweaksFile: join(panelRoot(), "state", "tweaks.json"),
      diskFile: join(panelRoot(), "state", "disk-usage.json"),
      lockFile: join(panelRoot(), "panel-tweaks.lock"),
      mysqlDir: join(panelRoot(), "mysql"),
      passwd: join(panelRoot(), "passwd"),
      rootUid: process.getuid?.() ?? 0,
    },
    ...extra,
  };
}

/** A panel database with the columns this addon reads, and nothing else. */
function seedPanel(): void {
  const db = new Database(join(panelRoot(), "panel.sq3"), { create: true });
  db.exec(`
    CREATE TABLE site (id INTEGER PRIMARY KEY, type TEXT, domain_name TEXT, root_directory TEXT,
      user TEXT, application TEXT, certificate_id INTEGER, created_at TEXT,
      allow_traffic_from_cloudflare_only BOOLEAN, varnish_cache BOOLEAN);
    CREATE TABLE php_settings (id INTEGER PRIMARY KEY, site_id INTEGER, php_version TEXT);
    CREATE TABLE nodejs_settings (id INTEGER PRIMARY KEY, site_id INTEGER, nodejs_version TEXT);
    CREATE TABLE python_settings (id INTEGER PRIMARY KEY, site_id INTEGER, python_version TEXT);
    CREATE TABLE certificate (id INTEGER PRIMARY KEY, site_id INTEGER, type TEXT, expires_at TEXT,
      certificate TEXT);
    CREATE TABLE "database" (id INTEGER PRIMARY KEY, site_id INTEGER, name TEXT);
    INSERT INTO certificate VALUES (7, 1, '2', '2026-12-01 09:00:00', NULL);
    INSERT INTO site VALUES (1, 'php', 'shop.example.com', 'shop.example.com', 'shop', 'WordPress', 7,
      '2025-04-09 11:20:00', 1, 0);
    INSERT INTO site VALUES (2, 'static', 'docs.example.com', 'docs.example.com', 'docs', 'Static', NULL,
      '2026-02-14 08:00:00', 0, 1);
    INSERT INTO php_settings VALUES (1, 1, '8.3');
    INSERT INTO "database" VALUES (1, 1, 'shopdb');
    CREATE TABLE user (id INTEGER PRIMARY KEY, user_name TEXT, role TEXT, status INTEGER);
    INSERT INTO user VALUES (1, 'boss', 'ROLE_ADMIN', 1);
    INSERT INTO user VALUES (2, 'shopkeeper', 'ROLE_USER', 1);
    INSERT INTO user VALUES (3, 'manager', 'ROLE_SITE_MANAGER', 1);
    INSERT INTO user VALUES (4, 'gone', 'ROLE_USER', 0);
    CREATE TABLE user_sites (user_id INTEGER, site_id INTEGER);
    INSERT INTO user_sites VALUES (2, 1);
    INSERT INTO user_sites VALUES (4, 1);
  `);
  db.close();
}

/**
 * An older panel: no Python runtime table and no certificates at all. SQLite
 * will not prepare a statement naming a table the database has not got, so an
 * outer join is not what makes this survivable.
 */
function seedOlderPanel(): void {
  const db = new Database(join(panelRoot(), "panel.sq3"), { create: true });
  db.exec(`
    DROP TABLE python_settings;
    DROP TABLE certificate;
  `);
  db.close();
}

function seedAccounts(): void {
  const uid = process.getuid?.() ?? 0;
  const gid = process.getgid?.() ?? 0;
  const lines = ["shop", "docs"].map((user) => `${user}:x:${uid}:${gid}::${join(panelRoot(), "home", user)}:/bin/sh`);
  writeFileSync(join(panelRoot(), "passwd"), `${lines.join("\n")}\n`);
  for (const user of ["shop", "docs"]) mkdirSync(join(panelRoot(), "home", user), { recursive: true });
  // What a WordPress install always has, and what the sign-in refuses without:
  // wp-content is the site's own, never something this creates from nothing.
  for (const directory of ["wp-includes", "wp-content"]) {
    mkdirSync(join(panelRoot(), "home", "shop", "htdocs", "shop.example.com", directory), { recursive: true });
  }
}

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
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
  expect(shop.createdAt).toBe("2025-04-09 11:20:00");
  expect(shop.cloudflareOnly).toBe(true);
  expect(shop.varnish).toBe(false);
  const docs = state.sites.find((site) => site.domain === "docs.example.com")!;
  expect(docs.runtime).toBe("");
  expect(docs.certificate).toBeNull();
  expect(docs.cloudflareOnly).toBe(false);
  expect(docs.varnish).toBe(true);
});

/** Puts a certificate of the given type on shop.example.com. */
function importCertificate(type: string, pem: string | null): void {
  const db = new Database(join(panelRoot(), "panel.sq3"));
  db.run("INSERT INTO certificate VALUES (8, 1, ?, '2041-02-07 10:00:00', ?);", [type, pem]);
  db.run("UPDATE site SET certificate_id = 8 WHERE id = 1;");
  db.close();
}

// CloudPanel records a type, not an issuer, so an uploaded certificate from
// Cloudflare's origin CA and one from a public authority are the same word to
// it. The certificate it stored says which.
test("an imported certificate is named by whoever issued it", async () => {
  importCertificate("3", CLOUDFLARE_ORIGIN);
  const state = await act<PanelTweaksState>(["state"]);
  const shop = state.sites.find((site) => site.domain === "shop.example.com")!;
  expect(shop.certificate)
    .toEqual({ type: "3", expiresAt: "2041-02-07 10:00:00", issuer: "CF Origin" });
});

test("a certificate the panel names itself is left with the panel's own name", async () => {
  // A self-signed certificate is issued in the site's own name and a Let's
  // Encrypt one in whichever intermediate signed it, so neither is read.
  importCertificate("1", CLOUDFLARE_ORIGIN);
  const selfSigned = await act<PanelTweaksState>(["state"]);
  expect(selfSigned.sites.find((site) => site.domain === "shop.example.com")!.certificate)
    .toEqual({ type: "1", expiresAt: "2041-02-07 10:00:00" });
});

test("an unreadable certificate falls back to the panel's own name", async () => {
  importCertificate("3", "-----BEGIN CERTIFICATE-----\nnonsense\n-----END CERTIFICATE-----");
  const state = await act<PanelTweaksState>(["state"]);
  expect(state.sites.find((site) => site.domain === "shop.example.com")!.certificate)
    .toEqual({ type: "3", expiresAt: "2041-02-07 10:00:00" });
});

// A table can predate one of its columns as easily as a database can predate a
// table, and one missing column must not cost the whole site list.
test("a panel that stores no certificate still lists its sites", async () => {
  const db = new Database(join(panelRoot(), "panel.sq3"));
  db.exec(`
    DROP TABLE certificate;
    CREATE TABLE certificate (id INTEGER PRIMARY KEY, site_id INTEGER, type TEXT, expires_at TEXT);
    INSERT INTO certificate VALUES (7, 1, '3', '2026-12-01 09:00:00');
  `);
  db.close();
  const state = await act<PanelTweaksState>(["state"]);
  expect(state.sites.find((site) => site.domain === "shop.example.com")!.certificate)
    .toEqual({ type: "3", expiresAt: "2026-12-01 09:00:00" });
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

test("measured sizes cannot outlive the sites table it belongs to", async () => {
  await act<SetTweaksResult>(["set-tweaks"], { input: JSON.stringify({ diskUsage: true }) });
  const off = await act<SetTweaksResult>(["set-tweaks"], { input: JSON.stringify({ sitesTable: false }) });
  expect(off.tweaks.diskUsage).toBe(false);

  const asked = await act<SetTweaksResult>(["set-tweaks"], { input: JSON.stringify({ diskUsage: true }) });
  expect(asked.tweaks.diskUsage).toBe(false);

  const back = await act<SetTweaksResult>(["set-tweaks"], { input: JSON.stringify({ sitesTable: true }) });
  expect(back.tweaks.diskUsage).toBe(false);
});

// The injected script runs on a page every panel user sees, so the state it
// reads is narrowed to the rows CloudPanel would have drawn for that user.
test("a named panel user is answered with their own sites and no others", async () => {
  const all = await act<PanelTweaksState>(["state"]);
  expect(all.sites.map((site) => site.domain)).toEqual(["docs.example.com", "shop.example.com"]);

  const mine = await act<PanelTweaksState>(["state", "--as-user=shopkeeper"]);
  expect(mine.sites.map((site) => site.domain)).toEqual(["shop.example.com"]);
  // The switches are the box owner's, and are the same answer for everyone.
  expect(mine.tweaks).toEqual(all.tweaks);

  // The two roles CloudPanel does not narrow.
  for (const user of ["boss", "manager"]) {
    const every = await act<PanelTweaksState>(["state", `--as-user=${user}`]);
    expect(every.sites.map((site) => site.domain)).toEqual(["docs.example.com", "shop.example.com"]);
  }

  // Deactivated, and a name that is nobody: both are shown nothing rather than
  // everything, because a session outlives the status change that ended it.
  for (const user of ["gone", "ghost"]) {
    const none = await act<PanelTweaksState>(["state", `--as-user=${user}`]);
    expect(none.sites).toEqual([]);
  }

  await expect(act(["state", "--as-user=not a name"])).rejects.toThrow("not a valid panel user name");
  await expect(act(["scan", "--as-user=boss"])).rejects.toThrow("takes no --as-user");
});

test("a request that names no tweak, or names one with the wrong type, is refused", async () => {
  await expect(act(["set-tweaks"], { input: "{}" })).rejects.toThrow("no tweak was named");
  await expect(act(["set-tweaks"], { input: '{"diskUsage":"yes"}' })).rejects.toThrow("must be true or false");
  await expect(act(["set-tweaks"], { input: "not json" })).rejects.toThrow("must be JSON");
});

test("the sweep measures every site's home and its databases, and caches the answer", async () => {
  mkdirSync(join(panelRoot(), "mysql", "shopdb"), { recursive: true });
  const asked: string[][] = [];
  const progress: { completed: number; total: number; site: string }[] = [];
  const result = await act<ScanResult>(["scan"], {
    onProgress: (event) => progress.push(event),
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
  expect(progress.map(({ completed, total, site }) => ({ completed, total, site }))).toEqual([
    { completed: 0, total: 2, site: "docs.example.com" },
    { completed: 1, total: 2, site: "shop.example.com" },
  ]);

  const state = await act<PanelTweaksState>(["state"]);
  const shop = state.sites.find((site) => site.domain === "shop.example.com")!;
  expect(shop.disk).toEqual({ bytes: 4096, databaseBytes: 2048, measuredAt: result.measuredAt });
  const docs = state.sites.find((site) => site.domain === "docs.example.com")!;
  expect(docs.disk?.databaseBytes).toBe(0);
});

test("unattended measurements reuse the result for six hours", async () => {
  await act<SetTweaksResult>(["set-tweaks"], { input: JSON.stringify({ diskUsage: true }) });
  let measurements = 0;
  const at = (iso: string) => options({
    now: () => new Date(iso),
    run: () => {
      measurements++;
      return { ok: true, stdout: "512\t/x\n", stderr: "", exitCode: 0 };
    },
  });

  expect(await scanDiskUsage(at("2026-09-20T00:00:00Z"))).toBe("2 sites measured");
  expect(measurements).toBe(2);
  expect(await scanDiskUsage(at("2026-09-20T05:59:59Z"))).toBeNull();
  expect(measurements).toBe(2);
  expect(await scanDiskUsage(at("2026-09-20T06:00:00Z"))).toBe("2 sites measured");
  expect(measurements).toBe(4);
});

test("the operator-pressed sweep is exempt from Bun's idle request timeout", async () => {
  const originalScanStream = panelTweaksService.scanStream;
  const calls: Array<[Request, number]> = [];
  const token = "panel-tweaks-test-token";
  const req = new Request("https://panel.example:8443/addons/panel-tweaks/api/scan", {
    method: "POST",
    headers: {
      host: "panel.example:8443",
      origin: "https://panel.example:8443",
      cookie: `clp_addons_csrf=${token}`,
      "x-clp-addons-csrf": token,
    },
  });

  try {
    panelTweaksService.scanStream = (handlers) => {
      handlers.onEvent({
        phase: "progress", completed: 0, total: 26, measured: 0, skipped: 0, site: "one.example.com",
      });
      handlers.onEvent({ phase: "complete", measured: 25, skipped: 1, measuredAt: "2026-09-20T15:00:00Z" });
      return { close() {} };
    };
    const response = await handlePanelTweaks(req, "/api/scan", null, {
      timeout(request: Request, seconds: number) {
        calls.push([request, seconds]);
      },
    } as any);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(response.headers.get("X-Accel-Buffering")).toBe("no");
    const events = await response.text();
    expect(events).toContain('\"phase\":\"progress\"');
    expect(events).toContain('\"total\":26');
    expect(events).toContain('\"phase\":\"complete\"');
  } finally {
    panelTweaksService.scanStream = originalScanStream;
  }

  expect(calls).toEqual([[req, 0]]);
});

test("a site whose account has gone is skipped rather than guessed at", async () => {
  writeFileSync(join(panelRoot(), "passwd"), `shop:x:${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}::${join(panelRoot(), "home", "shop")}:/bin/sh\n`);
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

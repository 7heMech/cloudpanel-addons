// The shared app shell: the one <script> every addon page carries, the styles
// every page draws with, and the client helper every page calls through.
// Anything here is wrong on more than one page at once.
//
// A syntax error anywhere in a page's script takes down the whole <script>
// element, not the line that holds it: the page still renders, the server
// still answers, and only a browser console says anything. This shipped once,
// and every button on the dashboard was dead for four releases. The Function
// constructor compiles without executing, which is the check that was missing.
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BASE_CLIENT_JS, FLEET_ROW_SELECTION_JS, THEME_INIT_JS } from "../lib/app-ui";
import { headerUpdateScript } from "../lib/panel-nav";
import { ADDON_NAMES } from "../addons/catalog";
import { CLIENT_JS as INSTATIC_CLIENT_JS } from "../addons/instatic/app/views";
import { CLIENT_JS as STAGER_CLIENT_JS } from "../addons/stager/app/views";
import { CLIENT_JS as GIT_CLIENT_JS } from "../addons/git/app/views";
import { CLIENT_JS as MAINTENANCE_CLIENT_JS, fleetView as maintenanceFleetView } from "../addons/maintenance/app/views";
import { CLIENT_JS as RESOURCE_LIMITS_CLIENT_JS } from "../addons/resource-limits/app/views";
import { dashboardView as cloudflareDashboardView } from "../addons/firewall/app/views";

const repo = join(import.meta.dir, "..");

// Checked as the browser receives it: the shared helpers and the addon's own
// script are concatenated into one <script>, so a stray escape in either one
// takes down every button on the page. Each addon is listed here; checking
// only the addon half would leave lib/app-ui.ts unverified.
const SCRIPTS: { name: string; source: string }[] = [
  { name: "theme initialization", source: THEME_INIT_JS },
  { name: "instatic", source: BASE_CLIENT_JS + INSTATIC_CLIENT_JS },
  { name: "stager", source: BASE_CLIENT_JS + STAGER_CLIENT_JS },
  { name: "git", source: BASE_CLIENT_JS + GIT_CLIENT_JS },
  { name: "maintenance", source: BASE_CLIENT_JS + MAINTENANCE_CLIENT_JS },
  { name: "resource-limits", source: BASE_CLIENT_JS + RESOURCE_LIMITS_CLIENT_JS },
  { name: "clp header update notice", source: headerUpdateScript() },
];

for (const { name, source } of SCRIPTS) {
  test(`the ${name} inline script parses`, () => {
    expect(() => new Function(source)).not.toThrow();
  });

}

// Native CloudPanel defaults to light and stores only its explicit dark choice.
// The early script must also recognize the cookie after another cookie and
// avoid confusing similarly named cookies or values with that preference.
test("addon theme follows CloudPanel's cookie before the page paints", () => {
  for (const [cookie, expected] of [
    ["", false], ["theme=dark", true], ["session=example; theme=dark; locale=en", true],
    ["other_theme=dark", false], ["theme=darkened", false], ["theme=light", false],
  ] as const) {
    const classes = new Set<string>();
    const document = {
      cookie,
      documentElement: { classList: { toggle(name: string, enabled: boolean) {
        if (enabled) classes.add(name); else classes.delete(name);
      } } },
    };
    new Function("document", THEME_INIT_JS)(document);
    expect(classes.has("dark"), cookie).toBe(expected);
  }
});

// `confirmAction` reads title, text, details, confirmLabel, danger and onAccept, and
// ignores anything else, so a dialog built with the wrong key opens explaining
// nothing and no type, test or console message says so.
test("every confirmAction call uses the keys the shared dialog reads", () => {
  const known = ["title", "text", "details", "confirmLabel", "danger", "typed", "onAccept"];
  const files = [...ADDON_NAMES.map((name) => `addons/${name}/app/views.client.js`), "manager/views.client.js"]
    .map((file) => join(repo, file)).filter((file) => existsSync(file));
  const unknown = new Set<string>();
  let calls = 0;
  for (const file of files) {
    const source = readFileSync(file, "utf-8");
    for (let at = source.indexOf("confirmAction({"); at !== -1; at = source.indexOf("confirmAction({", at + 1)) {
      calls++;
      let depth = 0;
      let end = source.indexOf("{", at);
      const start = end;
      for (; end < source.length; end++) {
        if (source[end] === "{") depth++;
        else if (source[end] === "}" && --depth === 0) break;
      }
      for (const match of source.slice(start + 1, end).matchAll(/(?:^|[,{])\s*([A-Za-z_$][\w$]*)\s*:/g)) {
        const key = match[1] ?? "";
        if (!known.includes(key)) unknown.add(`${file}: ${key}`);
      }
    }
  }
  expect(calls).toBeGreaterThan(5);
  expect([...unknown]).toEqual([]);
});

test("a fleet table gives the domain its own line on a phone", () => {
  // Squeezed into a sixth of a phone's width, a hostname wrapped one or two
  // characters at a time. The row becomes a block and every other cell names
  // the column heading the phone no longer has room to show.

  for (const html of [
    maintenanceFleetView({ global: { global: false, bypasses: [] }, sites: [{
      domain: "a-rather-long-hostname.example.test", user: "site-user", type: "php", enabled: false,
      customTemplate: false, bypasses: [], uncovered: null,
    }] }),
    cloudflareDashboardView({
      autoEnableNewSites: false,
      sites: [{ domain: "a-rather-long-hostname.example.test", enabled: false }],
      protocols: { available: true, enabled: true, protocols: {}, udpPorts: [] },
    }),
  ]) {
    expect(html).toContain('<table class="fleet-table');
    expect(html).toContain('<td class="site-cell"');
  }
});

// A route that saved a change and then failed at something after it answers
// with the state it did reach. `call` rejects, so that state is only knowable
// from the error, and the Panel Tweaks switch reads it to decide whether to
// stay where the operator put it.
test("a rejected request carries the state the route says it reached", async () => {
  const stubDoc = {
    cookie: "clp_addons_csrf=t",
    documentElement: { classList: { toggle: () => {}, contains: () => false } },
    querySelectorAll: () => [],
    querySelector: () => null,
    getElementById: () => null,
    addEventListener: () => {},
  };
  const reply = (status: number, body: unknown) => async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
  const load = (fetchStub: unknown) => new Function("document", "window", "location", "CLP_BASE", "fetch",
    `${BASE_CLIENT_JS}\nreturn { call };`)(
    stubDoc,
    { addEventListener: () => {}, matchMedia: () => ({ matches: false, addEventListener: () => {} }) },
    { pathname: "/addons/panel-tweaks/" }, "/addons/panel-tweaks", fetchStub,
  );

  const saved = load(reply(500, { ok: false, error: "nginx could not be reloaded", data: { reinject: true } }));
  await expect(saved.call("/api/tweaks", { method: "POST" })).rejects.toThrow("nginx could not be reloaded");
  const failure = await saved.call("/api/tweaks", { method: "POST" }).catch((e: Error & { data?: unknown }) => e);
  expect(failure.data).toEqual({ reinject: true });

  // A route that rejected the change outright has nothing to hand back, which
  // is what tells the caller it is safe to put the control back.
  const refused = load(reply(400, { ok: false, error: "that is not a tweak" }));
  const plain = await refused.call("/api/tweaks", { method: "POST" }).catch((e: Error & { data?: unknown }) => e);
  expect(plain.data).toBeUndefined();
});

// An action that reloaded the page lost the notice it had just shown, so each
// of these addons paints the reply into the page instead.
test("converted addon actions repaint without carrying notices through a reload", async () => {
  const pages = [
    { name: "instatic", script: FLEET_ROW_SELECTION_JS + INSTATIC_CLIENT_JS, run: "act('example.com', 'restart')" },
    { name: "git", script: FLEET_ROW_SELECTION_JS + GIT_CLIENT_JS, run: "refreshGit()" },
    { name: "resource-limits", script: RESOURCE_LIMITS_CLIENT_JS, run: "send('/api/limits', {}, 'Saved.')" },
  ];
  for (const page of pages) {
    const element = () => null;
    const document = {
      cookie: "clp_addons_csrf=t",
      readyState: "complete",
      body: { style: {} },
      documentElement: { classList: { toggle: () => {}, contains: () => false } },
      getElementById: element,
      querySelector: element,
      querySelectorAll: () => [],
      addEventListener: () => {},
      createElement: () => ({ style: {}, append: () => {}, setAttribute: () => {} }),
    };
    const reloads: string[] = [];
    const location = {
      pathname: `/addons/${page.name}/`, origin: "https://panel.example.test",
      reload: () => reloads.push("reload"), assign: (to: string) => reloads.push(to), replace: (to: string) => reloads.push(to),
    };
    const painted: string[] = [];
    const fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, html: "<p>after</p>", data: {} }) });
    const action = new Function("document", "window", "location", "CLP_BASE", "fetch", "alert", "paint",
      `${BASE_CLIENT_JS}\n${page.script}\nrepaintView = function (holder, html) { paint(html); };\nreturn function () { return ${page.run}; };`)(
      document,
      { addEventListener: () => {}, scrollTo: () => {}, matchMedia: () => ({ matches: false, addEventListener: () => {} }) },
      location, `/addons/${page.name}`, fetch, (message: string) => { throw new Error(`alert: ${message}`); },
      (html: string) => painted.push(html),
    );
    await action();
    expect(painted, page.name).toEqual(["<p>after</p>"]);
    expect(reloads, page.name).toEqual([]);
  }
});

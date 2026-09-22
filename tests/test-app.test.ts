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
import { BASE_CLIENT_JS, BASE_STYLE, THEME_INIT_JS } from "../lib/app-ui";
import { headerUpdateScript } from "../lib/panel-nav";
import { ADDON_NAMES } from "../cli/addon-catalog";
import { CLIENT_JS as INSTATIC_CLIENT_JS } from "../addons/instatic/app/views";
import { CLIENT_JS as STAGER_CLIENT_JS } from "../addons/stager/app/views";
import { CLIENT_JS as GIT_CLIENT_JS } from "../addons/git/app/views";
import { CLIENT_JS as MAINTENANCE_CLIENT_JS, fleetView as maintenanceFleetView } from "../addons/maintenance/app/views";
import { CLIENT_JS as PHP_RESOURCES_CLIENT_JS } from "../addons/php-resources/app/views";
import { dashboardView as cloudflareDashboardView } from "../addons/cloudflare-ips/app/views";

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
  { name: "php-resources", source: BASE_CLIENT_JS + PHP_RESOURCES_CLIENT_JS },
  { name: "clp header update notice", source: headerUpdateScript() },
];

for (const { name, source } of SCRIPTS) {
  test(`the ${name} inline script parses`, () => {
    expect(() => new Function(source)).not.toThrow();
  });

  // A bare newline inside a quoted string is the specific way this breaks, and
  // pointing at the line is more useful than "unexpected token" on a 4KB blob.
  test(`every ${name} client script line closes its strings`, () => {
    for (const [index, line] of source.split("\n").entries()) {
      const quotes = (line.match(/'/g) ?? []).length;
      expect(quotes % 2, `line ${index + 1}: ${line.trim()}`).toBe(0);
    }
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

test("a switch sits on the line of whatever it is beside", () => {
  // Both are labels, so both inherit the gap a field label leaves above its
  // input. Nothing sits under a switch, and that margin is what pushed every
  // one of them above the centre of its toolbar row or table cell.
  expect(BASE_STYLE).toContain(".switch-field { display: inline-flex; align-items: center; gap: 10px; margin: 0;");
  expect(BASE_STYLE).toContain(".switch { position: relative; display: inline-flex; width: 50px; height: 28px; margin: 0;");
  // One switch per row is a repeated control and comes down to the line height
  // beside it; a switch that decides the whole page keeps its full size.
  expect(BASE_STYLE).toContain(".fleet-table .switch { width: 44px; height: 24px; }");
});

test("a dialog is usable on a phone", () => {
  const narrow = BASE_STYLE.slice(BASE_STYLE.indexOf("@media (max-width: 940px)"));
  // The frame gives up its desktop padding, and the buttons take the row so a
  // confirmation label wraps inside its button rather than off the edge.
  expect(narrow).toContain("dialog { padding: 20px; width: calc(100% - 20px);");
  expect(narrow).toContain(".dialog-actions .btn { flex: 1 1 auto; }");
  // The visual viewport, so a collapsing address bar cannot cover the buttons.
  expect(narrow).toContain("dialog { max-height: calc(100dvh - 20px); }");
  expect(BASE_STYLE).toContain("dialog { max-height: calc(100dvh - 40px); }");
});

// `confirmAction` reads title, text, details, confirmLabel and danger, and
// ignores anything else, so a dialog built with the wrong key opens explaining
// nothing and no type, test or console message says so.
test("every confirmAction call uses the keys the shared dialog reads", () => {
  const known = ["title", "text", "details", "confirmLabel", "danger"];
  const files = [...ADDON_NAMES.map((name) => `addons/${name}/app/views.client.js`), "cli/assets/manager-index.client.js"]
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
  const narrow = BASE_STYLE.slice(BASE_STYLE.indexOf("@media (max-width: 940px)"));
  // Squeezed into a sixth of a phone's width, a hostname wrapped one or two
  // characters at a time. The row becomes a block and every other cell names
  // the column heading the phone no longer has room to show.
  expect(narrow).toContain(".fleet-table thead { display: none; }");
  expect(narrow).toContain(".fleet-table td.site-select { display: flex; flex: 0 0 42px; width: 42px;");
  expect(narrow).toContain(".fleet-table td.site-cell { flex: 1 1 calc(100% - 200px); min-width: 0;");
  // What a site is rides beside the domain as a tag, and every labelled cell
  // keeps half the row whatever it holds -- a status badge that grew when a
  // site went into maintenance used to move everything under it.
  expect(narrow).toContain(".fleet-table td.type-cell { flex: 0 1 auto;");
  expect(narrow).toContain(".fleet-table td[data-label] { flex: 1 1 calc(50% - 6px); min-width: 0; }");
  expect(narrow).toContain(".fleet-table td[data-label]::before { content: attr(data-label);");

  for (const html of [
    maintenanceFleetView([{
      domain: "a-rather-long-hostname.example.test", user: "site-user", type: "php", enabled: false,
      customTemplate: false, bypasses: [], error: "",
    }]),
    cloudflareDashboardView({
      autoEnableNewSites: false,
      sites: [{ domain: "a-rather-long-hostname.example.test", type: "php", enabled: false, excludedFromAutomatic: false }],
    }),
  ]) {
    expect(html).toContain('<table class="fleet-table');
    expect(html).toContain('<td class="site-cell"');
    expect(html).toContain('<td class="type-cell">');
  }
});

test("a mobile select-all control is hidden on desktop and shown on a phone", () => {
  expect(BASE_STYLE).toContain(".mobile-select-all { display: none; }");
  const narrow = BASE_STYLE.slice(BASE_STYLE.indexOf("@media (max-width: 940px)"));
  expect(narrow).toContain(".mobile-select-all { display: inline-flex;");
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

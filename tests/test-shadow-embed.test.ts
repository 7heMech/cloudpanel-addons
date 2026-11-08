import { expect, test } from "bun:test";
import { handle as handleMaintenance } from "../addons/maintenance/app/index";
import { handle as handleStager } from "../addons/stager/app/index";
import { stagerService, type JobView } from "../addons/stager/app/service";
import { maintenanceService } from "../addons/maintenance/app/service";
import { fragment } from "../addons/maintenance/app/views";
import { BASE_STYLE } from "../lib/app-ui";
import { siteLayoutTarget } from "../lib/panel-nav";
import {
  EMBED_LANDING_CLASS, EMBED_MARKER, embedLandingUrl, shadowStyle, SITE_EMBED_SCRIPT,
} from "../lib/shadow-embed";
import { join } from "node:path";
import { ADDON_SITE_TABS } from "../lib/site-context";
import { bundleStyles } from "../tools/browser-assets";

test("the stylesheet is rewritten for a shadow root", () => {
  const css = shadowStyle(BASE_STYLE);
  // A shadow tree cannot select the document, so the host carries both.
  expect(css).not.toContain(":root {");
  expect(css).not.toMatch(/(^|\n)html\.dark/);
  expect(css).toContain(":host {");
  expect(css).toContain(":host(.dark) {");
  expect(css).toContain(":host(.dark) .card-header");
  // The document belongs to CloudPanel on an embedded page.
  expect(css).not.toMatch(/(^|\n)body \{/);
  expect(css).toContain(":host { display: block;");
  // Rules an addon adds are rewritten too, including the editor's dark tint.
  expect(shadowStyle(BASE_STYLE + "\nhtml.dark #template-ace { background:#000; }"))
    .toContain(":host(.dark) #template-ace");
  expect(shadowStyle("@media (max-width:940px){body{font-size:15px}}")).toStartWith("@media (max-width:940px){:host {");
  // Everything else is the shell unchanged.
  expect(css).toContain(".switch input:checked + span");
  expect(css).toContain(".card {");
});

test("the stylesheet is rewritten for a shadow root once the build has minified it", async () => {
  const path = join(import.meta.dir, "../lib/assets/app-ui.css");
  for (const minify of [false, true]) {
    const css = shadowStyle((await bundleStyles([path], minify)).get(path)!);
    expect({ minify, dark: /html\.dark/.test(css), root: css.includes(":root"), body: /(^|[\s{}])body\s*\{/.test(css) })
      .toEqual({ minify, dark: false, root: false, body: false });
    expect(css).toContain(":host(.dark)");
  }
});

test("a fragment is a page with no document around it", () => {
  const page = fragment("Maintenance — shop.example.test", "<p>content</p>");
  expect(page.ok).toBe(true);
  expect(page.title).toBe("Maintenance — shop.example.test");
  expect(page.html).toContain("<p>content</p>");
  // The panel draws the chrome; the fragment must not draw it again.
  expect(page.html).not.toContain("<html");
  expect(page.html).not.toContain("clp-addon-header");
  expect(page.html).not.toContain("clp-addon-footer");
  expect(page.html).not.toContain("clp-addon-tabs");
  expect(page.css).not.toContain("clp-addon-site-info");
  // The shared notice holder and the one confirmation still travel with it.
  expect(page.html.match(/id="clp-flash"/g)).toHaveLength(1);
  expect(page.html.match(/id="clp-confirm"/g)).toHaveLength(1);
  // The script is handed over unrun, and learns its root from the loader.
  expect(page.script).toContain("typeof CLP_MOUNT === 'undefined' ? document : CLP_MOUNT");
});

test("the loader is injected with the layout rule, and only its markup half waits", () => {
  const snippet = siteLayoutTarget().snippet("/addons/");
  expect(snippet).toContain("attachShadow");
  // One script element. The layout block is deferred whole; the loader runs now
  // and defers the half that reads markup.
  expect(snippet.match(/<script>/g)).toHaveLength(1);
  expect(snippet.match(/function start\(\)/g)).toHaveLength(1);
  expect(snippet).toContain(`html.${EMBED_LANDING_CLASS} .site-content { visibility: hidden; }`);
});

test("a deep link into a site's addon page is answered by the panel's own page", async () => {
  const url = "https://panel.example.test:8443/addons/maintenance?domain=shop.example.test";
  const redirect = await handleMaintenance(new Request(url), "/");
  expect(redirect.status).toBe(302);
  expect(redirect.headers.get("Location")).toBe(embedLandingUrl("shop.example.test", "maintenance"));
  expect(redirect.headers.get("Location")).toContain(`${EMBED_MARKER}=maintenance`);

  // The standalone page stays reachable, for comparison and for a browser that
  // never reaches the loader.
  const standalone = await handleMaintenance(new Request(`${url}&embed=0`), "/");
  expect(standalone.status).not.toBe(302);
});

test("the fragment route answers with the page and the CSRF cookie its actions echo", async () => {
  const original = {
    globalStatus: maintenanceService.globalStatus,
    site: maintenanceService.site,
    template: maintenanceService.template,
  };
  try {
    maintenanceService.globalStatus = async () => ({ global: false, bypasses: [] });
    maintenanceService.site = async (domain: string) => ({
      site: { domain, type: "php", user: "shop", enabled: false, customTemplate: false, bypasses: [], uncovered: null },
      context: { domain, user: "shop", type: "php" },
    });
    maintenanceService.template = async (domain: string) => ({
      ok: true as const,
      data: { domain, custom: false, html: "<html></html>" },
    });

    const res = await handleMaintenance(
      new Request("https://panel.example.test:8443/addons/maintenance/fragment?domain=shop.example.test"),
      "/fragment",
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Set-Cookie")).toContain("clp_addons_csrf=");
    const body = await res.json() as { ok: boolean; title: string; css: string; html: string; script: string };
    expect(body.ok).toBe(true);
    expect(body.title).toBe("Maintenance — shop.example.test");
    expect(body.css).toContain(":host {");
    expect(body.html).toContain("shop.example.test");
    expect(body.script).toContain("CLP_ROOT");

    const invalid = await handleMaintenance(
      new Request("https://panel.example.test:8443/addons/maintenance/fragment?domain=not%20a%20host"),
      "/fragment",
    );
    expect(invalid.status).toBe(400);
  } finally {
    Object.assign(maintenanceService, original);
  }
});

/**
 * Just enough of CloudPanel's site page to run the injected loader: the two
 * elements it looks for, the tab link it binds, and the places it writes to.
 * Kept here rather than pulled in as a browser environment because these tests
 * are about what the loader decides, not about rendering.
 */
function runLoader(options: {
  strip?: boolean;
  content?: boolean;
  link?: boolean;
  landed?: string;
  fetchReply?: () => Promise<unknown>;
  shadowDom?: boolean;
  parsing?: boolean;
} = {}) {
  const warnings: string[] = [];
  const shadowRoots: { mode: string; innerHTML: string }[] = [];
  const history: [string, string][] = [];
  const landing = new Set<string>();
  const ready: (() => void)[] = [];
  const timers: number[] = [];
  const navigations: string[] = [];
  const fetched: string[] = [];
  const scripts: string[] = [];
  const clicks: ((event: unknown) => void)[] = [];

  // One link per addon tab, so a test can click a different tab than the one
  // that is mounted. The loader looks each up by its own url.
  const links = ADDON_SITE_TABS.map((tab) => ({
    getAttribute: () => `${tab.url}?domain=shop.example.test`,
    addEventListener: (_name: string, handler: (event: unknown) => void) => clicks.push(handler),
    parentNode: null,
    scrollIntoView: () => {},
  }));
  const strip = {
    querySelector: (selector: string) => {
      if (selector === "ul" || options.link === false) return null;
      const index = ADDON_SITE_TABS.findIndex((tab) => selector.includes(`${tab.url}?`));
      return index === -1 ? null : links[index];
    },
    querySelectorAll: () => [] as unknown[],
  };
  const content = { textContent: "x", appendChild: () => {} };
  const head = { appendChild: (el: { textContent: string }) => scripts.push(el.textContent) };
  const document = {
    title: "",
    head,
    readyState: options.parsing ? "loading" : "complete",
    addEventListener: (name: string, handler: () => void) => { if (name === "DOMContentLoaded") ready.push(handler); },
    documentElement: {
      classList: {
        contains: () => false,
        add: (name: string) => landing.add(name),
        remove: (name: string) => landing.delete(name),
      },
    },
    createElement: (tag: string) => (tag === "script"
      ? { textContent: "" }
      : {
        classList: { toggle: () => {} },
        attachShadow: (init: { mode: string }) => {
          const root = { mode: init.mode, innerHTML: "" };
          shadowRoots.push(root);
          return root;
        },
      }),
    querySelector: (selector: string) => {
      if (selector === ".tab-container") return options.strip === false ? null : strip;
      if (selector === ".site-content") return options.content === false ? null : content;
      return null;
    },
  };
  const location = {
    pathname: "/site/shop.example.test/settings",
    search: options.landed ? `?${EMBED_MARKER}=${options.landed}` : "",
    set href(value: string) { navigations.push(value); },
    get href() { return navigations[navigations.length - 1] ?? ""; },
  };
  const win: Record<string, unknown> = {
    console: { warn: (message: string) => warnings.push(message) },
    addEventListener: () => {},
  };
  const body = new Function(
    "document", "location", "window", "console", "fetch", "Element", "history", "MutationObserver", "setTimeout",
    SITE_EMBED_SCRIPT,
  );
  body(
    document,
    location,
    win,
    { warn: (message: string) => warnings.push(message) },
    (url: string) => { fetched.push(url); return (options.fetchReply ?? (() => new Promise(() => {})))(); },
    { prototype: options.shadowDom === false ? {} : { attachShadow: () => {} } },
    {
      pushState: (_state: unknown, _title: string, url: string) => history.push(["push", url]),
      replaceState: (_state: unknown, _title: string, url: string) => history.push(["replace", url]),
    },
    class { observe() {} },
    (_handler: () => void, delay: number) => timers.push(delay),
  );
  return { warnings, navigations, fetched, scripts, clicks, shadowRoots, history, landing, ready, timers, win };
}

const FRAGMENT = { ok: true, title: "Maintenance", css: ".x{}", html: "<p>fragment</p>", script: "const CLP_BASE = 'x';" };
const MAINTENANCE = ADDON_SITE_TABS.findIndex((tab) => tab.slug === "maintenance");

test("the loader mounts into an open shadow root and runs the script at global scope", async () => {
  const loader = runLoader({ fetchReply: async () => ({ json: async () => FRAGMENT }) });
  loader.clicks[MAINTENANCE]!({ button: 0, preventDefault: () => {} });
  await Bun.sleep(1);
  expect(loader.shadowRoots).toEqual([{ mode: "open", innerHTML: "<style>.x{}</style><p>fragment</p>" }]);
  // Inline handlers in the markup resolve against the global scope, so the
  // script goes into the document as a script element, told its root by CLP_MOUNT.
  expect(loader.scripts).toEqual([FRAGMENT.script]);
  expect(loader.win.CLP_MOUNT).toBe(loader.shadowRoots[0]);
  expect(loader.history).toEqual([["push", "/addons/maintenance?domain=shop.example.test"]]);
  expect(loader.navigations).toEqual([]);
});

// Falling back to the tab link would bounce through the redirect and land here again.
test("a browser without shadow DOM, or a fragment that fails, gets the standalone page", async () => {
  const old = runLoader({ shadowDom: false });
  old.clicks[MAINTENANCE]!({ button: 0, preventDefault: () => {} });
  expect(old.fetched).toEqual([]);
  expect(old.navigations).toEqual(["/addons/maintenance?domain=shop.example.test&embed=0"]);

  const failed = runLoader({ fetchReply: async () => ({ json: async () => ({ ok: false }) }) });
  failed.clicks[MAINTENANCE]!({ button: 0, preventDefault: () => {} });
  await Bun.sleep(1);
  expect(failed.shadowRoots).toEqual([]);
  expect(failed.navigations).toEqual(["/addons/maintenance?domain=shop.example.test&embed=0"]);
});

test("a deep link asks for its fragment while the panel page is still parsing", async () => {
  let release: (value: unknown) => void = () => {};
  const reply = new Promise((resolve) => { release = resolve; });
  const loader = runLoader({ parsing: true, landed: "maintenance", fetchReply: () => reply });
  // Asked before the document is ready, with the panel's content hidden from
  // the same moment and a timer that reveals it whatever happens.
  expect(loader.fetched).toEqual(["/addons/maintenance/fragment?domain=shop.example.test"]);
  expect([...loader.landing]).toEqual([EMBED_LANDING_CLASS]);
  expect(loader.timers).toEqual([5000]);

  // The landing mount takes that reply rather than asking again.
  for (const handler of loader.ready) handler();
  expect(loader.fetched).toHaveLength(1);
  release({ json: async () => FRAGMENT });
  await Bun.sleep(1);
  expect(loader.shadowRoots).toHaveLength(1);
  expect([...loader.landing]).toEqual([]);
  expect(loader.history).toEqual([["replace", "/addons/maintenance?domain=shop.example.test"]]);
});

test("nothing is hidden or fetched on a page nobody deep-linked to", () => {
  const loader = runLoader({ parsing: true });
  for (const handler of loader.ready) handler();
  expect(loader.fetched).toEqual([]);
  expect([...loader.landing]).toEqual([]);
  expect(loader.timers).toEqual([]);
});

test("a second click while a mount is in flight is ignored", async () => {
  let release: (value: unknown) => void = () => {};
  const pending = new Promise((resolve) => { release = resolve; });
  const loader = runLoader({
    fetchReply: () => pending.then(() => ({
      json: async () => ({ ok: true, title: "Maintenance", css: "", html: "", script: "const CLP_BASE = 'x';" }),
    })),
  });

  const event = { button: 0, preventDefault: () => {} };
  loader.clicks[0]!(event);
  loader.clicks[0]!(event);
  // The fragment's script declares CLP_BASE and CLP_ROOT with const at global
  // scope, so a second mount would throw on its own script and leave the
  // visible root pointing at the one it replaced.
  expect(loader.fetched).toHaveLength(1);

  release(null);
  await pending;
  await Bun.sleep(1);
  expect(loader.scripts).toHaveLength(1);

  // The mount is finished, so a further click is still a no-op.
  loader.clicks[0]!(event);
  expect(loader.fetched).toHaveLength(1);
});

test("the other addon's tab still works once one is mounted", async () => {
  const loader = runLoader({
    fetchReply: async () => ({
      json: async () => ({ ok: true, title: "Maintenance", css: "", html: "", script: "const CLP_BASE = 'x';" }),
    }),
  });
  // ADDON_SITE_TABS order, which is the order the loader binds them in.
  const maintenance = ADDON_SITE_TABS.findIndex((tab) => tab.slug === "maintenance");
  const stager = ADDON_SITE_TABS.findIndex((tab) => tab.slug === "stager");

  let prevented = 0;
  const event = { button: 0, preventDefault: () => { prevented++; } };
  loader.clicks[maintenance]!(event);
  await Bun.sleep(1);
  expect(loader.scripts).toHaveLength(1);
  expect(prevented).toBe(1);

  // The tab already shown stays a no-op, and stays prevented: following its own
  // link would reload the page to arrive where the operator already is.
  loader.clicks[maintenance]!(event);
  expect(loader.fetched).toHaveLength(1);
  expect(prevented).toBe(2);

  // The other tab is handed to the browser rather than swapped in place. A
  // second fragment in this document would throw on its own script, which
  // declares CLP_BASE with const at global scope -- so the click must not be
  // prevented, or the tab is simply dead.
  loader.clicks[stager]!(event);
  expect(prevented).toBe(2);
  expect(loader.fetched).toHaveLength(1);
});

test("a panel page the loader does not recognise says so and hands the page over", () => {
  // A deep link was redirected here, so the operator asked for the addon page;
  // leaving them on CloudPanel's settings page would look like nothing happened.
  const landed = runLoader({ content: false, landed: "maintenance" });
  expect(landed.warnings[0]).toContain("no tab strip or content area");
  expect(landed.navigations).toEqual(["/addons/maintenance?domain=shop.example.test&embed=0"]);

  // Nobody asked for anything here, so the panel's own page is what they wanted.
  const browsing = runLoader({ strip: false });
  expect(browsing.warnings).toHaveLength(1);
  expect(browsing.navigations).toEqual([]);

  // The strip is there but the addon's tab is not.
  const noTab = runLoader({ link: false, landed: "maintenance" });
  expect(noTab.warnings[0]).toContain("maintenance tab is not in this site's tab strip");
  expect(noTab.navigations).toEqual(["/addons/maintenance?domain=shop.example.test&embed=0"]);
});

test("Staging is a site tab too, and mounts the same way", async () => {
  const url = "https://panel.example.test:8443/addons/stager?domain=shop.example.test";
  const redirect = await handleStager(new Request(url), "/");
  expect(redirect.status).toBe(302);
  expect(redirect.headers.get("Location")).toBe(embedLandingUrl("shop.example.test", "stager"));

  const standalone = await handleStager(new Request(`${url}&embed=0`), "/");
  expect(standalone.status).not.toBe(302);
});

test("the Staging fragment shows this site's clones and its way back to live", async () => {
  const original = { sitePage: stagerService.sitePage, snapshot: stagerService.snapshot };
  try {
    const job = (over: Partial<JobView>): JobView => ({
      id: "20260916T000000Z-aaaaaa", kind: "clone", source: "", target: "", port: 0,
      state: "done", step: "", error: "", createdAt: "2026-09-16T00:00:00Z",
      startedAt: "", finishedAt: "", result: null, panelSite: true, sourcePanelSite: true, ...over,
    });
    stagerService.sitePage = async (domain: string) => ({
      context: { domain, user: "shop", type: "php" },
      jobs: [
        // One clone made from this site, and one that made this site.
        job({ id: "20260916T000001Z-bbbbbb", source: domain, target: `stg.${domain}` }),
        job({ id: "20260916T000002Z-cccccc", source: "live.example.test", target: domain, result: {} as never }),
      ],
      clonable: true,
    });
    stagerService.snapshot = async () => { throw new Error("no snapshot"); };

    const res = await handleStager(
      new Request("https://panel.example.test:8443/addons/stager/fragment?domain=shop.example.test"),
      "/fragment",
    );
    expect(res.status).toBe(200);
    // The fragment is what the operator's next action echoes, so it carries the
    // cookie the same way the Maintenance one does.
    expect(res.headers.get("Set-Cookie")).toContain("clp_addons_csrf=");
    const body = await res.json() as { ok: boolean; title: string; html: string };
    expect(body.ok).toBe(true);
    expect(body.title).toBe("Staging — shop.example.test");
    // What was staged from this site.
    expect(body.html).toContain("stg.shop.example.test");
    // And that this site is itself a clone, so it can go back.
    expect(body.html).toContain("live.example.test");
    expect(body.html).toContain("/addons/stager/promote?job=20260916T000002Z-cccccc");
    // No document around it, and no second tab strip: the panel draws both.
    expect(body.html).not.toContain("<!doctype html>");
    expect(body.html).not.toContain("clp-addon-tabs");
  } finally {
    Object.assign(stagerService, original);
  }
});

test("a site with nothing staged says so rather than offering a promote", async () => {
  const original = { sitePage: stagerService.sitePage, snapshot: stagerService.snapshot };
  try {
    stagerService.sitePage = async (domain: string) => ({
      context: { domain, user: "shop", type: "php" },
      jobs: [],
      clonable: true,
    });
    stagerService.snapshot = async () => { throw new Error("no snapshot"); };
    const res = await handleStager(
      new Request("https://panel.example.test:8443/addons/stager/fragment?domain=shop.example.test"),
      "/fragment",
    );
    const body = await res.json() as { html: string };
    expect(body.html).toContain("No staging copies");
    // Promoting is the return leg of a clone; with no clone record there is no
    // live site to return to, so the section is absent rather than disabled.
    expect(body.html).not.toContain("Promote to live");
  } finally {
    Object.assign(stagerService, original);
  }
});

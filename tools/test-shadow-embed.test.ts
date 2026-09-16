import { expect, test } from "bun:test";
import { handle as handleMaintenance } from "../addons/maintenance/app/index";
import { handle as handleStager } from "../addons/stager/app/index";
import { stagerService, type JobView } from "../addons/stager/app/service";
import { maintenanceService } from "../addons/maintenance/app/service";
import { fragment } from "../addons/maintenance/app/views";
import { BASE_STYLE } from "../lib/app-ui";
import { siteLayoutTarget } from "../lib/panel-nav";
import { EMBED_MARKER, embedLandingUrl, shadowStyle, SITE_EMBED_SCRIPT } from "../lib/shadow-embed";

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
  // Everything else is the shell unchanged.
  expect(css).toContain(".switch input:checked + span");
  expect(css).toContain(".card {");
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
  expect(page.script).toContain('const CLP_BASE = "/addons/maintenance"');
  expect(page.script).toContain("typeof CLP_MOUNT === 'undefined' ? document : CLP_MOUNT");
  expect(page.script).toContain("CLP_ROOT.getElementById('clp-flash')");
});

test("the loader mounts into a shadow root and runs the script at global scope", () => {
  const script = SITE_EMBED_SCRIPT;
  expect(script).toContain('attachShadow({ mode: "open" })');
  // Inline handlers in the markup resolve against the global scope, so the
  // fragment's script cannot be run inside a closure.
  expect(script).toContain('document.createElement("script")');
  expect(script).not.toContain("new Function(");
  expect(script).toContain("window.CLP_MOUNT = root");
  // One document, one mount, held from before the fetch rather than after it.
  expect(script).toContain("if (mounted || mounting) return;");
  expect(script).toContain("mounting = true;");
  expect(script).toContain('history[push ? "pushState" : "replaceState"]');
  // Anything it cannot do falls back to the standalone page. Falling back to
  // the tab link would bounce through the redirect and land here again.
  expect(script).toContain('"embed=0"');
  expect(script).toContain("if (!Element.prototype.attachShadow) return standalone(href);");
  expect(script).not.toMatch(/location\.href = href;/);
  expect(script).toContain(`get("${EMBED_MARKER}")`);
});

test("the loader is injected with the layout rule, behind the same deferral", () => {
  const snippet = siteLayoutTarget().snippet("/addons/");
  expect(snippet).toContain("attachShadow");
  expect(snippet).toContain('document.addEventListener("DOMContentLoaded", start, { once: true })');
  // One script element, one deferral, both bodies inside it.
  expect(snippet.match(/<script>/g)).toHaveLength(1);
  expect(snippet.indexOf("function start()")).toBeLessThan(snippet.indexOf("attachShadow"));
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
    maintenanceService.globalStatus = async () => false;
    maintenanceService.site = async (domain: string) => ({
      site: { domain, type: "php", user: "shop", enabled: false, customTemplate: false, bypasses: [] },
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
} = {}) {
  const warnings: string[] = [];
  const navigations: string[] = [];
  const fetched: string[] = [];
  const scripts: string[] = [];
  const clicks: ((event: unknown) => void)[] = [];

  const link = {
    getAttribute: () => "/addons/maintenance?domain=shop.example.test",
    addEventListener: (_name: string, handler: (event: unknown) => void) => clicks.push(handler),
    parentNode: null,
    scrollIntoView: () => {},
  };
  const strip = {
    querySelector: (selector: string) => (selector === "ul" ? null : options.link === false ? null : link),
    querySelectorAll: () => [] as unknown[],
  };
  const content = { textContent: "x", appendChild: () => {} };
  const head = { appendChild: (el: { textContent: string }) => scripts.push(el.textContent) };
  const document = {
    title: "",
    head,
    documentElement: { classList: { contains: () => false } },
    createElement: (tag: string) => (tag === "script"
      ? { textContent: "" }
      : { classList: { toggle: () => {} }, attachShadow: () => ({ innerHTML: "" }) }),
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
    "document", "location", "window", "console", "fetch", "Element", "history", "MutationObserver",
    SITE_EMBED_SCRIPT,
  );
  body(
    document,
    location,
    win,
    { warn: (message: string) => warnings.push(message) },
    (url: string) => { fetched.push(url); return (options.fetchReply ?? (() => new Promise(() => {})))(); },
    { prototype: { attachShadow: () => {} } },
    { pushState: () => {}, replaceState: () => {} },
    class { observe() {} },
  );
  return { warnings, navigations, fetched, scripts, clicks };
}

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
      startedAt: "", finishedAt: "", result: null, ...over,
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

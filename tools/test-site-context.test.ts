import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADDON_SITE_TABS, SITE_CONTEXT_STYLE, siteInfoHtml, siteTabs } from "../lib/site-context";
import { BASE_STYLE, renderLayout } from "../lib/app-ui";
import { siteLayoutTarget, SITE_TAB_TEMPLATE } from "../lib/panel-nav";
import { STAGER_TARGETS } from "../addons/stager/inject/targets";
import { MAINTENANCE_TARGETS } from "../addons/maintenance/inject/targets";
import { readPanelPublicIp } from "../lib/panel-snapshot";

const php = { domain: "shop.example.test", user: "shop", type: "php" };

test("the reproduced tab strip applies CloudPanel's own conditions", () => {
  const withVarnish = siteTabs({ ...php, varnishCache: true }).map((tab) => tab.label);
  expect(withVarnish).toEqual([
    "Settings", "Vhost", "Databases", "Varnish Cache", "SSL/TLS", "Security",
    "SSH/FTP", "File Manager", "Cron Jobs", "Logs", "Maintenance", "Staging",
  ]);

  // Varnish Cache is a PHP-with-Varnish tab; Databases is for anything but static.
  expect(siteTabs({ ...php, varnishCache: false }).map((tab) => tab.label)).not.toContain("Varnish Cache");
  expect(siteTabs({ ...php, type: "nodejs", varnishCache: true }).map((tab) => tab.label)).not.toContain("Varnish Cache");
  const staticTabs = siteTabs({ ...php, type: "static" }).map((tab) => tab.label);
  expect(staticTabs).not.toContain("Databases");
  expect(staticTabs).toContain("Settings");
  expect(staticTabs).toContain("Maintenance");
  expect(staticTabs).toContain("Staging");
});

test("tab links point at the panel's own routes and mark the active one", () => {
  const tabs = siteTabs({ ...php, varnishCache: true }, "maintenance");
  const href = (slug: string) => tabs.find((tab) => tab.slug === slug)!.href;
  expect(href("settings")).toBe("/site/shop.example.test/settings");
  expect(href("certificates")).toBe("/site/shop.example.test/certificates");
  expect(href("users")).toBe("/site/shop.example.test/users");
  expect(href("file-manager")).toBe("/site/shop.example.test/file-manager");
  expect(href("cron-jobs")).toBe("/site/shop.example.test/cron-jobs");
  expect(href("varnish-cache")).toBe("/site/shop.example.test/varnish-cache");
  expect(href("maintenance")).toBe("/addons/maintenance?domain=shop.example.test");
  expect(tabs.filter((tab) => tab.active).map((tab) => tab.slug)).toEqual(["maintenance"]);
  expect(siteTabs(php).some((tab) => tab.active)).toBe(false);
});

test("a hostname needing escaping stays escaped in links and site information", () => {
  const hostile = { domain: '"><img src=x>.example.test', user: "<b>user</b>", type: "php" };
  const html = renderLayout("Site", "", {
    brand: "Test", base: "/addons/test", nav: [], script: "",
    site: { ...hostile, activeSlug: "maintenance" },
  });
  expect(html).not.toContain("<img src=x>");
  expect(html).not.toContain("<b>user</b>");
  expect(siteInfoHtml(hostile)).toContain("&lt;b&gt;user&lt;/b&gt;");
});

test("the site shell replaces the addon's tabs and highlights Sites", () => {
  const html = renderLayout("Site", "<p>content</p>", {
    brand: "Maintenance Mode",
    base: "/addons/maintenance",
    nav: [{ href: "/addons/maintenance/", label: "Sites" }],
    script: "",
    site: { ...php, varnishCache: false, publicIp: "203.0.113.10", activeSlug: "maintenance" },
  });
  expect(html).toContain('aria-label="Site navigation"');
  expect(html).not.toContain('aria-label="Maintenance Mode navigation"');
  expect(html).toContain("<h3>Site User</h3>");
  expect(html).toContain("203.0.113.10");
  const sitesLink = html.slice(html.indexOf('href="/"'), html.indexOf('href="/addons/"'));
  expect(sitesLink).toContain('aria-current="page"');
  expect(html).not.toContain('href="/addons/" aria-current="page"');
});

test("site information omits the instance address when the panel has none", () => {
  const html = siteInfoHtml(php);
  expect(html).toContain("<h3>Domain</h3>");
  expect(html).toContain("<h3>Site User</h3>");
  expect(html).not.toContain("IP Address");
});

test("an addon page without site context keeps its own tabs and highlights Addons", () => {
  const html = renderLayout("Fleet", "<p>content</p>", {
    brand: "Maintenance Mode",
    base: "/addons/maintenance",
    nav: [{ href: "/addons/maintenance/", label: "Sites" }],
    script: "",
  });
  expect(html).toContain('aria-label="Maintenance Mode navigation"');
  expect(html).toContain("data-auto-active");
  expect(html).not.toContain('aria-label="Site navigation"');
  expect(html).toContain('href="/addons/" aria-current="page"');
});

test("the shell ships one confirmation dialog and one notice holder for every addon", () => {
  const html = renderLayout("Fleet", "<p>content</p>", { brand: "Test", base: "/addons/test", nav: [], script: "" });
  expect(html.match(/id="clp-confirm"/g)).toHaveLength(1);
  expect(html.match(/id="clp-flash"/g)).toHaveLength(1);
  expect(html).toContain('id="clp-confirm-accept"');
});

test("the reproduced site information carries the panel's own measurements", () => {
  // CloudPanel's assets/css/frontend/site.css. A reproduction that only looks
  // approximately right is what makes an addon page read as a different page:
  // the columns have to start where the panel starts them.
  expect(SITE_CONTEXT_STYLE).toContain("min-width: 200px");
  expect(SITE_CONTEXT_STYLE).toContain("margin: 0 60px 0 0");
  expect(SITE_CONTEXT_STYLE).toContain("font-size: 14px; font-weight: 500; color: #aaa");
  expect(SITE_CONTEXT_STYLE).toContain(".clp-addon-site-value { font-size: 18px");
  // The panel's own strip keeps that column too; only a narrow screen gives it up.
  const snippet = siteLayoutTarget().snippet("/addons/");
  expect(snippet).toContain(".site-info-box { max-width: 100%; }");
  expect(snippet.split("@media")[0]).not.toContain("min-width");
  expect(snippet).toContain("min-width: 0; margin-right: 30px");
});

test("the site layout rule targets the same partial an addon adds its tab to", () => {
  const layout = siteLayoutTarget();
  expect(layout.template).toBe(SITE_TAB_TEMPLATE);
  expect(MAINTENANCE_TARGETS.some((target) => target.template === SITE_TAB_TEMPLATE)).toBe(true);
  // Anchored on the strip's own container, so it lands ahead of the tabs.
  expect(layout.anchorBefore).toBe('<div class="tab-container">');
  const snippet = layout.snippet("/addons/");
  expect(snippet).toContain("flex-wrap: nowrap");
  expect(snippet).toContain("overflow-x: auto");
  // A strip that scrolls must not draw a bar: overflow-x alone also makes
  // overflow-y auto, and the bar itself ate 10px of the strip's height.
  expect(snippet).toContain("overflow-y: hidden");
  expect(snippet).toContain("scrollbar-width: none");
  expect(snippet).toContain("::-webkit-scrollbar { display: none; }");
  expect(BASE_STYLE).toContain(".clp-addon-tabs::-webkit-scrollbar { display: none; }");
  expect(BASE_STYLE.split(".clp-addon-tabs {")[1]!.split("}")[0]).toContain("overflow-y: hidden");
  expect(snippet).toContain("scrollIntoView");
  // Widening the panel's own limited-width container is what this rule avoids.
  expect(snippet).not.toContain(".container-limited-width");
});

test("the injected script waits for the strip it is injected ahead of", () => {
  const script = siteLayoutTarget().snippet("/addons/")
    .replace(/[\s\S]*<script>/, "").replace(/<\/script>[\s\S]*/, "");
  let queried = 0;
  let deferred = "";
  const document = {
    readyState: "loading",
    addEventListener: (event: string) => { deferred = event; },
    querySelector: () => { queried++; return null; },
  };
  new Function("document", script)(document);

  // Reading the strip during parsing found nothing, so the active tab was never
  // revealed and the focus handler was never attached.
  expect(queried).toBe(0);
  expect(deferred).toBe("DOMContentLoaded");
});

test("every injected tab label matches the strip the addon reproduces", () => {
  // The panel's copy of the strip and the addon's reproduction of it are two
  // renderings of ADDON_SITE_TABS; a label typed into either by hand is how
  // they drift.
  const injected = [
    { slug: "maintenance", targets: MAINTENANCE_TARGETS, url: "/addons/maintenance" },
    { slug: "stager", targets: STAGER_TARGETS, url: "/addons/stager" },
  ];
  for (const { slug, targets, url } of injected) {
    const tab = ADDON_SITE_TABS.find((candidate) => candidate.slug === slug)!;
    const target = targets.find((candidate) => candidate.slug === "site-tab")!;
    expect(target.snippet(url)).toContain(`>${tab.label}</a>`);
  }

  // And in the same order at the end of the reproduced strip, which is the
  // order the injector produces in the panel's own copy.
  expect(siteTabs(php).slice(-ADDON_SITE_TABS.length).map((tab) => tab.label))
    .toEqual(ADDON_SITE_TABS.map((tab) => tab.label));
});

function poolItem(root: string, name: string, expiry: number, key: string, value: string): void {
  const directory = join(root, "a", "b");
  mkdirSync(directory, { recursive: true });
  // Symfony's filesystem pool: expiry, key, then the serialized value.
  writeFileSync(join(directory, name), `${expiry}\n${key}\na:1:{s:4:"hash";s:${value.length}:"${value}";}`);
}

test("the instance address comes from the panel's own cache, or not at all", () => {
  const root = mkdtempSync(join(tmpdir(), "clp-pool-"));
  try {
    expect(readPanelPublicIp(join(root, "absent"))).toBe("");

    const future = Math.floor(Date.now() / 1000) + 3600;
    poolItem(root, "item", future, "ipv4_public_ip", "198.51.100.7");
    expect(readPanelPublicIp(root)).toBe("198.51.100.7");

    // An entry the panel would itself refetch is not the panel's current answer.
    rmSync(join(root, "a"), { recursive: true, force: true });
    poolItem(root, "item", Math.floor(Date.now() / 1000) - 60, "ipv4_public_ip", "198.51.100.7");
    expect(readPanelPublicIp(root)).toBe("");

    // Some other cached value must not be mistaken for an address.
    rmSync(join(root, "a"), { recursive: true, force: true });
    poolItem(root, "item", future, "app_version", "198.51.100.7");
    expect(readPanelPublicIp(root)).toBe("");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

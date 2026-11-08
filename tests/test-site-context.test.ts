import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADDON_SITE_TABS, siteInfoHtml, siteTabs } from "../lib/site-context";
import { renderLayout } from "../lib/app-ui";
import { siteLayoutTarget } from "../lib/panel-nav";
import { TEMPLATES } from "../lib/panel-anchors";
import { GIT_TARGETS } from "../addons/git/inject/targets";
import { STAGER_TARGETS } from "../addons/stager/inject/targets";
import { MAINTENANCE_TARGETS } from "../addons/maintenance/inject/targets";
import { readPanelPublicIp } from "../lib/panel-snapshot";

const php = { domain: "shop.example.test", user: "shop", type: "php" };

test("the reproduced tab strip applies CloudPanel's own conditions", () => {
  const withVarnish = siteTabs({ ...php, varnishCache: true }).map((tab) => tab.label);
  expect(withVarnish).toEqual([
    "Settings", "Vhost", "Databases", "Varnish Cache", "SSL/TLS", "Security",
    "SSH/FTP", "File Manager", "Cron Jobs", "Logs", "Git", "Maintenance", "Staging",
  ]);

  // Varnish Cache is a PHP-with-Varnish tab; Databases is for anything but static.
  expect(siteTabs({ ...php, varnishCache: false }).map((tab) => tab.label)).not.toContain("Varnish Cache");
  expect(siteTabs({ ...php, type: "nodejs", varnishCache: true }).map((tab) => tab.label)).not.toContain("Varnish Cache");
  const staticTabs = siteTabs({ ...php, type: "static" }).map((tab) => tab.label);
  expect(staticTabs).not.toContain("Databases");
  expect(staticTabs).toContain("Settings");
  expect(staticTabs).toContain("Git");
  expect(staticTabs).toContain("Maintenance");
  expect(staticTabs).toContain("Staging");
  // Staging only where Clone works, as the injected tab's Twig has it.
  expect(siteTabs({ ...php, type: "nodejs" }).map((tab) => tab.label)).not.toContain("Staging");
  expect(siteTabs({ ...php, type: "reverse-proxy" }).map((tab) => tab.label)).toContain("Staging");
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
    base: "/addons/test", script: "",
    site: { ...hostile, activeSlug: "maintenance" },
  });
  expect(html).not.toContain("<img src=x>");
  expect(html).not.toContain("<b>user</b>");
  expect(siteInfoHtml(hostile)).toContain("&lt;b&gt;user&lt;/b&gt;");
});

test("the site shell draws the site's tabs and highlights Sites", () => {
  const html = renderLayout("Site", "<p>content</p>", {
    base: "/addons/maintenance",
    script: "",
    site: { ...php, varnishCache: false, publicIp: "203.0.113.10", activeSlug: "maintenance" },
  });
  expect(html).toContain('aria-label="Site navigation"');
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

test("an addon page without site context draws no tab strip and highlights Addons", () => {
  const html = renderLayout("Fleet", "<p>content</p>", { base: "/addons/maintenance", script: "" });
  expect(html).not.toContain('<nav class="clp-addon-tabs"');
  expect(html).toContain('href="/addons/" aria-current="page"');
});

test("the shell ships one confirmation dialog and one notice holder for every addon", () => {
  const html = renderLayout("Fleet", "<p>content</p>", { base: "/addons/test", script: "" });
  expect(html.match(/id="clp-confirm"/g)).toHaveLength(1);
  expect(html.match(/id="clp-flash"/g)).toHaveLength(1);
  expect(html).toContain('id="clp-confirm-accept"');
});

test("a site manager's shell leaves out the administrator links", () => {
  const html = renderLayout("Instatic", "<p>content</p>", { base: "/addons/instatic", admin: false, script: "" });
  expect(html).toContain('href="/"');
  expect(html).not.toContain('href="/addons/"');
  expect(html).not.toContain('id="clp-admin-area"');
  const admin = renderLayout("Instatic", "", { base: "/addons/instatic", script: "" });
  expect(admin).toContain('href="/addons/"');
  expect(admin).toContain('id="clp-admin-area"');
});

test("the panel's own site strip keeps its column width outside a narrow screen", () => {
  const snippet = siteLayoutTarget().snippet("/addons/");
  expect(snippet.split("@media")[0]).not.toContain("min-width");
});

test("the site layout rule targets the same partial an addon adds its tab to", () => {
  const layout = siteLayoutTarget();
  expect(layout.template).toBe(TEMPLATES.siteTabs);
  expect(MAINTENANCE_TARGETS.some((target) => target.template === TEMPLATES.siteTabs)).toBe(true);
  // Anchored on the strip's own container, so it lands ahead of the tabs.
  expect(layout.anchorBefore).toBe('<div class="tab-container">');
  const snippet = layout.snippet("/addons/");
  expect(snippet).toContain("scrollIntoView");
  // Widening the panel's own limited-width container is what this rule avoids.
  expect(snippet).not.toContain(".container-limited-width");
});

test("the injected script waits for the strip it is injected ahead of", () => {
  const script = siteLayoutTarget().snippet("/addons/")
    .replace(/[\s\S]*<script>/, "").replace(/<\/script>[\s\S]*/, "");
  let queried = 0;
  const deferred: string[] = [];
  const document = {
    readyState: "loading",
    addEventListener: (event: string) => { deferred.push(event); },
    querySelector: () => { queried++; return null; },
  };
  new Function("document", "location", "window", script)(
    document,
    { pathname: "/site/shop.example.test/settings", search: "" },
    { addEventListener: () => {} },
  );

  // Reading the strip during parsing found nothing, so the active tab was never
  // revealed, the focus handler was never attached and no tab was mounted.
  expect(queried).toBe(0);
  // Both blocks: the layout rules and the loader's markup half.
  expect(deferred).toEqual(["DOMContentLoaded", "DOMContentLoaded"]);
});

test("every injected tab label matches the strip the addon reproduces", () => {
  // The panel's copy of the strip and the addon's reproduction of it are two
  // renderings of ADDON_SITE_TABS; a label typed into either by hand is how
  // they drift.
  const injected = [
    { slug: "git", targets: GIT_TARGETS, url: "/addons/git" },
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

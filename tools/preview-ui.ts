// Local UI review with fictional data. Never starts the manager, reads panel
// state or invokes an action. Mutating requests are rejected deliberately.
import { indexPage, updatePage } from "../cli/index";
import { dashboardView as cloudflareDashboardView, layout as cloudflareLayout } from "../addons/cloudflare-ips/app/views";
import { dashboardView, layout as instaticLayout, newInstanceView, jobView as instaticJobView } from "../addons/instatic/app/views";
import { jobsView, jobView, layout as stagerLayout, fragment as stagerFragment, newCloneView, promoteListView, promoteView, siteStagingView } from "../addons/stager/app/views";
import { fleetView as maintenanceFleetView, fragment as maintenanceFragment, layout as maintenanceLayout, siteView as maintenanceSiteView } from "../addons/maintenance/app/views";
import { dashboardView as phpResourcesDashboardView, layout as phpResourcesLayout } from "../addons/php-resources/app/views";
import { dashboardView as panelTweaksDashboardView, layout as panelTweaksLayout } from "../addons/panel-tweaks/app/views";
import { siteLayoutTarget } from "../lib/panel-nav";
import { sitesSnippet } from "../addons/panel-tweaks/inject/targets";
import { STAGER_TARGETS } from "../addons/stager/inject/targets";
import { MENU_ONLY_CLASS } from "../lib/row-actions";

/** The `site.type` values Stager's own Twig condition offers a Clone for. */
const CLONABLE_TYPES = ["php", "static", "reverse-proxy"];
import { WP_LOGIN_TARGETS } from "../addons/wp-login/inject/targets";
import { dashboardView as wpLoginDashboardView, layout as wpLoginLayout } from "../addons/wp-login/app/views";
import { WORDPRESS_APPLICATIONS, type WpSiteView } from "../addons/wp-login/action";
import { siteTabs, type SiteContext } from "../lib/site-context";
import { DEFAULT_MAINTENANCE_TEMPLATE } from "../addons/maintenance/action";
import { PRESET_CATEGORIES, STOCK_PROFILE, type PhpResourcesState, type PoolSiteState } from "../addons/php-resources/action";
import type { PanelTweaksState } from "../addons/panel-tweaks/action";
import ACE_MODE_HTML from "../addons/maintenance/app/ace-mode-html.js" with { type: "text" };
import type { InstanceView, InstaticJobView } from "../addons/instatic/app/service";
import type { JobView, SiteDetail, SiteSummary } from "../addons/stager/app/service";
import type { AvailableTags } from "../addons/instatic/app/tags";
import { withCsrfCookie, SECURITY_HEADERS } from "../lib/app-http";

const versions: AvailableTags = { tags: ["0.0.19", "0.0.18"], latest: "0.0.19", source: "registry" };
const instances: InstanceView[] = [
  { domain: "pages.example.com", port: 39000, tag: "0.0.19", state: "running" },
  { domain: "docs.example.com", port: 39001, tag: "0.0.18", state: "running" },
  { domain: "preview.example.com", port: 39002, tag: "0.0.18", state: "exited" },
].map((i) => ({ ...i, container: i.domain, siteUser: i.domain.split(".")[0]!, createdAt: "2026-09-10T09:30:00Z", panelSite: true }));
const sites: SiteSummary[] = [
  { domain: "www.example.com", siteType: "php", siteUser: "example", phpVersion: "8.2", application: "WordPress", databases: 1 },
  { domain: "static.example.com", siteType: "static", siteUser: "static", phpVersion: "", application: "Static HTML", databases: 0 },
  { domain: "pages.example.com", siteType: "reverse-proxy", siteUser: "pages", phpVersion: "", application: "Instatic", databases: 0 },
];
// Which native site tabs a site-scoped addon page draws depends on the site's
// type and Varnish setting, so the preview carries both. www has Varnish, which
// is the widest strip a site can have.
const siteVarnish: Record<string, boolean> = { "www.example.com": true };
const PREVIEW_PUBLIC_IP = "203.0.113.10";

/**
 * The Staging tab's content for one site.
 *
 * Both ends of a clone, because the page answers two questions and a fixture
 * showing only one would hide half the view: `?staged-from=1` makes this site a
 * clone of another, which is what puts the Promote section on screen.
 */
function previewSiteStaging(domain: string, siteType: string, url: URL): string {
  const base: JobView = {
    id: "preview-clone", kind: "clone", source: "", target: "", port: 0, state: "done",
    step: "", error: "", panelSite: true, createdAt: "2026-09-10T09:30:00Z",
    startedAt: "2026-09-10T09:30:02Z", finishedAt: "2026-09-10T09:32:10Z", result: null,
  };
  if (url.searchParams.has("empty")) {
    return siteStagingView(domain, [], siteType !== "nodejs" && siteType !== "python");
  }
  const jobs: JobView[] = [
    { ...base, id: "preview-clone-1", source: domain, target: `stg.${domain}` },
    { ...base, id: "preview-clone-2", source: domain, target: `qa.${domain}`, state: "running", step: "copying files" },
  ];
  if (url.searchParams.has("staged-from")) {
    jobs.push({ ...base, id: "preview-clone-3", source: "live.example.com", target: domain, result: {} as never });
  }
  return siteStagingView(domain, jobs, siteType !== "nodejs" && siteType !== "python");
}
const job: JobView = {
  id: "preview-job", kind: "clone", source: "www.example.com", target: "stg.example.com", port: 0,
  state: "done", step: "", error: "", panelSite: true,
  createdAt: "2026-09-10T09:30:00Z", startedAt: "2026-09-10T09:30:02Z", finishedAt: "2026-09-10T09:32:10Z",
  result: {
    siteType: "php", siteUser: "staging", phpVersion: "8.2", vhostTemplate: "WordPress",
    vhostCarried: true, vhostCarriedBy: "template", instatic: null,
    database: { source: "example", name: "staging", user: "staging", password: "preview-only-password" },
    notes: ["The source site's files and database were copied successfully."],
  },
};
const logs = "[09:30:02] Preparing staging site\n[09:30:16] Copying files\n[09:31:48] Importing database\n[09:32:10] Clone completed";

const instaticCreationJob: InstaticJobView = {
  id: "preview-instatic-job",
  domain: "blog.example.com",
  port: 39003,
  tag: "0.0.19",
  tls: true,
  state: "done",
  step: "instance created successfully",
  createdAt: "2026-09-10T09:30:00Z",
  startedAt: "2026-09-10T09:30:01Z",
  finishedAt: "2026-09-10T09:31:15Z",
};
const instaticLogs = "[instatic] creating CloudPanel reverse-proxy site for blog.example.com\n[instatic] preparing instance storage\n[instatic] pulling ghcr.io/corebunch/instatic:0.0.19\n[instatic] starting instatic-blog.example.com on 127.0.0.1:39003\n[instatic] waiting for health check\n[instatic] requesting a Let's Encrypt certificate for blog.example.com\n[instatic] instance created successfully";
const cloudflareSites = [
  { domain: "www.example.com", type: "php", enabled: true, excludedFromAutomatic: false },
  { domain: "static.example.com", type: "static", enabled: false, excludedFromAutomatic: true },
  { domain: "pages.example.com", type: "reverse-proxy", enabled: true, excludedFromAutomatic: false },
  { domain: "a-rather-long-customer-hostname.staging.example.com", type: "nodejs", enabled: false, excludedFromAutomatic: false },
];

/** ?sites=all|none|mixed and ?auto=off cover the states the controls describe. */
function cloudflarePreviewState(url: URL) {
  const all = url.searchParams.get("sites");
  const sites = cloudflareSites.map((site) => all === "all"
    ? { ...site, enabled: true }
    : all === "none" ? { ...site, enabled: false } : site);
  return {
    autoEnableNewSites: url.searchParams.get("auto") !== "off",
    sites: url.searchParams.has("empty") ? [] : sites,
  };
}

/**
 * PHP sites with a pool file, in the three states the page distinguishes: in a
 * category, in none, and in one but since overwritten -- which is what a PHP
 * version change leaves behind.
 */
const phpPoolSites: PoolSiteState[] = [
  {
    domain: "www.example.com", siteUser: "example", phpVersion: "8.3",
    poolFile: "/etc/php/8.3/fpm/pool.d/www.example.com.conf",
    current: { ...PRESET_CATEGORIES[1]!.profile },
    categoryId: "busy-site", categoryName: "Busy site",
    drifted: false,
  },
  {
    domain: "shop.example.com", siteUser: "shop", phpVersion: "8.2",
    poolFile: "/etc/php/8.2/fpm/pool.d/shop.example.com.conf",
    current: { ...PRESET_CATEGORIES[2]!.profile },
    categoryId: "high-traffic", categoryName: "High traffic",
    drifted: false,
  },
  {
    domain: "blog.example.com", siteUser: "blog", phpVersion: "8.3",
    poolFile: "/etc/php/8.3/fpm/pool.d/blog.example.com.conf",
    current: { ...STOCK_PROFILE },
    categoryId: null, categoryName: null,
    drifted: false,
  },
  {
    domain: "a-rather-long-customer-hostname.staging.example.com", siteUser: "longname", phpVersion: "8.1",
    poolFile: "/etc/php/8.1/fpm/pool.d/a-rather-long-customer-hostname.staging.example.com.conf",
    current: { ...STOCK_PROFILE },
    categoryId: "small-site", categoryName: "Small site",
    drifted: true,
  },
];

/** ?default=off leaves new sites uncategorised; ?empty= drops the fleet. */
function phpResourcesPreviewState(url: URL): PhpResourcesState {
  return {
    categories: url.searchParams.has("no-categories") ? [] : PRESET_CATEGORIES,
    defaultCategoryId: url.searchParams.get("default") === "off" ? null : "busy-site",
    sites: url.searchParams.has("empty") ? [] : phpPoolSites,
  };
}

/**
 * Panel UI tweaks with every switch on and most sites measured, because that is
 * the widest the page gets: `?off` is the state an operator lands on after
 * enabling the addon, and `?unmeasured` is the gap before the first sweep.
 */
function panelTweaksPreviewState(url: URL): PanelTweaksState {
  const on = !url.searchParams.has("off");
  const measured = on && !url.searchParams.has("unmeasured");
  const at = "2026-09-17T08:45:00Z";
  return {
    tweaks: {
      deviceTheme: on,
      sitesTable: on,
      sitesMobile: on,
      actionMenu: url.searchParams.has("menu"),
      panelMobile: on,
      diskUsage: on,
    },
    diskMeasuredAt: measured ? at : "",
    sites: url.searchParams.has("empty") ? [] : [
      {
        domain: "www.example.com", user: "example", type: "php", application: "WordPress",
        runtime: "PHP 8.2", createdAt: "2024-03-02 09:30:00", cloudflareOnly: true, varnish: false, certificate: { type: "2", expiresAt: "2026-11-30 10:00:00" },
        disk: measured ? { bytes: 4_812_003_328, databaseBytes: 412_003_328, measuredAt: at } : null,
      },
      {
        domain: "shop.example.com", user: "shop", type: "php", application: "WordPress",
        runtime: "PHP 8.3", createdAt: "2025-11-19 14:05:00", cloudflareOnly: true, varnish: true, certificate: { type: "2", expiresAt: "2026-09-24 10:00:00" },
        disk: measured ? { bytes: 19_327_352_832, databaseBytes: 2_147_483_648, measuredAt: at } : null,
      },
      {
        domain: "static.example.com", user: "static", type: "static", application: "Static",
        runtime: "", createdAt: "2026-01-08 08:15:00", cloudflareOnly: false, varnish: false, certificate: null,
        disk: measured ? { bytes: 24_117_248, databaseBytes: 0, measuredAt: at } : null,
      },
      {
        domain: "app.example.com", user: "app", type: "nodejs", application: "Nodejs",
        runtime: "Node.js 20", createdAt: "2026-06-21 17:40:00", cloudflareOnly: false, varnish: false, certificate: { type: "1", expiresAt: "2027-09-05 10:00:00" },
        disk: null,
      },
      // A hostname wider than a phone, which is what the card's first line has
      // to survive: the tag keeps its corner and the name wraps beside it.
      {
        domain: "staging.newsletter.example-church-of-the-hills.com", user: "news", type: "php",
        application: "WordPress", runtime: "PHP 8.2", createdAt: "2026-08-03 12:00:00",
        cloudflareOnly: false, varnish: false,
        certificate: { type: "2", expiresAt: "2026-10-30 10:00:00" },
        disk: measured ? { bytes: 41_943_040, databaseBytes: 8_388_608, measuredAt: at } : null,
      },
      {
        domain: "cdn.example.com", user: "cdn", type: "reverse-proxy", application: "ReverseProxy",
        runtime: "", createdAt: "2026-09-01 11:00:00", cloudflareOnly: false, varnish: true, certificate: { type: "2", expiresAt: "2026-12-20 10:00:00" },
        disk: measured ? { bytes: 1_048_576, databaseBytes: 0, measuredAt: at } : null,
      },
    ],
  };
}

// A stand-in for a CloudPanel site page, so the block the manager injects into
// the panel can be exercised without a panel. The markup mirrors
// Frontend/Site/settings.html.twig and the rules are the panel's own, from
// assets/css/style.css and assets/css/frontend/site.css.
const PANEL_STUB_STYLE = `
/* Bootstrap, which the panel loads and this stub does not, sets this globally. */
*, *::before, *::after { box-sizing: border-box; }
body { margin: 0; font-family: 'Helvetica Neue','Segoe UI',Helvetica,Arial,sans-serif; font-size: 16px;
  background: #f9fafb; color: #212529; }
a { color: #3c3c3c; text-decoration: none; }
html.dark body { background: #0e1217; color: #fff; }
.main-container { padding: 0 0 60px; }
.container-fluid { width: 100%; padding: 0 12px; margin: 0 auto; }
.container-limited-width { max-width: 1200px; }
.site-info-container { display: flex; margin: 30px 0; }
.site-info-box { margin: 0 60px 0 0; min-width: 200px; }
.site-info-box h3 { font-size: 14px; color: #aaa; margin: 0 0 5px; font-weight: 500; }
.site-info-value { font-size: 18px; }
.tab-container { border: 1px solid #e2e2e2; background: #fff; margin: 0 0 30px; }
html.dark .tab-container { background: #25282f; border-color: #a8b3cf33; }
.tab-container ul { padding: 0 20px; margin: 0; list-style: none; }
.tab-container ul li { display: inline-block; padding: 20px 0; }
.tab-container ul li a { padding: 20px 15px; color: #666; text-decoration: none; }
html.dark .tab-container ul li a { color: #9b9b9b; }
.tab-container ul li.active a { color: #000; border-bottom: 3px solid #0078d4; }
html.dark .tab-container ul li.active a { color: #fff; }
.preview-banner { background: #936319; color: #fff; padding: 6px 12px; font-size: 13px; text-align: center; }
.preview-banner button { margin-left: 12px; }
`;

function panelSiteStub(site: SiteContext, activeSlug: string): string {
  const tabs = siteTabs(site, activeSlug)
    .map((tab) => `      <li${tab.active ? ' class="active"' : ""}><a href="${tab.href}">${tab.label}</a></li>`)
    .join("\n");
  return `<!doctype html>
<html id="html" lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no">
<title>${site.domain}</title>
<script>document.documentElement.classList.toggle('dark', /(?:^|;\\s*)theme=dark(?:;|$)/.test(document.cookie));</script>
<style>${PANEL_STUB_STYLE}</style>
</head>
<body>
<div class="preview-banner">Stand-in for a CloudPanel site page
  <button type="button" onclick="document.documentElement.classList.toggle('dark')">Toggle panel theme</button>
</div>
<main id="main-container" class="main-container">
  <div class="container-fluid container-limited-width">
    <div class="site-container">
      <div class="site-info-container">
        <div class="site-info-box"><h3>Domain</h3><div class="site-info-value"><a href="https://${site.domain}">${site.domain}</a></div></div>
        <div class="site-info-box"><h3>Site User</h3><div class="site-info-value">${site.user}</div></div>
        <div class="site-info-box"><h3>IP Address</h3><div class="site-info-value">${PREVIEW_PUBLIC_IP}</div></div>
      </div>
      <div class="site-content-container">
${siteLayoutTarget().snippet("/addons/")}<div class="tab-container">
    <ul>
${tabs}
    </ul>
  </div>
        <div class="site-content">
          <p>This is whatever CloudPanel would render for the ${activeSlug} tab.</p>
        </div>
      </div>
    </div>
  </div>
</main>
</body>
</html>`;
}

/**
 * A stand-in for CloudPanel's own Sites page, so the block Panel UI tweaks injects
 * there can be reviewed without a panel. The markup is
 * Frontend/Site/index.html.twig with its Twig evaluated, and the rules are the
 * panel's own from assets/css/style.css and assets/css/frontend/sites.css.
 */
const WP_LOGIN_SITES_SCRIPT = WP_LOGIN_TARGETS.find((target) => target.slug === "sites-script")!;
const STAGER_SITES_STYLE = STAGER_TARGETS.find((target) => target.slug === "site-list-style")!;

function unwrapTwig(block: string): string {
  return block.replace("{% if is_granted('ROLE_ADMIN') %}", "").replace("{% endif %}", "");
}

/**
 * Three addons put a block above CloudPanel's sites table; the stub shows all.
 * Panel UI tweaks is handed the previewed switches rather than reading the ones
 * stored on a server, so `?off` and `?menu` change the injected markup here the
 * way a reconciliation would change it on a box.
 */
function injectedSitesBlocks(state: PanelTweaksState): string {
  return [
    unwrapTwig(sitesSnippet("/addons/panel-tweaks", state.tweaks)),
    unwrapTwig(WP_LOGIN_SITES_SCRIPT.snippet("/addons/wp-login")),
    unwrapTwig(STAGER_SITES_STYLE.snippet("/addons/stager")),
  ].join("\n");
}

/** WordPress everywhere but the static and reverse-proxy sites. */
function wpLoginPreviewSites(url: URL): WpSiteView[] {
  if (url.searchParams.has("empty")) return [];
  return [
    { domain: "www.example.com", user: "example", application: "WordPress", helper: true },
    { domain: "shop.example.com", user: "shop", application: "WooCommerce", helper: true },
    { domain: "blog.example.com", user: "blog", application: "Generic", helper: false },
  ];
}

function panelSitesStub(state: PanelTweaksState, dark: boolean): string {
  const rows = state.sites.map((site) => `                  <tr>
                    <td><a href="/site/${site.domain}/settings">${site.domain}</a></td>
                    <td>${site.user}</td>
                    <td>${site.type.toUpperCase()}</td>
                    <td class="text-end"><a href="/site/${site.domain}/settings">Manage</a>${WORDPRESS_APPLICATIONS.includes(site.application)
                      ? `<a href="#" class="clp-wp-login" data-clp-domain="${site.domain}">WP Login</a>`
                      : ""}${CLONABLE_TYPES.includes(site.type) ? `<a class="${MENU_ONLY_CLASS}" href="/addons/stager/new?source=${site.domain}">Clone</a>` : ""}</td>
                  </tr>`).join("\n");
  return `<!doctype html>
<html lang="en"${dark ? ' class="dark"' : ""}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no">
<title>Sites</title>
<script>if (/(?:^|;\\s*)theme=dark(?:;|$)/.test(document.cookie)) document.documentElement.classList.add('dark');</script>
<style>${PANEL_STUB_STYLE}
.page-header { display: flex; align-items: center; justify-content: space-between; margin: 30px 0 20px; }
.page-title h1 { font-size: 30px; margin: 0; }
.card.card-table { background: #fff; border: 1px solid #00000020; border-radius: 4px; box-shadow: 0 2px 4px rgb(157 161 164 / 19%); }
html.dark .card.card-table { background: #1c1f26; border-color: #a8b3cf33; box-shadow: none; }
table.table-sites { width: 100%; border-collapse: collapse; }
table.table-sites th { text-align: left; font-size: 14px; text-transform: uppercase; color: #9bacb6;
  background: #fbfcfc; padding: 18px 32px; font-weight: 700; }
html.dark table.table-sites th { background: #25282f; }
table.table-sites td { padding: 18px 32px; border-top: 1px solid #eaeaea; }
html.dark { --clp-border-color: #a8b3cf33; }
html.dark table.table-sites td { border-color: var(--clp-border-color); }
.text-end { text-align: right; }
.form-control, .form-select { padding: 8px 16px; border: 1px solid #ced4da; border-radius: 4px; font: inherit; min-height: 42px; }
html.dark .form-control, html.dark .form-select { background: #20242c; color: #fff; border-color: #a8b3cf33; }
</style>
</head>
<body>
<div class="preview-banner">Stand-in for CloudPanel's own Sites page
  <button type="button" onclick="document.documentElement.classList.toggle('dark')">Toggle panel theme</button>
</div>
<main class="main-container">
  <div class="container-fluid container-limited-width">
    <div class="page-header">
      <div class="page-title"><h1>Sites</h1></div>
      <div class="page-actions"><a href="#">+ Add Site</a></div>
    </div>
${injectedSitesBlocks(state)}
    <div class="card card-table">
      <table class="table table-sites">
        <thead>
          <tr><th>Domain</th><th>Site User</th><th>App</th><th class="text-end">Action</th></tr>
        </thead>
        <tbody>
${rows}
        </tbody>
      </table>
    </div>
  </div>
</main>
</body>
</html>`;
}

let panelAce: string | null = null;

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT || 4100),
  async fetch(req, server) {
    const url = new URL(req.url);
    const path = url.pathname;
    if (req.method !== "GET") return Response.json({ ok: false, error: "UI preview only; no changes were made." }, { status: 409 });
    // These are the same two logo URLs the installed manager gets from its
    // CloudPanel origin. Only this development preview fetches the public demo.
    if (["/assets/images/logo.svg", "/assets/images/logo-dark.svg"].includes(path)) {
      const upstream = await fetch(`https://demo.cloudpanel.io${path}`);
      // fetch decodes compression; do not forward the original Content-Encoding.
      return new Response(await upstream.arrayBuffer(), {
        status: upstream.status,
        headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=3600" },
      });
    }
    // CloudPanel serves its own Ace build here, which the maintenance editor
    // uses. Only this development preview borrows it from the public demo.
    if (path === "/assets/js/ace.min.js") {
      // PREVIEW_NO_ACE stands in for a panel release that stopped shipping it,
      // which has to leave a working textarea behind.
      if (process.env.PREVIEW_NO_ACE) return new Response("Not found", { status: 404 });
      panelAce ??= await (await fetch(`https://demo.cloudpanel.io${path}`)).text();
      return new Response(panelAce, {
        headers: { "Content-Type": "text/javascript", "Cache-Control": "public, max-age=3600" },
      });
    }
    if (["/", "/dashboard"].includes(path)) return Response.redirect("/addons/");
    // /sites stands in for the panel's own site list, with the addon's block in
    // place; /addons/panel-tweaks/api/panel is what that block then asks for.
    if (path === "/sites") {
      return new Response(panelSitesStub(panelTweaksPreviewState(url), url.searchParams.has("dark")), {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
    if (path === "/addons/panel-tweaks/api/panel") {
      // The injected block's URL is fixed, so the fixture the stub was drawn
      // from is named by the page that asked rather than by this request.
      const asked = req.headers.get("referer");
      const state = panelTweaksPreviewState(asked ? new URL(asked) : url);
      return Response.json({ ok: true, data: state });
    }
    // /site/{domain}/{tab} stands in for the panel's own site page.
    const panelSite = /^\/site\/([^/]+)\/([^/]+)$/.exec(path);
    if (panelSite) {
      const domain = decodeURIComponent(panelSite[1]!);
      const site = sites.find((candidate) => candidate.domain === domain) ?? sites[0]!;
      return new Response(
        panelSiteStub(
          { domain: site.domain, user: site.siteUser, type: site.siteType, varnishCache: siteVarnish[site.domain] === true },
          panelSite[2]!,
        ),
        { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
      );
    }
    if (path === "/addons/maintenance/ace/mode-html.js") {
      return new Response(ACE_MODE_HTML, { headers: { "Content-Type": "text/javascript; charset=utf-8" } });
    }
    if (path === "/addons/maintenance/fragment") {
      const domain = url.searchParams.get("domain") ?? sites[0]!.domain;
      const site = sites.find((candidate) => candidate.domain === domain);
      if (!site) return Response.json({ ok: false, error: "no such site" }, { status: 404 });
      const view = {
        domain: site.domain, type: site.siteType, user: site.siteUser,
        enabled: site.domain === sites[0]!.domain, customTemplate: false, bypasses: ["203.0.113.8"],
      };
      // The real route sets the CSRF cookie here, and where that cookie is
      // readable from decides whether a mounted page can act at all.
      return Response.json(
        maintenanceFragment(
          `Maintenance — ${domain}`,
          maintenanceSiteView(view, { domain, custom: false, html: DEFAULT_MAINTENANCE_TEMPLATE }, "203.0.113.8", url.searchParams.has("global")),
        ),
        { headers: withCsrfCookie({}, "preview-token") },
      );
    }
    if (path === "/addons/stager/fragment") {
      const domain = url.searchParams.get("domain") ?? sites[0]!.domain;
      const site = sites.find((candidate) => candidate.domain === domain);
      if (!site) return Response.json({ ok: false, error: "no such site" }, { status: 404 });
      return Response.json(
        stagerFragment(`Staging — ${domain}`, previewSiteStaging(domain, site.siteType, url)),
        { headers: withCsrfCookie({}, "preview-token") },
      );
    }
    const empty = url.searchParams.has("empty");
    const notice = url.searchParams.has("update") || path === "/addons/update" ? { current: "0.9.3", latest: "0.9.4" } : null;
    const age = url.searchParams.has("stale") ? 7200 : 30;
    const state = url.searchParams.get("state");
    const currentJob: JobView = state && ["running", "failed", "queued"].includes(state)
      ? { ...job, state, result: null, finishedAt: "", step: "Copying files", error: state === "failed" ? "Could not copy the source files. The staging site was removed." : "" }
      : job;
    let html: string;
    if (path === "/addons/update") {
      const jobState = state && ["running", "queued", "failed"].includes(state) ? state : null;
      return updatePage(url.searchParams.has("offline") ? null : {
        current: "0.9.3", latest: url.searchParams.has("current") ? "0.9.3" : "0.9.4", hasUpdate: !url.searchParams.has("current"),
      }, "0.9.3", {
        csrf: "preview-csrf-token",
        job: jobState ? {
          id: "20260910T093000Z-abc123", kind: "update", addon: "", state: jobState,
          step: "Downloading release", error: jobState === "failed" ? "Could not download the release. Try again later." : "",
          createdAt: "2026-09-10T09:30:00Z", startedAt: "2026-09-10T09:30:01Z", finishedAt: "",
        } : null,
      });
    }
    if (path === "/addons/") {
      // ?enabled= picks which addons are on, so the Available section and the
      // enable/disable buttons can be reviewed without a CloudPanel install.
      const enabled = empty ? [] : (url.searchParams.get("enabled") ?? "cloudflare-ips,instatic,stager,maintenance,php-resources").split(",").filter(Boolean);
      const previewJob = state && ["running", "queued", "failed"].includes(state)
        ? {
            id: "20260910T093000Z-abc123", kind: "enable", addon: "stager", state,
            step: "enabling stager", error: state === "failed" ? "docker is not active; install and start it before enabling stager" : "",
            createdAt: "2026-09-10T09:30:00Z", startedAt: "2026-09-10T09:30:01Z", finishedAt: "",
          }
        : null;
      const page = indexPage(enabled, notice, {
        available: ["cloudflare-ips", "instatic", "stager", "maintenance", "php-resources", "panel-tweaks", "wp-login"].filter((name) => !enabled.includes(name)),
        job: previewJob,
        csrf: "preview-csrf-token",
      });
      // ?confirm=<addon> opens the disable dialog on load. A modal only exists
      // after a click, and the screenshot tool does not click; without this the
      // one dialog an operator sees before turning an addon off cannot be
      // reviewed the way every other view can.
      const openDialog = url.searchParams.get("confirm");
      if (!openDialog) return page;
      const body = await page.text();
      return new Response(
        body.replace("</body>", `<script>addEventListener('DOMContentLoaded',function(){disableAddon(${JSON.stringify(openDialog)}, ${JSON.stringify(openDialog === "instatic" ? "Instatic CMS" : openDialog)})})</script></body>`),
        { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
      );
    }
    if (path === "/addons/maintenance/" || path === "/addons/maintenance") {
      const maintenanceSites = sites.map((site, index) => ({
        domain: site.domain, type: site.siteType, user: site.siteUser,
        enabled: index === 0, customTemplate: index === 1, bypasses: index === 0 ? ["203.0.113.8"] : [],
        ...(index === 2 ? { error: "status unavailable" } : {}),
      }));
      // ?global=1 shows the override active, which is the state whose wording
      // has to distinguish effective status from each site's saved setting.
      const globalEnabled = url.searchParams.has("global");
      const selected = url.searchParams.get("domain");
      const site = maintenanceSites.find((candidate) => candidate.domain === selected);
      html = maintenanceLayout(
        site ? `Maintenance — ${site.domain}` : "Maintenance Mode",
        site
          ? maintenanceSiteView(site, { domain: site.domain, custom: site.customTemplate, html: DEFAULT_MAINTENANCE_TEMPLATE }, "203.0.113.8", globalEnabled)
          : maintenanceFleetView(empty ? [] : maintenanceSites, globalEnabled),
        notice,
        site
          ? {
              domain: site.domain,
              user: site.user,
              type: site.type,
              varnishCache: siteVarnish[site.domain] === true,
              ...(url.searchParams.has("no-ip") ? {} : { publicIp: PREVIEW_PUBLIC_IP }),
            }
          : undefined,
      );
    } else if (path === "/addons/panel-tweaks/" || path === "/addons/panel-tweaks") {
      html = panelTweaksLayout("Panel UI tweaks", panelTweaksDashboardView(panelTweaksPreviewState(url)), notice);
    } else if (path === "/addons/wp-login/" || path === "/addons/wp-login") {
      html = wpLoginLayout("WordPress Sign-In", wpLoginDashboardView(wpLoginPreviewSites(url)), notice);
    } else if (path === "/addons/php-resources/" || path === "/addons/php-resources") {
      html = phpResourcesLayout("PHP resources", phpResourcesDashboardView(phpResourcesPreviewState(url)), notice);
    } else if (path === "/addons/cloudflare-ips/" || path === "/addons/cloudflare-ips") {
      html = cloudflareLayout("Cloudflare IP access", cloudflareDashboardView(cloudflarePreviewState(url)), notice);
    } else if (path === "/addons/instatic/") {
      html = instaticLayout("Instatic sites", dashboardView(empty ? [] : instances, age,
        sites.map((s) => ({ domain: s.domain, type: s.siteType, user: s.siteUser })), versions), notice);
    } else if (path === "/addons/instatic/new") {
      html = instaticLayout("New Instatic site", newInstanceView(39003, versions), notice);
    } else if (path === "/addons/instatic/jobs/preview-instatic-job") {
      html = instaticLayout("Creating blog.example.com", instaticJobView(instaticCreationJob, instaticLogs), notice);
    } else if (path.startsWith("/addons/instatic/api/") && path.endsWith("/creation-log")) {
      return Response.json({ ok: true, data: { domain: "pages.example.com", log: instaticLogs } });
    } else if (path.startsWith("/addons/instatic/api/") && path.endsWith("/logs")) {
      return Response.json({ ok: true, data: { logs: "Instatic listening on 127.0.0.1:39000\nReady to accept requests" } });
    } else if (path === "/addons/instatic/api/jobs/preview-instatic-job/events" || (path === "/addons/instatic/api/jobs/preview-instatic-job" && req.headers.get("accept")?.includes("text/event-stream"))) {
      if (server && typeof server.timeout === "function") {
        try { server.timeout(req, 0); } catch {}
      }
      return new Response(
        `data: ${JSON.stringify({ job: instaticCreationJob, log: instaticLogs })}\n\n`,
        {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            ...SECURITY_HEADERS,
          },
        },
      );
    } else if (path === "/addons/instatic/api/jobs/preview-instatic-job") {
      return Response.json({ ok: true, data: { job: instaticCreationJob, log: instaticLogs } });
    } else if (path === "/addons/stager/" || path === "/addons/stager") {
      // ?domain= is the site-scoped page the Staging tab reaches, drawn here
      // with the panel's chrome around it the way the standalone ?embed=0 page
      // is; the fragment route above is the same content with no document.
      const selected = url.searchParams.get("domain");
      const site = sites.find((candidate) => candidate.domain === selected);
      html = site
        ? stagerLayout(
            `Staging — ${site.domain}`,
            previewSiteStaging(site.domain, site.siteType, url),
            notice,
            {
              domain: site.domain,
              user: site.siteUser,
              type: site.siteType,
              varnishCache: siteVarnish[site.domain] === true,
              ...(url.searchParams.has("no-ip") ? {} : { publicIp: PREVIEW_PUBLIC_IP }),
            },
          )
        : stagerLayout("Staging sites", jobsView(empty ? [] : [currentJob], age), notice);
    } else if (path === "/addons/stager/new") {
      const source = sites.find((s) => s.domain === url.searchParams.get("source"));
      const detail: SiteDetail | null = source ? {
        ...source, instatic: source.siteType === "reverse-proxy", rootDirectory: source.domain,
        database: source.databases ? "example" : "", sizeMb: 148,
      } : null;
      html = stagerLayout("New staging site", newCloneView(detail, empty ? [] : sites), notice);
    } else if (path === "/addons/stager/promote") {
      // ?job= is what the list's Promote link carries, so following it here
      // reaches the same view it reaches in the panel. The preview had its own
      // /promote/confirm instead, which nothing linked to.
      html = url.searchParams.has("job")
        ? stagerLayout("Promote to live", promoteView(currentJob), notice)
        : stagerLayout("Promote to live", promoteListView(empty ? [] : [currentJob]), notice);
    } else if (path === "/addons/stager/jobs/preview-job") {
      html = stagerLayout("Staging site details", jobView(currentJob, logs), notice);
    } else if (path === "/addons/stager/api/jobs/preview-job/events" || (path === "/addons/stager/api/jobs/preview-job" && req.headers.get("accept")?.includes("text/event-stream"))) {
      if (server && typeof server.timeout === "function") {
        try { server.timeout(req, 0); } catch {}
      }
      return new Response(
        `data: ${JSON.stringify({ job: { ...currentJob, state: "running", result: null }, log: logs })}\n\n`,
        {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            ...SECURITY_HEADERS,
          },
        },
      );
    } else if (path === "/addons/stager/api/jobs/preview-job") {
      return Response.json({ ok: true, data: { job: { ...currentJob, state: "running", result: null }, log: logs } });
    } else return new Response("Not found", { status: 404 });
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
  },
});
console.log(`UI preview (fictional data): ${server.url}addons/`);

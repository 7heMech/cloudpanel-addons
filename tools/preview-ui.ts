// Local UI review with fictional data. Never starts the manager, reads panel
// state or invokes an action. Mutating requests are rejected deliberately.
import { indexPage, updatePage } from "../cli/index";
import { handle as loginThemePage } from "../addons/login-theme/app/index";
import { dashboardView as cloudflareDashboardView, layout as cloudflareLayout } from "../addons/cloudflare-ips/app/views";
import { dashboardView, layout as instaticLayout, newInstanceView, jobView as instaticJobView } from "../addons/instatic/app/views";
import { jobsView, jobView, layout as stagerLayout, fragment as stagerFragment, newCloneView, promoteListView, promoteView, siteStagingView } from "../addons/stager/app/views";
import { fleetView as gitFleetView, fragment as gitFragment, layout as gitLayout, siteView as gitSiteView } from "../addons/git/app/views";
import { fleetView as maintenanceFleetView, fragment as maintenanceFragment, layout as maintenanceLayout, siteView as maintenanceSiteView } from "../addons/maintenance/app/views";
import { dashboardView as phpResourcesDashboardView, layout as phpResourcesLayout } from "../addons/php-resources/app/views";
import { siteLayoutTarget } from "../lib/panel-nav";
import { siteTabs, type SiteContext } from "../lib/site-context";
import { DEFAULT_MAINTENANCE_TEMPLATE } from "../addons/maintenance/action";
import { PRESET_CATEGORIES, STOCK_PROFILE, type PhpResourcesState, type PoolSiteState } from "../addons/php-resources/action";
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

const gitLog = [
  "[git] deploying git@github.com:example/shop.git (main) into /home/example/htdocs/www.example.com as example",
  "[git] fetching main",
  "From github.com:example/shop",
  " * branch            main       -> FETCH_HEAD",
  "[git] updating the working tree",
  "HEAD is now at 9f2c1ab Add the checkout summary",
  "[git] $ composer install --no-dev",
  "Installing dependencies from lock file",
  "[git] deployment finished",
].join("\n");

/**
 * The three states the Git pages distinguish: deployed, never deployed, and
 * configured for a site CloudPanel no longer has.
 */
function gitPreviewSites(url: URL) {
  const commit = {
    hash: "9f2c1ab7c0f0ad0e0f6d2f1b2a3c4d5e6f708192", shortHash: "9f2c1ab",
    author: "Ada Lovelace", committedAt: "2026-09-17T11:04:00Z", subject: "Add the checkout summary",
  };
  const job = {
    id: "20260917T110500Z-ab12cd", kind: "deploy", domain: "www.example.com",
    state: url.searchParams.get("state") ?? "done", step: "running the post-deploy command", error: "",
    createdAt: "2026-09-17T11:05:00Z", startedAt: "2026-09-17T11:05:01Z",
    finishedAt: url.searchParams.get("state") ? "" : "2026-09-17T11:05:42Z",
    result: null,
  };
  if (job.state === "failed") job.error = "the post-deploy command failed; the files are deployed and the command did not finish";
  return [
    {
      domain: "www.example.com", siteUser: "example", siteType: "php",
      path: "/home/example/htdocs/www.example.com", configured: true,
      config: {
        domain: "www.example.com", remote: "git@github.com:example/shop.git", branch: "main",
        directory: "", postDeploy: "composer install --no-dev", updatedAt: "2026-09-15T08:00:00Z",
      },
      publicKey: url.searchParams.has("no-key") ? "" :
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPreviewKeyForTheUiOnlyNotARealKey00 clp-addons deploy key for www.example.com",
      commit, lastJob: job,
    },
    {
      domain: "static.example.com", siteUser: "static", siteType: "static",
      path: "/home/static/htdocs/static.example.com/public", configured: true,
      config: {
        domain: "static.example.com", remote: "https://github.com/example/docs.git", branch: "release/2.1",
        directory: "public", postDeploy: "", updatedAt: "2026-09-16T09:10:00Z",
      },
      publicKey: "", commit: null, lastJob: null,
    },
  ];
}

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
<meta name="viewport" content="width=device-width, initial-scale=1">
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
    // The job the Git pages watch, so ?state=running can be reviewed as a live
    // view rather than as a stream that never answers.
    if (path.startsWith("/addons/git/api/jobs/")) {
      const gitJob = gitPreviewSites(url)[0]!.lastJob!;
      if (path.endsWith("/events") || req.headers.get("accept")?.includes("text/event-stream")) {
        if (server && typeof server.timeout === "function") {
          try { server.timeout(req, 0); } catch {}
        }
        return new Response(`data: ${JSON.stringify({ job: gitJob, log: gitLog })}\n\n`, {
          headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", ...SECURITY_HEADERS },
        });
      }
      return Response.json({ ok: true, data: { job: gitJob, log: gitLog } });
    }
    if (path === "/addons/git/fragment") {
      const domain = url.searchParams.get("domain") ?? sites[0]!.domain;
      const site = gitPreviewSites(url).find((candidate) => candidate.domain === domain) ?? gitPreviewSites(url)[0]!;
      return Response.json(
        gitFragment(`Git — ${site.domain}`, gitSiteView(site, gitLog)),
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
    if (path === "/addons/login-theme/") return loginThemePage(req, "/", notice);
    if (path === "/addons/") {
      // ?enabled= picks which addons are on, so the Available section and the
      // enable/disable buttons can be reviewed without a CloudPanel install.
      const enabled = empty ? [] : (url.searchParams.get("enabled") ?? "cloudflare-ips,instatic,stager,maintenance,php-resources,git").split(",").filter(Boolean);
      const previewJob = state && ["running", "queued", "failed"].includes(state)
        ? {
            id: "20260910T093000Z-abc123", kind: "enable", addon: "stager", state,
            step: "enabling stager", error: state === "failed" ? "docker is not active; install and start it before enabling stager" : "",
            createdAt: "2026-09-10T09:30:00Z", startedAt: "2026-09-10T09:30:01Z", finishedAt: "",
          }
        : null;
      const page = indexPage(enabled, notice, {
        available: ["cloudflare-ips", "instatic", "stager", "maintenance", "php-resources", "git", "login-theme"].filter((name) => !enabled.includes(name)),
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
    } else if (path === "/addons/git/" || path === "/addons/git") {
      const gitSites = gitPreviewSites(url);
      const selected = url.searchParams.get("domain");
      const site = gitSites.find((candidate) => candidate.domain === selected);
      html = site
        ? gitLayout(`Git — ${site.domain}`, gitSiteView(site, gitLog), notice, {
            domain: site.domain,
            user: site.siteUser,
            type: site.siteType,
            varnishCache: siteVarnish[site.domain] === true,
            ...(url.searchParams.has("no-ip") ? {} : { publicIp: PREVIEW_PUBLIC_IP }),
          })
        : gitLayout("Git deploy", gitFleetView(empty ? [] : gitSites), notice);
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

// Local UI review with fictional data. Never starts the manager, reads panel
// state or invokes an action. Supported mutations change fictional data only.
import { indexPage, updatePage } from "../manager/views";
import { dashboardView as cloudflareDashboardView, layout as cloudflareLayout } from "../addons/cloudflare-ips/app/views";
import { dashboardView, layout as instaticLayout, newInstanceView, jobView as instaticJobView } from "../addons/instatic/app/views";
import { jobsView, jobView, layout as stagerLayout, fragment as stagerFragment, newCloneView, promoteView, siteStagingView } from "../addons/stager/app/views";
import { fleetView as gitFleetView, fragment as gitFragment, layout as gitLayout, siteView as gitSiteView } from "../addons/git/app/views";
import type { GitSiteStatus } from "../addons/git/app/service";
import { fleetView as maintenanceFleetView, fragment as maintenanceFragment, layout as maintenanceLayout, siteView as maintenanceSiteView } from "../addons/maintenance/app/views";
import type { MaintenanceFleet, MaintenanceSiteView } from "../addons/maintenance/app/service";
import { dashboardView as phpResourcesDashboardView, layout as phpResourcesLayout } from "../addons/php-resources/app/views";
import { dashboardView as smtpDashboardView, layout as smtpLayout } from "../addons/smtp/app/views";
import type { SmtpState } from "../addons/smtp/action";
import { dashboardView as dnsDashboardView, layout as dnsLayout } from "../addons/dns/app/views";
import type { DnsState, Review as DnsReview } from "../addons/dns/action";
import type { SitePlan as DnsSitePlan } from "../addons/dns/engine";
import { PRESETS as DNS_PRESETS, seededPolicy as dnsSeededPolicy } from "../addons/dns/presets";
import { tokenTemplate as dnsTokenTemplate } from "../addons/dns/token";
import { dashboardView as panelTweaksDashboardView, layout as panelTweaksLayout } from "../addons/panel-tweaks/app/views";
import { siteLayoutTarget } from "../lib/panel-nav";
import { sitesBlock } from "../addons/panel-tweaks/inject/targets";
import { previewPage as panelTweaksPreviewPage } from "../addons/panel-tweaks/app/preview";
import { STAGER_TARGETS } from "../addons/stager/inject/targets";
import { MENU_ONLY_CLASS } from "../lib/row-actions";

/** The `site.type` values Stager's own Twig condition offers a Clone for. */
const CLONABLE_TYPES = ["php", "static", "reverse-proxy"];
import { WP_TOOLS_TARGETS } from "../addons/wp-tools/inject/targets";
import { dashboardBody as wpToolsDashboardBody, dashboardView as wpToolsDashboardView, layout as wpToolsLayout } from "../addons/wp-tools/app/views";
import type { MainwpSiteView, MainwpView } from "../addons/wp-tools/mainwp";
import { WORDPRESS_APPLICATIONS, type WpJobView, type WpSiteView } from "../addons/wp-tools/action";
import { siteTabs, type SiteContext } from "../lib/site-context";
import { DEFAULT_MAINTENANCE_TEMPLATE } from "../addons/maintenance/action";
import { PRESET_CATEGORIES, STOCK_PROFILE, type PhpResourcesState, type PoolSiteState } from "../addons/php-resources/action";
import type { MeasureJobView, PanelTweaksState } from "../addons/panel-tweaks/action";
import type { PanelPhpStatus } from "../addons/system-tweaks/panel-php";
import ACE_MODE_HTML from "../addons/maintenance/app/ace-mode-html.js" with { type: "text" };
import type { InstanceView, InstaticJobView } from "../addons/instatic/app/service";
import type { JobView, SiteSummary } from "../addons/stager/app/service";
import type { AvailableTags } from "../addons/instatic/app/tags";
import { withCsrfCookie, SECURITY_HEADERS } from "../lib/app-http";
import { handle as terminalHandle } from "../addons/terminal/app/index";
import { dashboardView as terminalDashboardView, layout as terminalLayout } from "../addons/terminal/app/views";
import { TERMINAL_TARGETS } from "../addons/terminal/inject/targets";
import { dashboardView as securityKeysDashboardView, layout as securityKeysLayout } from "../addons/security-keys/app/views";
import { SECURITY_KEYS_TARGETS } from "../addons/security-keys/inject/targets";
import type { UserKeysView } from "../addons/security-keys/action";
import { dashboardView as systemTweaksDashboardView, layout as systemTweaksLayout } from "../addons/system-tweaks/app/views";
import type { SystemTweaksState } from "../addons/system-tweaks/action";

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

/** Two connections and a mixed fleet. ?setup shows a first visit with nothing connected, ?ask DNS before Automatic. */
function dnsPreviewState(url: URL): DnsState {
  const setup = url.searchParams.has("setup");
  const automatic = !setup && !url.searchParams.has("ask");
  const mode = automatic ? "enforce" as const : "report" as const;
  const seeded = dnsSeededPolicy().profiles;
  const web = seeded[0]!;
  const mailcow = { ...seeded[1]!, zone: { ...seeded[1]!.zone, skipFirewallIps: ["203.0.113.7"] } };
  const zone = (name: string, status = "active") => ({
    id: "0".repeat(32), name, status, nameServers: ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"],
    account: "Example Agency", connection: "Agency",
  });
  const plan = (domain: string, extra: Partial<DnsSitePlan>): DnsSitePlan => ({
    domain, profileId: "web", mode, zone: zone("example.com"), changes: [], problems: [], zoneChoices: [],
    certificateNames: [domain], ...extra,
  });
  const sites = setup ? [
    { domain: "example.com", type: "wordpress", profileId: null, plan: null, ssl: null },
    { domain: "shop.example.com", type: "php", profileId: null, plan: null, ssl: null },
  ] : [
    { domain: "example.com", type: "wordpress", profileId: "web", plan: plan("example.com", { certificateNames: ["example.com", "www.example.com"] }), ssl: null },
    { domain: "shop.example.com", type: "php", profileId: "web", plan: plan("shop.example.com", { changes: [
      { action: "update", subject: "A shop.example.com", detail: "203.0.113.10 · proxied", before: "198.51.100.4 · DNS only" },
      { action: "create", subject: "AAAA shop.example.com", detail: "2001:db8::10 · proxied" },
      { action: "delete", subject: "CNAME shop.example.com", detail: "shops.myshopify.com · DNS only" },
    ] }), ssl: null },
    { domain: "new-client.example.org", type: "wordpress", profileId: "web", plan: plan("new-client.example.org", { zone: zone("example.org", "pending") }),
      ssl: "Waiting for DNS: Zone example.org is pending; set its nameservers at the registrar" },
    { domain: "a-rather-long-customer-hostname.staging.example.net", type: "nodejs", profileId: "web-mailcow", plan: plan("a-rather-long-customer-hostname.staging.example.net", {
      profileId: "web-mailcow", zone: null,
      problems: ["example.net is reachable through more than one connection; choose which one manages it"],
      zoneChoices: [
        { zone: "example.net", connectionId: "cf-1", zoneId: "1".repeat(32), label: "Agency · Example Agency (active)" },
        { zone: "example.net", connectionId: "cf-2", zoneId: "1".repeat(32), label: "Church · Church account (active)" },
      ] }), ssl: null },
    { domain: "mail.example.org", type: "php", profileId: "web-mailcow", plan: plan("mail.example.org", {
      profileId: "web-mailcow", zone: zone("example.org"),
      changes: [
        { action: "create", subject: "Mailcow domain", detail: "mail.example.org" },
        { action: "create", subject: "MX mail.example.org", detail: "mail.example.net · priority 10" },
        { action: "update", subject: "TXT mail.example.org", detail: "v=spf1 include:_spf.mlsend.com mx ~all", before: "v=spf1 include:_spf.mlsend.com ~all" },
      ] }), ssl: null },
    { domain: "brand-new.example.co.uk", type: "wordpress", profileId: "web", plan: plan("brand-new.example.co.uk", { zone: null, changes: [
      { action: "create", subject: "Cloudflare zone", detail: "example.co.uk in Example Agency; then set its nameservers at the registrar" },
      { action: "create", subject: "A brand-new.example.co.uk", detail: "203.0.113.10 · proxied" },
    ] }), ssl: null },
    { domain: "docs.example.com", type: "static", profileId: null, plan: null, ssl: null },
  ];
  const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const log: DnsState["log"] = setup ? [] : [
    { at: at(3), cause: "New site", sites: ["new-client.example.org"], zone: "example.org", action: "create", subject: "Cloudflare zone",
      detail: "In Example Agency; nameservers ada.ns.cloudflare.com, bob.ns.cloudflare.com" },
    { at: at(3), cause: "New site", sites: ["new-client.example.org"], zone: "example.org", action: "create", subject: "A new-client.example.org", detail: "203.0.113.10 · proxied" },
    { at: at(64), cause: "Scheduled check", sites: ["example.com"], zone: "example.com", action: "update", subject: "A www.example.com",
      detail: "203.0.113.10 · proxied", before: "198.51.100.4 · DNS only" },
    { at: at(64), cause: "Scheduled check", sites: [], zone: "example.com", action: "update", subject: "Zone setting, whole zone", detail: "SSL/TLS Full (strict)", before: "Flexible" },
    ...Array.from({ length: 12 }, (_, n) => ({ at: at(1440 + n), cause: "Confirmed review", sites: [`site-${n}.example.com`], zone: "example.com",
      action: "create" as const, subject: `A site-${n}.example.com`, detail: "203.0.113.10 · proxied" })),
  ];
  const profiles = [web, mailcow].map((profile) => ({ ...profile, sites: sites.filter((site) => site.profileId === profile.id).length }));
  return {
    automatic,
    createIn: null,
    profiles,
    defaultProfileId: setup ? null : "web",
    sites,
    connections: setup ? [] : [
      { id: "cf-1", label: "Agency", active: true, status: "active", accounts: [{ id: "a".repeat(32), name: "Example Agency" }, { id: "b".repeat(32), name: "Clients" }], zones: 42, error: null, hasToken: true },
      { id: "cf-2", label: "Church", active: true, status: "active", accounts: [{ id: "c".repeat(32), name: "Church account" }], zones: 7, error: null, hasToken: true },
    ],
    accounts: setup ? [] : [
      { connectionId: "cf-1", accountId: "a".repeat(32), label: "Example Agency (Agency)" },
      { connectionId: "cf-1", accountId: "b".repeat(32), label: "Clients (Agency)" },
      { connectionId: "cf-2", accountId: "c".repeat(32), label: "Church account (Church)" },
    ],
    mailcow: setup
      ? { url: "", host: "", dkimSource: "", dkimSelector: "dkim", dkimBits: 2048, sharedMailbox: "", hasKey: false }
      : { url: "https://mail.example.net", host: "mail.example.net", dkimSource: "example.net", dkimSelector: "dkim", dkimBits: 2048, sharedMailbox: "relay@example.net", hasKey: true },
    smtpRelays: [{ profile: "Mailcow", host: "mail.example.net", username: "relay@example.net" }],
    server: { ipv4: "", ipv6: "", detected: { ipv4: "203.0.113.10", ipv6: "2001:db8::10" } },
    orphans: setup ? [] : [{ domain: "retired.example.com", zone: "example.com", records: 4 }],
    checkedAt: setup ? null : new Date(Date.now() - 4 * 60_000).toISOString(),
    waitUntil: 0,
    token: dnsTokenTemplate([web, mailcow]),
    presets: DNS_PRESETS,
    log,
  };
}

function dnsPreviewReview(state: DnsState): DnsReview {
  const sites = state.sites.filter((site) => site.plan).map((site) => ({ ...site.plan!, problems: [], zoneChoices: [] }));
  return {
    token: "preview", title: "Turn on Automatic",
    text: "8 changes will be made now. From then on DNS keeps every site's records to its profile, and creates a missing zone, on its own. Records at names a profile does not write are left alone.",
    sites, blocked: false, confirmLabel: "Apply and turn on Automatic", danger: true,
  };
}

/** Profiles and a mixed fleet. ?setup shows a first visit, ?empty a box with no sites. */
/** ?setup shows a fresh box, ?discard-default a Don't send default, ?many enough sites for search and filter. */
function smtpPreviewState(url: URL): SmtpState {
  const setup = url.searchParams.has("setup");
  const dontSend = { id: "dont-send", name: "Don't send", relay: null, sender: "noreply@{site}", sites: setup ? 0 : 1 };
  const profiles = setup ? [dontSend] : [
    { id: "postmark", name: "Postmark", relay: { host: "smtp.postmarkapp.com", port: 587, username: "server-token" }, sender: "{from.local}@{site}", sites: 2 },
    { id: "agency-gmail", name: "Agency Gmail", relay: { host: "smtp.gmail.com", port: 587, username: "alerts@agency.example" }, sender: "alerts@agency.example", sites: 1 },
    dontSend,
  ];
  const site = (domain: string, user: string, type: string, phpVersion: string | null, profileId: string | null, sender: string | null,
    grants: string[] = [], blocked: string | null = null, bypass = false) =>
    ({ domain, user, type, phpVersion, profileId: setup ? null : profileId, sender: setup ? null : sender, grants: setup ? [] : grants,
      blocked: setup ? null : blocked, bypass: setup ? false : bypass });
  const more = url.searchParams.has("many") ? [
    site("events.example.com", "events", "php", "8.3", "postmark", "{from.local}@events.example.com", [], null, true),
    site("api.example.com", "api", "python", null, "agency-gmail", "alerts@agency.example"),
  ] : [];
  return {
    profiles,
    defaultProfileId: setup ? null : url.searchParams.has("discard-default") ? "dont-send" : "postmark",
    sites: url.searchParams.has("empty") ? [] : [
      site("www.example.com", "example", "php", "8.3", "postmark", "{from.local}@example.com"),
      site("shop.example.com", "shop", "php", "8.3", "postmark", "{from.local}@shop.example.com", ["news.shop.example.com"]),
      site("blog.client.org", "blog", "php", "8.2", "agency-gmail", "alerts@agency.example"),
      site("staging.example.com", "staging", "php", "8.3", "dont-send", "noreply@staging.example.com"),
      site("news.shop.example.com", "news", "php", "8.3", null, null, [],
        "shop.example.com sends as news.shop.example.com through Postmark"),
      site("app.example.com", "app", "nodejs", null, null, null),
      site("docs.example.com", "docs", "static", null, null, null),
      ...more,
    ],
    skipped: setup || url.searchParams.has("empty") ? [] : [{ domain: "old.example.com", reason: "it has no Unix account" }],
  };
}

function gitPreviewLog(site: GitSiteStatus): string {
  if (!site.lastJob || !site.config || site.lastJob.state === "queued") return "";
  return [
    `[git] deploying ${site.config.remote} (${site.config.branch}) into ${site.path} as ${site.siteUser}`,
    `[git] fetching ${site.config.branch}`,
    "[git] updating the working tree",
    `HEAD is now at ${site.commit?.shortHash ?? "9f2c1ab"} ${site.commit?.subject ?? "Add the checkout summary"}`,
    ...(site.config.postDeploy ? [`[git] $ ${site.config.postDeploy}`] : []),
    ...(site.lastJob.state === "done" ? ["[git] deployment finished"]
      : site.lastJob.state === "failed" ? [`[git] ${site.lastJob.error}`] : []),
  ].join("\n");
}

/**
 * Connected sites and first-time setup. ?first-deploy, ?no-delivery,
 * ?other-provider, ?unavailable, ?no-key, ?no-hook and ?state= cover the
 * expandable controls, and ?many adds sites until the fleet search shows.
 */
const gitChanges = new Map<string, GitSiteStatus>();

function gitPreviewSites(url: URL): GitSiteStatus[] {
  const delivered = new Date(Date.now() - 4 * 60_000).toISOString().replace(/\.\d+Z$/, "Z");
  const firstDeploy = url.searchParams.has("first-deploy");
  const commit = {
    hash: "9f2c1ab7c0f0ad0e0f6d2f1b2a3c4d5e6f708192", shortHash: "9f2c1ab",
    author: "Ada Lovelace", committedAt: "2026-09-17T11:04:00Z", subject: "Add the checkout summary",
  };
  const job = {
    id: "20260917T110500Z-ab12cd", kind: "deploy", domain: "www.example.com", startedBy: "push",
    state: url.searchParams.get("state") ?? "done", step: "running the post-deploy command", error: "",
    createdAt: delivered, startedAt: delivered,
    finishedAt: ["queued", "running"].includes(url.searchParams.get("state") ?? "") ? "" : new Date(Date.parse(delivered) + 41_000).toISOString(),
    result: { branch: "main", directory: "", commit, postDeploy: "composer install --no-dev", postDeployRan: true },
  };
  if (job.state === "failed") job.error = "the post-deploy command failed; the files are deployed and the command did not finish";
  const result: GitSiteStatus[] = [
    {
      domain: "www.example.com", siteUser: "example", siteType: "php",
      path: "/home/example/htdocs/www.example.com", configured: true,
      config: {
        domain: "www.example.com", remote: url.searchParams.has("other-provider") ? "git@gitlab.com:example/shop.git" : "git@github.com:example/shop.git", branch: "main",
        directory: "", postDeploy: "composer install --no-dev", updatedAt: "2026-09-15T08:00:00Z",
        webhook: url.searchParams.has("no-hook") ? null : {
          token: "PreviewWebhookTokenForTheUiOnlyNotARealOne",
          lastDeliveryAt: url.searchParams.has("no-delivery") || firstDeploy ? "" : delivered, lastDelivery: "started a deployment",
          lastDeliveryJob: "20260917T110500Z-ab12cd",
        },
      },
      publicKey: url.searchParams.has("no-key") ? "" :
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPreviewKeyForTheUiOnlyNotARealKey00 clp-addons deploy key for www.example.com",
      commit: firstDeploy ? null : commit, lastJob: firstDeploy ? null : job,
    },
    {
      // A site the Git tab has never been used on: what an operator meets first.
      domain: "fresh.example.com", siteUser: "fresh", siteType: "php",
      path: "/home/fresh/htdocs/fresh.example.com", configured: false,
      config: null, publicKey: "", commit: null, lastJob: null,
    },
    {
      domain: "static.example.com", siteUser: "static", siteType: "static",
      path: "/home/static/htdocs/static.example.com/public", configured: true,
      config: {
        domain: "static.example.com", remote: "https://github.com/example/docs.git", branch: "release/2.1",
        directory: "public", postDeploy: "", updatedAt: "2026-09-16T09:10:00Z", webhook: null,
      },
      publicKey: "", commit: null, lastJob: null,
    },
    {
      domain: "app.example.com", siteUser: "app", siteType: url.searchParams.has("unavailable") ? "" : "nodejs",
      path: "/home/app/htdocs/app.example.com", configured: true,
      config: {
        domain: "app.example.com", remote: "git@gitlab.com:example/app.git", branch: "production",
        directory: "", postDeploy: "npm run build", updatedAt: "2026-09-16T09:10:00Z", webhook: null,
      },
      publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPreviewKeyForTheUiOnlyNotARealKey00", commit,
      lastJob: { ...job, id: "20260917T100500Z-ab12cd", domain: "app.example.com", state: "failed", startedBy: "operator", result: null,
        error: "The build command failed. Check the deployment output before trying again." },
    },
  ];
  if (url.searchParams.has("many")) {
    const base = result[2]!;
    for (const name of ["blog", "docs", "shop", "api"]) {
      result.push({ ...base, domain: `${name}.example.com`, config: { ...base.config!, domain: `${name}.example.com`, remote: `https://github.com/example/${name}.git`, directory: "" } });
    }
  }
  return result.map((site) => gitChanges.get(site.domain) ?? site);
}

/**
 * Maintenance across the fleet. ?global turns the override on, ?many adds sites
 * until the search shows, and ?uncovered leaves www without the Nginx check.
 * Switches made on the page are kept until the preview restarts.
 */
const maintenanceChanges = { enabled: new Map<string, boolean>(), global: null as boolean | null };

function maintenancePreviewFleet(url: URL): MaintenanceFleet {
  const extra = url.searchParams.has("many") ? [
    { domain: "shop.example.com", siteType: "php", siteUser: "shop" },
    { domain: "blog.example.com", siteType: "php", siteUser: "blog" },
    { domain: "new.example.com", siteType: "php", siteUser: "new" },
    { domain: "a-rather-long-customer-hostname.staging.example.com", siteType: "nodejs", siteUser: "long" },
  ] : [];
  const fleetSites = [...sites, ...extra].map((site, index): MaintenanceSiteView => ({
    domain: site.domain, type: site.siteType, user: site.siteUser,
    enabled: maintenanceChanges.enabled.get(site.domain) ?? (index === 0 || site.domain === "new.example.com"),
    customTemplate: index === 1, bypasses: index === 0 ? ["203.0.113.8"] : index === 3 ? ["198.51.100.4", "198.51.100.5"] : [],
    uncovered: site.domain === "new.example.com" || (index === 0 && url.searchParams.has("uncovered")) ? "Nginx has no vhost for it yet" : null,
    ...(index === 2 ? { error: "status unavailable" } : {}),
  }));
  return {
    global: { global: maintenanceChanges.global ?? url.searchParams.has("global"), bypasses: url.searchParams.has("empty") ? [] : ["203.0.113.8"] },
    sites: url.searchParams.has("empty") ? [] : fleetSites,
  };
}

function maintenancePreviewMutation(path: string, source: URL, body: Record<string, any>): Response | null {
  const toggle = path.match(/^\/addons\/maintenance\/api\/sites\/([^/]+)\/toggle$/);
  if (toggle) maintenanceChanges.enabled.set(decodeURIComponent(toggle[1]!), body.enabled === true);
  else if (path === "/addons/maintenance/api/bulk-toggle") {
    for (const domain of body.domains ?? []) maintenanceChanges.enabled.set(domain, body.enabled === true);
  } else if (path === "/addons/maintenance/api/global-toggle") maintenanceChanges.global = body.enabled === true;
  else return null;
  const domain = toggle ? decodeURIComponent(toggle[1]!) : "";
  return Response.json({
    ok: true,
    data: toggle ? { domain, enabled: body.enabled === true } : { enabled: body.enabled, updated: body.domains ?? [], failed: [], global: body.enabled },
    html: maintenanceFleetView(maintenancePreviewFleet(source), "203.0.113.8"),
  });
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
    step: "", error: "", panelSite: true, sourcePanelSite: true, createdAt: "2026-09-10T09:30:00Z",
    startedAt: "2026-09-10T09:30:02Z", finishedAt: "2026-09-10T09:32:10Z", result: null,
  };
  if (url.searchParams.has("empty") && !url.searchParams.has("staged-from")) {
    return siteStagingView(domain, [], siteType !== "nodejs" && siteType !== "python");
  }
  const jobs: JobView[] = [
    { ...base, id: "preview-clone-1", source: domain, target: `stg.${domain}` },
    { ...base, id: "preview-clone-2", source: domain, target: `qa.${domain}`, state: "running", step: "copying files" },
  ];
  // ?staged-from draws the site as a staging copy of live.example.com, promoted once.
  if (url.searchParams.has("staged-from")) {
    jobs.push({ ...base, id: "preview-clone-3", source: "live.example.com", target: domain, result: job.result });
    jobs.push({ ...base, id: "preview-promote-1", kind: "promote", source: domain, target: "live.example.com", createdAt: "2026-09-12T14:05:00Z" });
    if (url.searchParams.has("empty")) jobs.splice(0, 2);
  }
  return siteStagingView(domain, jobs, siteType !== "nodejs" && siteType !== "python");
}
const job: JobView = {
  id: "preview-job", kind: "clone", source: "www.example.com", target: "stg.example.com", port: 0,
  state: "done", step: "", error: "", panelSite: true, sourcePanelSite: true,
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
  { domain: "www.example.com", enabled: true },
  { domain: "static.example.com", enabled: false },
  { domain: "pages.example.com", enabled: true },
  { domain: "a-rather-long-customer-hostname.staging.example.com", enabled: false },
];
const cloudflareMoreSites = ["shop.example.net", "docs.example.org", "status.example.io", "api.example.dev"]
  .map((domain, index) => ({ domain, enabled: index % 2 === 0 }));

/** ?sites=all|none|mixed, ?auto=off and ?many (search and filter) cover the states the controls describe. */
function cloudflarePreviewState(url: URL) {
  const all = url.searchParams.get("sites");
  const sites = [...cloudflareSites, ...(url.searchParams.has("many") ? cloudflareMoreSites : [])].map((site) => all === "all"
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
    categoryId: "standard", categoryName: "Standard",
    drifted: false,
  },
  {
    domain: "shop.example.com", siteUser: "shop", phpVersion: "8.2",
    poolFile: "/etc/php/8.2/fpm/pool.d/shop.example.com.conf",
    current: { ...PRESET_CATEGORIES[2]!.profile },
    categoryId: "pro", categoryName: "Pro",
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
    categoryId: "lite", categoryName: "Lite",
    drifted: true,
  },
];

const phpMorePoolSites: PoolSiteState[] = ["news", "docs", "store", "events"].map((name, index) => ({
  domain: `${name}.example.org`, siteUser: name, phpVersion: index % 2 ? "8.2" : "8.3",
  poolFile: `/etc/php/8.3/fpm/pool.d/${name}.example.org.conf`,
  current: { ...PRESET_CATEGORIES[index % 2]!.profile },
  categoryId: PRESET_CATEGORIES[index % 2]!.id, categoryName: PRESET_CATEGORIES[index % 2]!.name,
  drifted: false,
}));

/** ?default=off leaves new sites uncategorised; ?empty= drops the fleet; ?many shows search and filter. */
function phpResourcesPreviewState(url: URL): PhpResourcesState {
  return {
    categories: url.searchParams.has("no-categories") ? [] : PRESET_CATEGORIES,
    defaultCategoryId: url.searchParams.get("default") === "off" ? null : "standard",
    sites: url.searchParams.has("empty") ? [] : url.searchParams.has("many") ? [...phpPoolSites, ...phpMorePoolSites] : phpPoolSites,
  };
}

/** The panel moved to 8.4 with an update waiting; `?off` is CloudPanel's own 8.1. */
let panelPhpChoice: string | null = null;

let systemTweaksPreview: SystemTweaksState | null = null;

/** ?dark draws a page in the panel's dark theme, from the cookie the panel's own switch sets. */
function previewTheme(html: string, url: URL): string {
  // ?open=id,id opens those disclosures, so a section that starts closed can be reviewed.
  const open = url.searchParams.get("open");
  if (open) {
    html = html.replace("</body>", () => `<script>addEventListener("DOMContentLoaded",function(){${JSON.stringify(open.split(",")).replaceAll("<", "\\u003c")}.forEach(function(id){const d=document.getElementById(id);if(d)d.open=true})})</script></body>`);
  }
  if (!url.searchParams.has("dark")) return html;
  return html.replace("<head>", "<head><script>document.cookie='theme=dark; Path=/'</script>");
}

/**
 * ?updates=missing|outside|off|on picks how unattended-upgrades stands, and
 * ?guard=off shows the upload-progress mitigation opted out, and ?realip=off
 * leaves X-Real-IP trusted from any address. ?reboot switches automatic reboot
 * on, ?at=03:30 sets its time, and ?overdue dates the required reboot weeks back.
 */
function systemTweaksPreviewState(url: URL): SystemTweaksState {
  if (systemTweaksPreview) return systemTweaksPreview;
  const mode = url.searchParams.get("updates") ?? "outside";
  const guard = url.searchParams.get("guard") !== "off";
  const managed = mode === "on";
  const enabled = mode === "on" || mode === "outside";
  const php = ["7.4", "8.1", "8.2", "8.3", "8.4"];
  return {
    settings: { enabled: managed, nginx: true, database: false, panel: false, reboot: url.searchParams.has("reboot"), rebootTime: url.searchParams.get("at") ?? "now" },
    updates: {
      installed: mode !== "missing",
      version: mode === "missing" ? "" : "2.9.1+nmu3",
      distro: { id: "Debian", codename: "bookworm" },
      managed,
      enabled,
      outsideSource: mode === "outside" ? "20auto-upgrades" : "",
      overriddenBy: "",
      listsUpdated: enabled,
      reboot: url.searchParams.has("reboot"),
      rebootTime: url.searchParams.get("at") ?? "",
      rebootWithUsers: true,
      timezone: "Europe/Berlin",
      timer: { state: "enabled", next: "Sat 2026-10-24 06:32:16 UTC" },
      coverage: [
        { name: "CloudPanel PHP", detail: php.join(", "), covered: managed ? "all" : "none" },
        { name: "Nginx", detail: "nginx", covered: managed ? "all" : "none" },
        { name: "CloudPanel", detail: "main", covered: "none" },
        { name: "MySQL", detail: "percona-server-server-8.0", covered: "none" },
        { name: "Varnish", detail: "varnish-7", covered: "none" },
        { name: "ProFTPD", detail: "proftpd", covered: "none" },
        { name: "Debian bookworm-security", detail: "main, contrib, non-free", covered: "all" },
        { name: "Debian bookworm", detail: "main, contrib, non-free, non-free-firmware", covered: "all" },
        { name: "Debian bookworm-updates", detail: "main", covered: "none" },
      ],
      lastRun: url.searchParams.has("failed") ? { at: "2026-10-23 16:11:29", outcome: "failed", packages: [], message: "An error occurred: 404 Not Found [IP: 2001:db8::1 443]\nThe URI https://packages.example.test/php8.2-bcmath.deb failed to download, aborting" } : enabled ? { at: "2026-10-23 06:41:09", outcome: "upgraded", packages: ["php8.3-fpm", "php8.3-cli"], message: "" } : null,
      rebootRequired: { since: url.searchParams.has("overdue") ? "2026-10-02T06:41:09Z" : "2026-10-20T06:41:09Z", packages: ["linux-image-6.1.0-53-amd64"] },
    },
    panelPhp: panelPhpPreviewStatus(url),
    realIp: { blockForged: url.searchParams.get("realip") !== "off", trustsAnyAddress: url.searchParams.get("realip") === "off", problem: "" },
    uploadProgress: {
      guard,
      fpms: [...php.map((version) => ({
        label: `PHP ${version}`, version, enabled: !guard && version !== "7.4",
        setBy: (guard ? "clp-addons" : version === "7.4" ? "config" : "default") as "clp-addons" | "config" | "default",
        source: guard ? `/etc/php/${version}/fpm/conf.d/99-clp-addons-upload-progress.ini` : version === "7.4" ? "/etc/php/7.4/fpm/php.ini" : "",
        offWithoutGuard: version === "7.4", poolsOn: version === "8.2" ? ["legacy.example.com"] : [],
      })), {
        label: "CloudPanel (PHP 8.4)", version: "8.4", enabled: !guard, setBy: guard ? "clp-addons" : "default",
        source: guard ? "/etc/php/8.4/fpm/conf.d/99-clp-addons-upload-progress.ini" : "", offWithoutGuard: false, poolsOn: [],
      }],
    },
  };
}

function systemTweaksPreviewMutation(path: string, source: URL, body: Record<string, any>): Response | null {
  if (!path.startsWith("/addons/system-tweaks/api/")) return null;
  const state = structuredClone(systemTweaksPreviewState(source));
  if (path.endsWith("/install-updates")) {
    state.updates.installed = true;
    state.updates.version = "2.9.1+nmu3";
  } else if (path.endsWith("/real-ip")) {
    state.realIp = { blockForged: body.enabled === true, trustsAnyAddress: body.enabled !== true, problem: "" };
  } else if (path.endsWith("/upload-guard")) {
    state.uploadProgress.guard = body.enabled === true;
    for (const row of state.uploadProgress.fpms) {
      row.enabled = !state.uploadProgress.guard && !row.offWithoutGuard;
      row.setBy = state.uploadProgress.guard ? "clp-addons" : row.offWithoutGuard ? "config" : "default";
    }
  } else {
    Object.assign(state.settings, body);
    state.updates.reboot = state.settings.reboot;
    state.updates.rebootTime = state.settings.rebootTime;
    state.updates.managed = state.settings.enabled;
    state.updates.enabled = state.settings.enabled || state.updates.outsideSource !== "";
    for (const row of state.updates.coverage) {
      const wanted = row.name === "CloudPanel PHP" ? state.settings.enabled
        : row.name === "Nginx" ? state.settings.enabled && state.settings.nginx
        : row.name === "MySQL" ? state.settings.enabled && state.settings.database
        : row.name === "CloudPanel" ? state.settings.enabled && state.settings.panel
        : row.covered !== "none";
      row.covered = wanted ? "all" : "none";
    }
  }
  systemTweaksPreview = state;
  return Response.json({ ok: true, html: systemTweaksDashboardView(state) });
}

function panelPhpPreviewStatus(url: URL): PanelPhpStatus {
  const wanted = panelPhpChoice ?? (url.searchParams.has("off") ? "" : "8.4");
  return {
    wanted,
    stock: "8.1",
    running: wanted || "8.1",
    choices: [
      { version: "8.1", installed: "8.1.34-1" },
      { version: "8.2", installed: "8.2.35-1" },
      { version: "8.3", installed: "8.3.36-1" },
      { version: "8.4", installed: "8.4.25-1", available: "8.4.27-1" },
      { version: "8.5", installed: "8.5.12-1" },
    ],
  };
}

/**
 * Panel Tweaks with every switch on and most sites measured, because that is
 * the widest the page gets: `?off` is the state an operator lands on after
 * enabling the addon, `?unmeasured` is the gap before the first sweep,
 * `?measuring` draws a measurement part-way through, and `?nocards` keeps the
 * table on a narrow screen.
 */
function panelTweaksPreviewState(url: URL): PanelTweaksState {
  const on = !url.searchParams.has("off");
  const measured = on && !url.searchParams.has("unmeasured");
  const at = "2026-09-17T08:45:00Z";
  if (url.searchParams.has("measuring") && !panelTweaksMeasurement) panelTweaksPreviewMeasure(Date.now() - 12_000);
  return {
    measuring: panelTweaksMeasurement ? panelTweaksPreviewTick(panelTweaksMeasurement) : null,
    tweaks: {
      deviceTheme: on,
      sitesTable: on,
      sitesMobile: on && !url.searchParams.has("nocards"),
      actionMenu: on,
      panelMobile: on,
      diskUsage: on,
      autoSsl: on,
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
      // One hostname competes with its type for a phone line, and another is
      // wider than a phone. The type must use a detail heading without moving
      // either detail column when it cannot use the hostname row.
      {
        domain: "portal.staging.example-group.com", user: "portal", type: "reverse-proxy",
        application: "ReverseProxy", runtime: "", createdAt: "2026-04-17 09:10:00",
        cloudflareOnly: true, varnish: false,
        certificate: { type: "2", expiresAt: "2026-11-05 10:00:00" },
        disk: measured ? { bytes: 2_097_152, databaseBytes: 0, measuredAt: at } : null,
      },
      {
        domain: "staging.newsletter.example-church-of-the-hills.com", user: "news", type: "php",
        application: "WordPress", runtime: "PHP 8.2", createdAt: "2026-08-03 12:00:00",
        cloudflareOnly: false, varnish: false,
        certificate: { type: "2", expiresAt: "2026-10-30 10:00:00" },
        disk: measured ? { bytes: 41_943_040, databaseBytes: 8_388_608, measuredAt: at } : null,
      },
      // An imported certificate is named by whoever issued it: Cloudflare's
      // origin CA on one, a public authority on the other.
      {
        domain: "edge.example.com", user: "edge", type: "reverse-proxy", application: "ReverseProxy",
        runtime: "", createdAt: "2026-02-11 10:20:00", cloudflareOnly: true, varnish: false,
        certificate: { type: "3", expiresAt: "2041-02-07 10:00:00", issuer: "CF Origin" },
        disk: measured ? { bytes: 8_388_608, databaseBytes: 0, measuredAt: at } : null,
      },
      {
        domain: "mail.example.com", user: "mail", type: "php", application: "WordPress",
        runtime: "PHP 8.3", createdAt: "2026-05-05 16:45:00", cloudflareOnly: false, varnish: false,
        certificate: { type: "3", expiresAt: "2027-04-30 10:00:00", issuer: "ZeroSSL" },
        disk: measured ? { bytes: 268_435_456, databaseBytes: 33_554_432, measuredAt: at } : null,
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
/* The panel's dark theme carries this; without it every hostname in the stub is
   near-black on a near-black table. */
html.dark a { color: #fff; }
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
    </ul>${twigForSite(TERMINAL_SITE_BUTTON.snippet("/addons/terminal"), site.domain)}
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
 * Security Keys' fictional keys, and stand-ins for the two CloudPanel pages it
 * adds to. The stand-ins load the panel's real stylesheets, which this preview
 * borrows from the public demo, so the injected blocks sit among the panel's
 * own rules. Open them on http://localhost:4100 rather than 127.0.0.1: browsers
 * refuse WebAuthn on an IP address, and the blocks say so.
 */
function securityKeysPreviewUsers(url: URL): UserKeysView[] {
  if (url.searchParams.has("empty")) return [];
  const origin = "https://panel.example.com:8443";
  return [
    { user: "admin", active: true, role: "ROLE_ADMIN", keys: [
      { id: "a1", name: "YubiKey 5C", origin, synced: false, createdAt: "2026-09-02T08:14:00.000Z", lastUsedAt: "2026-10-22T07:51:00.000Z" },
      { id: "a2", name: "Bitwarden", origin, synced: true, createdAt: "2026-09-10T16:40:00.000Z", lastUsedAt: null },
      { id: "a3", name: "The thing is, kids will never know how notorious this man was. H", origin, synced: false, createdAt: "2026-10-24T09:00:00.000Z", lastUsedAt: "2026-10-24T10:00:00.000Z" },
    ] },
    { user: "jane", active: true, role: "ROLE_SITE_MANAGER", keys: [
      { id: "j1", name: "MacBook Touch ID", origin, synced: true, createdAt: "2026-10-01T11:02:00.000Z", lastUsedAt: "2026-10-21T18:30:00.000Z" },
    ] },
    { user: "former-contractor", active: false, role: null, keys: [
      { id: "f1", name: "Security key", origin, synced: false, createdAt: "2026-06-12T09:00:00.000Z", lastUsedAt: "2026-07-01T10:12:00.000Z" },
    ] },
  ];
}

function panelPageStub(title: string, bodyClass: string, stylesheets: string[], body: string, dark: boolean): string {
  return `<!doctype html>
<html lang="en"${dark ? ' class="dark"' : ""}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no">
<title>${title}</title>
${["bootstrap.min.css", "style.css", "style-dark.css", ...stylesheets].map((sheet) => `<link href="/assets/css/${sheet}" rel="stylesheet">`).join("\n")}
</head>
<body class="${bodyClass}">
${body}
</body>
</html>`;
}

function panelLoginStub(dark: boolean): string {
  const block = SECURITY_KEYS_TARGETS.find((target) => target.slug === "login-button")!.snippet("/addons/security-keys");
  return panelPageStub("Log In", "", ["frontend/login.css"], `<div class="login-container">
  <div class="logo"><a title="CloudPanel" href="/login"><img alt="CloudPanel" src="/assets/images/logo.svg" height="75"></a></div>
  <div class="login-form-container">
    <div class="form-container">
      <form action="/login" method="post">
        <div class="row"><div class="col"><input type="text" name="userName" required="required" autocomplete="username" class="form-control form-control-lg" placeholder="User Name"></div></div>
        <div class="row"><div class="col"><input type="password" name="password" required="required" autocomplete="current-password" class="form-control form-control-lg" placeholder="Password"></div></div>
        <div class="row"><div class="col"><button type="submit" name="submit" class="btn btn-blue btn-login">Log In</button></div></div>
      </form>${block.replace("{% verbatim %}", "").replace("{% endverbatim %}", "")}
    </div>
  </div>
</div>`, dark);
}

function panelSecurityStub(dark: boolean): string {
  const block = SECURITY_KEYS_TARGETS.find((target) => target.slug === "account-card")!.snippet("/addons/security-keys");
  return panelPageStub("Two-Factor Authentication", "", ["frontend/account.css"], `<main class="main-container"><div class="container-fluid container-limited-width">
<div class="account-container">
  <div class="page-header"><div class="page-title"><h1>Account</h1></div></div>
  <div class="page-content">
    <div class="account-content-container">
      <div class="tab-container"><ul><li><a href="#">Settings</a></li><li class="active"><a href="/security">Security</a></li></ul></div>
      <div class="card">
        <div class="card-header">Two-Factor Authentication</div>
        <div class="card-body">
          <p>Two-Factor authentication adds an extra layer of security to your account. Whenever you sign in, you’ll need to enter both your password and also a security code.</p>
          <a href="#" class="btn btn-blue btn-lg">Enable Two-Factor Authentication</a>
        </div>
       </div>${block.replace("{% verbatim %}", "").replace("{% endverbatim %}", "")}
    </div>
  </div>
</div></div></main>`, dark);
}

/**
 * A stand-in for CloudPanel's own Sites page, so the block Panel Tweaks injects
 * there can be reviewed without a panel. The markup is
 * Frontend/Site/index.html.twig with its Twig evaluated, and the rules are the
 * panel's own from assets/css/style.css and assets/css/frontend/sites.css.
 */
const WP_TOOLS_SITES_SCRIPT = WP_TOOLS_TARGETS.find((target) => target.slug === "sites-script")!;
const TERMINAL_SITES_SCRIPT = TERMINAL_TARGETS.find((target) => target.slug === "sites-script")!;
const TERMINAL_SITES_ACTION = TERMINAL_TARGETS.find((target) => target.slug === "sites-action")!;
const TERMINAL_SITE_BUTTON = TERMINAL_TARGETS.find((target) => target.slug === "site-button")!;

/** An injected block as the panel would render it for one site and an administrator. */
function twigForSite(block: string, domain: string): string {
  return unwrapTwig(block)
    .split("{{ site.domainName|url_encode }}").join(encodeURIComponent(domain))
    .split("{{ site.domainName }}").join(domain);
}
const STAGER_SITES_STYLE = STAGER_TARGETS.find((target) => target.slug === "site-list-style")!;

function unwrapTwig(block: string): string {
  return block.replace("{% if is_granted('ROLE_ADMIN') %}", "").replace("{% endif %}", "");
}

/**
 * Three addons put a block above CloudPanel's sites table; the stub shows all.
 * Panel Tweaks is handed the previewed switches rather than reading the ones
 * stored on a server, so `?off` changes the injected markup here the
 * way a reconciliation would change it on a box.
 */
function injectedSitesBlocks(state: PanelTweaksState): string {
  return [
    sitesBlock("/addons/panel-tweaks", state.tweaks),
    unwrapTwig(WP_TOOLS_SITES_SCRIPT.snippet("/addons/wp-tools")),
    unwrapTwig(TERMINAL_SITES_SCRIPT.snippet("/addons/terminal")),
    unwrapTwig(STAGER_SITES_STYLE.snippet("/addons/stager")),
  ].join("\n");
}

/** WordPress everywhere but the static and reverse-proxy sites. */
function wpToolsPreviewSites(url: URL): WpSiteView[] {
  if (url.searchParams.has("empty")) return [];
  const status = url.searchParams.get("varnish");
  // ?varnish=network shows a network-activated multisite.
  const plugin = status && ["inactive", "missing", "network", "error"].includes(status)
    ? {
      status: (status === "network" ? "active" : status) as "inactive" | "missing" | "active" | "error",
      seen: true, checkedAt: "2026-10-09T08:45:00Z", ...(status === "network" ? { network: true } : {}),
      error: status === "error" ? "WP-CLI timed out while checking the site. Retry to check again." : "",
    }
    : null;
  return [
    { domain: "www.example.com", user: "example", helper: true, varnishCache: false, varnishPlugin: null },
    { domain: "shop.example.com", user: "shop", helper: true, varnishCache: true, varnishPlugin: { status: "active", seen: true, error: "", checkedAt: "2026-10-09T08:45:00Z" } },
    { domain: "blog.example.com", user: "blog", helper: false, varnishCache: true, varnishPlugin: plugin },
    { domain: "staging.newsletter.example-church-of-the-hills.com", user: "news", helper: false, varnishCache: true, varnishPlugin: { status: "inactive", seen: true, error: "", checkedAt: "2026-10-09T08:45:00Z" } },
  ];
}

function panelSitesStub(state: PanelTweaksState, dark: boolean): string {
  const rows = state.sites.map((site) => `                  <tr>
                    <td><a href="/site/${site.domain}/settings">${site.domain}</a></td>
                    <td>${site.user}</td>
                    <td>${site.type.toUpperCase()}</td>
                    <td class="text-end">${twigForSite(TERMINAL_SITES_ACTION.snippet("/addons/terminal"), site.domain)}<a href="/site/${site.domain}/settings">Manage</a>${WORDPRESS_APPLICATIONS.includes(site.application)
                      ? `<a href="#" class="clp-wp-tools" data-clp-domain="${site.domain}">WP Login</a>`
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
.table tbody td > a:hover { color: #0078d4; text-decoration: underline; }
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

const terminalPreviewSites = [
  { domain: "www.example.com", user: "example", type: "php" },
  { domain: "shop.example.com", user: "shop", type: "php" },
  { domain: "static.example.com", user: "static", type: "static" },
  { domain: "pages.example.com", user: "pages", type: "reverse-proxy" },
  { domain: "staging.newsletter.example-church-of-the-hills.com", user: "news", type: "php" },
  { domain: "blog.example.org", user: "blog", type: "php" },
];

const ESC = "\x1b";
const PROMPT = `${ESC}[1;32mexample@box${ESC}[0m:${ESC}[1;34m~/htdocs/www.example.com${ESC}[0m$ `;
const TERMINAL_TRANSCRIPT = [
  `${PROMPT}wp plugin list --status=active`,
  "+--------------------+--------+-----------+---------+",
  "| name               | status | update    | version |",
  "+--------------------+--------+-----------+---------+",
  `| akismet            | active | ${ESC}[33mavailable${ESC}[0m | 5.3.1   |`,
  "| redis-cache        | active | none      | 2.5.4   |",
  "| woocommerce        | active | none      | 9.3.3   |",
  "+--------------------+--------+-----------+---------+",
  `${PROMPT}git status --short`,
  ` ${ESC}[31mM${ESC}[0m wp-content/themes/example/style.css`,
  `${ESC}[31m??${ESC}[0m wp-content/uploads/2026/10/`,
  `${PROMPT}ls`,
  `index.php  license.txt  ${ESC}[1;34mwp-admin${ESC}[0m  wp-config.php  ${ESC}[1;34mwp-content${ESC}[0m  ${ESC}[1;34mwp-includes${ESC}[0m`,
  PROMPT,
].join("\r\n");

/** What the next popup shows: `?state=ended|moved|reconnecting|refused` on the popup page sets it. */
let terminalPreviewState = "";

/**
 * The terminal popup's API, answered with a canned transcript. The popup page
 * itself is the real handler's, so this is the only part that is made up.
 */
function terminalPreview(req: Request, url: URL): Response | null {
  const path = url.pathname;
  if (!path.startsWith("/addons/terminal/")) return null;
  const popup = /^\/addons\/terminal\/sites\/[^/]+$/.test(path);
  if (popup && req.method === "GET") {
    terminalPreviewState = url.searchParams.get("state") ?? "";
    return null;
  }
  if (path.startsWith("/addons/terminal/assets/")) return null;
  if (path === "/addons/terminal/api/sessions" && req.method === "POST") {
    if (terminalPreviewState === "refused") {
      return Response.json({ ok: false, error: "www.example.com cannot be opened: its Unix user has no login shell" }, { status: 400 });
    }
    return Response.json({ ok: true, data: { id: "preview-session-0000000", user: "example" } });
  }
  if (/\/api\/sessions\/[^/]+\/events$/.test(path)) {
    const encoder = new TextEncoder();
    const state = terminalPreviewState;
    const body = new ReadableStream({
      start(controller) {
        const send = (chunk: string) => controller.enqueue(encoder.encode(chunk));
        // A long retry keeps a dropped stream in its reconnecting state.
        send("retry: 600000\n\n");
        send(`event: session\ndata: ${JSON.stringify({ domain: "www.example.com", user: "example" })}\n\n`);
        send(`event: reset\nid: 1\ndata: ${Buffer.from(TERMINAL_TRANSCRIPT).toString("base64")}\n\n`);
        if (state === "ended") send(`event: ended\ndata: ${JSON.stringify({ reason: "exit", code: 0 })}\n\n`);
        if (state === "moved") send("event: moved\ndata: {}\n\n");
        if (state === "ended" || state === "moved" || state === "reconnecting") controller.close();
      },
    });
    return new Response(body, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
  }
  if (path.startsWith("/addons/terminal/api/sessions/")) return new Response(null, { status: 204 });
  return null;
}

// The WordPress Tools API, acting on the sites the page was last drawn with.
// ?mainwp=states turns automation on, ?mainwp=cleanup shows a pending cleanup,
// ?mainwp=none has no Dashboard chosen yet, ?mainwp=remote a Dashboard on another server.
function mainwpPreview(url: URL): MainwpView {
  const checkedAt = "2026-10-16T09:00:00Z";
  const entry = (status: MainwpSiteView["status"], ownedConnection = false, seen = true): MainwpSiteView => ({
    status, seen, checkedAt, ownedConnection,
    error: status === "error" ? "the Dashboard could not connect; check the site's HTTPS, firewall and security plugins" : "",
  });
  if (url.searchParams.get("mainwp") === "none") {
    return { enabled: false, dashboard: "", remote: false, cleanup: false, owned: 0, connections: 0, sites: {} };
  }
  if (url.searchParams.get("mainwp") === "remote") {
    return {
      enabled: true, dashboard: "", remote: true, cleanup: false, owned: 3, connections: 0,
      sites: {
        "shop.example.com": entry("connected"),
        "www.example.com": entry("not-connected"),
        "blog.example.com": entry("inactive"),
        "staging.newsletter.example-church-of-the-hills.com": entry("inactive"),
        "mainwp.example.com": entry("connected"),
        "new.example.com": entry("missing", false, false),
        "removed.example.com": entry("missing"),
        "network.example.com": entry("unsupported"),
        "retry.example.com": { ...entry("error"), error: "MainWP Child could not be activated; check the site in WordPress" },
      },
    };
  }
  return {
    enabled: url.searchParams.get("mainwp") === "states",
    dashboard: "mainwp.example.com",
    remote: false,
    cleanup: url.searchParams.get("mainwp") === "cleanup",
    owned: 1, connections: 1,
    sites: {
      "shop.example.com": entry("connected", true),
      "www.example.com": entry("connected"),
      "blog.example.com": entry("not-connected"),
      "staging.newsletter.example-church-of-the-hills.com": entry("not-connected"),
      "new.example.com": entry("missing", false, false),
      "waiting.example.com": entry("waiting-https", false, false),
      "removed.example.com": entry("missing"),
      "network.example.com": entry("unsupported"),
      "retry.example.com": entry("error"),
    },
  };
}
let wpToolsPreview = { sites: [] as WpSiteView[], automatic: false, error: "", mainwp: mainwpPreview(new URL("http://localhost")), mainwpError: "" };
// A job advances one site a second from when it was started; ?wpjob=varnish or
// ?wpjob=mainwp draws the page with one part-way through.
type PreviewJob = WpJobView & { startedMs: number; finish: () => void };
let wpToolsJobs: Record<"varnish" | "mainwp", PreviewJob | null> = { varnish: null, mainwp: null };
function wpToolsPreviewJob(task: WpJobView["task"], domains: string[], finish: () => void, startedMs = Date.now()): PreviewJob {
  const id = `${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}Z-${Math.random().toString(16).slice(2, 8).padEnd(6, "0")}`;
  const job: PreviewJob = {
    id, task, policy: task.startsWith("varnish") ? "varnish" : "mainwp", domains, state: "running", step: "", error: "",
    createdAt: "", startedAt: "", finishedAt: "", completed: 0, total: domains.length, site: domains[0] ?? "", result: null,
    startedMs, finish,
  };
  wpToolsJobs[job.policy] = job;
  return wpToolsPreviewTick(job);
}
function wpToolsPreviewTick(job: PreviewJob): PreviewJob {
  if (job.state === "done") return job;
  job.completed = Math.min(job.total, Math.floor((Date.now() - job.startedMs) / 1000));
  job.site = job.domains[job.completed] ?? "";
  if (job.completed < job.total) return job;
  job.finish();
  job.state = "done";
  job.result = { checked: job.total, installed: 0, connected: job.task === "mainwp-connect" ? job.total : 0, removed: 0, pending: 0, failed: [] };
  finishedWpJobs.set(job.id, job);
  if (wpToolsJobs[job.policy] === job) wpToolsJobs[job.policy] = null;
  return job;
}
const wpToolsPreviewData = () => {
  for (const job of Object.values(wpToolsJobs)) if (job) wpToolsPreviewTick(job);
  return {
    sites: wpToolsPreview.sites,
    varnish: { enabled: wpToolsPreview.automatic, sites: {} },
    varnishError: wpToolsPreview.error,
    mainwp: wpToolsPreview.mainwp, mainwpError: wpToolsPreview.mainwpError,
    jobs: { varnish: wpToolsJobs.varnish, mainwp: wpToolsJobs.mainwp },
  };
};
async function wpToolsPreviewApi(req: Request, path: string): Promise<Response | null> {
  if (!path.startsWith("/addons/wp-tools/api/")) return null;
  const body = req.method === "POST" ? await req.json().catch(() => ({})) as Record<string, unknown> : {};
  const ok = (data: unknown) => Response.json({ ok: true, data });
  const active = () => ({ status: "active" as const, seen: true, checkedAt: new Date().toISOString(), error: "" });
  const site = wpToolsPreview.sites.find((entry) => entry.domain === body.domain);
  const jobPath = /^\/addons\/wp-tools\/api\/jobs\/([^/]+)$/.exec(path);
  if (jobPath) {
    const job = Object.values(wpToolsJobs).find((entry) => entry?.id === jobPath[1]) ?? finishedWpJobs.get(jobPath[1]!);
    if (!job) return Response.json({ ok: false, error: "job not found" }, { status: 404 });
    wpToolsPreviewTick(job);
    return ok({ job, log: "" });
  }
  const started = (job: PreviewJob) => ok({ job });
  const mainwpTargets = () => wpToolsPreview.sites.map((entry) => entry.domain).filter((domain) => domain !== wpToolsPreview.mainwp.dashboard);
  switch (path.slice("/addons/wp-tools/api/".length)) {
    case "dashboard":
      return ok({ html: wpToolsDashboardBody(wpToolsPreviewData()) });
    case "mainwp-settings":
      wpToolsPreview.mainwp.enabled = body.enabled === true;
      if (body.remote === true) Object.assign(wpToolsPreview.mainwp, { remote: true, dashboard: "" });
      if (typeof body.dashboard === "string") Object.assign(wpToolsPreview.mainwp, { remote: false, dashboard: body.dashboard });
      return ok({});
    case "mainwp-connect": {
      const remote = wpToolsPreview.mainwp.remote;
      const domains = Array.isArray(body.domains) ? body.domains as string[] : [];
      return started(wpToolsPreviewJob("mainwp-connect", domains, () => {
        for (const domain of domains) wpToolsPreview.mainwp.sites[domain] = { status: remote ? "not-connected" : "connected", seen: true, ownedConnection: !remote, checkedAt: new Date().toISOString(), error: "" };
      }));
    }
    case "mainwp-sync": return started(wpToolsPreviewJob("mainwp-check", mainwpTargets(), () => {}));
    case "mainwp-cleanup": return started(wpToolsPreviewJob("mainwp-cleanup", ["shop.example.com"], () => {
      wpToolsPreview.mainwp.enabled = false;
      wpToolsPreview.mainwp.cleanup = false;
      wpToolsPreview.mainwp.owned = 0;
      for (const record of Object.values(wpToolsPreview.mainwp.sites)) {
        if (!record.ownedConnection) continue;
        record.status = "missing";
        record.ownedConnection = false;
      }
    }));
    case "varnish-settings":
      wpToolsPreview.automatic = body.enabled === true;
      return ok({});
    case "varnish-install":
      return started(wpToolsPreviewJob("varnish-install", site ? [site.domain] : [], () => { if (site) site.varnishPlugin = active(); }));
    case "varnish-sync": {
      const eligible = wpToolsPreview.sites.filter((entry) => entry.varnishCache);
      return started(wpToolsPreviewJob("varnish-check", eligible.map((entry) => entry.domain), () => {
        for (const entry of eligible) {
          if (!entry.varnishPlugin) entry.varnishPlugin = { status: "missing", seen: false, checkedAt: new Date().toISOString(), error: "" };
          if (wpToolsPreview.automatic && entry.varnishPlugin.status === "missing" && !entry.varnishPlugin.seen) entry.varnishPlugin = active();
        }
      }));
    }
    case "remove": {
      const removed = wpToolsPreview.sites.filter((entry) => entry.helper);
      removed.forEach((entry) => { entry.helper = false; });
      return ok({ removed: removed.length, failed: [] });
    }
  }
  return Response.json({ ok: false, error: "the preview cannot sign in to WordPress" }, { status: 400 });
}

const finishedWpJobs = new Map<string, PreviewJob>();

let panelAce: string | null = null;
const panelCss: Record<string, string> = {};

const finishedPreviewJobs = new Set<string>();
let previewEnabled: string[] | null = null;
let phpChanges: PhpResourcesState | null = null;
const previewDeployments = new Map<string, GitSiteStatus>();
let previewManagerJob: import("../cli/manager-action").ManagerJobView | null = null;
let previewJobNumber = 0;

/**
 * ?offline is a box that cannot reach ghcr.io; the fleet shows a creation in
 * progress, a failed one, and an instance whose CloudPanel site was deleted.
 */
function instaticDashboard(url?: URL): string {
  const offline = url?.searchParams.has("offline");
  const available: AvailableTags = offline ? { tags: ["0.0.18"], latest: null, source: "fallback" } : versions;
  const jobs: InstaticJobView[] = [
    { ...instaticCreationJob, id: "preview-instatic-job", domain: "blog.example.com", state: "running", step: "pulling ghcr.io/corebunch/instatic:0.0.19" },
    { ...instaticCreationJob, id: "preview-instatic-failed", domain: "news.example.com", state: "failed", step: "", error: "health check failed for news.example.com" },
    // ?updates: one site updating now and one whose update was rolled back.
    ...url?.searchParams.has("updates") ? [
      { ...instaticCreationJob, kind: "update" as const, id: "preview-update-docs", domain: "docs.example.com", tag: "0.0.19", fromTag: "0.0.18", state: "running" as const, step: "waiting for health check" },
      { ...instaticCreationJob, kind: "update" as const, id: "preview-update-failed", domain: "preview.example.com", tag: "0.0.19", fromTag: "0.0.18", state: "failed" as const, step: "", error: "health check failed for preview.example.com at 0.0.19; previous instance preserved" },
    ] : [],
  ];
  return dashboardView([...instances, { ...instances[0]!, domain: "old.example.com", tag: "0.0.18", panelSite: false }], available, jobs);
}

async function repaintPreviewMutation(req: Request, url: URL): Promise<Response | null> {
  if (req.method === "GET") return null;
  const path = url.pathname;
  const source = new URL(req.headers.get("referer") || url);
  const body = await req.json().catch(() => ({})) as Record<string, any>;
  if (path === "/addons/system-tweaks/api/panel-php") {
    panelPhpChoice = String(body.php ?? "");
    const state = { ...systemTweaksPreviewState(source), panelPhp: panelPhpPreviewStatus(source) };
    systemTweaksPreview = state;
    return Response.json({ ok: true, html: systemTweaksDashboardView(state) });
  }
  if (path === "/addons/security-keys/api/settings") {
    const settings = { roles: Array.isArray(body.roles) ? body.roles : [], syncedPasskeys: body.syncedPasskeys === true };
    return Response.json({ ok: true, html: securityKeysDashboardView({ users: securityKeysPreviewUsers(source), settings }) });
  }
  return gitPreviewMutation(req, path, source, body)
    ?? maintenancePreviewMutation(path, source, body)
    ?? instaticPreviewMutation(path, body)
    ?? phpPreviewMutation(path, source, body)
    ?? systemTweaksPreviewMutation(path, source, body)
    ?? managerPreviewMutation(path, source);
}

function gitPreviewMutation(req: Request, path: string, source: URL, body: Record<string, any>): Response | null {
  const gitRoute = path.match(/^\/addons\/git\/api\/sites\/([^/]+)\/(config|key|webhook)$/);
  if (gitRoute) {
    const domain = decodeURIComponent(gitRoute[1]!);
    const site = structuredClone(gitPreviewSites(source).find((site) => site.domain === domain));
    if (!site) return Response.json({ ok: false, error: "No preview site" }, { status: 404 });
    const verb = gitRoute[2];
    if (verb === "config") {
      site.configured = req.method !== "DELETE";
      site.config = site.configured
        ? {
            domain, remote: body.remote, branch: body.branch, directory: body.directory || "",
            postDeploy: body.postDeploy || "", updatedAt: "", webhook: site.config?.webhook ?? null,
          }
        : null;
    } else if (verb === "key") {
      site.publicKey = "ssh-ed25519 PreviewReplacementKey" + (++previewJobNumber);
    } else if (site.config) {
      site.config.webhook = req.method === "DELETE" ? null
        : { token: "PreviewWebhook" + (++previewJobNumber), lastDeliveryAt: "", lastDelivery: "", lastDeliveryJob: "" };
    }
    gitChanges.set(domain, site);
    return Response.json({ ok: true, data: { site }, html: gitSiteView(site, gitPreviewLog(site)) });
  }
  if (path === "/addons/git/api/deployments") {
    const site = structuredClone(gitPreviewSites(source).find((site) => site.domain === body.domain));
    if (!site?.config) return Response.json({ ok: false, error: "No repository configured" }, { status: 400 });
    const id = "20261021T120000Z-" + (++previewJobNumber).toString(16).padStart(6, "0");
    site.lastJob = {
      id, domain: site.domain, kind: "deploy", state: "running", step: "Fetching repository", startedBy: "operator",
      createdAt: new Date().toISOString(), startedAt: "", finishedAt: "", error: "", result: null,
    };
    gitChanges.set(site.domain, site);
    previewDeployments.set(id, site);
    return Response.json({ ok: true, data: { job: id } });
  }
  return null;
}

function instaticPreviewMutation(path: string, body: Record<string, any>): Response | null {
  const instanceRoute = path.match(/^\/addons\/instatic\/api\/instances\/([^/]+)\/(start|stop|restart|recreate|update|delete)$/);
  if (instanceRoute) {
    const domain = decodeURIComponent(instanceRoute[1]!);
    const instance = instances.find((instance) => instance.domain === domain);
    if (!instance) return Response.json({ ok: false, error: "No preview instance" }, { status: 404 });
    const verb = instanceRoute[2];
    if (verb === "delete") instances.splice(instances.indexOf(instance), 1);
    else if (verb === "update") instance.tag = body.tag;
    else instance.state = verb === "stop" ? "exited" : "running";
    return Response.json({ ok: true, data: { domain }, html: instaticDashboard() });
  }
  return null;
}

function phpPreviewMutation(path: string, source: URL, body: Record<string, any>): Response | null {
  if (path.startsWith("/addons/php-resources/api/")) {
    const state = phpChanges ?? structuredClone(phpResourcesPreviewState(source));
    if (path.endsWith("/default")) state.defaultCategoryId = body.categoryId;
    else if (path.endsWith("/assign")) {
      const category = state.categories.find((category) => category.id === body.categoryId);
      state.sites.forEach((site) => {
        if (!body.domains.includes(site.domain)) return;
        site.categoryId = category?.id ?? null;
        site.categoryName = category?.name ?? null;
        site.current = category?.profile ?? STOCK_PROFILE;
        site.drifted = false;
      });
    } else if (path.endsWith("/categories/delete")) {
      state.categories = state.categories.filter((category) => category.id !== body.id);
    } else if (path.endsWith("/categories")) {
      const category = { id: body.id || "preview-category", name: body.name, description: body.description, profile: body.profile };
      state.categories = state.categories.filter((entry) => entry.id !== category.id).concat(category);
    } else return null;
    phpChanges = state;
    return Response.json({ ok: true, data: { ...state, failures: [] }, html: phpResourcesDashboardView(state) });
  }
  return null;
}

function managerPreviewMutation(path: string, source: URL): Response | null {
  if (path === "/addons/api/update") {
    previewManagerJob = {
      id: "20261021T120000Z-" + (++previewJobNumber).toString(16).padStart(6, "0"), addon: "",
      kind: "update", state: "running", step: "Downloading", error: "Preview download failed", createdAt: "", startedAt: "", finishedAt: "",
    };
    return Response.json({ ok: true, data: { jobId: previewManagerJob.id } });
  }
  const managerRoute = path.match(/^\/addons\/api\/addons\/([^/]+)\/(enable|disable)$/);
  if (managerRoute) {
    previewEnabled ??= (source.searchParams.get("enabled") ?? "cloudflare-ips,instatic,stager,maintenance,php-resources,git").split(",");
    previewManagerJob = {
      id: "20261021T120000Z-" + (++previewJobNumber).toString(16).padStart(6, "0"), addon: managerRoute[1]!,
      kind: managerRoute[2]!, state: "running", step: "Updating addon", error: "", createdAt: "", startedAt: "", finishedAt: "",
    };
    return Response.json({ ok: true, data: { jobId: previewManagerJob.id } });
  }
  return null;
}

function finishedPreviewStream(job: { state: string; id: string }, log: string, finish: () => void, state = "done"): Response {
  let timer: ReturnType<typeof setTimeout>;
  const stream = new ReadableStream({
    start(controller) {
      const send = () => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ job, log })}\n\n`));
      send();
      timer = setTimeout(() => {
        job.state = state;
        finish();
        send();
        controller.close();
      }, 500);
    },
    cancel() { clearTimeout(timer); },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
}

// A measurement advances one site a second from when it was started, through
// a box of forty sites.
type PreviewMeasurement = MeasureJobView & { startedMs: number };
let panelTweaksMeasurement: PreviewMeasurement | null = null;
const finishedMeasurements = new Map<string, PreviewMeasurement>();
function panelTweaksPreviewMeasure(startedMs = Date.now()): PreviewMeasurement {
  const id = `${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}Z-${Math.random().toString(16).slice(2, 8).padEnd(6, "0")}`;
  panelTweaksMeasurement = {
    id, state: "running", step: "", error: "", createdAt: "", startedAt: "", finishedAt: "",
    completed: 0, total: 40, site: "", result: null, startedMs,
  };
  return panelTweaksPreviewTick(panelTweaksMeasurement);
}
function panelTweaksPreviewTick(job: PreviewMeasurement): PreviewMeasurement {
  if (job.state === "done") return job;
  job.completed = Math.min(job.total, Math.floor((Date.now() - job.startedMs) / 1000));
  job.site = job.completed < job.total ? `site-${String(job.completed + 1).padStart(2, "0")}.example.com` : "";
  if (job.completed < job.total) return job;
  job.state = "done";
  job.result = { measured: job.total - 2, skipped: 2, measuredAt: new Date().toISOString() };
  finishedMeasurements.set(job.id, job);
  if (panelTweaksMeasurement === job) panelTweaksMeasurement = null;
  return job;
}
function panelTweaksPreviewApi(req: Request, path: string): Response | null {
  if (req.method === "POST" && path === "/addons/panel-tweaks/api/measure") {
    const attached = panelTweaksMeasurement !== null;
    return Response.json({ ok: true, data: { job: panelTweaksMeasurement ?? panelTweaksPreviewMeasure(), attached } });
  }
  const jobPath = /^\/addons\/panel-tweaks\/api\/jobs\/([^/]+)$/.exec(path);
  if (!jobPath) return null;
  const job = panelTweaksMeasurement?.id === jobPath[1] ? panelTweaksMeasurement : finishedMeasurements.get(jobPath[1]!);
  if (!job) return Response.json({ ok: false, error: "job not found" }, { status: 404 });
  return Response.json({ ok: true, data: { job: panelTweaksPreviewTick(job), log: "" } });
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT || 4100),
  async fetch(req, server) {
    const url = new URL(req.url);
    const path = url.pathname;
    const terminalReply = terminalPreview(req, url);
    if (terminalReply) return terminalReply;
    const wpToolsApi = await wpToolsPreviewApi(req, path);
    if (wpToolsApi) return wpToolsApi;
    const panelTweaksApi = panelTweaksPreviewApi(req, path);
    if (panelTweaksApi) return panelTweaksApi;
    const repaintReply = await repaintPreviewMutation(req, url);
    if (repaintReply) return repaintReply;
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
    // The stylesheets the addon's own preview frame loads from its CloudPanel
    // origin. Only this development preview borrows them from the public demo.
    if (path.startsWith("/assets/css/") && path.endsWith(".css")) {
      panelCss[path] ??= await (await fetch(`https://demo.cloudpanel.io${path}`)).text();
      return new Response(panelCss[path], {
        headers: { "Content-Type": "text/css", "Cache-Control": "public, max-age=3600" },
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
    // The popup page and its assets are the real handler's; only its API is canned.
    if (path.startsWith("/addons/terminal/sites/") || path.startsWith("/addons/terminal/assets/")) {
      return terminalHandle(req, path.slice("/addons/terminal".length));
    }
    // /sites stands in for the panel's own site list, with the addon's block in
    // place; /addons/panel-tweaks/api/panel is what that block then asks for.
    if (path === "/sites") {
      return new Response(panelSitesStub(panelTweaksPreviewState(url), url.searchParams.has("dark")), {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
    if (path === "/login" || path === "/security") {
      const dark = url.searchParams.has("dark");
      return new Response(path === "/login" ? panelLoginStub(dark) : panelSecurityStub(dark), {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
    if (path === "/addons/security-keys/api/keys") {
      const asked = req.headers.get("referer");
      const users = securityKeysPreviewUsers(asked ? new URL(asked) : url);
      // ?role-off draws the card for an account whose role has keys turned off.
      const off = asked ? new URL(asked).searchParams.has("role-off") : false;
      // ?hardware-only draws it on a panel that no longer accepts synced passkeys.
      const hardwareOnly = asked ? new URL(asked).searchParams.has("hardware-only") : false;
      return Response.json({ ok: true, data: { keys: users[0]?.keys ?? [], canAdd: !off, syncedPasskeys: !hardwareOnly } });
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
        enabled: site.domain === sites[0]!.domain, customTemplate: false, bypasses: ["203.0.113.8"], uncovered: null,
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
    if (path.startsWith("/addons/api/jobs/") && previewManagerJob) {
      const job = previewManagerJob;
      return finishedPreviewStream(job, "Addon updated", () => {
        if (job.kind === "update") return;
        previewEnabled = previewEnabled!.filter((addon) => addon !== job.addon);
        if (job.kind === "enable") previewEnabled.push(job.addon);
      }, job.kind === "update" ? "failed" : "done");
    }
    if (path === "/addons/git/api/view") {
      const selected = url.searchParams.get("domain");
      const all = gitPreviewSites(url);
      const site = all.find((site) => site.domain === selected);
      return Response.json({ ok: true, html: site ? gitSiteView(site, gitPreviewLog(site)) : gitFleetView(all.filter((site) => site.configured)) });
    }
    // The job the Git pages watch, so ?state=running can be reviewed as a live
    // view rather than as a stream that never answers.
    if (path.startsWith("/addons/git/api/jobs/")) {
      const deployment = Array.from(previewDeployments.entries()).find(([id]) => path.includes(id))?.[1];
      if (deployment?.lastJob) {
        return finishedPreviewStream(deployment.lastJob, gitPreviewLog(deployment), () => {
          deployment.lastJob!.finishedAt = new Date().toISOString();
        });
      }
      // The watcher URL has no query, so use the page that requested it to keep
      // a running preview running instead of reloading it in a loop as done.
      const source = req.headers.get("referer");
      const gitSite = gitPreviewSites(source ? new URL(source) : url).find((site) => site.lastJob && path.includes(site.lastJob.id));
      if (!gitSite?.lastJob) return Response.json({ ok: false, error: "No preview job" }, { status: 404 });
      const gitJob = gitSite.lastJob;
      const gitLog = gitPreviewLog(gitSite);
      if (path.endsWith("/events") || req.headers.get("accept")?.includes("text/event-stream")) {
        if (server && typeof server.timeout === "function") {
          try { server.timeout(req, 0); } catch {}
        }
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ job: gitJob, log: gitLog })}\n\n`));
            if (gitJob.state !== "running" && gitJob.state !== "queued") controller.close();
          },
        });
        return new Response(stream, {
          headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", ...SECURITY_HEADERS },
        });
      }
      return Response.json({ ok: true, data: { job: gitJob, log: gitLog } });
    }
    if (path === "/addons/git/fragment") {
      const domain = url.searchParams.get("domain") ?? sites[0]!.domain;
      const site = gitPreviewSites(url).find((candidate) => candidate.domain === domain) ?? gitPreviewSites(url)[0]!;
      return Response.json(
        gitFragment(`Git — ${site.domain}`, gitSiteView(site, gitPreviewLog(site))),
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
    const currentJob: JobView = !finishedPreviewJobs.has(job.id) && state && ["running", "failed", "queued"].includes(state)
      ? { ...job, state, result: null, finishedAt: "", step: "Copying files", error: state === "failed" ? "Could not copy the source files. The staging site was removed." : "" }
      : job;
    let html: string;
    if (path === "/addons/update") {
      const jobState = state && ["running", "queued", "failed"].includes(state) ? state : null;
      return updatePage(url.searchParams.has("offline") ? null : {
        current: "0.9.3", latest: url.searchParams.has("current") ? "0.9.3" : "0.9.4", hasUpdate: !url.searchParams.has("current"),
      }, "0.9.3", {
        csrf: "preview-csrf-token",
        job: previewManagerJob?.kind === "update" ? previewManagerJob : jobState ? {
          id: "20260910T093000Z-abc123", kind: "update", addon: "", state: jobState,
          step: "Downloading release", error: jobState === "failed" ? "Could not download the release. Try again later." : "",
          createdAt: "2026-09-10T09:30:00Z", startedAt: "2026-09-10T09:30:01Z", finishedAt: "",
        } : null,
      });
    }
    if (path === "/addons/") {
      // ?enabled= picks which addons are on, so the Available section and the
      // enable/disable buttons can be reviewed without a CloudPanel install.
      const enabled = previewEnabled ?? (empty ? [] : (url.searchParams.get("enabled") ?? "cloudflare-ips,instatic,stager,maintenance,php-resources,git").split(",").filter(Boolean));
      const previewJob = state && ["running", "queued", "failed"].includes(state)
        ? {
            id: "20260910T093000Z-abc123", kind: "enable", addon: "stager", state,
            step: "enabling stager", error: state === "failed" ? "docker is not active; install and start it before enabling stager" : "",
            createdAt: "2026-09-10T09:30:00Z", startedAt: "2026-09-10T09:30:01Z", finishedAt: "",
          }
        : null;
      const page = indexPage(enabled, notice, {
        available: ["cloudflare-ips", "dns", "instatic", "stager", "maintenance", "php-resources", "git", "panel-tweaks", "system-tweaks", "wp-tools", "smtp", "terminal", "security-keys"].filter((name) => !enabled.includes(name)),
        job: previewJob,
        csrf: "preview-csrf-token",
        version: "2.0.0",
      });
      // ?confirm=<addon> opens the disable dialog on load. A modal only exists
      // after a click, and the screenshot tool does not click; without this the
      // one dialog an operator sees before turning an addon off cannot be
      // reviewed the way every other view can.
      const openDialog = url.searchParams.get("confirm");
      const body = previewTheme(await page.text(), url);
      if (!openDialog) return new Response(body, { headers: page.headers });
      return new Response(
        body.replace("</body>", `<script>addEventListener('DOMContentLoaded',function(){disableAddon(${JSON.stringify(openDialog)}, ${JSON.stringify(openDialog === "instatic" ? "Instatic CMS" : openDialog)})})</script></body>`),
        { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
      );
    }
    if (path === "/addons/maintenance/" || path === "/addons/maintenance") {
      const fleet = maintenancePreviewFleet(url);
      const globalEnabled = fleet.global.global;
      const selected = url.searchParams.get("domain");
      const site = fleet.sites.find((candidate) => candidate.domain === selected);
      html = maintenanceLayout(
        site ? `Maintenance — ${site.domain}` : "Maintenance Mode",
        site
          ? maintenanceSiteView(site, { domain: site.domain, custom: site.customTemplate, html: DEFAULT_MAINTENANCE_TEMPLATE }, "203.0.113.8", globalEnabled)
          : maintenanceFleetView(fleet, "203.0.113.8"),
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
    } else if (path === "/addons/panel-tweaks/preview") {
      return new Response(panelTweaksPreviewPage(panelTweaksPreviewState(url)), {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      });
    } else if (path === "/addons/panel-tweaks/" || path === "/addons/panel-tweaks") {
      html = panelTweaksLayout("Panel Tweaks", panelTweaksDashboardView(panelTweaksPreviewState(url)), notice);
    } else if (path === "/addons/system-tweaks/" || path === "/addons/system-tweaks") {
      systemTweaksPreview = null;
      html = systemTweaksLayout("System Tweaks", systemTweaksDashboardView(systemTweaksPreviewState(url)), notice);
    } else if (path === "/addons/terminal/" || path === "/addons/terminal") {
      html = terminalLayout("Terminal", terminalDashboardView(empty ? [] : terminalPreviewSites), notice);
    } else if (path === "/addons/wp-tools/" || path === "/addons/wp-tools") {
      wpToolsPreview = {
        sites: wpToolsPreviewSites(url),
        mainwp: mainwpPreview(url), mainwpError: url.searchParams.get("mainwp") === "unreadable" ? "The MainWP settings cannot be read." : "",
        automatic: url.searchParams.has("automatic"),
        error: url.searchParams.get("varnish") === "unreadable"
          ? "/var/lib/clp-addons/wp-tools/varnish.json cannot be read: the WordPress Varnish settings are invalid" : "",
      };
      const mainwpOnly = ["mainwp.example.com", "new.example.com", "waiting.example.com", "removed.example.com", "network.example.com", "retry.example.com"];
      if (!empty) {
        for (const domain of mainwpOnly) wpToolsPreview.sites.push({
          domain, user: domain.split(".")[0]!, helper: false, varnishCache: false, varnishPlugin: null,
        });
      }
      wpToolsJobs = { varnish: null, mainwp: null };
      const job = url.searchParams.get("wpjob");
      // Started a few seconds ago, and about a minute from done.
      if (job === "varnish") wpToolsPreviewJob("varnish-check", Array.from({ length: 64 }, (_, i) => `site${i}.example.com`), () => {}, Date.now() - 17_400);
      if (job === "mainwp") wpToolsPreviewJob("mainwp-connect", ["blog.example.com", "new.example.com", "waiting.example.com", "retry.example.com", "staging.newsletter.example-church-of-the-hills.com"], () => {}, Date.now() - 2_400);
      html = wpToolsLayout("WordPress Tools", wpToolsDashboardView(wpToolsPreviewData()), notice);
    } else if (path === "/addons/php-resources/" || path === "/addons/php-resources") {
      // ?dialog=new|edit opens the category dialog on load (edit: the first category), ?more with More limits open.
      const dialog = url.searchParams.get("dialog");
      const opener = dialog === null ? "" : `openCategoryDialog(${dialog === "edit" ? "CLP_ROOT.querySelector('tr[data-category] button')" : "document.body"});`
        + (url.searchParams.has("more") ? "CLP_ROOT.getElementById('category-more').open=true;" : "");
      html = phpResourcesLayout("PHP Resources", phpResourcesDashboardView(phpChanges ?? phpResourcesPreviewState(url)), notice)
        .replace("</body>", () => opener ? `<script>addEventListener("DOMContentLoaded",function(){${opener}})</script></body>` : "</body>");
    } else if (path === "/addons/dns/" || path === "/addons/dns") {
      // ?dialog=profile|advanced|new|review|site|pending|choose|connection|mailcow|server opens that dialog on load; ?ask shows DNS
      // before Automatic is turned on;
      // ?at=<selector> hides the cards above that one, for a phone screenshot of something below the fold; ?dark
      // draws the dark theme.
      const state = dnsPreviewState(url);
      const dialog = url.searchParams.get("dialog");
      const at = url.searchParams.get("at");
      const openers: Record<string, string> = {
        profile: "dnsEditProfile('web-mailcow')",
        advanced: "dnsEditProfile('web-mailcow');document.getElementById('dns-advanced').click();document.getElementById('dns-zone-details').open=true",
        new: "dnsEditProfile('')",
        review: `dnsShowReview(${JSON.stringify(dnsPreviewReview(state))})`,
        site: "dnsShowSite('shop.example.com')",
        pending: "dnsShowSite('new-client.example.org')",
        choose: "dnsShowSite('a-rather-long-customer-hostname.staging.example.net')",
        connection: "dnsEditConnection('')",
        mailcow: "dnsEditMailcow()",
        server: "dnsEditServer()",
      };
      const opener = (dialog ? openers[dialog] ?? "" : at ? `const card=document.querySelector(${JSON.stringify(at)})?.closest("#dns-root > *");for(let el=document.getElementById("dns-root").firstElementChild;el&&el!==card;el=el.nextElementSibling)el.style.display="none"` : "");
      html = dnsLayout("DNS", dnsDashboardView(state), notice)
        .replace("</body>", () => opener ? `<script>addEventListener("DOMContentLoaded",function(){${opener.replaceAll("<", "\\u003c")}})</script></body>` : "</body>");
    } else if (path === "/addons/smtp/" || path === "/addons/smtp") {
      // ?profile=<id> (or ?profile= for a new one), ?domains=<site> and ?test=<site> open a dialog on load, like ?confirm= does.
      const arg = (name: string) => JSON.stringify(url.searchParams.get(name)).replaceAll("<", "\\u003c");
      const opener = url.searchParams.has("profile") ? `smtpEditProfile(${arg("profile")})`
        : url.searchParams.has("domains") ? `smtpEditGrants(${arg("domains")})`
        : url.searchParams.has("test") ? `smtpOpenTest(${arg("test")})` : "";
      html = smtpLayout("SMTP Relay", smtpDashboardView(smtpPreviewState(url)), notice)
        .replace("</body>", () => opener ? `<script>addEventListener("DOMContentLoaded",function(){${opener}})</script></body>` : "</body>");
    } else if (path === "/addons/security-keys/" || path === "/addons/security-keys") {
      // ?hardware-only turns synced passkeys off; ?admins-only leaves one role on and ?no-roles none.
      html = securityKeysLayout("Security Keys", securityKeysDashboardView({
        users: securityKeysPreviewUsers(url),
        settings: {
          roles: url.searchParams.has("no-roles") ? [] : url.searchParams.has("admins-only") ? ["ROLE_ADMIN"] : ["ROLE_ADMIN", "ROLE_SITE_MANAGER", "ROLE_USER"],
          syncedPasskeys: !url.searchParams.has("hardware-only"),
        },
      }), notice);
    } else if (path === "/addons/cloudflare-ips/" || path === "/addons/cloudflare-ips") {
      html = cloudflareLayout("Cloudflare IP Access", cloudflareDashboardView(cloudflarePreviewState(url)), notice);
    } else if (path === "/addons/instatic/") {
      html = instaticLayout("Instatic sites", empty ? dashboardView([], versions) : instaticDashboard(url), notice);
      // ?dialog=update|delete|stop opens that dialog once the page is up.
      const openers: Record<string, string> = {
        update: "askUpdate('docs.example.com','0.0.18')",
        delete: "askDelete('old.example.com')",
        stop: "askStop('pages.example.com')",
      };
      const opener = openers[url.searchParams.get("dialog") ?? ""];
      if (opener) html = html.replace("</body>", `<script>addEventListener("DOMContentLoaded",function(){${opener}})</script></body>`);
    } else if (path === "/addons/instatic/new") {
      html = instaticLayout("New Instatic site", newInstanceView(
        url.searchParams.has("offline") ? { tags: ["0.0.18"], latest: null, source: "fallback" } : versions,
        url.searchParams.get("from") === "new-site",
      ), notice);
    } else if (path === "/addons/instatic/jobs/preview-instatic-job") {
      // ?cert=failed shows a creation whose certificate request failed.
      const certificate = url.searchParams.get("cert") === "failed" ? "failed" as const : "issued" as const;
      html = instaticLayout("Creating blog.example.com", instaticJobView(url.searchParams.has("finish") && !finishedPreviewJobs.has(instaticCreationJob.id) ? { ...instaticCreationJob, state: "running" } : { ...instaticCreationJob, certificate }, instaticLogs), notice);
    } else if (path.startsWith("/addons/instatic/api/") && path.endsWith("/logs")) {
      return Response.json({ ok: true, data: { logs: "Instatic listening on 127.0.0.1:39000\nReady to accept requests" } });
    } else if (path === "/addons/instatic/api/jobs/preview-instatic-job/events" || (path === "/addons/instatic/api/jobs/preview-instatic-job" && req.headers.get("accept")?.includes("text/event-stream"))) {
      const source = req.headers.get("referer");
      if (source && new URL(source).searchParams.has("finish")) {
        return finishedPreviewStream({ ...instaticCreationJob, state: "running" }, instaticLogs, () => finishedPreviewJobs.add(instaticCreationJob.id));
      }
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
        ? gitLayout(`Git — ${site.domain}`, gitSiteView(site, gitPreviewLog(site)), notice, {
            domain: site.domain,
            user: site.siteUser,
            type: site.siteType,
            varnishCache: siteVarnish[site.domain] === true,
            ...(url.searchParams.has("no-ip") ? {} : { publicIp: PREVIEW_PUBLIC_IP }),
          })
        : gitLayout("Git Deploy", gitFleetView(empty ? [] : gitSites.filter((site) => site.configured)
          .map((site) => ({ ...site, publicKey: "", keyMissing: site.domain === "www.example.com" && url.searchParams.has("no-key") }))), notice);
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
        : stagerLayout("Staging sites", jobsView(empty ? [] : [
          currentJob,
          { ...job, id: "preview-job-2", source: "shop.example.com", target: "qa.shop.example.com", createdAt: "2026-09-08T11:00:00Z" },
          { ...job, id: "preview-job-3", source: "blog.example.com", target: "stg.blog.example.com", panelSite: false, createdAt: "2026-09-01T08:15:00Z" },
          { ...job, id: "preview-job-4", kind: "promote", source: "stg.example.com", target: "www.example.com", createdAt: "2026-09-11T16:40:00Z" },
        ], age), notice);
    } else if (path === "/addons/stager/new") {
      const source = sites.find((s) => s.domain === url.searchParams.get("source")) ?? null;
      // ?many lists enough sites for the picker's search to appear.
      const picker = url.searchParams.has("many")
        ? [...sites, ...["shop", "docs", "agency", "careers"].map((name): SiteSummary => ({
          domain: `${name}.example.org`, siteType: "php", siteUser: name, phpVersion: "8.3", application: "WordPress", databases: 1,
        }))]
        : sites;
      html = stagerLayout("New staging site", newCloneView(source, empty ? [] : picker), notice);
    } else if (path === "/addons/stager/promote") {
      // ?job= is what the list's Promote link carries; without it the route
      // sends the operator to the list, as the panel's does.
      if (!url.searchParams.has("job")) return Response.redirect(new URL("/addons/stager/", url).href, 302);
      html = stagerLayout("Promote to live", promoteView(currentJob), notice);
    } else if (path === "/addons/stager/jobs/preview-job") {
      html = stagerLayout("Staging site details", jobView(currentJob, logs), notice);
    } else if (path === "/addons/stager/api/jobs/preview-job/events" || (path === "/addons/stager/api/jobs/preview-job" && req.headers.get("accept")?.includes("text/event-stream"))) {
      const source = req.headers.get("referer");
      if (source && new URL(source).searchParams.has("finish")) {
        return finishedPreviewStream({ ...job, state: "running" }, logs, () => finishedPreviewJobs.add(job.id));
      }
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
    return new Response(previewTheme(html, url), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
  },
});
console.log(`UI preview (fictional data): ${server.url}addons/`);

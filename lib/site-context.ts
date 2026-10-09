// The one description of CloudPanel's site-scoped navigation.
//
// A site-scoped addon page is reached from the panel's own site tab strip, so
// leaving that strip behind reads as leaving the site. The addon manager is a
// separate process and cannot render the panel's Twig, so it reproduces the
// strip -- and a reproduction is only safe if it is derived, not guessed. Both
// consumers read this file: the shell that draws the strip, and the Twig
// snippet that adds an addon's own tab to the panel's copy of it.
//
// Mirrors Frontend/Site/Partial/tab-container.html.twig: same order, same
// conditions, same routes. When CloudPanel changes that partial, the anchor
// check in `clp-addons repair` stops rather than patching unknown markup; this
// list is what has to be brought back in step afterwards.

import { esc } from "./app-http";
import { mountPath } from "./mount";

export interface SiteContext {
  domain: string;
  user: string;
  /** CloudPanel's site type: php, static, nodejs, python, reverse-proxy. */
  type: string;
  /** Whether the panel has Varnish enabled for this site. */
  varnishCache?: boolean;
  /** The instance address the panel shows, omitted when the panel has none. */
  publicIp?: string;
  /**
   * The addon tabs to draw, when the caller reaches fewer than all of them.
   * Omitted means every one, which is what an administrator sees.
   */
  addonSlugs?: string[];
}

export interface SiteTab {
  slug: string;
  label: string;
  href: string;
  active: boolean;
}

interface TabSpec {
  slug: string;
  label: string;
  /** Path segment under /site/{domain}/, or an absolute addon URL. */
  path: string;
  applies?: (site: SiteContext) => boolean;
}

const NATIVE_TABS: TabSpec[] = [
  { slug: "settings", label: "Settings", path: "settings" },
  { slug: "vhost", label: "Vhost", path: "vhost" },
  { slug: "databases", label: "Databases", path: "databases", applies: (site) => site.type !== "static" },
  {
    slug: "varnish-cache",
    label: "Varnish Cache",
    path: "varnish-cache",
    applies: (site) => site.type === "php" && site.varnishCache === true,
  },
  { slug: "certificates", label: "SSL/TLS", path: "certificates" },
  { slug: "security", label: "Security", path: "security" },
  { slug: "users", label: "SSH/FTP", path: "users" },
  { slug: "file-manager", label: "File Manager", path: "file-manager" },
  { slug: "cron-jobs", label: "Cron Jobs", path: "cron-jobs" },
  { slug: "logs", label: "Logs", path: "logs" },
];

/**
 * Addon tabs injected into the panel's strip, in the order they are appended
 * after the native ones -- ascending addon name, which is the order the
 * injector settles on when several addons share one anchor. Keeping the label
 * here keeps the injected Twig and the reproduced strip from drifting apart.
 */
export const ADDON_SITE_TABS: { slug: string; label: string; url: string }[] = [
  { slug: "git", label: "Git", url: mountPath("git") },
  { slug: "maintenance", label: "Maintenance", url: mountPath("maintenance") },
  { slug: "stager", label: "Staging", url: mountPath("stager") },
];

/** How CloudPanel's stored site `type` reads to an operator. */
export function siteTypeLabel(type: string): string {
  if (type === "php") return "PHP";
  if (type === "static") return "Static";
  if (type === "reverse-proxy") return "Reverse proxy";
  if (type === "nodejs") return "Node.js";
  if (type === "python") return "Python";
  return type;
}

/**
 * The tab strip CloudPanel would draw for this site, with `activeSlug` marked.
 *
 * Which addon tabs belong in it is the caller's to say through `addonSlugs`:
 * the panel's own strip only draws the tabs whose Twig condition the session
 * passes, and a reproduction that drew more would offer a site manager links
 * to addons the manager's gate refuses.
 */
export function siteTabs(site: SiteContext, activeSlug = ""): SiteTab[] {
  const native = NATIVE_TABS.filter((tab) => !tab.applies || tab.applies(site)).map((tab) => ({
    slug: tab.slug,
    label: tab.label,
    href: `/site/${encodeURIComponent(site.domain)}/${tab.path}`,
    active: tab.slug === activeSlug,
  }));
  const addons = ADDON_SITE_TABS.filter(
    (tab) => site.addonSlugs === undefined || site.addonSlugs.includes(tab.slug),
  ).map((tab) => ({
    slug: tab.slug,
    label: tab.label,
    href: `${tab.url}?domain=${encodeURIComponent(site.domain)}`,
    active: tab.slug === activeSlug,
  }));
  return [...native, ...addons];
}

/**
 * CloudPanel's own site-information block, above the tab strip.
 *
 * The numbers are the panel's, from assets/css/frontend/site.css: a 200px
 * minimum column with a 60px gutter, so the second and third blocks line up
 * where the panel puts them, a 14px/500 label in #aaa and an 18px value. Only
 * the top margin differs -- the panel's own 30px, less the 25px `main` already
 * contributes above the first element on an addon page.
 */
import SITE_CONTEXT_STYLE from "./assets/site-context.css" with { type: "text" };
export { SITE_CONTEXT_STYLE };

const EXTERNAL_LINK_ICON =
  '<svg viewBox="0 0 512 512" aria-hidden="true" focusable="false"><path d="M440,256H424a8,8,0,0,0-8,8V464a16,16,0,0,1-16,16H48a16,16,0,0,1-16-16V112A16,16,0,0,1,48,96H248a8,8,0,0,0,8-8V72a8,8,0,0,0-8-8H48A48,48,0,0,0,0,112V464a48,48,0,0,0,48,48H400a48,48,0,0,0,48-48V264A8,8,0,0,0,440,256ZM500,0,364,.34a12,12,0,0,0-12,12v10a12,12,0,0,0,12,12L454,34l.7.71L131.51,357.86a12,12,0,0,0,0,17l5.66,5.66a12,12,0,0,0,17,0L477.29,57.34l.71.7-.34,90a12,12,0,0,0,12,12h10a12,12,0,0,0,12-12L512,12A12,12,0,0,0,500,0Z"/></svg>';

export function siteInfoHtml(site: SiteContext): string {
  const boxes = [
    `<div class="clp-addon-site-box"><h3>Domain</h3><div class="clp-addon-site-value">` +
      `<a href="https://${esc(site.domain)}" target="_blank" rel="noopener noreferrer">${esc(site.domain)} ${EXTERNAL_LINK_ICON}</a></div></div>`,
    `<div class="clp-addon-site-box"><h3>Site User</h3><div class="clp-addon-site-value">${esc(site.user)}</div></div>`,
  ];
  // Only when the panel itself has an address recorded; an empty box is
  // honest, an invented address is not.
  if (site.publicIp) {
    boxes.push(`<div class="clp-addon-site-box"><h3>IP Address</h3><div class="clp-addon-site-value">${esc(site.publicIp)}</div></div>`);
  }
  return `<div class="clp-addon-site-info">${boxes.join("")}</div>`;
}

// The HTML shell every addon's manager app renders into.
//
// Here rather than in an addon because it is chrome, not content: the palette,
// the table and badge classes, the card and dialog styling. The Instatic addon
// owned all of it while it was the only addon, which meant a second addon's
// choices were either "copy 60 lines of CSS" or "look like a different
// product". An addon supplies its brand, contextual nav, its own script and
// any extra rules; everything else is shared.

import { esc, escJs } from "./app-http";
import { shadowStyle, type EmbedFragment } from "./shadow-embed";
import { SITE_CONTEXT_STYLE, siteInfoHtml, siteTabs, type SiteContext } from "./site-context";
import { UPDATE_STYLE, updateNoticeHtml } from "./update-ui";

/**
 * The three of CloudPanel's own pages the shell's header links to.
 *
 * The header reproduces the panel's, so it carries the panel's controls: the
 * Admin Area, and an account menu of Account Settings, the theme and Log Out.
 * The account control is the panel's own person icon rather than the
 * operator's gravatar: the manager serves these pages behind the panel's
 * session without ever being told whose it is, so it has no address to ask
 * about, and asking would tell Gravatar which boxes an operator administers.
 */
const PANEL_ADMIN_URL = "/admin/users";
const PANEL_SETTINGS_URL = "/settings";
const PANEL_LOGOUT_URL = "/logout";

/** How long ago something happened, in the words a status line would use. */
export function sinceText(iso: string): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "never";
  const minutes = Math.round((Date.now() - at) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/** The badge class for a job's state. */
export function jobStateClass(state: string): string {
  return ["queued", "running", "done", "failed"].includes(state) ? `state-${state}` : "state-failed";
}

/** A job's state as a sentence would put it. */
export function jobStateLabel(state: string): string {
  return ({ queued: "Queued", running: "Running", done: "Done", failed: "Failed" } as Record<string, string>)[state] ?? state;
}

/** A recorded time as the job pages print it, `2026-09-10 09:30 UTC`. */
export function whenText(iso: string): string {
  const at = Date.parse(iso);
  return Number.isFinite(at) ? `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC` : "—";
}

/** Below this many sites the whole table fits on a screen, so it needs no search. */
export const FLEET_FILTER_MIN = 6;

/**
 * Search, and an optional filter, above a site table whose rows carry
 * `data-domain`, `data-find` and `data-show`; the client half is `filterFleet`.
 */
export function fleetFilterHtml(options: {
  count: number;
  placeholder?: string;
  filters?: { value: string; label: string }[];
  summary: string;
}): string {
  if (options.count < FLEET_FILTER_MIN) return "";
  const filters = options.filters?.length
    ? `<select id="fleet-show" data-keep aria-label="Show" onchange="filterFleet()"><option value="">All sites</option>${options.filters
      .map((filter) => `<option value="${esc(filter.value)}">${esc(filter.label)}</option>`).join("")}</select>`
    : "";
  const placeholder = options.placeholder ?? "Find a site";
  return `<div class="fleet-filter">
      <input type="search" id="fleet-find" data-keep placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)}" oninput="filterFleet()">
      ${filters}<span class="hint" id="fleet-summary" data-all="${esc(options.summary)}">${esc(options.summary)}</span>
    </div>`;
}

/**
 * Under the table: the line shown when search or filter leaves no row, and the
 * button that shows the rest of a long list on a phone.
 */
export const FLEET_FOOTER_HTML = `<div class="empty" id="fleet-none" hidden>No site matches.</div>
<div class="fleet-more" id="fleet-more" hidden><button class="btn" type="button" onclick="showAllSites()">Show all sites</button></div>`;

/** Shared interaction and focus treatment for selectable site-table rows. */
export function fleetRowSelectionStyle(tableClass: string): string {
  return `
.${tableClass} tbody tr { cursor: pointer; transition: background-color .15s, box-shadow .15s; }
.${tableClass} tbody tr:hover { background: rgb(38 125 221 / 6%); }
.${tableClass} tbody tr[aria-selected="true"] { background: rgb(38 125 221 / 12%); box-shadow: inset 4px 0 var(--primary); }
.${tableClass} tbody tr:focus-visible { outline: 2px solid var(--accent); outline-offset: -3px; }
`;
}

/**
 * Shared selection for the Cloudflare, PHP and SMTP site tables: which rows
 * there are, which are picked, and the mouse and keyboard ways to pick them.
 *
 * Each entry point takes the page's own repaint, because what a selection
 * changes on the page is the one thing the tables do not agree on.
 */
import FLEET_ROW_SELECTION_JS from "./assets/fleet-row-selection.client.js" with { type: "text" };
export { FLEET_ROW_SELECTION_JS };

// Measured against CloudPanel v3's preview at dummy.cloudpanel.io: dashboard,
// sites, a site's settings, the admin area and the account menu. Keep these
// rules independent of the panel's private templates and versioned CSS bundles.
import BASE_STYLE from "./assets/app-ui.css" with { type: "text" };
export { BASE_STYLE };

// CloudPanel v3 keeps the theme in a cookie named "theme": "light", "dark", or
// "auto" -- the default, and what anything else reads as -- for the device's
// own preference. Read it before CSS is painted, so moving between the panel
// and an addon never flashes the other theme.
import THEME_INIT_JS from "./assets/theme-init.client.js" with { type: "text" };
export { THEME_INIT_JS };

/**
 * The client-side helpers every addon page needs: read the CSRF cookie, echo it
 * back on a mutation, and disable the page while one is in flight.
 *
 * Concatenated into the addon's own script, so a syntax error here takes down
 * every button on the page; tests/test-app.test.ts parses the pair together.
 */
import BASE_CLIENT_JS from "./assets/app-ui.client.js" with { type: "text" };
export { BASE_CLIENT_JS };

/**
 * Styling for a job's progress page, used by every addon that runs work in the
 * background. Appended after BASE_STYLE by the addon that needs it, so the
 * state colours here override the container-state palette above only on the
 * pages that draw a job.
 */
import JOB_STYLE from "./assets/job.css" with { type: "text" };
export { JOB_STYLE };

/** A list of settings, one switch each; the client half opens a setting's wording on a phone. */
import TWEAK_ROW_STYLE from "./assets/tweak-rows.css" with { type: "text" };
import TWEAK_ROW_JS from "./assets/tweak-rows.client.js" with { type: "text" };
export { TWEAK_ROW_STYLE, TWEAK_ROW_JS };

/**
 * The client half of the job progress page: paint an update, and follow a job
 * until it reaches a state that will not change again.
 *
 * Appended to an addon's own script, which calls `watchJob(id)` once the page
 * announces a job to follow. A caller can pass a containing element as the
 * second argument when a page has more than one job surface; the manager uses
 * that to keep updates in the card whose action started the job. A third
 * argument overrides the finished job's repaint, for embedded Git views and
 * successful manager updates that replace this page's code. The markup
 * contract is four ids -- `job-state`, `job-step`, `job-log` and a hidden
 * `job-watch` carrying `data-job` -- and an addon that draws only some of them
 * still works: each element is optional.
 *
 * EventSource with a polling fallback rather than polling alone, because a log
 * that appears a second after the line was written reads as a live console,
 * and one that appears five seconds later reads as a hung page. The fallback
 * covers a proxy that will not stream and a browser without EventSource.
 */
import JOB_WATCH_JS from "./assets/job-watch.client.js" with { type: "text" };
export { JOB_WATCH_JS };

/**
 * A progress bar for a background job that works through sites, such as
 * WordPress Tools' checks and Panel Tweaks' size measurement. The page draws
 * it with `jobProgressHtml` and the client half follows every one it finds
 * with `followJobProgress(onFinished)`, so a reload picks the job up again.
 */
import JOB_PROGRESS_STYLE from "./assets/job-progress.css" with { type: "text" };
import JOB_PROGRESS_JS from "./assets/job-progress.client.js" with { type: "text" };
export { JOB_PROGRESS_STYLE, JOB_PROGRESS_JS };

/** What the bar needs of a job; both addons' job views carry it. */
export interface SiteJobProgress {
  id: string;
  state: string;
  step: string;
  completed: number;
  total: number;
  site: string;
}

/** "12 of 40: site" beside the title; the client half writes the same. */
export function jobProgressText(job: SiteJobProgress): string {
  const count = job.total ? `${Math.min(job.completed + 1, job.total)} of ${job.total}: ` : "";
  return job.state === "queued" ? "Waiting to start" : job.site ? `${count}${job.site}` : job.step;
}

/** `hidden` draws an empty bar the client fills in when it starts a job. */
export function jobProgressHtml(job: SiteJobProgress, title: string, hidden = false): string {
  return `<div class="job-progress" data-job="${esc(job.id)}" role="status"${hidden ? " hidden" : ""}>
        <div class="job-progress-head"><strong>${esc(title)}</strong><span class="job-progress-step hint">${esc(jobProgressText(job))}</span></div>
        <progress class="job-progress-bar" max="${Math.max(job.total, 1)}"${job.total ? ` value="${job.completed}"` : ""}></progress>
      </div>`;
}

export interface Chrome {
  /** Product name for the contextual navigation, e.g. "Instatic". */
  brand: string;
  /** Where this addon is mounted, e.g. "/addons/instatic". */
  base: string;
  /** Contextual tabs for this addon's manager, below the global shell nav. */
  nav: { href: string; label: string }[];
  /** Rules appended after BASE_STYLE, for anything only this addon draws. */
  css?: string;
  /** The addon's own script. BASE_CLIENT_JS is prepended. */
  script: string;
  /** Optional header controls if a newer clp-addons release is available. */
  updateNotice?: { current: string; latest: string } | null;
  /** Hide administrator navigation for pages reached by a site manager. */
  admin?: boolean;
  /**
   * Draw CloudPanel's site information and site tab strip instead of this
   * addon's own tabs, for a page reached from that strip. `activeSlug` is the
   * tab this page is; see lib/site-context for the list.
   */
  site?: SiteContext & { activeSlug: string };
}

// v3's own theme icons, so the control has one shape on the panel's pages and on these.
const AUTO_PATH = '<path fill-rule="evenodd" clip-rule="evenodd" d="M3 3.75C3 2.2835 4.2835 1 5.75 1H10.25C11.7165 1 13 2.2835 13 3.75V13.25V14H12.25H3.75H3V13.25V3.75ZM5.75 2.5C5.11193 2.5 4.5 3.11193 4.5 3.75V12.5H11.5V3.75C11.5 3.11193 10.8881 2.5 10.25 2.5H5.75ZM5.5 5C5.5 4.44772 5.94772 4 6.5 4H9.5C10.0523 4 10.5 4.44772 10.5 5V8.5H5.5V5ZM8 10.5H10.5V9H8V10.5Z"/>';
const SUN_PATH = '<path fill-rule="evenodd" clip-rule="evenodd" d="M8 1.25V0.25H7V1.25V1.5V2.25H8V1.5V1.25ZM7.25 9.75C8.4926 9.75 9.5 8.7426 9.5 7.5C9.5 6.2574 8.4926 5.25 7.25 5.25C6.0074 5.25 5 6.2574 5 7.5C5 8.7426 6.0074 9.75 7.25 9.75ZM7.25 11.25C9.32107 11.25 11 9.57107 11 7.5C11 5.42893 9.32107 3.75 7.25 3.75C5.17893 3.75 3.5 5.42893 3.5 7.5C3.5 9.57107 5.17893 11.25 7.25 11.25ZM8 12.5V13.25V13.5V14.25H7V13.5V13.25V12.5H8ZM12.5 6.5H13.25H13.5H14.25V7.5H13.5H13.25H12.5V6.5ZM1.5 6.5H0.75V7.5H1.5H1.75H2.5V6.5H1.75H1.5ZM10.9697 3.28033L11.5 2.75L11.6768 2.57322L12.2071 2.04289L13.2678 3.10355L12.7374 3.63388L12.5607 3.81066L12.0303 4.34099L10.9697 3.28033ZM2.57322 11.6768L2.04289 12.2071L3.10355 13.2678L3.63388 12.7374L3.81066 12.5607L4.34099 12.0303L3.28033 10.9697L2.75 11.5L2.57322 11.6768ZM3.28033 4.34099L2.75 3.81066L2.57322 3.63388L2.04289 3.10355L3.10355 2.04289L3.63388 2.57322L3.81066 2.75L4.34099 3.28033L3.28033 4.34099ZM11.6768 12.7374L12.2071 13.2678L13.2678 12.2071L12.7374 11.6768L12.5607 11.5L12.0303 10.9697L10.9697 12.0303L11.5 12.5607L11.6768 12.7374Z"/>';
const MOON_PATH = '<path fill-rule="evenodd" clip-rule="evenodd" d="M11 0.5V1.25V1.75H11.5L12.25 1.75V3.25H11.5H11V3.75V4.5H9.5V3.75V3.25H9H8.25V1.75H9H9.5V1.25V0.5H11ZM5.50514 3.00496C4.58413 3.78491 4 4.94972 4 6.25C4 8.59721 5.90279 10.5 8.25 10.5C9.55029 10.5 10.7151 9.91587 11.4951 8.99485C11.4138 8.99827 11.3321 9 11.25 9C8.07436 9 5.5 6.42563 5.5 3.25C5.5 3.16792 5.50172 3.08623 5.50514 3.00496ZM2.5 6.25C2.5 3.76072 4.08142 1.64271 6.292 0.842193L7.25256 1.80275C7.08933 2.25347 7 2.74047 7 3.25C7 5.5972 8.90279 7.5 11.25 7.5C11.7595 7.5 12.2465 7.41065 12.6973 7.24743L13.6578 8.20798C12.8573 10.4186 10.7393 12 8.25 12C5.07436 12 2.5 9.42564 2.5 6.25Z"/>';

/** The panel's own moon and sun, for a `#theme-switch` button in a window with no account menu. */
export const THEME_SWITCH_ICONS = `<svg class="moon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">${MOON_PATH}</svg>
<svg class="sun" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">${SUN_PATH}</svg>`;

/** The theme row of v3's account menu: follow the device, light, or dark. */
const THEME_CHOOSER_HTML = `<div class="clp-addon-theme-row">
            <span>Theme</span>
            <fieldset class="clp-addon-theme-options">
              <legend class="sr-only">Theme</legend>
              ${[["auto", "Auto", AUTO_PATH], ["light", "Light", SUN_PATH], ["dark", "Dark", MOON_PATH]]
  .map(([value, label, path]) => `<span><input type="radio" name="clp-theme" value="${value}" id="clp-theme-${value}" onchange="chooseTheme(this.value)"><label for="clp-theme-${value}" title="${label}"><span class="sr-only">${label}</span><svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">${path}</svg></label></span>`)
  .join("")}
            </fieldset>
          </div>`;

/** Bootstrap Icons' person-circle, the panel's account control. */
const ACCOUNT_ICON = '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M11 6a3 3 0 1 1-6 0 3 3 0 0 1 6 0"/><path fill-rule="evenodd" d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8m8-7a7 7 0 0 0-5.468 11.37C3.242 11.226 4.805 10 8 10s4.757 1.225 5.468 2.37A7 7 0 0 0 8 1"/></svg>';

/** Bootstrap Icons' gear, for Admin Area where a phone leaves room for its icon only. */
const ADMIN_AREA_ICON = '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 4.754a3.246 3.246 0 1 0 0 6.492 3.246 3.246 0 0 0 0-6.492M5.754 8a2.246 2.246 0 1 1 4.492 0 2.246 2.246 0 0 1-4.492 0"/><path d="M9.796 1.343c-.527-1.79-3.065-1.79-3.592 0l-.094.319a.873.873 0 0 1-1.255.52l-.292-.16c-1.64-.892-3.433.902-2.54 2.541l.159.292a.873.873 0 0 1-.52 1.255l-.319.094c-1.79.527-1.79 3.065 0 3.592l.319.094a.873.873 0 0 1 .52 1.255l-.16.292c-.892 1.64.901 3.434 2.541 2.54l.292-.159a.873.873 0 0 1 1.255.52l.094.319c.527 1.79 3.065 1.79 3.592 0l.094-.319a.873.873 0 0 1 1.255-.52l.292.16c1.64.893 3.434-.902 2.54-2.541l-.159-.292a.873.873 0 0 1 .52-1.255l.319-.094c1.79-.527 1.79-3.065 0-3.592l-.319-.094a.873.873 0 0 1-.52-1.255l.16-.292c.893-1.64-.902-3.433-2.541-2.54l-.292.159a.873.873 0 0 1-1.255-.52zm-2.633.283c.246-.835 1.428-.835 1.674 0l.094.319a1.873 1.873 0 0 0 2.693 1.115l.291-.16c.764-.415 1.6.42 1.184 1.185l-.159.292a1.873 1.873 0 0 0 1.116 2.692l.318.094c.835.246.835 1.428 0 1.674l-.319.094a1.873 1.873 0 0 0-1.115 2.693l.16.291c.415.764-.42 1.6-1.185 1.184l-.291-.159a1.873 1.873 0 0 0-2.693 1.116l-.094.318c-.246.835-1.428.835-1.674 0l-.094-.319a1.873 1.873 0 0 0-2.692-1.115l-.292.16c-.764.415-1.6-.42-1.184-1.185l.159-.291A1.873 1.873 0 0 0 1.945 8.93l-.319-.094c-.835-.246-.835-1.428 0-1.674l.319-.094A1.873 1.873 0 0 0 3.06 4.377l-.16-.292c-.415-.764.42-1.6 1.185-1.184l.292.159a1.873 1.873 0 0 0 2.692-1.115z"/></svg>';

/** Bootstrap Icons' box-arrow-right, beside Log Out as the panel has it. */
const LOGOUT_ICON = '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M10 12.5a.5.5 0 0 1-.5.5h-8a.5.5 0 0 1-.5-.5v-9a.5.5 0 0 1 .5-.5h8a.5.5 0 0 1 .5.5v2a.5.5 0 0 0 1 0v-2A1.5 1.5 0 0 0 9.5 2h-8A1.5 1.5 0 0 0 0 3.5v9A1.5 1.5 0 0 0 1.5 14h8a1.5 1.5 0 0 0 1.5-1.5v-2a.5.5 0 0 0-1 0z"/><path fill-rule="evenodd" d="M15.854 8.354a.5.5 0 0 0 0-.708l-3-3a.5.5 0 0 0-.708.708L14.293 7.5H5.5a.5.5 0 0 0 0 1h8.793l-2.147 2.146a.5.5 0 0 0 .708.708z"/></svg>';

/** The inline notice holder every page carries, above its content. */
const FLASH_HTML = '<div id="clp-flash" hidden></div>';

/** What the addon's view drew, in the holder a change repaints in place. */
function viewRoot(content: string): string {
  return `<div id="clp-content">${content}</div>`;
}

/** The one confirmation dialog every page carries. */
const CONFIRM_HTML = `<dialog id="clp-confirm" aria-labelledby="clp-confirm-title">
  <div class="dialog-header"><h2 id="clp-confirm-title">Are you sure?</h2></div>
  <p id="clp-confirm-text"></p>
  <ul id="clp-confirm-details" hidden></ul>
  <div class="form-field" id="clp-confirm-typed-field" hidden>
    <label for="clp-confirm-typed">Type <strong id="clp-confirm-typed-word"></strong> to confirm</label>
    <input id="clp-confirm-typed" autocomplete="off" autocapitalize="off" spellcheck="false">
  </div>
  <form method="dialog" class="actions dialog-actions">
    <button class="btn" value="cancel" type="submit">Cancel</button>
    <button class="btn btn-primary" id="clp-confirm-accept" type="button">Continue</button>
  </form>
</dialog>`;

/**
 * The same page as `renderLayout`, without a document around it, for mounting
 * into CloudPanel's own site page.
 *
 * No header, no footer, no site strip: the panel is already drawing those. The
 * stylesheet is rewritten for a shadow root, and the script is handed back
 * unrun so the loader can give it the root its lookups are relative to.
 */
export function renderFragment(title: string, content: string, chrome: Chrome): EmbedFragment {
  return {
    ok: true,
    title,
    css: shadowStyle(`${BASE_STYLE}${chrome.css ?? ""}`),
    html: `${FLASH_HTML}${viewRoot(content)}${CONFIRM_HTML}`,
    script: `const CLP_BASE = "${escJs(chrome.base)}";\n${BASE_CLIENT_JS}${chrome.script}`,
  };
}

export function renderLayout(title: string, content: string, chrome: Chrome): string {
  const isAddonsRoute = chrome.base === "/addons" || chrome.base.startsWith("/addons/");
  // A site-scoped page belongs to the site, so it highlights Sites; it is not
  // somewhere else in the panel just because an addon renders it.
  const primaryNav = [
    { href: "/dashboard", label: "Dashboard", active: false },
    { href: "/", label: "Sites", active: Boolean(chrome.site) },
    { href: "/addons/", label: "Addons", title: "All addons", active: isAddonsRoute && !chrome.site },
  ]
    .filter((n) => chrome.admin !== false || n.href !== "/addons/")
    .map((n) => {
      const active = n.active ? ' aria-current="page"' : "";
      const titleAttr = n.title ? ` title="${esc(n.title)}"` : "";
      return `      <a class="clp-addon-primary-link${n.active ? " is-active" : ""}" href="${esc(n.href)}"${active}${titleAttr}>${esc(n.label)}</a>`;
    })
    .join("\n");
  const siteHeader = chrome.site
    ? `      ${siteInfoHtml(chrome.site)}
      <nav class="clp-addon-tabs" aria-label="Site navigation">
${siteTabs(chrome.site, chrome.site.activeSlug)
  .map((tab) => `        <a class="clp-addon-nav-link" href="${esc(tab.href)}"${tab.active ? ' aria-current="page"' : ""}>${esc(tab.label)}</a>`)
  .join("\n")}
      </nav>`
    : "";
  const contextualNav = chrome.nav
    .map((n) => `        <a class="clp-addon-nav-link" href="${esc(n.href)}">${esc(n.label)}</a>`)
    .join("\n");
  const contextualHeader = chrome.site || !contextualNav
    ? siteHeader
    : `      <nav class="clp-addon-tabs" data-auto-active aria-label="${esc(chrome.brand)} navigation">
${contextualNav}
      </nav>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no">
<title>${esc(title)}</title>
<script>${THEME_INIT_JS}</script>
<style>${BASE_STYLE}${SITE_CONTEXT_STYLE}${UPDATE_STYLE}${chrome.css ?? ""}</style>
</head>
<body>
<header class="clp-addon-header">
  <div class="clp-addon-header-inner">
    <a class="clp-addon-brand" href="${esc("/")}" aria-label="${esc("CloudPanel home")}">
      <img class="clp-addon-logo" src="/assets/images/logo.svg" alt="CloudPanel" width="126" height="26">
    </a>
    <nav class="clp-addon-primary-nav" aria-label="${esc("CloudPanel navigation")}">
${primaryNav}
    </nav>
    ${chrome.updateNotice ? updateNoticeHtml(chrome.updateNotice.latest) : ""}
    <div class="clp-addon-header-tools">
      ${chrome.admin !== false ? `<a class="btn btn-sm" id="clp-admin-area" href="${esc(PANEL_ADMIN_URL)}" title="Admin Area">
        ${ADMIN_AREA_ICON}
        <span class="clp-addon-tool-label">Admin Area</span>
      </a>` : ""}
      <div class="clp-addon-account">
        <button class="clp-addon-icon-button" id="clp-account-button" type="button" onclick="toggleAccountMenu()"
          aria-haspopup="true" aria-expanded="false" aria-controls="clp-account-menu" aria-label="Account">
          ${ACCOUNT_ICON}
        </button>
        <div class="clp-addon-menu" id="clp-account-menu" hidden>
          <a href="/dashboard">Dashboard</a>
          <a href="${esc(PANEL_SETTINGS_URL)}">Account Settings</a>
          <hr>
          ${THEME_CHOOSER_HTML}
          <hr>
          <a href="${esc(PANEL_LOGOUT_URL)}">Log Out ${LOGOUT_ICON}</a>
        </div>
      </div>
    </div>
  </div>
</header>
<main>${contextualHeader}${FLASH_HTML}${viewRoot(content)}</main>
${CONFIRM_HTML}
<footer class="clp-addon-footer">
  <a href="https://www.cloudpanel.io/blog/" target="_blank" rel="noopener noreferrer">Blog</a>
  <a href="https://www.cloudpanel.io/docs/v2/" target="_blank" rel="noopener noreferrer">Docs</a>
  <a href="https://github.com/7heMech/cloudpanel-addons/issues" target="_blank" rel="noopener noreferrer">Addon issues</a>
  <a href="https://www.cloudpanel.io/" target="_blank" rel="noopener noreferrer">CloudPanel</a>
</footer>
<script>const CLP_BASE = "${escJs(chrome.base)}";
${BASE_CLIENT_JS}${chrome.script}</script>
</body>
</html>`;
}

/**
 * A page for a window of its own, such as the terminal popup: the same head as
 * `renderLayout` -- theme, palette, shared script -- without the panel's
 * header, navigation or footer, which a small window has no room for.
 */
export function renderToolWindow(
  title: string,
  content: string,
  chrome: { base: string; css?: string; script: string; head?: string },
): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no, interactive-widget=resizes-content">
<title>${esc(title)}</title>
<script>${THEME_INIT_JS}</script>
${chrome.head ?? ""}<style>${BASE_STYLE}${chrome.css ?? ""}</style>
</head>
<body class="clp-tool-window">
${content}
<script>const CLP_BASE = "${escJs(chrome.base)}";
${BASE_CLIENT_JS}${chrome.script}</script>
</body>
</html>`;
}

import { esc, escJs } from "./app-http";
import { panelLogos, type PanelLogos } from "./panel-logos";
import { shadowStyle, type EmbedFragment } from "./shadow-embed";
import { SITE_CONTEXT_STYLE, siteInfoHtml, siteTabs, type SiteContext } from "./site-context";
import { UPDATE_STYLE, updateNoticeHtml } from "./update-ui";
import { mountPath } from "./mount";
import { rootShellLink, rootShellScript } from "./root-shell";

/**
 * Gravatar's own default, the image the panel itself shows for an account with
 * no gravatar, carried here as data rather than fetched: the manager serves
 * these pages behind the panel's session without ever being told whose it is,
 * so it has no address to ask about, and asking would tell Gravatar which boxes
 * an operator administers.
 */
const DEFAULT_AVATAR = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD//gA7Q1JFQVRPUjogZ2QtanBlZyB2MS4wICh1c2luZyBJSkcgSlBFRyB2NjIpLCBxdWFsaXR5ID0gOTAK/9sAQwADAgIDAgIDAwMDBAMDBAUIBQUEBAUKBwcGCAwKDAwLCgsLDQ4SEA0OEQ4LCxAWEBETFBUVFQwPFxgWFBgSFBUU/9sAQwEDBAQFBAUJBQUJFA0LDRQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU/8AAEQgARgBGAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/aAAwDAQACEQMRAD8A+uKKKKACiiigAooooAKKKKACiiigAooooAK7Hwx8NrzXYEurmT7FavypZcu49QOw9zVP4feH01/xDGky7raBfOkU9GweB+JI/AGvdQABgcCgDz2b4OaeYsR31ykn95wrD8sD+dcJ4n8G3/heUGcCa2c4S4j+6T6H0Ne/VS1TTYNWsJ7O5TfFKu0j09CPcdaAPnGirOp2D6XqFzaSffgkaMn1wetVqACiiigAooooA9J+DO37Rqufv7Y8fTLZ/pXqVeE+APECeH/EEckrbbaceTKx6KCeD+BA/DNe6BgwBByD0IoAdRRVHVtSg0ewmvLl9kUS7j6k9gPc9KAPFfiHt/4TLUtnTcv57Fz+tc5VnUr6TU9QuLuX/WTSNIfbJziq1ABRRRQAUUV1fgDwgPE2oPJcgixt8GTHG89lz/P/AOvQBh6XoWo6yxWys5bjHBZV+UfU9BXr/gLStc0qyMGqSxmFRiKLO50/4EOMe3P4V09tbRWcCQwRrFEgwqIMACpqACvNfiB4c8Sa1eExbLuwQ7ooYiFK/UE8n3/lXpVFAHzXeWVxYTmG6gkt5R1SRSp/WoK+iNc0Gy8QWbW15EHU/dcfeQ+oPavCPEGizeHtVnsZvmaM/K4HDKehoAzqKKKACvbfhfapbeEbZ1HzTu8jH33bf5KKKKAOuooooAKKKKACvK/jNaIl3plyB88iPGfoCCP/AEI0UUAecUUUUAf/2Q==";
// The header reproduces CloudPanel's own controls. Their icons are the panel's
// own paths, copied rather than approximated, so the same control does not
// have two shapes depending on which page it is on.
const PANEL_ADMIN_URL = "/admin/users";
const PANEL_SETTINGS_URL = "/settings";
const PANEL_LOGOUT_URL = "/logout";

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

export function jobStateClass(state: string): string {
  return ["queued", "running", "done", "failed"].includes(state) ? `state-${state}` : "state-failed";
}

export function jobStateLabel(state: string): string {
  return ({ queued: "Queued", running: "Running", done: "Done", failed: "Failed" } as Record<string, string>)[state] ?? state;
}

export function whenText(iso: string): string {
  const at = Date.parse(iso);
  return Number.isFinite(at) ? `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC` : "—";
}

/** Below this many sites the whole table fits on a screen, so it needs no search. */
const FLEET_FILTER_MIN = 6;

export const ATTENTION_RANK = { bad: 0, warn: 1, info: 2, ok: 3, muted: 4 } as const;

interface FleetFilter { value: string; label: string; group?: string }

export function filterWord(prefix: string, label: string): string {
  return `${prefix}-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

export function valueFilters(group: string, prefix: string, labels: string[]): FleetFilter[] {
  const distinct = [...new Set(labels.filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return distinct.length < 2 ? [] : distinct.map((label) => ({ value: filterWord(prefix, label), label, group }));
}

/**
 * For a site table whose rows carry `data-domain`, `data-find` and
 * `data-show`; the client half is `filterFleet`. Within a filter group a row
 * needs any of the ticked words, across groups all of them.
 */
export function fleetFilterHtml(options: {
  count: number;
  placeholder?: string;
  filters?: FleetFilter[];
  summary?: string;
}): string {
  if (options.count < FLEET_FILTER_MIN) return "";
  const groups = new Map<string, FleetFilter[]>();
  for (const filter of options.filters ?? []) {
    const group = filter.group ?? "Status";
    groups.set(group, [...(groups.get(group) ?? []), filter]);
  }
  const filters = groups.size
    ? `<details class="fleet-show" id="fleet-show"><summary><span id="fleet-show-label">All sites</span></summary>
        <div class="fleet-show-menu" role="group" aria-label="Show">${[...groups].map(([group, list]) => `
          <fieldset><legend${groups.size > 1 ? "" : ' class="visually-hidden"'}>${esc(group)}</legend>${list.map((filter) =>
            `<label><input type="checkbox" value="${esc(filter.value)}" data-group="${esc(group)}" onchange="pickFleetFilter()"> ${esc(filter.label)}</label>`).join("")}</fieldset>`).join("")}
          <button class="fleet-show-clear" type="button" onclick="clearFleetFilters()">Show all sites</button>
        </div></details>`
    : "";
  const placeholder = options.placeholder ?? "Find a site";
  return `<div class="fleet-filter">
      <input type="search" id="fleet-find" data-keep placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)}" oninput="filterFleet()">
      ${filters}${options.summary === undefined ? "" : `<span class="hint" id="fleet-summary" data-all="${esc(options.summary)}">${esc(options.summary)}</span>`}
    </div>`;
}

/** Goes in a site table's `.card-header.toolbar`, after its title and before the bulk actions. */
export const FLEET_SELECTION_HTML = `<div class="fleet-selection"><span class="toolbar-note" id="site-selection">No sites selected</span>
<button class="btn mobile-select-all" id="select-all-btn" type="button" onclick="toggleAllSites()">Select all</button></div>`;

export const FLEET_NONE_HTML = `<div class="empty" id="fleet-none" hidden>No site matches.</div>`;

/**
 * A page that ends with its list uses `FLEET_NONE_HTML` alone, and the fleet
 * script then shows every site on a phone.
 */
export const FLEET_FOOTER_HTML = `${FLEET_NONE_HTML}
<div class="fleet-more" id="fleet-more" hidden><button class="btn" type="button" onclick="showAllSites()">Show all sites</button></div>`;

export const PHONE_CUT = 10;

/** For a second long list, whose `tbody[data-phone-cut]` names the same `id`. */
export function phoneMoreHtml(id: string, label: string): string {
  return `<div class="fleet-more" data-phone-more="${esc(id)}" hidden><button class="btn" type="button" onclick="showAllRows('${esc(id)}')">${esc(label)}</button></div>`;
}

import FLEET_ROW_SELECTION_JS from "./assets/fleet-row-selection.client.js" with { type: "text" };
export { FLEET_ROW_SELECTION_JS };

// Measured against CloudPanel 2.5.1's public demo: dashboard, sites, settings,
// certificates, logs and new-site forms. Keep these rules independent of the
// panel's private templates and versioned CSS bundles.
import BASE_STYLE from "./assets/app-ui.css" with { type: "text" };
export { BASE_STYLE };

// CloudPanel uses a session cookie named "theme"; absence means light. Read it
// before CSS is painted, so moving between the panel and an addon never flashes
// or silently switches to the operating system's preferred theme.
import THEME_INIT_JS from "./assets/theme-init.client.js" with { type: "text" };
export { THEME_INIT_JS };

import BASE_CLIENT_JS from "./assets/app-ui.client.js" with { type: "text" };
export { BASE_CLIENT_JS };

import TWEAK_ROW_JS from "./assets/tweak-rows.client.js" with { type: "text" };
export { TWEAK_ROW_JS };

import JOB_WATCH_JS from "./assets/job-watch.client.js" with { type: "text" };
export { JOB_WATCH_JS };

import JOB_PROGRESS_JS from "./assets/job-progress.client.js" with { type: "text" };
export { JOB_PROGRESS_JS };

interface SiteJobProgress {
  id: string;
  state: string;
  step: string;
  completed: number;
  total: number;
  site: string;
}

// job-progress.client.js writes the same text.
function jobProgressText(job: SiteJobProgress): string {
  const count = job.total ? `${Math.min(job.completed + 1, job.total)} of ${job.total}: ` : "";
  return job.state === "queued" ? "Waiting to start" : job.site ? `${count}${job.site}` : job.step;
}

export function jobProgressHtml(job: SiteJobProgress, title: string, hidden = false): string {
  return `<div class="job-progress" data-job="${esc(job.id)}" role="status"${hidden ? " hidden" : ""}>
        <div class="job-progress-head"><strong>${esc(title)}</strong><span class="job-progress-step hint">${esc(jobProgressText(job))}</span></div>
        <progress class="job-progress-bar" max="${Math.max(job.total, 1)}"${job.total ? ` value="${job.completed}"` : ""}></progress>
      </div>`;
}

export interface AddonChrome {
  base: string;
  css?: string;
  script: string;
}

interface Chrome extends AddonChrome {
  updateNotice?: { current: string; latest: string } | null;
  /** False for pages reached by a site manager. */
  admin?: boolean;
  site?: SiteContext & { activeSlug: string };
}

/** The panel's own moon and sun. */
export const THEME_SWITCH_ICONS = `<svg class="moon" viewBox="0 0 384 512" fill="currentColor" aria-hidden="true"><path d="M223.5 32C100 32 0 132.3 0 256S100 480 223.5 480c60.6 0 115.5-24.2 155.8-63.4c5-4.9 6.3-12.5 3.1-18.7s-10.1-9.7-17-8.5c-9.8 1.7-19.8 2.6-30.1 2.6c-96.9 0-175.5-78.8-175.5-176c0-65.8 36-123.1 89.3-153.3c6.1-3.5 9.2-10.5 7.7-17.3s-7.3-11.9-14.3-12.5c-6.3-.5-12.6-.8-19-.8z"/></svg>
<svg class="sun" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4 8a4 4 0 11-8 0 4 4 0 018 0zm-.464 4.95l.707.707a1 1 0 001.414-1.414l-.707-.707a1 1 0 00-1.414 1.414zm2.12-10.607a1 1 0 010 1.414l-.706.707a1 1 0 11-1.414-1.414l.707-.707a1 1 0 011.414 0zM17 11a1 1 0 100-2h-1a1 1 0 100 2h1zm-7 4a1 1 0 011 1v1a1 1 0 11-2 0v-1a1 1 0 011-1zM5.05 6.464A1 1 0 106.465 5.05l-.708-.707a1 1 0 00-1.414 1.414l.707.707zm1.414 8.486l-.707.707a1 1 0 01-1.414-1.414l.707-.707a1 1 0 011.414 1.414zM4 11a1 1 0 100-2H3a1 1 0 000 2h1z" clip-rule="evenodd"></path></svg>`;

const FLASH_HTML = '<div id="clp-flash" hidden></div>';

function viewRoot(content: string): string {
  return `<div id="clp-content">${content}</div>`;
}

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
 * For mounting into CloudPanel's own site page, which already draws the
 * header, footer and site strip.
 */
export function renderFragment(title: string, content: string, chrome: AddonChrome): EmbedFragment {
  return {
    ok: true,
    title,
    css: shadowStyle(`${BASE_STYLE}${chrome.css ?? ""}`),
    html: `${FLASH_HTML}${viewRoot(content)}${CONFIRM_HTML}`,
    script: `const CLP_BASE = "${escJs(chrome.base)}";\n${BASE_CLIENT_JS}${chrome.script}`,
  };
}

export function logosHtml(logos: PanelLogos | null): string {
  const header = logos?.header ?? logos?.mark;
  if (!logos || !header) {
    return `      <img class="clp-addon-logo clp-addon-logo-light" src="/assets/images/logo.svg" alt="CloudPanel" width="155" height="31">
      <img class="clp-addon-logo clp-addon-logo-dark" src="/assets/images/logo-dark.svg" alt="CloudPanel" width="155" height="31">`;
  }
  const mark = logos.header ? logos.mark : null;
  return [0, 1].map((theme) => `      <picture class="clp-addon-logo-${theme ? "dark" : "light"}">${mark
    ? `<source media="(max-width: 760px)" srcset="${esc(mark[theme]!)}">` : ""}<img class="clp-addon-logo clp-addon-logo-custom" src="${esc(header[theme]!)}" alt="Home" height="31"></picture>`).join("\n");
}

export function faviconHtml(logos: PanelLogos | null): string {
  if (!logos?.favicon) return "";
  const type = logos.favicon.endsWith(".svg") ? "image/svg+xml" : logos.favicon.endsWith(".ico") ? "image/x-icon" : "image/png";
  return `<link rel="icon" type="${type}" href="${esc(logos.favicon)}">\n`;
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
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no">
<title>${esc(title)}</title>
${faviconHtml(panelLogos())}<script>${THEME_INIT_JS}</script>
<style>${BASE_STYLE}${SITE_CONTEXT_STYLE}${UPDATE_STYLE}${chrome.css ?? ""}</style>
</head>
<body>
<header class="clp-addon-header">
  <div class="clp-addon-header-inner">
    <a class="clp-addon-brand" href="${esc("/")}" aria-label="${esc("CloudPanel home")}">
${logosHtml(panelLogos())}
    </a>
    <nav class="clp-addon-primary-nav" aria-label="${esc("CloudPanel navigation")}">
${primaryNav}
      ${chrome.admin !== false ? rootShellLink(mountPath("terminal"), 'class="clp-addon-primary-link clp-root-shell-nav" data-clp-root-shell hidden', "Root") : ""}
    </nav>
    ${chrome.updateNotice ? updateNoticeHtml(chrome.updateNotice.latest) : ""}
    <div class="clp-addon-header-tools">
      <button class="clp-addon-tool" id="theme-switch" type="button" onclick="toggleTheme()" aria-label="Switch to dark mode" aria-pressed="false">
        ${THEME_SWITCH_ICONS}
      </button>
      ${chrome.admin !== false ? `<a class="clp-addon-tool" id="clp-admin-area" href="${esc(PANEL_ADMIN_URL)}" title="Admin Area">
        <svg viewBox="0 0 640 512" aria-hidden="true"><path fill="currentColor" d="M315.3 255.5c6.8-19 16.4-36.5 28.4-52.2-7.4 3-15.4 4.7-23.8 4.7-35.3 0-64-28.7-64-64s28.7-64 64-64 64 28.7 64 64c0 8.4-1.7 16.4-4.7 23.8 15.7-12 33.2-21.7 52.2-28.4C429 79.7 380.3 32 320 32c-61.9 0-112 50.1-112 112 0 60.3 47.7 109 107.3 111.5zM96 224c44.2 0 80-35.8 80-80s-35.8-80-80-80-80 35.8-80 80 35.8 80 80 80zm0-112c17.6 0 32 14.4 32 32s-14.4 32-32 32-32-14.4-32-32 14.4-32 32-32zm244.3 320H176v-44.8c0-36.4 29.2-66.2 65.4-67.2 20.6 8.6 41.9 13.6 63.4 15.2-.7-9.3-2-24 2.3-48.6-16.8-1.5-33.1-4.9-48-11.2-5.1-2.1-10.4-3.4-15.9-3.4-63.6 0-115.2 51.6-115.2 115.2V432c0 26.5 21.5 48 48 48h214c-19.4-12.9-36.2-29.2-49.7-48zM154.8 270.3c-13.4-9-29.5-14.3-46.8-14.3H84c-46.3 0-84 37.7-84 84 0 13.2 10.8 24 24 24s24-10.8 24-24c0-19.8 16.2-36 36-36h24c4.4 0 8.5 1.1 12.3 2.5 9.3-14 21.1-26.1 34.5-36.2zm455.7 71c2.6-14.1 2.6-28.5 0-42.6l25.8-14.9c3-1.7 4.3-5.2 3.3-8.5-6.7-21.6-18.2-41.2-33.2-57.4-2.3-2.5-6-3.1-9-1.4l-25.8 14.9c-10.9-9.3-23.4-16.5-36.9-21.3v-29.8c0-3.4-2.4-6.4-5.7-7.1-22.3-5-45-4.8-66.2 0-3.3.7-5.7 3.7-5.7 7.1v29.8c-13.5 4.8-26 12-36.9 21.3l-25.8-14.9c-2.9-1.7-6.7-1.1-9 1.4-15 16.2-26.5 35.8-33.2 57.4-1 3.3.4 6.8 3.3 8.5l25.8 14.9c-2.6 14.1-2.6 28.5 0 42.6l-25.8 14.9c-3 1.7-4.3 5.2-3.3 8.5 6.7 21.6 18.2 41.1 33.2 57.4 2.3 2.5 6 3.1 9 1.4l25.8-14.9c10.9 9.3 23.4 16.5 36.9 21.3v29.8c0 3.4 2.4 6.4 5.7 7.1 22.3 5 45 4.8 66.2 0 3.3-.7 5.7-3.7 5.7-7.1v-29.8c13.5-4.8 26-12 36.9-21.3l25.8 14.9c2.9 1.7 6.7 1.1 9-1.4 15-16.2 26.5-35.8 33.2-57.4 1-3.3-.4-6.8-3.3-8.5l-25.8-14.9zM496 368.5c-26.8 0-48.5-21.8-48.5-48.5s21.8-48.5 48.5-48.5 48.5 21.8 48.5 48.5-21.7 48.5-48.5 48.5z"></path></svg>
        <span class="clp-addon-tool-label">Admin Area</span>
      </a>` : ""}
      ${chrome.admin !== false ? rootShellLink(mountPath("terminal"), 'class="clp-addon-tool" id="clp-root-shell" data-clp-root-shell hidden',
        '<span class="clp-addon-tool-label">Root terminal</span>') : ""}
      <div class="clp-addon-account">
        <button class="clp-addon-tool" id="clp-account-button" type="button" onclick="toggleAccountMenu()"
          aria-haspopup="true" aria-expanded="false" aria-label="Account">
          <img class="clp-addon-avatar" src="${DEFAULT_AVATAR}" alt="" width="35" height="35">
        </button>
        <div class="clp-addon-account-menu" id="clp-account-menu" hidden>
          <a href="${esc(PANEL_SETTINGS_URL)}">Settings</a>
          <a href="${esc(PANEL_LOGOUT_URL)}">Logout</a>
        </div>
      </div>
    </div>
  </div>
</header>
<main>${siteHeader}${FLASH_HTML}${viewRoot(content)}</main>
${CONFIRM_HTML}
<footer class="clp-addon-footer">
  <a href="https://github.com/7heMech/cloudpanel-addons/issues" target="_blank" rel="noopener noreferrer">Report an addon issue</a>
  <a href="https://github.com/7heMech/cloudpanel-addons" target="_blank" rel="noopener noreferrer">Star addons on GitHub</a>
</footer>
<script>const CLP_BASE = "${escJs(chrome.base)}";
${BASE_CLIENT_JS}${chrome.admin !== false ? rootShellScript(mountPath("terminal")) : ""}${chrome.script}</script>
</body>
</html>`;
}

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
${faviconHtml(panelLogos())}<script>${THEME_INIT_JS}</script>
${chrome.head ?? ""}<style>${BASE_STYLE}${chrome.css ?? ""}</style>
</head>
<body class="clp-tool-window">
${content}
<script>const CLP_BASE = "${escJs(chrome.base)}";
${BASE_CLIENT_JS}${chrome.script}</script>
</body>
</html>`;
}

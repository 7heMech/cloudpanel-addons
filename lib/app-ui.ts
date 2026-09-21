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
 * Admin Area, and an account menu of Settings and Logout. The avatar is a
 * icons are the panel's own paths, copied rather than approximated, so the same
 * control does not have two shapes depending on which page it is on.
 *
 * The avatar is Gravatar's own default, the image the panel itself shows for an
 * account with no gravatar, carried here as data rather than fetched: the
 * manager serves these pages behind the panel's session without ever being told
 * whose it is, so it has no address to ask about, and asking would tell
 * Gravatar which boxes an operator administers.
 */
const DEFAULT_AVATAR = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD//gA7Q1JFQVRPUjogZ2QtanBlZyB2MS4wICh1c2luZyBJSkcgSlBFRyB2NjIpLCBxdWFsaXR5ID0gOTAK/9sAQwADAgIDAgIDAwMDBAMDBAUIBQUEBAUKBwcGCAwKDAwLCgsLDQ4SEA0OEQ4LCxAWEBETFBUVFQwPFxgWFBgSFBUU/9sAQwEDBAQFBAUJBQUJFA0LDRQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU/8AAEQgARgBGAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/aAAwDAQACEQMRAD8A+uKKKKACiiigAooooAKKKKACiiigAooooAK7Hwx8NrzXYEurmT7FavypZcu49QOw9zVP4feH01/xDGky7raBfOkU9GweB+JI/AGvdQABgcCgDz2b4OaeYsR31ykn95wrD8sD+dcJ4n8G3/heUGcCa2c4S4j+6T6H0Ne/VS1TTYNWsJ7O5TfFKu0j09CPcdaAPnGirOp2D6XqFzaSffgkaMn1wetVqACiiigAooooA9J+DO37Rqufv7Y8fTLZ/pXqVeE+APECeH/EEckrbbaceTKx6KCeD+BA/DNe6BgwBByD0IoAdRRVHVtSg0ewmvLl9kUS7j6k9gPc9KAPFfiHt/4TLUtnTcv57Fz+tc5VnUr6TU9QuLuX/WTSNIfbJziq1ABRRRQAUUV1fgDwgPE2oPJcgixt8GTHG89lz/P/AOvQBh6XoWo6yxWys5bjHBZV+UfU9BXr/gLStc0qyMGqSxmFRiKLO50/4EOMe3P4V09tbRWcCQwRrFEgwqIMACpqACvNfiB4c8Sa1eExbLuwQ7ooYiFK/UE8n3/lXpVFAHzXeWVxYTmG6gkt5R1SRSp/WoK+iNc0Gy8QWbW15EHU/dcfeQ+oPavCPEGizeHtVnsZvmaM/K4HDKehoAzqKKKACvbfhfapbeEbZ1HzTu8jH33bf5KKKKAOuooooAKKKKACvK/jNaIl3plyB88iPGfoCCP/AEI0UUAecUUUUAf/2Q==";
const PANEL_ADMIN_URL = "/admin/users";
const PANEL_SETTINGS_URL = "/settings";
const PANEL_LOGOUT_URL = "/logout";

/** Shared interaction and focus treatment for selectable site-table rows. */
export function fleetRowSelectionStyle(tableClass: string): string {
  return `
.${tableClass} tbody tr { cursor: pointer; transition: background-color .15s, box-shadow .15s; }
.${tableClass} tbody tr:hover { background: rgb(38 125 221 / 6%); }
.${tableClass} tbody tr[aria-selected="true"] { background: rgb(38 125 221 / 12%); box-shadow: inset 4px 0 var(--primary); }
.${tableClass} tbody tr:focus-visible { outline: 2px solid var(--accent); outline-offset: -3px; }
`;
}

/** Shared mouse/keyboard selection for the Cloudflare and PHP site tables. */
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
export const THEME_INIT_JS = `
try {
  document.documentElement.classList.toggle('dark', /(?:^|;\\s*)theme=dark(?:;|$)/.test(document.cookie));
} catch (e) {}
`;

/**
 * The client-side helpers every addon page needs: read the CSRF cookie, echo it
 * back on a mutation, and disable the page while one is in flight.
 *
 * Concatenated into the addon's own script, so a syntax error here takes down
 * every button on the page; tools/test-app.ts parses the pair together.
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

/**
 * The client half of the job progress page: paint an update, and follow a job
 * until it reaches a state that will not change again.
 *
 * Appended to an addon's own script, which calls `watchJob(id)` once the page
 * announces a job to follow. A caller can pass a containing element as the
 * second argument when a page has more than one job surface; the manager uses
 * that to keep updates in the card whose action started the job. The markup
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
  /**
   * Draw CloudPanel's site information and site tab strip instead of this
   * addon's own tabs, for a page reached from that strip. `activeSlug` is the
   * tab this page is; see lib/site-context for the list.
   */
  site?: SiteContext & { activeSlug: string };
}

/** The inline notice holder every page carries, above its content. */
const FLASH_HTML = '<div id="clp-flash" hidden></div>';

/** The one confirmation dialog every page carries. */
const CONFIRM_HTML = `<dialog id="clp-confirm" aria-labelledby="clp-confirm-title">
  <div class="dialog-header"><h2 id="clp-confirm-title">Are you sure?</h2></div>
  <p id="clp-confirm-text"></p>
  <ul id="clp-confirm-details" hidden></ul>
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
    html: `${FLASH_HTML}${content}${CONFIRM_HTML}`,
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
      <img class="clp-addon-logo clp-addon-logo-light" src="/assets/images/logo.svg" alt="CloudPanel" width="155" height="31">
      <img class="clp-addon-logo clp-addon-logo-dark" src="/assets/images/logo-dark.svg" alt="CloudPanel" width="155" height="31">
    </a>
    <nav class="clp-addon-primary-nav" aria-label="${esc("CloudPanel navigation")}">
${primaryNav}
    </nav>
    ${chrome.updateNotice ? updateNoticeHtml(chrome.updateNotice.latest) : ""}
    <div class="clp-addon-header-tools">
      <button class="clp-addon-tool" id="theme-switch" type="button" onclick="toggleTheme()" aria-label="Switch to dark mode" aria-pressed="false">
        <svg class="moon" viewBox="0 0 384 512" fill="currentColor" aria-hidden="true"><path d="M223.5 32C100 32 0 132.3 0 256S100 480 223.5 480c60.6 0 115.5-24.2 155.8-63.4c5-4.9 6.3-12.5 3.1-18.7s-10.1-9.7-17-8.5c-9.8 1.7-19.8 2.6-30.1 2.6c-96.9 0-175.5-78.8-175.5-176c0-65.8 36-123.1 89.3-153.3c6.1-3.5 9.2-10.5 7.7-17.3s-7.3-11.9-14.3-12.5c-6.3-.5-12.6-.8-19-.8z"/></svg>
        <svg class="sun" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4 8a4 4 0 11-8 0 4 4 0 018 0zm-.464 4.95l.707.707a1 1 0 001.414-1.414l-.707-.707a1 1 0 00-1.414 1.414zm2.12-10.607a1 1 0 010 1.414l-.706.707a1 1 0 11-1.414-1.414l.707-.707a1 1 0 011.414 0zM17 11a1 1 0 100-2h-1a1 1 0 100 2h1zm-7 4a1 1 0 011 1v1a1 1 0 11-2 0v-1a1 1 0 011-1zM5.05 6.464A1 1 0 106.465 5.05l-.708-.707a1 1 0 00-1.414 1.414l.707.707zm1.414 8.486l-.707.707a1 1 0 01-1.414-1.414l.707-.707a1 1 0 011.414 1.414zM4 11a1 1 0 100-2H3a1 1 0 000 2h1z" clip-rule="evenodd"></path></svg>
      </button>
      <a class="clp-addon-tool" id="clp-admin-area" href="${esc(PANEL_ADMIN_URL)}" title="Admin Area">
        <svg viewBox="0 0 640 512" aria-hidden="true"><path fill="currentColor" d="M315.3 255.5c6.8-19 16.4-36.5 28.4-52.2-7.4 3-15.4 4.7-23.8 4.7-35.3 0-64-28.7-64-64s28.7-64 64-64 64 28.7 64 64c0 8.4-1.7 16.4-4.7 23.8 15.7-12 33.2-21.7 52.2-28.4C429 79.7 380.3 32 320 32c-61.9 0-112 50.1-112 112 0 60.3 47.7 109 107.3 111.5zM96 224c44.2 0 80-35.8 80-80s-35.8-80-80-80-80 35.8-80 80 35.8 80 80 80zm0-112c17.6 0 32 14.4 32 32s-14.4 32-32 32-32-14.4-32-32 14.4-32 32-32zm244.3 320H176v-44.8c0-36.4 29.2-66.2 65.4-67.2 20.6 8.6 41.9 13.6 63.4 15.2-.7-9.3-2-24 2.3-48.6-16.8-1.5-33.1-4.9-48-11.2-5.1-2.1-10.4-3.4-15.9-3.4-63.6 0-115.2 51.6-115.2 115.2V432c0 26.5 21.5 48 48 48h214c-19.4-12.9-36.2-29.2-49.7-48zM154.8 270.3c-13.4-9-29.5-14.3-46.8-14.3H84c-46.3 0-84 37.7-84 84 0 13.2 10.8 24 24 24s24-10.8 24-24c0-19.8 16.2-36 36-36h24c4.4 0 8.5 1.1 12.3 2.5 9.3-14 21.1-26.1 34.5-36.2zm455.7 71c2.6-14.1 2.6-28.5 0-42.6l25.8-14.9c3-1.7 4.3-5.2 3.3-8.5-6.7-21.6-18.2-41.2-33.2-57.4-2.3-2.5-6-3.1-9-1.4l-25.8 14.9c-10.9-9.3-23.4-16.5-36.9-21.3v-29.8c0-3.4-2.4-6.4-5.7-7.1-22.3-5-45-4.8-66.2 0-3.3.7-5.7 3.7-5.7 7.1v29.8c-13.5 4.8-26 12-36.9 21.3l-25.8-14.9c-2.9-1.7-6.7-1.1-9 1.4-15 16.2-26.5 35.8-33.2 57.4-1 3.3.4 6.8 3.3 8.5l25.8 14.9c-2.6 14.1-2.6 28.5 0 42.6l-25.8 14.9c-3 1.7-4.3 5.2-3.3 8.5 6.7 21.6 18.2 41.1 33.2 57.4 2.3 2.5 6 3.1 9 1.4l25.8-14.9c10.9 9.3 23.4 16.5 36.9 21.3v29.8c0 3.4 2.4 6.4 5.7 7.1 22.3 5 45 4.8 66.2 0 3.3-.7 5.7-3.7 5.7-7.1v-29.8c13.5-4.8 26-12 36.9-21.3l25.8 14.9c2.9 1.7 6.7 1.1 9-1.4 15-16.2 26.5-35.8 33.2-57.4 1-3.3-.4-6.8-3.3-8.5l-25.8-14.9zM496 368.5c-26.8 0-48.5-21.8-48.5-48.5s21.8-48.5 48.5-48.5 48.5 21.8 48.5 48.5-21.7 48.5-48.5 48.5z"></path></svg>
        <span class="clp-addon-tool-label">Admin Area</span>
      </a>
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
<main>${contextualHeader}${FLASH_HTML}${content}</main>
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

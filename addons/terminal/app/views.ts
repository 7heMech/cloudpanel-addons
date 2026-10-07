import { esc } from "../../../lib/app-http";
import { renderLayout, renderToolWindow, THEME_SWITCH_ICONS } from "../../../lib/app-ui";
import { mountPath } from "../../../lib/mount";
import { siteTypeLabel } from "../../../lib/site-context";
import type { SanitizedSite } from "../../../lib/gateway-protocol";

import OPEN_JS from "./open.client.js" with { type: "text" };
import FLEET_JS from "./fleet.client.js" with { type: "text" };
import FLEET_STYLE from "./fleet.css" with { type: "text" };
import POPUP_JS from "./popup.client.js" with { type: "text" };
import POPUP_STYLE from "./popup.css" with { type: "text" };

export { OPEN_JS };

const BASE = mountPath("terminal");

/** Versioned, so the year-long cache on them is safe across an upgrade. */
export const XTERM_ASSETS = {
  "xterm-6.0.0/xterm.js": "text/javascript; charset=utf-8",
  "xterm-6.0.0/xterm.css": "text/css; charset=utf-8",
  "addon-fit-0.11.0/addon-fit.js": "text/javascript; charset=utf-8",
} as const;

export function layout(
  title: string,
  content: string,
  updateNotice?: { current: string; latest: string } | null,
): string {
  return renderLayout(title, content, {
    brand: "Terminal",
    base: BASE,
    nav: [],
    css: FLEET_STYLE,
    script: `${OPEN_JS}${FLEET_JS}`,
    updateNotice,
  });
}

function siteRow(site: SanitizedSite): string {
  return `
              <tr data-domain="${esc(site.domain)}" data-search="${esc(`${site.domain} ${site.user}`.toLowerCase())}">
                <td class="site-cell">${esc(site.domain)}</td>
                <td class="type-cell">${esc(siteTypeLabel(site.type))}</td>
                <td class="user-cell" data-label="Site user">${esc(site.user)}</td>
                <td class="action-cell">
                  <button class="btn" type="button" data-domain="${esc(site.domain)}" onclick="openFromRow(this, event)">Open terminal</button>
                </td>
              </tr>`;
}

export function dashboardView(sites: SanitizedSite[]): string {
  const count = `${sites.length} site${sites.length === 1 ? "" : "s"}`;
  const table = sites.length === 0
    ? '<div class="empty">CloudPanel has no sites yet.</div>'
    : `<div class="table-scroll">
        <table class="fleet-table terminal-site-table">
          <thead>
            <tr>
              <th>Domain</th>
              <th>Type</th>
              <th>Site user</th>
              <th class="text-end">Action</th>
            </tr>
          </thead>
          <tbody>${sites.map(siteRow).join("")}
          </tbody>
        </table>
      </div>
      <div class="terminal-none" id="terminal-none" hidden>No site matches.</div>`;
  return `
    <div class="page-heading">
      <div>
        <h1>Terminal</h1>
        <p>A shell as a site's own user, starting in its site directory, in a window of its own.</p>
      </div>
    </div>
    <div class="card card-table">
      <div class="card-header terminal-toolbar">
        <h2>Sites</h2>
        <span class="toolbar-note" id="terminal-count">${count}</span>
        ${sites.length === 0 ? "" : '<input type="search" id="terminal-search" placeholder="Search sites" aria-label="Search sites" autocomplete="off">'}
      </div>
      ${table}
    </div>`;
}

export function inventoryUnavailableView(message: string): string {
  return `
    <div class="page-heading">
      <div><h1>Terminal</h1></div>
    </div>
    <div class="alert" role="alert">The site list is unavailable: ${esc(message)}</div>`;
}

const KEYS = [
  ["esc", "Esc"], ["tab", "Tab"], ["ctrl", "Ctrl"], ["left", "←"], ["up", "↑"], ["down", "↓"], ["right", "→"],
  ["select", "Select"], ["paste", "Paste"],
];

export function popupPage(domain: string): string {
  const keys = KEYS.map(([name, label]) =>
    `<button type="button" data-key="${name}"${name === "ctrl" ? ' id="term-ctrl" aria-pressed="false"' : ""}>${label}</button>`).join("");
  const content = `<div class="term-bar">
  <img class="term-logo clp-addon-logo-light" src="/assets/images/logo.svg" alt="CloudPanel" width="100" height="20">
  <img class="term-logo clp-addon-logo-dark" src="/assets/images/logo-dark.svg" alt="CloudPanel" width="100" height="20">
  <span class="term-domain" title="${esc(domain)}">${esc(domain)}</span>
  <span class="term-user" id="term-user" hidden></span>
  <span class="badge state-paused" id="term-status" role="status">Connecting</span>
  <div class="term-tools">
    <button class="term-tool" type="button" onclick="changeFont(-1)" aria-label="Smaller text" title="Smaller text">A−</button>
    <button class="term-tool" type="button" onclick="changeFont(1)" aria-label="Larger text" title="Larger text">A+</button>
    <button class="term-tool" id="theme-switch" type="button" onclick="toggleTheme()" aria-label="Switch to dark mode" aria-pressed="false">
      ${THEME_SWITCH_ICONS}
    </button>
  </div>
</div>
<div class="term-main" id="term-main">
  <div id="terminal" data-domain="${esc(domain)}"></div>
  <div class="term-select" id="term-select" hidden>
    <div class="term-select-bar">
      <span>Select text to copy</span>
      <button class="btn" type="button" onclick="copyAllText()">Copy all</button>
      <button class="btn btn-primary" type="button" onclick="closeSelect()">Done</button>
    </div>
    <pre id="term-select-text"></pre>
  </div>
  <div class="term-ended" id="term-ended" hidden>
    <div class="card" role="alertdialog" aria-labelledby="term-ended-title" aria-describedby="term-ended-text">
      <h2 id="term-ended-title">Session ended</h2>
      <p id="term-ended-text"></p>
      <div class="actions">
        <button class="btn btn-primary" id="term-new" type="button" onclick="newSession()">New session</button>
        <button class="btn" type="button" onclick="window.close()">Close window</button>
      </div>
    </div>
  </div>
</div>
<div class="term-keys" aria-label="Extra keys">${keys}</div>`;
  const assets = Object.keys(XTERM_ASSETS).map((path) => `${BASE}/assets/${path}`);
  return renderToolWindow(`${domain} — Terminal`, content, {
    base: BASE,
    css: POPUP_STYLE,
    script: POPUP_JS,
    head: `<link rel="stylesheet" href="${assets[1]}">
<script src="${assets[0]}"></script>
<script src="${assets[2]}"></script>
`,
  });
}

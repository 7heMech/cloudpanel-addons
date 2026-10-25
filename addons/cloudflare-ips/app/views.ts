import CLIENT_JS_BODY from "./views.client.js" with { type: "text" };
import { esc } from "../../../lib/app-http";
import {
  FLEET_NONE_HTML, FLEET_ROW_SELECTION_JS, fleetFilterHtml, fleetRowSelectionStyle, renderLayout,
} from "../../../lib/app-ui";
import { mountPath } from "../../../lib/mount";
import type { CloudflareState } from "./service";

const BASE = mountPath("cloudflare-ips");
const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;

// Switches, the toolbar, the confirmation dialog and the inline notice come
// from lib/app-ui so this addon looks like the rest of the manager.
import VIEWS_CSS from "./views.css" with { type: "text" };

const STYLE = VIEWS_CSS
  .split("/* fleet-row-selection */").join(fleetRowSelectionStyle("cloudflare-site-table"));

export const CLIENT_JS = `
${FLEET_ROW_SELECTION_JS}
${CLIENT_JS_BODY}`;

export function layout(title: string, content: string, updateNotice?: { current: string; latest: string } | null): string {
  return renderLayout(title, content, {
    brand: "Cloudflare IP Access",
    base: BASE,
    nav: [],
    css: STYLE,
    script: CLIENT_JS,
    updateNotice,
  });
}

export function dashboardView(state: CloudflareState): string {
  const enabled = state.sites.filter((site) => site.enabled).length;
  const total = state.sites.length;
  const summary = `${enabled} of ${plural(total, "site")} allow Cloudflare only`;
  const rows = state.sites.map((site) => `
    <tr data-domain="${esc(site.domain)}" data-enabled="${site.enabled}" data-show="${site.enabled ? "on" : "off"}" tabindex="0" aria-selected="false" onclick="toggleSiteSelection(event, this)" onkeydown="toggleSiteSelection(event, this)">
      <td class="site-select"><input class="site-checkbox" type="checkbox" onchange="paintFleetSelection()" aria-label="Select ${esc(site.domain)}"></td>
      <td class="site-cell"><span class="site-name">${esc(site.domain)}</span></td>
      <td class="action-cell" data-label="Cloudflare only">
        <label class="switch"><input class="site-switch" id="cf-switch-${esc(site.domain)}" type="checkbox" aria-label="Cloudflare-only access for ${esc(site.domain)}" ${site.enabled ? "checked" : ""} onchange="setOne(this)"><span></span></label>
      </td>
    </tr>`).join("");

  return `
    <div class="page-heading">
      <div><h1>Cloudflare IP Access</h1><p>Control CloudPanel's “Allow traffic from Cloudflare only” setting for every site.</p></div>
    </div>
    <div class="card card-table">
      ${total === 0
        ? '<div class="empty">No sites found in CloudPanel.</div>'
        : `<div class="card-header toolbar">
            <div><h2>Sites</h2><p class="hint" id="cf-summary">${esc(summary)}</p></div>
            <span class="toolbar-note" id="site-selection">No sites selected</span>
            <button class="btn mobile-select-all" id="select-all-btn" type="button" onclick="toggleAllSites()">Select all</button>
            <div class="actions toolbar-actions">
              <button class="btn" id="enable-selected" type="button" disabled data-needs-selection onclick="setSelectedSites(true)">Enable selected</button>
              <button class="btn" id="disable-selected" type="button" disabled data-needs-selection onclick="setSelectedSites(false)">Disable selected</button>
            </div>
          </div>
          ${fleetFilterHtml({ count: total, filters: [{ value: "off", label: "Off" }], summary: plural(total, "site") })}
          <table class="fleet-table cloudflare-site-table">
            <thead><tr>
              <th scope="col" class="site-select"><input id="select-all" type="checkbox" onchange="selectAllSites(this.checked)" aria-label="Select all sites"></th>
              <th scope="col">Site</th><th scope="col" class="action-cell">Cloudflare only</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
          ${FLEET_NONE_HTML}`}
    </div>
    <div class="card split-card cf-policy">
      <div><h2>Enable on new sites</h2>
        <p class="hint">A site created from now on allows Cloudflare only, seconds after CloudPanel creates it. A site you turn off here is never turned back on.</p></div>
      <label class="switch"><input id="automatic-policy" type="checkbox" aria-label="Enable Cloudflare-only access on new sites" ${state.autoEnableNewSites ? "checked" : ""} onchange="setAutomatic(this)"><span></span></label>
    </div>`;
}

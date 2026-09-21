import CLIENT_JS_BODY from "./views.client.js" with { type: "text" };
import { esc } from "../../../lib/app-http";
import { FLEET_ROW_SELECTION_JS, fleetRowSelectionStyle, renderLayout } from "../../../lib/app-ui";
import { mountPath } from "../../../lib/mount";
import { siteTypeLabel } from "../../../lib/site-context";
import type { CloudflareState } from "./service";

const BASE = mountPath("cloudflare-ips");

// Switches, the toolbar, the confirmation dialog and the inline notice come
// from lib/app-ui so this addon looks like the rest of the manager.
const STYLE = `
.fleet-card, .policy-card { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; }
.fleet-card h2, .policy-card h2 { margin: 0 0 8px; }
.fleet-card p, .policy-card p { margin: 0; }
.fleet-card .actions { flex-shrink: 0; }
.toolbar-actions { margin-left: auto; }
${fleetRowSelectionStyle("cloudflare-site-table")}
.cloudflare-site-table .mobile-site-type { display: none; }
@media (max-width: 700px) {
  .fleet-card, .policy-card { flex-direction: column; }
}
@media (max-width: 760px) {
  .toolbar-actions { flex: 1 1 100%; margin-left: 0; }
  .toolbar-actions .btn { flex: 1 1 calc(50% - 6px); padding-right:10px; padding-left:10px; white-space:nowrap; }
}
/* Where the shared fleet table becomes a card, this row keeps the domain and
   its action on one line instead. */
@media (max-width: 940px) {
  .cloudflare-site-table tbody tr { flex-wrap: nowrap; align-items: center; padding: 10px 20px; }
  .fleet-table.cloudflare-site-table td.site-select { display: none; }
  .cloudflare-site-table td.site-cell { display: flex; align-items: center; flex: 1 1 auto; min-width: 0; }
  .cloudflare-site-table td.action-cell { width: auto; flex: 0 0 auto; margin-left: auto; display: flex; align-items: center; justify-content: flex-end; }
  .cloudflare-site-table td.action-cell::before { display: none; }
  .cloudflare-site-table td.type-cell { display: none; }
  .cloudflare-site-table .site-copy { display: flex; flex-direction: column; align-items: flex-start; gap: 1px; width: 100%; min-width: 0; }
  .cloudflare-site-table .site-name { display: block; overflow-wrap: anywhere; }
  .cloudflare-site-table .mobile-site-type { display: block;
    padding: 1px 4px; border: 1px solid var(--border); border-radius: 3px; color: var(--muted);
    font-size: 10px; font-weight: 400; line-height: 1.1; white-space: nowrap; }
}
`;

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
  const rows = state.sites.map((site) => `
    <tr data-domain="${esc(site.domain)}" data-enabled="${site.enabled}" data-excluded="${site.excludedFromAutomatic}" tabindex="0" aria-selected="false" onclick="toggleSiteSelection(event, this, paintSummary)" onkeydown="toggleSiteSelection(event, this, paintSummary)">
      <td class="site-select"><input class="site-checkbox" type="checkbox" onchange="paintSummary()" aria-label="Select ${esc(site.domain)}"></td>
      <td class="site-cell"><span class="site-copy"><span class="mobile-site-type">${esc(siteTypeLabel(site.type))}</span><span class="site-name">${esc(site.domain)}</span></span></td>
      <td class="type-cell">${esc(siteTypeLabel(site.type))}</td>
      <td class="action-cell" data-label="Cloudflare only">
        <label class="switch"><input class="site-switch" type="checkbox" aria-label="Cloudflare-only access for ${esc(site.domain)}" ${site.enabled ? "checked" : ""} onchange="setOne(this)"><span></span></label>
      </td>
    </tr>`).join("");

  return `
    <div class="page-heading">
      <div><h1>Cloudflare IP access</h1><p>Control CloudPanel's “Allow traffic from Cloudflare only” setting for every site.</p></div>
    </div>
    <div class="card fleet-card">
      <div>
        <h2>All sites</h2>
        <p id="cf-summary">${total === 0 ? "No sites found in CloudPanel." : `${enabled} of ${total} ${total === 1 ? "site" : "sites"} allow Cloudflare only.`}</p>
        <p class="hint">A one-time change to the sites that exist now.</p>
      </div>
      <div class="actions">
        <button class="btn btn-primary" id="enable-all" type="button" ${total === 0 ? "disabled" : ""} onclick="setAllSites(true)">Enable all sites</button>
        <button class="btn" id="disable-all" type="button" ${total === 0 ? "disabled" : ""} onclick="setAllSites(false)">Disable all sites</button>
      </div>
    </div>
    <div class="card policy-card">
      <div>
        <h2>Enable on new sites</h2>
        <p>Apply the setting automatically within about one minute after a site is created.</p>
      </div>
      <label class="switch"><input id="automatic-policy" type="checkbox" aria-label="Enable Cloudflare-only access on new sites" ${state.autoEnableNewSites ? "checked" : ""} onchange="setAutomatic(this)"><span></span></label>
    </div>
    <div class="card card-table">
      ${total === 0
        ? '<div class="empty">No sites found in CloudPanel.</div>'
        : `<div class="card-header toolbar">
            <h2>Sites</h2>
            <span class="toolbar-note" id="cf-selection">No sites selected</span>
            <button class="btn mobile-select-all" id="select-all-btn" type="button" onclick="toggleAllSites()">Select all</button>
            <div class="actions toolbar-actions">
              <button class="btn" id="enable-selected" type="button" disabled onclick="setSelectedSites(true)">Enable selected</button>
              <button class="btn" id="disable-selected" type="button" disabled onclick="setSelectedSites(false)">Disable selected</button>
            </div>
          </div>
          <table class="fleet-table cloudflare-site-table">
            <thead><tr>
              <th scope="col" class="site-select"><input id="select-all" type="checkbox" onchange="selectAllSites(this.checked)" aria-label="Select all sites"></th>
              <th scope="col">Site</th><th scope="col">Type</th><th scope="col" class="action-cell">Cloudflare only</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>`}
    </div>`;
}

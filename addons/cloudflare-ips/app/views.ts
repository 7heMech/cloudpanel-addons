import CLIENT_JS_BODY from "./views.client.js" with { type: "text" };
import { esc } from "../../../lib/app-http";
import { FLEET_ROW_SELECTION_JS, TWEAK_ROW_JS, TWEAK_ROW_STYLE, fleetRowSelectionStyle, renderLayout } from "../../../lib/app-ui";
import { mountPath } from "../../../lib/mount";
import { siteTypeLabel } from "../../../lib/site-context";
import type { CloudflareState } from "./service";

const BASE = mountPath("cloudflare-ips");

// Switches, the toolbar, the confirmation dialog and the inline notice come
// from lib/app-ui so this addon looks like the rest of the manager.
import VIEWS_CSS from "./views.css" with { type: "text" };

const STYLE = VIEWS_CSS
  .split("/* fleet-row-selection */").join(fleetRowSelectionStyle("cloudflare-site-table"));

export const CLIENT_JS = `
${FLEET_ROW_SELECTION_JS}
${TWEAK_ROW_JS}
${CLIENT_JS_BODY}`;

export function layout(title: string, content: string, updateNotice?: { current: string; latest: string } | null): string {
  return renderLayout(title, content, {
    brand: "Cloudflare IP Access",
    base: BASE,
    nav: [],
    css: TWEAK_ROW_STYLE + STYLE,
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
      <div><h1>Cloudflare IP Access</h1><p>Control CloudPanel's “Allow traffic from Cloudflare only” setting for every site.</p></div>
    </div>
    <div class="card">
      <div class="tweak-row cf-protection-row"><div class="tweak-body">
        <div class="tweak-heading">
          <h3>Mitigate Cloudflare-only bypass<button class="tweak-more" type="button" aria-expanded="false"
            aria-controls="cf-protection-note" aria-label="About Cloudflare-only bypass protection" onclick="toggleNote(this)"></button></h3>
          <label class="switch"><input id="bypass-protection" type="checkbox" aria-label="Mitigate Cloudflare-only bypass"
            ${state.protection.wanted ? "checked" : ""} onchange="setProtection(this)"><span></span></label>
        </div>
        <p class="cf-protection-scope">Applies only to sites with “Cloudflare only” enabled. Sites with it off are not restricted by this protection.</p>
        <div class="tweak-note" id="cf-protection-note"><p>On by default. Checks the actual connection address so forged IP headers cannot bypass Cloudflare-only access. Cloudflare must connect directly to this server; an intermediate proxy or tunnel will be blocked. Direct certificate validation requests are also blocked; use validation through Cloudflare or DNS.</p></div>
        <p class="cf-protection-status" id="cf-protection-status">${state.protection.configured ? "Protection configured." : state.protection.wanted ? "Protection needs repair." : "Bypass protection is off."}</p>
        <p class="cf-protection-problem" id="cf-protection-problem"${state.protection.problem ? "" : " hidden"}>${esc(state.protection.problem)}</p>
      </div></div>
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
            <button class="btn mobile-select-all" id="select-all-btn" type="button" onclick="toggleAllSites(paintSummary)">Select all</button>
            <div class="actions toolbar-actions">
              <button class="btn" id="enable-selected" type="button" disabled onclick="setSelectedSites(true)">Enable selected</button>
              <button class="btn" id="disable-selected" type="button" disabled onclick="setSelectedSites(false)">Disable selected</button>
            </div>
          </div>
          <table class="fleet-table cloudflare-site-table">
            <thead><tr>
              <th scope="col" class="site-select"><input id="select-all" type="checkbox" onchange="selectAllSites(this.checked, paintSummary)" aria-label="Select all sites"></th>
              <th scope="col">Site</th><th scope="col">Type</th><th scope="col" class="action-cell">Cloudflare only</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>`}
    </div>`;
}

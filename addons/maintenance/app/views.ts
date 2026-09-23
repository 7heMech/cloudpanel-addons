import { esc, escJs } from "../../../lib/app-http";
import { renderFragment, renderLayout } from "../../../lib/app-ui";
import type { EmbedFragment } from "../../../lib/shadow-embed";
import { mountPath } from "../../../lib/mount";
import { siteTypeLabel, type SiteContext } from "../../../lib/site-context";
import type { MaintenanceSiteView, MaintenanceTemplateView } from "./service";
import type { GlobalMaintenanceStatus } from "../action";

const BASE = mountPath("maintenance");

// Switches, toolbars, the confirmation dialog and the inline notice are in
// lib/app-ui; only what this addon alone draws is here.
import STYLE from "./views.css" with { type: "text" };

import CLIENT_JS from "./views.client.js" with { type: "text" };
export { CLIENT_JS };

export function layout(
  title: string,
  content: string,
  updateNotice?: { current: string; latest: string } | null,
  site?: SiteContext,
): string {
  return renderLayout(title, content, {
    brand: "Maintenance Mode",
    base: BASE,
    // No tab strip: this addon has one page of its own, so the strip could only
    // hold a tab for the page already being read. A site-scoped page draws
    // CloudPanel's own site tabs, which come from the site context below.
    nav: [],
    css: STYLE,
    script: CLIENT_JS,
    updateNotice,
    ...(site ? { site: { ...site, activeSlug: "maintenance" } } : {}),
  });
}

/**
 * The same page as `layout`, as a fragment for mounting inside CloudPanel's own
 * site page. No site context: the panel is already drawing it.
 */
export function fragment(title: string, content: string): EmbedFragment {
  return renderFragment(title, content, {
    brand: "Maintenance Mode",
    base: BASE,
    nav: [],
    css: STYLE,
    script: CLIENT_JS,
  });
}

function statusBadge(site: MaintenanceSiteView, globalEnabled = false): string {
  // A site whose saved setting could not be read is still behind the global
  // override, which Nginx serves from one file for every site. Unavailable is
  // what is unknown about the site, not what its visitors are getting.
  if (site.error && !globalEnabled) {
    return `<span class="badge state-unavailable" data-status-domain="${esc(site.domain)}">Unavailable</span>`;
  }
  if (site.enabled && !site.error) {
    return `<span class="badge state-maintenance" data-status-domain="${esc(site.domain)}">Maintenance Mode (503)</span>`;
  }
  if (globalEnabled) {
    return `<span class="badge state-maintenance" data-status-domain="${esc(site.domain)}">Maintenance (Global)</span>`;
  }
  return `<span class="badge state-live" data-status-domain="${esc(site.domain)}">Live</span>`;
}

/**
 * The global override, in a card of its own.
 *
 * It sat in the sites table header labelled "All sites", where it read as a
 * bulk edit of the switches below it. It is not one: it decides what visitors
 * get while every site keeps the setting it has saved.
 */
function globalCard(globalEnabled: boolean, disabled: boolean, bypasses: string[], currentIp: string): string {
  return `<div class="card" data-global-maintenance="${globalEnabled}"><div class="global-card">
    <div>
      <h2>Global maintenance</h2>
      <p>Serve the maintenance page for every site at once, whatever each site has saved.</p>
      <p class="hint">Saved per-site settings are left alone. Turning this off returns each site to its own setting.</p>
    </div>
    <label class="switch-field" for="global-toggle"><span class="switch-state" id="global-state">${globalEnabled ? "On" : "Off"}</span>
      <span class="switch switch-danger"><input type="checkbox" id="global-toggle" ${globalEnabled ? "checked" : ""} ${disabled ? "disabled" : ""} onchange="toggleGlobalMaintenance(this.checked)"><span></span></span>
    </label>
  </div>
  </div></div>
  ${bypassCard("global-bypass-ips", "Global IP bypasses", "These addresses skip maintenance on every site, including sites with their own setting on.", bypasses, currentIp, "saveGlobalBypasses()")}`;
}

function bypassCard(id: string, title: string, scope: string, bypasses: string[], currentIp: string, save: string): string {
  return `<div class="card bypass-card">
    <div class="bypass-intro"><h2>${title}</h2><p class="hint">${scope}</p><p class="hint">One IPv4 or IPv6 visitor address per line. For Cloudflare sites, enter the visitor IP.</p></div>
    <textarea id="${id}" class="bypass-list" aria-label="${title}" spellcheck="false" rows="${Math.min(Math.max(bypasses.length + 1, 4), 8)}" oninput="syncBypassSave(this)">${esc(bypasses.join("\n"))}</textarea>
    <div class="bypass-actions">${currentIp ? `<button class="btn" type="button" onclick="addCurrentIp('${id}', '${escJs(currentIp)}')">Add my IP (${esc(currentIp)})</button>` : ""}<button class="btn btn-primary" type="button" data-bypass-save="${id}" disabled onclick="${save}">Save bypasses</button></div>
  </div>`;
}

export function fleetView(sites: MaintenanceSiteView[], globalState: boolean | GlobalMaintenanceStatus = false, currentIp = ""): string {
  const globalEnabled = typeof globalState === "boolean" ? globalState : globalState.global;
  const globalBypasses = typeof globalState === "boolean" ? [] : globalState.bypasses;
  const available = sites.filter((site) => !site.error);
  const siteMaintenanceCount = available.filter((site) => site.enabled).length;
  // The override covers the fleet, including the sites this page could not read.
  const inMaintenanceCount = globalEnabled ? sites.length : siteMaintenanceCount;
  const liveCount = globalEnabled ? 0 : available.length - siteMaintenanceCount;
  const rows = sites.map((site) => `<tr>
    <td class="site-cell"><a href="${BASE}?domain=${encodeURIComponent(site.domain)}">${esc(site.domain)}</a>${site.error ? `<div class="hint">${esc(site.error)}</div>` : ""}</td>
    <td class="type-cell">${esc(siteTypeLabel(site.type))}</td>
    <td data-label="Effective status">${statusBadge(site, globalEnabled)}</td>
    <td class="page-cell" data-label="Page">${site.customTemplate ? "Custom" : "Default"}</td>
    <td class="bypass-cell" data-label="Bypasses">${site.bypasses.length}</td>
    <td class="action-cell" data-label="Site setting"><label class="switch switch-danger"><input type="checkbox" data-toggle-domain="${esc(site.domain)}" data-available="${!site.error}" aria-label="Maintenance mode for ${esc(site.domain)}" ${site.enabled ? "checked" : ""} ${site.error ? "disabled" : ""} onchange="toggleMaintenance('${escJs(site.domain)}', this.checked)"><span></span></label></td>
  </tr>`).join("");
  return `<div class="page-heading" data-global-maintenance="${globalEnabled}"><div><h1>Maintenance Mode</h1><p>Switch sites to a 503 maintenance page without reloading Nginx.</p></div></div>
  <div class="card stats">
    <div class="stat"><div class="label">CloudPanel sites</div><div class="value">${sites.length}</div></div>
    <div class="stat"><div class="label">In maintenance</div><div class="value">${inMaintenanceCount}</div></div>
    <div class="stat"><div class="label">Live</div><div class="value">${liveCount}</div></div>
  </div>
  ${globalCard(globalEnabled, sites.length === 0, globalBypasses, currentIp)}
  <div class="card card-table"><div class="card-header"><h2>Sites</h2></div>
  ${sites.length ? `<table class="fleet-table maintenance-fleet-table"><thead><tr><th scope="col">Site</th><th scope="col">Type</th><th scope="col">Effective status</th><th scope="col">Page</th><th scope="col">Bypasses</th><th scope="col" class="action-cell">Site setting</th></tr></thead><tbody data-global-maintenance="${globalEnabled}">${rows}</tbody></table>` : '<div class="empty">No CloudPanel sites were found.</div>'}
  </div>`;
}

export function siteView(
  site: MaintenanceSiteView,
  template: MaintenanceTemplateView,
  currentIp: string,
  globalEnabled = false,
): string {
  const globalNotice = `<div id="global-notice" class="notice"${globalEnabled && !site.enabled ? "" : " hidden"}>Global maintenance is on, so this site serves the maintenance page even though its own setting below is off. Turning the setting below off does not take this site out of global maintenance.</div>`;
  return `<div class="page-heading site-heading" data-global-maintenance="${globalEnabled}"><div class="site-header-main"><div class="site-title-row"><h1>${esc(site.domain)}</h1>${statusBadge(site, globalEnabled)}</div><p class="site-desc">Maintenance mode applies to HTTP and HTTPS traffic for this site.</p></div><div class="actions"><a class="btn" href="${BASE}/">All maintenance sites</a></div></div>
  ${globalNotice}
  <div class="card"><div class="switch-row"><div><h2>Maintenance response</h2><p class="hint">Visitors receive HTTP 503 with a five-minute Retry-After header. ACME certificate challenges and bypassed IPs remain live.</p></div>
    <label class="switch switch-danger"><input type="checkbox" data-toggle-domain="${esc(site.domain)}" data-available="true" aria-label="Maintenance mode for ${esc(site.domain)}" ${site.enabled ? "checked" : ""} onchange="toggleMaintenance('${escJs(site.domain)}', this.checked)"><span></span></label>
  </div></div>
  ${bypassCard("bypass-ips", "IP bypasses", "These addresses skip maintenance on this site, as do the global bypasses on the overview.", site.bypasses, currentIp, `saveBypasses('${escJs(site.domain)}')`)}
  <div class="card"><div class="card-header"><div><h2>Maintenance page</h2><p class="hint">Custom HTML and CSS are stored for this site. Active scripts and form controls are removed.</p></div></div>
    <div class="toolbar editor-toolbar">
      <div class="editor-tabs" role="tablist"><button class="btn" type="button" data-editor-tab="editor" aria-selected="true" onclick="showEditorTab('editor')">HTML / CSS</button><button class="btn" type="button" data-editor-tab="preview" aria-selected="false" onclick="showEditorTab('preview')">Preview</button></div>
      <label class="switch-field toolbar-end" for="edit-template">Edit<span class="switch"><input id="edit-template" type="checkbox" onchange="changeTemplateMode('${escJs(site.domain)}', this.checked)"><span></span></span></label>
    </div>
    <textarea id="template-editor" aria-label="Maintenance page HTML" spellcheck="false">${esc(template.html)}</textarea>
    <div id="template-ace" hidden></div>
    <iframe id="template-preview" title="Maintenance page preview" sandbox hidden></iframe>
    <div class="form-actions"><button class="btn btn-danger" type="button" onclick="resetTemplate('${escJs(site.domain)}', false)">Reset to default</button><button class="btn btn-primary" id="save-template" type="button" onclick="saveTemplate('${escJs(site.domain)}')">Save template</button></div>
  </div>`;
}

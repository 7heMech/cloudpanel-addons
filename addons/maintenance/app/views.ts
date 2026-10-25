import { esc, escJs } from "../../../lib/app-http";
import {
  FLEET_NONE_HTML, FLEET_ROW_SELECTION_JS, fleetFilterHtml, fleetRowSelectionStyle, renderFragment, renderLayout,
} from "../../../lib/app-ui";
import type { EmbedFragment } from "../../../lib/shadow-embed";
import { mountPath } from "../../../lib/mount";
import { siteTypeLabel, type SiteContext } from "../../../lib/site-context";
import type { MaintenanceFleet, MaintenanceSiteView, MaintenanceTemplateView } from "./service";

const BASE = mountPath("maintenance");

// Switches, toolbars, the confirmation dialog and the inline notice are in
// lib/app-ui; only what this addon alone draws is here.
import CSS from "./views.css" with { type: "text" };

import CLIENT_BODY from "./views.client.js" with { type: "text" };

const STYLE = CSS + fleetRowSelectionStyle("maintenance-fleet-table");
export const CLIENT_JS = `${FLEET_ROW_SELECTION_JS}\n${CLIENT_BODY}`;

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

function plural(count: number, word: string, many = `${word}s`): string {
  return `${count} ${count === 1 ? word : many}`;
}

/** Whether visitors to the site get the maintenance page right now. */
function serving(site: MaintenanceSiteView, globalEnabled: boolean): boolean {
  return !site.uncovered && ((site.enabled && !site.error) || globalEnabled);
}

function statusBadge(site: MaintenanceSiteView, globalEnabled = false): string {
  const attrs = `data-status-domain="${esc(site.domain)}"`;
  // A setting Nginx does not act on is not what visitors get, so it is not
  // drawn as if it were.
  if (site.uncovered && (site.enabled || globalEnabled)) {
    return `<span class="badge state-uncovered" ${attrs} title="${esc(site.uncovered)}">Not covered</span>`;
  }
  // A site whose saved setting could not be read is still behind the global
  // override, which Nginx serves from one file for every site. Unavailable is
  // what is unknown about the site, not what its visitors are getting.
  if (site.error && !globalEnabled) return `<span class="badge state-unavailable" ${attrs}>Unavailable</span>`;
  if (site.enabled && !site.error) return `<span class="badge state-maintenance" ${attrs}>Maintenance Mode (503)</span>`;
  if (globalEnabled) return `<span class="badge state-maintenance" ${attrs}>Maintenance (Global)</span>`;
  return `<span class="badge state-live" ${attrs}>Live</span>`;
}

function uncoveredText(reason: string): string {
  return `Not covered: ${reason}.`;
}

function bypassFields(id: string, scope: string, bypasses: string[], currentIp: string, save: string): string {
  return `<p class="hint">${scope} One visitor IP per line.</p>
    <textarea id="${id}" class="bypass-list" aria-label="IP bypasses" spellcheck="false" rows="${Math.min(Math.max(bypasses.length + 1, 3), 8)}" oninput="syncBypassSave(this)">${esc(bypasses.join("\n"))}</textarea>
    <div class="form-actions">${currentIp ? `<button class="btn" type="button" onclick="addCurrentIp('${id}', '${escJs(currentIp)}')">Add my IP (${esc(currentIp)})</button>` : ""}<button class="btn btn-primary" type="button" data-bypass-save="${id}" disabled onclick="${save}">Save bypasses</button></div>`;
}

function bypassSummary(id: string, title: string, count: string): string {
  return `<summary><span><span class="summary-title">${title}</span><span class="hint" id="${id}-count">${count}</span></span></summary>`;
}

/**
 * The global override: one switch that decides what visitors get for every
 * site at once while each site keeps the setting it has saved.
 */
function globalCard(globalEnabled: boolean, disabled: boolean, bypasses: string[], currentIp: string): string {
  return `<div class="card">
    <div class="split-card">
      <div>
        <h2>Global maintenance</h2>
        <p class="hint">Serve the maintenance page for every site at once. Each site keeps its own setting and goes back to it when this is off.</p>
      </div>
      <label class="switch-field" for="global-toggle"><span class="switch-state">${globalEnabled ? "On" : "Off"}</span>
        <span class="switch switch-danger"><input type="checkbox" id="global-toggle" ${globalEnabled ? "checked" : ""} ${disabled ? "disabled" : ""} onchange="toggleGlobalMaintenance(this.checked)"><span></span></span>
      </label>
    </div>
    <details class="disclosure bypass-disclosure" id="global-bypasses">
      ${bypassSummary("global-bypass-ips", "Global IP bypasses", bypasses.length ? plural(bypasses.length, "address", "addresses") : "None")}
      ${bypassFields("global-bypass-ips", "These skip maintenance on every site.", bypasses, currentIp, "saveGlobalBypasses()")}
    </details>
  </div>`;
}

function siteRow(site: MaintenanceSiteView, globalEnabled: boolean): string {
  const notes = [site.customTemplate ? "Custom page" : "", site.bypasses.length ? plural(site.bypasses.length, "bypass", "bypasses") : ""]
    .filter(Boolean).join(" · ");
  const show = [serving(site, globalEnabled) ? "maintenance" : "live", site.uncovered ? "uncovered" : ""].filter(Boolean).join(" ");
  const domain = esc(site.domain);
  return `<tr data-domain="${domain}" data-show="${show}" tabindex="0" aria-selected="false" onclick="toggleSiteSelection(event, this)" onkeydown="toggleSiteSelection(event, this)">
    <td class="site-select"><input class="site-checkbox" type="checkbox" onchange="paintFleetSelection()" aria-label="Select ${domain}"${site.error ? " disabled" : ""}></td>
    <td class="site-cell"><a href="${BASE}?domain=${encodeURIComponent(site.domain)}">${domain}</a>${notes ? `<div class="hint">${esc(notes)}</div>` : ""}${site.error ? `<div class="hint">${esc(site.error)}</div>` : ""}${site.uncovered ? `<div class="hint">${esc(uncoveredText(site.uncovered))}</div>` : ""}</td>
    <td class="type-cell">${esc(siteTypeLabel(site.type))}</td>
    <td data-label="Effective status">${statusBadge(site, globalEnabled)}</td>
    <td class="action-cell" data-label="Site setting"><label class="switch switch-danger"><input type="checkbox" data-toggle-domain="${domain}" aria-label="Maintenance mode for ${domain}" ${site.enabled ? "checked" : ""} ${site.error ? "disabled" : ""} onchange="toggleMaintenance('${escJs(site.domain)}', this.checked)"><span></span></label></td>
  </tr>`;
}

export function fleetView(fleet: MaintenanceFleet, currentIp = ""): string {
  const { sites } = fleet;
  const globalEnabled = fleet.global.global;
  const inMaintenance = sites.filter((site) => serving(site, globalEnabled)).length;
  const uncovered = sites.filter((site) => site.uncovered).length;
  const banner = globalEnabled
    ? `<div class="notice" role="status">Global maintenance is on: every site serves the maintenance page${uncovered ? `, except the ${plural(uncovered, "site")} Nginx does not cover` : ""}.</div>`
    : "";
  const filters = [
    { value: "maintenance", label: "In maintenance" },
    { value: "live", label: "Live" },
    ...(uncovered ? [{ value: "uncovered", label: "Not covered" }] : []),
  ];
  const table = sites.length
    ? `${fleetFilterHtml({ count: sites.length, filters, summary: plural(sites.length, "site") })}
      <table class="fleet-table maintenance-fleet-table"><thead><tr>
        <th scope="col" class="site-select"><input id="select-all" type="checkbox" onchange="selectAllSites(this.checked)" aria-label="Select all sites"></th>
        <th scope="col">Site</th><th scope="col">Type</th><th scope="col">Effective status</th><th scope="col" class="action-cell">Site setting</th>
      </tr></thead><tbody>${sites.map((site) => siteRow(site, globalEnabled)).join("")}</tbody></table>
      ${FLEET_NONE_HTML}`
    : '<div class="empty">No CloudPanel sites were found.</div>';
  return `<div class="page-heading" id="maintenance-fleet"><div><h1>Maintenance Mode</h1><p>Switch sites to a 503 maintenance page without reloading Nginx.</p></div></div>
  ${banner}
  <div class="card card-table">
    <div class="card-header toolbar">
      <div><h2>Sites</h2><div class="hint">${inMaintenance} of ${sites.length} in maintenance</div></div>
      ${sites.length ? `<span class="toolbar-note" id="site-selection">No sites selected</span>
      <button class="btn mobile-select-all" id="select-all-btn" type="button" onclick="toggleAllSites()">Select all</button>
      <div class="toolbar-end actions bulk-actions">
        <button class="btn" type="button" data-needs-selection disabled onclick="toggleSelected(true)">Turn on selected</button>
        <button class="btn" type="button" data-needs-selection disabled onclick="toggleSelected(false)">Turn off selected</button>
      </div>` : ""}
    </div>
    ${table}
  </div>
  ${globalCard(globalEnabled, sites.length === 0, fleet.global.bypasses, currentIp)}`;
}

export function siteView(
  site: MaintenanceSiteView,
  template: MaintenanceTemplateView,
  currentIp: string,
  globalEnabled = false,
): string {
  const domain = escJs(site.domain);
  const globalNotice = `<div id="global-notice" class="notice"${globalEnabled && !site.enabled && !site.uncovered ? "" : " hidden"}>Global maintenance is on, so this site serves the maintenance page even though its own setting is off. Turning the setting off does not take this site out of global maintenance.</div>`;
  const coverage = site.uncovered
    ? `<div class="notice" id="coverage-notice">Nginx does not run the maintenance check for this site because ${esc(site.uncovered)}, so visitors get the site whatever is set here.</div>`
    : "";
  return `<div class="page-heading" data-global-maintenance="${globalEnabled}" data-uncovered="${site.uncovered ? "true" : "false"}">
    <div><h1>Maintenance Mode</h1><p>Visitors get HTTP 503 with a five-minute Retry-After. Certificate challenges and bypassed IPs stay live.</p></div>
    <div class="heading-controls">${statusBadge(site, globalEnabled)}
      <label class="switch switch-danger"><input type="checkbox" data-toggle-domain="${esc(site.domain)}" aria-label="Maintenance mode for ${esc(site.domain)}" ${site.enabled ? "checked" : ""} onchange="toggleMaintenance('${domain}', this.checked)"><span></span></label>
      <a class="btn" href="${BASE}/">All sites</a>
    </div>
  </div>
  ${coverage}
  ${globalNotice}
  <div class="card">
    <details class="disclosure" id="site-bypasses">
      ${bypassSummary("bypass-ips", "IP bypasses", site.bypasses.length ? plural(site.bypasses.length, "bypass", "bypasses") : "None")}
      ${bypassFields("bypass-ips", "These skip maintenance on this site, as do the global bypasses.", site.bypasses, currentIp, `saveBypasses('${domain}')`)}
    </details>
    <details class="disclosure" id="site-page">
      <summary><span><span class="summary-title">Maintenance page</span><span class="hint" id="template-kind">${template.custom ? "Custom" : "Default"}</span></span></summary>
      <p class="hint">Custom HTML and CSS are stored for this site. Active scripts and form controls are removed.</p>
      <div class="toolbar editor-toolbar">
        <div class="editor-tabs" role="tablist" hidden><button class="btn" type="button" data-editor-tab="editor" aria-selected="false" onclick="showEditorTab('editor')">HTML / CSS</button><button class="btn" type="button" data-editor-tab="preview" aria-selected="true" onclick="showEditorTab('preview')">Preview</button></div>
        <label class="switch-field toolbar-end" for="edit-template">Edit<span class="switch"><input id="edit-template" type="checkbox" onchange="changeTemplateMode('${domain}', this.checked)"><span></span></span></label>
      </div>
      <textarea id="template-editor" aria-label="Maintenance page HTML" spellcheck="false" hidden>${esc(template.html)}</textarea>
      <div id="template-ace" hidden></div>
      <iframe id="template-preview" title="Maintenance page preview" sandbox></iframe>
      <div class="form-actions"><button class="btn btn-danger" id="reset-template" type="button" onclick="resetTemplate('${domain}')"${template.custom ? "" : " hidden"}>Reset to default</button><button class="btn btn-primary" id="save-template" type="button" onclick="saveTemplate('${domain}')">Save template</button></div>
    </details>
  </div>`;
}

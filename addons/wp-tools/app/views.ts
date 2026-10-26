import { esc } from "../../../lib/app-http";
import { FLEET_NONE_HTML, FLEET_ROW_SELECTION_JS, fleetFilterHtml, renderLayout } from "../../../lib/app-ui";
import { mountPath } from "../../../lib/mount";
import type { WpSiteView } from "../action";
import type { VarnishPluginStatus, WpVarnishState } from "../varnish";
import type { MainwpStatus, MainwpView } from "../mainwp";
import type { WpDashboard } from "./service";

const BASE = mountPath("wp-tools");

// The cards, the buttons and the narrow-screen table layout are in lib/app-ui.
import STYLE from "./views.css" with { type: "text" };

import SCRIPT from "./views.client.js" with { type: "text" };

export function layout(
  title: string,
  content: string,
  updateNotice?: { current: string; latest: string } | null,
): string {
  return renderLayout(title, content, {
    brand: "WordPress Tools",
    base: BASE,
    nav: [],
    css: STYLE,
    script: `${FLEET_ROW_SELECTION_JS}\n${SCRIPT}`,
    updateNotice,
  });
}

const PLUGIN_STATUS: Record<VarnishPluginStatus, [label: string, tone: string]> = {
  active: ["Active", "state-done"],
  inactive: ["Inactive", "state-paused"],
  missing: ["Not installed", ""],
  unsupported: ["Multisite, skipped", ""],
  error: ["Check failed", "state-failed"],
};

const MAINWP_STATUS: Record<MainwpStatus, [label: string, tone: string]> = {
  missing: ["Not installed", ""],
  inactive: ["Installed, inactive", ""],
  "waiting-https": ["Waiting for HTTPS", "state-paused"],
  "not-connected": ["Not connected", "state-paused"],
  connected: ["Connected", "state-done"],
  unsupported: ["Multisite, skipped", ""],
  error: ["Check failed", "state-failed"],
};

function checkedTitle(checkedAt: string): string {
  const checked = checkedAt.replace("T", " ").slice(0, 16);
  return checked ? ` title="Checked ${esc(checked)} UTC"` : "";
}

/** A per-site Automatic switch, drawn only while that automation is on. */
function siteSwitch(id: string, label: string, domain: string, included: boolean, handler: string): string {
  return `<div class="wp-auto"><label class="switch"><input id="${id}" type="checkbox" data-domain="${domain}" aria-label="${label} ${domain}" ${included ? "checked" : ""} onchange="${handler}(this)"><span></span></label><label for="${id}">Automatic</label></div>`;
}

function varnishCell(site: WpSiteView, varnish: WpVarnishState, available: boolean): string {
  if (!available) return '<span class="toolbar-note">Unavailable</span>';
  if (!site.varnishCache) return '<span class="hint" title="Varnish Cache is off for this site in CloudPanel, so the plugin has nothing to purge">Varnish off</span>';
  const domain = esc(site.domain);
  const record = site.varnishPlugin;
  const [label, tone] = !record ? ["Not checked", ""]
    : record.status === "missing" && record.seen ? ["Removed", ""] : PLUGIN_STATUS[record.status];
  const status = record?.status;
  // The backend installs if missing and activates.
  const action = site.varnishExcluded || status === "active" || status === "unsupported" ? ""
    : `<button class="btn" type="button" data-domain="${domain}" onclick="installPlugin(this)">${
      status === "inactive" ? "Activate" : status === "error" ? "Retry" : "Install"}</button>`;
  const automatic = varnish.enabled
    ? siteSwitch(`varnish-auto-${domain}`, "Install CLP Varnish Cache automatically on", domain, !site.varnishExcluded, "setSiteAutomatic")
    : "";
  return `<div class="wp-status"><span class="badge ${tone}"${record ? checkedTitle(record.checkedAt) : ""}>${label}</span>${action}</div>${
    record?.error ? `<div class="wp-error">${esc(record.error)}</div>` : ""}${automatic}`;
}

function mainwpCell(site: WpSiteView, state: MainwpView): string {
  if (site.domain === state.dashboard) return '<div class="wp-status"><span class="badge state-done">Dashboard</span></div>';
  const domain = esc(site.domain);
  const record = state.sites[site.domain];
  const excluded = state.excluded.includes(site.domain);
  const [label, tone] = !record ? ["Not checked", ""]
    : record.status === "missing" && record.seen ? ["Removed", ""] : MAINWP_STATUS[record.status];
  const eligible = record?.status !== "unsupported";
  // A Dashboard elsewhere connects the site itself; here the Child is only installed and activated.
  const verb = record?.status === "error" ? "Retry" : !state.remote ? "Connect"
    : record?.status === "inactive" ? "Activate" : record?.status === "not-connected" ? "" : "Install";
  const action = verb && eligible && !excluded && !state.cleanup && record?.status !== "connected"
    ? `<button class="btn" type="button" data-domain="${domain}"${state.remote ? " data-remote" : ""} onclick="connectMainwp(this)">${verb}</button>`
    : "";
  const owner = record?.status !== "connected" ? "" : record.ownedConnection ? "Connected by WordPress Tools" : "Connected in MainWP";
  const automatic = state.enabled && eligible
    ? siteSwitch(`mainwp-auto-${domain}`, "Install MainWP Child automatically on", domain, !excluded, "setMainwpSite")
    : "";
  return `<div class="wp-status"><span class="badge ${tone}"${record ? checkedTitle(record.checkedAt) : ""}>${label}</span>${action}</div>${
    owner ? `<div class="hint">${owner}</div>` : ""}${record?.error ? `<div class="wp-error">${esc(record.error)}</div>` : ""}${automatic}`;
}

function siteRow(site: WpSiteView, data: WpDashboard, mainwp: boolean): string {
  const domain = esc(site.domain);
  return `
              <tr data-domain="${domain}" data-find="${esc(`${site.domain} ${site.user}`)}">
                <td class="site-cell">${domain}<div class="hint">${esc(site.user)}</div></td>
                <td data-label="Varnish plugin">${varnishCell(site, data.varnish, !data.varnishError)}</td>${
  mainwp ? `\n                <td data-label="MainWP Child">${mainwpCell(site, data.mainwp)}</td>` : ""}
                <td class="action-cell"><button class="btn btn-primary" type="button" data-domain="${domain}" onclick="signIn(this)">Sign in</button></td>
              </tr>`;
}

function helperLine(sites: WpSiteView[]): string {
  const installed = sites.filter((site) => site.helper).length;
  if (installed === 0) return "";
  return `<p class="wp-helper hint">Sign-in helper on ${installed} site${installed === 1 ? "" : "s"} · <button class="wp-link" type="button" onclick="removeHelpers()">Remove</button></p>`;
}

function sitesCard(data: WpDashboard): string {
  const sites = data.sites;
  if (sites.length === 0) {
    return `
    <div class="card card-table">
      <div class="card-header"><h2>WordPress sites</h2></div>
      <div class="empty">No site on this server has a WordPress in it.</div>
    </div>`;
  }
  const mainwp = !data.mainwpError && (Boolean(data.mainwp.dashboard) || data.mainwp.remote);
  return `
    <div class="card card-table">
      <div class="card-header"><h2>WordPress sites</h2></div>
      ${fleetFilterHtml({ count: sites.length, summary: `${sites.length} sites` })}
      <div class="table-scroll">
        <table class="fleet-table wp-site-table">
          <thead>
            <tr>
              <th scope="col">Site</th>
              <th scope="col" title="CLP Varnish Cache, the WordPress plugin that clears CloudPanel's Varnish cache when content changes">Varnish plugin</th>${mainwp ? '\n              <th scope="col">MainWP Child</th>' : ""}
              <th scope="col" class="action-cell"></th>
            </tr>
          </thead>
          <tbody>${sites.map((site) => siteRow(site, data, mainwp)).join("")}
          </tbody>
        </table>
      </div>
      ${FLEET_NONE_HTML}
    </div>${helperLine(sites)}`;
}

function varnishSection(automatic: boolean, error: string): string {
  const title = "Install CLP Varnish Cache automatically";
  if (error) return `<div class="wp-section"><h3>${title}</h3><div class="alert" role="alert">${esc(error)}</div></div>`;
  return `
      <div class="wp-section split-card">
        <div>
          <h3>${title}</h3>
          <p class="hint">On WordPress sites with Varnish enabled in CloudPanel, checked every 15 minutes. A plugin deactivated or removed in WordPress is left alone.</p>
        </div>
        <div class="wp-controls">
          ${automatic ? '<button class="btn" id="varnish-check" type="button" onclick="checkSites()">Check now</button>' : ""}
          <label class="switch"><input id="varnish-automatic" type="checkbox" aria-label="${title}" ${automatic ? "checked" : ""} onchange="setAutomatic(this)"><span></span></label>
        </div>
      </div>`;
}

function dashboardPicker(sites: WpSiteView[], state: MainwpView): string {
  const locked = state.connections > 0 || state.cleanup;
  const options = sites.map((site) =>
    `<option value="${esc(site.domain)}"${site.domain === state.dashboard ? " selected" : ""}>${esc(site.domain)}</option>`).join("");
  return `<div class="mainwp-picker">
          <label for="mainwp-dashboard">MainWP Dashboard</label>
          <select id="mainwp-dashboard" onchange="setMainwpDashboard(this)" ${locked ? "disabled" : ""}>${
  state.dashboard || state.remote ? "" : '<option value="">Choose a site</option>'}<option value="@remote"${
  state.remote ? " selected" : ""}>On another server</option>${options}</select>
        </div>`;
}

function mainwpSection(sites: WpSiteView[], state: MainwpView, error: string): string {
  const title = state.remote ? "Install MainWP Child automatically" : "Install and connect MainWP Child automatically";
  if (error) return `<div class="wp-section"><h3>${title}</h3><div class="alert" role="alert">${esc(error)}</div></div>`;
  const cleanable = state.owned > 0 || state.cleanup;
  const cleanup = cleanable
    ? `<button class="btn" type="button" onclick="cleanupMainwp()">${state.cleanup ? "Retry cleanup…" : "Turn off and clean up…"}</button>`
    : "";
  const note = state.cleanup
    ? '<p class="mainwp-note" role="status">Cleanup pending. Automation stays off until what WordPress Tools added is removed.</p>'
    : "";
  if (!state.dashboard && !state.remote) {
    // A deleted Dashboard can leave Child plugins the addon installed, which cleanup still removes.
    return `
      <div class="wp-section">
        <h3>MainWP</h3>
        <p class="hint">Choose the site that runs MainWP Dashboard to connect the other WordPress sites to it, or On another server to only install MainWP Child.</p>
        <div class="mainwp-controls">
          ${dashboardPicker(sites, state)}
          ${cleanup}
        </div>
        ${note}
      </div>`;
  }
  const summary = state.remote
    ? "On every WordPress site that has never had MainWP Child, checked every 15 minutes. It stays inactive, since it turns itself off when no Dashboard connects soon after activation: activate a site just before adding it in your Dashboard. A Child removed in WordPress is left alone."
    : "On every WordPress site that has never had MainWP Child, once it answers over HTTPS, checked every 15 minutes. A Child removed in WordPress is left alone.";
  return `
      <div class="wp-section">
        <div class="split-card">
          <div>
            <h3>${title}</h3>
            <p class="hint">${summary}</p>
          </div>
          <label class="switch"><input id="mainwp-automatic" type="checkbox" aria-label="${title}" ${state.enabled ? "checked" : ""} ${state.cleanup ? "disabled" : ""} onchange="setMainwpAutomatic(this)"><span></span></label>
        </div>
        <div class="mainwp-controls">
          ${dashboardPicker(sites, state)}
          <button class="btn" id="mainwp-check" type="button" onclick="checkMainwp()">Check now</button>
          ${cleanup}
        </div>
        ${note}
      </div>`;
}

function automationCard(data: WpDashboard): string {
  return `
    <div class="card">
      <div class="card-header"><h2>Automation</h2></div>
      ${varnishSection(data.varnish.enabled, data.varnishError)}
      ${mainwpSection(data.sites, data.mainwp, data.mainwpError)}
    </div>`;
}

/** Everything below the heading; the page repaints it from `/api/dashboard` after a change. */
export function dashboardBody(data: WpDashboard): string {
  return `${sitesCard(data)}${automationCard(data)}`;
}

export function dashboardView(data: WpDashboard): string {
  return `
    <div class="page-heading">
      <div>
        <h1>WordPress Tools</h1>
        <p>Sign in to any WordPress on this server as its first administrator, and install CLP Varnish Cache and MainWP Child automatically.</p>
      </div>
    </div>
    <div id="wp-dashboard">${dashboardBody(data)}</div>`;
}

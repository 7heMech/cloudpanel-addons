import { esc } from "../../../lib/app-http";
import { renderLayout } from "../../../lib/app-ui";
import { mountPath } from "../../../lib/mount";
import type { WpSiteView } from "../action";
import type { VarnishPluginStatus } from "../varnish";
import type { MainwpStatus } from "../mainwp";
import type { WpDashboard } from "./service";

const BASE = mountPath("wp-login");

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
    script: SCRIPT,
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

function pluginStatus(site: WpSiteView, available: boolean): string {
  if (!available) return '<span class="toolbar-note">Unavailable</span>';
  if (!site.varnishCache) return '<span class="toolbar-note">Varnish off</span>';
  const record = site.varnishPlugin;
  if (!record) return '<span class="badge">Not checked</span>';
  const [label, tone] = record.status === "missing" && record.seen ? ["Removed", ""] : PLUGIN_STATUS[record.status];
  const checked = record.checkedAt.replace("T", " ").slice(0, 16);
  return `<span class="badge ${tone}" title="Checked ${esc(checked)} UTC">${label}</span>${
    record.error ? `<div class="varnish-error">${esc(record.error)}</div>` : ""}`;
}

/** The explicit install for an included site; the backend installs if missing and activates. */
function pluginButton(site: WpSiteView): string {
  const status = site.varnishPlugin?.status;
  if (!site.varnishCache || site.varnishExcluded || status === "active" || status === "unsupported") return "";
  const label = status === "inactive" ? "Activate" : status === "error" ? "Retry" : "Install";
  return `<button class="btn" type="button" data-domain="${esc(site.domain)}" onclick="installPlugin(this)">${label}</button>`;
}

function siteRow(site: WpSiteView, available: boolean): string {
  const domain = esc(site.domain);
  const automatic = available && site.varnishCache
    ? `<label class="switch"><input id="auto-${domain}" type="checkbox" data-domain="${domain}" aria-label="Install CLP Varnish Cache automatically on ${domain}" ${site.varnishExcluded ? "" : "checked"} onchange="setSiteAutomatic(this)"><span></span></label>`
    : "";
  return `
              <tr>
                <td class="site-cell">${domain}<div class="hint">${esc(site.user)}</div></td>
                <td class="type-cell">${esc(site.application || "WordPress")}</td>
                <td data-label="Varnish plugin">${pluginStatus(site, available)}</td>
                <td data-label="Automatic">${automatic}</td>
                <td class="action-cell"><span class="row-actions">${available ? pluginButton(site) : ""}<button class="btn btn-primary" type="button" data-domain="${domain}" onclick="signIn(this)">Sign in</button></span></td>
              </tr>`;
}

function sitesCard(sites: WpSiteView[], available: boolean): string {
  if (sites.length === 0) {
    return `
    <div class="card card-table">
      <div class="card-header"><h2>WordPress sites</h2></div>
      <div class="empty">No site on this server has a WordPress in it.</div>
    </div>`;
  }
  return `
    <div class="card card-table">
      <div class="card-header">
        <h2>WordPress sites</h2>
        <span class="toolbar-note">${sites.length} site${sites.length === 1 ? "" : "s"}</span>
      </div>
      <div class="table-scroll">
        <table class="fleet-table wp-site-table">
          <thead>
            <tr>
              <th scope="col">Site</th>
              <th scope="col">Application</th>
              <th scope="col">Varnish plugin</th>
              <th scope="col">Automatic</th>
              <th scope="col" class="action-cell">Actions</th>
            </tr>
          </thead>
          <tbody>${sites.map((site) => siteRow(site, available)).join("")}
          </tbody>
        </table>
      </div>
    </div>`;
}

function policyCard(automatic: boolean, error: string): string {
  if (error) {
    return `
    <div class="card wp-card">
      <h2>Install CLP Varnish Cache automatically</h2>
      <div class="alert" role="alert">${esc(error)}</div>
    </div>`;
  }
  return `
    <div class="card switch-row wp-card">
      <div>
        <h2>Install CLP Varnish Cache automatically</h2>
        <p>On WordPress sites with Varnish enabled in CloudPanel, checked every 15 minutes. A plugin deactivated or removed in WordPress is left alone.</p>
      </div>
      <div class="wp-card-controls">
        ${automatic ? '<button class="btn" type="button" onclick="checkSites()">Check now</button>' : ""}
        <label class="switch"><input id="varnish-automatic" type="checkbox" aria-label="Install CLP Varnish Cache automatically" ${automatic ? "checked" : ""} onchange="setAutomatic(this)"><span></span></label>
      </div>
    </div>`;
}

function helperCard(sites: WpSiteView[]): string {
  const installed = sites.filter((site) => site.helper).length;
  if (installed === 0) return "";
  return `
    <div class="card switch-row wp-card">
      <div>
        <h2>Sign-in helper</h2>
        <p>A must-use plugin in ${installed} site${installed === 1 ? "" : "s"} that accepts a one-time sign-in and does nothing on any other request. The next sign-in puts it back.</p>
      </div>
      <button class="btn" type="button" onclick="removeHelpers()">Remove from every site</button>
    </div>`;
}

function mainwpSection(data: WpDashboard): string {
  const state = data.mainwp;
  const dashboard = state?.dashboard || "";
  const enabled = state?.enabled || false;
  const cleanup = state?.cleanup || false;
  const options = data.sites.map((site) => `<option value="${esc(site.domain)}" ${site.domain === dashboard ? "selected" : ""}>${esc(site.domain)}</option>`).join("");
  const labels: Record<MainwpStatus, [string, string]> = {
    missing: ["Not installed", ""], "not-connected": ["Not connected", "state-paused"], connected: ["Connected", "state-done"],
    unsupported: ["Multisite, skipped", ""], error: ["Check failed", "state-failed"],
  };
  const rows = data.sites.map((site) => {
    const record = state?.sites[site.domain];
    const isDashboard = site.domain === dashboard;
    const excluded = state?.excluded.includes(site.domain);
    const [label, tone] = isDashboard ? ["Dashboard", "state-done"] : record ? record.status === "missing" && record.seen ? ["Removed", ""] : labels[record.status] : ["Not checked", ""];
    const eligible = !isDashboard && record?.status !== "unsupported" && !data.mainwpError;
    const action = eligible && !excluded && dashboard && !cleanup && record?.status !== "connected"
      ? `<button class="btn" type="button" data-domain="${esc(site.domain)}" onclick="connectMainwp(this)">${record?.status === "error" ? "Retry" : "Connect"}</button>` : "";
    const managed = record?.ownedConnection ? "Managed by WordPress Tools" : record?.status === "connected" ? "Managed in MainWP" : "";
    return `<tr><td class="site-cell">${esc(site.domain)}<div class="hint">${esc(site.user)}</div></td>
      <td data-label="MainWP"><span class="badge ${tone}" title="${esc(record?.checkedAt || "")}">${label}</span>${managed ? `<div class="hint">${managed}</div>` : ""}${record?.error ? `<div class="varnish-error">${esc(record.error)}</div>` : ""}</td>
      <td data-label="Automatic">${eligible ? `<label class="switch"><input type="checkbox" data-domain="${esc(site.domain)}" aria-label="Install MainWP Child automatically on ${esc(site.domain)}" ${excluded ? "" : "checked"} onchange="setMainwpSite(this)"><span></span></label>` : ""}</td>
      <td class="action-cell">${action}</td></tr>`;
  }).join("");
  return `<div class="card wp-card">
    <div class="switch-row"><div><h2>Install and connect MainWP Child automatically</h2><p>Sites without MainWP Child are installed and connected every 15 minutes. Existing plugins need Connect; removed plugins are left alone.</p></div>
      <label class="switch"><input id="mainwp-automatic" type="checkbox" aria-label="Install and connect MainWP Child automatically" ${enabled ? "checked" : ""} ${!dashboard || cleanup || data.mainwpError ? "disabled" : ""} onchange="setMainwpAutomatic(this)"><span></span></label></div>
    ${data.mainwpError ? `<div class="alert" role="alert">${esc(data.mainwpError)}</div>` : `<div class="mainwp-controls"><label for="mainwp-dashboard">MainWP Dashboard</label><select id="mainwp-dashboard" aria-label="MainWP Dashboard" onchange="setMainwpDashboard(this)" ${state?.owned || cleanup ? "disabled" : ""}><option value="">Choose a site…</option>${options}</select><button class="btn" type="button" onclick="checkMainwp()" ${dashboard ? "" : "disabled"}>Check now</button>${state?.owned || cleanup ? `<button class="btn" type="button" onclick="cleanupMainwp()">${cleanup ? "Retry cleanup…" : "Turn off and clean up…"}</button>` : ""}</div>`}
    ${cleanup ? '<p class="mainwp-pending" role="status">Cleanup pending. Automation is off; retry until every managed connection is removed.</p>' : !enabled && state?.owned ? '<p class="mainwp-pending">Automation is off. Existing MainWP connections remain active until you clean up.</p>' : ""}
  </div><div class="card card-table"><div class="card-header"><h2>MainWP sites</h2><span class="toolbar-note">${data.sites.length} sites</span></div>${rows ? `<div class="table-scroll"><table class="fleet-table wp-site-table mainwp-site-table"><thead><tr><th scope="col">Site</th><th scope="col">MainWP</th><th scope="col">Automatic</th><th scope="col" class="action-cell">Actions</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="empty">No WordPress sites on this server.</div>'}</div>`;
}

/** Everything below the heading; the page repaints it from `/api/dashboard` after a change. */
export function dashboardBody(data: WpDashboard): string {
  const available = !data.varnishError;
  return `${policyCard(data.varnish.enabled, data.varnishError)}${sitesCard(data.sites, available)}${mainwpSection(data)}${helperCard(data.sites)}`;
}

export function dashboardView(data: WpDashboard): string {
  return `
    <div class="page-heading">
      <div>
        <h1>WordPress Tools</h1>
        <p>Sign in to any WordPress on this server as its first administrator, and automate CLP Varnish Cache and MainWP Child installation.</p>
      </div>
    </div>
    <div id="wp-dashboard">${dashboardBody(data)}</div>`;
}

import { esc } from "../../../lib/app-http";
import {
  FLEET_FOOTER_HTML, FLEET_ROW_SELECTION_JS, JOB_PROGRESS_JS, JOB_PROGRESS_STYLE, fleetFilterHtml, fleetRowSelectionStyle,
  jobProgressHtml, renderLayout,
} from "../../../lib/app-ui";
import { mountPath } from "../../../lib/mount";
import type { WpJobView, WpSiteView } from "../action";
import type { VarnishPluginStatus } from "../varnish";
import type { MainwpStatus, MainwpView } from "../mainwp";
import type { NewSitePluginOutcome, NewSitePluginStatus, NewSiteResult } from "../new-site-plugins";
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
    css: `${JOB_PROGRESS_STYLE}${STYLE}${fleetRowSelectionStyle("wp-selectable")}`,
    script: `${FLEET_ROW_SELECTION_JS}\n${JOB_PROGRESS_JS}\n${SCRIPT}`,
    updateNotice,
  });
}

const PLUGIN_STATUS: Record<VarnishPluginStatus, [label: string, tone: string]> = {
  active: ["Active", "state-done"],
  inactive: ["Inactive", "state-paused"],
  missing: ["Not installed", ""],
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

function varnishCell(site: WpSiteView, available: boolean, job: WpJobView | null): string {
  if (!available) return '<span class="toolbar-note">Unavailable</span>';
  if (!site.varnishCache) return '<span class="hint" title="Varnish Cache is off for this site in CloudPanel, so the plugin has nothing to purge">Varnish off</span>';
  const domain = esc(site.domain);
  const record = site.varnishPlugin;
  const [label, tone] = !record ? ["Not checked", ""]
    : record.status === "missing" && record.seen ? ["Removed", ""]
    : record.status === "active" && record.network ? ["Network active", "state-done"] : PLUGIN_STATUS[record.status];
  // Only a check says what a site needs; the backend installs if missing and activates.
  const status = record?.status;
  const action = !record || status === "active" ? ""
    : `<button class="btn" type="button" data-domain="${domain}"${record.network ? " data-network" : ""}${job ? " disabled" : ""} onclick="installPlugin(this)">${
      status === "inactive" ? "Activate" : status === "error" ? "Retry" : "Install"}</button>`;
  return `<div class="wp-status" data-policy="varnish"><span class="badge ${tone}"${record ? checkedTitle(record.checkedAt) : ""}>${label}</span>${action}</div>${
    record?.error ? `<div class="wp-error">${esc(record.error)}</div>` : ""}`;
}

/** Sites a batch can connect to a Dashboard on this server: checked or not, anything not already connected. */
function connectable(site: WpSiteView, state: MainwpView): boolean {
  const status = state.sites[site.domain]?.status;
  return !state.remote && Boolean(state.dashboard) && !state.cleanup && site.domain !== state.dashboard
    && status !== "connected" && status !== "unsupported";
}

function mainwpCell(site: WpSiteView, state: MainwpView, job: WpJobView | null): string {
  if (site.domain === state.dashboard) return '<div class="wp-status" data-policy="mainwp"><span class="badge state-done">Dashboard</span></div>';
  const domain = esc(site.domain);
  const record = state.sites[site.domain];
  const [label, tone] = !record ? ["Not checked", ""]
    : record.status === "missing" && record.seen ? ["Removed", ""] : MAINWP_STATUS[record.status];
  // A Dashboard elsewhere connects the site itself; here the Child is only installed and activated.
  const verb = record?.status === "error" ? "Retry" : !state.remote ? "Connect"
    : record?.status === "inactive" ? "Activate" : record?.status === "not-connected" ? "" : "Install";
  // An unchecked site gets its button from a check, as for Varnish; a batch can still connect it.
  const action = verb && record && record.status !== "unsupported" && !state.cleanup && record.status !== "connected"
    ? `<button class="btn" type="button" data-domain="${domain}"${state.remote ? " data-remote" : ""}${job ? " disabled" : ""} onclick="connectMainwp(this)">${verb}</button>`
    : "";
  // A phone's half-width cell fits the short form beside the badge.
  const owner = record?.status !== "connected" ? ""
    : record.ownedConnection ? '<span class="wp-note" title="Connected by WordPress Tools">by <span class="wp-long">WordPress Tools</span><span class="wp-short">WP Tools</span></span>'
    : '<span class="wp-note">in MainWP</span>';
  return `<div class="wp-status" data-policy="mainwp"><span class="badge ${tone}"${record ? checkedTitle(record.checkedAt) : ""}>${label}</span>${
    owner}${action}</div>${record?.error ? `<div class="wp-error">${esc(record.error)}</div>` : ""}`;
}

function siteRow(site: WpSiteView, data: WpDashboard, mainwp: boolean, selectable: boolean): string {
  const domain = esc(site.domain);
  const select = selectable
    ? ` tabindex="0" aria-selected="false" onclick="toggleSiteSelection(event, this)" onkeydown="toggleSiteSelection(event, this)"` : "";
  const box = selectable ? `
                <td class="site-select"><input class="site-checkbox" type="checkbox" onchange="paintFleetSelection()" aria-label="Select ${domain}"${
    connectable(site, data.mainwp) && !data.jobs.mainwp ? "" : " disabled"}></td>` : "";
  return `
              <tr data-domain="${domain}" data-find="${esc(`${site.domain} ${site.user}`)}"${select}>${box}
                <td class="site-cell">${domain}<div class="hint">${esc(site.user)}</div></td>
                <td data-label="CLP Varnish Cache">${varnishCell(site, !data.varnishError, data.jobs.varnish)}</td>${
  mainwp ? `\n                <td data-label="MainWP Child">${mainwpCell(site, data.mainwp, data.jobs.mainwp)}</td>` : ""}
                <td class="action-cell"><button class="btn btn-primary" type="button" data-domain="${domain}" onclick="signIn(this)">Sign in</button></td>
              </tr>`;
}

const JOB_TITLES: Record<WpJobView["task"], string> = {
  "varnish-check": "Checking CLP Varnish Cache",
  "varnish-install": "Installing CLP Varnish Cache",
  "mainwp-check": "Checking MainWP Child",
  "mainwp-connect": "Connecting sites to MainWP",
  "mainwp-cleanup": "Cleaning up MainWP",
  "new-site-plugins": "Installing plugins",
};

function jobsStrip(data: WpDashboard): string {
  const jobs = [data.jobs.varnish, data.jobs.mainwp].filter((job): job is WpJobView => Boolean(job));
  return jobs.length ? `<div class="wp-jobs">${jobs.map((job) => `
      ${jobProgressHtml(job, JOB_TITLES[job.task])}`).join("")}
        <p class="hint">Runs in the background: you can leave or reload this page.</p></div>` : "";
}

function batchToolbar(data: WpDashboard, count: number): string {
  const busy = data.jobs.mainwp ? " disabled" : "";
  return `
        <span class="toolbar-note" id="site-selection">No sites selected</span>
        <button class="btn mobile-select-all" id="select-all-btn" type="button" onclick="toggleAllSites()">Select all</button>
        <div class="toolbar-end wp-batch">
          <button class="btn" type="button" data-needs-selection disabled onclick="connectMainwpSelected()"><span class="wp-long">Connect selected to MainWP</span><span class="wp-short">Connect selected</span></button>
          <button class="btn" type="button" data-count="${count}"${count && !busy ? "" : " disabled"} onclick="connectMainwpAll(this)"><span class="wp-long">Connect all unconnected (${count})</span><span class="wp-short">Connect all (${count})</span></button>
        </div>`;
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
  // Batch connection is for a Dashboard on this server; one elsewhere connects each site itself.
  const selectable = mainwp && !data.mainwp.remote && !data.mainwp.cleanup;
  const unconnected = selectable ? sites.filter((site) => connectable(site, data.mainwp)).length : 0;
  return `
    <div class="card card-table">
      <div class="card-header${selectable ? " toolbar" : ""}"><h2>WordPress sites</h2>${selectable ? batchToolbar(data, unconnected) : ""}</div>
      ${jobsStrip(data)}
      ${fleetFilterHtml({ count: sites.length, summary: `${sites.length} sites` })}
      <div class="table-scroll">
        <table class="fleet-table wp-site-table${selectable ? " wp-selectable" : ""}">
          <thead>
            <tr>${selectable ? `
              <th scope="col" class="site-select"><input id="select-all" type="checkbox" onchange="selectAllSites(this.checked)" aria-label="Select all sites"${data.jobs.mainwp ? " disabled" : ""}></th>` : ""}
              <th scope="col">Site</th>
              <th scope="col" title="The WordPress plugin that clears CloudPanel's Varnish cache when content changes">CLP Varnish Cache</th>${
  mainwp ? '\n              <th scope="col">MainWP Child</th>' : ""}
              <th scope="col" class="action-cell"></th>
            </tr>
          </thead>
          <tbody>${sites.map((site) => siteRow(site, data, mainwp, selectable)).join("")}
          </tbody>
        </table>
      </div>
      ${FLEET_FOOTER_HTML}
    </div>${helperLine(sites)}`;
}

const NEW_SITE_STATUS: Record<NewSitePluginStatus, [label: string, tone: string]> = {
  activated: ["Active", "state-done"],
  installed: ["Installed", ""],
  present: ["Already there", ""],
  failed: ["Failed", "state-failed"],
};

function when(stamp: string): string {
  return stamp ? `${esc(stamp.replace("T", " ").slice(0, 16))} UTC` : "";
}

function newSitePlugin(plugin: NewSitePluginOutcome): string {
  const [label, tone] = NEW_SITE_STATUS[plugin.status] ?? ["Failed", "state-failed"];
  const source = plugin.source === "upload" ? "uploaded" : "WordPress.org";
  return `<li><span class="wp-plugin-name">${esc(plugin.name)}</span> <span class="badge ${tone}">${label}</span> <span class="wp-note">${source}</span>${
    plugin.error ? `<div class="wp-error">${esc(plugin.error)}</div>` : ""}</li>`;
}

function newSiteRow(job: WpJobView): string {
  const result = job.result as NewSiteResult | null;
  const plugins = result?.plugins.length
    ? `<ul class="wp-plugin-list">${result.plugins.map(newSitePlugin).join("")}</ul>`
    : `<ul class="wp-plugin-list">${job.plugins.map((plugin) => `<li><span class="wp-plugin-name">${esc(plugin.name)}</span></li>`).join("")}</ul>`;
  const state = job.state === "failed"
    ? `<span class="badge state-failed">Failed</span><div class="wp-error">${esc(job.error)}</div>`
    : `<span class="hint">${when(job.finishedAt)}</span>`;
  return `
              <tr data-domain="${esc(job.domains[0] ?? "")}">
                <td class="site-cell">${esc(job.domains[0] ?? "")}${job.chosenBy ? `<div class="hint">chosen by ${esc(job.chosenBy)}</div>` : ""}</td>
                <td data-label="Plugins">${plugins}</td>
                <td data-label="Finished">${state}</td>
              </tr>`;
}

/** What the new-site form's choices did, and the ones still waiting for their site. */
function newSitesCard(jobs: WpJobView[]): string {
  const running = jobs.filter((job) => job.state === "queued" || job.state === "running");
  const finished = jobs.filter((job) => !running.includes(job));
  return `
    <div class="card card-table">
      <div class="card-header"><h2>Plugins on new sites</h2></div>
      <p class="hint wp-card-note">Choose plugins from WordPress.org, or upload them as zips, on CloudPanel's New WordPress Site form. Each is installed as the site's own user once WordPress is set up, and the page the new site lands on says how it went.</p>${
  running.length ? `
      <div class="wp-jobs">${running.map((job) => `
        ${jobProgressHtml(job, `Plugins for ${job.domains[0] ?? ""}`)}`).join("")}
      </div>` : ""}${
  finished.length ? `
      <div class="table-scroll">
        <table class="fleet-table wp-new-site-table">
          <thead><tr><th scope="col">Site</th><th scope="col">Plugins</th><th scope="col">Finished</th></tr></thead>
          <tbody>${finished.map(newSiteRow).join("")}
          </tbody>
        </table>
      </div>` : ""}
    </div>`;
}

function varnishSection(automatic: boolean, error: string, job: WpJobView | null): string {
  const title = "Install CLP Varnish Cache automatically";
  if (error) return `<div class="wp-section"><h3>${title}</h3><div class="alert" role="alert">${esc(error)}</div></div>`;
  const busy = job ? " disabled" : "";
  return `
      <div class="wp-section split-card">
        <div>
          <h3>${title}</h3>
          <p class="hint">On WordPress sites with Varnish enabled in CloudPanel, checked every 15 minutes; on a multisite network it is network-activated. A plugin deactivated or removed in WordPress is left alone. Check now shows each site's plugin without installing anything while this is off.</p>
        </div>
        <div class="wp-controls">
          <button class="btn" id="varnish-check" type="button"${busy} onclick="checkSites()">${job ? "Checking…" : "Check now"}</button>
          <label class="switch"><input id="varnish-automatic" type="checkbox" aria-label="${title}" ${automatic ? "checked" : ""}${busy} onchange="setAutomatic(this)"><span></span></label>
        </div>
      </div>`;
}

function dashboardPicker(sites: WpSiteView[], state: MainwpView, busy = false): string {
  const locked = state.connections > 0 || state.cleanup || busy;
  const options = sites.map((site) =>
    `<option value="${esc(site.domain)}"${site.domain === state.dashboard ? " selected" : ""}>${esc(site.domain)}</option>`).join("");
  return `<div class="mainwp-picker">
          <label for="mainwp-dashboard">MainWP Dashboard</label>
          <select id="mainwp-dashboard" onchange="setMainwpDashboard(this)" ${locked ? "disabled" : ""}>${
  state.dashboard || state.remote ? "" : '<option value="">Choose a site</option>'}<option value="@remote"${
  state.remote ? " selected" : ""}>On another server</option>${options}</select>
        </div>`;
}

function mainwpSection(sites: WpSiteView[], state: MainwpView, error: string, job: WpJobView | null): string {
  const title = state.remote ? "Install MainWP Child automatically" : "Keep every site connected to MainWP";
  if (error) return `<div class="wp-section"><h3>${title}</h3><div class="alert" role="alert">${esc(error)}</div></div>`;
  const cleanable = state.owned > 0 || state.cleanup;
  const busy = job ? " disabled" : "";
  const cleanup = cleanable
    ? `<button class="btn" type="button"${busy} onclick="cleanupMainwp()">${state.cleanup ? "Retry cleanup…" : "Turn off and clean up…"}</button>`
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
    : "Checked every 15 minutes: each WordPress site gets MainWP Child installed, activated and connected to this Dashboard once it answers over HTTPS, even if it was connected to another one. Site administrators cannot see, deactivate or disconnect it.";
  return `
      <div class="wp-section">
        <div class="split-card">
          <div>
            <h3>${title}</h3>
            <p class="hint">${summary}</p>
          </div>
          <label class="switch"><input id="mainwp-automatic" type="checkbox" aria-label="${title}" ${state.enabled ? "checked" : ""} ${state.cleanup || job ? "disabled" : ""} onchange="setMainwpAutomatic(this)"><span></span></label>
        </div>
        <div class="mainwp-controls">
          ${dashboardPicker(sites, state, Boolean(job))}
          <button class="btn" id="mainwp-check" type="button"${busy} onclick="checkMainwp()">${job?.task === "mainwp-check" ? "Checking…" : "Check now"}</button>
          ${cleanup}
        </div>
        ${note}
      </div>`;
}

function switchSection(title: string, id: string, on: boolean, handler: string, hint: string, error: string): string {
  return error
    ? `<div class="wp-section"><h3>${title}</h3><div class="alert" role="alert">${esc(error)}</div></div>`
    : `
      <div class="wp-section">
        <div class="split-card">
          <div>
            <h3>${title}</h3>
            <p class="hint">${hint}</p>
          </div>
          <label class="switch"><input id="${id}" type="checkbox" aria-label="${title}" ${on ? "checked" : ""} onchange="${handler}(this)"><span></span></label>
        </div>
      </div>`;
}

/** The switches that change what CloudPanel's own pages draw, which saving renders again. */
function panelPagesCard(data: WpDashboard): string {
  return `
    <div class="card">
      <div class="card-header"><h2>CloudPanel's pages</h2></div>
      ${switchSection("Sign in from the domain", "domain-link", data.domainLink.signIn, "setDomainLink",
    "On a WordPress site's pages in CloudPanel, the domain at the top signs in to WordPress instead of opening the site; Ctrl-click still opens it. Off, a WP Login link sits beside the domain instead.",
    data.domainLinkError)}
      ${switchSection("Site managers choose plugins for new sites", "new-site-managers", data.newSiteAccess?.siteManagers ?? false, "setNewSiteManagers",
    "Site managers get the Plugins row on the New WordPress Site form too, with WordPress.org plugins only. Uploading a zip stays with administrators.",
    data.newSiteAccessError ?? "")}
    </div>`;
}

function automationCard(data: WpDashboard): string {
  return `
    <div class="card">
      <div class="card-header"><h2>Automation</h2></div>
      ${varnishSection(data.varnish.enabled, data.varnishError, data.jobs.varnish)}
      ${mainwpSection(data.sites, data.mainwp, data.mainwpError, data.jobs.mainwp)}
    </div>`;
}

/** Everything below the heading; the page repaints it from `/api/dashboard` after a change. */
export function dashboardBody(data: WpDashboard): string {
  return `${sitesCard(data)}${newSitesCard(data.newSites ?? [])}${automationCard(data)}${panelPagesCard(data)}`;
}

export function dashboardView(data: WpDashboard): string {
  return `
    <div class="page-heading">
      <div>
        <h1>WordPress Tools</h1>
        <p>Sign in to any WordPress on this server as its first administrator, choose plugins for new WordPress sites, and install CLP Varnish Cache and MainWP Child automatically.</p>
      </div>
    </div>
    <div id="wp-dashboard">${dashboardBody(data)}</div>`;
}

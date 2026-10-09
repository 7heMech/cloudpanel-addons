import { esc } from "../../../lib/app-http";
import { CARRIED_FLASH_JS, renderLayout } from "../../../lib/app-ui";
import { mountPath } from "../../../lib/mount";
import type { WpSiteView } from "../action";
import type { WpVarnishState } from "../varnish";

const BASE = mountPath("wp-login");

// The cards, the buttons and the narrow-screen table layout are in lib/app-ui.
import STYLE from "./views.css" with { type: "text" };

import SCRIPT_BODY from "./views.client.js" with { type: "text" };

const SCRIPT = `${CARRIED_FLASH_JS}${SCRIPT_BODY}`;

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

function siteRow(site: WpSiteView): string {
  const record = site.varnishPlugin;
  const labels = { active: "Active", inactive: "Inactive", missing: record?.seen ? "Removed" : "Not installed", unsupported: "Multisite", error: "Check failed" };
  const status = record ? labels[record.status] : "Not checked";
  const statusClass = record?.status === "active" ? "state-done" : record?.status === "inactive" ? "state-paused" : record?.status === "error" ? "state-failed" : "";
  const install = site.varnishCache && !site.varnishExcluded && record?.status !== "active" && record?.status !== "unsupported";
  const action = record?.status === "inactive" ? "activate" : record?.status === "error" ? "retry" : "install";
  const installLabel = { activate: "Activate", retry: "Retry", install: "Install" }[action];
  return `
              <tr>
                <td class="site-cell"><span class="site-copy"><span class="badge mobile-site-type">${esc(site.application || "WordPress")}</span><span class="site-name">${esc(site.domain)}</span></span></td>
                <td class="type-cell">${esc(site.application || "WordPress")}</td>
                <td data-label="Site user">${esc(site.user)}</td>
                <td class="varnish-cell" data-label="Varnish">
                  ${site.varnishCache ? `<span class="badge ${statusClass}"${record?.checkedAt ? ` title="Last checked: ${esc(record.checkedAt)}"` : ""}>${esc(status)}</span>
                  ${record?.status === "unsupported" ? '<div class="hint wp-status-note">Manage in WordPress</div>' : ""}
                  ${record?.error ? `<div class="varnish-error">${esc(record.error)}</div>` : ""}
                  ` : '<span class="badge">Varnish off</span>'}
                </td>
                <td class="varnish-policy-cell" data-label="Varnish tools">${site.varnishCache
                  ? `<label class="switch-field"><span class="switch"><input type="checkbox" data-domain="${esc(site.domain)}" ${site.varnishExcluded ? "" : "checked"} aria-label="Include ${esc(site.domain)} in Varnish plugin installation" onchange="setVarnishSite(this)"><span></span></span><span class="switch-state">${site.varnishExcluded ? "Excluded" : "Included"}</span></label>`
                  : '<span class="toolbar-note">Unavailable</span>'}</td>
                <td class="action-cell"><div class="wp-actions">
                  ${install ? `<button class="btn" type="button" data-domain="${esc(site.domain)}" data-varnish-action="${action}" onclick="installVarnish(this)">${installLabel} Varnish</button>` : ""}
                  <button class="btn btn-primary" type="button" data-domain="${esc(site.domain)}" onclick="signIn(this)">Sign in</button>
                </div></td>
              </tr>`;
}

function sitesCard(sites: WpSiteView[]): string {
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
              <th scope="col">Site user</th>
              <th scope="col">Varnish</th>
              <th scope="col">Varnish tools</th>
              <th scope="col" class="text-end">Actions</th>
            </tr>
          </thead>
          <tbody>${sites.map(siteRow).join("")}
          </tbody>
        </table>
      </div>
    </div>`;
}

function helperDetails(sites: WpSiteView[]): string {
  const installed = sites.filter((site) => site.helper).length;
  if (installed === 0) return "";
  return `
    <details class="wp-helper-details">
      <summary>Sign-in helpers · ${installed} site${installed === 1 ? "" : "s"}</summary>
      <div class="wp-helper-body"><p>The helper accepts a one-time sign-in. Removing it clears it from every site; the next sign-in installs it again.</p>
        <button class="btn btn-danger" type="button" onclick="removeHelpers(this)">Remove helpers</button>
      </div>
    </details>`;
}

function toolsCard(sites: WpSiteView[], state: WpVarnishState): string {
  return `<div class="card wp-tools-card">
    <section class="wp-tool" aria-labelledby="wp-sign-in-title">
      <div class="switch-row"><h2 id="wp-sign-in-title">WordPress sign-in</h2><span class="badge state-done">Available</span></div>
      <p class="hint">Open a site below as its first administrator, without a password.</p>
      ${helperDetails(sites)}
    </section>
    <section class="wp-tool" aria-labelledby="wp-varnish-title">
      <div class="switch-row"><h2 id="wp-varnish-title">CLP Varnish Cache</h2>
        <label class="switch-field"><span class="switch-state">${state.enabled ? "On" : "Off"}</span><span class="switch"><input type="checkbox" aria-label="Install CLP Varnish Cache automatically" ${state.enabled ? "checked" : ""} onchange="setVarnishAutomatic(this)"><span></span></span></label>
      </div>
      <p class="hint">Automatically install the official plugin on existing and new WordPress sites with Varnish enabled in CloudPanel.</p>
      <div class="wp-check-row"><p class="hint">${state.enabled ? "Checks every 15 minutes." : "Automatic installation is off."} Manual deactivation and removal are respected.</p>
        <button class="btn" type="button" ${state.enabled ? "" : "disabled"} onclick="syncVarnishSites(this)">Check sites now</button></div>
    </section>
  </div>`;
}

export function dashboardView(sites: WpSiteView[], varnish: WpVarnishState = { enabled: false, excluded: [], sites: {} }): string {
  return `
    <div class="page-heading">
      <div>
        <h1>WordPress Tools</h1>
        <p>One-click administrator sign-in and Varnish integration for your WordPress sites.</p>
      </div>
    </div>${toolsCard(sites, varnish)}${sitesCard(sites)}`;
}

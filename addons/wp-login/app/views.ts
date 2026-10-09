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
  const labels = { active: "Active", inactive: "Inactive", missing: record?.seen ? "Removed" : "Not installed", unsupported: "Multisite · manage in WordPress", error: "Check failed" };
  const status = record ? labels[record.status] : "Not checked";
  const install = site.varnishCache && !site.varnishExcluded && record?.status !== "active" && record?.status !== "unsupported";
  const installLabel = record?.status === "inactive" ? "Activate" : record?.status === "error" ? "Retry" : "Install";
  return `
              <tr>
                <td class="site-cell">${esc(site.domain)}</td>
                <td class="type-cell">${esc(site.application || "WordPress")}</td>
                <td data-label="Site user">${esc(site.user)}</td>
                <td data-label="Sign-in helper">${site.helper
                  ? '<span class="badge state-done">Installed</span>'
                  : '<span class="badge">Not installed</span>'}</td>
                <td class="varnish-cell" data-label="Varnish">
                  ${site.varnishCache ? `<div class="varnish-status"${record?.checkedAt ? ` title="Last checked: ${esc(record.checkedAt)}"` : ""}><span class="badge ${record?.status === "active" ? "state-done" : ""}">${esc(status)}</span></div>
                  ${record?.error ? `<div class="varnish-error">${esc(record.error)}</div>` : ""}
                  <label class="varnish-include"><input type="checkbox" data-domain="${esc(site.domain)}" ${site.varnishExcluded ? "" : "checked"} onchange="setVarnishSite(this)"> Include in automatic installation</label>`
                    : '<span class="toolbar-note">Disabled in CloudPanel</span>'}
                </td>
                <td class="action-cell"><div class="wp-actions">
                  ${install ? `<button class="btn" type="button" data-domain="${esc(site.domain)}" onclick="installVarnish(this)">${installLabel} Varnish</button>` : ""}
                  <button class="btn" type="button" data-domain="${esc(site.domain)}" onclick="signIn(this)">Sign in</button>
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
              <th>Domain</th>
              <th>Application</th>
              <th>Site user</th>
              <th>Sign-in helper</th>
              <th>Varnish</th>
              <th class="text-end">Action</th>
            </tr>
          </thead>
          <tbody>${sites.map(siteRow).join("")}
          </tbody>
        </table>
      </div>
    </div>`;
}

function removeCard(sites: WpSiteView[]): string {
  const installed = sites.filter((site) => site.helper).length;
  if (installed === 0) return "";
  return `
    <div class="card">
      <div class="card-header"><h2>The helper</h2></div>
      <div class="remove-row">
        <p>A must-use plugin sits in ${installed} site${installed === 1 ? "" : "s"} so a sign-in can be accepted. It does nothing on any other request, and uninstalling this addon removes it everywhere.</p>
        <button class="btn" type="button" onclick="removeHelpers(this)">Remove from every site</button>
      </div>
    </div>`;
}

function varnishCard(state: WpVarnishState): string {
  return `<div class="card">
    <div class="card-header"><h2>CLP Varnish Cache</h2></div>
    <div class="varnish-settings">
      <div class="switch-row"><h3>Install automatically</h3>
        <label class="switch"><input type="checkbox" aria-label="Install CLP Varnish Cache automatically" ${state.enabled ? "checked" : ""} onchange="setVarnishAutomatic(this)"><span></span></label>
      </div>
      <p>Install and activate the official plugin on existing and new WordPress sites with Varnish enabled in CloudPanel.</p>
      <div class="varnish-settings-footer"><p class="hint">Checks run every 15 minutes. Manual deactivation and removal are respected. Manage plugin updates in WordPress.</p>
        <button class="btn" type="button" ${state.enabled ? "" : "disabled"} onclick="syncVarnishSites(this)">Check sites now</button></div>
    </div>
  </div>`;
}

export function dashboardView(sites: WpSiteView[], varnish: WpVarnishState = { enabled: false, excluded: [], sites: {} }): string {
  return `
    <div class="page-heading">
      <div>
        <h1>WordPress Tools</h1>
        <p>One-click administrator sign-in and Varnish integration for your WordPress sites.</p>
      </div>
    </div>${varnishCard(varnish)}${sitesCard(sites)}${removeCard(sites)}`;
}

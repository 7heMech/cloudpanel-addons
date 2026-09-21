import { esc } from "../../../lib/app-http";
import { CARRIED_FLASH_JS, renderLayout } from "../../../lib/app-ui";
import { mountPath } from "../../../lib/mount";
import type { WpSiteView } from "../action";

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
    brand: "WordPress Sign-In",
    base: BASE,
    nav: [],
    css: STYLE,
    script: SCRIPT,
    updateNotice,
  });
}

function siteRow(site: WpSiteView): string {
  return `
              <tr>
                <td class="site-cell">${esc(site.domain)}</td>
                <td class="type-cell">${esc(site.application || "WordPress")}</td>
                <td data-label="Site user">${esc(site.user)}</td>
                <td data-label="Helper">${site.helper
                  ? '<span class="badge state-done">Installed</span>'
                  : '<span class="badge">Not installed</span>'}</td>
                <td class="action-cell">
                  <button class="btn" type="button" data-domain="${esc(site.domain)}" onclick="signIn(this)">Sign in</button>
                </td>
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
        <table class="fleet-table">
          <thead>
            <tr>
              <th>Domain</th>
              <th>Application</th>
              <th>Site user</th>
              <th>Helper</th>
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

export function dashboardView(sites: WpSiteView[]): string {
  return `
    <div class="page-heading">
      <div>
        <h1>WordPress Sign-In</h1>
        <p>Open any WordPress on this server as its first administrator, without its password.</p>
      </div>
    </div>${removeCard(sites)}${sitesCard(sites)}`;
}

import CLIENT_JS_BODY from "./views.client.js" with { type: "text" };
import { esc } from "../../../lib/app-http";
import {
  FLEET_FOOTER_HTML, FLEET_SELECTION_HTML, FLEET_ROW_SELECTION_JS, fleetFilterHtml, renderLayout,
} from "../../../lib/app-ui";
import { mountPath } from "../../../lib/mount";
import type { FirewallPageState } from "./service";

const BASE = mountPath("firewall");
const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;

import STYLE from "./views.css" with { type: "text" };

// One criterion, so a toggle rather than a menu; it keeps the shared filter's
// contract, a checkbox inside #fleet-show, so search, count and selection treat it alike.
const OFF_ONLY_HTML = `<label class="btn cf-off-only" id="fleet-show"><input class="visually-hidden" type="checkbox" value="off" data-group="Status" onchange="pickFleetFilter()">Off only</label>`;

export const CLIENT_JS = `
${FLEET_ROW_SELECTION_JS}
${CLIENT_JS_BODY}`;

export function layout(title: string, content: string, updateNotice?: { current: string; latest: string } | null): string {
  return renderLayout(title, content, {
    base: BASE,
    css: STYLE,
    script: CLIENT_JS,
    updateNotice,
  });
}

/** The Protocol switch, and the UDP ports its choices open. */
function protocolsCard(status: FirewallPageState["protocols"]): string {
  const link = `<a href="/admin/firewall">Firewall</a>`;
  const detail = "error" in status
    ? `<p class="hint">The protocols could not be read: ${esc(status.error)}</p>`
    : !status.available
      ? '<p class="hint">ufw is not installed on this server.</p>'
      : status.enabled && status.udpPorts.length
        ? `<p class="hint">UDP ports open: ${esc(status.udpPorts.join(", "))}.</p>`
        : "";
  const on = !("error" in status) && status.enabled;
  return `
    <div class="card split-card cf-policy">
      <div><h2>Protocols</h2>
        <p class="hint">Each rule on CloudPanel's ${link} page gets a Protocol: TCP, UDP or both. Off, every rule is TCP again; the choices are kept.</p>${detail}</div>
      <label class="switch"><input id="protocols-switch" type="checkbox" aria-label="Protocols on CloudPanel's Firewall page" ${on ? "checked" : ""} ${"error" in status ? "disabled" : ""} onchange="setProtocols(this)"><span></span></label>
    </div>`;
}

export function dashboardView(state: FirewallPageState): string {
  const enabled = state.sites.filter((site) => site.enabled).length;
  const total = state.sites.length;
  const summary = `${enabled} of ${total} are Cloudflare only`;
  // From six sites the count shares the search's row; below that it stays under the title.
  const filter = fleetFilterHtml({ count: total, summary: `${plural(total, "site")} · ${enabled} Cloudflare only` })
    .replace('<span class="hint" id="fleet-summary"', `${OFF_ONLY_HTML}$&`);
  const rows = state.sites.map((site) => `
    <tr data-domain="${esc(site.domain)}" data-enabled="${site.enabled}" data-show="${site.enabled ? "on" : "off"}" data-sort-enabled="${site.enabled ? "on" : "off"}" tabindex="0" aria-selected="false" onclick="toggleSiteSelection(event, this)" onkeydown="toggleSiteSelection(event, this)">
      <td class="site-select"><input class="site-checkbox" type="checkbox" onchange="paintFleetSelection()" aria-label="Select ${esc(site.domain)}"></td>
      <td class="site-cell"><span class="site-name">${esc(site.domain)}</span></td>
      <td class="action-cell" data-label="Cloudflare only">
        <label class="switch"><input class="site-switch" id="cf-switch-${esc(site.domain)}" type="checkbox" aria-label="Cloudflare-only access for ${esc(site.domain)}" ${site.enabled ? "checked" : ""} onchange="setOne(this)"><span></span></label>
      </td>
    </tr>`).join("");

  return `
    <div class="page-heading">
      <div><h1>Firewall</h1><p>CloudPanel's “Allow traffic from Cloudflare only” setting for every site, and a protocol for each rule on its Firewall page.</p></div>
    </div>
    <div class="card card-table">
      ${total === 0
        ? '<div class="empty">No sites found in CloudPanel.</div>'
        : `<div class="card-header toolbar">
            <div><h2>Sites</h2>${filter ? "" : `<p class="hint" id="cf-summary">${esc(summary)}</p>`}</div>
            ${FLEET_SELECTION_HTML}
            <div class="actions toolbar-actions">
              <button class="btn" id="enable-selected" type="button" disabled data-needs-selection onclick="setSelectedSites(true)">Enable selected</button>
              <button class="btn" id="disable-selected" type="button" disabled data-needs-selection onclick="setSelectedSites(false)">Disable selected</button>
            </div>
          </div>
          ${filter}
          <div class="table-scroll"><table class="fleet-table cloudflare-site-table">
            <thead><tr>
              <th scope="col" class="site-select"><input id="select-all" type="checkbox" onchange="selectAllSites(this.checked)" aria-label="Select all sites"></th>
              <th scope="col" data-sort="domain">Site</th><th scope="col" class="action-cell" data-sort="enabled">Cloudflare only</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table></div>
          ${FLEET_FOOTER_HTML}`}
    </div>
    <div class="card split-card cf-policy">
      <div><h2>Enable on new sites</h2>
        <p class="hint">A site created from now on allows Cloudflare only, seconds after CloudPanel creates it. A site you turn off here is never turned back on.</p></div>
      <label class="switch"><input id="automatic-policy" type="checkbox" aria-label="Enable Cloudflare-only access on new sites" ${state.autoEnableNewSites ? "checked" : ""} onchange="setAutomatic(this)"><span></span></label>
    </div>${protocolsCard(state.protocols)}`;
}

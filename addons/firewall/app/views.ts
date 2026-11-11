import CLIENT_JS_BODY from "./views.client.js" with { type: "text" };
import { esc } from "../../../lib/app-http";
import {
  FLEET_FOOTER_HTML, FLEET_SELECTION_HTML, FLEET_ROW_SELECTION_JS, fleetFilterHtml, renderLayout,
} from "../../../lib/app-ui";
import { mountPath } from "../../../lib/mount";
import type { FirewallPageState } from "./service";
import { HETZNER_ROLES, type HetznerRole } from "../hetzner";

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

/** Hetzner has no prefilled token form, and a project's token page needs the project's id, which neither the API nor the metadata service gives. */
const HETZNER_CONSOLE = "https://console.hetzner.com/projects";

type ConnectedView = Extract<FirewallPageState["hetzner"], { state: "connected" }>;

/** DNS's Connect Cloudflare dialog, for Hetzner. */
function connectDialog(serverName: string | null, replacing: boolean): string {
  const holder = serverName ? `<strong>${esc(serverName)}</strong>` : "this server";
  return `
  <dialog id="hz-connect-dialog" aria-labelledby="hz-connect-heading"><form id="hetzner-token-form" onsubmit="connectHetzner(event)">
    <div class="dialog-header"><h2 id="hz-connect-heading">${replacing ? "Replace the Hetzner token" : "Connect Hetzner"}</h2></div>
    <ol class="hz-steps">
      <li><strong>Create a token in this server's project</strong>
        <p class="hint">Open the project that holds ${holder}, then Security → API tokens → Generate API token. Choose Read &amp; Write.</p>
        <a class="btn" href="${HETZNER_CONSOLE}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">Open Hetzner Console ↗</a></li>
      <li><strong>Paste it here</strong>
        <div class="form-field hz-token-field"><label for="hetzner-token">API token</label>
          <input id="hetzner-token" name="token" type="password" autocomplete="new-password" spellcheck="false" required></div></li>
    </ol>
    <div class="actions dialog-actions"><button class="btn" type="button" onclick="this.closest('dialog').close()">Cancel</button><button class="btn btn-primary" type="submit">Connect</button></div>
  </form></dialog>`;
}

/** The review a switch opens, in sections: what changes, the names that stop answering, and what closes. */
const REVIEW_DIALOG = `
  <dialog id="hz-review" aria-labelledby="hz-review-title"><form method="dialog">
    <div class="dialog-header"><h2 id="hz-review-title"></h2></div>
    <p id="hz-review-text"></p>
    <div id="hz-review-list-wrap" hidden><h3 class="hz-review-label" id="hz-review-label"></h3><ul class="hz-review-list" id="hz-review-list"></ul></div>
    <div class="notice hz-review-warn" id="hz-review-warn" hidden></div>
    <p class="hint" id="hz-review-way-back" hidden></p>
    <div class="form-field" id="hz-review-typed-field" hidden>
      <label for="hz-review-typed">Type <strong id="hz-review-typed-word"></strong> to confirm</label>
      <input id="hz-review-typed" autocomplete="off" autocapitalize="off" spellcheck="false">
    </div>
    <div class="actions dialog-actions">
      <button class="btn" type="button" onclick="this.closest('dialog').close('cancel')">Cancel</button>
      <button class="btn btn-primary" id="hz-review-accept" value="accept" type="submit">Turn on</button>
    </div>
  </form></dialog>`;

const ROLE_HINTS: Record<HetznerRole, string> = {
  web: "Ports 80 and 443 answer only Cloudflare, so a site must be proxied through it.",
  panel: "Port 8443 answers only Cloudflare; CloudPanel answers at its custom domain.",
};

function roleRows(view: ConnectedView): string {
  return (Object.keys(HETZNER_ROLES) as HetznerRole[]).map((role) => {
    const info = view.roles[role];
    const notes = [
      ...info.stillOpen.map((line) => `${line} Until that changes, this firewall has no effect.`),
      ...(info.current ? [] : ["Its rules differ from Cloudflare's list; the next repair puts them back."]),
    ].map((line) => `<p class="hint tone-warn">${esc(line)}</p>`).join("");
    const attached = info.on && info.firewall ? esc(info.firewall) : info.open ? `${esc(info.open)} · open to anyone` : "";
    const title = HETZNER_ROLES[role].title;
    return `
      <div class="hz-row">
        <div><h3>${title}</h3><p class="hint">${ROLE_HINTS[role]}</p>${attached ? `<p class="hint hz-fw-name">${attached}</p>` : ""}${notes}</div>
        <label class="switch"><input id="hetzner-${role}" type="checkbox" aria-label="${title}" ${info.on ? "checked" : ""} onchange="setHetzner(this, '${role}')"><span></span></label>
      </div>`;
  }).join("");
}

function problems(view: ConnectedView): string {
  const ports = view.sshClosed;
  const ssh = ports.length
    ? `<div class="notice" role="status">SSH is closed: no firewall on this server allows port ${esc(ports.join(", "))}, so site users cannot connect over SFTP. ${view.terminal
      ? `For a root shell, use <a href="${mountPath("terminal")}/">Terminal</a>.` : "Allow it in another firewall in Hetzner Console to open it again."}</div>`
    : "";
  return ssh + (view.rangesProblem ? `<div class="notice" role="status">${esc(view.rangesProblem)}</div>` : "");
}

/** The Hetzner Cloud Firewall card: connect a token in a dialog, then a switch for the sites and one for the panel. */
function hetznerCard(view: FirewallPageState["hetzner"]): string {
  const openConnect = "CLP_ROOT.getElementById('hz-connect-dialog').showModal()";
  const tokenButtons = `
      <div class="actions hz-token-actions">
        <button class="btn" type="button" onclick="${openConnect}">Replace token</button>
        <button class="btn btn-danger" type="button" onclick="removeHetznerToken()">Remove token</button>
      </div>`;
  const card = (body: string, headerActions = "", dialogs = "") => `
    <div class="card hz-card" id="hetzner-card">
      <div class="card-header"><h2>Hetzner Cloud Firewall</h2>${headerActions}</div>
      <p class="hint hz-intro">Hetzner drops what these firewalls do not allow before it reaches this server.</p>${body}
    </div>${dialogs}`;
  if (view.state === "absent") {
    return card('<p class="hz-absent">This server is not a Hetzner Cloud server, so there is nothing to set here. Dedicated (Robot) servers are not covered.</p>');
  }
  if (view.state === "disconnected") {
    const holder = view.serverName ? `<strong>${esc(view.serverName)}</strong>` : "this server";
    return card(`<div class="hz-connect"><p class="hint">Connect an API token from the Hetzner project that holds ${holder}; then turn on the firewalls you want.</p>
        <button class="btn btn-primary" type="button" onclick="${openConnect}">Connect Hetzner</button></div>`, "", connectDialog(view.serverName, false));
  }
  if (view.state === "error") {
    return card(`<div class="alert" role="alert">${esc(view.error)}</div>`, view.connected ? tokenButtons : "", view.connected ? connectDialog(null, true) : "");
  }
  const others = view.others.length ? `Also attached to ${esc(view.serverName)}: ${view.others.map(esc).join(", ")}.` : `No other firewall is attached to ${esc(view.serverName)}.`;
  return card(`${problems(view)}${roleRows(view)}<p class="hint hz-foot">Connected to the project of ${esc(view.serverName)}. ${others}</p>`,
    tokenButtons, `${connectDialog(view.serverName, true)}${REVIEW_DIALOG}`);
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
      <div><h1>Firewall</h1><p>CloudPanel's “Allow traffic from Cloudflare only” setting for every site, a protocol for each rule on its Firewall page, and Hetzner Cloud Firewalls that admit only Cloudflare.</p></div>
    </div>
    <div class="card card-table">
      ${total === 0
        ? '<div class="empty">No sites found in CloudPanel.</div>'
        : `<div class="card-header toolbar">
            <div><h2>Cloudflare only</h2>${filter ? "" : `<p class="hint" id="cf-summary">${esc(summary)}</p>`}</div>
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
    </div>${protocolsCard(state.protocols)}${hetznerCard(state.hetzner)}`;
}

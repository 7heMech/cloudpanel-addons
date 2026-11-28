import CLIENT_JS_BODY from "./views.client.js" with { type: "text" };
import { esc } from "../../../lib/app-http";
import {
  badgeHtml, FLEET_FOOTER_HTML, FLEET_SELECTION_HTML, FLEET_ROW_SELECTION_JS, fleetFilterHtml, renderLayout, sectionShellHtml,
  type SectionTab,
} from "../../../lib/app-ui";
import {
  CLOUDFLARE_SCOPE_JS, cloudflareAccessDetailsHtml, cloudflareConnectDialogHtml,
} from "../../../lib/cloudflare/connect-dialog";
import { SSL_LABELS } from "../../../lib/cloudflare/edge";
import { mountPath } from "../../../lib/mount";
import type { LockState } from "../../../lib/root-locks";
import type { FirewallPageState } from "./service";
import type { EdgeLogEntry, EdgePageView, EdgeZoneStatus } from "../edge";
import { CLOUD_ROLES, ROLES, type CloudConnectedView, type CloudRole } from "../cloud-firewall";
import { NETCUP_HOST } from "../netcup-api";

const BASE = mountPath("firewall");
const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;
const CLIPBOARD = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8.5" rx="1.5"/><path d="M10.5 5.5V3.5a1.5 1.5 0 0 0-1.5-1.5H3.5A1.5 1.5 0 0 0 2 3.5V9a1.5 1.5 0 0 0 1.5 1.5h2"/></svg>';

import STYLE from "./views.css" with { type: "text" };

// One criterion, so a toggle rather than a menu; it keeps the shared filter's
// contract, a checkbox inside #fleet-show, so search, count and selection treat it alike.
const OFF_ONLY_HTML = `<label class="btn cf-off-only" id="fleet-show"><input class="visually-hidden" type="checkbox" value="off" data-group="Status" onchange="pickFleetFilter()">Off only</label>`;

export const CLIENT_JS = `
${FLEET_ROW_SELECTION_JS}
${CLOUDFLARE_SCOPE_JS}
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

const WAY_BACK = "Shut out? <code>ssh -L 8443:127.0.0.1:8443 root@&lt;server&gt;</code>, then open https://127.0.0.1:8443, or run <code>clp-addons firewall panel-gate off</code> as root.";

/** The Panel gate: what it needs, or what differs from what it set up. */
export function panelGateCard(view: FirewallPageState["panelGate"]): string {
  const pending = !("error" in view) && view.pending;
  const card = (body: string, on: boolean, ready: boolean) => `
    <div class="card hz-card" id="panel-gate-card"${pending ? " data-pending" : ""}>
      <div class="hz-row hz-first">
        <div><h2>Panel gate</h2>
          <p class="hint">Only requests through Cloudflare for CloudPanel's custom domain, after a Cloudflare Access sign-in with a code sent to a panel user's email, reach the panel. Opening it at the server's IP on port 8443 stops working.</p></div>
        <label class="switch"><input id="panel-gate-switch" type="checkbox" aria-label="Panel gate" ${on ? "checked" : ""} ${ready ? "" : "disabled"} onchange="setPanelGate(this)"><span></span></label>
      </div>${body}
      <p class="hint pg-way-back">${WAY_BACK}</p>
    </div>`;
  if ("error" in view) return card(`<div class="alert" role="alert">${esc(view.error)}</div>`, false, false);
  const list = (lines: string[]) => `<ul class="pg-list">${lines.map((line) => `<li>${esc(line)}</li>`).join("")}</ul>`;
  const leftover = view.leftover ? '<div class="notice" role="status">Cloudflare still has the Access application or origin-pull certificate of a gate turned off; the next repair deletes them.</div>' : "";
  if (view.on) {
    const checked = view.checkedAt ? ` Cloudflare checked ${esc(view.checkedAt.replace("T", " ").slice(0, 16))} UTC.` : "";
    const drift = view.drift.length ? `<div class="pg-drift">${list(view.drift)}</div>` : "";
    return card(`<p class="hint pg-lead">On for <strong>${esc(view.hostname ?? "")}</strong>.${checked}</p>${drift}`, true, true);
  }
  if (view.pending) return card(`${leftover}<p class="hint pg-lead" role="status">Checking what it needs in Cloudflare…</p>`, false, false);
  if (view.problems.length) {
    const edit = view.editUrl ? ` <a href="${esc(view.editUrl)}" target="_blank" rel="noopener">Edit the token in Cloudflare</a>.` : "";
    return card(`${leftover}<p class="hint pg-lead">Before it can be turned on:${edit}</p>${list(view.problems)}`, false, false);
  }
  return card(`${leftover}<p class="hint pg-lead">Ready for <strong>${esc(view.hostname ?? "")}</strong>.</p>`, false, true);
}

/** Hetzner has no prefilled token form, and a project's token page needs the project's id, which neither the API nor the metadata service gives. */
const HETZNER_CONSOLE = "https://console.hetzner.com/projects";

type ConnectedView = CloudConnectedView;
type Provider = "hetzner" | "netcup";

/** How a provider's card speaks, where the two differ. */
const CARD: Record<Provider, { title: string; intro: string; noun: string; on: string; sshFix: string }> = {
  hetzner: {
    title: "Hetzner Cloud Firewall",
    intro: "Hetzner drops what these firewalls do not allow before it reaches this server.",
    noun: "firewall", on: "is attached too",
    sshFix: "Allow it in another firewall in Hetzner Console to open it again.",
  },
  netcup: {
    title: "netcup firewall",
    intro: "netcup drops what these policies do not allow before it reaches this server.",
    noun: "policy", on: "is on this server too",
    sshFix: "Allow it in a policy in SCP to open it again.",
  },
};

/** DNS's Connect Cloudflare dialog, for Hetzner. */
function connectDialog(serverName: string | null, replacing: boolean): string {
  const holder = serverName ? `<strong>${esc(serverName)}</strong>` : "this server";
  return `
  <dialog id="hz-connect-dialog" aria-labelledby="hz-connect-heading" onclose="resetHetznerConnect(this)"><form id="hetzner-token-form" onsubmit="connectHetzner(event)">
    <div class="dialog-header"><h2 id="hz-connect-heading">${replacing ? "Replace the Hetzner token" : "Connect Hetzner"}</h2></div>
    <ol class="hz-steps">
      <li><strong>Create a token in this server's project</strong>
        <p class="hint">Open the project that holds ${holder}, then Security → API tokens → Generate API token. Choose Read &amp; Write.</p>
        <a class="btn" href="${HETZNER_CONSOLE}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">Open Hetzner Console ↗</a></li>
      <li><strong>Paste it here</strong>
        <div class="form-field hz-token-field"><label for="hetzner-token">API token</label>
          <input id="hetzner-token" name="token" type="password" autocomplete="new-password" spellcheck="false" required></div></li>
    </ol>
    <div class="alert hz-connect-error" id="hz-connect-error" role="alert" hidden></div>
    <div class="actions dialog-actions"><button class="btn" type="button" onclick="this.closest('dialog').close()">Cancel</button><button class="btn btn-primary" type="submit">Connect</button></div>
  </form></dialog>`;
}

/** netcup's device sign-in: the page fills in the link and the code, then waits for netcup. */
const NETCUP_DIALOG = `
  <dialog id="nc-connect-dialog" aria-labelledby="nc-connect-heading" onclose="stopNetcupConnect()"><form method="dialog">
    <div class="dialog-header"><h2 id="nc-connect-heading">Connect netcup</h2></div>
    <ol class="hz-steps">
      <li><strong>Sign in to netcup</strong>
        <p class="hint">Use the customer number of the account that holds this server.</p>
        <a class="btn" id="nc-connect-link" href="${NETCUP_HOST}/" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">Open netcup ↗</a></li>
      <li><strong>Check the code and grant access</strong>
        <p class="hint">netcup shows <strong class="nc-code" id="nc-connect-code"></strong>.</p></li>
    </ol>
    <p class="hint nc-connect-status" id="nc-connect-status" role="status">Waiting for netcup…</p>
    <div class="alert hz-connect-error" id="nc-connect-error" role="alert" hidden></div>
    <div class="actions dialog-actions"><button class="btn" type="button" onclick="this.closest('dialog').close()">Cancel</button></div>
  </form></dialog>`;

/** The review a cloud firewall switch opens. */
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

/** Confirmation dialog for Cloudflare edge defaults approval, updates, and guarded per-zone changes. */
const EDGE_REVIEW_DIALOG = `
  <dialog id="fw-edge-review-dialog" class="fw-edge-review-dialog" aria-labelledby="fw-edge-review-title">
    <div class="dialog-header"><h2 id="fw-edge-review-title">Review Cloudflare edge changes</h2></div>
    <p id="fw-edge-review-text"></p>
    <div class="notice fw-edge-review-warnings" id="fw-edge-review-warnings" hidden></div>
    <div class="fw-edge-review-zones" id="fw-edge-review-zones"></div>
    <div class="actions dialog-actions">
      <button class="btn" type="button" onclick="this.closest('dialog').close()">Cancel</button>
      <button class="btn btn-primary" id="fw-edge-review-confirm" type="button" onclick="fwConfirmEdge()">Confirm</button>
    </div>
  </dialog>`;

const ROLE_HINTS: Record<CloudRole, string> = {
  web: "Ports 80 and 443 answer only Cloudflare, so a site must be proxied through it.",
  panel: "Port 8443 answers only Cloudflare; CloudPanel answers at its custom domain.",
};

function roleRows(provider: Provider, view: ConnectedView): string {
  const words = CARD[provider];
  return ROLES.map((role) => {
    const info = view.roles[role];
    const notes = [
      ...info.stillOpen.map((line) => `${line} Until that changes, this ${words.noun} has no effect.`),
      ...(info.current ? [] : ["Its rules differ from Cloudflare's list; the next repair puts them back."]),
      ...(info.on && info.open ? [`${info.open} ${words.on} and lets anyone in; the next repair takes it off.`] : []),
    ].map((line) => `<p class="hint tone-warn">${esc(line)}</p>`).join("");
    const attached = [info.on && info.firewall ? esc(info.firewall) : "", info.open ? `${esc(info.open)} · open to anyone` : ""].filter(Boolean).join("<br>");
    const title = CLOUD_ROLES[role].title;
    return `
      <div class="hz-row">
        <div><h3>${title}</h3><p class="hint">${ROLE_HINTS[role]}</p>${attached ? `<p class="hint hz-fw-name">${attached}</p>` : ""}${notes}</div>
        <label class="switch"><input id="${provider}-${role}" type="checkbox" aria-label="${title}" ${info.on ? "checked" : ""} ${view.blocked ? "disabled" : ""} onchange="setCloud(this, '${provider}', '${role}')"><span></span></label>
      </div>`;
  }).join("");
}

function problems(provider: Provider, view: ConnectedView): string {
  const ports = view.sshClosed;
  const blocked = view.blocked ? `<div class="notice" role="status">${esc(view.blocked)}</div>` : "";
  const ssh = ports.length
    ? `<div class="notice" role="status">SSH is closed: no ${CARD[provider].noun} on this server allows port ${esc(ports.join(", "))}, so site users cannot connect over SFTP. ${view.terminal
      ? `<a href="${mountPath("terminal")}/">Terminal</a> gives a root shell to an administrator root allows one.` : CARD[provider].sshFix}</div>`
    : "";
  return blocked + ssh + (view.rangesProblem ? `<div class="notice" role="status">${esc(view.rangesProblem)}</div>` : "");
}

function providerCard(provider: Provider, body: string, headerActions = "", dialogs = ""): string {
  return `
    <div class="card hz-card" id="${provider}-card">
      <div class="card-header"><h2>${CARD[provider].title}</h2>${headerActions}</div>
      <p class="hint hz-intro">${CARD[provider].intro}</p>${body}
    </div>${dialogs}`;
}

/** The Hetzner Cloud Firewall card: connect a token in a dialog, then a switch for the sites and one for the panel. */
function hetznerCard(view: FirewallPageState["hetzner"]): string {
  const openConnect = "CLP_ROOT.getElementById('hz-connect-dialog').showModal()";
  const tokenButtons = `
      <div class="actions hz-token-actions">
        <button class="btn" type="button" onclick="${openConnect}">Replace token</button>
        <button class="btn btn-danger" type="button" onclick="removeHetznerToken()">Remove token</button>
      </div>`;
  const card = (body: string, headerActions = "", dialogs = "") => providerCard("hetzner", body, headerActions, dialogs);
  if (view.state === "absent") return "";
  if (view.state === "disconnected") {
    const holder = view.serverName ? `<strong>${esc(view.serverName)}</strong>` : "this server";
    return card(`<div class="hz-connect"><p class="hint">Connect an API token from the Hetzner project that holds ${holder}; then turn on the firewalls you want.</p>
        <button class="btn btn-primary" type="button" onclick="${openConnect}">Connect Hetzner</button></div>`, "", connectDialog(view.serverName, false));
  }
  if (view.state === "error") {
    return card(`<div class="alert" role="alert">${esc(view.error)}</div>`, view.connected ? tokenButtons : "", view.connected ? connectDialog(null, true) : "");
  }
  const others = view.others.length ? `Also attached to ${esc(view.serverName)}: ${view.others.map(esc).join(", ")}.` : `No other firewall is attached to ${esc(view.serverName)}.`;
  return card(`${problems("hetzner", view)}${roleRows("hetzner", view)}<p class="hint hz-foot">Connected to the project of ${esc(view.serverName)}. ${others}</p>`,
    tokenButtons, connectDialog(view.serverName, true));
}

/** The netcup firewall card: sign in with a code netcup shows, then a switch for the sites and one for the panel. */
function netcupCard(view: FirewallPageState["netcup"]): string {
  const signInButtons = `
      <div class="actions hz-token-actions">
        <button class="btn" type="button" onclick="startNetcupConnect()">Connect again</button>
        <button class="btn btn-danger" type="button" onclick="removeNetcupSignIn()">Disconnect</button>
      </div>`;
  const card = (body: string, headerActions = "") => providerCard("netcup", body, headerActions, NETCUP_DIALOG);
  if (view.state === "absent") return "";
  if (view.state === "disconnected") {
    const address = view.address ? ` (<strong>${esc(view.address)}</strong>)` : "";
    return card(`<div class="hz-connect"><p class="hint">Sign in to the netcup account that holds this server${address}; then turn on the policies you want.</p>
        <button class="btn btn-primary" type="button" onclick="startNetcupConnect()">Connect netcup</button></div>`);
  }
  if (view.state === "error") return card(`<div class="alert" role="alert">${esc(view.error)}</div>`, view.connected ? signInButtons : "");
  const others = view.others.length ? `Also on it: ${view.others.map(esc).join(", ")}.` : "No other policy is on it.";
  return card(`${problems("netcup", view)}${roleRows("netcup", view)}<p class="hint hz-foot">Connected to netcup; this server is ${esc(view.serverName)} there. ${others}</p>`, signInButtons);
}

function panelGateAttention(view: FirewallPageState["panelGate"]): "bad" | "warn" | undefined {
  if ("error" in view) return "bad";
  if ((view.on && view.drift.length > 0) || view.leftover) return "warn";
  return undefined;
}

function edgeAttention(view: FirewallPageState["cloudflareEdge"]): "bad" | "warn" | undefined {
  if ("error" in view) return "bad";
  if (!view.connected) return undefined;
  if (view.zones.some((zone) => zone.status === "error" || zone.status === "conflict")) return "bad";
  if (view.zones.some((zone) => zone.status === "needs_review") || view.needsApproval || Boolean(view.migrationNote)) return "warn";
  return undefined;
}

function cloudProviderAttention(view: FirewallPageState["hetzner"] | FirewallPageState["netcup"]): "bad" | "warn" | undefined {
  if (view.state === "error") return "bad";
  if (view.state !== "connected") return undefined;
  if (
    view.blocked
    || view.sshClosed.length > 0
    || view.rangesProblem
    || ROLES.some((role) => {
      const info = view.roles[role];
      return info.stillOpen.length > 0 || !info.current || (info.on && Boolean(info.open));
    })
  ) return "warn";
  return undefined;
}

function cloudAttention(state: FirewallPageState): "bad" | "warn" | undefined {
  const tones = [cloudProviderAttention(state.netcup), cloudProviderAttention(state.hetzner)];
  if (tones.includes("bad")) return "bad";
  return tones.includes("warn") ? "warn" : undefined;
}

function visitorIpCard(state: FirewallPageState["visitorIp"], lock: LockState): string {
  const line = state.problem
    ? `${badgeHtml("Unknown", "warn")} <span>${esc(state.problem)}</span>`
    : state.enabled && state.applied
      ? `${badgeHtml("On", "ok")} <span>Behind Cloudflare, sites see the visitor's IP.</span>`
      : state.enabled
        ? `${badgeHtml("Not applied", "warn")} <span>Run clp-addons repair.</span>`
        : `${badgeHtml("Off", "plain")} <span>Behind Cloudflare, sites see Cloudflare's or the tunnel's address.</span>`;
  const locked = lock !== "unlocked" && state.enabled;
  const lockHint = lock === "damaged"
    ? '<p class="hint tone-warn">The root lock file cannot be trusted, so this switch can only go on until root fixes /etc/clp-addons/locks.json.</p>'
    : locked
      ? '<p class="hint">Locked by root. Run <code>clp-addons unlock firewall</code> on the server to switch it off.</p>'
      : "";
  return `
    <div class="card split-card cf-policy" id="visitor-ip-card">
      <div><h2>Cloudflare visitor IPs</h2>
        <p class="hint">Site access logs and PHP take the visitor's IP from CF-Connecting-IP when Cloudflare's proxy or a Cloudflare Tunnel on this server sent the request. Anyone else's header is ignored, and so is an X-Real-IP sent through a tunnel.</p>
        <p class="hint">Error logs, Cloudflare-only access and CloudPanel's IP rules still see the connecting address. In a vhost's port 8080 server that is 127.0.0.1, so keep rules you add by IP in its first server.</p>
        <p class="fw-status">${line}</p>${lockHint}</div>
      <label class="switch"><input id="visitor-ip-switch" type="checkbox" aria-label="Cloudflare visitor IPs" ${state.enabled ? "checked" : ""} ${locked ? "disabled" : ""} onchange="setVisitorIp(this)"><span></span></label>
    </div>`;
}

function cloudflareConnectionsCard(cf: FirewallPageState["cloudflare"]): string {
  const rows = cf.connections.map((connection) => {
    const accounts = connection.accounts.map((account) => account.name || account.id).join(", ");
    const status = connection.active ? '<span class="tone-ok">Active</span>' : `<span class="tone-bad">${esc(connection.status === "unchecked" ? "Not checked" : "Not working")}</span>`;
    const reach = connection.access?.reach ? `${connection.access.reach} · ${plural(connection.zones, "zone")} now` : plural(connection.zones, "zone");
    const line = `${esc(reach)} · ${status}${connection.error ? ` · ${esc(connection.error)}` : ""}`;
    return `<div class="dns-setting-row dns-connection-row" data-connection="${esc(connection.id)}">
      <div class="dns-setting-main">
        <strong>${esc(connection.label)}</strong>${accounts ? `<span class="hint">${esc(accounts)}</span>` : ""}
        ${connection.access ? cloudflareAccessDetailsHtml(connection.id, connection.access, line, "fw-cf") : `<span class="hint">${line}</span>`}
      </div>
      <div class="actions">
        <button class="btn" type="button" onclick="fwEditCloudflare('${esc(connection.id)}')">Edit</button>
        <button class="btn btn-danger" type="button" onclick="fwRemoveCloudflare('${esc(connection.id)}')">Remove</button>
      </div>
    </div>`;
  }).join("");
  const body = cf.connections.length
    ? `<div class="dns-setting-list">${rows}</div>`
    : `<div class="hz-connect"><p class="hint">Connect a Cloudflare API token once. DNS and Firewall share the same connections.</p>
        <button class="btn btn-primary" type="button" onclick="fwEditCloudflare('')">Connect Cloudflare</button></div>`;
  const headerButton = cf.connections.length
    ? '<button class="btn" type="button" onclick="fwEditCloudflare(\'\')">Add Cloudflare connection</button>'
    : "";
  return `
    <div class="card hz-card" id="fw-cf-card">
      <div class="card-header"><div><h2>Cloudflare connections</h2>
        <p class="hint">Shared with DNS. Used by Cloudflare edge defaults and Panel gate.</p></div>${headerButton}</div>
      ${body}
    </div>`;
}

function formatUtcShort(iso: string | null): string {
  if (!iso) return "";
  return `${iso.replace("T", " ").slice(0, 16)} UTC`;
}

function zoneCurrentSummary(zone: EdgeZoneStatus): string {
  const parts: string[] = [];
  if (zone.current.ssl) parts.push(zone.current.ssl);
  if (zone.current.alwaysHttps) parts.push(`Always HTTPS ${zone.current.alwaysHttps.toLowerCase()}`);
  const rules = [
    zone.current.acmeRule && "Let's Encrypt",
    zone.current.webmailRule && "webmail",
    zone.current.skipIps && zone.current.skipIps.length > 0 && `WAF skip (${zone.current.skipIps.length})`,
  ].filter(Boolean);
  const top = parts.length ? esc(parts.join(" · ")) : '<span class="tone-muted">—</span>';
  const sub = rules.length ? `<span class="hint">${esc(`Rules: ${rules.join(", ")}`)}</span>` : "";
  return `${top}${sub}`;
}

function zoneStatusCell(zone: EdgeZoneStatus, approved: boolean): string {
  if (zone.status === "error") {
    return `${badgeHtml("Error", "bad")}<span class="hint fw-edge-clamp" title="${esc(zone.error ?? "")}">${esc(zone.error ?? "Read failed")}</span>`;
  }
  if (zone.status === "conflict") {
    const first = zone.conflicts[0] ?? "Conflicting Cloudflare rules";
    return `${badgeHtml("Conflict", "bad")}<span class="hint fw-edge-clamp" title="${esc(first)}">${esc(first)}</span>`;
  }
  if (zone.status === "needs_review") {
    const guarded = zone.changes.find((change) => change.destructive || change.conflict);
    const reason = guarded?.reason ?? `${plural(zone.changes.length, "change")} require confirmation`;
    return `${badgeHtml("Needs review", "warn")}<span class="hint fw-edge-clamp" title="${esc(reason)}">${esc(reason)}</span>`;
  }
  if (zone.status === "pending") {
    const hint = approved
      ? `${plural(zone.changes.length, "change")} pending`
      : `${plural(zone.changes.length, "change")} wait for approval`;
    return `${badgeHtml(approved ? "Pending" : "Waiting approval", "warn")}<span class="hint">${esc(hint)}</span>`;
  }
  const extra = zone.zoneStatus !== "active" ? `<span class="hint">Zone ${esc(zone.zoneStatus)}</span>` : "";
  return `${badgeHtml("In sync", "ok")}${extra}`;
}

function zoneActionCell(zone: EdgeZoneStatus, approved: boolean): string {
  if (zone.zoneChoices && zone.zoneChoices.length > 0) {
    const opts = ['<option value="">Choose connection…</option>']
      .concat(zone.zoneChoices.map((choice) =>
        `<option value="${esc(`${choice.connectionId}/${choice.zoneId}`)}">${esc(choice.label)}</option>`))
      .join("");
    return `<select class="fw-edge-choice" aria-label="Choose Cloudflare connection for ${esc(zone.zoneName)}" onchange="fwChooseEdgeZone('${esc(zone.zoneName)}', this)">${opts}</select>`;
  }
  if (approved && (zone.status === "needs_review" || zone.status === "pending")) {
    return `<button class="btn" type="button" onclick="fwReviewEdgeZone('${esc(zone.zoneKey)}')">Review</button>`;
  }
  return '<span class="tone-muted">—</span>';
}

function edgeLogRow(entry: EdgeLogEntry): string {
  const before = entry.before ? `<span class="hint">Was: ${esc(entry.before)}</span>` : "";
  return `<tr>
    <td data-label="Time" class="fw-edge-log-time"><span class="hint">${esc(formatUtcShort(entry.at))}</span></td>
    <td data-label="Zone"><strong>${esc(entry.zone)}</strong><span class="hint">${esc(entry.cause)}</span></td>
    <td data-label="Change">${esc(entry.subject)}: ${esc(entry.detail)}${before}</td>
  </tr>`;
}

function cloudflareEdgePanel(edge: FirewallPageState["cloudflareEdge"], cf: FirewallPageState["cloudflare"]): string {
  if ("error" in edge) {
    return `<div class="card hz-card" id="fw-edge-card"><h2>Cloudflare edge</h2><div class="alert" role="alert">${esc(edge.error)}</div></div>${cloudflareConnectionsCard(cf)}`;
  }

  // Unconfigured state: focused first-run card without empty tables or forms.
  if (!edge.connected) {
    return `
      <div class="card fw-edge-setup" id="fw-edge-card">
        <h2>Cloudflare edge defaults</h2>
        <p class="hint">Set your zone-wide Cloudflare defaults once: SSL/TLS mode, Always Use HTTPS, Full SSL rules for Let's Encrypt and webmail, and WAF skip IPs. Once approved, new Cloudflare zones inherit them automatically while destructive changes and rule conflicts still ask first.</p>
        <div class="actions"><button class="btn btn-primary" type="button" onclick="fwEditCloudflare('')">Connect Cloudflare</button></div>
      </div>`;
  }

  const singleConn = cf.connections.length <= 1;
  const migrationBanner = edge.migrationNote
    ? `<div class="notice fw-edge-notice" role="status">${esc(edge.migrationNote)}</div>`
    : "";

  const approvalBanner = !edge.approved
    ? `<div class="card split-card fw-edge-banner" id="fw-edge-approval-banner">
        <div>
          <div class="fw-edge-banner-head">${badgeHtml("Not approved", "warn")}<h2>Review and approve edge defaults</h2></div>
          <p class="hint">Firewall reads your Cloudflare zones and writes nothing until you approve these defaults once. After approval, new zones inherit them automatically without per-site holds; SSL downgrades, disabling HTTPS, rule removals, and conflicts still ask for confirmation.</p>
        </div>
        <div class="actions fw-edge-banner-actions">
          <button class="btn btn-primary" type="button" onclick="fwSaveEdge(true)">Review and approve</button>
        </div>
      </div>`
    : "";

  const headerStatus = edge.approved
    ? `<p class="hint fw-edge-status-hint">${edge.approvedAt ? `Approved ${esc(formatUtcShort(edge.approvedAt))} · ` : ""}New zones inherit these defaults automatically; destructive changes and conflicts ask first.</p>`
    : `<p class="hint fw-edge-status-hint">These defaults apply to every reachable Cloudflare zone once approved.</p>`;

  const headerActions = edge.approved
    ? `<div class="actions fw-edge-header-actions">
        <button class="btn" type="button" onclick="fwPauseEdge()">Pause automatic</button>
      </div>`
    : "";

  const sslOptions = ['<option value="">Leave as it is</option>']
    .concat(Object.entries(SSL_LABELS).map(([value, label]) =>
      `<option value="${value}"${edge.defaults.ssl === value ? " selected" : ""}>${label}</option>`))
    .join("");
  const httpsVal = edge.defaults.alwaysHttps === null ? "" : edge.defaults.alwaysHttps ? "on" : "off";

  const defaultsCard = `
    <div class="card hz-card" id="fw-edge-card">
      <div class="card-header">
        <div><div class="fw-edge-title-row"><h2>Cloudflare edge defaults</h2>${edge.approved ? badgeHtml("Approved", "ok") : ""}</div>${headerStatus}</div>
        ${headerActions}
      </div>
      ${migrationBanner}
      <form id="fw-edge-form" onsubmit="fwSaveEdgeForm(event)">
        <div class="form-grid fw-edge-grid">
          <div class="form-field">
            <label for="fw-edge-ssl">SSL/TLS mode</label>
            <select id="fw-edge-ssl" name="ssl">${sslOptions}</select>
          </div>
          <div class="form-field">
            <label for="fw-edge-https">Always Use HTTPS</label>
            <select id="fw-edge-https" name="alwaysHttps">
              <option value=""${httpsVal === "" ? " selected" : ""}>Leave as it is</option>
              <option value="on"${httpsVal === "on" ? " selected" : ""}>On</option>
              <option value="off"${httpsVal === "off" ? " selected" : ""}>Off</option>
            </select>
          </div>
        </div>
        <div class="fw-edge-switches">
          <label class="fw-edge-switch-row">
            <span class="switch"><input type="checkbox" name="acmeFullSsl" ${edge.defaults.acmeFullSsl ? "checked" : ""}><span></span></span>
            <span><strong>Full SSL for Let's Encrypt checks</strong><span class="hint">Lets a proxied site issue and renew certificates over HTTP-01 while Full (strict) and Cloudflare-only access are on.</span></span>
          </label>
          <label class="fw-edge-switch-row">
            <span class="switch"><input type="checkbox" name="webmailFullSsl" ${edge.defaults.webmailFullSsl ? "checked" : ""}><span></span></span>
            <span><strong>Full SSL for webmail hosts</strong><span class="hint">Uses Full SSL for proxied <code>webmail.*</code> hostnames whose origin is a mail server.</span></span>
          </label>
        </div>
        <div class="form-field fw-edge-skip-field">
          <label for="fw-edge-skip">Skip the firewall for</label>
          <textarea id="fw-edge-skip" name="skipFirewallIps" rows="2" placeholder="203.0.113.7">${esc(edge.defaults.skipFirewallIps.join("\n"))}</textarea>
          <div class="hint">Optional. One IP per line, such as a MainWP Dashboard. Skips Super Bot Fight Mode and managed WAF rules; Cloudflare cannot skip the free Bot Fight Mode.</div>
        </div>
        <div class="actions fw-edge-form-actions">
          ${edge.approved
            ? '<button class="btn btn-primary" type="submit">Review and save changes</button>'
            : '<button class="btn" type="button" onclick="fwSaveEdge(false)">Save draft</button><button class="btn btn-primary" type="submit">Review and approve defaults</button>'}
        </div>
      </form>
    </div>`;

  const checkedText = edge.checkedAt ? `Checked ${formatUtcShort(edge.checkedAt)}` : "Not checked yet";
  const zoneRows = edge.zones.map((zone) => `
    <tr data-zone-key="${esc(zone.zoneKey)}">
      <td class="site-cell"><strong>${esc(zone.zoneName)}</strong>${!singleConn && zone.connectionLabel ? `<span class="hint">${esc(zone.connectionLabel)}${zone.accountName ? ` · ${esc(zone.accountName)}` : ""}</span>` : zone.accountName ? `<span class="hint">${esc(zone.accountName)}</span>` : ""}</td>
      <td data-label="Current edge">${zoneCurrentSummary(zone)}</td>
      <td data-label="Status">${zoneStatusCell(zone, edge.approved)}</td>
      <td data-label="Action" class="action-cell">${zoneActionCell(zone, edge.approved)}</td>
    </tr>`).join("");

  const zonesCard = `
    <div class="card card-table" id="fw-edge-zones-card">
      <div class="card-header">
        <div><h2>Cloudflare zones</h2><p class="hint">${esc(edge.zones.length ? `${plural(edge.zones.length, "zone")} · ${checkedText}` : checkedText)}</p></div>
        <div class="actions"><button class="btn" type="button" onclick="fwCheckEdge()">Check now</button></div>
      </div>
      ${edge.zones.length
        ? `<div class="table-scroll"><table class="fleet-table fw-edge-zone-table">
            <thead><tr><th scope="col">Zone</th><th scope="col">Current edge</th><th scope="col">Status</th><th scope="col" class="action-cell">Action</th></tr></thead>
            <tbody>${zoneRows}</tbody>
          </table></div>`
        : '<div class="empty">No zones read yet. Choose Check now to inspect reachable Cloudflare zones.</div>'}
    </div>`;

  const logCard = edge.log.length
    ? `<details class="card fw-edge-log-details" id="fw-edge-log">
        <summary><strong>Recent edge changes</strong><span class="hint">${plural(edge.log.length, "change")}</span></summary>
        <div class="table-scroll"><table class="fleet-table fw-edge-log-table"><tbody>${edge.log.slice(0, 20).map(edgeLogRow).join("")}</tbody></table></div>
      </details>`
    : "";

  return `${approvalBanner}${defaultsCard}${zonesCard}${logCard}${cloudflareConnectionsCard(cf)}`;
}

export function dashboardView(state: FirewallPageState, lock: LockState = "unlocked"): string {
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

  const sitesPanel = `
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
    </div>
    ${visitorIpCard(state.visitorIp, lock)}`;

  const netcup = netcupCard(state.netcup);
  const hetzner = hetznerCard(state.hetzner);
  const cloudPanel = `${netcup}${hetzner}`;
  const review = state.hetzner.state === "connected" || state.netcup.state === "connected" ? REVIEW_DIALOG : "";
  const cfData = esc(JSON.stringify({ connections: state.cloudflare.connections.map(({ id, label }) => ({ id, label })), serverIps: state.cloudflare.serverIps }));
  const cfDialog = cloudflareConnectDialogHtml({
    prefix: "fw-cf",
    onSubmit: "fwSaveCloudflare(event)",
    copyFn: "fwCopyText",
    defaultDns: state.cloudflare.dnsEnabled,
    defaultEdge: true,
    defaultPanelGate: true,
    templates: state.cloudflare.templates,
    clipboardIcon: CLIPBOARD,
  }).replace('<dialog id="fw-cf-connection-dialog"', `<dialog id="fw-cf-connection-dialog" data-fw-cf="${cfData}"`);

  const panelGateConnect = state.cloudflare.connections.length
    ? `<div class="card split-card cf-policy">
        <div><h2>Cloudflare connections</h2>
          <p class="hint">Shared across Cloudflare edge defaults, Panel gate, and DNS (${plural(state.cloudflare.connections.length, "connection")} saved).</p></div>
        <div class="actions"><a class="btn" href="#fw-cf-card">Manage connections</a></div>
      </div>`
    : `<div class="card split-card cf-policy">
        <div><h2>Connect Cloudflare</h2>
          <p class="hint">Connect a Cloudflare API token once. DNS, Cloudflare edge defaults, and Panel gate share the same connections.</p></div>
        <div class="actions"><button class="btn btn-primary" type="button" onclick="fwEditCloudflare('')">Connect Cloudflare</button></div>
      </div>`;
  const panelGatePanel = `${panelGateCard(state.panelGate)}${panelGateConnect}`;
  const edgePanel = cloudflareEdgePanel(state.cloudflareEdge, state.cloudflare);
  const edgeCount = !("error" in state.cloudflareEdge) && state.cloudflareEdge.connected && state.cloudflareEdge.zones.length
    ? state.cloudflareEdge.zones.length : undefined;

  const tabs: SectionTab[] = [
    { id: "sites", label: "Cloudflare only", count: total, attention: state.visitorIp.problem || (state.visitorIp.enabled && !state.visitorIp.applied) ? "warn" : undefined, content: sitesPanel },
    { id: "edge", label: "Cloudflare edge", count: edgeCount, attention: edgeAttention(state.cloudflareEdge), content: edgePanel },
    { id: "panel-gate", label: "Panel gate", attention: panelGateAttention(state.panelGate), content: panelGatePanel },
    { id: "protocols", label: "Protocols", attention: "error" in state.protocols ? "bad" : undefined, content: protocolsCard(state.protocols) },
    ...(cloudPanel ? [{ id: "cloud", label: "Cloud firewall", attention: cloudAttention(state), content: cloudPanel }] : []),
  ];

  return `
    <div class="page-heading">
      <div><h1>Firewall</h1><p>Cloudflare-only access, visitor IPs, and zone-wide edge defaults for every site, a protocol for each rule on CloudPanel's Firewall page, a gate in front of the panel, and Hetzner Cloud or netcup firewalls that admit only Cloudflare.</p></div>
    </div>
    ${sectionShellHtml("firewall", "Firewall sections", tabs, "sites")}${cfDialog}${EDGE_REVIEW_DIALOG}${review}`;
}

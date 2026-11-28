import CLIENT_BODY from "./views.client.js" with { type: "text" };
import STYLE from "./views.css" with { type: "text" };
import { esc } from "../../../lib/app-http";
import { PHONE_CUT, phoneMoreHtml, renderLayout, sectionShellHtml, type SectionTab } from "../../../lib/app-ui";
import { CLIPBOARD } from "../../../lib/clipboard";
import {
  CLOUDFLARE_SCOPE_JS, cloudflareAccessDetailsHtml, cloudflareConnectDialogHtml,
} from "../../../lib/cloudflare/connect-dialog";
import { mountPath } from "../../../lib/mount";
import type { RedirectsState, RedirectView } from "../action";

const BASE = mountPath("redirects");
const CLIENT = `${CLOUDFLARE_SCOPE_JS}\nconst REDIR_CLIPBOARD = ${JSON.stringify(CLIPBOARD)};\n${CLIENT_BODY}`;

const REDIRECT_STATUS_LABELS: Record<number, string> = {
  301: "301 Moved permanently",
  302: "302 Found (temporary)",
  307: "307 Temporary, same method",
  308: "308 Permanent, same method",
};

const LOG_LABELS: Record<string, string> = { create: "Create", update: "Update", delete: "Delete" };

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;

export function layout(title: string, content: string, notice?: { current: string; latest: string } | null): string {
  return renderLayout(title, content, { base: BASE, css: STYLE, script: CLIENT, updateNotice: notice });
}

function ago(iso: string | null, now: number): string {
  if (!iso) return "Not checked yet";
  const minutes = Math.round((now - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "Checked just now";
  if (minutes < 60) return `Checked ${plural(minutes, "minute")} ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `Checked ${plural(hours, "hour")} ago` : `Checked ${new Date(iso).toISOString().slice(0, 10)}`;
}

/** What one redirect's status amounts to, in a badge label, tone, and short hint. */
export function redirectStatus(redirect: RedirectView, automatic: boolean, singleConnection = false): { label: string; tone: string; hint: string } {
  const plan = redirect.plan;
  if (!plan) return { label: "Not checked yet", tone: "muted", hint: "" };
  if (plan.problems.length) return { label: "Needs attention", tone: "bad", hint: plan.problems[0]! };
  const waiting = plan.changes.filter((change) => change.waits).length;
  if (waiting) return { label: "Waits for review", tone: "warn", hint: "Provider changed; review before applying" };
  if (!plan.zone) {
    const pending = plan.changes.some((change) => change.action !== "note");
    if (redirect.standIn && !pending) return { label: "On this server", tone: "ok", hint: "Served by a stand-in site" };
    return {
      label: redirect.standIn ? "Stand-in to update" : "Stand-in to create",
      tone: "warn",
      hint: automatic ? "" : "Redirects asks first",
    };
  }
  const suffix = !singleConnection ? ` · ${plan.zone.connection}` : "";
  const zone = `${plan.zone.name}${suffix}`;
  const pending = plan.changes.filter((change) => change.action !== "note").length;
  if (plan.zone.status !== "active") return { label: `Zone ${plan.zone.status}`, tone: "warn", hint: "Set its nameservers at the registrar" };
  if (pending) return { label: automatic ? `${plural(pending, "change")} to make` : plural(pending, "difference"), tone: "warn", hint: zone };
  return { label: "In sync", tone: "ok", hint: zone };
}

function hintLine(text: string): string {
  return text ? `<span class="hint redir-clamp" title="${esc(text)}">${esc(text)}</span>` : "";
}

function servedByHtml(redirect: RedirectView, hasCloudflare: boolean): string {
  if (redirect.mode === "local") return "Local stand-in";
  if (redirect.plan?.zone) return redirect.standIn ? 'Cloudflare<span class="hint">Stand-in retiring</span>' : "Cloudflare";
  if (redirect.standIn) return "Local stand-in";
  return hasCloudflare ? 'Auto<span class="hint">Cloudflare or stand-in</span>' : "Local stand-in";
}

function redirectRow(redirect: RedirectView, state: RedirectsState): string {
  const single = state.connections.length <= 1;
  const status = redirectStatus(redirect, state.automatic, single);
  const kept = [redirect.keepPath && "path", redirect.keepQuery && "query"].filter(Boolean);
  const domain = esc(redirect.source);
  const target = esc(redirect.target.replace(/^https?:\/\//, ""));
  return `<tr data-redirect="${domain}">
    <td class="site-cell"><strong>${domain}</strong><span class="redir-card-target"><span aria-hidden="true">→</span><span class="visually-hidden">redirects to</span> ${target}</span></td>
    <td data-label="Redirects to" class="redir-target-cell"><span class="redir-target" title="${esc(redirect.target)}">${target}</span>
      <span class="hint">${redirect.status}${kept.length ? ` · keeps ${kept.join(" and ")}` : ""}</span></td>
    <td data-label="Served by" class="redir-served-cell">${servedByHtml(redirect, state.connections.length > 0)}</td>
    <td data-label="Status" class="redir-status"><span class="badge tone-${status.tone}">${esc(status.label)}</span>${hintLine(status.hint)}</td>
    <td class="action-cell"><div class="actions">
      <button class="btn" type="button" onclick="redirEdit('${domain}')">Edit</button>
      <button class="btn" type="button" onclick="redirShowDetail('${domain}')">Details</button>
    </div></td>
  </tr>`;
}

function setupCard(): string {
  const step = (title: string, hint: string, control: string): string =>
    `<li><div><strong>${title}</strong><span class="hint">${hint}</span></div><div class="redir-step-control">${control}</div></li>`;
  return `<div class="card redir-setup" id="redir-setup"><h2>Set up Redirects</h2><ol class="redir-checklist">
    ${step(
      "Connect Cloudflare (optional)",
      "For domains in Cloudflare, Redirects writes a Single Redirect rule and a proxied placeholder record so this server is never reached. Shared with DNS and Firewall.",
      '<button class="btn btn-primary" type="button" onclick="redirEditConnection(\'\')">Connect Cloudflare</button>',
    )}
    ${step(
      "Or add a redirect on this server",
      "Domains outside Cloudflare are served by a static stand-in site on this server with a Let's Encrypt certificate covering every effective host.",
      '<button class="btn" type="button" onclick="redirEdit(\'\')">Add redirect</button>',
    )}
    ${step(
      "Turn on Automatic",
      "Until then Redirects previews changes and writes nothing.",
      '<span class="hint">After adding a redirect</span>',
    )}
  </ol></div>`;
}

function modeBar(state: RedirectsState): string {
  if (state.automatic || !state.redirects.length) return "";
  const plans = state.redirects.flatMap((redirect) => redirect.plan ? [redirect.plan] : []);
  const changes = plans.flatMap((plan) => plan.changes.filter((change) => change.action !== "note"));
  const busy = plans.filter((plan) => plan.changes.some((change) => change.action !== "note")).length;
  const waiting = changes.length
    ? ` ${plural(changes.length, "change")} across ${plural(busy, "redirect")} ${changes.length === 1 ? "is" : "are"} waiting.`
    : "";
  return `<div class="notice redir-mode-bar" id="redir-mode-banner"><span><strong>Ask first.</strong> Redirects previews differences and writes nothing until Automatic is on.${waiting}</span>
    <button class="btn btn-primary" type="button" onclick="redirSetAutomatic(true)">Review and turn on Automatic</button></div>`;
}

function redirectsCard(state: RedirectsState, now: number): string {
  const hasCf = state.connections.length > 0;
  const tools = `<div class="redir-tools">${hasCf ? '<button class="btn" type="button" onclick="redirFind(this)">Find redirects in Cloudflare</button>' : ""}
    <button class="btn btn-primary" type="button" onclick="redirEdit('')">Add redirect</button></div>`;
  const footer = `<div class="card-footer"><span class="hint">${esc(ago(state.checkedAt, now))}. Drift is checked every 15 minutes.</span></div>`;
  return `<div class="card card-table"><div class="card-header"><div><h2>Redirects</h2>
      <p class="hint">Domains forwarded to another address. Their mail records are set in DNS, as each domain's Mail role.</p></div>${tools}</div>
    ${state.redirects.length
      ? `<div class="table-scroll"><table class="fleet-table redir-table"><thead><tr>
          <th>Domain</th><th>Redirects to</th><th>Served by</th><th>Status</th><th class="action-cell"></th>
        </tr></thead><tbody data-phone-cut="redir-list">${state.redirects.map((redirect) => redirectRow(redirect, state)).join("")}</tbody></table></div>
        ${state.redirects.length > PHONE_CUT ? phoneMoreHtml("redir-list", `Show all ${plural(state.redirects.length, "redirect")}`) : ""}`
      : `<div class="empty">No redirect domains yet.${hasCf ? " Add one or find existing rules in Cloudflare." : " Add one to create a local stand-in site."}</div>`}
    ${footer}
  </div>`;
}

function syncModeCard(state: RedirectsState): string {
  return `<div class="card split-card" id="redir-mode"><div><h2>Automatic sync</h2>
      <p class="hint">${state.automatic
        ? "On. Redirects keeps Cloudflare Single Redirect rules and local stand-in sites in sync."
        : "Ask first. Redirects previews changes without writing to Cloudflare or creating stand-in sites."}</p></div>
      <button class="btn${state.automatic ? "" : " btn-primary"}" type="button" onclick="redirSetAutomatic(${state.automatic ? "false" : "true"})">${state.automatic ? "Switch to Ask first" : "Review and turn on Automatic"}</button></div>`;
}

function connectionRow(connection: RedirectsState["connections"][number]): string {
  const accounts = connection.accounts.map((account) => account.name || account.id).join(", ");
  const status = connection.active ? '<span class="tone-ok">Active</span>' : `<span class="tone-bad">${esc(connection.status === "unchecked" ? "Not checked" : "Not working")}</span>`;
  const reach = connection.access?.reach ? `${connection.access.reach} · ${plural(connection.zones, "zone")} now` : plural(connection.zones, "zone");
  const line = `${esc(reach)} · ${status}${connection.error ? ` · ${esc(connection.error)}` : ""}`;
  return `<div class="dns-setting-row dns-connection-row" data-connection="${esc(connection.id)}">
    <div class="dns-setting-main">
      <strong>${esc(connection.label)}</strong>${accounts ? `<span class="hint">${esc(accounts)}</span>` : ""}
      ${connection.access ? cloudflareAccessDetailsHtml(connection.id, connection.access, line, "redir-cf") : `<span class="hint">${line}</span>`}
    </div>
    <div class="actions">
      <button class="btn" type="button" onclick="redirEditConnection('${esc(connection.id)}')">Edit</button>
      <button class="btn btn-danger" type="button" onclick="redirRemoveConnection('${esc(connection.id)}')">Remove</button>
    </div>
  </div>`;
}

function connectionsCard(state: RedirectsState): string {
  const rows = state.connections.map(connectionRow).join("");
  const headerButton = state.connections.length
    ? '<button class="btn" type="button" onclick="redirEditConnection(\'\')">Add Cloudflare connection</button>'
    : "";
  const body = state.connections.length
    ? `<div class="dns-setting-list">${rows}</div>`
    : `<div class="redir-connect-empty"><p class="hint">Connect a Cloudflare API token to serve redirects at Cloudflare's edge with Single Redirect rules. Shared with DNS and Firewall.</p>
        <button class="btn btn-primary" type="button" onclick="redirEditConnection('')">Connect Cloudflare</button></div>`;
  return `<div class="card" id="redir-connection"><div class="card-header"><div><h2>Cloudflare connections</h2>
      <p class="hint">Shared with DNS and Firewall. Redirects needs DNS: Edit and Single Redirect: Edit on zones it redirects.</p></div>${headerButton}</div>${body}</div>`;
}

function logRow(line: RedirectsState["log"][number]): string {
  const when = line.at.slice(0, 16).replace("T", " ");
  const where = [line.sites.join(", "), line.zone && !line.sites.includes(line.zone) ? line.zone : ""].filter(Boolean).join(" · ");
  return `<tr><td class="redir-log-when"><span class="mono">${esc(when)}</span> <span class="hint">${esc(line.cause)}</span></td>
    <td><span class="badge redir-${esc(line.action)}">${LOG_LABELS[line.action] ?? esc(line.action)}</span></td>
    <td class="wide-cell"><strong>${esc(line.subject)}</strong>${where ? `<span class="hint">${esc(where)}</span>` : ""}</td>
    <td class="wide-cell redir-change-detail">${esc(line.detail)}${line.before ? `<span class="hint">Was: ${esc(line.before)}</span>` : ""}</td></tr>`;
}

function connectionAttention(state: RedirectsState): "bad" | "warn" | undefined {
  let warn = false;
  for (const connection of state.connections) {
    if (!connection.active) return "bad";
    if (connection.access?.rows.some((row) => !row.optional && (row.held === "no" || row.held === "some"))) return "bad";
    if (connection.access && connection.access.reach === null) warn = true;
  }
  return warn ? "warn" : undefined;
}

export function dashboardContent(state: RedirectsState, now = Date.now()): string {
  const data = JSON.stringify(state).replaceAll("<", "\\u003c");
  const waiting = state.waitUntil > now
    ? `<div class="notice">Cloudflare asked this server to wait until ${esc(new Date(state.waitUntil).toISOString().slice(11, 16))} UTC. Checks resume after that.</div>`
    : "";
  const configured = state.connections.length > 0 || state.redirects.length > 0;
  const pageAction = configured
    ? '<div class="page-actions"><button class="btn" type="button" onclick="redirCheck(this)">Check now</button></div>'
    : "";
  const heading = `<script type="application/json" id="redir-state">${data}</script>
    <div class="page-heading"><div><h1>Redirects</h1>
      <p>Forward domains at Cloudflare's edge or with local stand-in sites.</p></div>${pageAction}</div>`;

  // Before any Cloudflare connection or redirect exists, show the focused first-run card instead of empty tabs.
  if (!configured) {
    return `${heading}${waiting}${setupCard()}`;
  }

  const single = state.connections.length <= 1;
  const tones = state.redirects.map((redirect) => redirectStatus(redirect, state.automatic, single).tone);
  const redirectsAttention: "bad" | "warn" | undefined = tones.includes("bad") ? "bad" : tones.includes("warn") ? "warn" : undefined;

  const redirectsPanel = `${waiting}${modeBar(state)}${redirectsCard(state, now)}`;
  const settingsPanel = `${syncModeCard(state)}${connectionsCard(state)}`;
  const logPanel = `<div class="card card-table"><div class="card-header"><div><h2>Change log</h2>
      <p class="hint">Cloudflare redirect rule, placeholder record, and stand-in site changes, newest first.</p></div></div>
    ${state.log.length
      ? `<div class="table-scroll"><table class="fleet-table redir-log-table"><tbody>${state.log.slice(0, 10).map(logRow).join("")}</tbody></table></div>
        ${state.log.length > 10 ? `<details class="redir-log-more"><summary>Show ${plural(state.log.length - 10, "earlier change")}</summary>
          <div class="table-scroll"><table class="fleet-table redir-log-table"><tbody>${state.log.slice(10).map(logRow).join("")}</tbody></table></div></details>` : ""}`
      : `<div class="empty">${state.automatic ? "No changes yet." : "No changes yet. Redirects asks first, so it writes nothing until you turn on Automatic."}</div>`}
  </div>`;

  const tabs: SectionTab[] = [
    { id: "redirects", label: "Redirects", count: state.redirects.length, attention: redirectsAttention, content: redirectsPanel },
    { id: "settings", label: "Settings", attention: connectionAttention(state), content: settingsPanel },
    { id: "activity", label: "Activity", content: logPanel },
  ];

  return `${heading}${sectionShellHtml("redirects", "Redirects sections", tabs, "redirects")}`;
}

const field = (id: string, label: string, control: string, hint = ""): string =>
  `<div class="form-field"><label for="${id}">${label}</label>${control}${hint ? `<div class="hint">${hint}</div>` : ""}</div>`;

const switchField = (name: string, label: string, hint: string): string =>
  `<label class="redir-switch-row"><span class="switch"><input type="checkbox" name="${name}"><span></span></span><span><strong>${label}</strong><span class="hint">${hint}</span></span></label>`;

function dialogsHtml(state: RedirectsState): string {
  const cfDialog = cloudflareConnectDialogHtml({
    prefix: "redir-cf",
    onSubmit: "redirSaveConnection(event)",
    copyFn: "redirCopyElement",
    defaultDns: state.dnsEnabled,
    defaultRedirects: true,
    defaultEdge: false,
    defaultPanelGate: state.firewallEnabled,
    templates: state.tokens,
    clipboardIcon: CLIPBOARD,
  });
  return `
  <dialog id="redir-edit-dialog" aria-labelledby="redir-edit-heading"><form id="redir-edit-form" onsubmit="redirSave(event)">
    <div class="dialog-header"><h2 id="redir-edit-heading">Add redirect</h2></div>
    <div class="form-grid">
      ${field("redir-source", "Domain", '<input id="redir-source" name="source" required autocomplete="off" spellcheck="false" placeholder="old-name.com">', "A zone's apex also covers its www. Any other host is redirected alone.")}
      ${field("redir-target", "Redirect to", '<input id="redir-target" name="target" type="url" required autocomplete="off" spellcheck="false" placeholder="https://example.com">')}
      ${field("redir-status", "Status", `<select id="redir-status" name="status">${Object.entries(REDIRECT_STATUS_LABELS).map(([code, label]) => `<option value="${code}">${label}</option>`).join("")}</select>`)}
      <div class="form-field" id="redir-mode-field"><label for="redir-mode-select">Serve through</label>
        <select id="redir-mode-select" name="mode" onchange="redirSyncWhere()">
          <option value="auto">Automatic (Cloudflare when available, else local stand-in)</option>
          <option value="local">Local stand-in site on this server</option>
        </select></div>
    </div>
    ${switchField("keepPath", "Keep path", "/about on the old domain goes to /about on the target.")}
    ${switchField("keepQuery", "Keep query string", "Anything after ? goes along.")}
    <p class="hint redir-dialog-note" id="redir-where"></p>
    <div class="actions dialog-actions">
      <button class="btn btn-danger redir-dialog-start" id="redir-delete-btn" type="button" onclick="redirDelete()">Delete</button>
      <button class="btn" type="button" onclick="this.closest('dialog').close()">Cancel</button>
      <button class="btn btn-primary" type="submit">Save</button>
    </div>
  </form></dialog>
  <dialog id="redir-detail-dialog" aria-labelledby="redir-detail-heading">
    <div class="dialog-header"><h2 id="redir-detail-heading">Redirect</h2></div>
    <div id="redir-detail-body"></div>
    <div class="actions dialog-actions">
      <button class="btn redir-dialog-start" id="redir-detail-edit" type="button" onclick="redirEdit(redirShown)">Edit redirect</button>
      <button class="btn" type="button" onclick="this.closest('dialog').close()">Close</button>
      <button class="btn btn-primary" id="redir-detail-review" type="button" hidden onclick="redirReviewHeld()">Review changes</button>
    </div>
  </dialog>
  <dialog id="redir-review-dialog" class="redir-wide-dialog" aria-labelledby="redir-review-heading">
    <div class="dialog-header"><h2 id="redir-review-heading">Review</h2></div>
    <p id="redir-review-text"></p>
    <div id="redir-review-sites"></div>
    <div class="actions dialog-actions">
      <button class="btn" type="button" onclick="this.closest('dialog').close()">Cancel</button>
      <button class="btn btn-primary" id="redir-review-confirm" type="button" onclick="redirConfirm()">Confirm</button>
    </div>
  </dialog>
  <dialog id="redir-found-dialog" class="redir-wide-dialog" aria-labelledby="redir-found-heading"><form id="redir-found-form" onsubmit="redirTakeOver(event)">
    <div class="dialog-header"><h2 id="redir-found-heading">Redirects in Cloudflare</h2></div>
    <p class="hint">Whole-domain redirect rules in your Cloudflare zones that Redirects does not manage yet. Taking one over updates its rule in place; it never adds a second.</p>
    <div id="redir-found-body"></div>
    <div class="actions dialog-actions">
      <button class="btn" type="button" onclick="this.closest('dialog').close()">Cancel</button>
      <button class="btn btn-primary" id="redir-found-submit" type="submit">Take over selected</button>
    </div>
  </form></dialog>
  ${cfDialog}`;
}

export function dashboardView(state: RedirectsState): string {
  return `<div id="redir-root">${dashboardContent(state)}</div>${dialogsHtml(state)}`;
}

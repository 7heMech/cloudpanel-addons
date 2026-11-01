import CLIENT_BODY from "./views.client.js" with { type: "text" };
import CSS from "./views.css" with { type: "text" };
import { esc } from "../../../lib/app-http";
import { ATTENTION_RANK, FLEET_FOOTER_HTML, FLEET_ROW_SELECTION_JS, fleetFilterHtml, filterWord, valueFilters, fleetRowSelectionStyle, renderLayout } from "../../../lib/app-ui";
import { mountPath } from "../../../lib/mount";
import type { DnsState, SiteView } from "../action";
import type { Profile } from "../model";
import { CLIPBOARD } from "../../../lib/clipboard";
import { SSL_LABELS } from "../zone";

const BASE = mountPath("dns");
const STYLE = CSS.split("/* fleet-row-selection */").join(fleetRowSelectionStyle("dns-site-table"));
const CLIENT = `${FLEET_ROW_SELECTION_JS}\nconst DNS_CLIPBOARD = ${JSON.stringify(CLIPBOARD)};\n${CLIENT_BODY}`;
const NO_PROFILE = "Not managed";

export function layout(title: string, content: string, notice?: { current: string; latest: string } | null): string {
  return renderLayout(title, content, { brand: "DNS", base: BASE, nav: [], css: STYLE, script: CLIENT, updateNotice: notice });
}

const TYPE_LABELS: Record<string, string> = {
  wordpress: "WordPress", php: "PHP", static: "Static", nodejs: "Node.js", python: "Python", "reverse-proxy": "Reverse proxy", redirect: "Redirect",
};

export const REDIRECT_STATUS_LABELS: Record<number, string> = {
  301: "301 Moved permanently", 302: "302 Found (temporary)", 307: "307 Temporary, same method", 308: "308 Permanent, same method",
};

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;

function ago(iso: string | null, now: number): string {
  if (!iso) return "Not checked yet";
  const minutes = Math.round((now - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "Checked just now";
  if (minutes < 60) return `Checked ${plural(minutes, "minute")} ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `Checked ${plural(hours, "hour")} ago` : `Checked ${new Date(iso).toISOString().slice(0, 10)}`;
}

function profileOptions(profiles: Profile[], selected: string | null, none: string): string {
  return [`<option value="">${esc(none)}</option>`]
    .concat(profiles.map((profile) => `<option value="${esc(profile.id)}"${profile.id === selected ? " selected" : ""}>${esc(profile.name)}</option>`))
    .join("");
}

function recordSummary(profile: Profile): string {
  const types = [...new Set(profile.records.map((record) => record.type))].join(", ");
  return profile.records.length ? `${plural(profile.records.length, "record")}<span class="hint">${esc(types)}</span>` : '<span class="hint">No records</span>';
}

function zoneSummary(profile: Profile): string {
  const parts: string[] = [];
  if (profile.zone.ssl) parts.push(SSL_LABELS[profile.zone.ssl]);
  if (profile.zone.alwaysHttps !== null) parts.push(`Always HTTPS ${profile.zone.alwaysHttps ? "on" : "off"}`);
  const rules = [profile.zone.acmeFullSsl && "Let's Encrypt", profile.zone.webmailFullSsl && "webmail", profile.zone.skipFirewallIps.length && "firewall skip"].filter(Boolean);
  const extras = [profile.mailcow && "Mailcow"].filter(Boolean);
  return `${esc(parts.join(" · ") || "Zone settings unchanged")}${rules.length || extras.length ? `<span class="hint">${esc([rules.length ? `Rules: ${rules.join(", ")}` : "", ...extras].filter(Boolean).join(" · "))}</span>` : ""}`;
}

function profileRow(profile: DnsState["profiles"][number]): string {
  return `<tr data-profile="${esc(profile.id)}">
    <td class="site-cell"><strong>${esc(profile.name)}</strong><span class="dns-card-sites"> · ${plural(profile.sites, "site")}</span></td>
    <td data-label="Records">${recordSummary(profile)}</td>
    <td data-label="Zone" class="wide-cell">${zoneSummary(profile)}</td>
    <td data-label="Sites" class="numeric dns-sites-cell">${profile.sites}</td>
    <td data-label="Actions" class="action-cell"><div class="actions">
      <button class="btn" type="button" onclick="dnsEditProfile('${esc(profile.id)}')">Edit</button>
      <button class="btn btn-danger" type="button" onclick="dnsDeleteProfile('${esc(profile.id)}')">Delete</button>
    </div></td>
  </tr>`;
}

/** What one site's DNS amounts to, in a word and a line. */
export function siteStatus(site: SiteView, automatic: boolean): { label: string; tone: string; hint: string } {
  const plan = site.plan;
  if (!site.profileId && !site.redirect) return { label: "—", tone: "muted", hint: "" };
  if (!plan) return { label: "Not checked yet", tone: "muted", hint: "" };
  if (site.redirect && !plan.zone && !plan.problems.length) {
    const pending = plan.changes.some((change) => change.action !== "note");
    if (site.redirect.standIn && !pending) return { label: "On this server", tone: "ok", hint: "Served by a stand-in site until Cloudflare is connected" };
    return { label: site.redirect.standIn ? "Stand-in to update" : "Stand-in to create", tone: "warn", hint: automatic ? "" : "DNS asks first" };
  }
  const zone = plan.zone ? `${plan.zone.name} · ${plan.zone.connection}` : "";
  if (plan.problems.length) return { label: "Needs attention", tone: "bad", hint: plan.problems[0]! };
  const waiting = plan.changes.filter((change) => change.waits).length;
  if (waiting) return { label: "Waits for review", tone: "warn", hint: `Its address is in place; ${plural(waiting, "change")} reach${waiting === 1 ? "es" : ""} further` };
  const pending = plan.changes.filter((change) => change.action !== "note").length;
  if (plan.zone && plan.zone.status !== "active") return { label: `Zone ${plan.zone.status}`, tone: "warn", hint: "Set its nameservers at the registrar" };
  if (!plan.zone && pending) return { label: "Zone to create", tone: "warn", hint: "" };
  if (pending) return { label: automatic ? `${plural(pending, "change")} to make` : plural(pending, "difference"), tone: "warn", hint: zone };
  return { label: "In sync", tone: "ok", hint: zone };
}

/** A line under a status, cut to two lines in the table; Details and the tooltip have it whole. */
function hintLine(text: string): string {
  return text ? `<span class="hint dns-clamp" title="${esc(text)}">${esc(text)}</span>` : "";
}

function typeLabel(site: SiteView): string {
  return site.redirect ? "Redirect" : TYPE_LABELS[site.type] ?? site.type;
}

function siteRow(site: SiteView, state: DnsState): string {
  const status = siteStatus(site, state.automatic);
  const runs = site.redirect
    ? `Redirect<span class="hint dns-redirect-target" title="${esc(site.redirect.target)}">→ ${esc(site.redirect.target.replace(/^https?:\/\//, ""))}</span>`
    : esc(TYPE_LABELS[site.type] ?? site.type);
  const profile = state.profiles.find((candidate) => candidate.id === site.profileId);
  const show = [
    status.tone === "bad" ? "attention" : status.tone === "warn" ? "pending" : "",
    filterWord("type", typeLabel(site)),
    profile || site.redirect ? "" : "unmanaged",
  ].filter(Boolean).join(" ");
  const sorts = ` data-sort-attention="${ATTENTION_RANK[status.tone as keyof typeof ATTENTION_RANK] ?? ATTENTION_RANK.muted}" data-sort-profile="${esc(profile?.name ?? "")}" data-sort-type="${esc(typeLabel(site))}"`;
  return `<tr data-domain="${esc(site.domain)}" data-profile-id="${esc(site.profileId ?? "")}" data-show="${show}"${sorts}${site.plan?.held ? " data-held" : ""} tabindex="0" aria-selected="false" onclick="toggleSiteSelection(event, this)" onkeydown="toggleSiteSelection(event, this)">
    <td class="site-select"><input class="site-checkbox" type="checkbox" onchange="paintFleetSelection()" aria-label="Select ${esc(site.domain)}"></td>
    <td class="site-cell"><strong>${esc(site.domain)}</strong></td>
    <td class="type-cell">${runs}</td>
    <td data-label="Profile" class="dns-profile-cell"><select aria-label="Profile for ${esc(site.domain)}" onchange="dnsAssignRow(this)">${profileOptions(state.profiles, site.profileId, site.redirect ? "No profile" : NO_PROFILE)}</select></td>
    <td data-label="DNS" class="dns-status">${status.label === "—" ? '<span class="tone-muted">—</span>' : `<span class="badge tone-${status.tone}">${esc(status.label)}</span>`}${hintLine(status.hint)}${site.ssl ? hintLine(site.ssl.startsWith("Waiting for DNS") ? "Certificate requested; waits for DNS" : `Certificate: ${site.ssl}`) : ""}</td>
    <td class="action-cell">${site.profileId || site.redirect ? `<button class="btn" type="button" onclick="dnsShowSite('${esc(site.domain)}')">Details</button>` : ""}</td>
  </tr>`;
}

function connectionRow(connection: DnsState["connections"][number]): string {
  const accounts = connection.accounts.map((account) => account.name || account.id).join(", ");
  const status = connection.active ? '<span class="tone-ok">Active</span>' : `<span class="tone-bad">${esc(connection.status === "unchecked" ? "Not checked" : "Not working")}</span>`;
  return `<tr data-connection="${esc(connection.id)}">
    <td class="site-cell"><strong>${esc(connection.label)}</strong><span class="hint">Cloudflare</span></td>
    <td class="wide-cell">${esc(accounts || "—")}<span class="hint">${esc(plural(connection.zones, "zone"))} · ${status}${connection.error ? ` · ${esc(connection.error)}` : ""}</span></td>
    <td data-label="Actions" class="action-cell"><div class="actions">
      <button class="btn" type="button" onclick="dnsEditConnection('${esc(connection.id)}')">Edit</button>
      <button class="btn btn-danger" type="button" onclick="dnsRemoveConnection('${esc(connection.id)}')">Remove</button>
    </div></td>
  </tr>`;
}

function address(value: string, detected: string | null, placeholder: string): string {
  const name = `<span class="mono">${esc(placeholder)}</span>`;
  if (value) return `${name} ${esc(value)}`;
  if (detected) return `${name} ${esc(detected)} <span class="hint inline">detected</span>`;
  return `${name} <span class="tone-warn">${detected === null ? "not detected" : "none"}</span>`;
}

/** Where a site's missing zone is created: the only account the connections reach, or the one chosen. */
function newZonesRow(state: DnsState): string {
  const chosen = state.createIn && state.accounts.find((account) => account.connectionId === state.createIn!.connectionId && account.accountId === state.createIn!.accountId);
  const value = state.accounts.length > 1 || (state.createIn && !chosen)
    ? `<select id="dns-zone-account" aria-label="Account for new zones" onchange="dnsSetZoneAccount(this)">
        <option value=""${chosen ? "" : " selected"}>${chosen ? "Not chosen" : "Choose an account"}</option>${state.accounts.map((account) => {
          const key = `${account.connectionId}/${account.accountId}`;
          return `<option value="${esc(key)}"${chosen === account ? " selected" : ""}>${esc(account.label)}</option>`;
        }).join("")}</select>`
    : state.accounts.length ? esc(state.accounts[0]!.label) : '<span class="hint">No connection reaches an account yet.</span>';
  return `<tr><td class="site-cell"><strong>New zones</strong><span class="hint">For sites not in Cloudflare</span></td>
        <td class="wide-cell">${value}<span class="hint">Created in this account; its nameservers are shown to set at the registrar.</span></td>
        <td data-label="Actions" class="action-cell"></td></tr>`;
}

/** What DNS connects to and what the placeholders stand for: set once, rarely touched. */
function settingsCard(state: DnsState): string {
  const { mailcow, server } = state;
  const dkim = mailcow.dkimSource ? `shares the DKIM key of ${mailcow.dkimSource}` : `${mailcow.dkimBits}-bit DKIM, selector ${mailcow.dkimSelector}`;
  const mailcowValue = mailcow.url
    ? `<span class="mono">{mailcow.host}</span> ${esc(mailcow.host)}<span class="hint">${esc([dkim, mailcow.sharedMailbox && `${mailcow.sharedMailbox} may send as each domain`].filter(Boolean).join(" · "))}</span>`
    : '<span class="hint">Not set up. Profiles that use Mailcow need it.</span>';
  const connections = state.connections.length ? state.connections.map(connectionRow).join("") : `<tr>
      <td class="site-cell"><strong>Cloudflare</strong></td><td class="wide-cell"><span class="hint">Not connected</span></td>
      <td data-label="Actions" class="action-cell"><button class="btn" type="button" onclick="dnsEditConnection('')">Connect</button></td></tr>`;
  return `<div class="card card-table"><div class="card-header"><div><h2>Settings</h2>
      <p class="hint">Each Cloudflare connection is one API token. A site is managed in the longest zone any connection reaches.</p></div>
      ${state.connections.length ? '<button class="btn" type="button" onclick="dnsEditConnection(\'\')">Add Cloudflare connection</button>' : ""}</div>
    <div class="table-scroll"><table class="fleet-table dns-settings-table"><tbody>
      ${connections}
      ${state.connections.length ? newZonesRow(state) : ""}
      <tr><td class="site-cell"><strong>Server addresses</strong></td>
        <td class="wide-cell">${address(server.ipv4, server.detected.ipv4, "{ipv4}")}<br>${address(server.ipv6, server.detected.ipv6, "{ipv6}")}</td>
        <td data-label="Actions" class="action-cell"><button class="btn" type="button" onclick="dnsEditServer()">Edit</button></td></tr>
      <tr><td class="site-cell"><strong>Mailcow</strong>${mailcow.url ? `<span class="hint">${esc(new URL(mailcow.url).host)}</span>` : ""}</td>
        <td class="wide-cell">${mailcowValue}</td>
        <td data-label="Actions" class="action-cell"><div class="actions">
          <button class="btn" type="button" onclick="dnsEditMailcow()">${mailcow.url ? "Edit" : "Set up"}</button>
          ${mailcow.url || mailcow.hasKey ? '<button class="btn btn-danger" type="button" onclick="dnsRemoveMailcow()">Remove</button>' : ""}
        </div></td></tr>
    </tbody></table></div></div>`;
}

/** Until Cloudflare is connected: the three steps that make a new site publish itself. */
function setupCard(state: DnsState): string {
  if (state.connections.length) return "";
  const fallback = state.profiles.find((profile) => profile.id === state.defaultProfileId);
  const step = (done: boolean, title: string, hint: string, control: string): string =>
    `<li class="${done ? "done" : ""}"><div><strong>${title}</strong><span class="hint">${hint}</span></div><div class="dns-step-control">${control}</div></li>`;
  return `<div class="card dns-setup"><h2>Set up DNS</h2><ol class="dns-checklist">
    ${step(false, "Connect Cloudflare", "Cloudflare's own form opens with the permissions filled in; paste the token back.",
      '<button class="btn btn-primary" type="button" onclick="dnsEditConnection(\'\')">Connect Cloudflare</button>')}
    ${step(Boolean(fallback), "Choose the profile for new sites", "A new site joins it seconds after CloudPanel creates it. Existing sites are never moved.",
      `<select id="dns-setup-default" aria-label="Profile for new sites" onchange="dnsSetDefault(this)">${profileOptions(state.profiles, state.defaultProfileId, "No profile")}</select>`)}
    ${step(state.automatic, "Turn on Automatic", "Until then DNS asks first: it shows what differs and writes nothing, so new sites get no records.",
      state.automatic ? '<span class="tone-ok">On</span>' : state.sites.some((site) => site.redirect) ? "" : '<span class="hint">After connecting</span>')}
  </ol></div>`;
}

/** Ask first until the operator says yes once; then Automatic, with the way back. */
function modeBar(state: DnsState): string {
  if (!state.connections.length && !state.sites.some((site) => site.redirect)) return "";
  if (state.automatic) {
    return `<div class="notice dns-mode-bar dns-mode-on"><span><strong>Automatic.</strong> DNS keeps every site's records to its profile, and creates a zone a site is missing.</span>
      <button class="btn" type="button" onclick="dnsSetAutomatic(false)">Ask first instead</button></div>`;
  }
  const plans = state.sites.flatMap((site) => site.plan ? [site.plan] : []);
  const changes = plans.flatMap((plan) => plan.changes.filter((change) => change.action !== "note"));
  const zones = new Set(changes.filter((change) => change.subject === "Cloudflare zone").map((change) => change.detail.split(" ")[0])).size;
  const busy = plans.filter((plan) => plan.changes.some((change) => change.action !== "note")).length;
  const waiting = changes.length
    ? ` ${plural(changes.length - zones, "change")}${zones ? ` and ${plural(zones, "new zone")}` : ""} across ${plural(busy, "site")} are waiting.`
    : "";
  return `<div class="notice dns-mode-bar"><span><strong>Ask first.</strong> DNS shows what differs and writes nothing, so new sites get no records.${waiting}</span>
    <button class="btn btn-primary" type="button" onclick="dnsSetAutomatic(true)">Review and turn on Automatic</button></div>`;
}

const LOG_LABELS: Record<string, string> = { create: "Create", update: "Update", delete: "Delete" };

function logRow(line: DnsState["log"][number]): string {
  const when = line.at.slice(0, 16).replace("T", " ");
  const where = [line.sites.join(", "), line.zone && !line.sites.includes(line.zone) ? line.zone : ""].filter(Boolean).join(" · ");
  return `<tr><td class="dns-log-when"><span class="mono">${esc(when)}</span><span class="hint">${esc(line.cause)}</span></td>
    <td><span class="badge dns-${esc(line.action)}">${LOG_LABELS[line.action] ?? esc(line.action)}</span></td>
    <td class="wide-cell"><strong>${esc(line.subject)}</strong>${where ? `<span class="hint">${esc(where)}</span>` : ""}</td>
    <td class="wide-cell dns-change-detail">${esc(line.detail)}${line.before ? `<span class="hint">Was: ${esc(line.before)}</span>` : ""}</td></tr>`;
}

function siteCount(state: DnsState): string {
  const redirects = state.sites.filter((site) => site.redirect).length;
  const sites = plural(state.sites.length - redirects, "site");
  return redirects ? `${sites} · ${plural(redirects, "redirect")}` : sites;
}

/** Redirect domains sit in the sites table, so they are assigned and checked with the sites. */
function redirectTools(state: DnsState): string {
  return `<span class="dns-redirect-tools">${state.connections.length ? '<button class="btn" type="button" onclick="dnsFindRedirects(this)">Find redirects in Cloudflare</button>' : ""}
    <button class="btn" type="button" onclick="dnsEditRedirect('')">Add redirect</button></span>`;
}

export function dashboardView(state: DnsState): string {
  return `<div id="dns-root">${dashboardContent(state)}</div>${DIALOGS}`;
}

/** Everything a change can alter, repainted in place from the action's reply. */
export function dashboardContent(state: DnsState, now = Date.now()): string {
  const data = JSON.stringify(state).replaceAll("<", "\\u003c");
  const profiles = state.profiles.map(profileRow).join("");
  const sites = state.sites.map((site) => siteRow(site, state)).join("");
  const waiting = state.waitUntil > now
    ? `<div class="notice">Cloudflare or Mailcow asked this server to wait until ${esc(new Date(state.waitUntil).toISOString().slice(11, 16))} UTC. Checks resume after that.</div>` : "";
  const orphans = state.orphans.length ? `<div class="card card-table"><div class="card-header"><div><h2>Records of deleted sites</h2>
      <p class="hint">These sites are gone from CloudPanel. Their records are still in Cloudflare until you remove them.</p></div></div>
      <div class="table-scroll"><table class="fleet-table dns-orphan-table"><tbody>${state.orphans.map((orphan) => `<tr>
        <td class="site-cell"><strong>${esc(orphan.domain)}</strong><span class="hint">${esc(plural(orphan.records, "record"))} in ${esc(orphan.zone)}</span></td>
        <td data-label="Actions" class="action-cell"><div class="actions">
          <button class="btn" type="button" onclick="dnsForget('${esc(orphan.domain)}')">Keep</button>
          <button class="btn btn-danger" type="button" onclick="dnsRemoveRecords('${esc(orphan.domain)}')">Remove records</button>
        </div></td></tr>`).join("")}</tbody></table></div></div>` : "";

  // Shown empty too: a missing card read as a log that was never added, when
  // the usual reason is that DNS still asks first and so has written nothing.
  const log = `<div class="card card-table"><div class="card-header"><div><h2>Change log</h2>
      <p class="hint">Every record, zone and Mailcow change DNS made, newest first.</p></div></div>
      ${state.log.length ? `<div class="table-scroll"><table class="fleet-table dns-log-table"><tbody>${state.log.slice(0, 10).map(logRow).join("")}</tbody></table></div>
      ${state.log.length > 10 ? `<details class="dns-log-more"><summary>Show ${plural(state.log.length - 10, "earlier change")}</summary>
        <div class="table-scroll"><table class="fleet-table dns-log-table"><tbody>${state.log.slice(10).map(logRow).join("")}</tbody></table></div></details>` : ""}`
    : `<div class="empty">${state.automatic ? "No changes yet."
      : "No changes yet. DNS asks first, so it writes nothing until you turn on Automatic."}</div>`}
    </div>`;

  return `<script type="application/json" id="dns-state">${data}</script>
    <div class="page-heading"><div><h1>DNS</h1>
      <p>Keep each site's Cloudflare DNS to its profile's records.</p></div></div>
    ${waiting}${setupCard(state)}${modeBar(state)}
    <div class="card card-table">
    ${state.sites.length ? `<div class="card-header toolbar">
        <h2>Sites</h2>
        <span class="toolbar-note" id="site-selection">No sites selected</span>
        <button class="btn mobile-select-all" id="select-all-btn" type="button" onclick="toggleAllSites()">Select all</button>
        <select class="toolbar-end" id="bulk-profile" aria-label="Profile for the selected sites"><option value="" selected disabled>Choose a profile</option>${state.profiles
          .map((profile) => `<option value="${esc(profile.id)}">${esc(profile.name)}</option>`).join("")}<option value="-">${NO_PROFILE}</option></select>
        <button class="btn" id="assign-selected" type="button" disabled data-needs-selection onclick="dnsAssignSelected()">Assign selected</button>
        ${redirectTools(state)}
      </div>
      ${fleetFilterHtml({
        count: state.sites.length,
        filters: [
          { value: "attention", label: "Needs attention" }, { value: "pending", label: "Changes waiting" }, { value: "unmanaged", label: "Not managed" },
          ...valueFilters("Type", "type", state.sites.map(typeLabel)),
        ],
        summary: siteCount(state),
      })}
      <div class="table-scroll"><table class="fleet-table dns-site-table"><thead><tr>
        <th class="site-select"><input id="select-all" type="checkbox" onchange="selectAllSites(this.checked)" aria-label="Select all sites"></th>
        <th data-sort="domain">Site</th><th data-sort="type">Runs</th><th data-sort="profile">Profile</th><th data-sort="attention" data-sort-label="DNS status">DNS</th><th class="action-cell"></th>
      </tr></thead><tbody>${sites}</tbody></table></div>
      ${FLEET_FOOTER_HTML}
      <div class="card-footer"><span class="hint">${esc(ago(state.checkedAt, now))}. Drift is checked every 15 minutes.</span>
        <button class="btn" type="button" onclick="dnsCheck(this)"${state.connections.length || state.sites.some((site) => site.redirect) ? "" : " disabled"}>Check now</button></div>`
      : `<div class="card-header toolbar"><h2>Sites</h2>${redirectTools(state)}</div><div class="empty">CloudPanel has no sites yet.</div>`}
    </div>
    ${orphans}
    <div class="card card-table"><div class="card-header"><div><h2>Profiles</h2>
      <p class="hint">A profile is the records each of its sites should have. Records that conflict with them are deleted, at the names the profile writes and nowhere else.</p></div>
      <div class="dns-profile-tools">
        <div class="dns-default-field"><label class="hint" for="dns-default">New sites join</label>
          <select id="dns-default" onchange="dnsSetDefault(this)">${profileOptions(state.profiles, state.defaultProfileId, "No profile")}</select></div>
        <button class="btn btn-primary" type="button" onclick="dnsEditProfile('')">New profile</button></div></div>
      ${profiles ? `<div class="table-scroll"><table class="fleet-table dns-profile-table"><thead><tr><th>Profile</th><th>Records</th><th>Zone</th><th class="numeric">Sites</th><th class="action-cell">Actions</th></tr></thead><tbody>${profiles}</tbody></table></div>`
        : '<div class="empty">No profiles yet. Create one from the Web and Mailcow presets.</div>'}
    </div>
    ${settingsCard(state)}
    ${log}`;
}

const field = (id: string, label: string, control: string, hint = "", full = false): string =>
  `<div class="form-field${full ? " form-field-full" : ""}"><label for="${id}">${label}</label>${control}${hint ? `<div class="hint">${hint}</div>` : ""}</div>`;

const actions = (save: string): string =>
  `<div class="actions dialog-actions"><button class="btn" type="button" onclick="this.closest('dialog').close()">Cancel</button><button class="btn btn-primary" type="submit">${save}</button></div>`;

const switchField = (name: string, label: string, hint: string): string =>
  `<label class="dns-switch-row"><span class="switch"><input type="checkbox" name="${name}"><span></span></span><span><strong>${label}</strong><span class="hint">${hint}</span></span></label>`;

const PLACEHOLDERS: [string, string][] = [
  ["{domain}", "the site's domain"], ["{zone}", "its Cloudflare zone"], ["{sub}", "the part before the zone"],
  ["{ipv4}", "this server's IPv4"], ["{ipv6}", "this server's IPv6"], ["{mailcow.host}", "the mail hostname"],
  ["{mailcow.selector}", "Mailcow's DKIM selector"], ["{mailcow.dkim}", "Mailcow's DKIM key"],
];

/** The dialogs sit outside the repainted content, so a repaint never closes one. */
const DIALOGS = `
  <dialog id="dns-profile-dialog" class="dns-wide-dialog" aria-labelledby="dns-profile-heading"><form id="dns-profile-form" onsubmit="dnsSaveProfile(event)">
    <div class="dialog-header"><h2 id="dns-profile-heading">New profile</h2></div>
    <input type="hidden" name="id">
    <div class="form-grid">${field("dns-profile-name", "Name", '<input id="dns-profile-name" name="name" required maxlength="40" autocomplete="off" placeholder="Web and Mailcow">')}</div>
    <div class="dns-section-head"><h3>Records</h3>
      <div class="actions"><label class="dns-check"><input type="checkbox" id="dns-advanced" onchange="dnsRenderRows()"> TTL and apex only</label>
        <select id="dns-preset" aria-label="Add rows from a preset" onchange="dnsAddPreset(this)"></select>
        <button class="btn" type="button" onclick="dnsAddRow()">Add record</button></div></div>
    <div class="dns-rows-wrap"><table class="dns-rows" id="dns-rows-table"><thead><tr><th>Type</th><th>Name</th><th>Content</th><th class="dns-adv">TTL</th><th class="dns-adv">Apex only</th><th>Proxy</th><th><span class="visually-hidden">Remove</span></th></tr></thead>
      <tbody id="dns-rows"></tbody></table></div>
    <p class="hint dns-empty-rows" id="dns-empty-rows" hidden>No records yet. Add one, or start from a preset.</p>
    <div class="dns-placeholders"><span class="hint">Placeholders, inserted where the cursor is:</span>
      ${PLACEHOLDERS.map(([token, meaning]) => `<button class="dns-chip" type="button" title="${esc(meaning)}" onmousedown="event.preventDefault()" onclick="dnsInsert('${token}')">${token}</button>`).join("")}</div>
    <div id="dns-mailcow-section"><h3 class="dns-section">Mailcow</h3>
    ${switchField("mailcow", "Set up each site's domain in Mailcow", "Adds the domain if it is missing, gives it a DKIM key, and lets the shared mailbox send as it. A Mailcow domain is never deleted.")}</div>
    <details class="dns-zone-details" id="dns-zone-details"><summary><h3>Cloudflare zone</h3><span class="hint" id="dns-zone-summary"></span></summary>
    <p class="hint">These apply to the whole zone, not only to this profile's sites.</p>
    <div class="form-grid">
      ${field("dns-ssl", "SSL/TLS mode", `<select id="dns-ssl" name="ssl"><option value="">Leave as it is</option>${Object.entries(SSL_LABELS).map(([value, label]) => `<option value="${value}">${label}</option>`).join("")}</select>`)}
      ${field("dns-https", "Always Use HTTPS", '<select id="dns-https" name="alwaysHttps"><option value="">Leave as it is</option><option value="on">On</option><option value="off">Off</option></select>')}
    </div>
    ${switchField("acmeFullSsl", "Full SSL for Let's Encrypt checks", "Lets a proxied site get its first certificate while Full (strict) is on, and with Cloudflare-only access.")}
    ${switchField("webmailFullSsl", "Full SSL for webmail hosts", "For proxied webmail records, whose origin is the mail server.")}
    <div class="form-grid dns-zone-grid">
      ${field("dns-skip", "Skip the firewall for", '<textarea id="dns-skip" name="skipFirewallIps" rows="2" placeholder="203.0.113.7"></textarea>', "Optional. One IP per line, such as a MainWP Dashboard's. Skips Super Bot Fight Mode and managed rules; Cloudflare cannot skip the free Bot Fight Mode.")}
    </div></details>
    ${actions("Save profile")}
  </form></dialog>
  <dialog id="dns-review-dialog" class="dns-wide-dialog" aria-labelledby="dns-review-heading">
    <div class="dialog-header"><h2 id="dns-review-heading">Review</h2></div>
    <p id="dns-review-text"></p>
    <div id="dns-review-sites"></div>
    <div class="actions dialog-actions"><button class="btn" type="button" onclick="this.closest('dialog').close()">Cancel</button><button class="btn btn-primary" id="dns-review-confirm" type="button" onclick="dnsConfirm()">Confirm</button></div>
  </dialog>
  <dialog id="dns-site-dialog" aria-labelledby="dns-site-heading">
    <div class="dialog-header"><h2 id="dns-site-heading">Site</h2></div>
    <div id="dns-site-body"></div>
    <div class="actions dialog-actions"><button class="btn dns-dialog-start" id="dns-site-edit" type="button" hidden onclick="dnsEditRedirect(dnsSiteShown)">Edit redirect</button><button class="btn" type="button" onclick="this.closest('dialog').close()">Close</button><button class="btn btn-primary" id="dns-site-apply" type="button" onclick="dnsApplySite()">Apply now</button></div>
  </dialog>
  <dialog id="dns-redirect-dialog" aria-labelledby="dns-redirect-heading"><form id="dns-redirect-form" onsubmit="dnsSaveRedirect(event)">
    <div class="dialog-header"><h2 id="dns-redirect-heading">Add redirect</h2></div>
    <div class="form-grid">
      ${field("dns-redirect-source", "Domain", '<input id="dns-redirect-source" name="source" required autocomplete="off" spellcheck="false" placeholder="old-name.com">', "A zone's apex also covers its www. Any other host is redirected alone.")}
      ${field("dns-redirect-target", "Redirect to", '<input id="dns-redirect-target" name="target" type="url" required autocomplete="off" spellcheck="false" placeholder="https://example.com">')}
      ${field("dns-redirect-status", "Status", `<select id="dns-redirect-status" name="status">${Object.entries(REDIRECT_STATUS_LABELS).map(([code, label]) => `<option value="${code}">${label}</option>`).join("")}</select>`)}
      ${field("dns-redirect-profile", "Profile", '<select id="dns-redirect-profile" name="profileId"></select>', "Its rows apply, such as mail, except the domain's own address records.")}
    </div>
    ${switchField("keepPath", "Keep path", "/about on the old domain goes to /about on the target.")}
    ${switchField("keepQuery", "Keep query string", "Anything after ? goes along.")}
    <p class="hint dns-dialog-note" id="dns-redirect-where"></p>
    <div class="actions dialog-actions"><button class="btn btn-danger dns-dialog-start" id="dns-redirect-delete" type="button" onclick="dnsDeleteRedirect()">Delete</button>
      <button class="btn" type="button" onclick="this.closest('dialog').close()">Cancel</button><button class="btn btn-primary" type="submit">Save</button></div>
  </form></dialog>
  <dialog id="dns-found-dialog" class="dns-wide-dialog" aria-labelledby="dns-found-heading"><form id="dns-found-form" onsubmit="dnsTakeOver(event)">
    <div class="dialog-header"><h2 id="dns-found-heading">Redirects in Cloudflare</h2></div>
    <p class="hint">Whole-domain redirect rules in the zones your connections reach that DNS does not manage yet. Taking one over updates its rule in place; it never adds a second.</p>
    <div id="dns-found-body"></div>
    <div class="form-grid">${field("dns-found-profile", "Profile", '<select id="dns-found-profile" name="profileId"></select>', "For their mail and other rows. The domains' own address records become the redirect's.")}</div>
    <div class="actions dialog-actions"><button class="btn" type="button" onclick="this.closest('dialog').close()">Cancel</button><button class="btn btn-primary" id="dns-found-submit" type="submit">Take over selected</button></div>
  </form></dialog>
  <dialog id="dns-connection-dialog" aria-labelledby="dns-connection-heading"><form id="dns-connection-form" onsubmit="dnsSaveConnection(event)">
    <div class="dialog-header"><h2 id="dns-connection-heading">Connect Cloudflare</h2></div>
    <input type="hidden" name="id">
    <ol class="dns-steps">
      <li id="dns-token-step"><strong>Create a token in Cloudflare</strong>
        <p class="hint">Check these permissions: <span id="dns-token-permissions"></span>. Choose the accounts and zones there; All zones also covers zones you add later.</p>
        <div id="dns-token-ips-hint"><p class="hint">Under Client IP Address Filtering, allow only this server:</p>
          <div class="dns-copy"><code id="dns-token-ips"></code><button class="dns-clip" type="button" title="Copy" aria-label="Copy the addresses" onclick="dnsCopyIps()">${CLIPBOARD}</button></div></div>
        <a class="btn" id="dns-token-link" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">Create token in Cloudflare ↗</a></li>
      <li><strong>Paste it here</strong>
        <div class="form-grid dns-token-grid">
          ${field("dns-connection-token", "API token", '<input id="dns-connection-token" name="token" type="password" autocomplete="new-password" spellcheck="false">')}
          ${field("dns-connection-label", "Name", '<input id="dns-connection-label" name="label" maxlength="40" autocomplete="off" placeholder="The account names">', "Optional.")}
        </div></li>
    </ol>
    ${actions("Connect")}
  </form></dialog>
  <dialog id="dns-mailcow-dialog" aria-labelledby="dns-mailcow-heading"><form id="dns-mailcow-form" onsubmit="dnsSaveMailcow(event)">
    <div class="dialog-header"><h2 id="dns-mailcow-heading">Mailcow</h2></div>
    <div class="form-grid">
      <div class="form-field" id="dns-mailcow-relay-field" hidden><label for="dns-mailcow-relay">Fill from SMTP Relay</label>
        <select id="dns-mailcow-relay" onchange="dnsFillFromRelay()"></select>
        <div class="hint">Takes the hostname and mailbox of an SMTP Relay profile.</div></div>
      ${field("dns-mailcow-url", "Hostname", '<input id="dns-mailcow-url" name="url" required placeholder="mail.example.com" autocomplete="off" spellcheck="false">', "Mailcow's web address, and what <code>{mailcow.host}</code> is: the MX and autodiscover target.")}
      ${field("dns-mailcow-key", "API key", '<input id="dns-mailcow-key" name="key" type="password" autocomplete="new-password" spellcheck="false">', "A read-write key. Limit it to this server's IP in Mailcow.")}
      ${field("dns-mailcow-mailbox", "Shared mailbox", '<input id="dns-mailcow-mailbox" name="sharedMailbox" type="email" autocomplete="off" placeholder="relay@example.com">', "Optional. An existing mailbox allowed to send as every domain, such as SMTP Relay's.")}
      ${field("dns-mailcow-dkim", "DKIM key", '<select id="dns-mailcow-dkim" name="dkimMode" onchange="dnsSyncDkim()"><option value="generate">A new key for each domain</option><option value="share">The key of another domain</option></select>')}
      <div class="form-field" id="dns-dkim-generate"><label for="dns-mailcow-selector">Selector and size</label>
        <div class="dns-inline"><input id="dns-mailcow-selector" name="dkimSelector" autocomplete="off" placeholder="dkim">
        <select name="dkimBits" aria-label="Key size"><option>1024</option><option selected>2048</option><option>3072</option><option>4096</option></select></div></div>
      <div class="form-field" id="dns-dkim-share" hidden><label for="dns-mailcow-source">Share the key of</label>
        <input id="dns-mailcow-source" name="dkimSource" autocomplete="off" placeholder="example.com"></div>
    </div>
    <p class="hint dns-dialog-note">A domain that already has a key in Mailcow keeps it. DNS publishes whatever key Mailcow holds.</p>
    ${actions("Save")}
  </form></dialog>
  <dialog id="dns-server-dialog" aria-labelledby="dns-server-heading"><form id="dns-server-form" onsubmit="dnsSaveServer(event)">
    <div class="dialog-header"><h2 id="dns-server-heading">Server addresses</h2></div>
    <div class="form-grid">
      ${field("dns-server-ipv4", "IPv4", '<input id="dns-server-ipv4" name="ipv4" autocomplete="off">', "Leave empty to use the detected address.")}
      ${field("dns-server-ipv6", "IPv6", '<input id="dns-server-ipv6" name="ipv6" autocomplete="off">', "Leave empty to use the detected address. Without one, AAAA rows are left out and stale AAAA records removed.")}
    </div>
    ${actions("Save")}
  </form></dialog>`;

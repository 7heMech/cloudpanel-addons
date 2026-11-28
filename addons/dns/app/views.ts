import CLIENT_BODY from "./views.client.js" with { type: "text" };
import STYLE from "./views.css" with { type: "text" };
import { esc } from "../../../lib/app-http";
import {
  ATTENTION_RANK, FLEET_FOOTER_HTML, FLEET_SELECTION_HTML, FLEET_ROW_SELECTION_JS,
  fleetFilterHtml, filterWord, renderLayout, sectionShellHtml, valueFilters, type SectionTab,
} from "../../../lib/app-ui";
import { mountPath } from "../../../lib/mount";
import type { DnsState, SiteView } from "../action";
import type { Profile } from "../model";
import { CLIPBOARD } from "../../../lib/clipboard";
import { CLOUDFLARE_SCOPE_JS } from "../../../lib/cloudflare/connect-dialog";
import { PROVIDER_LABELS } from "../provider";
import { SSL_LABELS } from "../zone";

const BASE = mountPath("dns");
const CLIENT = `${FLEET_ROW_SELECTION_JS}\n${CLOUDFLARE_SCOPE_JS}\nconst DNS_CLIPBOARD = ${JSON.stringify(CLIPBOARD)};\n${CLIENT_BODY}`;
const NO_PROFILE = "Not managed";

export function layout(title: string, content: string, notice?: { current: string; latest: string } | null): string {
  return renderLayout(title, content, { base: BASE, css: STYLE, script: CLIENT, updateNotice: notice });
}

const TYPE_LABELS: Record<string, string> = {
  wordpress: "WordPress", php: "PHP", static: "Static", nodejs: "Node.js", python: "Python", "reverse-proxy": "Reverse proxy",
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

function zoneSummary(profile: Profile, hasCloudflare: boolean): string {
  if (!hasCloudflare) return profile.mailcow ? "Mailcow" : '<span class="tone-muted">—</span>';
  const parts: string[] = [];
  if (profile.zone.ssl) parts.push(SSL_LABELS[profile.zone.ssl]);
  if (profile.zone.alwaysHttps !== null) parts.push(`Always HTTPS ${profile.zone.alwaysHttps ? "on" : "off"}`);
  const rules = [profile.zone.acmeFullSsl && "Let's Encrypt", profile.zone.webmailFullSsl && "webmail", profile.zone.skipFirewallIps.length && "firewall skip"].filter(Boolean);
  const extras = [profile.mailcow && "Mailcow"].filter(Boolean);
  return `${esc(parts.join(" · ") || "Zone settings unchanged")}${rules.length || extras.length ? `<span class="hint">${esc([rules.length ? `Rules: ${rules.join(", ")}` : "", ...extras].filter(Boolean).join(" · "))}</span>` : ""}`;
}

function profileRow(profile: DnsState["profiles"][number], hasCloudflare: boolean): string {
  return `<tr data-profile="${esc(profile.id)}">
    <td class="site-cell"><strong>${esc(profile.name)}</strong><span class="dns-card-sites"> · ${plural(profile.sites, "site")}</span></td>
    <td data-label="Records">${recordSummary(profile)}</td>
    <td data-label="${hasCloudflare ? "Zone" : "Options"}" class="wide-cell">${zoneSummary(profile, hasCloudflare)}</td>
    <td data-label="Sites" class="numeric dns-sites-cell">${profile.sites}</td>
    <td data-label="Actions" class="action-cell"><div class="actions">
      <button class="btn" type="button" onclick="dnsEditProfile('${esc(profile.id)}')">Edit</button>
      <button class="btn btn-danger" type="button" onclick="dnsDeleteProfile('${esc(profile.id)}')">Delete</button>
    </div></td>
  </tr>`;
}

/** What one site's DNS amounts to, in a word and a line. */
export function siteStatus(site: SiteView, automatic: boolean, singleConnection = false): { label: string; tone: string; hint: string } {
  const plan = site.plan;
  if (!site.profileId) return { label: "—", tone: "muted", hint: "" };
  if (!plan) return { label: "Not checked yet", tone: "muted", hint: "" };
  const suffix = plan.zone && !singleConnection ? ` · ${plan.zone.connection}` : "";
  const zone = plan.zone ? `${plan.zone.name}${suffix}` : "";
  if (plan.problems.length) return { label: "Needs attention", tone: "bad", hint: plan.problems[0]! };
  const waiting = plan.changes.filter((change) => change.waits).length;
  if (waiting) return { label: "Waits for review", tone: "warn", hint: `Its address is in place; ${plural(waiting, "change")} reach${waiting === 1 ? "es" : ""} further` };
  const pending = plan.changes.filter((change) => change.action !== "note").length;
  if (plan.zone && plan.zone.status !== "active") return { label: `Zone ${plan.zone.status}`, tone: "warn", hint: "Set its nameservers at the registrar" };
  if (!plan.zone && pending) return { label: "Zone to create", tone: "warn", hint: "" };
  if (pending) return { label: automatic ? `${plural(pending, "change")} to make` : plural(pending, "difference"), tone: "warn", hint: zone };
  return { label: "In sync", tone: "ok", hint: plan.wildcard && plan.zone ? `${plan.wildcard}${suffix}` : zone };
}

/** A line under a status, cut to two lines in the table; Details and the tooltip have it whole. */
function hintLine(text: string): string {
  return text ? `<span class="hint dns-clamp" title="${esc(text)}">${esc(text)}</span>` : "";
}

function typeLabel(site: SiteView): string {
  return TYPE_LABELS[site.type] ?? site.type;
}

/** The status cell both tables share: a chip, then its line and the certificate's, each cut to two lines. */
function statusCell(site: SiteView, automatic: boolean, singleConnection = false): string {
  const status = siteStatus(site, automatic, singleConnection);
  return `${status.label === "—" ? '<span class="tone-muted">—</span>' : `<span class="badge tone-${status.tone}">${esc(status.label)}</span>`}${hintLine(status.hint)}${
    site.ssl ? hintLine(site.ssl.startsWith("Waiting for DNS") ? "Certificate requested; waits for DNS" : `Certificate: ${site.ssl}`) : ""}`;
}

function siteRow(site: SiteView, state: DnsState): string {
  const single = state.connections.length <= 1;
  const status = siteStatus(site, state.automatic, single);
  const profile = state.profiles.find((candidate) => candidate.id === site.profileId);
  const show = [
    status.tone === "bad" ? "attention" : status.tone === "warn" ? "pending" : "",
    filterWord("type", typeLabel(site)),
    profile ? "" : "unmanaged",
  ].filter(Boolean).join(" ");
  const sorts = ` data-sort-attention="${ATTENTION_RANK[status.tone as keyof typeof ATTENTION_RANK] ?? ATTENTION_RANK.muted}" data-sort-profile="${esc(profile?.name ?? "")}" data-sort-type="${esc(typeLabel(site))}"`;
  return `<tr data-domain="${esc(site.domain)}" data-profile-id="${esc(site.profileId ?? "")}" data-show="${show}"${sorts}${site.plan?.held ? " data-held" : ""} tabindex="0" aria-selected="false" onclick="toggleSiteSelection(event, this)" onkeydown="toggleSiteSelection(event, this)">
    <td class="site-select"><input class="site-checkbox" type="checkbox" onchange="paintFleetSelection()" aria-label="Select ${esc(site.domain)}"></td>
    <td class="site-cell"><strong>${esc(site.domain)}</strong></td>
    <td class="type-cell">${esc(typeLabel(site))}</td>
    <td data-label="Profile" class="dns-profile-cell"><select aria-label="Profile for ${esc(site.domain)}" onchange="dnsAssignRow(this)">${profileOptions(state.profiles, site.profileId, NO_PROFILE)}</select></td>
    <td data-label="DNS" class="dns-status">${statusCell(site, state.automatic, single)}</td>
    <td class="action-cell">${site.profileId ? `<button class="btn" type="button" onclick="dnsShowSite('${esc(site.domain)}')">Details</button>` : ""}</td>
  </tr>`;
}

type Access = NonNullable<DnsState["connections"][number]["access"]>;

const NOTE_MAX = 200;

/** What is missing of what DNS requires, by name; nothing when the token holds all of it. */
function accessProblems(access: Access): string {
  const required = access.rows.filter((row) => !row.optional);
  const missing = required.filter((row) => row.held === "no").map((row) => row.label);
  const partial = required.filter((row) => row.held === "some").map((row) => `${row.label} (${row.detail})`);
  // Without its own read, what Cloudflare refused it is all that is known.
  const lines = access.reach === null
    ? [missing.length && `Refused by Cloudflare: ${missing.join(", ")}`]
    : [missing.length && `Missing: ${missing.join(", ")}`, partial.length && `Not on every zone: ${partial.join(", ")}`];
  const note = access.reach === null ? [`<span class="tone-warn">${esc(sentence(access.note ?? ""))}</span>`] : [];
  return [...note, ...lines.filter(Boolean).map((line) => `<span class="tone-bad">${esc(line as string)}</span>`)].join("<br>");
}

/** Cloudflare's own error text can be long and end in its own punctuation. */
function sentence(text: string): string {
  const short = text.length > NOTE_MAX ? `${text.slice(0, NOTE_MAX - 1).trimEnd()}…` : text;
  return /[.!?…]$/.test(short) ? short : `${short}.`;
}

function heldCell(row: Access["rows"][number]): string {
  if (row.held === "yes") return '<span class="tone-ok" role="img" aria-label="Held">✓</span>';
  if (row.held === "unknown") return '<span class="hint inline" role="img" aria-label="Not known">—</span>';
  if (row.optional && row.held !== "some") return '<span class="hint inline">Not added</span>';
  if (row.held === "no") return `<span class="badge tone-bad">${esc(row.detail ?? "Missing")}</span>`;
  return `<span class="badge tone-warn">${esc(row.detail ?? "Some zones")}</span>`;
}

function accessRow(row: Access["rows"][number]): string {
  return `<div class="dns-access-row" role="row" data-held="${row.held}">
      <span class="dns-access-perm" role="cell">${esc(row.label)}</span>
      <span class="dns-access-use" role="cell">${esc(row.usedFor)}</span>
      <span class="dns-access-held" role="cell">${heldCell(row)}</span></div>`;
}

/** The connection's status line opens the table of what its token holds; optional permissions follow under their own heading. */
function accessDetails(id: string, access: Access, status: string): string {
  const optional = access.rows.filter((row) => row.optional);
  const rows = access.rows.filter((row) => !row.optional).map(accessRow).join("") + (optional.length
    ? `<div class="dns-access-row dns-access-cols dns-access-section" role="row"><span role="columnheader">Optional</span><span role="columnheader">Enables</span><span></span></div>${optional.map(accessRow).join("")}`
    : "");
  const problems = accessProblems(access);
  return `<details class="dns-access-details" id="dns-access-${esc(id)}"><summary><span class="hint">${status} · <span class="dns-access-toggle">Permissions</span></span>${problems ? `<span class="dns-access-problems">${problems}</span>` : ""}</summary>
    <div class="dns-access"><div class="dns-access-grid" role="table" aria-label="Token permissions">
      <div class="dns-access-row dns-access-cols" role="row"><span role="columnheader">Permission</span><span role="columnheader">Used for</span><span role="columnheader">This token</span></div>${rows}</div>
      <p class="dns-access-foot hint"><a href="${esc(access.editUrl)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">Edit in Cloudflare ↗</a></p></div></details>`;
}

function connectionRow(connection: DnsState["connections"][number]): string {
  const provider = connection.provider ?? "cloudflare";
  const badge = `<span class="badge dns-provider-badge">${esc(PROVIDER_LABELS[provider])}</span>`;
  const status = connection.active ? '<span class="tone-ok">Active</span>' : `<span class="tone-bad">${esc(connection.status === "unchecked" ? "Not checked" : "Not working")}</span>`;
  if (provider === "powerdns") {
    const meta = [
      connection.url,
      connection.serverId && connection.serverId !== "localhost" ? `server ${connection.serverId}` : "",
      connection.defaultTtl ? `default TTL ${connection.defaultTtl}s` : "",
      connection.createZones ? "creates zones" : "",
    ].filter(Boolean).join(" · ");
    const line = `${esc(plural(connection.zones, "zone"))} · ${status}${connection.error ? ` · ${esc(connection.error)}` : ""}`;
    return `<div class="dns-setting-row dns-connection-row" data-connection="${esc(connection.id)}">
      <div class="dns-setting-main">
        <div class="dns-connection-title"><strong>${esc(connection.label)}</strong>${badge}</div>
        ${meta ? `<span class="hint">${esc(meta)}</span>` : ""}
        <span class="hint">${line}</span>
      </div>
      <div class="actions">
        <button class="btn" type="button" onclick="dnsEditConnection('${esc(connection.id)}')">Edit</button>
        <button class="btn btn-danger" type="button" onclick="dnsRemoveConnection('${esc(connection.id)}')">Remove</button>
      </div>
    </div>`;
  }
  const accounts = connection.accounts.map((account) => account.name || account.id).join(", ");
  const { access } = connection;
  const reach = access?.reach ? `${access.reach} · ${plural(connection.zones, "zone")} now` : plural(connection.zones, "zone");
  const line = `${esc(reach)} · ${status}${connection.error ? ` · ${esc(connection.error)}` : ""}`;
  return `<div class="dns-setting-row dns-connection-row" data-connection="${esc(connection.id)}">
    <div class="dns-setting-main">
      <div class="dns-connection-title"><strong>${esc(connection.label)}</strong>${badge}</div>${accounts ? `<span class="hint">${esc(accounts)}</span>` : ""}
      ${access ? accessDetails(connection.id, access, line) : `<span class="hint">${line}</span>`}
    </div>
    <div class="actions">
      <button class="btn" type="button" onclick="dnsEditConnection('${esc(connection.id)}')">Edit</button>
      <button class="btn btn-danger" type="button" onclick="dnsRemoveConnection('${esc(connection.id)}')">Remove</button>
    </div>
  </div>`;
}

function address(value: string, detected: string | null, placeholder: string): string {
  const name = `<span class="mono">${esc(placeholder)}</span>`;
  if (value) return `${name} ${esc(value)}`;
  if (detected) return `${name} ${esc(detected)} <span class="hint inline">detected</span>`;
  return `${name} <span class="tone-warn">${detected === null ? "not detected" : "none"}</span>`;
}

/** Where a site's missing zone is created; shown only when connections span multiple accounts or a saved choice went missing. */
function newZonesRow(state: DnsState): string {
  const chosen = state.createIn && state.accounts.find((account) => account.connectionId === state.createIn!.connectionId && account.accountId === state.createIn!.accountId);
  if (state.accounts.length <= 1 && !(state.createIn && !chosen)) return "";
  const value = `<select id="dns-zone-account" aria-label="Account for new zones" onchange="dnsSetZoneAccount(this)">
        <option value=""${chosen ? "" : " selected"}>${chosen ? "Not chosen" : "Choose an account"}</option>${state.accounts.map((account) => {
          const key = `${account.connectionId}/${account.accountId}`;
          return `<option value="${esc(key)}"${chosen === account ? " selected" : ""}>${esc(account.label)}</option>`;
        }).join("")}</select>`;
  return `<div class="dns-setting-row"><div class="dns-setting-main"><strong>New zones</strong>
        <span class="hint">Account or server where missing zones are created.</span></div>
        <div class="dns-setting-control">${value}</div></div>`;
}

function connectionsCard(state: DnsState): string {
  const rows = state.connections.map(connectionRow).join("");
  return `<div class="card" id="dns-connection"><div class="card-header"><div><h2>DNS connections</h2>
      <p class="hint">Cloudflare connections are shared with Redirects and Firewall. A site uses the longest matching zone across connected providers.</p></div>
      <div class="actions dns-connection-actions">
        <button class="btn" type="button" onclick="dnsEditConnection('', 'cloudflare')">Add Cloudflare</button>
        <button class="btn" type="button" onclick="dnsEditConnection('', 'powerdns')">Add PowerDNS</button>
      </div></div>
    <div class="dns-setting-list">${rows}${newZonesRow(state)}</div></div>`;
}

function syncModeCard(state: DnsState): string {
  const onlyCf = state.connections.length > 0 && state.connections.every((connection) => connection.provider === "cloudflare");
  return `<div class="card split-card" id="dns-mode"><div><h2>Automatic sync</h2>
      <p class="hint">${state.automatic
        ? "On. DNS keeps every assigned site in sync and creates missing zones where enabled."
        : `Ask first. DNS shows differences without writing to ${onlyCf ? "Cloudflare" : "your DNS provider"} or Mailcow.`}</p></div>
      <button class="btn${state.automatic ? "" : " btn-primary"}" type="button" onclick="dnsSetAutomatic(${state.automatic ? "false" : "true"})">${state.automatic ? "Switch to Ask first" : "Review and turn on Automatic"}</button></div>`;
}

function integrationsCard(state: DnsState): string {
  const { mailcow, server } = state;
  const dkim = mailcow.dkimSource ? `shares the DKIM key of ${mailcow.dkimSource}` : `${mailcow.dkimBits}-bit DKIM, selector ${mailcow.dkimSelector}`;
  const mailcowSummary = mailcow.url ? new URL(mailcow.url).host : "Optional · not set up";
  const mailcowOpen = Boolean(mailcow.url || mailcow.hasKey);
  const serverOverridden = Boolean(server.ipv4 || server.ipv6 || (!server.detected.ipv4 && !server.detected.ipv6));
  const serverSummary = [server.ipv4 || server.detected.ipv4, server.ipv6 || server.detected.ipv6].filter(Boolean).join(" · ") || "Not detected";
  return `<div class="card"><div class="card-header"><h2>Integrations &amp; advanced</h2></div>
    <details class="disclosure" id="dns-mailcow-disclosure"${mailcowOpen ? " open" : ""}>
      <summary><div><span class="summary-title">Mailcow</span><span class="hint">${esc(mailcowSummary)}</span></div></summary>
      <div class="dns-setting-row dns-disclosure-row"><div class="dns-setting-main">
        ${mailcow.url
          ? `<span class="mono">{mailcow.host}</span> ${esc(mailcow.host)}<span class="hint">${esc([dkim, mailcow.sharedMailbox && `${mailcow.sharedMailbox} may send as each domain`].filter(Boolean).join(" · "))}</span>`
          : '<span class="hint">Connect Mailcow only if a profile manages mail domains and DKIM keys.</span>'}
      </div><div class="actions">
        <button class="btn" type="button" onclick="dnsEditMailcow()">${mailcow.url ? "Edit" : "Set up"}</button>
        ${mailcow.url || mailcow.hasKey ? '<button class="btn btn-danger" type="button" onclick="dnsRemoveMailcow()">Remove</button>' : ""}
      </div></div>
    </details>
    <details class="disclosure" id="dns-server-disclosure"${serverOverridden ? " open" : ""}>
      <summary><div><span class="summary-title">Server addresses</span><span class="hint">${esc(serverSummary)}</span></div></summary>
      <div class="dns-setting-row dns-disclosure-row"><div class="dns-setting-main">
        ${address(server.ipv4, server.detected.ipv4, "{ipv4}")}<br>${address(server.ipv6, server.detected.ipv6, "{ipv6}")}
      </div><div class="actions"><button class="btn" type="button" onclick="dnsEditServer()">Edit</button></div></div>
    </details>
  </div>`;
}

const PANEL_SETTINGS_URL = "/admin/settings";

/** A name for CloudPanel itself, pointed here and proxied on Cloudflare once CloudPanel has its certificate. */
function panelHostCard(state: DnsState): string {
  const host = state.panelHost;
  const hasCloudflare = state.connections.some((connection) => connection.provider === "cloudflare");
  const hasPowerDns = state.connections.some((connection) => connection.provider === "powerdns");
  const zones = state.zones.length
    ? `<datalist id="dns-zone-list">${state.zones.map((zone) => `<option value="${esc(zone)}"></option>`).join("")}</datalist>`
    : "";
  const adoptLabel = hasCloudflare && !hasPowerDns ? "Manage in Cloudflare" : "Manage in DNS";
  const adopt = !host && state.customDomain
    ? `<div class="notice dns-adopt-bar"><span>CloudPanel already uses <strong>${esc(state.customDomain.name)}</strong>${state.customDomain.issued ? " with a valid certificate" : ""}.</span>
        <button class="btn" type="button" onclick="dnsAdoptPanelHost('${esc(state.customDomain.name)}')">${adoptLabel}</button></div>`
    : "";
  const form = `<form class="dns-panel-host-form" onsubmit="dnsSavePanelHost(event)">
      <input id="dns-panel-host-name" name="name" aria-label="Panel hostname" autocomplete="off" spellcheck="false" placeholder="k7m2p9x4.example.com"${zones ? ' list="dns-zone-list"' : ""} value="${esc(host?.name ?? "")}">${zones}
      <button class="btn" type="button" onclick="dnsRandomPanelHost()">Random</button>
      <button class="btn" type="submit">${host ? "Change" : "Save"}</button>
      ${host ? '<button class="btn btn-danger" type="button" onclick="dnsRemovePanelHost()">Remove</button>' : ""}</form>`;
  let body = "";
  if (host) {
    const planProblems = host.plan?.problems ?? [];
    const hasProblems = Boolean(host.problem || planProblems.length);
    const status = host.problem
      ? { label: "Needs attention", tone: "bad", hint: host.problem }
      : siteStatus({ domain: host.name, type: "panel", profileId: "panel-hostname", plan: host.plan, ssl: null }, state.automatic, state.connections.length <= 1);
    const pending = host.plan?.changes.filter((change) => change.action !== "note") ?? [];
    const settings = `<a href="${PANEL_SETTINGS_URL}">Admin → Settings → Custom Domain</a>`;
    const custom = host.customDomain;
    const isPowerDns = host.plan?.zone ? host.plan.zone.provider === "powerdns" : !hasCloudflare;
    const next = hasProblems ? ""
      : isPowerDns && custom?.name === host.name && custom.issued && !pending.length && host.plan
        ? `CloudPanel's custom domain, pointed directly at this server${host.plan.wildcard ? ` via ${esc(host.plan.wildcard)}` : ""}.`
      : isPowerDns && custom?.name === host.name && !custom.issued
        ? "CloudPanel is getting its certificate."
      : !isPowerDns && host.proxied && !pending.length && host.plan ? `CloudPanel's custom domain, proxied through Cloudflare${host.plan.wildcard ? ` via ${esc(host.plan.wildcard)}` : ""}. The zone's Full SSL rule keeps Let's Encrypt renewals working.`
      : !isPowerDns && !host.proxied && custom?.name === host.name ? "CloudPanel is getting its certificate. DNS proxies it through Cloudflare once issued."
      : pending.length || !host.plan ? (state.automatic ? (pending.length ? "The next check writes these, within 15 minutes." : "") : "DNS asks first, so the record is written once you turn on Automatic.")
      : isPowerDns
        ? `Next: enter ${esc(host.name)} under ${settings} in CloudPanel.${custom ? ` CloudPanel's custom domain is ${esc(custom.name)} now.` : ""}`
        : `Next: enter ${esc(host.name)} under ${settings} in CloudPanel. DNS proxies it through Cloudflare once CloudPanel has its certificate.${custom ? ` CloudPanel's custom domain is ${esc(custom.name)} now.` : ""}`;
    // Show extra problems only past the first, which is already in the badge hint.
    const extraProblems = host.problem ? planProblems : planProblems.slice(1);
    body = `<div class="dns-panel-host-status"><span class="badge tone-${status.tone}">${esc(status.label)}</span>${status.hint ? `<span class="hint">${esc(status.hint)}</span>` : ""}</div>
      ${host.plan?.wildcardBlocked && !hasProblems ? `<p class="hint dns-wildcard-note">${esc(host.plan.wildcardBlocked)}.</p>` : ""}
      ${pending.length && !hasProblems ? `<ul class="dns-panel-host-changes">${pending.map((change) =>
        `<li><span class="badge dns-${esc(change.action)}">${esc(LOG_LABELS[change.action] ?? change.action)}</span> <strong>${esc(change.subject)}</strong> <span class="hint">${esc(change.detail)}</span></li>`).join("")}</ul>` : ""}
      ${extraProblems.length ? `<ul class="dns-panel-host-changes">${extraProblems.map((problem) => `<li class="tone-bad">${esc(problem)}</li>`).join("")}</ul>` : ""}
      ${next ? `<p class="dns-panel-host-next">${next}</p>` : ""}`;
  }
  return `<div class="card" id="dns-panel-host"><div class="card-header"><div><h2>Panel hostname</h2>
      <p class="hint">${hasCloudflare
        ? "Points a hard-to-guess name at this server for CloudPanel's certificate, then proxies it or hands it off to your zone's wildcard."
        : "Points a hard-to-guess name at this server for CloudPanel's certificate, or hands it off to your zone's wildcard."}</p></div></div>
    <div class="dns-panel-host-body">${adopt}${form}${body}</div></div>`;
}

/** Until a DNS provider is connected: the three steps that make a new site publish itself. */
function setupCard(state: DnsState): string {
  if (state.connections.length) return "";
  const fallback = state.profiles.find((profile) => profile.id === state.defaultProfileId);
  const step = (done: boolean, title: string, hint: string, control: string): string =>
    `<li class="${done ? "done" : ""}"><div><strong>${title}</strong><span class="hint">${hint}</span></div><div class="dns-step-control">${control}</div></li>`;
  return `<div class="card dns-setup" id="dns-connection"><h2>Set up DNS</h2><ol class="dns-checklist">
    ${step(false, "Connect a DNS provider", "Connect Cloudflare (shared with Redirects and Firewall) or a PowerDNS Authoritative API v1 server.",
      '<div class="actions dns-setup-actions"><button class="btn btn-primary" type="button" onclick="dnsEditConnection(\'\', \'cloudflare\')">Connect Cloudflare</button><button class="btn" type="button" onclick="dnsEditConnection(\'\', \'powerdns\')">Connect PowerDNS</button></div>')}
    ${step(Boolean(fallback), "Choose the profile for new sites", "A new site joins it seconds after CloudPanel creates it. Existing sites are never moved.",
      `<select id="dns-setup-default" aria-label="Profile for new sites" onchange="dnsSetDefault(this)">${profileOptions(state.profiles, state.defaultProfileId, "No profile")}</select>`)}
    ${step(state.automatic, "Turn on Automatic", "Until then DNS previews changes and writes nothing.",
      state.automatic ? '<span class="tone-ok">On</span>' : '<span class="hint">After connecting</span>')}
  </ol></div>`;
}

/** Shown on the Sites tab while DNS asks first. */
function modeBar(state: DnsState): string {
  if (state.automatic || !state.connections.length) return "";
  const plans = state.sites.flatMap((site) => site.plan ? [site.plan] : []);
  const changes = plans.flatMap((plan) => plan.changes.filter((change) => change.action !== "note"));
  const zones = new Set(changes.filter((change) => change.subject.endsWith(" zone")).map((change) => change.detail.split(" ")[0])).size;
  const busy = plans.filter((plan) => plan.changes.some((change) => change.action !== "note")).length;
  const waiting = changes.length
    ? ` ${plural(changes.length - zones, "change")}${zones ? ` and ${plural(zones, "new zone")}` : ""} across ${plural(busy, "site")} are waiting.`
    : "";
  return `<div class="notice dns-mode-bar" id="dns-mode-banner"><span><strong>Ask first.</strong> DNS previews differences and writes nothing until Automatic is on.${waiting}</span>
    <button class="btn btn-primary" type="button" onclick="dnsSetAutomatic(true)">Review and turn on Automatic</button></div>`;
}

const LOG_LABELS: Record<string, string> = { create: "Create", update: "Update", delete: "Delete" };

function logRow(line: DnsState["log"][number]): string {
  const when = line.at.slice(0, 16).replace("T", " ");
  const where = [line.sites.join(", "), line.zone && !line.sites.includes(line.zone) ? line.zone : ""].filter(Boolean).join(" · ");
  return `<tr><td class="dns-log-when"><span class="mono">${esc(when)}</span> <span class="hint">${esc(line.cause)}</span></td>
    <td><span class="badge dns-${esc(line.action)}">${LOG_LABELS[line.action] ?? esc(line.action)}</span></td>
    <td class="wide-cell"><strong>${esc(line.subject)}</strong>${where ? `<span class="hint">${esc(where)}</span>` : ""}</td>
    <td class="wide-cell dns-change-detail">${esc(line.detail)}${line.before ? `<span class="hint">Was: ${esc(line.before)}</span>` : ""}</td></tr>`;
}

export function dashboardView(state: DnsState): string {
  return `<div id="dns-root">${dashboardContent(state)}</div>${DIALOGS}`;
}

function connectionAttention(state: DnsState): "bad" | "warn" | undefined {
  let warn = false;
  for (const connection of state.connections) {
    if (!connection.active) return "bad";
    if (connection.access?.rows.some((row) => !row.optional && (row.held === "no" || row.held === "some"))) return "bad";
    if (connection.access && connection.access.reach === null) warn = true;
  }
  if (state.panelHost?.problem || state.panelHost?.plan?.problems.length) return "bad";
  return warn ? "warn" : undefined;
}

/** Everything a change can alter, repainted in place from the action's reply. */
export function dashboardContent(state: DnsState, now = Date.now()): string {
  const data = JSON.stringify(state).replaceAll("<", "\\u003c");
  const plain = state.sites;
  const hasCloudflare = state.connections.some((connection) => connection.provider === "cloudflare");
  const hasPowerDns = state.connections.some((connection) => connection.provider === "powerdns");
  const waiting = state.waitUntil > now
    ? `<div class="notice">A DNS provider or Mailcow asked this server to wait until ${esc(new Date(state.waitUntil).toISOString().slice(11, 16))} UTC. Checks resume after that.</div>` : "";
  const pageAction = state.connections.length
    ? '<div class="page-actions"><button class="btn" type="button" onclick="dnsCheck(this)">Check now</button></div>'
    : "";
  const heading = `<script type="application/json" id="dns-state">${data}</script>
    <div class="page-heading"><div><h1>DNS</h1>
      <p>Keep each site's DNS synced to its profile.</p></div>${pageAction}</div>`;

  // Before any DNS provider is connected, replace the workspace tables and forms with the focused first-run flow.
  if (!state.connections.length) {
    return `${heading}${waiting}${setupCard(state)}`;
  }

  const single = state.connections.length <= 1;
  const profiles = state.profiles.map((profile) => profileRow(profile, hasCloudflare)).join("");
  const sites = plain.map((site) => siteRow(site, state)).join("");
  const checked = `<div class="card-footer"><span class="hint">${esc(ago(state.checkedAt, now))}. Drift is checked every 15 minutes.</span></div>`;
  const orphanProvider = hasCloudflare && !hasPowerDns ? "Cloudflare" : hasPowerDns && !hasCloudflare ? "PowerDNS" : "your DNS provider";
  const orphans = state.orphans.length ? `<div class="card card-table"><div class="card-header"><div><h2>Records of deleted sites</h2>
      <p class="hint">These sites are gone from CloudPanel. Their records stay in ${orphanProvider} until you remove them.</p></div></div>
      <div class="table-scroll"><table class="fleet-table dns-orphan-table"><tbody>${state.orphans.map((orphan) => `<tr>
        <td class="site-cell"><strong>${esc(orphan.domain)}</strong><span class="hint">${esc(plural(orphan.records, "record"))} in ${esc(orphan.zone)}</span></td>
        <td data-label="Actions" class="action-cell"><div class="actions">
          <button class="btn" type="button" onclick="dnsForget('${esc(orphan.domain)}')">Keep</button>
          <button class="btn btn-danger" type="button" onclick="dnsRemoveRecords('${esc(orphan.domain)}')">Remove records</button>
        </div></td></tr>`).join("")}</tbody></table></div></div>` : "";

  const sitesPanel = `${waiting}${modeBar(state)}${orphans}
    <div class="card card-table dns-site-card">
    ${plain.length ? `<div class="card-header toolbar">
        <h2>Sites</h2>
        ${FLEET_SELECTION_HTML}
        <div class="toolbar-end actions bulk-assign">
          <select id="bulk-profile" aria-label="Profile for the selected sites"><option value="" selected disabled>Choose a profile</option>${state.profiles
            .map((profile) => `<option value="${esc(profile.id)}">${esc(profile.name)}</option>`).join("")}<option value="-">${NO_PROFILE}</option></select>
          <button class="btn" id="assign-selected" type="button" disabled data-needs-selection onclick="dnsAssignSelected()">Assign selected</button>
        </div>
      </div>
      ${fleetFilterHtml({
        count: plain.length,
        filters: [
          { value: "attention", label: "Needs attention" }, { value: "pending", label: "Changes waiting" }, { value: "unmanaged", label: "Not managed" },
          ...valueFilters("Type", "type", plain.map(typeLabel)),
        ],
        summary: plural(plain.length, "site"),
      })}
      <div class="table-scroll"><table class="fleet-table dns-site-table"><thead><tr>
        <th class="site-select"><input id="select-all" type="checkbox" onchange="selectAllSites(this.checked)" aria-label="Select all sites"></th>
        <th data-sort="domain">Site</th><th data-sort="type">Runs</th><th data-sort="profile">Profile</th><th data-sort="attention">DNS</th><th class="action-cell"></th>
      </tr></thead><tbody>${sites}</tbody></table></div>
      ${FLEET_FOOTER_HTML}
      ${checked}`
      : `<div class="card-header"><h2>Sites</h2></div><div class="empty">CloudPanel has no sites yet.</div>${checked}`}
    </div>`;

  const profilesPanel = `<div class="card card-table"><div class="card-header"><div><h2>Profiles</h2>
      <p class="hint">Record templates kept in sync for assigned sites.</p></div>
      <div class="dns-profile-tools">
        <div class="dns-default-field"><label class="hint" for="dns-default">New sites join</label>
          <select id="dns-default" onchange="dnsSetDefault(this)">${profileOptions(state.profiles, state.defaultProfileId, "No profile")}</select></div>
        <button class="btn btn-primary" type="button" onclick="dnsEditProfile('')">New profile</button></div></div>
      ${profiles ? `<div class="table-scroll"><table class="fleet-table dns-profile-table"><thead><tr><th>Profile</th><th>Records</th><th>${hasCloudflare ? "Zone" : "Options"}</th><th class="numeric">Sites</th><th class="action-cell">Actions</th></tr></thead><tbody>${profiles}</tbody></table></div>`
        : '<div class="empty">No profiles yet. Create one from the Web and Mailcow presets.</div>'}
    </div>`;

  const settingsPanel = `${connectionsCard(state)}${syncModeCard(state)}${panelHostCard(state)}${integrationsCard(state)}`;

  const logPanel = `<div class="card card-table"><div class="card-header"><div><h2>Change log</h2>
      <p class="hint">Record, zone and Mailcow writes, newest first.</p></div></div>
      ${state.log.length ? `<div class="table-scroll"><table class="fleet-table dns-log-table"><tbody>${state.log.slice(0, 10).map(logRow).join("")}</tbody></table></div>
      ${state.log.length > 10 ? `<details class="dns-log-more"><summary>Show ${plural(state.log.length - 10, "earlier change")}</summary>
        <div class="table-scroll"><table class="fleet-table dns-log-table"><tbody>${state.log.slice(10).map(logRow).join("")}</tbody></table></div></details>` : ""}`
    : `<div class="empty">${state.automatic ? "No changes yet."
      : "No changes yet. DNS asks first, so it writes nothing until you turn on Automatic."}</div>`}
    </div>`;

  const siteTones = plain.map((site) => siteStatus(site, state.automatic, single).tone);
  const sitesAttention: "bad" | "warn" | undefined = siteTones.includes("bad") ? "bad" : siteTones.includes("warn") || state.orphans.length ? "warn" : undefined;
  const tabs: SectionTab[] = [
    { id: "sites", label: "Sites", count: plain.length, attention: sitesAttention, content: sitesPanel },
    { id: "profiles", label: "Profiles", count: state.profiles.length, content: profilesPanel },
    { id: "settings", label: "Settings", attention: connectionAttention(state), content: settingsPanel },
    { id: "activity", label: "Activity", content: logPanel },
  ];

  return `${heading}${sectionShellHtml("dns", "DNS sections", tabs, "sites")}`;
}

const field = (id: string, label: string, control: string, hint = "", full = false): string =>
  `<div class="form-field${full ? " form-field-full" : ""}"><label for="${id}">${label}</label>${control}${hint ? `<div class="hint">${hint}</div>` : ""}</div>`;

const actions = (save: string): string =>
  `<div class="actions dialog-actions"><button class="btn" type="button" onclick="this.closest('dialog').close()">Cancel</button><button class="btn btn-primary" type="submit">${save}</button></div>`;

const switchField = (name: string, label: string, hint: string): string =>
  `<label class="dns-switch-row"><span class="switch"><input type="checkbox" name="${name}"><span></span></span><span><strong>${label}</strong><span class="hint">${hint}</span></span></label>`;

const PLACEHOLDERS: [string, string][] = [
  ["{domain}", "the site's domain"], ["{zone}", "its DNS zone"], ["{sub}", "the part before the zone"],
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
    <div class="dns-rows-wrap"><table class="dns-rows" id="dns-rows-table"><thead><tr><th>Type</th><th>Name</th><th>Content</th><th class="dns-adv">TTL</th><th class="dns-adv">Apex only</th><th class="dns-proxy-col" id="dns-proxy-head">Proxy</th><th><span class="visually-hidden">Remove</span></th></tr></thead>
      <tbody id="dns-rows"></tbody></table></div>
    <p class="hint dns-empty-rows" id="dns-empty-rows" hidden>No records yet. Add one, or start from a preset.</p>
    <p class="hint dns-mixed-note" id="dns-mixed-note" hidden>Proxy and Cloudflare zone settings apply to Cloudflare zones only. PowerDNS zones use unproxied records and their connection's default TTL when a row is set to Auto.</p>
    <div class="dns-placeholders"><span class="hint">Placeholders, inserted where the cursor is:</span>
      ${PLACEHOLDERS.map(([token, meaning]) => `<button class="dns-chip" type="button" title="${esc(meaning)}" onmousedown="event.preventDefault()" onclick="dnsInsert('${token}')">${token}</button>`).join("")}</div>
    <div id="dns-mailcow-section"><h3 class="dns-section">Mailcow</h3>
    ${switchField("mailcow", "Set up each site's domain in Mailcow", "Adds the domain if it is missing, gives it a DKIM key, and lets the shared mailbox send as it. A Mailcow domain is never deleted.")}</div>
    <details class="dns-zone-details" id="dns-zone-details"><summary><h3 id="dns-zone-details-heading">Cloudflare zone</h3><span class="hint" id="dns-zone-summary"></span></summary>
    <p class="hint">These apply to the whole Cloudflare zone, not only to this profile's sites.</p>
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
    <div class="actions dialog-actions"><button class="btn" type="button" onclick="this.closest('dialog').close()">Close</button><button class="btn btn-primary" id="dns-site-apply" type="button" onclick="dnsApplySite()">Apply now</button></div>
  </dialog>
  <dialog id="dns-connection-dialog" aria-labelledby="dns-connection-heading"><form id="dns-connection-form" onsubmit="dnsSaveConnection(event)">
    <div class="dialog-header"><h2 id="dns-connection-heading">Connect DNS</h2></div>
    <input type="hidden" name="id">
    <input type="hidden" name="provider" value="cloudflare">
    <div class="dns-provider-tabs" id="dns-provider-tabs" role="tablist" aria-label="DNS provider">
      <button class="dns-provider-tab" type="button" role="tab" data-provider="cloudflare" aria-selected="true" onclick="dnsSelectProvider('cloudflare')">Cloudflare</button>
      <button class="dns-provider-tab" type="button" role="tab" data-provider="powerdns" aria-selected="false" onclick="dnsSelectProvider('powerdns')">PowerDNS</button>
    </div>
    <div id="dns-provider-cloudflare">
      <ol class="dns-steps">
        <li id="dns-token-step"><strong>Create a token in Cloudflare</strong>
          <div class="cf-scope-picks" role="group" aria-label="Token scopes">
            <label class="cf-scope-pick"><input type="checkbox" id="dns-scope-dns" checked onchange="cfSyncScope('dns', this)"><span>DNS records and zones</span></label>
            <label class="cf-scope-pick"><input type="checkbox" id="dns-scope-redirects" onchange="cfSyncScope('dns', this)"><span>Redirect domains (Single Redirect rules)</span></label>
            <label class="cf-scope-pick"><input type="checkbox" id="dns-scope-gate" onchange="cfSyncScope('dns', this)"><span>Panel gate (Cloudflare Access and origin pulls)</span></label>
          </div>
          <p class="hint">Check these permissions: <span id="dns-token-permissions"></span>. Choose the accounts and zones there; All zones also covers zones you add later.</p>
          <div id="dns-token-ips-hint"><p class="hint">Under Client IP Address Filtering, allow only this server:</p>
            <div class="dns-copy"><code id="dns-token-ips"></code><button class="dns-clip" type="button" title="Copy" aria-label="Copy the addresses" onclick="copyText('dns-token-ips', 'Addresses')">${CLIPBOARD}</button></div></div>
          <a class="btn" id="dns-token-link" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">Create token in Cloudflare ↗</a></li>
        <li><strong>Paste it here</strong>
          <div class="form-grid dns-token-grid">
            ${field("dns-connection-token", "API token", '<input id="dns-connection-token" name="token" type="password" autocomplete="new-password" spellcheck="false">')}
            ${field("dns-connection-label", "Name", '<input id="dns-connection-label" name="label" maxlength="40" autocomplete="off" placeholder="The account names">', "Optional.")}
          </div></li>
      </ol>
    </div>
    <div id="dns-provider-powerdns" hidden>
      <div class="form-grid">
        ${field("dns-pdns-url", "API URL", '<input id="dns-pdns-url" name="url" autocomplete="off" spellcheck="false" placeholder="https://ns1.example.com or http://127.0.0.1:8081">', "HTTPS for public hosts; plain HTTP is allowed for localhost, RFC 1918, Tailscale and IPv6 ULA.")}
        ${field("dns-pdns-key", "API key", '<input id="dns-pdns-key" name="apiKey" type="password" autocomplete="new-password" spellcheck="false">', "The api-key configured on your PowerDNS Authoritative server.")}
        ${field("dns-pdns-label", "Name", '<input id="dns-pdns-label" name="pdnsLabel" maxlength="40" autocomplete="off" placeholder="Primary NS">', "Optional.")}
        ${field("dns-pdns-server", "Server ID", '<input id="dns-pdns-server" name="serverId" maxlength="64" autocomplete="off" placeholder="localhost">', "Usually localhost.")}
        ${field("dns-pdns-ttl", "Default TTL (seconds)", '<input id="dns-pdns-ttl" name="defaultTtl" type="number" min="60" max="86400" inputmode="numeric" value="300">', "Used for profile rows whose TTL is set to Auto.")}
      </div>
      <div class="dns-pdns-create-wrap">
        <label class="dns-switch-row"><span class="switch"><input type="checkbox" id="dns-pdns-create" name="createZones" onchange="dnsSyncPowerDns()"><span></span></span><span><strong>Create missing zones</strong><span class="hint">Creates missing Native zones automatically using the nameservers below.</span></span></label>
        <div class="form-grid" id="dns-pdns-ns-field" hidden>
          ${field("dns-pdns-ns", "Nameservers", '<textarea id="dns-pdns-ns" name="nameservers" rows="2" placeholder="ns1.example.net&#10;ns2.example.net"></textarea>', "One nameserver hostname per line.", true)}
        </div>
      </div>
    </div>
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

import CLIENT_BODY from "./views.client.js" with { type: "text" };
import STYLE from "./views.css" with { type: "text" };
import { esc } from "../../../lib/app-http";
import {
  ATTENTION_RANK, FLEET_FOOTER_HTML, FLEET_SELECTION_HTML, FLEET_ROW_SELECTION_JS, PHONE_CUT,
  fleetFilterHtml, filterWord, phoneMoreHtml, renderLayout, sectionShellHtml, valueFilters, type SectionTab,
} from "../../../lib/app-ui";
import { mountPath } from "../../../lib/mount";
import type { DnsState, SiteView } from "../action";
import type { Profile } from "../model";
import { CLIPBOARD } from "../../../lib/clipboard";
import { CLOUDFLARE_SCOPE_JS } from "../../../lib/cloudflare/connect-dialog";
import { PROVIDER_LABELS } from "../provider";

const BASE = mountPath("dns");
const CLIENT = `${FLEET_ROW_SELECTION_JS}\n${CLOUDFLARE_SCOPE_JS}\nconst DNS_CLIPBOARD = ${JSON.stringify(CLIPBOARD)};\n${CLIENT_BODY}`;
const HTTP_NONE = "DNS-only";
const MAIL_NONE = "None";

export function layout(title: string, content: string, notice?: { current: string; latest: string } | null): string {
  return renderLayout(title, content, { base: BASE, css: STYLE, script: CLIENT, updateNotice: notice });
}

const TYPE_LABELS: Record<string, string> = {
  wordpress: "WordPress", php: "PHP", static: "Static", nodejs: "Node.js", python: "Python", "reverse-proxy": "Reverse proxy", redirect: "Redirect",
};

const HTTP_ROLE_LABELS: Record<SiteView["httpRole"], string> = {
  site: "Site", redirect: "Redirect", "dns-only": "DNS-only",
};

const REDIRECT_STATUS_LABELS: Record<number, string> = {
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

function mailOptionsSummary(profile: Profile, mailcowLinked: boolean): string {
  if (!profile.mailcow) return '<span class="tone-muted">—</span>';
  return mailcowLinked
    ? '<span class="badge tone-ok">Mailcow</span>'
    : '<span class="badge tone-warn">Mailcow unlinked</span>';
}

function httpProfileRow(profile: DnsState["profiles"][number]): string {
  return `<tr data-profile="${esc(profile.id)}" data-role="http">
    <td class="site-cell"><strong>${esc(profile.name)}</strong><span class="dns-card-sites"> · ${plural(profile.sites, "site")}</span></td>
    <td data-label="Records">${recordSummary(profile)}</td>
    <td data-label="Sites" class="numeric dns-sites-cell">${profile.sites}</td>
    <td data-label="Actions" class="action-cell"><div class="actions">
      <button class="btn" type="button" onclick="dnsEditProfile('${esc(profile.id)}', 'http')">Edit</button>
      <button class="btn btn-danger" type="button" onclick="dnsDeleteProfile('${esc(profile.id)}')">Delete</button>
    </div></td>
  </tr>`;
}

function mailProfileRow(profile: DnsState["profiles"][number], mailcowLinked: boolean): string {
  return `<tr data-profile="${esc(profile.id)}" data-role="mail">
    <td class="site-cell"><strong>${esc(profile.name)}</strong><span class="dns-card-sites"> · ${plural(profile.sites, "domain")}</span></td>
    <td data-label="Records">${recordSummary(profile)}</td>
    <td data-label="Options" class="wide-cell">${mailOptionsSummary(profile, mailcowLinked)}</td>
    <td data-label="Domains" class="numeric dns-sites-cell">${profile.sites}</td>
    <td data-label="Actions" class="action-cell"><div class="actions">
      <button class="btn" type="button" onclick="dnsEditProfile('${esc(profile.id)}', 'mail')">Edit</button>
      <button class="btn btn-danger" type="button" onclick="dnsDeleteProfile('${esc(profile.id)}')">Delete</button>
    </div></td>
  </tr>`;
}

/** What one site's DNS amounts to, in a word and a line. */
export function siteStatus(site: SiteView, automatic: boolean, singleConnection = false): { label: string; tone: string; hint: string } {
  const plan = site.plan;
  if (!site.httpProfileId && !site.mailProfileId && !site.redirect) return { label: "—", tone: "muted", hint: "" };
  if (site.mailcowMissing && (!plan || !plan.problems.length)) {
    return { label: "Mailcow unlinked", tone: "warn", hint: "Reconnect Mailcow or change its Mail role" };
  }
  if (!plan) return { label: "Not checked yet", tone: "muted", hint: "" };
  if (site.redirect && !plan.zone && !plan.problems.length) {
    const pending = plan.changes.some((change) => change.action !== "note");
    if (site.redirect.standIn && !pending) return { label: "On this server", tone: "ok", hint: "Served by a stand-in site" };
    return { label: site.redirect.standIn ? "Stand-in to update" : "Stand-in to create", tone: "warn", hint: automatic ? "" : "DNS asks first" };
  }
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

/** Who answers the redirect now, in the words the Details dialog uses at more length. */
function servedBy(site: SiteView, state: DnsState): string {
  if (site.plan?.zone) return site.plan.zone.provider === "powerdns" ? "by a stand-in site" : "by Cloudflare";
  if (site.redirect!.standIn) return "by a stand-in site";
  const hasCf = state.connections.some((connection) => connection.provider === "cloudflare");
  const hasPdns = state.connections.some((connection) => connection.provider === "powerdns");
  return hasCf && !hasPdns ? "by Cloudflare" : "by a stand-in site once Automatic";
}

/**
 * A redirect domain's row. Its HTTP role is Redirect (mutually exclusive with
 * Site and DNS-only), while its Mail role is chosen independently in Edit.
 */
function redirectRow(site: SiteView, state: DnsState): string {
  const redirect = site.redirect!;
  const mailProfile = state.profiles.find((candidate) => candidate.role === "mail" && candidate.id === site.mailProfileId);
  const kept = [redirect.keepPath && "path", redirect.keepQuery && "query"].filter(Boolean);
  const domain = esc(site.domain);
  const target = esc(redirect.target.replace(/^https?:\/\//, ""));
  const mailBadge = site.mailcowMissing ? '<span class="badge tone-warn dns-mailcow-warn">Mailcow unlinked</span>' : "";
  // A phone card heads with "domain → target" and drops the Redirects to cell's own copy.
  return `<tr data-redirect="${domain}">
    <td class="site-cell"><strong>${domain}</strong><span class="dns-card-target"><span aria-hidden="true">→</span><span class="visually-hidden">redirects to</span> ${target}</span></td>
    <td data-label="Redirects to" class="dns-redirect-cell"><span class="dns-redirect-target" title="${esc(redirect.target)}">${target}</span>
      <span class="hint">${redirect.status}${kept.length ? ` · keeps ${kept.join(" and ")}` : ""} · ${servedBy(site, state)}</span></td>
    <td data-label="Mail" class="dns-redirect-profile">${mailProfile ? esc(mailProfile.name) : `<span class="tone-muted">${MAIL_NONE}</span>`}${mailBadge}</td>
    <td data-label="DNS" class="dns-status">${statusCell(site, state.automatic, state.connections.length <= 1)}</td>
    <td class="action-cell"><div class="actions">
      <button class="btn" type="button" onclick="dnsEditRedirect('${domain}')">Edit</button>
      <button class="btn" type="button" onclick="dnsShowSite('${domain}')">Details</button>
    </div></td>
  </tr>`;
}

function siteRow(site: SiteView, state: DnsState, httpProfiles: Profile[], mailProfiles: Profile[]): string {
  const single = state.connections.length <= 1;
  const status = siteStatus(site, state.automatic, single);
  const httpProfile = httpProfiles.find((candidate) => candidate.id === site.httpProfileId);
  const mailProfile = mailProfiles.find((candidate) => candidate.id === site.mailProfileId);
  const managed = Boolean(site.httpProfileId || site.mailProfileId);
  const show = [
    status.tone === "bad" || site.mailcowMissing ? "attention" : status.tone === "warn" ? "pending" : "",
    filterWord("type", typeLabel(site)),
    managed ? "" : "unmanaged",
  ].filter(Boolean).join(" ");
  const sorts = ` data-sort-attention="${ATTENTION_RANK[status.tone as keyof typeof ATTENTION_RANK] ?? ATTENTION_RANK.muted}" data-sort-http="${esc(httpProfile?.name ?? "")}" data-sort-mail="${esc(mailProfile?.name ?? "")}" data-sort-type="${esc(typeLabel(site))}"`;
  const mailWarn = site.mailcowMissing ? '<span class="badge tone-warn dns-mailcow-warn">Mailcow unlinked</span>' : "";
  return `<tr data-domain="${esc(site.domain)}" data-http-profile-id="${esc(site.httpProfileId ?? "")}" data-mail-profile-id="${esc(site.mailProfileId ?? "")}" data-show="${show}"${sorts}${site.plan?.held ? " data-held" : ""} tabindex="0" aria-selected="false" onclick="toggleSiteSelection(event, this)" onkeydown="toggleSiteSelection(event, this)">
    <td class="site-select"><input class="site-checkbox" type="checkbox" onchange="paintFleetSelection()" aria-label="Select ${esc(site.domain)}"></td>
    <td class="site-cell"><strong>${esc(site.domain)}</strong></td>
    <td class="type-cell">${esc(typeLabel(site))}</td>
    <td data-label="HTTP" class="dns-role-cell dns-http-cell"><select class="dns-role-select${site.httpProfileId ? "" : " dns-role-default"}" aria-label="HTTP role for ${esc(site.domain)}" onchange="dnsAssignHttp(this)">${profileOptions(httpProfiles, site.httpProfileId, HTTP_NONE)}</select></td>
    <td data-label="Mail" class="dns-role-cell dns-mail-cell"><select class="dns-role-select${site.mailProfileId ? "" : " dns-role-default"}" aria-label="Mail role for ${esc(site.domain)}" onchange="dnsAssignMail(this)">${profileOptions(mailProfiles, site.mailProfileId, MAIL_NONE)}</select>${mailWarn}</td>
    <td data-label="DNS" class="dns-status">${statusCell(site, state.automatic, single)}</td>
    <td class="action-cell">${managed ? `<button class="btn" type="button" onclick="dnsShowSite('${esc(site.domain)}')">Details</button>` : ""}</td>
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
      <p class="hint">Cloudflare connections are shared with Firewall. A site uses the longest matching zone across connected providers.</p></div>
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

function serverAddressesCard(state: DnsState): string {
  const { server } = state;
  const serverOverridden = Boolean(server.ipv4 || server.ipv6 || (!server.detected.ipv4 && !server.detected.ipv6));
  const serverSummary = [server.ipv4 || server.detected.ipv4, server.ipv6 || server.detected.ipv6].filter(Boolean).join(" · ") || "Not detected";
  return `<div class="card" id="dns-server">
    <details class="disclosure" id="dns-server-disclosure"${serverOverridden ? " open" : ""}>
      <summary><div><span class="summary-title">Server addresses</span><span class="hint">${esc(serverSummary)}</span></div></summary>
      <div class="dns-setting-row dns-disclosure-row"><div class="dns-setting-main">
        ${address(server.ipv4, server.detected.ipv4, "{ipv4}")}<br>${address(server.ipv6, server.detected.ipv6, "{ipv6}")}
      </div><div class="actions"><button class="btn" type="button" onclick="dnsEditServer()">Edit</button></div></div>
    </details>
  </div>`;
}

/**
 * Dedicated Mailcow tab panel. While Mailcow is unlinked, renders only a
 * focused Connect Mailcow card with zero settings forms below it. If sites or
 * redirects still assign Mailcow after removal, surfaces a clear warning inside
 * the card listing the affected domains.
 */
function mailcowPanel(state: DnsState, mailcowDomains: SiteView[]): string {
  const { mailcow } = state;
  if (!mailcow.linked) {
    const affected = mailcow.affectedSites;
    if (affected.length) {
      const listed = affected.slice(0, 6).map((domain) => `<code>${esc(domain)}</code>`).join(", ");
      const extra = affected.length > 6 ? ` and ${affected.length - 6} more` : "";
      const singular = affected.length === 1;
      return `<div class="card dns-mailcow-connect dns-mailcow-warn-card" id="dns-mailcow">
        <div class="dns-mailcow-head"><h2>Connect Mailcow</h2><span class="badge tone-warn">Mailcow unlinked</span></div>
        <div class="notice dns-mailcow-alert" role="alert">
          <strong>${esc(plural(affected.length, "domain"))} still ${singular ? "assigns" : "assign"} Mailcow as ${singular ? "its" : "their"} Mail role:</strong>
          ${listed}${extra}. Sync for ${singular ? "this domain" : "these domains"} is paused until you reconnect Mailcow or switch ${singular ? "its" : "their"} Mail role.
        </div>
        <p class="hint">Reconnect Mailcow to resume adding domains, managing DKIM keys, and granting shared mailbox sender permissions. Existing DNS records and Mailcow domains were left untouched.</p>
        <div class="actions">
          <button class="btn btn-primary" type="button" onclick="dnsEditMailcow()">Reconnect Mailcow</button>
        </div>
      </div>`;
    }
    return `<div class="card dns-mailcow-connect" id="dns-mailcow">
      <h2>Connect Mailcow</h2>
      <p class="hint">Link a Mailcow server to add domains, manage DKIM keys, and grant a shared mailbox sender permission for any domain assigned Mailcow as its Mail role.</p>
      <div class="actions">
        <button class="btn btn-primary" type="button" onclick="dnsEditMailcow()">Connect Mailcow</button>
      </div>
    </div>`;
  }

  const dkim = mailcow.dkimSource
    ? `Shares the DKIM key of ${mailcow.dkimSource}`
    : `Generates a ${mailcow.dkimBits}-bit key with selector ${mailcow.dkimSelector}`;
  const single = state.connections.length <= 1;
  const hasMailcowProfile = state.profiles.some((profile) => profile.role === "mail" && profile.mailcow);
  const rows = mailcowDomains.map((site) => {
    const mailProfile = state.profiles.find((candidate) => candidate.role === "mail" && candidate.id === site.mailProfileId);
    const domain = esc(site.domain);
    return `<tr data-mailcow-domain="${domain}">
      <td class="site-cell"><strong>${domain}</strong></td>
      <td data-label="HTTP role"><span class="badge">${esc(HTTP_ROLE_LABELS[site.httpRole])}</span></td>
      <td data-label="Mail profile">${mailProfile ? esc(mailProfile.name) : "—"}</td>
      <td data-label="DNS" class="dns-status">${statusCell(site, state.automatic, single)}</td>
      <td class="action-cell"><button class="btn" type="button" onclick="dnsShowSite('${domain}')">Details</button></td>
    </tr>`;
  }).join("");

  return `<div class="card" id="dns-mailcow">
      <div class="card-header">
        <div>
          <div class="dns-mailcow-head"><h2>Mailcow</h2><span class="badge tone-ok">Connected</span></div>
          <p class="hint">Provisions mail domains, DKIM keys, and shared mailbox permissions for any domain with a Mailcow Mail role.</p>
        </div>
        <div class="actions">
          <button class="btn" type="button" onclick="dnsEditMailcow()">Edit</button>
          <button class="btn btn-danger" type="button" onclick="dnsRemoveMailcow()">Remove</button>
        </div>
      </div>
      <div class="dns-setting-list">
        <div class="dns-setting-row">
          <div class="dns-setting-main"><strong>Mail host</strong><span class="hint">Used for <span class="mono">{mailcow.host}</span> and API calls.</span></div>
          <div class="dns-setting-control dns-mailcow-value"><strong>${esc(mailcow.host)}</strong><span class="hint">${esc(mailcow.url)}</span></div>
        </div>
        <div class="dns-setting-row">
          <div class="dns-setting-main"><strong>DKIM policy</strong><span class="hint">A domain that already has a key in Mailcow keeps it.</span></div>
          <div class="dns-setting-control dns-mailcow-value">${esc(dkim)}</div>
        </div>
        <div class="dns-setting-row">
          <div class="dns-setting-main"><strong>Shared mailbox</strong><span class="hint">Optional mailbox allowed to send as every Mailcow domain.</span></div>
          <div class="dns-setting-control dns-mailcow-value">${mailcow.sharedMailbox ? esc(mailcow.sharedMailbox) : '<span class="tone-muted">Not configured</span>'}</div>
        </div>
      </div>
    </div>
    <div class="card card-table">
      <div class="card-header">
        <div><h2>Domains using Mailcow</h2>
          <p class="hint">Sites and redirects whose Mail role uses Mailcow.</p></div>
        ${hasMailcowProfile ? "" : '<button class="btn" type="button" onclick="dnsEditProfile(\'\', \'mail\')">New Mail profile</button>'}
      </div>
      ${mailcowDomains.length
        ? `<div class="table-scroll"><table class="fleet-table dns-mailcow-table"><thead><tr>
            <th>Domain</th><th>HTTP role</th><th>Mail profile</th><th>DNS</th><th class="action-cell"></th>
          </tr></thead><tbody>${rows}</tbody></table></div>`
        : '<div class="empty">No domains use Mailcow yet. Choose Mailcow under Mail in Sites or Redirects.</div>'}
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
      : siteStatus({ domain: host.name, type: "panel", httpRole: "site", httpProfileId: "panel-hostname", mailProfileId: null, plan: host.plan, ssl: null }, state.automatic, state.connections.length <= 1);
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
  const httpProfiles = state.profiles.filter((profile) => profile.role === "http");
  const fallback = httpProfiles.find((profile) => profile.id === state.defaultHttpProfileId);
  const step = (done: boolean, title: string, hint: string, control: string): string =>
    `<li class="${done ? "done" : ""}"><div><strong>${title}</strong><span class="hint">${hint}</span></div><div class="dns-step-control">${control}</div></li>`;
  return `<div class="card dns-setup" id="dns-connection"><h2>Set up DNS</h2><ol class="dns-checklist">
    ${step(false, "Connect a DNS provider", "Connect Cloudflare (shared with Firewall) or a PowerDNS Authoritative API v1 server.",
      '<div class="actions dns-setup-actions"><button class="btn btn-primary" type="button" onclick="dnsEditConnection(\'\', \'cloudflare\')">Connect Cloudflare</button><button class="btn" type="button" onclick="dnsEditConnection(\'\', \'powerdns\')">Connect PowerDNS</button></div>')}
    ${step(Boolean(fallback), "Choose the HTTP profile for new sites", "A new site gets its records seconds after CloudPanel creates it. Existing sites are never moved.",
      `<select id="dns-setup-default" aria-label="HTTP profile for new sites" onchange="dnsSetDefault('http', this)">${profileOptions(httpProfiles, state.defaultHttpProfileId, HTTP_NONE)}</select>`)}
    ${step(state.automatic, "Turn on Automatic", "Until then DNS previews changes and writes nothing.",
      state.automatic ? '<span class="tone-ok">On</span>' : state.sites.some((site) => site.redirect) ? "" : '<span class="hint">After connecting</span>')}
  </ol></div>`;
}

/** Shown on the Sites tab while DNS asks first, or before connecting when stand-in redirects exist. */
function modeBar(state: DnsState): string {
  if (state.automatic) return "";
  if (!state.connections.length && !state.sites.some((site) => site.redirect)) return "";
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

/**
 * Redirect domains get a card of their own: their HTTP role is Redirect, while
 * their Mail role is chosen independently in Edit.
 */
function redirectsCard(state: DnsState, redirects: SiteView[]): string {
  const hasCloudflare = state.connections.some((connection) => connection.provider === "cloudflare");
  const tools = `<div class="dns-redirect-tools">${hasCloudflare ? '<button class="btn" type="button" onclick="dnsFindRedirects(this)">Find redirects in Cloudflare</button>' : ""}
    <button class="btn${state.connections.length ? " btn-primary" : ""}" type="button" onclick="dnsEditRedirect('')">Add redirect</button></div>`;
  return `<div class="card card-table"><div class="card-header"><div><h2>Redirects</h2>
      <p class="hint">Domains with HTTP role set to Redirect. Assign a Mail role independently in Edit.</p></div>${tools}</div>
    ${redirects.length ? `<div class="table-scroll"><table class="fleet-table dns-redirect-table"><thead><tr>
        <th>Domain</th><th>Redirects to</th><th>Mail</th><th>DNS</th><th class="action-cell"></th>
      </tr></thead><tbody data-phone-cut="dns-redirects">${redirects.map((site) => redirectRow(site, state)).join("")}</tbody></table></div>
      ${redirects.length > PHONE_CUT ? phoneMoreHtml("dns-redirects", `Show all ${plural(redirects.length, "redirect")}`) : ""}`
      : '<div class="empty">No redirect domains yet.</div>'}
  </div>`;
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
  const plain = state.sites.filter((site) => !site.redirect);
  const redirects = state.sites.filter((site) => site.redirect);
  const httpProfiles = state.profiles.filter((profile) => profile.role === "http");
  const mailProfiles = state.profiles.filter((profile) => profile.role === "mail");
  const mailcowProfileIds = new Set(mailProfiles.filter((profile) => profile.mailcow).map((profile) => profile.id));
  const mailcowDomains = state.sites.filter((site) => site.mailProfileId && mailcowProfileIds.has(site.mailProfileId));
  const hasCloudflare = state.connections.some((connection) => connection.provider === "cloudflare");
  const hasPowerDns = state.connections.some((connection) => connection.provider === "powerdns");
  const waiting = state.waitUntil > now
    ? `<div class="notice">A DNS provider or Mailcow asked this server to wait until ${esc(new Date(state.waitUntil).toISOString().slice(11, 16))} UTC. Checks resume after that.</div>` : "";
  const pageAction = state.connections.length || redirects.length
    ? '<div class="page-actions"><button class="btn" type="button" onclick="dnsCheck(this)">Check now</button></div>'
    : '<div class="page-actions"><button class="btn" type="button" onclick="dnsEditRedirect(\'\')">Add redirect</button></div>';
  const heading = `<script type="application/json" id="dns-state">${data}</script>
    <div class="page-heading"><div><h1>DNS</h1>
      <p>Keep each domain's HTTP and Mail DNS roles in sync.</p></div>${pageAction}</div>`;

  // Before any DNS provider is connected, replace the workspace tables and forms with the focused first-run flow.
  if (!state.connections.length) {
    return `${heading}${waiting}${setupCard(state)}${redirects.length ? `${state.automatic ? syncModeCard(state) : modeBar(state)}${redirectsCard(state, redirects)}` : ""}`;
  }

  const single = state.connections.length <= 1;
  const httpRows = httpProfiles.map((profile) => httpProfileRow(profile)).join("");
  const mailRows = mailProfiles.map((profile) => mailProfileRow(profile, state.mailcow.linked)).join("");
  const sites = plain.map((site) => siteRow(site, state, httpProfiles, mailProfiles)).join("");
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
          <select id="bulk-http" aria-label="HTTP role for selected sites"><option value="" selected>HTTP: keep</option><option value="-">HTTP: ${HTTP_NONE}</option>${httpProfiles
            .map((profile) => `<option value="${esc(profile.id)}">HTTP: ${esc(profile.name)}</option>`).join("")}</select>
          <select id="bulk-mail" aria-label="Mail role for selected sites"><option value="" selected>Mail: keep</option><option value="-">Mail: ${MAIL_NONE}</option>${mailProfiles
            .map((profile) => `<option value="${esc(profile.id)}">Mail: ${esc(profile.name)}</option>`).join("")}</select>
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
        <th data-sort="domain">Site</th><th data-sort="type">Runs</th><th data-sort="http">HTTP</th><th data-sort="mail">Mail</th><th data-sort="attention">DNS</th><th class="action-cell"></th>
      </tr></thead><tbody>${sites}</tbody></table></div>
      ${FLEET_FOOTER_HTML}
      ${checked}`
      : `<div class="card-header"><h2>Sites</h2></div><div class="empty">CloudPanel has no sites yet.</div>${checked}`}
    </div>`;

  const edgeHint = hasCloudflare
    ? state.firewallEnabled
      ? ` Zone-wide Cloudflare SSL/TLS, Always HTTPS, and WAF rules live in <a href="${mountPath("firewall")}/#fw-edge-card">Firewall's Cloudflare edge tab</a>.`
      : " Zone-wide Cloudflare SSL/TLS, Always HTTPS, and WAF rules live in the Firewall addon."
    : "";
  const profilesPanel = `<div class="card card-table"><div class="card-header"><div><h2>HTTP profiles</h2>
      <p class="hint">Web record templates for CloudPanel sites. Redirects and DNS-only sites do not use an HTTP profile.${edgeHint}</p></div>
      <div class="dns-profile-tools">
        <div class="dns-default-field"><label class="hint" for="dns-default-http">New sites HTTP</label>
          <select id="dns-default-http" onchange="dnsSetDefault('http', this)">${profileOptions(httpProfiles, state.defaultHttpProfileId, HTTP_NONE)}</select></div>
        <button class="btn btn-primary" type="button" onclick="dnsEditProfile('', 'http')">New HTTP profile</button></div></div>
      ${httpRows ? `<div class="table-scroll"><table class="fleet-table dns-profile-table"><thead><tr><th>Profile</th><th>Records</th><th class="numeric">Sites</th><th class="action-cell">Actions</th></tr></thead><tbody>${httpRows}</tbody></table></div>`
        : '<div class="empty">No HTTP profiles yet. Create one from the Web preset.</div>'}
    </div>
    <div class="card card-table"><div class="card-header"><div><h2>Mail profiles</h2>
      <p class="hint">Mail and custom record templates you can combine with any Site, Redirect, or DNS-only domain.</p></div>
      <div class="dns-profile-tools">
        <div class="dns-default-field"><label class="hint" for="dns-default-mail">New sites Mail</label>
          <select id="dns-default-mail" onchange="dnsSetDefault('mail', this)">${profileOptions(mailProfiles, state.defaultMailProfileId, MAIL_NONE)}</select></div>
        <button class="btn" type="button" onclick="dnsEditProfile('', 'mail')">New Mail profile</button></div></div>
      ${mailRows ? `<div class="table-scroll"><table class="fleet-table dns-profile-table"><thead><tr><th>Profile</th><th>Records</th><th>Options</th><th class="numeric">Domains</th><th class="action-cell">Actions</th></tr></thead><tbody>${mailRows}</tbody></table></div>`
        : '<div class="empty">No Mail profiles yet. Create one from Google Workspace, DMARC, or your own record templates.</div>'}
    </div>`;

  const settingsPanel = `${connectionsCard(state)}${syncModeCard(state)}${panelHostCard(state)}${serverAddressesCard(state)}`;

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
  const redirectTones = redirects.map((site) => siteStatus(site, state.automatic, single).tone);
  const redirectsAttention: "bad" | "warn" | undefined = redirectTones.includes("bad") ? "bad" : redirectTones.includes("warn") ? "warn" : undefined;
  const mailcowTones = mailcowDomains.map((site) => siteStatus(site, state.automatic, single).tone);
  const mailcowAttention: "bad" | "warn" | undefined = mailcowTones.includes("bad") ? "bad" : mailcowTones.includes("warn") ? "warn" : undefined;
  const mailcowTab: SectionTab = {
    id: "mailcow",
    label: "Mailcow",
    ...(!state.mailcow.linked && state.mailcow.affectedSites.length
      ? { badge: { label: `${state.mailcow.affectedSites.length} affected`, tone: "warn" as const } }
      : state.mailcow.linked
        ? { count: mailcowDomains.length || undefined, attention: mailcowAttention }
        : {}),
    content: mailcowPanel(state, mailcowDomains),
  };

  const tabs: SectionTab[] = [
    { id: "sites", label: "Sites", count: plain.length, attention: sitesAttention, content: sitesPanel },
    { id: "redirects", label: "Redirects", count: redirects.length || undefined, attention: redirectsAttention, content: redirectsCard(state, redirects) },
    { id: "profiles", label: "Profiles", count: state.profiles.length, content: profilesPanel },
    mailcowTab,
    { id: "settings", label: "Settings", attention: connectionAttention(state), content: settingsPanel },
    { id: "activity", label: "Activity", content: logPanel },
  ];

  return `${heading}${sectionShellHtml("dns", "DNS sections", tabs, "sites")}`;
}

const field = (id: string, label: string, control: string, hint = "", full = false): string =>
  `<div class="form-field${full ? " form-field-full" : ""}"><label for="${id}">${label}</label>${control}${hint ? `<div class="hint">${hint}</div>` : ""}</div>`;

const actions = (save: string): string =>
  `<div class="actions dialog-actions"><button class="btn" type="button" onclick="this.closest('dialog').close()">Cancel</button><button class="btn btn-primary" type="submit">${save}</button></div>`;

const switchField = (name: string, label: string, hint: string, wrapId = ""): string =>
  `<label class="dns-switch-row"${wrapId ? ` id="${wrapId}"` : ""}><span class="switch"><input type="checkbox" name="${name}"><span></span></span><span><strong>${label}</strong><span class="hint">${hint}</span></span></label>`;

const PLACEHOLDERS: [string, string, boolean][] = [
  ["{domain}", "the domain", false], ["{zone}", "its DNS zone", false], ["{sub}", "the part before the zone", false],
  ["{ipv4}", "this server's IPv4", false], ["{ipv6}", "this server's IPv6", false],
  ["{mailcow.host}", "the mail hostname", true], ["{mailcow.selector}", "Mailcow's DKIM selector", true], ["{mailcow.dkim}", "Mailcow's DKIM key", true],
];

/** The dialogs sit outside the repainted content, so a repaint never closes one. */
const DIALOGS = `
  <dialog id="dns-profile-dialog" class="dns-wide-dialog" aria-labelledby="dns-profile-heading"><form id="dns-profile-form" onsubmit="dnsSaveProfile(event)">
    <div class="dialog-header"><h2 id="dns-profile-heading">New profile</h2></div>
    <input type="hidden" name="id">
    <input type="hidden" name="role" value="http">
    <div class="form-grid">${field("dns-profile-name", "Name", '<input id="dns-profile-name" name="name" required maxlength="40" autocomplete="off" placeholder="Web">')}</div>
    <div class="dns-section-head"><h3>Records</h3>
      <div class="actions"><label class="dns-check"><input type="checkbox" id="dns-advanced" onchange="dnsRenderRows()"> TTL and apex only</label>
        <select id="dns-preset" aria-label="Add rows from a preset" onchange="dnsAddPreset(this)"></select>
        <button class="btn" type="button" onclick="dnsAddRow()">Add record</button></div></div>
    <div class="dns-rows-wrap"><table class="dns-rows" id="dns-rows-table"><thead><tr><th>Type</th><th>Name</th><th>Content</th><th class="dns-adv">TTL</th><th class="dns-adv">Apex only</th><th class="dns-proxy-col" id="dns-proxy-head">Proxy</th><th><span class="visually-hidden">Remove</span></th></tr></thead>
      <tbody id="dns-rows"></tbody></table></div>
    <p class="hint dns-empty-rows" id="dns-empty-rows" hidden>No records yet. Add one, or start from a preset.</p>
    <p class="hint dns-mixed-note" id="dns-mixed-note" hidden>Proxy applies to Cloudflare zones only. PowerDNS zones use unproxied records and their connection's default TTL when a row is set to Auto.</p>
    <div class="dns-placeholders"><span class="hint">Placeholders, inserted where the cursor is:</span>
      ${PLACEHOLDERS.map(([token, meaning, mailcowOnly]) => `<button class="dns-chip" type="button"${mailcowOnly ? " data-mailcow-chip" : ""} title="${esc(meaning)}" onmousedown="event.preventDefault()" onclick="dnsInsert('${token}')">${token}</button>`).join("")}</div>
    <div id="dns-mailcow-section" hidden><h3 class="dns-section">Mailcow</h3>
    ${switchField("mailcow", "Set up each domain in Mailcow", "Adds the domain if it is missing, gives it a DKIM key, and lets the shared mailbox send as it. A Mailcow domain is never deleted.")}</div>
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
      ${field("dns-redirect-mail", "Mail role", '<select id="dns-redirect-mail" name="mailProfileId"></select>', "Optional. Keeps mail records (and Mailcow setup) alongside the redirect.")}
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
    <div class="form-grid">${field("dns-found-mail", "Mail role", '<select id="dns-found-mail" name="mailProfileId"></select>', "Optional. Applies mail records alongside the taken-over redirects.")}</div>
    <div class="actions dialog-actions"><button class="btn" type="button" onclick="this.closest('dialog').close()">Cancel</button><button class="btn btn-primary" id="dns-found-submit" type="submit">Take over selected</button></div>
  </form></dialog>
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
            <label class="cf-scope-pick"><input type="checkbox" id="dns-scope-dns" data-cf-scope="dns" checked onchange="cfSyncScope('dns', this)"><span>DNS records and zones</span></label>
            <label class="cf-scope-pick"><input type="checkbox" id="dns-scope-edge" data-cf-scope="edge" onchange="cfSyncScope('dns', this)"><span>Cloudflare edge defaults (SSL/TLS, HTTPS, rules)</span></label>
            <label class="cf-scope-pick"><input type="checkbox" id="dns-scope-gate" data-cf-scope="panelGate" onchange="cfSyncScope('dns', this)"><span>Panel gate (Cloudflare Access and origin pulls)</span></label>
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
    <div class="dialog-header"><h2 id="dns-mailcow-heading">Connect Mailcow</h2></div>
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
    ${actions("Connect")}
  </form></dialog>
  <dialog id="dns-server-dialog" aria-labelledby="dns-server-heading"><form id="dns-server-form" onsubmit="dnsSaveServer(event)">
    <div class="dialog-header"><h2 id="dns-server-heading">Server addresses</h2></div>
    <div class="form-grid">
      ${field("dns-server-ipv4", "IPv4", '<input id="dns-server-ipv4" name="ipv4" autocomplete="off">', "Leave empty to use the detected address.")}
      ${field("dns-server-ipv6", "IPv6", '<input id="dns-server-ipv6" name="ipv6" autocomplete="off">', "Leave empty to use the detected address. Without one, AAAA rows are left out and stale AAAA records removed.")}
    </div>
    ${actions("Save")}
  </form></dialog>`;

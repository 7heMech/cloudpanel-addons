import CLIENT_BODY from "./views.client.js" with { type: "text" };
import CSS from "./views.css" with { type: "text" };
import { esc } from "../../../lib/app-http";
import { FLEET_ROW_SELECTION_JS, fleetRowSelectionStyle, renderLayout } from "../../../lib/app-ui";
import { mountPath } from "../../../lib/mount";
import type { DnsState, SiteView } from "../action";
import type { Profile } from "../model";
import { SSL_LABELS } from "../zone";

const BASE = mountPath("dns");
const STYLE = CSS.split("/* fleet-row-selection */").join(fleetRowSelectionStyle("dns-site-table"));
const CLIENT = `${FLEET_ROW_SELECTION_JS}\n${CLIENT_BODY}`;
const NO_PROFILE = "Not managed";

export function layout(title: string, content: string, notice?: { current: string; latest: string } | null): string {
  return renderLayout(title, content, { brand: "DNS", base: BASE, nav: [], css: STYLE, script: CLIENT, updateNotice: notice });
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

function zoneSummary(profile: Profile): string {
  const parts: string[] = [];
  if (profile.zone.ssl) parts.push(SSL_LABELS[profile.zone.ssl]);
  if (profile.zone.alwaysHttps !== null) parts.push(`Always HTTPS ${profile.zone.alwaysHttps ? "on" : "off"}`);
  const rules = [profile.zone.acmeFullSsl && "Let's Encrypt", profile.zone.webmailFullSsl && "webmail", profile.zone.skipFirewallIps.length && "firewall skip"].filter(Boolean);
  const extras = [profile.mailcow && "Mailcow", profile.zone.createIn && "creates zones"].filter(Boolean);
  return `${esc(parts.join(" · ") || "Zone settings unchanged")}${rules.length || extras.length ? `<span class="hint">${esc([rules.length ? `Rules: ${rules.join(", ")}` : "", ...extras].filter(Boolean).join(" · "))}</span>` : ""}`;
}

function profileRow(profile: DnsState["profiles"][number], isDefault: boolean): string {
  const enforcing = profile.mode === "enforce";
  return `<tr data-profile="${esc(profile.id)}">
    <td class="site-cell"><strong>${esc(profile.name)}</strong><span class="dns-card-sites"> · ${plural(profile.sites, "site")}</span>${isDefault ? '<span class="badge state-default">Default for new sites</span>' : ""}</td>
    <td data-label="Records">${recordSummary(profile)}</td>
    <td data-label="Zone" class="wide-cell">${zoneSummary(profile)}</td>
    <td data-label="Enforce" class="dns-enforce-cell">
      <label class="switch-field"><span class="switch"><input type="checkbox" aria-label="Enforce ${esc(profile.name)}"${enforcing ? " checked" : ""} onchange="dnsSetMode(this, '${esc(profile.id)}')"><span></span></span><span class="switch-state">${enforcing ? "On" : "Report only"}</span></label>
    </td>
    <td data-label="Sites" class="numeric dns-sites-cell">${profile.sites}</td>
    <td data-label="Actions" class="action-cell"><div class="actions">
      <button class="btn" type="button" onclick="dnsEditProfile('${esc(profile.id)}')">Edit</button>
      <button class="btn btn-danger" type="button" onclick="dnsDeleteProfile('${esc(profile.id)}')">Delete</button>
    </div></td>
  </tr>`;
}

/** What one site's DNS amounts to, in a word and a line. */
export function siteStatus(site: SiteView, mode: "report" | "enforce" | null): { label: string; tone: string; hint: string } {
  const plan = site.plan;
  if (!site.profileId) return { label: "—", tone: "muted", hint: "" };
  if (!plan) return { label: "Not checked yet", tone: "muted", hint: "" };
  const zone = plan.zone ? `${plan.zone.name} · ${plan.zone.connection}` : "";
  if (plan.problems.length) return { label: "Needs attention", tone: "bad", hint: plan.problems[0]! };
  const pending = plan.changes.filter((change) => change.action !== "note").length;
  if (plan.zone && plan.zone.status !== "active") return { label: `Zone ${plan.zone.status}`, tone: "warn", hint: "Set its nameservers at the registrar" };
  if (!plan.zone && pending) return { label: "Zone to create", tone: "warn", hint: "" };
  if (pending) return { label: mode === "enforce" ? `${plural(pending, "change")} to make` : plural(pending, "difference"), tone: "warn", hint: zone };
  return { label: "In sync", tone: "ok", hint: zone };
}

function siteRow(site: SiteView, state: DnsState): string {
  const profile = state.profiles.find((candidate) => candidate.id === site.profileId);
  const status = siteStatus(site, profile?.mode ?? null);
  return `<tr data-domain="${esc(site.domain)}" data-profile-id="${esc(site.profileId ?? "")}" tabindex="0" aria-selected="false" onclick="toggleSiteSelection(event, this, dnsPaintSelection)" onkeydown="toggleSiteSelection(event, this, dnsPaintSelection)">
    <td class="site-select"><input class="site-checkbox" type="checkbox" onchange="dnsPaintSelection()" aria-label="Select ${esc(site.domain)}"></td>
    <td class="site-cell"><strong>${esc(site.domain)}</strong></td>
    <td class="type-cell">${esc(TYPE_LABELS[site.type] ?? site.type)}</td>
    <td data-label="Profile" class="dns-profile-cell"><select aria-label="Profile for ${esc(site.domain)}" onchange="dnsAssignRow(this)">${profileOptions(state.profiles, site.profileId, NO_PROFILE)}</select></td>
    <td data-label="DNS" class="dns-status"><span class="tone-${status.tone}">${esc(status.label)}</span>${status.hint ? `<span class="hint">${esc(status.hint)}</span>` : ""}${site.ssl ? `<span class="hint">${esc(site.ssl.startsWith("Waiting for DNS") ? "Certificate requested; waits for DNS" : `Certificate: ${site.ssl}`)}</span>` : ""}</td>
    <td class="action-cell">${site.profileId ? `<button class="btn" type="button" onclick="dnsShowSite('${esc(site.domain)}')">Details</button>` : ""}</td>
  </tr>`;
}

function connectionRow(connection: DnsState["connections"][number]): string {
  const accounts = connection.accounts.map((account) => account.name || account.id).join(", ");
  const status = connection.active ? '<span class="tone-ok">Active</span>' : `<span class="tone-bad">${esc(connection.status === "unchecked" ? "Not checked" : "Not working")}</span>`;
  return `<tr data-connection="${esc(connection.id)}">
    <td class="site-cell"><strong>${esc(connection.label)}</strong></td>
    <td data-label="Accounts" class="wide-cell">${esc(accounts || "—")}</td>
    <td data-label="Zones" class="numeric">${connection.zones}</td>
    <td data-label="Status">${status}${connection.error ? `<span class="hint">${esc(connection.error)}</span>` : ""}</td>
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

function settingsCard(state: DnsState): string {
  const { mailcow, server } = state;
  const dkim = mailcow.dkimSource ? `shares the DKIM key of ${mailcow.dkimSource}` : `${mailcow.dkimBits}-bit DKIM, selector ${mailcow.dkimSelector}`;
  const mailcowValue = mailcow.url
    ? `<span class="mono">{mailcow.host}</span> ${esc(mailcow.host)}<span class="hint">${esc([dkim, mailcow.sharedMailbox && `${mailcow.sharedMailbox} may send as each domain`].filter(Boolean).join(" · "))}</span>`
    : '<span class="hint">Not set up. Profiles that use Mailcow need it.</span>';
  return `<div class="card card-table"><div class="card-header"><div><h2>Server and Mailcow</h2>
      <p class="hint">What the placeholders in record rows stand for.</p></div></div>
    <table class="fleet-table dns-settings-table"><tbody>
      <tr><td class="site-cell"><strong>Server addresses</strong></td>
        <td class="wide-cell">${address(server.ipv4, server.detected.ipv4, "{ipv4}")}<br>${address(server.ipv6, server.detected.ipv6, "{ipv6}")}</td>
        <td data-label="Actions" class="action-cell"><button class="btn" type="button" onclick="dnsEditServer()">Edit</button></td></tr>
      <tr><td class="site-cell"><strong>Mailcow</strong>${mailcow.url ? `<span class="hint">${esc(new URL(mailcow.url).host)}</span>` : ""}</td>
        <td class="wide-cell">${mailcowValue}</td>
        <td data-label="Actions" class="action-cell"><button class="btn" type="button" onclick="dnsEditMailcow()">${mailcow.url ? "Edit" : "Set up"}</button></td></tr>
    </tbody></table></div>`;
}

export function dashboardView(state: DnsState): string {
  return `<div id="dns-root">${dashboardContent(state)}</div>${DIALOGS}`;
}

/** Everything a change can alter, repainted in place from the action's reply. */
export function dashboardContent(state: DnsState, now = Date.now()): string {
  const data = JSON.stringify(state).replaceAll("<", "\\u003c");
  const profiles = state.profiles.map((profile) => profileRow(profile, profile.id === state.defaultProfileId)).join("");
  const sites = state.sites.map((site) => siteRow(site, state)).join("");
  const connections = state.connections.map(connectionRow).join("");
  const waiting = state.waitUntil > now
    ? `<div class="notice">Cloudflare or Mailcow asked this server to wait until ${esc(new Date(state.waitUntil).toISOString().slice(11, 16))} UTC. Checks resume after that.</div>` : "";
  const connect = state.connections.length ? "" : `<div class="card dns-setup">
      <div><h2>Connect Cloudflare</h2><p>DNS needs a Cloudflare API token. Cloudflare's own form opens with the permissions the profiles need; you choose the accounts and zones there and paste the token back.</p></div>
      <button class="btn btn-primary" type="button" onclick="dnsEditConnection('')">Connect Cloudflare</button></div>`;
  const orphans = state.orphans.length ? `<div class="card card-table"><div class="card-header"><div><h2>Records of deleted sites</h2>
      <p class="hint">These sites are gone from CloudPanel. Their records are still in Cloudflare until you remove them.</p></div></div>
      <table class="fleet-table dns-orphan-table"><tbody>${state.orphans.map((orphan) => `<tr>
        <td class="site-cell"><strong>${esc(orphan.domain)}</strong><span class="hint">${esc(plural(orphan.records, "record"))} in ${esc(orphan.zone)}</span></td>
        <td data-label="Actions" class="action-cell"><div class="actions">
          <button class="btn" type="button" onclick="dnsForget('${esc(orphan.domain)}')">Keep</button>
          <button class="btn btn-danger" type="button" onclick="dnsRemoveRecords('${esc(orphan.domain)}')">Remove records</button>
        </div></td></tr>`).join("")}</tbody></table></div>` : "";

  return `<script type="application/json" id="dns-state">${data}</script>
    <div class="page-heading"><div><h1>DNS</h1>
      <p>Keep each site's Cloudflare DNS to its profile's records. Report only shows what differs; Enforce makes it so and keeps it so.</p></div>
      <button class="btn btn-primary" type="button" onclick="dnsEditProfile('')">New profile</button></div>
    ${waiting}${connect}
    <div class="card default-card">
      <div><h2>New sites</h2><p>A site created from now on joins this profile, before its certificate is requested.</p>
        <p class="hint">Existing sites are never moved by this. Its records are written seconds after CloudPanel creates the site.</p></div>
      <div class="default-choice"><label class="hint" for="dns-default">Profile for new sites</label>
        <select id="dns-default" onchange="dnsSetDefault(this)">${profileOptions(state.profiles, state.defaultProfileId, "None")}</select></div>
    </div>
    <div class="card card-table"><div class="card-header"><div><h2>Profiles</h2>
      <p class="hint">A profile is the records each of its sites should have. Enforce deletes records that conflict with them, at the names the profile writes and nowhere else.</p></div></div>
      ${profiles ? `<table class="fleet-table dns-profile-table"><thead><tr><th>Profile</th><th>Records</th><th>Zone</th><th>Enforce</th><th class="numeric">Sites</th><th class="action-cell">Actions</th></tr></thead><tbody>${profiles}</tbody></table>`
        : '<div class="empty">No profiles yet. Create one from the Web and Mailcow presets.</div>'}
    </div>
    <div class="card card-table">
    ${state.sites.length ? `<div class="card-header toolbar">
        <h2>Sites</h2>
        <span class="toolbar-note" id="site-selection">No sites selected</span>
        <button class="btn mobile-select-all" id="select-all-btn" type="button" onclick="toggleAllSites(dnsPaintSelection)">Select all</button>
        <select class="toolbar-end" id="bulk-profile" aria-label="Profile for the selected sites"><option value="" selected disabled>Choose a profile</option>${state.profiles
          .map((profile) => `<option value="${esc(profile.id)}">${esc(profile.name)}</option>`).join("")}<option value="-">${NO_PROFILE}</option></select>
        <button class="btn" id="assign-selected" type="button" disabled onclick="dnsAssignSelected()">Assign selected</button>
      </div>
      <table class="fleet-table dns-site-table"><thead><tr>
        <th class="site-select"><input id="select-all" type="checkbox" onchange="selectAllSites(this.checked, dnsPaintSelection)" aria-label="Select all sites"></th>
        <th>Site</th><th>Runs</th><th>Profile</th><th>DNS</th><th class="action-cell"></th>
      </tr></thead><tbody>${sites}</tbody></table>
      <div class="card-footer"><span class="hint">${esc(ago(state.checkedAt, now))}. Drift is checked every 15 minutes.</span>
        <button class="btn" type="button" onclick="dnsCheck(this)"${state.connections.length ? "" : " disabled"}>Check now</button></div>`
      : '<div class="empty">CloudPanel has no sites yet.</div>'}
    </div>
    ${orphans}
    <div class="card card-table"><div class="card-header"><div><h2>Cloudflare</h2>
      <p class="hint">Each connection is one API token. A site is managed in the longest zone any connection reaches.</p></div>
      <button class="btn" type="button" onclick="dnsEditConnection('')">Add connection</button></div>
      ${connections ? `<table class="fleet-table dns-connection-table"><thead><tr><th>Connection</th><th>Accounts</th><th class="numeric">Zones</th><th>Status</th><th class="action-cell">Actions</th></tr></thead><tbody>${connections}</tbody></table>`
        : '<div class="empty">No connections yet.</div>'}
    </div>
    ${settingsCard(state)}`;
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
      <div class="actions"><select id="dns-preset" aria-label="Add rows from a preset" onchange="dnsAddPreset(this)"></select>
        <button class="btn" type="button" onclick="dnsAddRow()">Add record</button></div></div>
    <div class="dns-rows-wrap"><table class="dns-rows"><thead><tr><th>Type</th><th>Name</th><th>Content</th><th>Priority</th><th>TTL</th><th>Proxy</th><th>Apex only</th><th><span class="visually-hidden">Remove</span></th></tr></thead>
      <tbody id="dns-rows"></tbody></table></div>
    <p class="hint dns-empty-rows" id="dns-empty-rows" hidden>No records yet. Add one, or start from a preset.</p>
    <div class="dns-placeholders"><span class="hint">Placeholders, inserted where the cursor is:</span>
      ${PLACEHOLDERS.map(([token, meaning]) => `<button class="dns-chip" type="button" title="${esc(meaning)}" onmousedown="event.preventDefault()" onclick="dnsInsert('${token}')">${token}</button>`).join("")}</div>
    <h3 class="dns-section">Mailcow</h3>
    ${switchField("mailcow", "Set up each site's domain in Mailcow", "Adds the domain if it is missing, gives it a DKIM key, and lets the shared mailbox send as it. A Mailcow domain is never deleted.")}
    <h3 class="dns-section">Cloudflare zone <span class="hint inline">applies to the whole zone</span></h3>
    <div class="form-grid">
      ${field("dns-ssl", "SSL/TLS mode", `<select id="dns-ssl" name="ssl"><option value="">Leave as it is</option>${Object.entries(SSL_LABELS).map(([value, label]) => `<option value="${value}">${label}</option>`).join("")}</select>`)}
      ${field("dns-https", "Always Use HTTPS", '<select id="dns-https" name="alwaysHttps"><option value="">Leave as it is</option><option value="on">On</option><option value="off">Off</option></select>')}
    </div>
    ${switchField("acmeFullSsl", "Full SSL for Let's Encrypt checks", "Lets a proxied site get its first certificate while Full (strict) is on, and with Cloudflare-only access.")}
    ${switchField("webmailFullSsl", "Full SSL for webmail hosts", "For proxied webmail records, whose origin is the mail server.")}
    <div class="form-grid dns-zone-grid">
      ${field("dns-skip", "Skip the firewall for", '<textarea id="dns-skip" name="skipFirewallIps" rows="2" placeholder="203.0.113.7"></textarea>', "Optional. One IP per line, such as a MainWP Dashboard's. Skips Super Bot Fight Mode and managed rules; Cloudflare cannot skip the free Bot Fight Mode.")}
      ${field("dns-create-in", "Missing zones", '<select id="dns-create-in" name="createIn"></select>', "Creating a zone shows its nameservers; changing them at the registrar is up to you.")}
    </div>
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
    <div class="dialog-header"><h2 id="dns-connection-heading">Connect Cloudflare</h2></div>
    <input type="hidden" name="id">
    <ol class="dns-steps">
      <li id="dns-token-step"><strong>Create a token in Cloudflare</strong>
        <p class="hint">Check these permissions: <span id="dns-token-permissions"></span>. Choose the accounts and zones there; All zones also covers zones you add later.</p>
        <p class="hint" id="dns-token-ips-hint">Under Client IP Address Filtering, allow only this server: <code id="dns-token-ips"></code>.</p>
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
      ${field("dns-mailcow-url", "Address", '<input id="dns-mailcow-url" name="url" type="url" required placeholder="https://mail.example.com" autocomplete="off">')}
      ${field("dns-mailcow-key", "API key", '<input id="dns-mailcow-key" name="key" type="password" autocomplete="new-password" spellcheck="false">', "A read-write key. Limit it to this server's IP in Mailcow.")}
      ${field("dns-mailcow-host", "Mail hostname", '<input id="dns-mailcow-host" name="host" autocomplete="off" placeholder="mail.example.com">', "What <code>{mailcow.host}</code> is: the MX and autodiscover target.")}
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

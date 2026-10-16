import BODY from "./views.client.js" with { type: "text" };
import STYLE from "./views.css" with { type: "text" };
import { esc } from "../../../lib/app-http";
import { FLEET_ROW_SELECTION_JS, fleetRowSelectionStyle, renderLayout } from "../../../lib/app-ui";
import { PRESET_PROFILE, type Change, type DnsRecord, type Profile, type Review, type SitePlan, type State } from "../model";

export const CLIENT_JS = `${FLEET_ROW_SELECTION_JS}\n${BODY}`;
export const layout = (title: string, content: string, updateNotice?: { current: string; latest: string } | null): string => renderLayout(title, content, {
  brand: "DNS & Mail", base: "/addons/domains", nav: [], css: `${STYLE}${fleetRowSelectionStyle("domains-sites")}`, script: CLIENT_JS, updateNotice,
});
function options(profiles: Profile[], selected: string | null): string {
  return `<option value="">No profile</option>${profiles.map((p) => `<option value="${esc(p.id)}"${selected === p.id ? " selected" : ""}>${esc(p.name)}</option>`).join("")}`;
}
function recordValue(r: DnsRecord): string {
  return `${r.type} ${r.name} → ${r.type === "SRV" ? JSON.stringify(r.data) : r.content}${r.priority !== undefined ? ` (priority ${r.priority})` : ""}${["A", "AAAA", "CNAME"].includes(r.type) ? r.proxied ? " · Proxied" : " · DNS only" : ""}`;
}
function changeHtml(c: Change): string {
  return `<li class="change change-${c.action}"><span class="badge">${esc(c.action)}</span><div><strong>${esc(c.name)}</strong><div>${esc(c.detail)}${c.conflict ? ' <span class="conflict-label">Conflict / drift</span>' : ""}</div>${c.before ? `<div class="record before">${esc(recordValue(c.before))}</div>` : ""}${c.after ? `<div class="record">${esc(recordValue(c.after))}</div>` : ""}</div></li>`;
}
function planHtml(site: SitePlan, expand = false, compact = false): string {
  return `<details class="site-plan"${expand && (site.changes.length || site.errors.length) ? " open" : ""}><summary aria-label="View plan for ${esc(site.domain)}">${compact ? "View plan" : `${esc(site.domain)} <span class="hint">${site.changes.length} pending · ${site.mode === "enforce" ? "Enforce" : "Report only"}</span>`}</summary>
    ${site.errors.map((e) => `<p class="error-text">${esc(e)}</p>`).join("")}
    ${site.zone ? `<p class="hint">${esc(site.zone.name)} · ${esc(site.zone.status)}${site.zone.nameServers.length ? ` · Nameservers: ${esc(site.zone.nameServers.join(", "))}` : ""}</p>` : ""}
    ${site.changes.length ? `<ul class="changes">${site.changes.map(changeHtml).join("")}</ul>` : '<p class="hint">No pending changes.</p>'}</details>`;
}
export function reviewContent(review: Review): string {
  return `<h3>${esc(review.title)}</h3><p>Confirm the changes below. Enforce keeps correcting drift at these managed names. Unrelated names stay editable in Cloudflare.</p>
    ${review.removal ? `<p>Only these tracked DNS records will be removed. Mailcow and the zone stay in place.</p><ul class="changes">${review.removal.records.map((r) => changeHtml({ action: "delete", service: "dns", name: r.name, detail: "Remove orphan record", before: r })).join("")}</ul>` : review.sites.filter((s) => s.profileId).map((s) => planHtml(s, true)).join("") || '<p>This profile has no sites yet. New sites assigned to it will use this policy automatically.</p>'}`;
}
function profileCard(p: Profile, state: State): string {
  const count = state.sites.filter((s) => s.profileId === p.id).length;
  return `<article class="card policy-card" data-profile="${esc(JSON.stringify(p))}"><div class="policy-title"><h3>${esc(p.name)}</h3><span class="badge ${p.mode === "enforce" ? "ok-text" : ""}">${p.mode === "enforce" ? "Enforce" : "Report only"}</span></div>
    <p class="hint">${count} ${count === 1 ? "site" : "sites"}${state.defaultProfileId === p.id ? " · Default for new sites" : ""}</p>
    <p>${p.webProxied ? p.proxyAfterCertificate ? "Proxy after certificate" : "Proxied from creation" : "Web DNS only"}${p.mailEnabled ? " · Mailcow" : " · Web only"}</p>
    <p class="hint">${p.zoneSettings ? "Strict SSL · Always use HTTPS" : "Zone settings unchanged"}${p.acmeRule ? " · ACME Full SSL rule" : ""}${p.webmailRule ? " · Webmail Full SSL rule" : ""}${p.mainwpIps.length ? " · MainWP firewall skip" : ""}</p>
    <div class="actions"><button class="btn" type="button" onclick="editProfile(this)">Edit</button><button class="btn${p.mode === "report" ? " btn-primary" : ""}" type="button" onclick="setProfileMode(this)">${p.mode === "report" ? "Review Enforce" : "Report only"}</button><button class="btn" type="button" onclick="deleteProfile(this)">Delete</button></div></article>`;
}
function siteRow(s: SitePlan, profiles: Profile[]): string {
  let status = !s.profileId ? "No profile" : s.errors.length ? "Needs attention" : s.zone?.status !== "active" ? "Zone pending" : s.changes.length ? `${s.changes.length} pending` : "In sync";
  return `<tr data-domain="${esc(s.domain)}" tabindex="0" aria-selected="false" onclick="toggleSiteSelection(event,this,paintSelection)" onkeydown="toggleSiteSelection(event,this,paintSelection)">
    <td class="site-select"><input class="site-checkbox" type="checkbox" aria-label="Select ${esc(s.domain)}" onchange="paintSelection()"></td>
    <td class="site-cell"><strong>${esc(s.domain)}</strong><div class="hint">${esc(s.type)}${s.certificateReady ? " · Certificate valid" : ""}</div></td>
    <td data-label="Profile"><select aria-label="Profile for ${esc(s.domain)}" onchange="assignSite(this)">${options(profiles, s.profileId)}</select></td>
    <td data-label="DNS & mail"><span class="${s.errors.length ? "error-text" : s.changes.length ? "warn-text" : ""}">${esc(status)}</span>
      ${s.zone ? `<div class="hint">${esc(s.zone.name)} · ${esc(s.zone.status)}</div>` : ""}
      ${s.profileId ? planHtml(s, false, true) : ""}${s.unproxiedWeb && s.cloudflareOnly ? '<p class="warn-text">DNS only + Cloudflare-only access blocks visitors and HTTP-01. Enable the proxy or change origin access.</p>' : ""}
      ${s.ssl ? `<p class="hint">SSL: ${esc(s.ssl.state)} · ${s.ssl.attempts}/5 retries${s.ssl.nextAttemptAt ? ` · Next eligible ${esc(new Date(s.ssl.nextAttemptAt).toISOString())}` : ""}</p>` : ""}</td>
    <td class="action-cell"><div class="actions"><button class="btn" type="button" onclick="provisionSite(this)">Provision now</button>${s.ssl && !s.certificateReady ? '<button class="btn" type="button" onclick="retrySsl(this)">Retry SSL</button>' : ""}</div></td></tr>`;
}
export function dashboardContent(state: State): string {
  const assigned = state.sites.filter((s) => s.profileId).length;
  return `<div class="page-heading"><div><h1>DNS &amp; mail</h1><p>CloudPanel's sites drive Cloudflare DNS and Mailcow. Profiles decide which records stay correct.</p><p class="hint">${state.scannedAt ? `Last scan ${esc(state.scannedAt)}` : "Save connections, assign profiles, then scan the plan before enabling Enforce."}</p></div><div class="actions"><button class="btn" type="button" onclick="openConnections()">Connections</button><button class="btn btn-primary" type="button" onclick="scanNow()">Scan now</button></div></div>
    <div id="domains-data" data-connections="${esc(JSON.stringify(state.connections))}" data-preset="${esc(JSON.stringify(PRESET_PROFILE))}"></div>
    ${!state.connections.hasCloudflareToken ? '<div class="notice">Start with Connections. Saving credentials puts profiles in Report only; review their plans before enabling Enforce.</div>' : ""}
    ${state.retryAt > Date.now() ? `<div class="notice">A provider requested a pause until ${esc(new Date(state.retryAt).toISOString())}. Reconciliation resumes after that time.</div>` : ""}
    ${state.errors.map((e) => `<div class="alert">${esc(e)}</div>`).join("")}
    <div class="card stats"><div class="stat"><div class="label">Sites</div><div class="value">${state.sites.length}</div></div><div class="stat"><div class="label">Assigned</div><div class="value">${assigned}</div></div><div class="stat"><div class="label">Orphaned</div><div class="value">${state.orphans.length}</div></div><div class="stat"><div class="label">Detected server</div><div class="ip-value">${esc(state.detectedIps.ipv4 || "No unique public IPv4")}<br>${esc(state.detectedIps.ipv6 || "No unique public IPv6")}</div></div></div>
    <div class="card default-card"><div><h2>New sites</h2><p>Provision the default profile as a site is created, before automatic SSL.</p><p class="hint">Existing sites keep their assignments. Drift is checked every fifteen minutes.</p></div><div class="default-choice"><label for="default-profile">Default for new sites</label><select id="default-profile" onchange="changeDefault(this)">${options(state.profiles, state.defaultProfileId)}</select></div></div>
    <div class="policy-heading"><h2>Profiles</h2><button class="btn" type="button" onclick="editProfile()">New profile</button></div><div class="policy-grid">${state.profiles.map((p) => profileCard(p, state)).join("") || '<p class="hint">Create a profile to get started.</p>'}</div>
    <div class="card card-table"><div class="card-header toolbar"><h2>Sites</h2><span id="site-selection" class="toolbar-note">No sites selected</span><button class="btn mobile-select-all" type="button" onclick="toggleAllSites(paintSelection)">Select all</button><select id="bulk-profile" class="toolbar-end" aria-label="Profile for selected sites"><option value="choose" disabled selected>Choose a profile</option>${options(state.profiles, null)}</select><button class="btn" id="assign-selected" type="button" disabled onclick="assignSelected()">Assign selected</button></div>
    ${state.sites.length ? `<table class="fleet-table domains-sites"><thead><tr><th class="site-select"><input id="select-all" type="checkbox" aria-label="Select all sites" onchange="selectAllSites(this.checked,paintSelection)"></th><th>Site</th><th>Profile</th><th>DNS &amp; mail</th><th class="action-cell">Actions</th></tr></thead><tbody>${state.sites.map((s) => siteRow(s, state.profiles)).join("")}</tbody></table>` : '<div class="empty">No CloudPanel sites yet. New sites can join the default profile automatically.</div>'}</div>
    ${state.orphans.length ? `<div class="card"><h2>Orphaned records</h2><p>These sites left CloudPanel. Their DNS and Mailcow were kept.</p>${state.orphans.map((o) => `<div class="orphan" data-orphan="${esc(JSON.stringify({ domain: o.domain, zoneId: o.zoneId }))}"><div><strong>${esc(o.domain)}</strong><p class="hint">${o.records.length} tracked records in ${esc(o.zoneName)}</p></div><button class="btn btn-danger" type="button" onclick="removeOrphan(this)">Remove records</button></div>`).join("")}</div>` : ""}`;
}
function input(key: string, label: string, hint = "", type = "text"): string {
  return `<div class="form-field"><label for="profile-${key}">${esc(label)}</label><input id="profile-${key}" data-profile-field="${key}" type="${type}" autocomplete="off">${hint ? `<div class="hint">${hint}</div>` : ""}</div>`;
}
function toggle(key: string, label: string): string {
  return `<label class="check-field"><input type="checkbox" data-profile-field="${key}"> ${esc(label)}</label>`;
}
export function dashboardView(state: State): string {
  return `<div id="domains-content">${dashboardContent(state)}</div>
  <dialog id="connections-dialog" aria-labelledby="connections-title"><div class="dialog-header"><h2 id="connections-title">Connections</h2></div><p class="hint">Keys stay on the root side and are never sent back here. Leave a saved key blank to keep it for the same endpoint. Saving returns profiles to Report only.</p><form id="connections-form" onsubmit="saveConnections(event)"><div class="form-grid">
    <div class="form-field"><label for="cf-account">Cloudflare account ID</label><input id="cf-account" name="accountId" autocomplete="off" required></div><div class="form-field"><label for="cf-token">Cloudflare API token</label><input id="cf-token" name="cloudflareToken" type="password" autocomplete="new-password"></div>
    <div class="form-field"><label for="mailcow-url">Mailcow HTTPS origin</label><input id="mailcow-url" name="mailcowUrl" type="url" placeholder="https://mail.example.com" autocomplete="off"></div><div class="form-field"><label for="mailcow-key">Mailcow API key</label><input id="mailcow-key" name="mailcowKey" type="password" autocomplete="new-password"></div></div>
    <p class="hint">Cloudflare: Zone Read + DNS Edit. Enable Zone Settings Edit for HTTPS settings, Zone Config Rules Edit for ACME/webmail, and Zone WAF Edit for MainWP skip, only when using those features. Zone Edit is needed only to create zones.</p><div class="actions dialog-actions"><button class="btn" type="button" onclick="this.closest('dialog').close()">Cancel</button><button class="btn btn-primary" type="submit">Save connections</button></div></form></dialog>
  <dialog id="profile-dialog" aria-labelledby="profile-title"><div class="dialog-header"><h2 id="profile-title">Profile</h2></div><form onsubmit="saveProfile(event)"><p class="hint">New profiles start in Report only. Editing an enforcing profile shows a new plan before applying changes.</p><div class="form-grid">
    ${input("name", "Name")}${input("serverIpv4", "Server IPv4 override", "Blank uses the detected public IPv4.")}${input("serverIpv6", "Server IPv6 override", "Blank uses a unique detected public IPv6; no address means no AAAA record.")}
    </div><div class="toggle-grid">${toggle("webProxied", "Proxy web records")}${toggle("acmeRule", "Full SSL for ACME HTTP-01")}${toggle("webmailRule", "Full SSL for webmail")}${toggle("zoneSettings", "Strict SSL + Always use HTTPS for the zone")}${toggle("createZones", "Create missing zones (registrar change is manual)")}${toggle("mailEnabled", "Set up Mailcow and mail DNS")}${toggle("proxyAfterCertificate", "Wait for a valid certificate before proxying (alternative)")}</div>
    <p class="hint">Proxied from creation with the ACME rule works with Cloudflare-only origin access. Waiting for a certificate requires direct origin access. Webmail uses its template's own proxy setting.</p>
    <h3>Mail</h3><div class="form-grid">${input("mailHost", "Mail host", "MX, autoconfig and autodiscover target.")}${input("webmailHost", "Webmail hub host")}${input("mailIpv4", "Mail server IPv4", "Used in SPF; no mail-server address records are created.")}${input("mailIpv6", "Mail server IPv6")}${input("sharedMailbox", "Shared SMTP mailbox", "Existing Mailcow mailbox whose sender ACL gets this domain.")}${input("dkimSource", "Duplicate DKIM from domain", "Blank generates a new key for each domain.")}${input("dkimSelector", "Selector for generated DKIM")}
    <div class="form-field"><label for="profile-dkimBits">DKIM key size</label><select id="profile-dkimBits" data-profile-field="dkimBits"><option>1024</option><option>2048</option><option>3072</option><option>4096</option></select></div>
    <div class="form-field"><label for="profile-includes">Extra SPF includes</label><textarea id="profile-includes" rows="2" placeholder="_spf.provider.example"></textarea><div class="hint">One hostname per line. Adds these and mail IPs to existing SPF, preserving senders and policy. New SPF ends ~all. Removing an include here does not revoke it in DNS.</div></div>
    <div class="form-field"><label for="profile-spf-domains">Per-domain SPF includes</label><textarea id="profile-spf-domains" rows="2" placeholder="example.net: _spf.provider.example"></textarea><div class="hint">One domain per line: domain: include-host include-host.</div></div>
    <div class="form-field"><label for="profile-mainwp">MainWP server IPs to skip</label><textarea id="profile-mainwp" rows="2" placeholder="192.0.2.10"></textarea><div class="hint">Optional, one IP per line. Skips Super Bot Fight Mode and managed WAF rules. Cloudflare cannot skip ordinary Bot Fight Mode.</div></div></div>
    <details class="templates-editor"><summary>Record templates</summary><p class="hint">JSON templates with {domain}, {server.ipv4}, {server.ipv6}, {mail.host}, {mail.ipv4}, {mail.ipv6}, {webmail.host}, {spf}, {selector}, {dkim}. apexOnly adds a record only when the site is the zone apex. proxy is web, on or off. Template names must stay inside the site.</p><textarea id="profile-templates" rows="14" spellcheck="false" aria-label="Record templates JSON"></textarea></details>
    <div class="actions dialog-actions"><button class="btn" type="button" onclick="this.closest('dialog').close()">Cancel</button><button class="btn btn-primary" type="submit">Save profile</button></div></form></dialog>
  <dialog id="review-dialog" aria-labelledby="review-title"><div class="dialog-header"><h2 id="review-title">Confirm changes</h2></div><div id="review-content"></div><div class="actions dialog-actions"><button class="btn" type="button" onclick="this.closest('dialog').close()">Cancel</button><button class="btn btn-primary" id="apply-plan" type="button" onclick="applyPlan()">Confirm and apply</button></div></dialog>`;
}

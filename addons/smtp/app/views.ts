import CLIENT_BODY from "./views.client.js" with { type: "text" };
import CSS from "./views.css" with { type: "text" };
import { esc } from "../../../lib/app-http";
import { FLEET_ROW_SELECTION_JS, fleetRowSelectionStyle, renderLayout } from "../../../lib/app-ui";
import { mountPath } from "../../../lib/mount";
import type { SmtpProfileView, SmtpSiteView, SmtpState } from "../action";

const BASE = mountPath("smtp");
const STYLE = CSS.split("/* fleet-row-selection */").join(fleetRowSelectionStyle("smtp-site-table"));
const CLIENT = `${FLEET_ROW_SELECTION_JS}\n${CLIENT_BODY}`;
const NO_PROFILE = "Not relayed";
/** Not a valid profile id, so no profile can be mistaken for it. */
const BULK_NONE = "-";

export function layout(title: string, content: string, notice?: { current: string; latest: string } | null): string {
  return renderLayout(title, content, { brand: "SMTP Relay", base: BASE, nav: [], css: STYLE, script: CLIENT, updateNotice: notice });
}

const TEMPLATE_HINT = "<code>{site}</code> is the site's domain, without a leading www. <code>{from.local}</code> and <code>{from.domain}</code> are the name and domain of the From the app asked for, used only when that domain is the site's own or one it may also send as. <code>{from.local}@{site}</code> keeps <code>wordpress@</code> or <code>orders@</code> on the site's domain.";

const TYPE_LABELS: Record<string, string> = { static: "Static", nodejs: "Node.js", python: "Python", "reverse-proxy": "Reverse proxy" };
function typeLabel(site: SmtpSiteView): string {
  return site.phpVersion !== null ? `PHP ${site.phpVersion}` : TYPE_LABELS[site.type] ?? site.type;
}

function profileOptions(profiles: SmtpProfileView[], selected: string | null, none = NO_PROFILE): string {
  return [`<option value="">${esc(none)}</option>`]
    .concat(profiles.map((profile) => `<option value="${esc(profile.id)}"${profile.id === selected ? " selected" : ""}>${esc(profile.name)}</option>`))
    .join("");
}

/** Starts on nothing, so the first entry of the list is not the one that takes sites out of their profile. */
function bulkOptions(profiles: SmtpProfileView[]): string {
  return [`<option value="" selected disabled>Choose a profile</option>`]
    .concat(profiles.map((profile) => `<option value="${esc(profile.id)}">${esc(profile.name)}</option>`))
    .concat([`<option value="${BULK_NONE}">${esc(NO_PROFILE)}</option>`])
    .join("");
}

/** Lets an address wrap after its @ rather than inside its name or domain. */
const wrappable = (address: string): string => esc(address).replace("@", "@<wbr>");

function profileRow(profile: SmtpProfileView, isDefault: boolean): string {
  const through = profile.relay
    ? `${esc(profile.relay.host)}:${profile.relay.port}<span class="hint">${esc(profile.relay.username)}</span>`
    : `Discards mail<span class="hint">Logged, never delivered</span>`;
  return `<tr data-profile="${esc(profile.id)}">
    <td class="site-cell"><strong>${esc(profile.name)}</strong>${isDefault ? '<span class="badge state-default">Default for new sites</span>' : ""}</td>
    <td data-label="Sends through" class="wide-cell">${through}</td>
    <td data-label="From" class="wide-cell">${profile.relay ? `<span class="mono">${wrappable(profile.sender)}</span>` : "—"}</td>
    <td data-label="Sites" class="numeric">${profile.sites}</td>
    <td data-label="Actions" class="action-cell"><div class="actions">
      <button class="btn" type="button" onclick="smtpEditProfile('${esc(profile.id)}')">Edit</button>
      <button class="btn btn-danger" type="button" onclick="smtpDeleteProfile('${esc(profile.id)}')">Delete</button>
    </div></td>
  </tr>`;
}

function siteRow(site: SmtpSiteView, profiles: SmtpProfileView[]): string {
  const discards = profiles.find((profile) => profile.id === site.profileId)?.relay === null;
  const from = site.blocked ? `<span class="hint blocked">Blocked: ${esc(site.blocked)}</span>`
    : site.sender === null ? '<span class="hint">Not relayed</span>'
    : discards ? '<span class="hint">Discarded</span>' : `<span class="mono">${wrappable(site.sender)}</span>`;
  const grants = site.grants.length ? `<span class="hint">Also sends as ${site.grants.map(esc).join(", ")}</span>` : "";
  return `<tr data-domain="${esc(site.domain)}" data-profile-id="${esc(site.profileId ?? "")}" tabindex="0" aria-selected="false" onclick="toggleSiteSelection(event, this, smtpPaintSelection)" onkeydown="toggleSiteSelection(event, this, smtpPaintSelection)">
    <td class="site-select"><input class="site-checkbox" type="checkbox" onchange="smtpPaintSelection()" aria-label="Select ${esc(site.domain)}"></td>
    <td class="site-cell"><strong>${esc(site.domain)}</strong><span class="hint">${esc(site.user)}</span></td>
    <td class="type-cell">${esc(typeLabel(site))}</td>
    <td data-label="Profile"><select aria-label="Profile for ${esc(site.domain)}" onchange="smtpAssignRow(this)">${profileOptions(profiles, site.profileId)}</select></td>
    <td data-label="From" class="wide-cell">${from}${grants}</td>
    <td data-label="Actions" class="action-cell"><button class="btn" type="button" onclick="smtpEditGrants('${esc(site.domain)}')">Domains</button></td>
  </tr>`;
}

export function dashboardView(state: SmtpState): string {
  return `<div id="smtp-root">${dashboardContent(state)}</div>`;
}

/** Everything a change can alter, repainted in place from the action's reply. */
export function dashboardContent(state: SmtpState): string {
  const data = JSON.stringify(state).replaceAll("<", "\\u003c");
  const routed = state.sites.filter((site) => site.profileId !== null);
  const profiles = state.profiles.map((profile) => profileRow(profile, profile.id === state.defaultProfileId)).join("");
  const sites = state.sites.map((site) => siteRow(site, state.profiles)).join("");
  return `<script type="application/json" id="smtp-state">${data}</script>
    <div class="page-heading"><div><h1>SMTP relay</h1>
      <p>Send each site's mail through a relay profile. Postfix lets a site send only as its own domains, so it can only use its own profile.</p></div>
      <button class="btn btn-primary" type="button" onclick="smtpEditProfile('')">New profile</button></div>
    <div class="card default-card">
      <div><h2>New sites</h2><p>A site created from now on joins this profile.</p>
        <p class="hint">Existing sites are never moved by this. A new site is picked up seconds after CloudPanel creates it.</p></div>
      <div class="default-choice"><label class="hint" for="smtp-default">Profile for new sites</label>
        <select id="smtp-default" onchange="smtpSetDefault(this)">${profileOptions(state.profiles, state.defaultProfileId, "None")}</select></div>
    </div>
    <div class="card card-table"><div class="card-header"><div><h2>Profiles</h2>
      <p class="hint">A profile is one SMTP account. Its provider must accept the From addresses its sites send as.</p></div></div>
      ${profiles ? `<table class="fleet-table smtp-profile-table"><thead><tr><th>Profile</th><th>Sends through</th><th>From</th><th class="numeric">Sites</th><th class="action-cell">Actions</th></tr></thead><tbody>${profiles}</tbody></table>`
        : '<div class="empty">No profiles yet. Create one for each SMTP account.</div>'}
    </div>
    <div class="card card-table">
    ${state.sites.length ? `<div class="card-header toolbar">
        <h2>Sites</h2>
        <span class="toolbar-note" id="site-selection">No sites selected</span>
        <button class="btn mobile-select-all" id="select-all-btn" type="button" onclick="toggleAllSites(smtpPaintSelection)">Select all</button>
        <select class="toolbar-end" id="bulk-profile" aria-label="Profile to put the selected sites in">${bulkOptions(state.profiles)}</select>
        <button class="btn" id="assign-selected" type="button" disabled onclick="smtpAssignSelected()">Assign selected</button>
      </div>
      <table class="fleet-table smtp-site-table"><thead><tr>
        <th class="site-select"><input id="select-all" type="checkbox" onchange="selectAllSites(this.checked, smtpPaintSelection)" aria-label="Select all sites"></th>
        <th>Site</th><th>Runs</th><th>Profile</th><th>From</th><th class="action-cell">Actions</th>
      </tr></thead><tbody>${sites}</tbody></table>`
      : '<div class="empty">CloudPanel has no sites yet.</div>'}
    ${state.skipped.length ? `<p class="hint skipped-note">Left alone, sending only as their Unix user: ${state.skipped
      .map((site) => `${esc(site.domain)} (${esc(site.reason)})`).join("; ")}.</p>` : ""}
    </div>
    <form class="card smtp-form" id="smtp-test-form" onsubmit="smtpSendTest(event)">
      <h2>Send a test</h2><p class="hint">Sends as the site's own Unix user through the same path as its mail: PHP's <code>mail()</code> for a PHP site, sendmail for any other. A successful result means Postfix queued it; check the inbox for delivery.</p>
      <div class="smtp-grid"><label>Site<select name="domain" required>${routed.map((site) => `<option value="${esc(site.domain)}">${esc(site.domain)}</option>`).join("")}</select></label>
      <label>Recipient<input name="recipient" type="email" required placeholder="you@example.com"></label></div>
      <label>From the app asks for (optional)<input name="from" type="email" autocomplete="off" placeholder="wordpress@{site}"></label>
      <div class="actions"><button class="btn" type="submit" ${routed.length ? "" : "disabled"}>Queue test email</button></div>
    </form>
    <dialog id="smtp-profile-dialog" class="smtp-dialog"><form method="dialog" id="smtp-profile-form" onsubmit="smtpSaveProfile(event)">
      <h2 id="smtp-profile-heading">New profile</h2><input type="hidden" name="id">
      <label>Name<input name="name" required maxlength="40" autocomplete="off" placeholder="Postmark"></label>
      <label>Mail from its sites<select name="delivery" onchange="smtpSyncDelivery()"><option value="send">Is sent through an SMTP server</option><option value="discard">Is discarded, for staging copies</option></select></label>
      <div id="smtp-relay-fields"><div class="smtp-grid">
        <label>SMTP hostname<input name="host" autocomplete="off" placeholder="smtp.postmarkapp.com"></label>
        <label>Port<input name="port" type="number" min="1" max="65535" value="587"></label>
        <label>Username<input name="username" autocomplete="off"></label>
        <label>Password<input name="password" type="password" autocomplete="new-password"></label>
      </div><p class="hint">STARTTLS on 587 or 2525. The certificate must be valid for the hostname.</p>
      <label>From<input name="sender" autocomplete="off" placeholder="noreply@{site}"></label><p class="hint">${TEMPLATE_HINT}</p></div>
      <div class="actions"><button class="btn" type="button" onclick="this.closest('dialog').close()">Cancel</button><button class="btn btn-primary" type="submit">Save profile</button></div>
    </form></dialog>
    <dialog id="smtp-grants-dialog" class="smtp-dialog"><form method="dialog" id="smtp-grants-form" onsubmit="smtpSaveGrants(event)">
      <h2 id="smtp-grants-heading">Sending domains</h2><input type="hidden" name="domain">
      <label>Also sends as<textarea name="domains" rows="4" placeholder="news.example.com"></textarea></label>
      <p class="hint">Its own domain is always allowed. These domains go through the site's profile too, and no other site may use them through a different profile.</p>
      <div class="actions"><button class="btn" type="button" onclick="this.closest('dialog').close()">Cancel</button><button class="btn btn-primary" type="submit">Save domains</button></div>
    </form></dialog>`;
}

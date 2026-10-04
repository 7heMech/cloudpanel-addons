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

const TEMPLATE_HINT = "<code>{site}</code> is the site's domain, without a leading www. <code>{from.local}</code> and <code>{from.domain}</code> are the name and domain of the From the app asked for, used only when that domain is the site's own or one of its extra sending domains. <code>{from.local}@{site}</code> keeps <code>wordpress@</code> or <code>orders@</code> on the site's domain.";

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
  return `<tr data-domain="${esc(site.domain)}" data-profile-id="${esc(site.profileId ?? "")}" tabindex="0" aria-selected="false" onclick="toggleSiteSelection(event, this, smtpPaintSelection)" onkeydown="toggleSiteSelection(event, this, smtpPaintSelection)">
    <td class="site-select"><input class="site-checkbox" type="checkbox" onchange="smtpPaintSelection()" aria-label="Select ${esc(site.domain)}"></td>
    <td class="site-cell"><strong>${esc(site.domain)}</strong><span class="hint">${esc(site.user)}</span></td>
    <td class="type-cell">${esc(typeLabel(site))}</td>
    <td data-label="Profile"><select aria-label="Profile for ${esc(site.domain)}" onchange="smtpAssignRow(this)">${profileOptions(profiles, site.profileId)}</select></td>
    <td data-label="From" class="wide-cell">${from}</td>
  </tr>`;
}

function grantRow(site: SmtpSiteView, profiles: SmtpProfileView[]): string {
  const profile = profiles.find((candidate) => candidate.id === site.profileId)?.name ?? NO_PROFILE;
  return `<tr>
    <td class="site-cell"><strong>${esc(site.domain)}</strong><span class="hint">${esc(profile)}</span></td>
    <td data-label="Also sends as" class="wide-cell">${site.grants.map(esc).join("<br>")}</td>
    <td data-label="Actions" class="action-cell"><div class="actions">
      <button class="btn" type="button" onclick="smtpEditGrants('${esc(site.domain)}')">Edit</button>
      <button class="btn btn-danger" type="button" onclick="smtpRemoveGrants('${esc(site.domain)}')">Remove</button>
    </div></td>
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
  const grants = state.sites.filter((site) => site.grants.length).map((site) => grantRow(site, state.profiles)).join("");
  const field = (id: string, label: string, control: string, hint = "", full = false) =>
    `<div class="form-field${full ? " form-field-full" : ""}"><label for="${id}">${label}</label>${control}${hint ? `<div class="hint">${hint}</div>` : ""}</div>`;
  const dialogActions = (save: string) => `<div class="actions dialog-actions"><button class="btn" type="button" onclick="this.closest('dialog').close()">Cancel</button><button class="btn btn-primary" type="submit">${save}</button></div>`;
  return `<script type="application/json" id="smtp-state">${data}</script>
    <div class="page-heading"><div><h1>SMTP relay</h1>
      <p>Send each site's mail through its profile's SMTP account. Postfix lets a site send only as its own domains, so never through another profile.</p></div>
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
        <th>Site</th><th>Runs</th><th>Profile</th><th>From</th>
      </tr></thead><tbody>${sites}</tbody></table>`
      : '<div class="empty">CloudPanel has no sites yet.</div>'}
    ${state.skipped.length ? `<p class="hint skipped-note">Can't be relayed: ${state.skipped
      .map((site) => `${esc(site.domain)} (${esc(site.reason)})`).join("; ")}.</p>` : ""}
    </div>
    <div class="card card-table smtp-grants-card"><div class="card-header"><div><h2>Extra sending domains</h2>
      <p class="hint">A site always sends as its own domain. Add any other domain its apps send as, such as example.com for app.example.com. Its mail goes through the site's profile, and no site in another profile can send as it.</p></div>
      <button class="btn" type="button" onclick="smtpEditGrants('')"${state.sites.length ? "" : " disabled"}>Add domains</button></div>
      ${grants ? `<table class="fleet-table smtp-grants-table"><thead><tr><th>Site</th><th>Also sends as</th><th class="action-cell">Actions</th></tr></thead><tbody>${grants}</tbody></table>`
        : '<div class="empty">Every site sends only as its own domain.</div>'}
    </div>
    <form class="card" id="smtp-test-form" onsubmit="smtpSendTest(event)">
      <div class="card-header"><div><h2>Send a test</h2><p class="hint">Sends as the site's own Unix user through the same path as its mail: PHP's <code>mail()</code> for a PHP site, sendmail for any other. A successful result means Postfix queued it; check the inbox for delivery.</p></div></div>
      <div class="form-grid">
        ${field("smtp-test-site", "Site", `<select id="smtp-test-site" name="domain" required>${routed.map((site) => `<option value="${esc(site.domain)}">${esc(site.domain)}</option>`).join("")}</select>`,
          routed.length ? "" : "Assign a site to a profile first.")}
        ${field("smtp-test-recipient", "Recipient", '<input id="smtp-test-recipient" name="recipient" type="email" required placeholder="you@example.com">')}
        ${field("smtp-test-from", "From the app asks for", '<input id="smtp-test-from" name="from" type="email" autocomplete="off" placeholder="wordpress@{site}">',
          "Optional. The result shows what the profile's From makes of it.", true)}
      </div>
      <div class="actions smtp-test-actions"><button class="btn" type="submit" ${routed.length ? "" : "disabled"}>Queue test email</button></div>
    </form>
    <dialog id="smtp-profile-dialog" aria-labelledby="smtp-profile-heading"><form id="smtp-profile-form" onsubmit="smtpSaveProfile(event)">
      <div class="dialog-header"><h2 id="smtp-profile-heading">New profile</h2></div><input type="hidden" name="id">
      <div class="form-grid">
        ${field("smtp-name", "Name", '<input id="smtp-name" name="name" required maxlength="40" autocomplete="off" placeholder="Postmark">')}
        ${field("smtp-delivery", "Mail from its sites", '<select id="smtp-delivery" name="delivery" onchange="smtpSyncDelivery()"><option value="send">Is sent through an SMTP server</option><option value="discard">Is discarded, for staging copies</option></select>')}
      </div>
      <div class="form-grid smtp-relay-fields" id="smtp-relay-fields">
        ${field("smtp-host", "SMTP hostname", '<input id="smtp-host" name="host" autocomplete="off" placeholder="smtp.postmarkapp.com" oninput="smtpSyncDelivery()">', "Its certificate must be valid for this name.")}
        ${field("smtp-port", "Port", '<input id="smtp-port" name="port" type="number" min="1" max="65535" value="587">', "587 or 2525, with STARTTLS.")}
        ${field("smtp-username", "Username", '<input id="smtp-username" name="username" autocomplete="off" oninput="smtpSyncDelivery()">')}
        ${field("smtp-password", "Password", '<input id="smtp-password" name="password" type="password" autocomplete="new-password">')}
        ${field("smtp-sender", "From", '<input id="smtp-sender" name="sender" autocomplete="off" placeholder="noreply@{site}">', TEMPLATE_HINT, true)}
      </div>
      ${dialogActions("Save profile")}
    </form></dialog>
    <dialog id="smtp-grants-dialog" aria-labelledby="smtp-grants-heading"><form id="smtp-grants-form" onsubmit="smtpSaveGrants(event)">
      <div class="dialog-header"><h2 id="smtp-grants-heading">Extra sending domains</h2></div>
      <div class="form-grid">
        ${field("smtp-grants-site", "Site", `<select id="smtp-grants-site" name="domain" required onchange="smtpLoadGrants()"><option value="" disabled selected>Choose a site</option>${state.sites
          .map((site) => `<option value="${esc(site.domain)}">${esc(site.domain)}</option>`).join("")}</select>`, "", true)}
        ${field("smtp-grants-domains", "Also sends as", '<textarea id="smtp-grants-domains" name="domains" rows="4" placeholder="example.com"></textarea>',
          "One domain per line. Leave it empty for the site's own domain only.", true)}
      </div>
      ${dialogActions("Save domains")}
    </form></dialog>`;
}

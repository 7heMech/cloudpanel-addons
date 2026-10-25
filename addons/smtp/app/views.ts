import CLIENT_BODY from "./views.client.js" with { type: "text" };
import CSS from "./views.css" with { type: "text" };
import { esc } from "../../../lib/app-http";
import {
  FLEET_NONE_HTML, FLEET_ROW_SELECTION_JS, fleetFilterHtml, fleetRowSelectionStyle, renderLayout,
} from "../../../lib/app-ui";
import { mountPath } from "../../../lib/mount";
import type { SmtpProfileView, SmtpSiteView, SmtpState } from "../action";

const BASE = mountPath("smtp");
const STYLE = CSS.split("/* fleet-row-selection */").join(fleetRowSelectionStyle("smtp-site-table"));
export const CLIENT = `${FLEET_ROW_SELECTION_JS}\n${CLIENT_BODY}`;
const NO_PROFILE = "Not relayed (sent from this server)";
const DONT_SEND = "dont-send";
const DONT_SEND_LABEL = "Don't send (discard)";
/** Not a valid profile id, so no profile can be mistaken for it. */
const BULK_NONE = "-";

export function layout(title: string, content: string, notice?: { current: string; latest: string } | null): string {
  return renderLayout(title, content, { brand: "SMTP Relay", base: BASE, nav: [], css: STYLE, script: CLIENT, updateNotice: notice });
}

const TEMPLATE_HINT = "<code>{site}</code> is the site's domain. A leading www. is removed only when the bare domain contains a dot and is not another CloudPanel site. <code>{from.local}</code> and <code>{from.domain}</code> are the name and domain of the From the app asked for, used only when that domain is the site's own or one of its extra sending domains. <code>{from.local}@{site}</code> keeps <code>wordpress@</code> or <code>orders@</code> on the site's domain.";

const TYPE_LABELS: Record<string, string> = { static: "Static", nodejs: "Node.js", python: "Python", "reverse-proxy": "Reverse proxy" };
function typeLabel(site: SmtpSiteView): string {
  return site.phpVersion !== null ? `PHP ${site.phpVersion}` : TYPE_LABELS[site.type] ?? site.type;
}

const relays = (profiles: SmtpProfileView[]) => profiles.filter((profile) => profile.relay);

/** Not relayed, then each relay profile, then discard: the three things a site's mail can do. */
function profileOptions(profiles: SmtpProfileView[], selected: string | null, none = ""): string {
  return [`<option value="${none}"${selected === null ? " selected" : ""}>${esc(NO_PROFILE)}</option>`]
    .concat(relays(profiles).map((profile) => `<option value="${esc(profile.id)}"${profile.id === selected ? " selected" : ""}>${esc(profile.name)}</option>`))
    .concat([`<option value="${DONT_SEND}"${selected === DONT_SEND ? " selected" : ""}>${esc(DONT_SEND_LABEL)}</option>`])
    .join("");
}

/** Starts on nothing, so the first entry of the list is not the one that takes sites out of their profile. */
function bulkOptions(profiles: SmtpProfileView[]): string {
  return `<option value="" selected disabled>Choose where mail goes</option>${profileOptions(profiles, "", BULK_NONE)}`;
}

/** Lets an address wrap after its @ rather than inside its name or domain. */
const wrappable = (address: string): string => esc(address).replace("@", "@<wbr>");

function profileRow(profile: SmtpProfileView): string {
  return `<tr data-profile="${esc(profile.id)}">
    <td class="site-cell"><strong>${esc(profile.name)}</strong></td>
    <td data-label="Sends through" class="wide-cell">${esc(profile.relay!.host)}:${profile.relay!.port}<span class="hint">${esc(profile.relay!.username)}</span></td>
    <td data-label="From" class="wide-cell"><span class="mono">${wrappable(profile.sender)}</span></td>
    <td data-label="Sites" class="numeric">${profile.sites}</td>
    <td data-label="Actions" class="action-cell"><div class="actions">
      <button class="btn" type="button" onclick="smtpEditProfile('${esc(profile.id)}')">Edit</button>
      <button class="btn btn-danger" type="button" onclick="smtpDeleteProfile('${esc(profile.id)}')">Delete</button>
    </div></td>
  </tr>`;
}

/** Whether a test from this site would reach a relay. */
function relayed(site: SmtpSiteView, profiles: SmtpProfileView[]): boolean {
  return !site.blocked && !site.bypass && Boolean(profiles.find((profile) => profile.id === site.profileId)?.relay);
}

function siteRow(site: SmtpSiteView, profiles: SmtpProfileView[]): string {
  const discards = site.profileId === DONT_SEND;
  const from = site.blocked ? `<span class="hint tone-warn">Blocked: ${esc(site.blocked)}</span>`
    : site.bypass ? '<span class="hint tone-warn">Bypassed: its PHP-FPM pool sets its own sendmail_path</span>'
    : site.sender === null ? '<span class="hint">—</span>'
    : discards ? '<span class="hint">Discarded</span>' : `<span class="mono">${wrappable(site.sender)}</span>`;
  const show = [site.profileId === null ? "unrelayed" : "", discards ? "discarded" : "", site.blocked || site.bypass ? "blocked" : ""].filter(Boolean).join(" ");
  const grants = site.grants.length ? ` · also sends as ${site.grants.map(esc).join(", ")}` : "";
  return `<tr data-domain="${esc(site.domain)}" data-find="${esc([site.domain, ...site.grants].join(" "))}" data-show="${show}" data-profile-id="${esc(site.profileId ?? "")}" tabindex="0" aria-selected="false" onclick="toggleSiteSelection(event, this)" onkeydown="toggleSiteSelection(event, this)">
    <td class="site-select"><input class="site-checkbox" type="checkbox" onchange="paintFleetSelection()" aria-label="Select ${esc(site.domain)}"></td>
    <td class="site-cell"><strong>${esc(site.domain)}</strong><span class="hint">${esc(site.user)} · ${esc(typeLabel(site))}${grants}</span></td>
    <td data-label="Mail"><select aria-label="Where mail from ${esc(site.domain)} goes" onchange="smtpAssignRow(this)">${profileOptions(profiles, site.profileId)}</select></td>
    <td data-label="From" class="wide-cell">${from}</td>
    <td data-label="Actions" class="action-cell"><div class="actions">
      <button class="btn" type="button" onclick="smtpOpenTest('${esc(site.domain)}')"${relayed(site, profiles) ? "" : " disabled"}>Test</button>
      <button class="btn" type="button" onclick="smtpEditGrants('${esc(site.domain)}')">Domains</button>
    </div></td>
  </tr>`;
}

/** Until a profile has an SMTP server: the three steps that relay a site. */
function setupCard(state: SmtpState): string {
  if (relays(state.profiles).length) return "";
  const step = (title: string, hint: string, control: string): string =>
    `<li><div><strong>${title}</strong><span class="hint">${hint}</span></div><div class="smtp-step-control">${control}</div></li>`;
  return `<div class="card smtp-setup"><h2>Set up SMTP Relay</h2><ol class="smtp-checklist">
    ${step("Create a profile", "One SMTP account: its server, login and the From its sites send with.",
      '<button class="btn btn-primary" type="button" onclick="smtpEditProfile(\'\')">New profile</button>')}
    ${step("Assign sites, or choose the profile new sites join", "Pick it in a site's Mail column, in bulk, or under Profiles.", '<span class="hint">After step 1</span>')}
    ${step("Send a test", "Test on a site's row sends one and shows what the SMTP server answered.", '<span class="hint">After step 2</span>')}
  </ol></div>`;
}

export function dashboardView(state: SmtpState): string {
  return `<div id="smtp-root">${dashboardContent(state)}</div>`;
}

/** Everything a change can alter, repainted in place from the action's reply. */
export function dashboardContent(state: SmtpState): string {
  const data = JSON.stringify(state).replaceAll("<", "\\u003c");
  const profiles = relays(state.profiles).map(profileRow).join("");
  const sites = state.sites.map((site) => siteRow(site, state.profiles)).join("");
  const total = state.sites.length;
  const field = (id: string, label: string, control: string, hint = "", full = false) =>
    `<div class="form-field${full ? " form-field-full" : ""}"><label for="${id}">${label}</label>${control}${hint ? `<div class="hint">${hint}</div>` : ""}</div>`;
  const dialogActions = (save: string, close = "Cancel") => `<div class="actions dialog-actions"><button class="btn" type="button" onclick="this.closest('dialog').close()">${close}</button><button class="btn btn-primary" type="submit">${save}</button></div>`;
  const discardDefault = state.defaultProfileId === DONT_SEND
    ? `<div class="notice">New sites join <strong>Don't send</strong>: their mail is discarded until you move them to a profile.</div>` : "";
  return `<script type="application/json" id="smtp-state">${data}</script>
    <div class="page-heading"><div><h1>SMTP Relay</h1>
      <p>Send each site's mail through its profile's SMTP account. Postfix lets a site send only as its own domains, so never through another profile.</p></div></div>
    ${setupCard(state)}${discardDefault}
    <div class="card card-table">
    ${total ? `<div class="card-header toolbar">
        <h2>Sites</h2>
        <span class="toolbar-note" id="site-selection">No sites selected</span>
        <button class="btn mobile-select-all" id="select-all-btn" type="button" onclick="toggleAllSites()">Select all</button>
        <select class="toolbar-end" id="bulk-profile" data-keep aria-label="Where mail from the selected sites goes">${bulkOptions(state.profiles)}</select>
        <button class="btn" id="assign-selected" type="button" disabled data-needs-selection onclick="smtpAssignSelected()">Assign selected</button>
      </div>
      ${fleetFilterHtml({ count: total, filters: [
        { value: "unrelayed", label: "Not relayed" }, { value: "discarded", label: "Discarded" }, { value: "blocked", label: "Blocked" },
      ], summary: `${total} site${total === 1 ? "" : "s"}` })}
      <table class="fleet-table smtp-site-table"><thead><tr>
        <th class="site-select"><input id="select-all" type="checkbox" onchange="selectAllSites(this.checked)" aria-label="Select all sites"></th>
        <th>Site</th><th>Mail</th><th>From</th><th class="action-cell">Actions</th>
      </tr></thead><tbody>${sites}</tbody></table>
      ${FLEET_NONE_HTML}`
      : '<div class="empty">CloudPanel has no sites yet.</div>'}
    ${state.skipped.length ? `<p class="hint skipped-note">Can't be relayed: ${state.skipped
      .map((site) => `${esc(site.domain)} (${esc(site.reason)})`).join("; ")}.</p>` : ""}
    </div>
    <div class="card card-table"><div class="card-header smtp-profiles-header"><div><h2>Profiles</h2>
      <p class="hint">A profile is one SMTP account. Its provider must accept the From addresses its sites send as.</p></div>
      <div class="smtp-profile-tools">
        <div class="smtp-default-field"><label class="hint" for="smtp-default">New sites</label>
          <select id="smtp-default" onchange="smtpSetDefault(this)">${profileOptions(state.profiles, state.defaultProfileId)}</select></div>
        <button class="btn btn-primary" type="button" onclick="smtpEditProfile('')">New profile</button></div></div>
      ${profiles ? `<table class="fleet-table smtp-profile-table"><thead><tr><th>Profile</th><th>Sends through</th><th>From</th><th class="numeric">Sites</th><th class="action-cell">Actions</th></tr></thead><tbody>${profiles}</tbody></table>`
        : '<div class="empty">No profiles yet. Create one for each SMTP account.</div>'}
    </div>
    <dialog id="smtp-profile-dialog" aria-labelledby="smtp-profile-heading"><form id="smtp-profile-form" onsubmit="smtpSaveProfile(event)">
      <div class="dialog-header"><h2 id="smtp-profile-heading">New profile</h2></div><input type="hidden" name="id">
      <div class="form-grid">
        ${field("smtp-name", "Name", '<input id="smtp-name" name="name" required maxlength="40" autocomplete="off" placeholder="Postmark">', "", true)}
        ${field("smtp-host", "SMTP hostname", '<input id="smtp-host" name="host" required autocomplete="off" placeholder="smtp.postmarkapp.com" oninput="smtpSyncPassword()">', "Its certificate must be valid for this name.")}
        ${field("smtp-port", "Port", '<input id="smtp-port" name="port" type="number" required min="1" max="65535" value="587">', "587 or 2525, with STARTTLS.")}
        ${field("smtp-username", "Username", '<input id="smtp-username" name="username" required autocomplete="off" oninput="smtpSyncPassword()">')}
        ${field("smtp-password", "Password", '<input id="smtp-password" name="password" type="password" autocomplete="new-password">')}
        ${field("smtp-sender", "From", '<input id="smtp-sender" name="sender" required autocomplete="off" placeholder="noreply@{site}">', "", true)}
      </div>
      <details class="disclosure smtp-from-help"><summary><div><span class="summary-title">How From is chosen</span></div></summary>
        <p class="hint">${TEMPLATE_HINT}</p></details>
      ${dialogActions("Save profile")}
    </form></dialog>
    <dialog id="smtp-grants-dialog" aria-labelledby="smtp-grants-heading"><form id="smtp-grants-form" onsubmit="smtpSaveGrants(event)">
      <div class="dialog-header"><h2 id="smtp-grants-heading">Extra sending domains</h2></div><input type="hidden" name="domain">
      <p class="hint">A site always sends as its own domain. Add any other domain its apps send as, such as example.com for app.example.com. Its mail goes through the site's profile, and no site in another profile can send as it.</p>
      <div class="form-grid">
        ${field("smtp-grants-domains", "Also sends as", '<textarea id="smtp-grants-domains" name="domains" rows="4" placeholder="example.com"></textarea>',
          "One domain per line. Leave it empty for the site's own domain only.", true)}
      </div>
      ${dialogActions("Save domains")}
    </form></dialog>
    <dialog id="smtp-test-dialog" aria-labelledby="smtp-test-heading"><form id="smtp-test-form" onsubmit="smtpSendTest(event)">
      <div class="dialog-header"><h2 id="smtp-test-heading">Send a test</h2></div><input type="hidden" name="domain">
      <p class="hint">Sent as the site's own Unix user through the same path as its mail: PHP's <code>mail()</code> for a PHP site, sendmail for any other.</p>
      <div class="form-grid">
        ${field("smtp-test-recipient", "Recipient", '<input id="smtp-test-recipient" name="recipient" type="email" required placeholder="you@example.com">')}
        ${field("smtp-test-from", "From the app asks for", '<input id="smtp-test-from" name="from" type="email" autocomplete="off" placeholder="wordpress@example.com">',
          "Optional. The result shows what the profile's From makes of it.")}
      </div>
      <div id="smtp-test-result" class="smtp-test-result" role="status" hidden></div>
      ${dialogActions("Send test", "Close")}
    </form></dialog>`;
}

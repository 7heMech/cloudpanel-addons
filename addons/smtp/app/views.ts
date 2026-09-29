import CLIENT from "./views.client.js" with { type: "text" };
import CSS from "./views.css" with { type: "text" };
import { esc } from "../../../lib/app-http";
import { renderLayout } from "../../../lib/app-ui";
import { mountPath } from "../../../lib/mount";
import type { SmtpState } from "../action";

const BASE = mountPath("smtp");

export function layout(title: string, content: string, notice?: { current: string; latest: string } | null): string {
  return renderLayout(title, content, { brand: "SMTP Relay", base: BASE, nav: [], css: CSS, script: CLIENT, updateNotice: notice });
}

const TEMPLATE_HINT = "<code>{site}</code> is the site's domain. <code>{from.local}</code> and <code>{from.domain}</code> are the name and domain of the From the app asked for, when it is on the site's domain, so <code>{from.local}@{site}</code> keeps <code>wordpress@</code> or <code>orders@</code> on the site's domain.";

export function dashboardView(state: SmtpState): string {
  return `<div id="smtp-root">${dashboardContent(state)}</div>`;
}

/** Everything a save can change, repainted in place from the action's reply. */
export function dashboardContent(state: SmtpState): string {
  const data = JSON.stringify(state).replaceAll("<", "\\u003c");
  const relay = state.relay;
  const sites = state.sites.map((site) => `<tr>
    <td class="site-cell"><strong>${esc(site.domain)}</strong><span class="hint">${esc(site.user)}</span></td>
    <td data-label="From" class="wide-cell"><code>${esc(site.senderPreview)}</code>${site.overridden ? ' <span class="badge">Override</span>' : ""}${site.rule.domains.length ? `<span class="hint">{from.domain} may also be ${site.rule.domains.map((domain) => esc(domain)).join(", ")}</span>` : ""}</td>
    <td data-label="Actions" class="action-cell"><button class="btn" type="button" onclick="smtpEditSite('${site.domain}')">Edit</button></td>
  </tr>`).join("");
  const overrides = Object.entries(state.relayOverrides).map(([domain, item]) => `<tr>
    <td class="site-cell"><strong>${esc(domain)}</strong></td><td data-label="SMTP host">${esc(item.host)}:${item.port}</td><td data-label="Username">${esc(item.username)}</td>
    <td data-label="Actions" class="actions action-cell"><button class="btn" type="button" onclick="smtpEditDomain('${domain}')">Edit</button><button class="btn" type="button" onclick="smtpClearDomain('${domain}')">Remove</button></td>
  </tr>`).join("");
  return `<script type="application/json" id="smtp-state">${data}</script>
    <div class="page-heading"><div><h1>SMTP relay</h1><p>Send WordPress and other PHP mail through Postfix, with a From rule for each site.</p></div></div>
    <form class="card smtp-form" id="smtp-setup-form" onsubmit="smtpSaveSetup(event)">
      <div class="smtp-status"><div><h2>Relay and default sender</h2><p class="hint">Set the fallback SMTP account and the From every PHP site uses unless it has its own.</p></div><span class="badge">${relay ? "Configured" : "Setup needed"}</span></div>
      <h3>Global SMTP relay</h3><p class="hint">Used for sending domains without a relay override. Postfix queues messages and retries temporary failures.</p>
      <div class="smtp-grid">
        <label>SMTP hostname<input name="host" required autocomplete="off" placeholder="mail.example.com" value="${esc(relay?.host ?? "")}"></label>
        <label>Port<input name="port" type="number" min="1" max="65535" required value="${relay?.port ?? 587}"></label>
        <label>Username<input name="username" required autocomplete="off" value="${esc(relay?.username ?? "")}"></label>
        <label>Password<input name="password" type="password" ${relay ? "" : "required"} autocomplete="new-password" placeholder="${relay ? "Leave blank to keep saved password" : "SMTP password"}"></label>
      </div><h3>Default From</h3><p class="hint">${TEMPLATE_HINT}</p>
      <label>From address<input name="sender" required autocomplete="off" value="${esc(state.defaultRule.sender)}" placeholder="noreply@{site}"></label>
      <div class="actions"><button class="btn btn-primary" type="submit">Save relay and default</button></div>
    </form>
    <form class="card smtp-form" id="smtp-test-form" onsubmit="smtpSendTest(event)">
      <h2>Send a test</h2><p class="hint">Sends as the site's own account through the same path as PHP <code>mail()</code>, so the site's From rule applies. A successful result means Postfix queued the message; check the inbox for delivery.</p>
      <div class="smtp-grid"><label>Sender site<select name="domain" required>${state.sites.map((site) => `<option value="${esc(site.domain)}">${esc(site.domain)}</option>`).join("")}</select></label>
      <label>Recipient<input name="recipient" type="email" required placeholder="you@example.com"></label></div>
      <label>From the app asks for (optional)<input name="from" type="email" autocomplete="off" placeholder="wordpress@{site}"></label>
      <div class="actions"><button class="btn" type="submit" ${!state.configured || state.sites.length === 0 ? "disabled" : ""}>Queue test email</button></div>
    </form>
    <div class="card card-table"><div class="card-header"><div><h2>PHP sites</h2><p class="hint">Edit a site to give it its own From.</p></div></div>
      ${sites ? `<table class="fleet-table smtp-site-table"><thead><tr><th>Site</th><th>From</th><th>Actions</th></tr></thead><tbody>${sites}</tbody></table>` : '<div class="empty">No PHP sites found.</div>'}
    </div>
    <div class="card card-table"><div class="card-header"><div><h2>Sending domain relays</h2><p class="hint">Use a different SMTP account for a domain whose provider does not allow the global credential to send as it.</p></div><button class="btn" type="button" onclick="smtpEditDomain('')">Add domain relay</button></div>
      ${overrides ? `<table class="fleet-table smtp-domain-table"><thead><tr><th>Sending domain</th><th>SMTP host</th><th>Username</th><th>Actions</th></tr></thead><tbody>${overrides}</tbody></table>` : '<div class="empty">All sending domains use the global relay.</div>'}
    </div>
    <dialog id="smtp-site-dialog" class="smtp-dialog"><form method="dialog" id="smtp-site-form" onsubmit="smtpSaveSite(event)">
      <h2 id="smtp-site-heading">Site sender</h2><input type="hidden" name="domain">
      <label>From address<input name="sender" required autocomplete="off" oninput="smtpSyncSiteDomains()"></label>
      <p class="hint">${TEMPLATE_HINT}</p>
      <div id="smtp-site-domains" hidden><label>Also allowed domains<textarea name="domains" rows="3" placeholder="news.example.com"></textarea></label>
      <p class="hint">The app's From is used only on the site's own domain or these. Any other From is sent as noreply on the site's domain, with the app's address as Reply-To.</p></div>
      <div class="actions"><button class="btn" type="button" onclick="smtpClearSite()" id="smtp-clear-site">Use default</button><button class="btn" type="button" onclick="this.closest('dialog').close()">Cancel</button><button class="btn btn-primary" type="submit">Save site</button></div>
    </form></dialog>
    <dialog id="smtp-domain-dialog" class="smtp-dialog"><form method="dialog" id="smtp-domain-form" onsubmit="smtpSaveDomain(event)">
      <h2>Sending domain relay</h2><label>Sending domain<input name="domain" required placeholder="example.com"></label>
      <div class="smtp-grid"><label>SMTP hostname<input name="host" required placeholder="mail.example.com"></label><label>Port<input name="port" type="number" min="1" max="65535" required value="587"></label></div>
      <label>Username<input name="username" required></label><label>Password<input name="password" type="password" autocomplete="new-password" required placeholder="New SMTP password"></label>
      <div class="actions"><button class="btn" type="button" onclick="this.closest('dialog').close()">Cancel</button><button class="btn btn-primary" type="submit">Save relay</button></div>
    </form></dialog>`;
}

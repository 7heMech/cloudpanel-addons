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

function modeOptions(mode: string): string {
  return `<option value="force" ${mode === "force" ? "selected" : ""}>Force one address</option><option value="allow" ${mode === "allow" ? "selected" : ""}>Allow site domains</option>`;
}

export function dashboardView(state: SmtpState): string {
  const data = JSON.stringify(state).replaceAll("<", "\\u003c");
  const relay = state.relay;
  const sites = state.sites.map((site) => `<tr>
    <td class="site-cell"><strong>${esc(site.domain)}</strong><span class="hint">${esc(site.user)}</span></td>
    <td data-label="Mode">${site.rule.mode === "force" ? "Force" : "Allow listed"}${site.overridden ? ' <span class="badge">Override</span>' : ""}</td>
    <td data-label="${site.rule.mode === "force" ? "Forced From" : "Fallback From"}" class="wide-cell"><code>${esc(site.senderPreview)}</code>${site.rule.mode === "allow" ? `<span class="hint">Also allowed: ${[site.domain, ...site.rule.domains].map((domain) => `@${esc(domain)}`).concat(site.rule.addresses.map(esc)).join(", ")}</span>` : ""}</td>
    <td data-label="Actions" class="action-cell"><button class="btn" type="button" onclick="smtpEditSite('${site.domain}')">Edit</button></td>
  </tr>`).join("");
  const overrides = Object.entries(state.relayOverrides).map(([domain, item]) => `<tr>
    <td class="site-cell"><strong>${esc(domain)}</strong></td><td data-label="SMTP host">${esc(item.host)}:${item.port}</td><td data-label="Username">${esc(item.username)}</td>
    <td data-label="Actions" class="actions action-cell"><button class="btn" type="button" onclick="smtpEditDomain('${domain}')">Edit</button><button class="btn" type="button" onclick="smtpClearDomain('${domain}')">Remove</button></td>
  </tr>`).join("");
  return `<script type="application/json" id="smtp-state">${data}</script>
    <div class="page-heading"><div><h1>SMTP relay</h1><p>Send WordPress and other PHP mail through Postfix, with a sender policy for each site.</p></div></div>
    <form class="card smtp-form" id="smtp-setup-form" onsubmit="smtpSaveSetup(event)">
      <div class="smtp-status"><div><h2>Relay and default sender</h2><p class="hint">Set the fallback SMTP account and sender rule for every PHP site in one save.</p></div><span class="badge">${relay ? "Configured" : "Setup needed"}</span></div>
      <h3>Global SMTP relay</h3><p class="hint">Used for sending domains without a relay override. Postfix queues messages and retries temporary failures.</p>
      <div class="smtp-grid">
        <label>SMTP hostname<input name="host" required autocomplete="off" placeholder="mail.example.com" value="${esc(relay?.host ?? "")}"></label>
        <label>Port<input name="port" type="number" min="1" max="65535" required value="${relay?.port ?? 587}"></label>
        <label>Username<input name="username" required autocomplete="off" value="${esc(relay?.username ?? "")}"></label>
        <label>Password<input name="password" type="password" ${relay ? "" : "required"} autocomplete="new-password" placeholder="${relay ? "Leave blank to keep saved password" : "SMTP password"}"></label>
      </div><h3>Default sender policy</h3><p class="hint">{domain} is each CloudPanel site's domain. Force replaces the requested From address; allow listed preserves addresses on that site's approved domains.</p>
      <div class="smtp-grid"><label>Mode<select name="mode">${modeOptions(state.defaultRule.mode)}</select></label>
      <label>Sender address or template<input name="sender" required value="${esc(state.defaultRule.sender)}" placeholder="noreply@{domain}"></label></div>
      <div class="actions"><button class="btn btn-primary" type="submit">Save relay and default</button></div>
    </form>
    <form class="card smtp-form" id="smtp-test-form" onsubmit="smtpSendTest(event)">
      <h2>Send a test</h2><p class="hint">Submits directly to Postfix as root using the selected site's configured sender. It does not test PHP mail or that site's sender permissions. A successful result means Postfix queued the message; check the inbox for delivery.</p>
      <div class="smtp-grid"><label>Sender site<select name="domain" required>${state.sites.map((site) => `<option value="${esc(site.domain)}">${esc(site.domain)}</option>`).join("")}</select></label>
      <label>Recipient<input name="recipient" type="email" required placeholder="you@example.com"></label></div>
      <div class="actions"><button class="btn" type="submit" ${!state.configured || state.sites.length === 0 ? "disabled" : ""}>Queue test email</button></div>
    </form>
    <div class="card card-table"><div class="card-header"><div><h2>PHP sites</h2><p class="hint">Edit a site to add sending domains or use a different address.</p></div></div>
      ${sites ? `<table class="fleet-table smtp-site-table"><thead><tr><th>Site</th><th>Mode</th><th>From policy</th><th>Actions</th></tr></thead><tbody>${sites}</tbody></table>` : '<div class="empty">No PHP sites found.</div>'}
    </div>
    <div class="card card-table"><div class="card-header"><div><h2>Sending domain relays</h2><p class="hint">Use a different SMTP account for a domain whose provider does not allow the global credential to send as it.</p></div><button class="btn" type="button" onclick="smtpEditDomain('')">Add domain relay</button></div>
      ${overrides ? `<table class="fleet-table smtp-domain-table"><thead><tr><th>Sending domain</th><th>SMTP host</th><th>Username</th><th>Actions</th></tr></thead><tbody>${overrides}</tbody></table>` : '<div class="empty">All sending domains use the global relay.</div>'}
    </div>
    <dialog id="smtp-site-dialog" class="smtp-dialog"><form method="dialog" id="smtp-site-form" onsubmit="smtpSaveSite(event)">
      <h2 id="smtp-site-heading">Site sender</h2><input type="hidden" name="domain">
      <label>Mode<select name="mode" onchange="smtpSyncSiteMode()">${modeOptions("force")}</select></label>
      <label>Sender address or template<input name="sender" required></label>
      <div id="smtp-site-allow-fields" hidden><label>Additional allowed domains<textarea name="domains" rows="3" placeholder="news.example.com"></textarea></label>
      <label>Additional exact addresses<textarea name="addresses" rows="3" placeholder="billing@example.com"></textarea></label>
      <p class="hint">The site's own domain is always allowed. Switching to Force clears these additional grants.</p></div>
      <div class="actions"><button class="btn" type="button" onclick="smtpClearSite()" id="smtp-clear-site">Use default</button><button class="btn" type="button" onclick="this.closest('dialog').close()">Cancel</button><button class="btn btn-primary" type="submit">Save site</button></div>
    </form></dialog>
    <dialog id="smtp-domain-dialog" class="smtp-dialog"><form method="dialog" id="smtp-domain-form" onsubmit="smtpSaveDomain(event)">
      <h2>Sending domain relay</h2><label>Sending domain<input name="domain" required placeholder="example.com"></label>
      <div class="smtp-grid"><label>SMTP hostname<input name="host" required placeholder="mail.example.com"></label><label>Port<input name="port" type="number" min="1" max="65535" required value="587"></label></div>
      <label>Username<input name="username" required></label><label>Password<input name="password" type="password" autocomplete="new-password" required placeholder="New SMTP password"></label>
      <div class="actions"><button class="btn" type="button" onclick="this.closest('dialog').close()">Cancel</button><button class="btn btn-primary" type="submit">Save relay</button></div>
    </form></dialog>`;
}

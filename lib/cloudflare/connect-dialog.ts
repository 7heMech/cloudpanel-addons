/**
 * Shared Connect Cloudflare modal and token-permission view helpers used by
 * DNS, Redirects and Firewall pages.
 */
import { esc } from "../app-http";
import type { AccessView } from "./access";
import type { TokenTemplates } from "./tokens";

export interface CloudflareDialogOptions {
  /** Prefix for DOM element IDs (e.g. "dns", "redir-cf" or "fw-cf"). */
  prefix: string;
  /** Form onsubmit handler expression. */
  onSubmit: string;
  /** Copy button onclick expression (passed elementId, label). */
  copyFn: string;
  /** Initial state of the DNS scope checkbox. */
  defaultDns: boolean;
  /** Initial state of the Redirects scope checkbox. */
  defaultRedirects?: boolean;
  /** Initial state of the Panel gate scope checkbox. */
  defaultPanelGate: boolean;
  /** Prefilled templates for each combination of scopes. */
  templates: TokenTemplates;
  /** Clipboard SVG markup. */
  clipboardIcon: string;
}

function templateKey(dns: boolean, redirects: boolean, panelGate: boolean): keyof TokenTemplates {
  if (dns && redirects && panelGate) return "all";
  if (dns && redirects) return "dnsRedirects";
  if (dns && panelGate) return "both";
  if (redirects && panelGate) return "redirectsPanelGate";
  if (panelGate) return "panelGate";
  if (redirects) return "redirects";
  return "dns";
}

const heldBadge = (row: AccessView["rows"][number]): string => {
  if (row.held === "yes") return '<span class="tone-ok">Yes</span>';
  if (row.held === "no") return `<span class="${row.optional ? "hint" : "tone-bad"}">${esc(row.detail ?? "Missing")}</span>`;
  if (row.held === "some") return `<span class="${row.optional ? "hint" : "tone-warn"}">${esc(row.detail ?? "Some zones")}</span>`;
  return '<span class="hint">Unknown</span>';
};

export function cloudflareAccessProblems(access: AccessView): string {
  if (access.note) return esc(access.note);
  const missing = access.rows.filter((row) => !row.optional && (row.held === "no" || row.held === "some")).map((row) => row.label);
  if (!missing.length) return "";
  return `Lacks ${esc(missing.join(", "))}`;
}

/** Expandable table of what a shared Cloudflare token holds. */
export function cloudflareAccessDetailsHtml(id: string, access: AccessView, status: string, prefix = "cf"): string {
  const rowHtml = (row: AccessView["rows"][number]) =>
    `<div class="dns-access-row" role="row"><span class="dns-access-perm" role="cell">${esc(row.label)}</span><span class="dns-access-use hint" role="cell">${esc(row.usedFor)}</span><span class="dns-access-held" role="cell">${heldBadge(row)}</span></div>`;
  const optional = access.rows.filter((row) => row.optional);
  const rows = access.rows.filter((row) => !row.optional).map(rowHtml).join("") + (optional.length
    ? `<div class="dns-access-row dns-access-cols dns-access-section" role="row"><span role="columnheader">Optional</span><span role="columnheader">Enables</span><span></span></div>${optional.map(rowHtml).join("")}`
    : "");
  const problems = cloudflareAccessProblems(access);
  return `<details class="dns-access-details" id="${esc(prefix)}-access-${esc(id)}"><summary><span class="hint">${status} · <span class="dns-access-toggle">Permissions</span></span>${problems ? `<span class="dns-access-problems">${problems}</span>` : ""}</summary>
    <div class="dns-access"><div class="dns-access-grid" role="table" aria-label="Token permissions">
      <div class="dns-access-row dns-access-cols" role="row"><span role="columnheader">Permission</span><span role="columnheader">Used for</span><span role="columnheader">This token</span></div>${rows}</div>
      <p class="dns-access-foot hint"><a href="${esc(access.editUrl)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">Edit in Cloudflare ↗</a></p></div></details>`;
}

/**
 * Shared Connect Cloudflare `<dialog>` with scope checkboxes so an operator
 * can mint one token covering DNS, Redirects, Firewall's Panel gate, or any
 * combination.
 */
export function cloudflareConnectDialogHtml(options: CloudflareDialogOptions): string {
  const p = esc(options.prefix);
  const defaultRedirects = options.defaultRedirects === true;
  const initial = options.templates[templateKey(options.defaultDns, defaultRedirects, options.defaultPanelGate)] ?? options.templates.dns;
  const templatesAttr = esc(JSON.stringify(options.templates));
  return `<dialog id="${p}-connection-dialog" aria-labelledby="${p}-connection-heading" data-cf-templates="${templatesAttr}"><form id="${p}-connection-form" onsubmit="${options.onSubmit}">
    <div class="dialog-header"><h2 id="${p}-connection-heading">Connect Cloudflare</h2></div>
    <input type="hidden" name="id">
    <ol class="dns-steps">
      <li id="${p}-token-step"><strong>Create a token in Cloudflare</strong>
        <div class="cf-scope-picks" role="group" aria-label="Token scopes">
          <label class="cf-scope-pick"><input type="checkbox" id="${p}-scope-dns" data-cf-scope="dns" ${options.defaultDns ? "checked" : ""} onchange="cfSyncScope('${p}', this)"><span>DNS records and zones</span></label>
          <label class="cf-scope-pick"><input type="checkbox" id="${p}-scope-redirects" data-cf-scope="redirects" ${defaultRedirects ? "checked" : ""} onchange="cfSyncScope('${p}', this)"><span>Redirect domains (Single Redirect rules)</span></label>
          <label class="cf-scope-pick"><input type="checkbox" id="${p}-scope-gate" data-cf-scope="panelGate" ${options.defaultPanelGate ? "checked" : ""} onchange="cfSyncScope('${p}', this)"><span>Panel gate (Cloudflare Access and origin pulls)</span></label>
        </div>
        <p class="hint">Check these permissions: <span id="${p}-token-permissions">${esc(initial.permissions.join(", "))}</span>. Choose the accounts and zones there; All zones also covers zones you add later.</p>
        <div id="${p}-token-ips-hint" hidden><p class="hint">Under Client IP Address Filtering, allow only this server:</p>
          <div class="dns-copy"><code id="${p}-token-ips"></code><button class="dns-clip" type="button" title="Copy" aria-label="Copy the addresses" onclick="${options.copyFn}('${p}-token-ips', 'Addresses')">${options.clipboardIcon}</button></div></div>
        <a class="btn" id="${p}-token-link" href="${esc(initial.url)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">Create token in Cloudflare ↗</a></li>
      <li><strong>Paste it here</strong>
        <div class="form-grid dns-token-grid">
          <div class="form-field"><label for="${p}-connection-token">API token</label>
            <input id="${p}-connection-token" name="token" type="password" autocomplete="new-password" spellcheck="false"></div>
          <div class="form-field"><label for="${p}-connection-label">Name</label>
            <input id="${p}-connection-label" name="label" maxlength="40" autocomplete="off" placeholder="The account names">
            <div class="hint">Optional.</div></div>
        </div></li>
    </ol>
    <div class="alert" role="alert" data-error hidden></div>
    <div class="actions dialog-actions"><button class="btn" type="button" onclick="this.closest('dialog').close()">Cancel</button><button class="btn btn-primary" type="submit">Connect</button></div>
  </form></dialog>`;
}

/** Tiny shared helper embedded by pages that render `cloudflareConnectDialogHtml`. */
export const CLOUDFLARE_SCOPE_JS = `
function cfSyncScope(prefix, changed) {
  var dialog = CLP_ROOT.getElementById(prefix + '-connection-dialog');
  if (!dialog) return;
  var dnsBox = CLP_ROOT.getElementById(prefix + '-scope-dns');
  var redirBox = CLP_ROOT.getElementById(prefix + '-scope-redirects');
  var gateBox = CLP_ROOT.getElementById(prefix + '-scope-gate');
  var dns = Boolean(dnsBox && dnsBox.checked);
  var redir = Boolean(redirBox && redirBox.checked);
  var gate = Boolean(gateBox && gateBox.checked);
  if (!dns && !redir && !gate && changed) {
    changed.checked = true;
    dns = Boolean(dnsBox && dnsBox.checked);
    redir = Boolean(redirBox && redirBox.checked);
    gate = Boolean(gateBox && gateBox.checked);
  }
  var templates;
  try { templates = JSON.parse(dialog.dataset.cfTemplates || '{}'); } catch (e) { return; }
  var key = dns && redir && gate ? 'all'
    : dns && redir ? 'dnsRedirects'
    : dns && gate ? 'both'
    : redir && gate ? 'redirectsPanelGate'
    : gate ? 'panelGate'
    : redir ? 'redirects'
    : 'dns';
  var chosen = templates[key] || templates.dns;
  if (!chosen) return;
  var perms = CLP_ROOT.getElementById(prefix + '-token-permissions');
  var link = CLP_ROOT.getElementById(prefix + '-token-link');
  if (perms) perms.textContent = (chosen.permissions || []).join(', ');
  if (link) link.href = chosen.url || '';
}
`;

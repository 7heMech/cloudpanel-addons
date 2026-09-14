import { esc, escJs } from "../../../lib/app-http";
import { renderLayout } from "../../../lib/app-ui";
import { mountPath } from "../../../lib/mount";
import type { MaintenanceSiteView, MaintenanceTemplateView } from "./service";

const BASE = mountPath("maintenance");

const STYLE = `
.maintenance-summary { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
.maintenance-summary h1 { margin:0; overflow-wrap:anywhere; }
.maintenance-summary .badge { margin-left:auto; }
.state-live { color:var(--ok); border-color:var(--ok); }
.state-maintenance { color:var(--bad); border-color:var(--bad); }
.state-unavailable { color:var(--muted); }
.site-back { display:inline-block; margin-bottom:18px; }
.switch-row { display:flex; align-items:center; justify-content:space-between; gap:20px; }
.switch { position:relative; display:inline-flex; width:50px; height:28px; flex:none; }
.switch input { position:absolute; opacity:0; }
.switch span { width:100%; border-radius:99px; background:var(--border); cursor:pointer; transition:.15s; }
.switch span::after { content:""; display:block; width:22px; height:22px; margin:3px; border-radius:50%; background:#fff; box-shadow:0 1px 4px rgba(0,0,0,.25); transition:.15s; }
.switch input:checked + span { background:var(--bad); }
.switch input:checked + span::after { transform:translateX(22px); }
.editor-tabs { display:flex; gap:8px; margin-bottom:12px; }
.editor-tabs button[aria-selected="true"] { color:var(--accent); border-color:var(--accent); }
#template-editor { width:100%; min-height:420px; resize:vertical; font:13px/1.55 var(--mono); tab-size:2; }
#template-preview { width:100%; min-height:420px; border:1px solid var(--border); border-radius:8px; background:#fff; }
.template-mode { display:flex; align-items:center; gap:10px; margin-bottom:18px; }
.bypass-grid { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:10px; align-items:end; }
.bypass-grid textarea { min-height:110px; resize:vertical; }
.fleet-site { font-weight:600; }
.fleet-site a { overflow-wrap:anywhere; }
@media (max-width:700px) {
  .maintenance-summary .badge { margin-left:0; }
  .bypass-grid { grid-template-columns:1fr; }
}
`;

export const CLIENT_JS = `
let maintenancePreviewUrl = '';

function siteEndpoint(domain, suffix) {
  return '/api/sites/' + encodeURIComponent(domain) + suffix;
}

function paintStatus(domain, enabled) {
  document.querySelectorAll('[data-status-domain="' + CSS.escape(domain) + '"]').forEach(function (node) {
    node.textContent = enabled ? 'Maintenance Mode (503)' : 'Live';
    node.className = 'badge ' + (enabled ? 'state-maintenance' : 'state-live');
  });
  document.querySelectorAll('[data-toggle-domain="' + CSS.escape(domain) + '"]').forEach(function (node) {
    node.checked = enabled;
  });
}

async function toggleMaintenance(domain, enabled) {
  busy(true);
  try {
    const reply = await call(siteEndpoint(domain, '/toggle'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: enabled })
    });
    paintStatus(domain, reply.data.enabled);
  } catch (error) {
    paintStatus(domain, !enabled);
    alert('Could not change maintenance mode: ' + error.message);
  } finally { busy(false); }
}

function showEditorTab(tab) {
  const editor = document.getElementById('template-editor');
  const preview = document.getElementById('template-preview');
  if (!editor || !preview) return;
  const showingPreview = tab === 'preview';
  editor.hidden = showingPreview;
  preview.hidden = !showingPreview;
  document.querySelectorAll('[data-editor-tab]').forEach(function (button) {
    button.setAttribute('aria-selected', String(button.getAttribute('data-editor-tab') === tab));
  });
  if (showingPreview) updateTemplatePreview();
}

function updateTemplatePreview() {
  const editor = document.getElementById('template-editor');
  const preview = document.getElementById('template-preview');
  if (!editor || !preview) return;
  if (maintenancePreviewUrl) URL.revokeObjectURL(maintenancePreviewUrl);
  maintenancePreviewUrl = URL.createObjectURL(new Blob([editor.value], { type: 'text/html' }));
  preview.src = maintenancePreviewUrl;
}

function setTemplateMode(custom) {
  const editor = document.getElementById('template-editor');
  const save = document.getElementById('save-template');
  if (editor) editor.disabled = !custom;
  if (save) save.disabled = !custom;
}

function changeTemplateMode(domain, custom) {
  if (custom) { setTemplateMode(true); return; }
  const checkbox = document.getElementById('custom-template');
  if (!confirm('Use the default maintenance page and remove this custom template?')) {
    if (checkbox) checkbox.checked = true;
    return;
  }
  resetTemplate(domain, true);
}

async function saveTemplate(domain) {
  const editor = document.getElementById('template-editor');
  if (!editor) return;
  busy(true);
  try {
    const reply = await call(siteEndpoint(domain, '/template'), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ html: editor.value })
    });
    editor.value = reply.data.html;
    updateTemplatePreview();
    alert('Custom maintenance page saved.');
  } catch (error) { alert('Could not save the template: ' + error.message); }
  finally { busy(false); setTemplateMode(true); }
}

async function resetTemplate(domain, confirmed) {
  if (!confirmed && !confirm('Reset this site to the default maintenance page?')) return;
  busy(true);
  try {
    const reply = await call(siteEndpoint(domain, '/template'), { method: 'DELETE' });
    const editor = document.getElementById('template-editor');
    const custom = document.getElementById('custom-template');
    if (editor) editor.value = reply.data.html;
    if (custom) custom.checked = false;
    setTemplateMode(false);
    updateTemplatePreview();
  } catch (error) {
    const custom = document.getElementById('custom-template');
    if (custom) custom.checked = true;
    alert('Could not reset the template: ' + error.message);
  } finally {
    busy(false);
    const custom = document.getElementById('custom-template');
    setTemplateMode(Boolean(custom && custom.checked));
  }
}

async function saveBypasses(domain) {
  const field = document.getElementById('bypass-ips');
  const ips = String(field && field.value || '').split(/[\\n,]+/).map(function (ip) { return ip.trim(); }).filter(Boolean);
  busy(true);
  try {
    const reply = await call(siteEndpoint(domain, '/bypasses'), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ips: ips })
    });
    field.value = reply.data.bypasses.join('\\n');
    alert('IP bypasses saved.');
  } catch (error) { alert('Could not save IP bypasses: ' + error.message); }
  finally { busy(false); }
}

function addCurrentIp(ip) {
  const field = document.getElementById('bypass-ips');
  if (!field || !ip) return;
  const values = field.value.split(/[\\n,]+/).map(function (value) { return value.trim(); }).filter(Boolean);
  if (values.indexOf(ip) === -1) values.push(ip);
  field.value = values.join('\\n');
}

function initMaintenance() {
  const editor = document.getElementById('template-editor');
  if (editor) {
    editor.addEventListener('input', function () {
      const preview = document.getElementById('template-preview');
      if (preview && !preview.hidden) updateTemplatePreview();
    });
    const custom = document.getElementById('custom-template');
    setTemplateMode(Boolean(custom && custom.checked));
  }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initMaintenance);
else initMaintenance();
`;

export function layout(title: string, content: string, updateNotice?: { current: string; latest: string } | null): string {
  return renderLayout(title, content, {
    brand: "Maintenance Mode",
    base: BASE,
    nav: [{ href: `${BASE}/`, label: "Sites" }],
    css: STYLE,
    script: CLIENT_JS,
    updateNotice,
  });
}

function statusBadge(site: MaintenanceSiteView): string {
  if (site.error) {
    return `<span class="badge state-unavailable" data-status-domain="${esc(site.domain)}">Unavailable</span>`;
  }
  const text = site.enabled ? "Maintenance Mode (503)" : "Live";
  const state = site.enabled ? "state-maintenance" : "state-live";
  return `<span class="badge ${state}" data-status-domain="${esc(site.domain)}">${text}</span>`;
}

export function fleetView(sites: MaintenanceSiteView[]): string {
  const available = sites.filter((site) => !site.error);
  const maintenance = available.filter((site) => site.enabled).length;
  const rows = sites.map((site) => `<tr>
    <td class="fleet-site"><a href="${BASE}?domain=${encodeURIComponent(site.domain)}">${esc(site.domain)}</a>${site.error ? `<div class="hint">${esc(site.error)}</div>` : ""}</td>
    <td>${esc(site.type)}</td>
    <td>${statusBadge(site)}</td>
    <td>${site.customTemplate ? "Custom" : "Default"}</td>
    <td>${site.bypasses.length}</td>
    <td class="action-cell"><label class="switch" title="Toggle maintenance mode"><input type="checkbox" data-toggle-domain="${esc(site.domain)}" ${site.enabled ? "checked" : ""} ${site.error ? "disabled" : ""} onchange="toggleMaintenance('${escJs(site.domain)}', this.checked)"><span></span></label></td>
  </tr>`).join("");
  return `<section class="page-head"><div><h1>Maintenance Mode</h1><p>Switch sites to a 503 maintenance page without reloading Nginx.</p></div></section>
  <section class="stat-grid">
    <article class="stat"><div class="label">CloudPanel sites</div><div class="value">${sites.length}</div></article>
    <article class="stat"><div class="label">In maintenance</div><div class="value">${maintenance}</div></article>
    <article class="stat"><div class="label">Live</div><div class="value">${available.length - maintenance}</div></article>
  </section>
  <article class="card"><div class="card-header"><h2>Sites</h2></div>
  ${sites.length ? `<div class="table-wrap"><table><thead><tr><th>Site</th><th>Type</th><th>Status</th><th>Page</th><th>Bypasses</th><th class="action-cell">Toggle</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="empty">No CloudPanel sites were found.</p>'}
  </article>`;
}

export function siteView(
  site: MaintenanceSiteView,
  template: MaintenanceTemplateView,
  currentIp: string,
): string {
  const settingsUrl = `/site/${encodeURIComponent(site.domain)}/settings`;
  return `<a class="site-back" href="${settingsUrl}">← Back to ${esc(site.domain)}</a>
  <section class="page-head maintenance-summary"><div><h1>${esc(site.domain)}</h1><p>Maintenance mode applies to HTTP and HTTPS traffic for this site.</p></div>${statusBadge(site)}</section>
  <article class="card"><div class="switch-row"><div><h2>Maintenance response</h2><p class="hint">Visitors receive HTTP 503 with a five-minute Retry-After header. ACME certificate challenges and bypassed IPs remain live.</p></div>
    <label class="switch"><input type="checkbox" data-toggle-domain="${esc(site.domain)}" ${site.enabled ? "checked" : ""} onchange="toggleMaintenance('${escJs(site.domain)}', this.checked)"><span></span></label>
  </div></article>
  <article class="card"><div class="card-header"><div><h2>IP bypasses</h2><p class="hint">One IPv4 or IPv6 address per line. Requests from these addresses skip maintenance mode.</p></div></div>
    <div class="bypass-grid"><label>Allowed IP addresses<textarea id="bypass-ips" spellcheck="false">${esc(site.bypasses.join("\n"))}</textarea></label>
      <div class="actions">${currentIp ? `<button class="btn" type="button" onclick="addCurrentIp('${escJs(currentIp)}')">Add my IP (${esc(currentIp)})</button>` : ""}<button class="btn btn-primary" type="button" onclick="saveBypasses('${escJs(site.domain)}')">Save bypasses</button></div></div>
  </article>
  <article class="card"><div class="card-header"><div><h2>Maintenance page</h2><p class="hint">Custom HTML and CSS are stored for this site. Active scripts and form controls are removed.</p></div></div>
    <label class="template-mode"><input id="custom-template" type="checkbox" ${template.custom ? "checked" : ""} onchange="changeTemplateMode('${escJs(site.domain)}', this.checked)"> Use a custom template</label>
    <div class="editor-tabs" role="tablist"><button class="btn" type="button" data-editor-tab="editor" aria-selected="true" onclick="showEditorTab('editor')">HTML / CSS</button><button class="btn" type="button" data-editor-tab="preview" aria-selected="false" onclick="showEditorTab('preview')">Preview</button></div>
    <textarea id="template-editor" aria-label="Maintenance page HTML" spellcheck="false">${esc(template.html)}</textarea>
    <iframe id="template-preview" title="Maintenance page preview" sandbox hidden></iframe>
    <div class="form-actions"><button class="btn btn-danger" type="button" onclick="resetTemplate('${escJs(site.domain)}', false)">Reset to default</button><button class="btn btn-primary" id="save-template" type="button" onclick="saveTemplate('${escJs(site.domain)}')">Save template</button></div>
  </article>`;
}

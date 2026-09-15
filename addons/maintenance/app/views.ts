import { esc, escJs } from "../../../lib/app-http";
import { renderFragment, renderLayout } from "../../../lib/app-ui";
import type { EmbedFragment } from "../../../lib/shadow-embed";
import { mountPath } from "../../../lib/mount";
import { siteTypeLabel, type SiteContext } from "../../../lib/site-context";
import type { MaintenanceSiteView, MaintenanceTemplateView } from "./service";

const BASE = mountPath("maintenance");

// Switches, toolbars, the confirmation dialog and the inline notice are in
// lib/app-ui; only what this addon alone draws is here.
const STYLE = `
/* Shrinkable, so the badge and the button wrap rather than overflow a phone. */
.page-heading .actions { align-items:center; }
.state-live { color:var(--ok); border-color:var(--ok); }
.state-maintenance { color:var(--bad); border-color:var(--bad); }
.state-unavailable { color:var(--muted); }
.editor-toolbar { margin-bottom:12px; }
.editor-tabs { display:flex; gap:8px; }
.editor-tabs button[aria-selected="true"] { color:var(--accent); border-color:var(--accent); }
#template-editor { width:100%; min-height:420px; resize:vertical; font:13px/1.55 var(--mono); tab-size:2; }
#template-preview { width:100%; min-height:420px; border:1px solid var(--border); border-radius:8px; background:#fff; }
#template-ace { width:100%; min-height:420px; border:1px solid var(--border); border-radius:4px; }
#template-ace.is-readonly { opacity:.6; }
/* The panel ships only Ace's light theme, so dark mode tints it rather than ask
   for a theme file that is not there. The template is edited in text mode, so
   there is no syntax colouring to preserve. */
html.dark #template-ace,
html.dark #template-ace .ace_scroller,
html.dark #template-ace .ace_content { background:var(--input-bg); color:var(--text); }
html.dark #template-ace .ace_gutter { background:var(--surface); color:var(--muted); }
html.dark #template-ace .ace_gutter-active-line { background:#ffffff14; }
html.dark #template-ace .ace_cursor { color:var(--text); }
html.dark #template-ace .ace_marker-layer .ace_active-line { background:#ffffff0d; }
html.dark #template-ace .ace_marker-layer .ace_selection { background:#2f5b8c; }
/* Ace's light theme colours its tokens for a white page; on the tinted
   background they would be navy on near-black. */
html.dark #template-ace .ace_tag,
html.dark #template-ace .ace_tag-name,
html.dark #template-ace .ace_meta.ace_tag,
html.dark #template-ace .ace_doctype,
html.dark #template-ace .ace_xml-pe { color:#6cb6ff; }
html.dark #template-ace .ace_attribute-name,
html.dark #template-ace .ace_support,
html.dark #template-ace .ace_fonts,
html.dark #template-ace .ace_keyword { color:#e5bc76; }
html.dark #template-ace .ace_string,
html.dark #template-ace .ace_attribute-value { color:#81c9a0; }
html.dark #template-ace .ace_constant,
html.dark #template-ace .ace_numeric,
html.dark #template-ace .ace_entity { color:#d9a9ff; }
html.dark #template-ace .ace_comment { color:#93a1ad; }
.bypass-grid { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:16px; align-items:end; }
.bypass-field { min-width:0; margin:0; }
.bypass-field span, .bypass-field textarea { display:block; }
.bypass-field span { margin-bottom:7px; }
.bypass-field textarea { min-height:110px; resize:vertical; font-family:var(--mono); }
.bypass-actions { justify-content:flex-end; }
.fleet-site { font-weight:600; }
.fleet-site a { overflow-wrap:anywhere; }
.global-card { display:flex; justify-content:space-between; align-items:flex-start; gap:24px; }
.global-card h2 { margin:0 0 8px; }
.global-card p { margin:0; }
@media (max-width:700px) {
  .bypass-grid { grid-template-columns:1fr; }
  .bypass-actions { justify-content:flex-start; }
  .global-card { flex-direction:column; }
}
`;

export const CLIENT_JS = `
let maintenancePreviewUrl = '';

// CloudPanel ships Ace and edits vhosts with it, so the maintenance template is
// edited by the same editor rather than by one bundled here. The textarea stays
// the source of truth and stays the editor when the script is not there, which
// is also what happens if a panel release stops shipping it.
let templateAce = null;
// What the server last confirmed. Editing is a local mode, so this is the only
// way to tell an untouched template from an edited one.
let templateSaved = '';

function templateArea() { return CLP_ROOT.getElementById('template-editor'); }
function templateToggle() { return CLP_ROOT.getElementById('edit-template'); }

function templateValue() {
  const area = templateArea();
  return area ? area.value : '';
}

function setTemplateValue(html) {
  const area = templateArea();
  if (area) area.value = html;
  if (templateAce && templateAce.getValue() !== html) templateAce.setValue(html, -1);
}

function setTemplateHidden(hidden) {
  const area = templateArea();
  const holder = CLP_ROOT.getElementById('template-ace');
  if (area) area.hidden = hidden || Boolean(templateAce);
  if (holder) holder.hidden = hidden || !templateAce;
  if (templateAce && !hidden) templateAce.resize();
}

function setTemplateEditable(editable) {
  const area = templateArea();
  if (area) area.disabled = !editable;
  const holder = CLP_ROOT.getElementById('template-ace');
  if (holder) holder.classList.toggle('is-readonly', !editable);
  if (templateAce) templateAce.setReadOnly(!editable);
}

function loadPanelAce() {
  if (window.ace) return Promise.resolve(window.ace);
  if (!window.clpAceLoading) {
    window.clpAceLoading = new Promise(function (resolve) {
      const script = document.createElement('script');
      script.src = '/assets/js/ace.min.js';
      script.onload = function () { resolve(window.ace || null); };
      script.onerror = function () { resolve(null); };
      document.head.appendChild(script);
    });
  }
  return window.clpAceLoading;
}

async function setupTemplateEditor() {
  const area = templateArea();
  const holder = CLP_ROOT.getElementById('template-ace');
  if (!area || !holder) return;
  const ace = await loadPanelAce();
  if (!ace) return;
  templateAce = ace.edit(holder);
  // Text first, so a mode that will not load leaves a working editor rather
  // than none. The panel ships the Ace core but no modes, so the HTML mode is
  // served from here, pinned to the version the panel serves.
  templateAce.session.setMode('ace/mode/text');
  try {
    ace.config.setModuleUrl('ace/mode/html', CLP_BASE + '/ace/mode-html.js');
    templateAce.session.setMode('ace/mode/html');
  } catch (error) { /* the template stays readable without colour */ }
  templateAce.setOptions({ minLines: 24, maxLines: Infinity, showPrintMargin: false, useWorker: false });
  templateAce.setAutoScrollEditorIntoView(true);
  templateAce.setValue(area.value, -1);
  templateAce.session.on('change', function () {
    area.value = templateAce.getValue();
    const preview = CLP_ROOT.getElementById('template-preview');
    if (preview && !preview.hidden) updateTemplatePreview();
  });
  // Ace writes its stylesheet into the document head, which a shadow root
  // cannot see, so the editor inside one needs its own copy.
  if (CLP_ROOT !== document) {
    document.querySelectorAll('style[id^="ace"]').forEach(function (style) {
      if (!CLP_ROOT.getElementById(style.id)) CLP_ROOT.appendChild(style.cloneNode(true));
    });
  }
  const editing = templateToggle();
  setTemplateHidden(false);
  setTemplateEditable(Boolean(editing && editing.checked));
}

function siteEndpoint(domain, suffix) {
  return '/api/sites/' + encodeURIComponent(domain) + suffix;
}

function updateStats(inMaintenance, live) {
  CLP_ROOT.querySelectorAll('.card.stats .stat').forEach(function (stat) {
    const label = stat.querySelector('.label');
    const value = stat.querySelector('.value');
    if (!label || !value) return;
    const text = label.textContent.trim();
    if (text === 'In maintenance') value.textContent = String(inMaintenance);
    if (text === 'Live') value.textContent = String(live);
  });
}

function isGlobalActive() {
  const el = CLP_ROOT.querySelector('[data-global-maintenance]');
  if (el) return el.dataset.globalMaintenance === 'true';
  const global = CLP_ROOT.getElementById('global-toggle');
  return global ? global.checked : false;
}

function paintGlobalState(globalActive) {
  CLP_ROOT.querySelectorAll('[data-global-maintenance]').forEach(function (el) {
    el.dataset.globalMaintenance = String(globalActive);
  });
  const global = CLP_ROOT.getElementById('global-toggle');
  if (global) global.checked = globalActive;
  const state = CLP_ROOT.getElementById('global-state');
  if (state) state.textContent = globalActive ? 'On' : 'Off';
}

function syncGlobalUI(globalActive) {
  paintGlobalState(globalActive);

  // Every row, not only the readable ones: the override covers a site whose
  // saved setting could not be read just as it covers the rest.
  const rows = Array.from(CLP_ROOT.querySelectorAll('input[data-toggle-domain]'));
  let readableCount = 0;
  let siteEnabledCount = 0;

  rows.forEach(function (input) {
    const domain = input.dataset.toggleDomain;
    const readable = input.dataset.available === 'true';
    if (readable) readableCount++;
    const isSiteEnabled = readable && input.checked;
    if (isSiteEnabled) siteEnabledCount++;

    const badge = CLP_ROOT.querySelector('[data-status-domain="' + CSS.escape(domain) + '"]');
    if (!badge) return;

    if (isSiteEnabled) {
      badge.className = 'badge state-maintenance';
      badge.textContent = 'Maintenance Mode (503)';
    } else if (globalActive) {
      badge.className = 'badge state-maintenance';
      badge.textContent = 'Maintenance (Global)';
    } else if (!readable) {
      badge.className = 'badge state-unavailable';
      badge.textContent = 'Unavailable';
    } else {
      badge.className = 'badge state-live';
      badge.textContent = 'Live';
    }
  });

  const maintenanceCount = globalActive ? rows.length : siteEnabledCount;
  const liveCount = globalActive ? 0 : readableCount - siteEnabledCount;
  updateStats(maintenanceCount, liveCount);
}

function paintStatus(domain, siteEnabled) {
  const globalActive = isGlobalActive();
  CLP_ROOT.querySelectorAll('[data-status-domain="' + CSS.escape(domain) + '"]').forEach(function (node) {
    if (siteEnabled) {
      node.textContent = 'Maintenance Mode (503)';
      node.className = 'badge state-maintenance';
    } else if (globalActive) {
      node.textContent = 'Maintenance (Global)';
      node.className = 'badge state-maintenance';
    } else {
      node.textContent = 'Live';
      node.className = 'badge state-live';
    }
  });
  CLP_ROOT.querySelectorAll('[data-toggle-domain="' + CSS.escape(domain) + '"]').forEach(function (node) {
    node.checked = siteEnabled;
  });

  const notice = CLP_ROOT.getElementById('global-notice');
  if (notice) notice.hidden = !(globalActive && !siteEnabled);

  const available = Array.from(CLP_ROOT.querySelectorAll('input[data-toggle-domain][data-available="true"]'));
  if (available.length > 0) {
    const siteEnabledCount = available.filter(function (i) { return i.checked; }).length;
    const maintenanceCount = globalActive ? available.length : siteEnabledCount;
    const liveCount = globalActive ? 0 : available.length - siteEnabledCount;
    updateStats(maintenanceCount, liveCount);
  }
}

async function toggleMaintenance(domain, enabled) {
  clearNotice();
  busy(true);
  try {
    const reply = await call(siteEndpoint(domain, '/toggle'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: enabled })
    });
    paintStatus(domain, reply.data.enabled);
    if (isGlobalActive() && !reply.data.enabled) {
      notify('Saved. ' + domain + ' stays in maintenance while global maintenance is on.', 'warn');
    } else {
      notify(domain + (reply.data.enabled ? ' is now in maintenance mode.' : ' is now live.'), 'ok');
    }
  } catch (error) {
    paintStatus(domain, !enabled);
    notify('Could not change maintenance mode for ' + domain + ': ' + error.message, 'error');
  } finally {
    busy(false);
  }
}

// The global switch is an override, not a bulk edit: it changes what visitors
// get without touching what each site has saved. Say so before it is used.
async function toggleGlobalMaintenance(targetEnabled) {
  const toggle = CLP_ROOT.getElementById('global-toggle');
  // One Nginx flag covers every CloudPanel site, including any whose own
  // status could not be read, so the scope is the whole inventory.
  const all = Array.from(CLP_ROOT.querySelectorAll('input[data-toggle-domain]'));
  const known = all.filter(function (input) { return input.dataset.available === 'true'; });
  const count = all.length;
  const savedOff = known.filter(function (input) { return !input.checked; }).length;
  const unknown = all.length - known.length;
  const details = targetEnabled
    ? ['Every site serves the 503 maintenance page, including the ' + savedOff + ' with maintenance saved off.',
       'Each site keeps its own saved setting and its own maintenance page.']
    : ['Sites with maintenance saved on stay in maintenance.',
       'The other sites go live again.'];
  if (unknown) {
    details.push(unknown === 1
      ? 'The saved setting for 1 site could not be read and is not counted above.'
      : 'The saved settings for ' + unknown + ' sites could not be read and are not counted above.');
  }
  const accepted = await confirmAction({
    title: targetEnabled ? 'Turn on global maintenance?' : 'Turn off global maintenance?',
    text: targetEnabled
      ? 'Global maintenance covers all ' + count + (count === 1 ? ' site' : ' sites') + ' on this panel.'
      : 'Global maintenance stops covering all ' + count + (count === 1 ? ' site' : ' sites') + ' on this panel.',
    details: details,
    confirmLabel: targetEnabled ? 'Turn on' : 'Turn off',
    danger: targetEnabled,
  });
  if (!accepted) {
    if (toggle) toggle.checked = !targetEnabled;
    return;
  }
  clearNotice();
  busy(true);
  try {
    await call('/api/global-toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: targetEnabled })
    });
    syncGlobalUI(targetEnabled);
    notify(targetEnabled ? 'Global maintenance is on.' : 'Global maintenance is off.', 'ok');
  } catch (error) {
    if (toggle) toggle.checked = !targetEnabled;
    notify('Could not change global maintenance mode: ' + error.message, 'error');
  } finally {
    busy(false);
  }
}

function showEditorTab(tab) {
  const editor = CLP_ROOT.getElementById('template-editor');
  const preview = CLP_ROOT.getElementById('template-preview');
  if (!editor || !preview) return;
  const showingPreview = tab === 'preview';
  setTemplateHidden(showingPreview);
  preview.hidden = !showingPreview;
  CLP_ROOT.querySelectorAll('[data-editor-tab]').forEach(function (button) {
    button.setAttribute('aria-selected', String(button.getAttribute('data-editor-tab') === tab));
  });
  if (showingPreview) updateTemplatePreview();
}

function updateTemplatePreview() {
  const editor = CLP_ROOT.getElementById('template-editor');
  const preview = CLP_ROOT.getElementById('template-preview');
  if (!editor || !preview) return;
  if (maintenancePreviewUrl) URL.revokeObjectURL(maintenancePreviewUrl);
  maintenancePreviewUrl = URL.createObjectURL(new Blob([templateValue()], { type: 'text/html' }));
  preview.src = maintenancePreviewUrl;
}

function setTemplateMode(editing) {
  const save = CLP_ROOT.getElementById('save-template');
  setTemplateEditable(editing);
  if (save) save.disabled = !editing;
}

// Editing is a local mode and nothing else: leaving it never touches what is
// saved. Removing a template is what the reset button is for.
async function changeTemplateMode(domain, editing) {
  if (editing || templateValue() === templateSaved) { setTemplateMode(editing); return; }
  const accepted = await confirmAction({
    title: 'Discard the unsaved changes?',
    text: 'The maintenance page for ' + domain + ' goes back to the version that is saved.',
    confirmLabel: 'Discard',
    danger: true,
  });
  const toggle = templateToggle();
  if (!accepted) {
    if (toggle) toggle.checked = true;
    return;
  }
  setTemplateValue(templateSaved);
  updateTemplatePreview();
  setTemplateMode(false);
}

async function saveTemplate(domain) {
  const editor = CLP_ROOT.getElementById('template-editor');
  if (!editor) return;
  clearNotice();
  busy(true);
  try {
    const reply = await call(siteEndpoint(domain, '/template'), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ html: templateValue() })
    });
    setTemplateValue(reply.data.html);
    templateSaved = reply.data.html;
    updateTemplatePreview();
    notify('Custom maintenance page saved.', 'ok');
  } catch (error) { notify('Could not save the template: ' + error.message, 'error'); }
  finally { busy(false); setTemplateMode(true); }
}

async function resetTemplate(domain, confirmed) {
  if (!confirmed) {
    const accepted = await confirmAction({
      title: 'Reset to the default maintenance page?',
      text: 'The custom template saved for ' + domain + ' is removed and cannot be recovered from here.',
      confirmLabel: 'Reset',
      danger: true,
    });
    if (!accepted) return;
  }
  clearNotice();
  busy(true);
  try {
    const reply = await call(siteEndpoint(domain, '/template'), { method: 'DELETE' });
    const toggle = templateToggle();
    setTemplateValue(reply.data.html);
    templateSaved = reply.data.html;
    if (toggle) toggle.checked = false;
    updateTemplatePreview();
    notify('Reset to the default maintenance page.', 'ok');
  } catch (error) {
    notify('Could not reset the template: ' + error.message, 'error');
  } finally {
    busy(false);
    const toggle = templateToggle();
    setTemplateMode(Boolean(toggle && toggle.checked));
  }
}

async function saveBypasses(domain) {
  const field = CLP_ROOT.getElementById('bypass-ips');
  const ips = String(field && field.value || '').split(/[\\n,]+/).map(function (ip) { return ip.trim(); }).filter(Boolean);
  clearNotice();
  busy(true);
  try {
    const reply = await call(siteEndpoint(domain, '/bypasses'), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ips: ips })
    });
    field.value = reply.data.bypasses.join('\\n');
    notify('IP bypasses saved.', 'ok');
  } catch (error) { notify('Could not save IP bypasses: ' + error.message, 'error'); }
  finally { busy(false); }
}

function addCurrentIp(ip) {
  const field = CLP_ROOT.getElementById('bypass-ips');
  if (!field || !ip) return;
  const values = field.value.split(/[\\n,]+/).map(function (value) { return value.trim(); }).filter(Boolean);
  if (values.indexOf(ip) === -1) values.push(ip);
  field.value = values.join('\\n');
}

function initMaintenance() {
  const editor = templateArea();
  if (editor) {
    editor.addEventListener('input', function () {
      const preview = CLP_ROOT.getElementById('template-preview');
      if (preview && !preview.hidden) updateTemplatePreview();
    });
    templateSaved = editor.value;
    const editing = templateToggle();
    setTemplateMode(Boolean(editing && editing.checked));
    setupTemplateEditor();
  }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initMaintenance);
else initMaintenance();
`;

export function layout(
  title: string,
  content: string,
  updateNotice?: { current: string; latest: string } | null,
  site?: SiteContext,
): string {
  return renderLayout(title, content, {
    brand: "Maintenance Mode",
    base: BASE,
    // No tab strip: this addon has one page of its own, so the strip could only
    // hold a tab for the page already being read. A site-scoped page draws
    // CloudPanel's own site tabs, which come from the site context below.
    nav: [],
    css: STYLE,
    script: CLIENT_JS,
    updateNotice,
    ...(site ? { site: { ...site, activeSlug: "maintenance" } } : {}),
  });
}

/**
 * The same page as `layout`, as a fragment for mounting inside CloudPanel's own
 * site page. No site context: the panel is already drawing it.
 */
export function fragment(title: string, content: string): EmbedFragment {
  return renderFragment(title, content, {
    brand: "Maintenance Mode",
    base: BASE,
    nav: [],
    css: STYLE,
    script: CLIENT_JS,
  });
}

function statusBadge(site: MaintenanceSiteView, globalEnabled = false): string {
  // A site whose saved setting could not be read is still behind the global
  // override, which Nginx serves from one file for every site. Unavailable is
  // what is unknown about the site, not what its visitors are getting.
  if (site.error && !globalEnabled) {
    return `<span class="badge state-unavailable" data-status-domain="${esc(site.domain)}">Unavailable</span>`;
  }
  if (site.enabled && !site.error) {
    return `<span class="badge state-maintenance" data-status-domain="${esc(site.domain)}">Maintenance Mode (503)</span>`;
  }
  if (globalEnabled) {
    return `<span class="badge state-maintenance" data-status-domain="${esc(site.domain)}">Maintenance (Global)</span>`;
  }
  return `<span class="badge state-live" data-status-domain="${esc(site.domain)}">Live</span>`;
}

/**
 * The global override, in a card of its own.
 *
 * It sat in the sites table header labelled "All sites", where it read as a
 * bulk edit of the switches below it. It is not one: it decides what visitors
 * get while every site keeps the setting it has saved.
 */
function globalCard(globalEnabled: boolean, disabled: boolean): string {
  return `<div class="card global-card" data-global-maintenance="${globalEnabled}">
    <div>
      <h2>Global maintenance</h2>
      <p>Serve the maintenance page for every site at once, whatever each site has saved.</p>
      <p class="hint">Saved per-site settings are left alone. Turning this off returns each site to its own setting.</p>
    </div>
    <label class="switch-field" for="global-toggle"><span class="switch-state" id="global-state">${globalEnabled ? "On" : "Off"}</span>
      <span class="switch switch-danger"><input type="checkbox" id="global-toggle" ${globalEnabled ? "checked" : ""} ${disabled ? "disabled" : ""} onchange="toggleGlobalMaintenance(this.checked)"><span></span></span>
    </label>
  </div>`;
}

export function fleetView(sites: MaintenanceSiteView[], globalEnabled = false): string {
  const available = sites.filter((site) => !site.error);
  const siteMaintenanceCount = available.filter((site) => site.enabled).length;
  // The override covers the fleet, including the sites this page could not read.
  const inMaintenanceCount = globalEnabled ? sites.length : siteMaintenanceCount;
  const liveCount = globalEnabled ? 0 : available.length - siteMaintenanceCount;
  const rows = sites.map((site) => `<tr>
    <td class="fleet-site"><a href="${BASE}?domain=${encodeURIComponent(site.domain)}">${esc(site.domain)}</a>${site.error ? `<div class="hint">${esc(site.error)}</div>` : ""}</td>
    <td>${esc(siteTypeLabel(site.type))}</td>
    <td>${statusBadge(site, globalEnabled)}</td>
    <td>${site.customTemplate ? "Custom" : "Default"}</td>
    <td>${site.bypasses.length}</td>
    <td class="action-cell"><label class="switch switch-danger"><input type="checkbox" data-toggle-domain="${esc(site.domain)}" data-available="${!site.error}" aria-label="Maintenance mode for ${esc(site.domain)}" ${site.enabled ? "checked" : ""} ${site.error ? "disabled" : ""} onchange="toggleMaintenance('${escJs(site.domain)}', this.checked)"><span></span></label></td>
  </tr>`).join("");
  return `<div class="page-heading" data-global-maintenance="${globalEnabled}"><div><h1>Maintenance Mode</h1><p>Switch sites to a 503 maintenance page without reloading Nginx.</p></div></div>
  <div class="card stats">
    <div class="stat"><div class="label">CloudPanel sites</div><div class="value">${sites.length}</div></div>
    <div class="stat"><div class="label">In maintenance</div><div class="value">${inMaintenanceCount}</div></div>
    <div class="stat"><div class="label">Live</div><div class="value">${liveCount}</div></div>
  </div>
  ${globalCard(globalEnabled, sites.length === 0)}
  <div class="card card-table"><div class="card-header"><h2>Sites</h2></div>
  ${sites.length ? `<table><thead><tr><th scope="col">Site</th><th scope="col">Type</th><th scope="col">Effective status</th><th scope="col">Page</th><th scope="col">Bypasses</th><th scope="col" class="action-cell">Site setting</th></tr></thead><tbody data-global-maintenance="${globalEnabled}">${rows}</tbody></table>` : '<div class="empty">No CloudPanel sites were found.</div>'}
  </div>`;
}

export function siteView(
  site: MaintenanceSiteView,
  template: MaintenanceTemplateView,
  currentIp: string,
  globalEnabled = false,
): string {
  const globalNotice = `<div id="global-notice" class="notice"${globalEnabled && !site.enabled ? "" : " hidden"}>Global maintenance is on, so this site serves the maintenance page even though its own setting below is off. Turning the setting below off does not take this site out of global maintenance.</div>`;
  return `<div class="page-heading" data-global-maintenance="${globalEnabled}"><div><h1>${esc(site.domain)}</h1><p>Maintenance mode applies to HTTP and HTTPS traffic for this site.</p></div>
    <div class="actions">${statusBadge(site, globalEnabled)}<a class="btn" href="${BASE}/">All maintenance sites</a></div></div>
  ${globalNotice}
  <div class="card"><div class="switch-row"><div><h2>Maintenance response</h2><p class="hint">Visitors receive HTTP 503 with a five-minute Retry-After header. ACME certificate challenges and bypassed IPs remain live.</p></div>
    <label class="switch switch-danger"><input type="checkbox" data-toggle-domain="${esc(site.domain)}" data-available="true" aria-label="Maintenance mode for ${esc(site.domain)}" ${site.enabled ? "checked" : ""} onchange="toggleMaintenance('${escJs(site.domain)}', this.checked)"><span></span></label>
  </div></div>
  <div class="card"><div class="card-header"><div><h2>IP bypasses</h2><p class="hint">One IPv4 or IPv6 address per line. Requests from these addresses skip maintenance mode.</p></div></div>
    <div class="bypass-grid"><label class="bypass-field" for="bypass-ips"><span>Allowed IP addresses</span><textarea id="bypass-ips" spellcheck="false">${esc(site.bypasses.join("\n"))}</textarea></label>
      <div class="actions bypass-actions">${currentIp ? `<button class="btn" type="button" onclick="addCurrentIp('${escJs(currentIp)}')">Add my IP (${esc(currentIp)})</button>` : ""}<button class="btn btn-primary" type="button" onclick="saveBypasses('${escJs(site.domain)}')">Save bypasses</button></div></div>
  </div>
  <div class="card"><div class="card-header"><div><h2>Maintenance page</h2><p class="hint">Custom HTML and CSS are stored for this site. Active scripts and form controls are removed.</p></div></div>
    <div class="toolbar editor-toolbar">
      <div class="editor-tabs" role="tablist"><button class="btn" type="button" data-editor-tab="editor" aria-selected="true" onclick="showEditorTab('editor')">HTML / CSS</button><button class="btn" type="button" data-editor-tab="preview" aria-selected="false" onclick="showEditorTab('preview')">Preview</button></div>
      <label class="switch-field toolbar-end" for="edit-template">Edit<span class="switch"><input id="edit-template" type="checkbox" onchange="changeTemplateMode('${escJs(site.domain)}', this.checked)"><span></span></span></label>
    </div>
    <textarea id="template-editor" aria-label="Maintenance page HTML" spellcheck="false">${esc(template.html)}</textarea>
    <div id="template-ace" hidden></div>
    <iframe id="template-preview" title="Maintenance page preview" sandbox hidden></iframe>
    <div class="form-actions"><button class="btn btn-danger" type="button" onclick="resetTemplate('${escJs(site.domain)}', false)">Reset to default</button><button class="btn btn-primary" id="save-template" type="button" onclick="saveTemplate('${escJs(site.domain)}')">Save template</button></div>
  </div>`;
}

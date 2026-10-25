
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
  setTemplateMode(Boolean(editing && editing.checked));
}

function siteEndpoint(domain, suffix) {
  return '/api/sites/' + encodeURIComponent(domain) + suffix;
}

function repaintFleet(reply, done) {
  if (reply.html) {
    repaintView(CLP_ROOT.getElementById('clp-content'), reply.html);
    if (done) notify(done, 'ok');
  } else {
    notify((done ? done + ' ' : '') + 'The page could not be refreshed; reload it to see the change.', 'warn');
  }
}

function onFleetPage() {
  return Boolean(CLP_ROOT.getElementById('maintenance-fleet'));
}

// The site page has one site and an editor whose state a repaint would lose,
// so it paints its badge and notices in place.
function paintSiteStatus(domain, enabled) {
  const heading = CLP_ROOT.querySelector('[data-global-maintenance]');
  const globalActive = Boolean(heading && heading.dataset.globalMaintenance === 'true');
  const uncovered = Boolean(heading && heading.dataset.uncovered === 'true');
  CLP_ROOT.querySelectorAll('[data-status-domain="' + CSS.escape(domain) + '"]').forEach(function (node) {
    const label = uncovered && (enabled || globalActive) ? ['Not covered', 'uncovered']
      : enabled ? ['Maintenance Mode (503)', 'maintenance']
      : globalActive ? ['Maintenance (Global)', 'maintenance'] : ['Live', 'live'];
    node.textContent = label[0];
    node.className = 'badge state-' + label[1];
  });
  CLP_ROOT.querySelectorAll('[data-toggle-domain="' + CSS.escape(domain) + '"]').forEach(function (node) {
    node.checked = enabled;
  });
  const notice = CLP_ROOT.getElementById('global-notice');
  if (notice) notice.hidden = !(globalActive && !enabled && !uncovered);
}

async function toggleMaintenance(domain, enabled) {
  const fleet = onFleetPage();
  clearNotice();
  busy(true);
  try {
    const reply = await call(siteEndpoint(domain, '/toggle'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fleet ? { enabled: enabled, view: 'fleet' } : { enabled: enabled })
    });
    if (fleet) repaintFleet(reply);
    else paintSiteStatus(domain, reply.data.enabled);
  } catch (error) {
    CLP_ROOT.querySelectorAll('[data-toggle-domain="' + CSS.escape(domain) + '"]').forEach(function (node) {
      node.checked = !enabled;
    });
    notify('Could not change maintenance mode for ' + domain + ': ' + error.message, 'error');
  } finally {
    busy(false);
  }
}

function selectedDomains() {
  return selectedRows().map(function (row) { return row.dataset.domain; });
}

// Taking sites offline is confirmed with their names; bringing them back is not.
async function toggleSelected(enabled) {
  const domains = selectedDomains();
  if (!domains.length) return;
  if (enabled) {
    const accepted = await confirmAction({
      title: 'Turn on maintenance for ' + plural(domains.length, 'site') + '?',
      text: 'Visitors to these sites get the 503 maintenance page until it is turned off.',
      details: domains,
      confirmLabel: 'Turn on',
      danger: true,
    });
    if (!accepted) return;
  }
  clearNotice();
  busy(true);
  try {
    const reply = await call('/api/bulk-toggle', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: enabled, domains: domains })
    });
    const failed = reply.data.failed;
    const done = 'Maintenance turned ' + (enabled ? 'on' : 'off') + ' for ' + plural(reply.data.updated.length, 'site') + '.';
    repaintFleet(reply, failed.length ? '' : done);
    if (failed.length) {
      notify(done + ' Not changed: ' + failed.map(function (f) { return f.domain + ' (' + f.error + ')'; }).join(', '), 'error');
    }
  } catch (error) {
    notify('Could not change maintenance mode: ' + error.message, 'error');
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
  const known = all.filter(function (input) { return !input.disabled; });
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
      ? 'Global maintenance covers all ' + plural(count, 'site') + ' on this panel.'
      : 'Global maintenance stops covering all ' + plural(count, 'site') + ' on this panel.',
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
    const reply = await call('/api/global-toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: targetEnabled })
    });
    repaintFleet(reply, targetEnabled ? 'Global maintenance is on.' : 'Global maintenance is off.');
  } catch (error) {
    if (toggle) toggle.checked = !targetEnabled;
    notify('Could not change global maintenance mode: ' + error.message, 'error');
  } finally {
    busy(false);
  }
}

function showEditorTab(tab) {
  const preview = CLP_ROOT.getElementById('template-preview');
  if (!preview) return;
  const showingPreview = tab === 'preview';
  setTemplateHidden(showingPreview);
  preview.hidden = !showingPreview;
  CLP_ROOT.querySelectorAll('[data-editor-tab]').forEach(function (button) {
    button.setAttribute('aria-selected', String(button.getAttribute('data-editor-tab') === tab));
  });
  if (showingPreview) updateTemplatePreview();
}

function updateTemplatePreview() {
  const preview = CLP_ROOT.getElementById('template-preview');
  if (!preview) return;
  if (maintenancePreviewUrl) URL.revokeObjectURL(maintenancePreviewUrl);
  maintenancePreviewUrl = URL.createObjectURL(new Blob([templateValue()], { type: 'text/html' }));
  preview.src = maintenancePreviewUrl;
}

// The page opens on its preview; the Edit switch is the way into the HTML.
function setTemplateMode(editing) {
  const save = CLP_ROOT.getElementById('save-template');
  const tabs = CLP_ROOT.querySelector('.editor-tabs');
  setTemplateEditable(editing);
  if (save) save.disabled = !editing;
  if (tabs) tabs.hidden = !editing;
  showEditorTab(editing ? 'editor' : 'preview');
}

function paintTemplateKind(custom) {
  const kind = CLP_ROOT.getElementById('template-kind');
  if (kind) kind.textContent = custom ? 'Custom' : 'Default';
  const reset = CLP_ROOT.getElementById('reset-template');
  if (reset) reset.hidden = !custom;
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
  setTemplateMode(false);
}

async function saveTemplate(domain) {
  if (!templateArea()) return;
  clearNotice();
  busy(true);
  try {
    const reply = await call(siteEndpoint(domain, '/template'), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ html: templateValue() })
    });
    setTemplateValue(reply.data.html);
    templateSaved = reply.data.html;
    paintTemplateKind(true);
    updateTemplatePreview();
    notify(reply.data.removed ? 'Saved; some tags were removed.' : 'Custom maintenance page saved.', reply.data.removed ? 'warn' : 'ok');
  } catch (error) { notify('Could not save the template: ' + error.message, 'error'); }
  finally { busy(false); setTemplateEditable(true); }
}

async function resetTemplate(domain) {
  const accepted = await confirmAction({
    title: 'Reset to the default maintenance page?',
    text: 'The custom template saved for ' + domain + ' is removed and cannot be recovered from here.',
    confirmLabel: 'Reset',
    danger: true,
  });
  if (!accepted) return;
  clearNotice();
  busy(true);
  try {
    const reply = await call(siteEndpoint(domain, '/template'), { method: 'DELETE' });
    const toggle = templateToggle();
    setTemplateValue(reply.data.html);
    templateSaved = reply.data.html;
    if (toggle) toggle.checked = false;
    paintTemplateKind(false);
    notify('Reset to the default maintenance page.', 'ok');
  } catch (error) {
    notify('Could not reset the template: ' + error.message, 'error');
  } finally {
    busy(false);
    const toggle = templateToggle();
    setTemplateMode(Boolean(toggle && toggle.checked));
  }
}

function bypassList(value) {
  return String(value || '').split(/[\n,]+/).map(function (ip) { return ip.trim(); }).filter(Boolean);
}

// Save stays off until the list differs from what the server last returned.
function syncBypassSave(field) {
  const save = CLP_ROOT.querySelector('[data-bypass-save="' + field.id + '"]');
  if (save) save.disabled = bypassList(field.value).join('\n') === bypassList(field.defaultValue).join('\n');
}

async function saveBypassList(id, endpoint, saved, failed) {
  const field = CLP_ROOT.getElementById(id);
  if (!field) return;
  clearNotice();
  busy(true);
  try {
    const reply = await call(endpoint, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ips: bypassList(field.value) })
    });
    field.value = field.defaultValue = reply.data.bypasses.join('\n');
    const count = CLP_ROOT.getElementById(id + '-count');
    const n = reply.data.bypasses.length;
    const word = id === 'bypass-ips' ? ['bypass', 'bypasses'] : ['address', 'addresses'];
    if (count) count.textContent = n ? n + ' ' + word[n === 1 ? 0 : 1] : 'None';
    notify(saved, 'ok');
  } catch (error) { notify(failed + error.message, 'error'); }
  finally {
    busy(false);
    syncBypassSave(field);
  }
}

function saveBypasses(domain) {
  return saveBypassList('bypass-ips', siteEndpoint(domain, '/bypasses'), 'IP bypasses saved.', 'Could not save IP bypasses: ');
}

function saveGlobalBypasses() {
  return saveBypassList('global-bypass-ips', '/api/global-bypasses', 'Global IP bypasses saved.', 'Could not save global IP bypasses: ');
}

function addCurrentIp(id, ip) {
  const field = CLP_ROOT.getElementById(id);
  if (!field || !ip) return;
  const values = bypassList(field.value);
  if (values.indexOf(ip) === -1) values.push(ip);
  field.value = values.join('\n');
  syncBypassSave(field);
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

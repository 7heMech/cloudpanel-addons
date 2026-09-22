
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

  const rows = Array.from(CLP_ROOT.querySelectorAll('input[data-toggle-domain]'));
  const available = rows.filter(function (i) { return i.dataset.available === 'true'; });
  if (available.length > 0) {
    const siteEnabledCount = available.filter(function (i) { return i.checked; }).length;
    // Every row, as syncGlobalUI counts them: the override covers a site whose
    // saved setting could not be read just as it covers the rest.
    const maintenanceCount = globalActive ? rows.length : siteEnabledCount;
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
  const ips = String(field && field.value || '').split(/[\n,]+/).map(function (ip) { return ip.trim(); }).filter(Boolean);
  clearNotice();
  busy(true);
  try {
    const reply = await call(siteEndpoint(domain, '/bypasses'), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ips: ips })
    });
    field.value = reply.data.bypasses.join('\n');
    notify('IP bypasses saved.', 'ok');
  } catch (error) { notify('Could not save IP bypasses: ' + error.message, 'error'); }
  finally { busy(false); }
}

function addCurrentIp(ip) {
  const field = CLP_ROOT.getElementById('bypass-ips');
  if (!field || !ip) return;
  const values = field.value.split(/[\n,]+/).map(function (value) { return value.trim(); }).filter(Boolean);
  if (values.indexOf(ip) === -1) values.push(ip);
  field.value = values.join('\n');
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

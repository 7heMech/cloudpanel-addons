let dnsState = JSON.parse(CLP_ROOT.getElementById('dns-state')?.textContent || '{}');
let dnsRowsState = [];
let dnsLastField = null;
let dnsReviewToken = '';
let dnsSiteShown = '';

const DNS_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'CAA'];
const DNS_TTLS = [[1, 'Auto'], [60, '1 min'], [120, '2 min'], [300, '5 min'], [600, '10 min'], [900, '15 min'], [1800, '30 min'],
  [3600, '1 hour'], [7200, '2 hours'], [18000, '5 hours'], [43200, '12 hours'], [86400, '1 day']];
const DNS_EXAMPLES = { A: '{ipv4}', AAAA: '{ipv6}', CNAME: 'target.example.com', MX: '{mailcow.host}', TXT: 'v=spf1 mx ~all',
  SRV: '0 443 {mailcow.host}', CAA: '0 issue "letsencrypt.org"' };

function dnsEsc(value) {
  return String(value).replace(/[&<>"']/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; });
}

function dnsProfile(id) {
  return dnsState.profiles.find(function (profile) { return profile.id === id; });
}

function dnsDialogError(dialog, message) {
  let box = dialog.querySelector('.dns-dialog-error');
  if (!box) {
    box = document.createElement('div');
    box.className = 'alert dns-dialog-error';
    box.setAttribute('role', 'alert');
    dialog.querySelector('.dialog-header').after(box);
  }
  box.textContent = message;
  box.scrollIntoView({ block: 'nearest' });
}

function dnsOpen(id) {
  const dialog = CLP_ROOT.getElementById(id);
  dialog.querySelectorAll('.dns-dialog-error').forEach(function (box) { box.remove(); });
  if (!dialog.open) dialog.showModal();
  return dialog;
}

/** Sends a change and repaints from the reply. A review in the reply opens; anything else closes the dialog it came from. */
async function dnsPost(path, body, from) {
  busy(true);
  try {
    const reply = await call(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    if (reply.html) {
      CLP_ROOT.getElementById('dns-root').innerHTML = reply.html;
      dnsState = reply.data;
      dnsPaintSelection();
    }
    if (from) from.close();
    if (reply.data && reply.data.review) dnsShowReview(reply.data.review, reply.data.notice);
    else if (reply.data && reply.data.notice) notify(reply.data.notice, 'ok');
    return reply;
  } catch (error) {
    const open = CLP_ROOT.querySelector('dialog[open]');
    if (open) dnsDialogError(open, error.message);
    else notify(error.message, 'error');
    return null;
  } finally {
    busy(false);
  }
}

// --- profiles ---------------------------------------------------------------

function dnsRowCells(row, index) {
  const proxiable = ['A', 'AAAA', 'CNAME'].indexOf(row.type) >= 0;
  const prioritised = row.type === 'MX' || row.type === 'SRV';
  return '<td data-label="Type" class="dns-type"><select data-field="type" aria-label="Type of record ' + (index + 1) + '">' +
      DNS_TYPES.map(function (type) { return '<option' + (type === row.type ? ' selected' : '') + '>' + type + '</option>'; }).join('') + '</select></td>' +
    '<td data-label="Name" class="dns-name"><input data-field="name" aria-label="Name of record ' + (index + 1) + '" spellcheck="false" autocomplete="off" placeholder="{domain}"></td>' +
    '<td data-label="Content" class="dns-content"><input data-field="content" aria-label="Content of record ' + (index + 1) + '" spellcheck="false" autocomplete="off" placeholder="' + dnsEsc(DNS_EXAMPLES[row.type]) + '"></td>' +
    '<td data-label="Priority" class="dns-priority"><input data-field="priority" type="number" min="0" max="65535" inputmode="numeric" aria-label="Priority of record ' + (index + 1) + '"' + (prioritised ? '' : ' disabled') + '></td>' +
    '<td data-label="TTL" class="dns-ttl"><select data-field="ttl" aria-label="TTL of record ' + (index + 1) + '"' + (row.proxied ? ' disabled' : '') + '>' +
      DNS_TTLS.map(function (ttl) { return '<option value="' + ttl[0] + '"' + (ttl[0] === row.ttl ? ' selected' : '') + '>' + ttl[1] + '</option>'; }).join('') + '</select></td>' +
    '<td data-label="Proxy" class="dns-flag"><label class="switch"><input data-field="proxied" type="checkbox" aria-label="Proxy record ' + (index + 1) + '"' +
      (row.proxied ? ' checked' : '') + (proxiable ? '' : ' disabled') + '><span></span></label></td>' +
    '<td data-label="Apex only" class="dns-flag"><label class="switch"><input data-field="apexOnly" type="checkbox" aria-label="Record ' + (index + 1) + ' only at the zone apex"' +
      (row.apexOnly ? ' checked' : '') + '><span></span></label></td>' +
    '<td class="dns-remove"><button class="btn dns-remove-btn" type="button" aria-label="Remove record ' + (index + 1) + '" onclick="dnsRemoveRow(' + index + ')">×</button></td>';
}

function dnsRenderRows() {
  const body = CLP_ROOT.getElementById('dns-rows');
  body.textContent = '';
  dnsRowsState.forEach(function (row, index) {
    const tr = document.createElement('tr');
    tr.innerHTML = dnsRowCells(row, index);
    tr.querySelector('[data-field="name"]').value = row.name;
    tr.querySelector('[data-field="content"]').value = row.content;
    tr.querySelector('[data-field="priority"]').value = row.priority === null || row.priority === undefined ? '' : row.priority;
    tr.addEventListener('input', function (event) { dnsRowChanged(index, event.target, false); });
    tr.addEventListener('change', function (event) { dnsRowChanged(index, event.target, true); });
    tr.addEventListener('focusin', function (event) { if (event.target.matches('input[type="text"], input:not([type])')) dnsLastField = event.target; });
    body.appendChild(tr);
  });
  CLP_ROOT.getElementById('dns-empty-rows').hidden = dnsRowsState.length > 0;
}

function dnsRowChanged(index, target, settled) {
  const key = target.dataset.field;
  if (!key) return;
  const row = dnsRowsState[index];
  if (target.type === 'checkbox') row[key] = target.checked;
  else if (key === 'ttl') row.ttl = Number(target.value);
  else if (key === 'priority') row.priority = target.value === '' ? null : Number(target.value);
  else row[key] = target.value;
  if (key === 'proxied' && row.proxied) row.ttl = 1;
  if (key === 'type') {
    if (['A', 'AAAA', 'CNAME'].indexOf(row.type) < 0) row.proxied = false;
    if (row.type !== 'MX' && row.type !== 'SRV') row.priority = null;
    else if (row.priority === null) row.priority = row.type === 'MX' ? 10 : 0;
  }
  // Only what changes which fields apply redraws the rows, so typing keeps its focus.
  if (settled && (key === 'type' || key === 'proxied')) dnsRenderRows();
}

function dnsAddRow() {
  dnsRowsState.push({ type: 'A', name: '{domain}', content: '{ipv4}', proxied: true, ttl: 1, priority: null, apexOnly: false });
  dnsRenderRows();
  const rows = CLP_ROOT.querySelectorAll('#dns-rows tr');
  rows[rows.length - 1].querySelector('[data-field="name"]').focus();
}

function dnsRemoveRow(index) {
  dnsRowsState.splice(index, 1);
  dnsRenderRows();
}

function dnsAddPreset(select) {
  const preset = dnsState.presets.find(function (candidate) { return candidate.id === select.value; });
  select.value = '';
  if (!preset) return;
  preset.records.forEach(function (record) { dnsRowsState.push(Object.assign({}, record)); });
  const form = CLP_ROOT.getElementById('dns-profile-form');
  if (preset.mailcow) form.elements.namedItem('mailcow').checked = true;
  const zone = preset.zone || {};
  if (zone.ssl && !form.elements.namedItem('ssl').value) form.elements.namedItem('ssl').value = zone.ssl;
  if (zone.alwaysHttps !== undefined && !form.elements.namedItem('alwaysHttps').value) form.elements.namedItem('alwaysHttps').value = zone.alwaysHttps ? 'on' : 'off';
  if (zone.acmeFullSsl) form.elements.namedItem('acmeFullSsl').checked = true;
  if (zone.webmailFullSsl) form.elements.namedItem('webmailFullSsl').checked = true;
  dnsRenderRows();
  notify('Added the ' + preset.label + ' rows. Edit them as you need.', 'ok');
}

function dnsInsert(token) {
  const field = dnsLastField;
  if (!field || !field.isConnected) return notify('Click into a name or content field first.', 'warn');
  const start = field.selectionStart === null ? field.value.length : field.selectionStart;
  const end = field.selectionEnd === null ? start : field.selectionEnd;
  field.value = field.value.slice(0, start) + token + field.value.slice(end);
  field.focus();
  field.setSelectionRange(start + token.length, start + token.length);
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

function dnsEditProfile(id) {
  const profile = id ? dnsProfile(id) : null;
  const form = CLP_ROOT.getElementById('dns-profile-form');
  form.reset();
  form.elements.namedItem('id').value = profile ? profile.id : '';
  form.elements.namedItem('name').value = profile ? profile.name : '';
  const zone = profile ? profile.zone : { ssl: null, alwaysHttps: null, acmeFullSsl: false, webmailFullSsl: false, skipFirewallIps: [], createIn: null };
  form.elements.namedItem('mailcow').checked = Boolean(profile && profile.mailcow);
  form.elements.namedItem('ssl').value = zone.ssl || '';
  form.elements.namedItem('alwaysHttps').value = zone.alwaysHttps === null ? '' : zone.alwaysHttps ? 'on' : 'off';
  form.elements.namedItem('acmeFullSsl').checked = zone.acmeFullSsl;
  form.elements.namedItem('webmailFullSsl').checked = zone.webmailFullSsl;
  form.elements.namedItem('skipFirewallIps').value = zone.skipFirewallIps.join('\n');
  const createIn = form.elements.namedItem('createIn');
  createIn.innerHTML = '<option value="">Report them</option>' + dnsState.accounts.map(function (account) {
    return '<option value="' + dnsEsc(account.connectionId + '/' + account.accountId) + '">Create in ' + dnsEsc(account.label) + '</option>';
  }).join('');
  createIn.value = zone.createIn ? zone.createIn.connectionId + '/' + zone.createIn.accountId : '';
  CLP_ROOT.getElementById('dns-preset').innerHTML = '<option value="">Add a preset…</option>' + dnsState.presets.map(function (preset) {
    return '<option value="' + dnsEsc(preset.id) + '">' + dnsEsc(preset.label) + '</option>';
  }).join('');
  dnsRowsState = profile ? profile.records.map(function (record) { return Object.assign({}, record); }) : [];
  dnsLastField = null;
  dnsRenderRows();
  CLP_ROOT.getElementById('dns-profile-heading').textContent = profile ? 'Edit ' + profile.name : 'New profile';
  dnsOpen('dns-profile-dialog');
}

function dnsSaveProfile(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const value = function (name) { return form.elements.namedItem(name).value; };
  const createIn = value('createIn').split('/');
  dnsPost('/api/profiles', {
    id: value('id') || null,
    name: value('name'),
    records: dnsRowsState,
    mailcow: form.elements.namedItem('mailcow').checked,
    zone: {
      ssl: value('ssl') || null,
      alwaysHttps: value('alwaysHttps') === '' ? null : value('alwaysHttps') === 'on',
      acmeFullSsl: form.elements.namedItem('acmeFullSsl').checked,
      webmailFullSsl: form.elements.namedItem('webmailFullSsl').checked,
      skipFirewallIps: value('skipFirewallIps').split(/[\s,]+/).filter(Boolean),
      createIn: createIn.length === 2 ? { connectionId: createIn[0], accountId: createIn[1] } : null,
    },
  }, CLP_ROOT.getElementById('dns-profile-dialog'));
}

async function dnsDeleteProfile(id) {
  const profile = dnsProfile(id);
  const accepted = await confirmAction({
    title: 'Delete ' + profile.name + '?',
    text: 'Its sites stop being managed. Nothing in Cloudflare or Mailcow changes.',
    details: profile.sites ? [plural(profile.sites, 'site') + ' will be in no profile.'] : [],
    confirmLabel: 'Delete', danger: true,
  });
  if (accepted) dnsPost('/api/profiles/delete', { id: id });
}

function dnsSetMode(input, id) {
  const mode = input.checked ? 'enforce' : 'report';
  // The switch shows the saved mode until the reply repaints it, after a review if one is needed.
  input.checked = !input.checked;
  dnsPost('/api/mode', { id: id, mode: mode });
}

// --- sites ------------------------------------------------------------------

function dnsPaintSelection() {
  const rows = siteRows();
  rows.forEach(function (row) {
    const box = row.querySelector('.site-checkbox');
    row.setAttribute('aria-selected', String(Boolean(box && box.checked)));
  });
  const chosen = selectedRows();
  const note = CLP_ROOT.getElementById('site-selection');
  if (note) note.textContent = chosen.length === 0 ? 'No sites selected' : chosen.length + ' of ' + rows.length + ' selected';
  const apply = CLP_ROOT.getElementById('assign-selected');
  if (apply) apply.disabled = chosen.length === 0;
  const all = CLP_ROOT.getElementById('select-all');
  if (all) {
    all.checked = rows.length > 0 && chosen.length === rows.length;
    all.indeterminate = chosen.length > 0 && chosen.length < rows.length;
  }
  const allBtn = CLP_ROOT.getElementById('select-all-btn');
  if (allBtn) allBtn.textContent = rows.length > 0 && chosen.length === rows.length ? 'Deselect all' : 'Select all';
}

async function dnsAssignRow(select) {
  const row = select.closest('tr[data-domain]');
  const id = select.value;
  select.value = row.dataset.profileId;
  await dnsPost('/api/assign', { domains: [row.dataset.domain], profileId: id || null });
}

async function dnsAssignSelected() {
  const rows = selectedRows();
  const picker = CLP_ROOT.getElementById('bulk-profile');
  if (!picker.value) return notify('Choose a profile to put them in first.', 'warn');
  const id = picker.value === '-' ? null : picker.value;
  const moving = rows.filter(function (row) { return (row.dataset.profileId || '') !== (id || ''); });
  if (!moving.length) return notify('Those sites are already there; nothing to change.', 'ok');
  const profile = id ? dnsProfile(id) : null;
  if (!profile || profile.mode !== 'enforce') {
    const accepted = await confirmAction({
      title: profile ? 'Put ' + plural(moving.length, 'site') + ' in ' + profile.name + '?' : 'Stop managing ' + plural(moving.length, 'site') + '?',
      text: profile ? 'Report only: their DNS is checked against it and nothing is changed.' : 'Their DNS is left as it is.',
      confirmLabel: profile ? 'Assign' : 'Stop managing',
    });
    if (!accepted) return;
  }
  dnsPost('/api/assign', { domains: moving.map(function (row) { return row.dataset.domain; }), profileId: id });
}

async function dnsSetDefault(select) {
  const id = select.value;
  select.value = dnsState.defaultProfileId || '';
  await dnsPost('/api/default', { profileId: id || null });
}

async function dnsCheck(button) {
  button.textContent = 'Checking…';
  if (!await dnsPost('/api/check', {})) button.textContent = 'Check now';
}

// --- plans and reviews ------------------------------------------------------

const DNS_ACTION_LABELS = { create: 'Create', update: 'Update', delete: 'Delete', note: 'Note' };

function dnsChanges(changes) {
  if (!changes.length) return '<p class="hint">Nothing to change.</p>';
  return '<ul class="dns-changes">' + changes.map(function (change) {
    return '<li><span class="badge dns-' + change.action + '">' + DNS_ACTION_LABELS[change.action] + '</span><div>' +
      '<strong>' + dnsEsc(change.subject) + '</strong><span class="dns-change-detail">' + dnsEsc(change.detail) + '</span>' +
      (change.before ? '<span class="hint">Now: ' + dnsEsc(change.before) + '</span>' : '') + '</div></li>';
  }).join('') + '</ul>';
}

function dnsProblems(problems) {
  return problems.length ? '<div class="alert">' + problems.map(dnsEsc).join('<br>') + '</div>' : '';
}

function dnsShowReview(review, notice) {
  dnsReviewToken = review.token;
  CLP_ROOT.getElementById('dns-review-heading').textContent = review.title;
  CLP_ROOT.getElementById('dns-review-text').textContent = (notice ? notice + ' ' : '') + review.text;
  const busySites = review.sites.filter(function (plan) { return plan.changes.length || plan.problems.length; });
  const quiet = review.sites.length - busySites.length;
  CLP_ROOT.getElementById('dns-review-sites').innerHTML = busySites.map(function (plan) {
    return '<section class="dns-review-site"><h3>' + dnsEsc(plan.domain) + '</h3>' + dnsProblems(plan.problems) + (plan.problems.length ? '' : dnsChanges(plan.changes)) + '</section>';
  }).join('') + (quiet ? '<p class="hint">' + plural(quiet, 'other site') + ' already ' + (quiet === 1 ? 'matches' : 'match') + '.</p>' : '');
  const confirm = CLP_ROOT.getElementById('dns-review-confirm');
  confirm.textContent = review.confirmLabel;
  confirm.className = review.danger ? 'btn btn-danger' : 'btn btn-primary';
  confirm.hidden = review.blocked;
  dnsOpen('dns-review-dialog');
}

function dnsConfirm() {
  dnsPost('/api/confirm', { token: dnsReviewToken }, CLP_ROOT.getElementById('dns-review-dialog'));
}

function dnsShowSite(domain) {
  const site = dnsState.sites.find(function (candidate) { return candidate.domain === domain; });
  const profile = dnsProfile(site.profileId);
  const plan = site.plan;
  dnsSiteShown = domain;
  CLP_ROOT.getElementById('dns-site-heading').textContent = domain;
  let html = '<dl class="dns-facts"><dt>Profile</dt><dd>' + dnsEsc(profile ? profile.name : '—') + (profile ? ' · ' + (profile.mode === 'enforce' ? 'Enforce' : 'Report only') : '') + '</dd>';
  if (plan && plan.zone) {
    html += '<dt>Zone</dt><dd>' + dnsEsc(plan.zone.name) + ' · ' + dnsEsc(plan.zone.status) + '</dd>' +
      '<dt>Through</dt><dd>' + dnsEsc(plan.zone.connection) + ' · ' + dnsEsc(plan.zone.account) + '</dd>';
    if (plan.zone.status !== 'active' && plan.zone.nameServers.length) html += '<dt>Nameservers</dt><dd class="mono">' + plan.zone.nameServers.map(dnsEsc).join('<br>') + '</dd>';
  }
  if (site.ssl) html += '<dt>Certificate</dt><dd>' + dnsEsc(site.ssl) + '</dd>';
  html += '</dl>';
  if (!plan) html += '<p class="hint">Not checked yet. Check now reads it from Cloudflare.</p>';
  else {
    html += dnsProblems(plan.problems);
    if (plan.zoneChoices.length) {
      html += '<div class="dns-choice"><label for="dns-zone-choice">Manage ' + dnsEsc(plan.zoneChoices[0].zone) + ' through</label><div class="dns-inline">' +
        '<select id="dns-zone-choice">' + plan.zoneChoices.map(function (choice) {
          return '<option value="' + dnsEsc(choice.connectionId + '/' + choice.zoneId) + '">' + dnsEsc(choice.label) + '</option>';
        }).join('') + '</select><button class="btn" type="button" onclick="dnsChooseZone()">Use this</button></div></div>';
    }
    if (!plan.problems.length) {
      html += '<h3 class="dns-section">' + (profile && profile.mode === 'enforce' ? 'To change' : 'Differences, not changed in Report only') + '</h3>' + dnsChanges(plan.changes);
    }
  }
  CLP_ROOT.getElementById('dns-site-body').innerHTML = html;
  const pending = plan && !plan.problems.length && plan.changes.some(function (change) { return change.action !== 'note'; });
  CLP_ROOT.getElementById('dns-site-apply').hidden = !(profile && profile.mode === 'enforce' && pending);
  dnsOpen('dns-site-dialog');
}

async function dnsApplySite() {
  const dialog = CLP_ROOT.getElementById('dns-site-dialog');
  const reply = await dnsPost('/api/provision', { domain: dnsSiteShown });
  if (!reply) return;
  if (reply.provision) notify(reply.provision.ready ? dnsSiteShown + ': DNS is in place.' : dnsSiteShown + ': ' + reply.provision.reason, reply.provision.ready ? 'ok' : 'warn');
  if (dialog.open) dnsShowSite(dnsSiteShown);
}

async function dnsChooseZone() {
  const site = dnsState.sites.find(function (candidate) { return candidate.domain === dnsSiteShown; });
  const choice = CLP_ROOT.getElementById('dns-zone-choice').value.split('/');
  await dnsPost('/api/zone', { zone: site.plan.zoneChoices[0].zone, connectionId: choice[0], zoneId: choice[1] }, CLP_ROOT.getElementById('dns-site-dialog'));
}

function dnsForget(domain) {
  dnsPost('/api/records/forget', { domain: domain });
}

function dnsRemoveRecords(domain) {
  dnsPost('/api/records/remove', { domain: domain });
}

// --- connections and settings -----------------------------------------------

function dnsEditConnection(id) {
  const connection = id ? dnsState.connections.find(function (candidate) { return candidate.id === id; }) : null;
  const form = CLP_ROOT.getElementById('dns-connection-form');
  form.reset();
  form.elements.namedItem('id').value = id;
  form.elements.namedItem('label').value = connection ? connection.label : '';
  const token = form.elements.namedItem('token');
  token.required = !connection;
  token.placeholder = connection ? 'Leave empty to keep the saved token' : 'Paste the token';
  CLP_ROOT.getElementById('dns-token-permissions').textContent = dnsState.token.permissions.join(', ');
  CLP_ROOT.getElementById('dns-token-link').href = dnsState.token.url;
  CLP_ROOT.getElementById('dns-connection-heading').textContent = connection ? 'Edit ' + connection.label : 'Connect Cloudflare';
  form.querySelector('[type="submit"]').textContent = connection ? 'Save' : 'Connect';
  dnsOpen('dns-connection-dialog');
}

function dnsSaveConnection(event) {
  event.preventDefault();
  const form = event.currentTarget;
  dnsPost('/api/connections', {
    id: form.elements.namedItem('id').value || null,
    label: form.elements.namedItem('label').value,
    token: form.elements.namedItem('token').value,
  }, CLP_ROOT.getElementById('dns-connection-dialog'));
}

async function dnsRemoveConnection(id) {
  const connection = dnsState.connections.find(function (candidate) { return candidate.id === id; });
  const accepted = await confirmAction({
    title: 'Remove ' + connection.label + '?',
    text: 'Its token is deleted from this server. Zones only it reaches stop being managed; their records stay as they are.',
    confirmLabel: 'Remove', danger: true,
  });
  if (accepted) dnsPost('/api/connections/remove', { id: id });
}

function dnsSyncDkim() {
  const share = CLP_ROOT.getElementById('dns-mailcow-dkim').value === 'share';
  CLP_ROOT.getElementById('dns-dkim-share').hidden = !share;
  CLP_ROOT.getElementById('dns-dkim-generate').hidden = share;
}

function dnsEditMailcow() {
  const settings = dnsState.mailcow;
  const form = CLP_ROOT.getElementById('dns-mailcow-form');
  form.reset();
  form.elements.namedItem('url').value = settings.url;
  form.elements.namedItem('host').value = settings.host;
  form.elements.namedItem('sharedMailbox').value = settings.sharedMailbox;
  form.elements.namedItem('dkimMode').value = settings.dkimSource ? 'share' : 'generate';
  form.elements.namedItem('dkimSource').value = settings.dkimSource;
  form.elements.namedItem('dkimSelector').value = settings.dkimSelector;
  form.elements.namedItem('dkimBits').value = String(settings.dkimBits);
  const key = form.elements.namedItem('key');
  key.required = !settings.hasKey;
  key.placeholder = settings.hasKey ? 'Leave empty to keep the saved key' : 'API key';
  dnsSyncDkim();
  dnsOpen('dns-mailcow-dialog');
}

function dnsSaveMailcow(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const value = function (name) { return form.elements.namedItem(name).value.trim(); };
  const share = value('dkimMode') === 'share';
  dnsPost('/api/mailcow', {
    url: value('url'), key: value('key'), host: value('host'), sharedMailbox: value('sharedMailbox'),
    dkimSource: share ? value('dkimSource') : '', dkimSelector: value('dkimSelector') || 'dkim', dkimBits: Number(value('dkimBits')),
  }, CLP_ROOT.getElementById('dns-mailcow-dialog'));
}

function dnsEditServer() {
  const form = CLP_ROOT.getElementById('dns-server-form');
  form.elements.namedItem('ipv4').value = dnsState.server.ipv4;
  form.elements.namedItem('ipv6').value = dnsState.server.ipv6;
  form.elements.namedItem('ipv4').placeholder = dnsState.server.detected.ipv4 || 'None detected';
  form.elements.namedItem('ipv6').placeholder = dnsState.server.detected.ipv6 || 'None detected';
  dnsOpen('dns-server-dialog');
}

function dnsSaveServer(event) {
  event.preventDefault();
  const form = event.currentTarget;
  dnsPost('/api/server', {
    ipv4: form.elements.namedItem('ipv4').value.trim(),
    ipv6: form.elements.namedItem('ipv6').value.trim(),
  }, CLP_ROOT.getElementById('dns-server-dialog'));
}

/** A press on the backdrop closes a dialog; a drag that started in a field and ended outside does not. */
CLP_ROOT.querySelectorAll('dialog').forEach(function (dialog) {
  dialog.addEventListener('mousedown', function (event) {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    const inside = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
    if (!inside) dialog.close();
  });
});

dnsPaintSelection();

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

function dnsHasCloudflare() {
  return (dnsState.connections || []).some(function (connection) { return (connection.provider || 'cloudflare') === 'cloudflare'; });
}

function dnsHasPowerDns() {
  return (dnsState.connections || []).some(function (connection) { return connection.provider === 'powerdns'; });
}

function dnsProviderLabel() {
  const cf = dnsHasCloudflare();
  const pdns = dnsHasPowerDns();
  if (cf && !pdns) return 'Cloudflare';
  if (pdns && !cf) return 'PowerDNS';
  return 'your DNS provider';
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
      repaintView(CLP_ROOT.getElementById('dns-root'), reply.html);
      dnsState = reply.data;
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

function dnsTtlLabel(ttl) {
  const known = DNS_TTLS.find(function (option) { return option[0] === ttl; });
  return known ? known[1] : ttl + ' s';
}

/** Type, name, content and proxy; priority sits in the content cell for MX and SRV, TTL and apex only behind the toggle. */
function dnsRowCells(row, index, advanced) {
  const proxiable = ['A', 'AAAA', 'CNAME'].indexOf(row.type) >= 0;
  const prioritised = row.type === 'MX' || row.type === 'SRV';
  const n = index + 1;
  const tags = advanced ? [] : [row.apexOnly ? 'apex only' : '', !row.proxied && row.ttl !== 1 ? 'TTL ' + dnsTtlLabel(row.ttl) : ''].filter(Boolean);
  return '<td data-label="Type" class="dns-type"><select data-field="type" aria-label="Type of record ' + n + '">' +
      DNS_TYPES.map(function (type) { return '<option' + (type === row.type ? ' selected' : '') + '>' + type + '</option>'; }).join('') + '</select></td>' +
    '<td data-label="Name" class="dns-name' + (tags.length ? ' dns-tagged' : '') + '"><input data-field="name" aria-label="Name of record ' + n + '" spellcheck="false" autocomplete="off" placeholder="{domain}">' +
      (tags.length ? '<span class="dns-row-tags">' + tags.map(function (tag) { return '<span class="badge">' + dnsEsc(tag) + '</span>'; }).join('') + '</span>' : '') + '</td>' +
    '<td data-label="Content" class="dns-content"><div class="dns-content-fields">' +
      (prioritised ? '<input data-field="priority" class="dns-priority" type="number" min="0" max="65535" inputmode="numeric" title="Priority" aria-label="Priority of record ' + n + '">' : '') +
      '<input data-field="content" aria-label="Content of record ' + n + '" spellcheck="false" autocomplete="off" placeholder="' + dnsEsc(DNS_EXAMPLES[row.type]) + '"></div></td>' +
    '<td data-label="TTL" class="dns-ttl dns-adv"><select data-field="ttl" aria-label="TTL of record ' + n + '"' + (row.proxied && dnsHasCloudflare() ? ' disabled' : '') + '>' +
      DNS_TTLS.map(function (ttl) { return '<option value="' + ttl[0] + '"' + (ttl[0] === row.ttl ? ' selected' : '') + '>' + ttl[1] + '</option>'; }).join('') + '</select></td>' +
    '<td data-label="Apex only" class="dns-flag dns-adv"><label class="switch"><input data-field="apexOnly" type="checkbox" aria-label="Record ' + n + ' only at the zone apex"' +
      (row.apexOnly ? ' checked' : '') + '><span></span></label></td>' +
    '<td data-label="Proxy" class="dns-flag dns-proxy-col' + (proxiable ? '' : ' dns-unproxiable') + '"><label class="switch"><input data-field="proxied" type="checkbox" aria-label="Proxy record ' + n + '"' +
      (row.proxied ? ' checked' : '') + (proxiable ? '' : ' disabled') + '><span></span></label></td>' +
    '<td class="dns-remove"><button class="btn dns-remove-btn" type="button" aria-label="Remove record ' + n + '" onclick="dnsRemoveRow(' + index + ')">×</button></td>';
}

function dnsRenderRows() {
  const body = CLP_ROOT.getElementById('dns-rows');
  const advanced = CLP_ROOT.getElementById('dns-advanced').checked;
  const table = CLP_ROOT.getElementById('dns-rows-table');
  const hasCf = dnsHasCloudflare();
  const hasPdns = dnsHasPowerDns();
  table.classList.toggle('dns-show-advanced', advanced);
  table.classList.toggle('dns-no-proxy', !hasCf);
  const proxyHead = CLP_ROOT.getElementById('dns-proxy-head');
  if (proxyHead) proxyHead.textContent = hasCf && hasPdns ? 'Proxy (CF)' : 'Proxy';
  const mixedNote = CLP_ROOT.getElementById('dns-mixed-note');
  if (mixedNote) mixedNote.hidden = !(hasCf && hasPdns);
  body.textContent = '';
  dnsRowsState.forEach(function (row, index) {
    const tr = document.createElement('tr');
    tr.innerHTML = dnsRowCells(row, index, advanced);
    tr.querySelector('[data-field="name"]').value = row.name;
    tr.querySelector('[data-field="content"]').value = row.content;
    const priority = tr.querySelector('[data-field="priority"]');
    if (priority) priority.value = row.priority === null || row.priority === undefined ? '' : row.priority;
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
  if (key === 'ttl' && row.ttl !== 1 && !dnsHasCloudflare()) row.proxied = false;
  if (key === 'type') {
    if (['A', 'AAAA', 'CNAME'].indexOf(row.type) < 0) row.proxied = false;
    if (row.type !== 'MX' && row.type !== 'SRV') row.priority = null;
    else if (row.priority === null) row.priority = row.type === 'MX' ? 10 : 0;
  }
  // Only what changes which fields apply redraws the rows, so typing keeps its focus.
  if (settled && (key === 'type' || key === 'proxied')) dnsRenderRows();
}

function dnsAddRow() {
  const form = CLP_ROOT.getElementById('dns-profile-form');
  const role = form ? form.elements.namedItem('role').value : 'http';
  if (role === 'mail') {
    dnsRowsState.push({ type: 'TXT', name: '{domain}', content: '', proxied: false, ttl: 1, priority: null, apexOnly: false });
  } else {
    dnsRowsState.push({ type: 'A', name: '{domain}', content: '{ipv4}', proxied: dnsHasCloudflare(), ttl: 1, priority: null, apexOnly: false });
  }
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
  dnsSyncProfileSections();
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

function dnsEditProfile(id, role) {
  const profile = id ? dnsProfile(id) : null;
  const profileRole = profile ? profile.role : (role === 'mail' ? 'mail' : 'http');
  const form = CLP_ROOT.getElementById('dns-profile-form');
  form.reset();
  form.elements.namedItem('id').value = profile ? profile.id : '';
  form.elements.namedItem('role').value = profileRole;
  const nameField = form.elements.namedItem('name');
  nameField.value = profile ? profile.name : '';
  nameField.placeholder = profileRole === 'mail' ? (dnsState.mailcow.linked ? 'Mailcow' : 'Google Workspace') : 'Web';
  form.elements.namedItem('mailcow').checked = Boolean(profile && profile.mailcow);
  const matchingPresets = (dnsState.presets || []).filter(function (preset) { return preset.role === profileRole; });
  const presetSelect = CLP_ROOT.getElementById('dns-preset');
  presetSelect.innerHTML = '<option value="">Add a preset…</option>' + matchingPresets.map(function (preset) {
    return '<option value="' + dnsEsc(preset.id) + '">' + dnsEsc(preset.label) + '</option>';
  }).join('');
  presetSelect.hidden = matchingPresets.length === 0;
  dnsRowsState = profile ? profile.records.map(function (record) { return Object.assign({}, record); }) : [];
  dnsLastField = null;
  CLP_ROOT.getElementById('dns-advanced').checked = false;
  dnsSyncProfileSections();
  dnsRenderRows();
  CLP_ROOT.getElementById('dns-profile-heading').textContent = profile
    ? 'Edit ' + profile.name
    : (profileRole === 'mail' ? 'New Mail profile' : 'New HTTP profile');
  dnsOpen('dns-profile-dialog');
}

/** Mailcow shows only on Mail profiles once Mailcow is linked (or already used). */
function dnsSyncProfileSections() {
  const form = CLP_ROOT.getElementById('dns-profile-form');
  const role = form.elements.namedItem('role').value || 'http';
  const isMail = role === 'mail';
  const mailcowChecked = form.elements.namedItem('mailcow').checked;
  const showMailcow = isMail && (dnsState.mailcow.linked || mailcowChecked);
  CLP_ROOT.getElementById('dns-mailcow-section').hidden = !showMailcow;
  form.querySelectorAll('[data-mailcow-chip]').forEach(function (chip) { chip.hidden = !showMailcow; });
}

function dnsSaveProfile(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const value = function (name) { return form.elements.namedItem(name).value; };
  const role = value('role') || 'http';
  dnsPost('/api/profiles', {
    id: value('id') || null,
    role: role,
    name: value('name'),
    records: dnsRowsState,
    mailcow: role === 'mail' && form.elements.namedItem('mailcow').checked,
  }, CLP_ROOT.getElementById('dns-profile-dialog'));
}

async function dnsDeleteProfile(id) {
  const profile = dnsProfile(id);
  const noun = profile.role === 'mail' ? 'domain' : 'site';
  const accepted = await confirmAction({
    title: 'Delete ' + profile.name + '?',
    text: 'Assigned domains stop syncing this ' + (profile.role === 'mail' ? 'Mail' : 'HTTP') + ' profile. Nothing in ' + dnsProviderLabel() + ' or Mailcow changes.',
    details: profile.sites ? [plural(profile.sites, noun) + ' will lose this ' + (profile.role === 'mail' ? 'Mail' : 'HTTP') + ' role.'] : [],
    confirmLabel: 'Delete', danger: true,
  });
  if (accepted) dnsPost('/api/profiles/delete', { id: id });
}

/** Turning Automatic on answers with the review of everything it would write; off is saved straight away. */
function dnsSetAutomatic(on) {
  dnsPost('/api/automatic', { automatic: on });
}

async function dnsSetZoneAccount(select) {
  const parts = select.value.split('/');
  const saved = dnsState.createIn;
  select.value = saved ? saved.connectionId + '/' + saved.accountId : '';
  await dnsPost('/api/zone-account', { createIn: parts.length === 2 ? { connectionId: parts[0], accountId: parts[1] } : null });
}

// --- sites ------------------------------------------------------------------

async function dnsAssignHttp(select) {
  const row = select.closest('tr[data-domain]');
  const id = select.value;
  select.value = row.dataset.httpProfileId;
  await dnsPost('/api/assign', { domains: [row.dataset.domain], httpProfileId: id || null });
}

async function dnsAssignMail(select) {
  const row = select.closest('tr[data-domain]');
  const id = select.value;
  select.value = row.dataset.mailProfileId;
  await dnsPost('/api/assign', { domains: [row.dataset.domain], mailProfileId: id || null });
}

async function dnsAssignSelected() {
  const rows = selectedRows();
  const httpPicker = CLP_ROOT.getElementById('bulk-http');
  const mailPicker = CLP_ROOT.getElementById('bulk-mail');
  const changeHttp = Boolean(httpPicker && httpPicker.value);
  const changeMail = Boolean(mailPicker && mailPicker.value);
  if (!changeHttp && !changeMail) return notify('Choose an HTTP or Mail role to assign first.', 'warn');
  const httpId = changeHttp ? (httpPicker.value === '-' ? null : httpPicker.value) : undefined;
  const mailId = changeMail ? (mailPicker.value === '-' ? null : mailPicker.value) : undefined;
  const moving = rows.filter(function (row) {
    const httpDiff = changeHttp && (row.dataset.httpProfileId || '') !== (httpId || '');
    const mailDiff = changeMail && (row.dataset.mailProfileId || '') !== (mailId || '');
    const heldReview = Boolean(row.dataset.held) && (Boolean(httpId) || Boolean(mailId));
    return httpDiff || mailDiff || heldReview;
  });
  if (!moving.length) return notify('Those sites already have those roles; nothing to change.', 'ok');
  const body = { domains: moving.map(function (row) { return row.dataset.domain; }) };
  if (changeHttp) body.httpProfileId = httpId;
  if (changeMail) body.mailProfileId = mailId;
  const clearingOnly = (!changeHttp || httpId === null) && (!changeMail || mailId === null);
  if (clearingOnly || !dnsState.automatic) {
    const parts = [];
    if (changeHttp) parts.push('HTTP: ' + (httpId ? dnsProfile(httpId).name : 'DNS-only'));
    if (changeMail) parts.push('Mail: ' + (mailId ? dnsProfile(mailId).name : 'None'));
    const accepted = await confirmAction({
      title: 'Update ' + plural(moving.length, 'site') + ' (' + parts.join(', ') + ')?',
      text: clearingOnly ? 'Existing DNS records are left as they are.' : 'DNS asks first: their DNS is checked against these roles and nothing is changed.',
      confirmLabel: 'Assign',
    });
    if (!accepted) return;
  }
  dnsPost('/api/assign', body);
}

async function dnsSetDefault(role, select) {
  const id = select.value;
  if (role === 'mail') {
    select.value = dnsState.defaultMailProfileId || '';
    await dnsPost('/api/default', { mailProfileId: id || null });
  } else {
    select.value = dnsState.defaultHttpProfileId || '';
    await dnsPost('/api/default', { httpProfileId: id || null });
  }
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
      (change.before ? '<span class="hint">Now: ' + dnsEsc(change.before) + '</span>' : '') +
      (change.waits ? '<span class="hint tone-warn">Waits for your review</span>' : '') + '</div></li>';
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
  const quietSites = review.sites.filter(function (plan) { return !plan.changes.length && !plan.problems.length; });
  const quiet = quietSites.length;
  const quietWildcards = Array.from(new Set(quietSites.map(function (plan) { return plan.wildcard; }).filter(Boolean)));
  const quietSuffix = quietWildcards.length === 1 && quietSites.every(function (plan) { return plan.wildcard === quietWildcards[0]; })
    ? ' (covered by ' + quietWildcards[0] + ')' : '';
  CLP_ROOT.getElementById('dns-review-sites').innerHTML = busySites.map(function (plan) {
    const blockedNote = !plan.problems.length && plan.wildcardBlocked ? '<p class="hint dns-wildcard-note">' + dnsEsc(plan.wildcardBlocked) + '.</p>' : '';
    return '<section class="dns-review-site"><h3>' + dnsEsc(plan.domain) + '</h3>' + dnsProblems(plan.problems) + blockedNote + (plan.problems.length ? '' : dnsChanges(plan.changes)) + '</section>';
  }).join('') + (quiet ? '<p class="hint">' + plural(quiet, busySites.length ? 'other site' : 'site') + ' already ' + (quiet === 1 ? 'matches' : 'match') + dnsEsc(quietSuffix) + '.</p>' : '');
  const confirm = CLP_ROOT.getElementById('dns-review-confirm');
  confirm.textContent = review.confirmLabel;
  confirm.className = review.danger ? 'btn btn-danger' : 'btn btn-primary';
  confirm.hidden = review.blocked;
  dnsOpen('dns-review-dialog');
}

function dnsConfirm() {
  dnsPost('/api/confirm', { token: dnsReviewToken }, CLP_ROOT.getElementById('dns-review-dialog'));
}

// The site's state and what it needs first, then what will change, then the
// facts that only describe it.
function dnsShowSite(domain) {
  const site = dnsState.sites.find(function (candidate) { return candidate.domain === domain; });
  const httpProfile = site.httpProfileId ? dnsProfile(site.httpProfileId) : null;
  const mailProfile = site.mailProfileId ? dnsProfile(site.mailProfileId) : null;
  const plan = site.plan;
  dnsSiteShown = domain;
  const heading = CLP_ROOT.getElementById('dns-site-heading');
  heading.textContent = domain;
  const row = Array.prototype.find.call(CLP_ROOT.querySelectorAll('tr[data-domain], tr[data-mailcow-domain]'), function (candidate) {
    return (candidate.dataset.domain || candidate.dataset.mailcowDomain) === domain;
  });
  const chip = row && row.querySelector('.dns-status .badge');
  if (chip) heading.appendChild(chip.cloneNode(true));

  let html = '';
  if (site.mailcowMissing && (!plan || !plan.problems.length)) {
    html += '<div class="alert">Mailcow is not connected. Reconnect Mailcow on the Mailcow tab or change this domain\'s Mail role.</div>';
  }
  if (!plan) {
    html += httpProfile || mailProfile ? '<p class="hint">Not checked yet. Check now reads it from your DNS provider.</p>'
      : '<p class="hint">No HTTP or Mail role yet. Choose one in its row.</p>';
  }
  else {
    html += dnsProblems(plan.problems);
    if (plan.zone && plan.zone.status !== 'active' && plan.zone.nameServers.length) {
      html += '<div class="notice dns-nameservers"><span>Set ' + dnsEsc(plan.zone.name) + "'s nameservers at its registrar:</span>" +
        plan.zone.nameServers.map(function (server) {
          // One button each: a registrar usually has a field per nameserver.
          return '<span class="dns-copy"><code>' + dnsEsc(server) + '</code><button class="dns-clip" type="button" title="Copy" aria-label="Copy ' + dnsEsc(server) +
            '" onclick="dnsCopyText(this.previousElementSibling.textContent)">' + DNS_CLIPBOARD + '</button></span>';
        }).join('') + '</div>';
    }
    if (plan.zoneChoices.length) {
      html += '<div class="dns-choice"><label for="dns-zone-choice">Manage ' + dnsEsc(plan.zoneChoices[0].zone) + ' through</label><div class="dns-inline">' +
        '<select id="dns-zone-choice">' + plan.zoneChoices.map(function (choice) {
          return '<option value="' + dnsEsc(choice.connectionId + '/' + choice.zoneId) + '">' + dnsEsc(choice.label) + '</option>';
        }).join('') + '</select><button class="btn" type="button" onclick="dnsChooseZone()">Use this</button></div></div>';
    }
    if (plan.held && !plan.problems.length) {
      html += '<div class="notice">CloudPanel created this site, so its own address records went in straight away. The changes marked below reach further and wait until you review them.</div>';
    }
    if (!plan.problems.length && plan.changes.length) {
      html += '<h3 class="dns-section">' + (dnsState.automatic ? 'To change' : 'Differences, not changed until DNS is Automatic') + '</h3>'
        + (plan.wildcardBlocked ? '<p class="hint dns-wildcard-note">' + dnsEsc(plan.wildcardBlocked) + '.</p>' : '')
        + dnsChanges(plan.changes);
    }
  }

  if (site.redirectedBy) {
    html += '<div class="notice">' + dnsEsc(site.redirectedBy.source) + ' redirects to ' + dnsEsc(site.redirectedBy.target) +
      ' in <a href="' + DNS_REDIRECTS + '">Redirects</a>. DNS still keeps this domain\'s records to its roles below.</div>';
  }
  html += '<h3 class="dns-section">' + (site.type === 'domain' ? 'Domain' : 'Site') + '</h3><dl class="dns-facts">';
  const httpDesc = httpProfile ? 'Site · ' + dnsEsc(httpProfile.name) : 'DNS-only (no web records)';
  const mailDesc = mailProfile ? dnsEsc(mailProfile.name) + (site.mailcowMissing ? ' <span class="badge tone-warn">Mailcow unlinked</span>' : '') : 'None';
  html += '<dt>HTTP role</dt><dd>' + httpDesc + '</dd>' +
    '<dt>Mail role</dt><dd>' + mailDesc + '</dd>' +
    '<dt>Sync mode</dt><dd>' + (dnsState.automatic ? 'Automatic' : 'Ask first') + '</dd>';
  if (plan && plan.zone) {
    const providerLabel = plan.zone.provider === 'powerdns' ? 'PowerDNS' : 'Cloudflare';
    html += '<dt>Zone</dt><dd>' + dnsEsc(plan.zone.name) + ' · ' + dnsEsc(plan.zone.status) + '</dd>' +
      '<dt>Through</dt><dd>' + dnsEsc(plan.zone.connection) + ' (' + providerLabel + ') · ' + dnsEsc(plan.zone.account) + '</dd>';
  }
  if (plan && plan.wildcard) html += '<dt>Covered by</dt><dd class="mono">' + dnsEsc(plan.wildcard) + '</dd>';
  else if (plan && !plan.problems.length && !plan.changes.length && plan.wildcardBlocked) {
    html += '<dt>Wildcard</dt><dd>' + dnsEsc(plan.wildcardBlocked) + '.</dd>';
  }
  if (site.ssl) html += '<dt>Certificate</dt><dd>' + dnsEsc(site.ssl) + '</dd>';
  html += '</dl>';
  CLP_ROOT.getElementById('dns-site-body').innerHTML = html;
  CLP_ROOT.getElementById('dns-site-remove').hidden = site.type !== 'domain';
  const pending = plan && !plan.problems.length && plan.changes.some(function (change) { return change.action !== 'note'; });
  const apply = CLP_ROOT.getElementById('dns-site-apply');
  apply.hidden = !(dnsState.automatic && pending && (httpProfile || mailProfile));
  apply.textContent = plan && plan.held ? 'Review changes' : 'Apply now';
  dnsOpen('dns-site-dialog');
}

async function dnsApplySite() {
  const dialog = CLP_ROOT.getElementById('dns-site-dialog');
  const site = dnsState.sites.find(function (candidate) { return candidate.domain === dnsSiteShown; });
  if (site.plan && site.plan.held) {
    return dnsPost('/api/assign', { domains: [site.domain], httpProfileId: site.httpProfileId, mailProfileId: site.mailProfileId }, dialog);
  }
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

function dnsAddDomain() {
  const form = CLP_ROOT.getElementById('dns-domain-form');
  form.reset();
  const options = function (role, none) {
    return '<option value="">' + none + '</option>' + dnsState.profiles.filter(function (profile) { return profile.role === role; }).map(function (profile) {
      return '<option value="' + dnsEsc(profile.id) + '">' + dnsEsc(profile.name) + '</option>';
    }).join('');
  };
  form.elements.namedItem('httpProfileId').innerHTML = options('http', 'DNS-only');
  form.elements.namedItem('mailProfileId').innerHTML = options('mail', 'None');
  dnsOpen('dns-domain-dialog');
  form.elements.namedItem('domain').focus();
}

function dnsSaveDomain(event) {
  event.preventDefault();
  const form = event.target;
  dnsPost('/api/domains', {
    domain: form.elements.namedItem('domain').value,
    httpProfileId: form.elements.namedItem('httpProfileId').value || null,
    mailProfileId: form.elements.namedItem('mailProfileId').value || null,
  }, CLP_ROOT.getElementById('dns-domain-dialog'));
}

async function dnsRemoveDomain(domain) {
  const accepted = await confirmAction({
    title: 'Remove ' + domain + '?',
    text: 'DNS stops managing it. Its records stay in ' + dnsProviderLabel() + ', listed with the records of deleted sites until you remove or keep them.',
    confirmLabel: 'Remove', danger: true,
  });
  if (accepted) dnsPost('/api/domains/remove', { domain: domain }, CLP_ROOT.getElementById('dns-site-dialog'));
}

function dnsForget(domain) {
  dnsPost('/api/records/forget', { domain: domain });
}

function dnsRemoveRecords(domain) {
  dnsPost('/api/records/remove', { domain: domain });
}

// --- connections and settings -----------------------------------------------

function dnsSyncPowerDns() {
  const form = CLP_ROOT.getElementById('dns-connection-form');
  const create = form.elements.namedItem('createZones').checked;
  const nsField = CLP_ROOT.getElementById('dns-pdns-ns-field');
  if (nsField) nsField.hidden = !create;
}

function dnsSelectProvider(provider) {
  const form = CLP_ROOT.getElementById('dns-connection-form');
  const isEditing = Boolean(form.elements.namedItem('id').value);
  const isPdns = provider === 'powerdns';
  form.elements.namedItem('provider').value = isPdns ? 'powerdns' : 'cloudflare';
  const cfPanel = CLP_ROOT.getElementById('dns-provider-cloudflare');
  const pdnsPanel = CLP_ROOT.getElementById('dns-provider-powerdns');
  cfPanel.hidden = isPdns;
  pdnsPanel.hidden = !isPdns;
  cfPanel.querySelectorAll('input, select, textarea, button').forEach(function (el) { el.disabled = isPdns; });
  pdnsPanel.querySelectorAll('input, select, textarea, button').forEach(function (el) { el.disabled = !isPdns; });
  CLP_ROOT.querySelectorAll('#dns-provider-tabs .dns-provider-tab').forEach(function (tab) {
    tab.setAttribute('aria-selected', tab.dataset.provider === (isPdns ? 'powerdns' : 'cloudflare') ? 'true' : 'false');
  });
  form.elements.namedItem('token').required = !isPdns && !isEditing;
  form.elements.namedItem('url').required = isPdns;
  form.elements.namedItem('apiKey').required = isPdns && !isEditing;
  if (!isEditing) {
    CLP_ROOT.getElementById('dns-connection-heading').textContent = isPdns ? 'Connect PowerDNS' : 'Connect Cloudflare';
  }
  dnsSyncPowerDns();
}

function dnsEditConnection(id, preferredProvider) {
  const connection = id ? dnsState.connections.find(function (candidate) { return candidate.id === id; }) : null;
  const provider = connection ? (connection.provider || 'cloudflare') : (preferredProvider || 'cloudflare');
  const form = CLP_ROOT.getElementById('dns-connection-form');
  form.reset();
  form.elements.namedItem('id').value = id;
  form.elements.namedItem('label').value = connection && provider === 'cloudflare' ? connection.label : '';
  const token = form.elements.namedItem('token');
  token.placeholder = connection ? 'Leave empty to keep the saved token' : 'Paste the token';

  form.elements.namedItem('url').value = connection && connection.url ? connection.url : '';
  form.elements.namedItem('pdnsLabel').value = connection && provider === 'powerdns' ? connection.label : '';
  form.elements.namedItem('serverId').value = connection && connection.serverId ? connection.serverId : 'localhost';
  form.elements.namedItem('defaultTtl').value = String(connection && connection.defaultTtl ? connection.defaultTtl : 300);
  form.elements.namedItem('createZones').checked = Boolean(connection && connection.createZones);
  form.elements.namedItem('nameservers').value = connection && connection.nameservers ? connection.nameservers.join('\n') : '';
  const apiKey = form.elements.namedItem('apiKey');
  apiKey.placeholder = connection ? 'Leave empty to keep the saved key' : 'Paste the PowerDNS API key';

  const tabs = CLP_ROOT.getElementById('dns-provider-tabs');
  if (tabs) tabs.hidden = Boolean(connection);

  const dialog = CLP_ROOT.getElementById('dns-connection-dialog');
  const templates = dnsState.tokens || { dns: dnsState.token };
  dialog.dataset.cfTemplates = JSON.stringify(templates);
  const dnsScope = CLP_ROOT.getElementById('dns-scope-dns');
  const redirectsScope = CLP_ROOT.getElementById('dns-scope-redirects');
  const edgeScope = CLP_ROOT.getElementById('dns-scope-edge');
  const gateScope = CLP_ROOT.getElementById('dns-scope-gate');
  if (dnsScope) dnsScope.checked = true;
  if (redirectsScope) redirectsScope.checked = Boolean(dnsState.redirectsEnabled);
  if (edgeScope) edgeScope.checked = Boolean(dnsState.firewallEnabled);
  if (gateScope) gateScope.checked = false;
  cfSyncScope('dns');
  const ips = [dnsState.server.detected.ipv4, dnsState.server.detected.ipv6].filter(Boolean);
  // Space-separated, as Cloudflare's IP filter takes several addresses at once.
  CLP_ROOT.getElementById('dns-token-ips').textContent = ips.join(' ');
  CLP_ROOT.getElementById('dns-token-ips-hint').hidden = !ips.length;
  dnsSelectProvider(provider);
  if (connection) CLP_ROOT.getElementById('dns-connection-heading').textContent = 'Edit ' + connection.label;
  form.querySelector('[type="submit"]').textContent = connection ? 'Save' : 'Connect';
  dnsOpen('dns-connection-dialog');
  form.elements.namedItem(provider === 'powerdns' ? 'url' : 'token').focus();
}

function dnsCopyText(text) {
  if (!navigator.clipboard || !navigator.clipboard.writeText) return notify('Select ' + text + ' and copy it.', 'warn');
  navigator.clipboard.writeText(text).then(
    function () { notify(text + ' copied.', 'ok'); },
    function () { notify('Select ' + text + ' and copy it.', 'warn'); }
  );
}

function dnsSaveConnection(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const provider = form.elements.namedItem('provider').value || 'cloudflare';
  if (provider === 'powerdns') {
    const nameservers = form.elements.namedItem('nameservers').value.split(/[\s,]+/).filter(Boolean);
    dnsPost('/api/connections', {
      id: form.elements.namedItem('id').value || null,
      provider: 'powerdns',
      label: form.elements.namedItem('pdnsLabel').value,
      url: form.elements.namedItem('url').value.trim(),
      apiKey: form.elements.namedItem('apiKey').value,
      serverId: form.elements.namedItem('serverId').value.trim() || 'localhost',
      defaultTtl: Number(form.elements.namedItem('defaultTtl').value || 300),
      createZones: form.elements.namedItem('createZones').checked,
      nameservers: nameservers,
    }, CLP_ROOT.getElementById('dns-connection-dialog'));
    return;
  }
  dnsPost('/api/connections', {
    id: form.elements.namedItem('id').value || null,
    provider: 'cloudflare',
    label: form.elements.namedItem('label').value,
    token: form.elements.namedItem('token').value,
  }, CLP_ROOT.getElementById('dns-connection-dialog'));
}

async function dnsRemoveConnection(id) {
  const connection = dnsState.connections.find(function (candidate) { return candidate.id === id; });
  const isPdns = connection && connection.provider === 'powerdns';
  const accepted = await confirmAction({
    title: 'Remove ' + connection.label + '?',
    text: (isPdns ? 'Its API key' : 'Its token') + ' is deleted from this server. Zones only it reaches stop being managed; their records stay as they are.',
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
  form.elements.namedItem('url').value = settings.url.replace(/^https:\/\//, '');
  form.elements.namedItem('sharedMailbox').value = settings.sharedMailbox;
  form.elements.namedItem('dkimMode').value = settings.dkimSource ? 'share' : 'generate';
  form.elements.namedItem('dkimSource').value = settings.dkimSource;
  form.elements.namedItem('dkimSelector').value = settings.dkimSelector;
  form.elements.namedItem('dkimBits').value = String(settings.dkimBits);
  const key = form.elements.namedItem('key');
  key.required = !settings.hasKey;
  key.placeholder = settings.hasKey ? 'Leave empty to keep the saved key' : 'API key';
  const relays = dnsState.smtpRelays;
  const relay = CLP_ROOT.getElementById('dns-mailcow-relay');
  relay.innerHTML = '<option value="">Choose a profile</option>' + relays.map(function (account, index) {
    return '<option value="' + index + '">' + dnsEsc(account.profile + ': ' + account.username + ' at ' + account.host) + '</option>';
  }).join('');
  CLP_ROOT.getElementById('dns-mailcow-relay-field').hidden = !relays.length;
  // Not set up yet and only one account to share: that is almost certainly the one.
  if (!settings.url && relays.length === 1) {
    relay.value = '0';
    dnsFillFromRelay();
  }
  CLP_ROOT.getElementById('dns-mailcow-heading').textContent = settings.linked ? 'Edit Mailcow' : 'Connect Mailcow';
  form.querySelector('[type="submit"]').textContent = settings.linked ? 'Save' : 'Connect';
  dnsSyncDkim();
  dnsOpen('dns-mailcow-dialog');
}

function dnsFillFromRelay() {
  const account = dnsState.smtpRelays[Number(CLP_ROOT.getElementById('dns-mailcow-relay').value)];
  if (!CLP_ROOT.getElementById('dns-mailcow-relay').value || !account) return;
  const form = CLP_ROOT.getElementById('dns-mailcow-form');
  form.elements.namedItem('url').value = account.host;
  form.elements.namedItem('sharedMailbox').value = account.username.includes('@') ? account.username : '';
}

async function dnsRemoveMailcow() {
  const mailcowIds = new Set((dnsState.profiles || []).filter(function (profile) { return profile.role === 'mail' && profile.mailcow; }).map(function (profile) { return profile.id; }));
  const assigned = (dnsState.sites || []).filter(function (site) { return site.mailProfileId && mailcowIds.has(site.mailProfileId); }).length;
  const accepted = await confirmAction({
    title: 'Remove Mailcow?',
    text: 'Its API key is deleted from this server. Domains that assign Mailcow as their Mail role will show a warning and stay paused until Mailcow is reconnected or their Mail role changes; existing DNS records and Mailcow domains stay as they are.',
    details: assigned ? [plural(assigned, 'domain') + ' currently ' + (assigned === 1 ? 'uses' : 'use') + ' Mailcow as ' + (assigned === 1 ? 'its' : 'their') + ' Mail role.'] : [],
    confirmLabel: 'Remove', danger: true,
  });
  if (accepted) dnsPost('/api/mailcow/remove', {});
}

function dnsSaveMailcow(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const value = function (name) { return form.elements.namedItem(name).value.trim(); };
  const share = value('dkimMode') === 'share';
  dnsPost('/api/mailcow', {
    url: value('url'), key: value('key'), sharedMailbox: value('sharedMailbox'),
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

// --- panel hostname ---------------------------------------------------------

/** Eight unambiguous lowercase characters (~39 bits), starting with a letter, with no wordlist to scan. */
function dnsRandomLabel() {
  const first = 'abcdefghjkmnpqrstuvwxyz';
  const rest = 'abcdefghjkmnpqrstuvwxyz23456789';
  const pick = function (alphabet) {
    const limit = Math.floor(256 / alphabet.length) * alphabet.length;
    const buf = new Uint8Array(1);
    let n = 256;
    while (n >= limit) {
      crypto.getRandomValues(buf);
      n = buf[0];
    }
    return alphabet[n % alphabet.length];
  };
  let out = pick(first);
  for (let i = 1; i < 8; i++) out += pick(rest);
  return out;
}

function dnsPanelBase(value, savedBase) {
  const clean = value.trim().toLowerCase().replace(/\.+$/, '');
  const zones = (dnsState.zones || []).slice().sort(function (a, b) { return b.length - a.length; });
  if (clean) {
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(clean)) return '';
    const matched = zones.find(function (zone) { return clean === zone || clean.endsWith('.' + zone); });
    if (matched) return matched;
    if (savedBase && (clean === savedBase || clean.endsWith('.' + savedBase))) return savedBase;
    const planZone = dnsState.panelHost && dnsState.panelHost.plan && dnsState.panelHost.plan.zone && dnsState.panelHost.plan.zone.name;
    if (planZone && (clean === planZone || clean.endsWith('.' + planZone))) return planZone;
    return clean;
  }
  return zones.length === 1 ? zones[0] : '';
}

function dnsRandomPanelHost() {
  const input = CLP_ROOT.getElementById('dns-panel-host-name');
  const base = dnsPanelBase(input.value, input.dataset.randomBase || '');
  if (!base) {
    input.focus();
    notify('Enter your domain first, such as example.com, then choose Random.', 'warn');
    return;
  }
  input.dataset.randomBase = base;
  input.value = dnsRandomLabel() + '.' + base;
  input.focus();
}

function dnsSavePanelHost(event) {
  event.preventDefault();
  const name = event.currentTarget.elements.namedItem('name').value.trim();
  // An emptied field is Remove, with its confirmation; with nothing set, there is nothing to save.
  if (!name) {
    if (dnsState.panelHost) dnsRemovePanelHost();
    return;
  }
  dnsPost('/api/panel-host', { name: name });
}

function dnsAdoptPanelHost(name) {
  dnsPost('/api/panel-host', { name: name });
}

async function dnsRemovePanelHost() {
  const viaWildcard = Boolean(dnsState.panelHost.plan && dnsState.panelHost.plan.wildcard);
  const panelProvider = dnsState.panelHost.plan && dnsState.panelHost.plan.zone && dnsState.panelHost.plan.zone.provider === 'powerdns'
    ? 'PowerDNS'
    : dnsProviderLabel();
  const accepted = await confirmAction({
    title: 'Remove the panel hostname?',
    text: 'DNS stops managing ' + dnsState.panelHost.name + '.' + (viaWildcard ? ' ' : ' Any explicit records stay in ' + panelProvider + ', listed with the records of deleted sites, and ') + 'CloudPanel keeps its custom domain.',
    confirmLabel: 'Remove', danger: true,
  });
  if (accepted) dnsPost('/api/panel-host', { name: null });
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

paintFleetSelection();

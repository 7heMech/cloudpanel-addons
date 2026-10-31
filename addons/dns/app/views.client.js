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
    '<td data-label="TTL" class="dns-ttl dns-adv"><select data-field="ttl" aria-label="TTL of record ' + n + '"' + (row.proxied ? ' disabled' : '') + '>' +
      DNS_TTLS.map(function (ttl) { return '<option value="' + ttl[0] + '"' + (ttl[0] === row.ttl ? ' selected' : '') + '>' + ttl[1] + '</option>'; }).join('') + '</select></td>' +
    '<td data-label="Apex only" class="dns-flag dns-adv"><label class="switch"><input data-field="apexOnly" type="checkbox" aria-label="Record ' + n + ' only at the zone apex"' +
      (row.apexOnly ? ' checked' : '') + '><span></span></label></td>' +
    '<td data-label="Proxy" class="dns-flag' + (proxiable ? '' : ' dns-unproxiable') + '"><label class="switch"><input data-field="proxied" type="checkbox" aria-label="Proxy record ' + n + '"' +
      (row.proxied ? ' checked' : '') + (proxiable ? '' : ' disabled') + '><span></span></label></td>' +
    '<td class="dns-remove"><button class="btn dns-remove-btn" type="button" aria-label="Remove record ' + n + '" onclick="dnsRemoveRow(' + index + ')">×</button></td>';
}

function dnsRenderRows() {
  const body = CLP_ROOT.getElementById('dns-rows');
  const advanced = CLP_ROOT.getElementById('dns-advanced').checked;
  CLP_ROOT.getElementById('dns-rows-table').classList.toggle('dns-show-advanced', advanced);
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

function dnsEditProfile(id) {
  const profile = id ? dnsProfile(id) : null;
  const form = CLP_ROOT.getElementById('dns-profile-form');
  form.reset();
  form.elements.namedItem('id').value = profile ? profile.id : '';
  form.elements.namedItem('name').value = profile ? profile.name : '';
  const zone = profile ? profile.zone : { ssl: null, alwaysHttps: null, acmeFullSsl: false, webmailFullSsl: false, skipFirewallIps: [] };
  form.elements.namedItem('mailcow').checked = Boolean(profile && profile.mailcow);
  form.elements.namedItem('ssl').value = zone.ssl || '';
  form.elements.namedItem('alwaysHttps').value = zone.alwaysHttps === null ? '' : zone.alwaysHttps ? 'on' : 'off';
  form.elements.namedItem('acmeFullSsl').checked = zone.acmeFullSsl;
  form.elements.namedItem('webmailFullSsl').checked = zone.webmailFullSsl;
  form.elements.namedItem('skipFirewallIps').value = zone.skipFirewallIps.join('\n');
  CLP_ROOT.getElementById('dns-preset').innerHTML = '<option value="">Add a preset…</option>' + dnsState.presets.map(function (preset) {
    return '<option value="' + dnsEsc(preset.id) + '">' + dnsEsc(preset.label) + '</option>';
  }).join('');
  dnsRowsState = profile ? profile.records.map(function (record) { return Object.assign({}, record); }) : [];
  dnsLastField = null;
  CLP_ROOT.getElementById('dns-advanced').checked = false;
  CLP_ROOT.getElementById('dns-zone-details').open = false;
  dnsSyncProfileSections();
  dnsRenderRows();
  CLP_ROOT.getElementById('dns-profile-heading').textContent = profile ? 'Edit ' + profile.name : 'New profile';
  dnsOpen('dns-profile-dialog');
}

/** Mailcow shows once Mailcow is set up or the profile uses it; the zone's summary follows its fields. */
function dnsSyncProfileSections() {
  const form = CLP_ROOT.getElementById('dns-profile-form');
  const value = function (name) { return form.elements.namedItem(name).value; };
  CLP_ROOT.getElementById('dns-mailcow-section').hidden = !dnsState.mailcow.url && !form.elements.namedItem('mailcow').checked;
  const ssl = form.elements.namedItem('ssl');
  const parts = [];
  if (value('ssl')) parts.push(ssl.options[ssl.selectedIndex].text);
  if (value('alwaysHttps')) parts.push('Always HTTPS ' + value('alwaysHttps'));
  const rules = [form.elements.namedItem('acmeFullSsl').checked && "Let's Encrypt", form.elements.namedItem('webmailFullSsl').checked && 'webmail',
    value('skipFirewallIps').trim() && 'firewall skip'].filter(Boolean);
  if (rules.length) parts.push('Rules: ' + rules.join(', '));
  CLP_ROOT.getElementById('dns-zone-summary').textContent = parts.join(' · ') || 'Left as it is';
}

function dnsSaveProfile(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const value = function (name) { return form.elements.namedItem(name).value; };
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
  // A held site placed in its own profile again is reviewed.
  const moving = rows.filter(function (row) { return (row.dataset.profileId || '') !== (id || '') || (id && row.dataset.held); });
  if (!moving.length) return notify('Those sites are already there; nothing to change.', 'ok');
  const profile = id ? dnsProfile(id) : null;
  if (!profile || !dnsState.automatic) {
    const accepted = await confirmAction({
      title: profile ? 'Put ' + plural(moving.length, 'site') + ' in ' + profile.name + '?' : 'Stop managing ' + plural(moving.length, 'site') + '?',
      text: profile ? 'DNS asks first: their DNS is checked against it and nothing is changed.' : 'Their DNS is left as it is.',
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
  let html = '<dl class="dns-facts">';
  if (site.redirect) {
    const kept = [site.redirect.keepPath && 'path', site.redirect.keepQuery && 'query string'].filter(Boolean);
    html += '<dt>Redirects to</dt><dd class="dns-change-detail">' + dnsEsc(site.redirect.target) + '</dd>' +
      '<dt>Status</dt><dd>' + site.redirect.status + (kept.length ? ' · keeps the ' + kept.join(' and ') : '') + '</dd>' +
      '<dt>Served by</dt><dd>' + (plan && plan.zone ? 'Cloudflare' : site.redirect.standIn ? 'A stand-in site on this server' : dnsState.connections.length ? 'Cloudflare' : 'A stand-in site on this server, once DNS is Automatic') + '</dd>';
  }
  html += '<dt>Profile</dt><dd>' + dnsEsc(profile ? profile.name : '—') + (profile || site.redirect ? ' · ' + (dnsState.automatic ? 'Automatic' : 'Ask first') : '') + '</dd>';
  if (plan && plan.zone) {
    html += '<dt>Zone</dt><dd>' + dnsEsc(plan.zone.name) + ' · ' + dnsEsc(plan.zone.status) + '</dd>' +
      '<dt>Through</dt><dd>' + dnsEsc(plan.zone.connection) + ' · ' + dnsEsc(plan.zone.account) + '</dd>';
    if (plan.zone.status !== 'active' && plan.zone.nameServers.length) {
      // One button each: a registrar usually has a field per nameserver.
      html += '<dt>Nameservers</dt><dd class="dns-nameservers">' + plan.zone.nameServers.map(function (server) {
        return '<div class="dns-copy"><code>' + dnsEsc(server) + '</code><button class="dns-clip" type="button" title="Copy" aria-label="Copy ' + dnsEsc(server) +
          '" onclick="dnsCopyText(this.previousElementSibling.textContent)">' + DNS_CLIPBOARD + '</button></div>';
      }).join('') + '</dd>';
    }
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
    if (plan.held && !plan.problems.length) {
      html += '<div class="notice">CloudPanel created this site, so its own address records went in straight away. The changes marked below reach further and wait until you review them.</div>';
    }
    if (!plan.problems.length) {
      html += '<h3 class="dns-section">' + (dnsState.automatic ? 'To change' : 'Differences, not changed until DNS is Automatic') + '</h3>' + dnsChanges(plan.changes);
    }
  }
  if (site.redirect) html += '<p><button class="btn" type="button" onclick="dnsEditRedirect(\'' + dnsEsc(domain) + '\')">Edit redirect</button></p>';
  CLP_ROOT.getElementById('dns-site-body').innerHTML = html;
  const pending = plan && !plan.problems.length && plan.changes.some(function (change) { return change.action !== 'note'; });
  const apply = CLP_ROOT.getElementById('dns-site-apply');
  // A redirect is applied by the next check, or through its review when it is held.
  apply.hidden = !(dnsState.automatic && pending && (site.redirect ? plan.held : profile));
  apply.textContent = plan && plan.held ? 'Review changes' : 'Apply now';
  dnsOpen('dns-site-dialog');
}

async function dnsApplySite() {
  const dialog = CLP_ROOT.getElementById('dns-site-dialog');
  const site = dnsState.sites.find(function (candidate) { return candidate.domain === dnsSiteShown; });
  if (site.plan && site.plan.held) return dnsPost('/api/assign', { domains: [site.domain], profileId: site.profileId }, dialog);
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

// --- redirect domains -------------------------------------------------------

function dnsProfileChoices(selected) {
  return '<option value="">No profile</option>' + dnsState.profiles.map(function (profile) {
    return '<option value="' + dnsEsc(profile.id) + '"' + (profile.id === selected ? ' selected' : '') + '>' + dnsEsc(profile.name) + '</option>';
  }).join('');
}

function dnsEditRedirect(source) {
  const site = source ? dnsState.sites.find(function (candidate) { return candidate.domain === source; }) : null;
  const redirect = site && site.redirect;
  const form = CLP_ROOT.getElementById('dns-redirect-form');
  form.reset();
  const field = function (name) { return form.elements.namedItem(name); };
  field('source').value = redirect ? redirect.source : '';
  field('source').readOnly = Boolean(redirect);
  field('target').value = redirect ? redirect.target : '';
  field('status').value = String(redirect ? redirect.status : 301);
  field('keepPath').checked = redirect ? redirect.keepPath : true;
  field('keepQuery').checked = redirect ? redirect.keepQuery : true;
  field('profileId').innerHTML = dnsProfileChoices(redirect ? redirect.profileId : null);
  CLP_ROOT.getElementById('dns-redirect-where').textContent = dnsState.connections.length
    ? 'Cloudflare answers it: a Single Redirect rule and a proxied placeholder record, so this server is never reached.'
    : 'With no Cloudflare connection, a static site on this server answers it and gets a Let\'s Encrypt certificate once the domain points here.';
  CLP_ROOT.getElementById('dns-redirect-delete').hidden = !redirect;
  CLP_ROOT.getElementById('dns-redirect-heading').textContent = redirect ? 'Edit ' + redirect.source : 'Add redirect';
  CLP_ROOT.getElementById('dns-site-dialog').close();
  dnsOpen('dns-redirect-dialog');
}

function dnsSaveRedirect(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const field = function (name) { return form.elements.namedItem(name); };
  dnsPost('/api/redirects', {
    source: field('source').value.trim(), target: field('target').value.trim(), status: Number(field('status').value),
    keepPath: field('keepPath').checked, keepQuery: field('keepQuery').checked, profileId: field('profileId').value || null,
  }, CLP_ROOT.getElementById('dns-redirect-dialog'));
}

async function dnsDeleteRedirect() {
  const dialog = CLP_ROOT.getElementById('dns-redirect-dialog');
  const source = CLP_ROOT.getElementById('dns-redirect-form').elements.namedItem('source').value;
  const site = dnsState.sites.find(function (candidate) { return candidate.domain === source; });
  dialog.close();
  // Once Automatic, deleting a redirect Cloudflare serves is a review of the rule it deletes.
  if (!site.redirect.standIn && dnsState.automatic && dnsState.connections.length) return dnsPost('/api/redirects/delete', { source: source });
  const accepted = await confirmAction({
    title: 'Delete the redirect for ' + source + '?',
    text: site.redirect.standIn
      ? 'Its stand-in site is deleted from this server, so ' + source + ' stops redirecting.'
      : 'DNS stops managing it. Its rule and records stay in Cloudflare and keep redirecting.',
    confirmLabel: 'Delete', danger: true,
  });
  if (accepted) dnsPost('/api/redirects/delete', { source: source });
}

let dnsFound = [];

async function dnsFindRedirects(button) {
  const label = button.textContent;
  button.textContent = 'Reading Cloudflare…';
  const reply = await dnsPost('/api/redirects/find', {});
  button.textContent = label;
  if (reply && reply.data && reply.data.found) dnsShowFound(reply.data.found);
}

function dnsShowFound(found) {
  dnsFound = found.redirects;
  const notes = found.notes.length ? '<div class="alert">' + found.notes.map(dnsEsc).join('<br>') + '</div>' : '';
  CLP_ROOT.getElementById('dns-found-body').innerHTML = notes + (dnsFound.length
    ? '<div class="table-scroll"><table class="fleet-table dns-found-table"><thead><tr><th class="site-select"><input type="checkbox" checked aria-label="Select all" onchange="dnsSelectFound(this.checked)"></th>' +
      '<th>Domain</th><th>Redirects to</th><th>Status</th><th>Keep path</th></tr></thead><tbody>' + dnsFound.map(function (redirect, index) {
        return '<tr><td class="site-select"><input type="checkbox" name="take" value="' + index + '" checked aria-label="Take over ' + dnsEsc(redirect.source) + '"></td>' +
          '<td class="site-cell"><strong>' + dnsEsc(redirect.source) + '</strong>' + (redirect.source === redirect.zone ? '<span class="hint">and www</span>' : '') + '</td>' +
          '<td data-label="Redirects to" class="dns-change-detail">' + dnsEsc(redirect.target) + '</td>' +
          '<td data-label="Status">' + redirect.status + '</td>' +
          '<td data-label="Keep path"><label class="switch"><input type="checkbox" name="keepPath" data-index="' + index + '"' + (redirect.keepPath ? ' checked' : '') +
          ' aria-label="Keep the path for ' + dnsEsc(redirect.source) + '"><span></span></label></td></tr>';
      }).join('') + '</tbody></table></div>'
    : '<div class="empty">No whole-domain redirect rules are waiting to be taken over.</div>');
  CLP_ROOT.getElementById('dns-found-profile').innerHTML = dnsProfileChoices(null);
  CLP_ROOT.getElementById('dns-found-submit').hidden = !dnsFound.length;
  dnsOpen('dns-found-dialog');
}

function dnsSelectFound(on) {
  CLP_ROOT.querySelectorAll('#dns-found-body input[name="take"]').forEach(function (box) { box.checked = on; });
}

function dnsTakeOver(event) {
  event.preventDefault();
  const body = CLP_ROOT.getElementById('dns-found-body');
  const chosen = Array.from(body.querySelectorAll('input[name="take"]:checked')).map(function (box) {
    const redirect = dnsFound[Number(box.value)];
    const keepPath = body.querySelector('input[name="keepPath"][data-index="' + box.value + '"]').checked;
    return { source: redirect.source, target: redirect.target, status: redirect.status, keepPath: keepPath, keepQuery: redirect.keepQuery };
  });
  if (!chosen.length) return dnsDialogError(CLP_ROOT.getElementById('dns-found-dialog'), 'Select at least one redirect.');
  dnsPost('/api/redirects/take-over', { redirects: chosen, profileId: CLP_ROOT.getElementById('dns-found-profile').value || null }, CLP_ROOT.getElementById('dns-found-dialog'));
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
  const ips = [dnsState.server.detected.ipv4, dnsState.server.detected.ipv6].filter(Boolean);
  CLP_ROOT.getElementById('dns-token-ips').textContent = ips.join(' ');
  CLP_ROOT.getElementById('dns-token-ips-hint').hidden = !ips.length;
  CLP_ROOT.getElementById('dns-connection-heading').textContent = connection ? 'Edit ' + connection.label : 'Connect Cloudflare';
  form.querySelector('[type="submit"]').textContent = connection ? 'Save' : 'Connect';
  dnsOpen('dns-connection-dialog');
}

/** Space-separated, as Cloudflare's IP filter takes several addresses at once. */
function dnsCopyText(text) {
  if (!navigator.clipboard || !navigator.clipboard.writeText) return notify('Select ' + text + ' and copy it.', 'warn');
  navigator.clipboard.writeText(text).then(
    function () { notify(text + ' copied.', 'ok'); },
    function () { notify('Select ' + text + ' and copy it.', 'warn'); }
  );
}

function dnsCopyIps() {
  const block = CLP_ROOT.getElementById('dns-token-ips');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(block.textContent).then(
      function () { notify('Addresses copied.', 'ok'); },
      function () { notify('Select the addresses and copy them.', 'warn'); }
    );
    return;
  }
  // No clipboard API: select them so one keystroke finishes the job.
  const range = document.createRange();
  range.selectNodeContents(block);
  window.getSelection().removeAllRanges();
  window.getSelection().addRange(range);
  notify('Press Ctrl+C to copy the selection.', 'warn');
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
  const accepted = await confirmAction({
    title: 'Remove Mailcow?',
    text: 'Its API key is deleted from this server. Sites whose profile sets up Mailcow stop being applied until Mailcow is set up again; their records and Mailcow domains stay as they are.',
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

CLP_ROOT.getElementById('dns-zone-details').addEventListener('change', dnsSyncProfileSections);
CLP_ROOT.getElementById('dns-zone-details').addEventListener('input', dnsSyncProfileSections);

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

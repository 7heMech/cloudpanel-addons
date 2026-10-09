let smtpState = JSON.parse(CLP_ROOT.getElementById('smtp-state')?.textContent || '{}');

function smtpFields(form) {
  return Object.fromEntries(new FormData(form).entries());
}

async function smtpPost(path, body, done) {
  busy(true);
  try {
    const reply = await call(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    for (const dialog of CLP_ROOT.querySelectorAll('dialog[open]')) dialog.close();
    CLP_ROOT.getElementById('smtp-root').innerHTML = reply.html;
    smtpState = reply.data;
    smtpPaintSelection();
    notify(done, 'ok');
    return true;
  } catch (error) {
    notify(error.message, 'error');
    return false;
  } finally {
    busy(false);
  }
}

function smtpProfileName(id) {
  const profile = smtpState.profiles.find(function (item) { return item.id === id; });
  return profile ? profile.name : id;
}

// --- profiles ---------------------------------------------------------------

function smtpSyncDelivery() {
  const form = CLP_ROOT.getElementById('smtp-profile-form');
  const send = form.elements.namedItem('delivery').value === 'send';
  CLP_ROOT.getElementById('smtp-relay-fields').hidden = !send;
  for (const name of ['host', 'port', 'username', 'sender']) form.elements.namedItem(name).required = send;
  // A saved password is kept only for the server and account it was saved for.
  const keeps = form.dataset.savedRelay !== '' && form.dataset.savedRelay ===
    JSON.stringify([form.elements.namedItem('host').value.trim().toLowerCase(), form.elements.namedItem('username').value]);
  const password = form.elements.namedItem('password');
  password.required = send && !keeps;
  password.placeholder = keeps ? 'Leave blank to keep the saved password' : 'SMTP password';
}

function smtpEditProfile(id) {
  const profile = id ? smtpState.profiles.find(function (item) { return item.id === id; }) : null;
  const form = CLP_ROOT.getElementById('smtp-profile-form');
  form.reset();
  form.elements.namedItem('id').value = profile ? profile.id : '';
  form.elements.namedItem('name').value = profile ? profile.name : '';
  form.elements.namedItem('delivery').value = profile && !profile.relay ? 'discard' : 'send';
  form.elements.namedItem('host').value = profile && profile.relay ? profile.relay.host : '';
  form.elements.namedItem('port').value = profile && profile.relay ? profile.relay.port : 587;
  form.elements.namedItem('username').value = profile && profile.relay ? profile.relay.username : '';
  form.elements.namedItem('sender').value = profile ? profile.sender : 'noreply@{site}';
  form.dataset.savedRelay = profile && profile.relay ? JSON.stringify([profile.relay.host, profile.relay.username]) : '';
  smtpSyncDelivery();
  CLP_ROOT.getElementById('smtp-profile-heading').textContent = profile ? 'Edit ' + profile.name : 'New profile';
  CLP_ROOT.getElementById('smtp-profile-dialog').showModal();
}

function smtpSaveProfile(event) {
  event.preventDefault();
  const fields = smtpFields(event.currentTarget);
  const send = fields.delivery === 'send';
  smtpPost('/api/profiles', {
    id: fields.id || null,
    name: fields.name,
    relay: send ? { host: fields.host, port: Number(fields.port), username: fields.username, password: fields.password } : null,
    sender: send ? fields.sender : undefined,
  }, fields.id ? 'Saved ' + fields.name + '. Its sites use it now.' : 'Created ' + fields.name + '. Assign sites to it below.');
}

async function smtpDeleteProfile(id) {
  const profile = smtpState.profiles.find(function (item) { return item.id === id; });
  const details = profile && profile.sites ? [plural(profile.sites, 'site') + ' in it ' + (profile.sites === 1 ? 'stops' : 'stop') + ' being relayed.'] : [];
  const accepted = await confirmAction({
    title: 'Delete ' + smtpProfileName(id) + '?',
    text: 'Its SMTP account and From are removed.',
    details: details,
    confirmLabel: 'Delete',
    danger: true,
  });
  if (accepted) smtpPost('/api/profiles/delete', { id: id }, 'Deleted ' + smtpProfileName(id) + '.');
}

async function smtpSetDefault(select) {
  const id = select.value || null;
  const saved = await smtpPost('/api/default', { profileId: id }, id
    ? 'New sites will join ' + smtpProfileName(id) + '. Existing sites are unchanged.'
    : 'New sites will not be relayed. Existing sites are unchanged.');
  if (!saved) select.value = smtpState.defaultProfileId || '';
}

// --- sites ------------------------------------------------------------------

function smtpPaintSelection() {
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

async function smtpAssignRow(select) {
  const row = select.closest('tr[data-domain]');
  const id = select.value || null;
  const saved = await smtpPost('/api/assign', { domains: [row.dataset.domain], profileId: id }, id
    ? row.dataset.domain + ' now sends through ' + smtpProfileName(id) + '.'
    : row.dataset.domain + ' is no longer relayed.');
  if (!saved) select.value = row.dataset.profileId || '';
}

async function smtpAssignSelected() {
  const rows = selectedRows();
  const picker = CLP_ROOT.getElementById('bulk-profile');
  if (!rows.length) return notify('Select at least one site first.', 'warn');
  if (!picker.value) return notify('Choose a profile to put them in first.', 'warn');
  const id = picker.value === '-' ? null : picker.value;
  const moving = rows.filter(function (row) { return (row.dataset.profileId || '') !== (id || ''); });
  if (!moving.length) return notify('Those sites are already there; nothing to change.', 'ok');
  const accepted = await confirmAction({
    title: id ? 'Send ' + plural(rows.length, 'site') + ' through ' + smtpProfileName(id) + '?' : 'Stop relaying ' + plural(rows.length, 'site') + '?',
    text: id ? 'Their mail goes through this profile\'s SMTP account from now on.' : 'Their mail is no longer relayed.',
    details: [moving.length + ' of the ' + plural(rows.length, 'selected site') + (moving.length === 1 ? ' changes' : ' change') + '; the rest are already there.'],
    confirmLabel: id ? 'Assign' : 'Stop relaying',
    danger: !id,
  });
  if (!accepted) return;
  smtpPost('/api/assign', { domains: rows.map(function (row) { return row.dataset.domain; }), profileId: id }, id
    ? plural(rows.length, 'site') + (rows.length === 1 ? ' now sends' : ' now send') + ' through ' + smtpProfileName(id) + '.'
    : plural(rows.length, 'site') + (rows.length === 1 ? ' is' : ' are') + ' no longer relayed.');
}

function smtpList(value) {
  return String(value || '').split(/[\s,]+/).map(function (part) { return part.trim(); }).filter(Boolean);
}

function smtpSiteGrants(domain) {
  const site = smtpState.sites.find(function (item) { return item.domain === domain; });
  return site ? site.grants : [];
}

/** With no domain, opens on no site, and choosing one shows the domains it already has. */
function smtpEditGrants(domain) {
  const form = CLP_ROOT.getElementById('smtp-grants-form');
  form.elements.namedItem('domain').value = domain;
  smtpLoadGrants();
  CLP_ROOT.getElementById('smtp-grants-dialog').showModal();
}

function smtpLoadGrants() {
  const form = CLP_ROOT.getElementById('smtp-grants-form');
  form.elements.namedItem('domains').value = smtpSiteGrants(form.elements.namedItem('domain').value).join('\n');
}

function smtpSaveGrants(event) {
  event.preventDefault();
  const fields = smtpFields(event.currentTarget);
  const domains = smtpList(fields.domains);
  smtpPost('/api/grants', { domain: fields.domain, domains: domains }, domains.length
    ? fields.domain + ' can now also send as ' + domains.join(', ') + '.'
    : fields.domain + ' now sends only as its own domain.');
}

async function smtpRemoveGrants(domain) {
  const accepted = await confirmAction({
    title: 'Stop ' + domain + ' sending as ' + smtpSiteGrants(domain).join(', ') + '?',
    text: 'It then sends only as its own domain.',
    confirmLabel: 'Remove',
    danger: true,
  });
  if (accepted) smtpPost('/api/grants', { domain: domain, domains: [] }, domain + ' now sends only as its own domain.');
}

async function smtpSendTest(event) {
  event.preventDefault();
  const fields = smtpFields(event.currentTarget);
  busy(true);
  try {
    const result = await call('/api/test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: fields.domain, recipient: fields.recipient, from: fields.from }),
    });
    const data = result.data;
    notify((data.discarded ? 'Postfix accepted the test and its profile discards it, so it will not arrive. ' : 'Postfix queued the test to ' + data.recipient + '. ') +
      (data.sender === data.requested ? 'Its From stays ' + data.sender
        : 'The app asked for ' + data.requested + ' and it was sent as ' + data.sender + (data.replyTo ? ', with Reply-To ' + data.replyTo : '')) + '.', 'ok');
  } catch (error) {
    notify(error.message, 'error');
  } finally {
    busy(false);
  }
}

smtpPaintSelection();

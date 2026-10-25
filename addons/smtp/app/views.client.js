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
    repaintView(CLP_ROOT.getElementById('smtp-root'), reply.html);
    smtpState = reply.data;
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
  if (id === 'dont-send') return "Don't send";
  const profile = smtpState.profiles.find(function (item) { return item.id === id; });
  return profile ? profile.name : id;
}

// --- profiles ---------------------------------------------------------------

/** A saved password is kept only for the server and account it was saved for. */
function smtpSyncPassword() {
  const form = CLP_ROOT.getElementById('smtp-profile-form');
  const keeps = form.dataset.savedRelay !== '' && form.dataset.savedRelay ===
    JSON.stringify([form.elements.namedItem('host').value.trim().toLowerCase(), form.elements.namedItem('username').value]);
  const password = form.elements.namedItem('password');
  password.required = !keeps;
  password.placeholder = keeps ? 'Blank keeps the saved one' : '';
}

function smtpEditProfile(id) {
  const profile = id ? smtpState.profiles.find(function (item) { return item.id === id; }) : null;
  const form = CLP_ROOT.getElementById('smtp-profile-form');
  form.reset();
  form.elements.namedItem('id').value = profile ? profile.id : '';
  form.elements.namedItem('name').value = profile ? profile.name : '';
  form.elements.namedItem('host').value = profile ? profile.relay.host : '';
  form.elements.namedItem('port').value = profile ? profile.relay.port : 587;
  form.elements.namedItem('username').value = profile ? profile.relay.username : '';
  form.elements.namedItem('sender').value = profile ? profile.sender : 'noreply@{site}';
  form.dataset.savedRelay = profile ? JSON.stringify([profile.relay.host, profile.relay.username]) : '';
  form.querySelector('.smtp-from-help').open = false;
  smtpSyncPassword();
  CLP_ROOT.getElementById('smtp-profile-heading').textContent = profile ? 'Edit ' + profile.name : 'New profile';
  CLP_ROOT.getElementById('smtp-profile-dialog').showModal();
}

function smtpSaveProfile(event) {
  event.preventDefault();
  const fields = smtpFields(event.currentTarget);
  smtpPost('/api/profiles', {
    id: fields.id || null,
    name: fields.name,
    relay: { host: fields.host, port: Number(fields.port), username: fields.username, password: fields.password },
    sender: fields.sender,
  }, fields.id ? 'Saved ' + fields.name + '. Its sites use it now.' : 'Created ' + fields.name + '. Assign sites to it above.');
}

async function smtpDeleteProfile(id) {
  const profile = smtpState.profiles.find(function (item) { return item.id === id; });
  const details = profile && profile.sites ? [plural(profile.sites, 'site') + ' in it ' + (profile.sites === 1 ? 'is' : 'are') + ' then sent from this server.'] : [];
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
  const saved = await smtpPost('/api/default', { profileId: id }, id === 'dont-send'
    ? "New sites will join Don't send, so their mail is discarded. Existing sites are unchanged."
    : id ? 'New sites will join ' + smtpProfileName(id) + '. Existing sites are unchanged.'
    : 'New sites will send from this server. Existing sites are unchanged.');
  if (!saved) select.value = smtpState.defaultProfileId || '';
}

// --- sites ------------------------------------------------------------------

function smtpWhere(id) {
  return id === 'dont-send' ? 'is discarded' : id ? 'goes through ' + smtpProfileName(id) : 'is sent from this server';
}

async function smtpAssignRow(select) {
  const row = select.closest('tr[data-domain]');
  const id = select.value || null;
  const saved = await smtpPost('/api/assign', { domains: [row.dataset.domain], profileId: id },
    'Mail from ' + row.dataset.domain + ' now ' + smtpWhere(id) + '.');
  if (!saved) select.value = row.dataset.profileId || '';
}

async function smtpAssignSelected() {
  const rows = selectedRows();
  const picker = CLP_ROOT.getElementById('bulk-profile');
  if (!rows.length) return;
  if (!picker.value) return notify('Choose where their mail goes first.', 'warn');
  const id = picker.value === '-' ? null : picker.value;
  const moving = rows.filter(function (row) { return (row.dataset.profileId || '') !== (id || ''); });
  if (!moving.length) return notify('Those sites are already there; nothing to change.', 'ok');
  const accepted = await confirmAction({
    title: id === 'dont-send' ? 'Discard mail from ' + plural(moving.length, 'site') + '?'
      : id ? 'Send ' + plural(moving.length, 'site') + ' through ' + smtpProfileName(id) + '?'
      : 'Send ' + plural(moving.length, 'site') + ' from this server?',
    text: id === 'dont-send' ? 'Their mail is logged and never delivered.'
      : id ? 'Their mail goes through this profile\'s SMTP account from now on.' : 'Their mail is no longer relayed.',
    confirmLabel: id === 'dont-send' ? 'Discard' : 'Assign',
    danger: !id || id === 'dont-send',
  });
  if (!accepted) return;
  smtpPost('/api/assign', { domains: moving.map(function (row) { return row.dataset.domain; }), profileId: id },
    'Mail from ' + plural(moving.length, 'site') + ' now ' + smtpWhere(id) + '.');
}

function smtpList(value) {
  return String(value || '').split(/[\s,]+/).map(function (part) { return part.trim(); }).filter(Boolean);
}

function smtpSite(domain) {
  return smtpState.sites.find(function (item) { return item.domain === domain; });
}

function smtpEditGrants(domain) {
  const form = CLP_ROOT.getElementById('smtp-grants-form');
  form.elements.namedItem('domain').value = domain;
  form.elements.namedItem('domains').value = (smtpSite(domain) || { grants: [] }).grants.join('\n');
  CLP_ROOT.getElementById('smtp-grants-heading').textContent = 'Extra sending domains for ' + domain;
  CLP_ROOT.getElementById('smtp-grants-dialog').showModal();
}

function smtpSaveGrants(event) {
  event.preventDefault();
  const fields = smtpFields(event.currentTarget);
  const domains = smtpList(fields.domains);
  smtpPost('/api/grants', { domain: fields.domain, domains: domains }, domains.length
    ? fields.domain + ' can now also send as ' + domains.join(', ') + '.'
    : fields.domain + ' now sends only as its own domain.');
}

// --- test -------------------------------------------------------------------

function smtpOpenTest(domain) {
  const form = CLP_ROOT.getElementById('smtp-test-form');
  form.elements.namedItem('domain').value = domain;
  CLP_ROOT.getElementById('smtp-test-heading').textContent = 'Send a test from ' + domain;
  CLP_ROOT.getElementById('smtp-test-result').hidden = true;
  CLP_ROOT.getElementById('smtp-test-dialog').showModal();
}

/** What Postfix did with the test, and what the profile's From made of the one the app asked for. */
function smtpTestOutcome(data) {
  const delivery = data.delivery || { state: 'queued', detail: '' };
  const verdict = {
    sent: ['tone-ok', 'Delivered to the SMTP server.'],
    deferred: ['tone-warn', 'Deferred: ' + delivery.detail],
    bounced: ['tone-bad', 'Refused: ' + delivery.detail],
    queued: ['', 'Still queued: Postfix has not tried it yet.'],
  }[delivery.state];
  const from = data.sender === data.requested ? 'Sent as ' + data.sender + '.'
    : 'The app asked for ' + data.requested + ' and it was sent as ' + data.sender + (data.replyTo ? ', with Reply-To ' + data.replyTo : '') + '.';
  return { tone: verdict[0], verdict: verdict[1], from: from };
}

async function smtpSendTest(event) {
  event.preventDefault();
  const fields = smtpFields(event.currentTarget);
  const result = CLP_ROOT.getElementById('smtp-test-result');
  result.hidden = true;
  busy(true);
  try {
    const reply = await call('/api/test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: fields.domain, recipient: fields.recipient, from: fields.from }),
    });
    const outcome = smtpTestOutcome(reply.data);
    result.textContent = '';
    const verdict = document.createElement('strong');
    verdict.className = outcome.tone;
    verdict.textContent = outcome.verdict;
    const from = document.createElement('span');
    from.className = 'hint';
    from.textContent = outcome.from;
    result.append(verdict, from);
    result.className = 'smtp-test-result';
  } catch (error) {
    result.textContent = error.message;
    result.className = 'smtp-test-result tone-bad';
  } finally {
    result.hidden = false;
    busy(false);
  }
}

paintFleetSelection();

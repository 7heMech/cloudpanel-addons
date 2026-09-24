const smtpState = JSON.parse(document.getElementById('smtp-state')?.textContent || '{}');

function smtpFields(form) {
  return Object.fromEntries(new FormData(form).entries());
}

async function smtpPost(path, body) {
  busy(true);
  try {
    await call(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    location.reload();
  } catch (error) {
    notify(error.message, 'error');
  } finally {
    busy(false);
  }
}

function smtpRelayPayload(fields) {
  return { host: fields.host, port: Number(fields.port), username: fields.username, password: fields.password };
}

function smtpSaveSetup(event) {
  event.preventDefault();
  const fields = smtpFields(event.currentTarget);
  smtpPost('/api/setup', {
    relay: smtpRelayPayload(fields),
    rule: { mode: fields.mode, sender: fields.sender,
      domains: smtpState.defaultRule.domains, addresses: smtpState.defaultRule.addresses },
  });
}

async function smtpSendTest(event) {
  event.preventDefault();
  const fields = smtpFields(event.currentTarget);
  busy(true);
  try {
    const result = await call('/api/test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: fields.domain, recipient: fields.recipient }),
    });
    notify('Postfix queued a test from ' + result.data.sender + ' to ' + result.data.recipient + '.', 'ok');
  } catch (error) {
    notify(error.message, 'error');
  } finally {
    busy(false);
  }
}

function smtpList(value) {
  return String(value || '').split(/[\s,]+/).map(function (part) { return part.trim(); }).filter(Boolean);
}

function smtpEditSite(domain) {
  const site = smtpState.sites.find(function (item) { return item.domain === domain; });
  if (!site) return;
  const form = document.getElementById('smtp-site-form');
  form.elements.namedItem('domain').value = domain;
  form.elements.namedItem('mode').value = site.rule.mode;
  form.elements.namedItem('sender').value = site.rule.sender;
  form.elements.namedItem('domains').value = site.rule.domains.join('\n');
  form.elements.namedItem('addresses').value = site.rule.addresses.join('\n');
  smtpSyncSiteMode();
  document.getElementById('smtp-site-heading').textContent = 'Sender policy for ' + domain;
  document.getElementById('smtp-clear-site').hidden = !site.overridden;
  document.getElementById('smtp-site-dialog').showModal();
}

function smtpSyncSiteMode() {
  const form = document.getElementById('smtp-site-form');
  const allow = form.elements.namedItem('mode').value === 'allow';
  document.getElementById('smtp-site-allow-fields').hidden = !allow;
  for (const name of ['domains', 'addresses']) {
    const field = form.elements.namedItem(name);
    if (!allow) field.value = '';
    field.disabled = !allow;
  }
}

function smtpSaveSite(event) {
  event.preventDefault();
  const fields = smtpFields(event.currentTarget);
  smtpPost('/api/site', { domain: fields.domain, rule: {
    mode: fields.mode, sender: fields.sender,
    domains: smtpList(fields.domains), addresses: smtpList(fields.addresses),
  } });
}

function smtpClearSite() {
  const domain = document.getElementById('smtp-site-form').elements.namedItem('domain').value;
  smtpPost('/api/site/clear', { domain: domain });
}

function smtpEditDomain(domain) {
  const old = domain && smtpState.relayOverrides[domain];
  const form = document.getElementById('smtp-domain-form');
  form.elements.namedItem('domain').value = domain || '';
  form.elements.namedItem('domain').readOnly = Boolean(old);
  form.elements.namedItem('host').value = old ? old.host : '';
  form.elements.namedItem('port').value = old ? old.port : 587;
  form.elements.namedItem('username').value = old ? old.username : '';
  form.elements.namedItem('password').value = '';
  form.elements.namedItem('password').required = !old;
  form.elements.namedItem('password').placeholder = old ? 'Leave blank to keep saved password' : 'New SMTP password';
  document.getElementById('smtp-domain-dialog').showModal();
}

function smtpSaveDomain(event) {
  event.preventDefault();
  const fields = smtpFields(event.currentTarget);
  smtpPost('/api/domain-relay', { domain: fields.domain, relay: smtpRelayPayload(fields) });
}

async function smtpClearDomain(domain) {
  if (!await confirmAction({ title: 'Remove SMTP override?', text: domain + ' will use the global relay credential again.', confirmLabel: 'Remove' })) return;
  smtpPost('/api/domain-relay/clear', { domain: domain });
}

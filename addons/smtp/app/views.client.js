let smtpState = JSON.parse(document.getElementById('smtp-state')?.textContent || '{}');

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
    for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
    document.getElementById('smtp-root').innerHTML = reply.html;
    smtpState = reply.data;
    notify(done, 'ok');
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
    rule: { sender: fields.sender, domains: [] },
  }, 'Saved the relay and default From.');
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
    notify('Postfix queued the test to ' + data.recipient + '. The app asked for ' + data.requested +
      ' and it was sent as ' + data.sender + (data.replyTo ? ', with Reply-To ' + data.replyTo : '') + '.', 'ok');
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
  form.elements.namedItem('sender').value = site.rule.sender;
  form.elements.namedItem('domains').value = site.rule.domains.join('\n');
  smtpSyncSiteDomains();
  document.getElementById('smtp-site-heading').textContent = 'From for ' + domain;
  document.getElementById('smtp-clear-site').hidden = !site.overridden;
  document.getElementById('smtp-site-dialog').showModal();
}

function smtpSyncSiteDomains() {
  const form = document.getElementById('smtp-site-form');
  const keepsDomain = form.elements.namedItem('sender').value.includes('{from.domain}');
  document.getElementById('smtp-site-domains').hidden = !keepsDomain;
  form.elements.namedItem('domains').disabled = !keepsDomain;
}

function smtpSaveSite(event) {
  event.preventDefault();
  const fields = smtpFields(event.currentTarget);
  smtpPost('/api/site', { domain: fields.domain, rule: {
    sender: fields.sender, domains: smtpList(fields.domains),
  } }, 'Saved the From for ' + fields.domain + '.');
}

function smtpClearSite() {
  const domain = document.getElementById('smtp-site-form').elements.namedItem('domain').value;
  smtpPost('/api/site/clear', { domain: domain }, domain + ' uses the default From again.');
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
  smtpPost('/api/domain-relay', { domain: fields.domain, relay: smtpRelayPayload(fields) }, 'Saved the relay for ' + fields.domain + '.');
}

async function smtpClearDomain(domain) {
  if (!await confirmAction({ title: 'Remove SMTP override?', text: domain + ' will use the global relay credential again.', confirmLabel: 'Remove' })) return;
  smtpPost('/api/domain-relay/clear', { domain: domain }, domain + ' uses the global relay again.');
}

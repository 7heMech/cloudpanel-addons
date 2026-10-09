
// The window is opened inside the click, before anything is awaited: one
// opened after a fetch resolves is a popup the browser blocks.
async function signIn(button) {
  const domain = button.dataset.domain;
  const target = window.open('', '_blank');
  clearNotice();
  busy(true);
  try {
    const reply = await call('/api/sign-in', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: domain }),
    });
    submitToken(target, reply.data);
    busy(false);
    notify('Signing in to ' + domain + ' in a new tab.', 'ok');
  } catch (error) {
    if (target) target.close();
    busy(false);
    notify(error.message, 'error');
  }
}

// Posted rather than put in the address bar: a single-use secret in a query
// string is still a secret in the site's access log and in the browser history.
function submitToken(target, data) {
  if (!target) throw new Error('Allow pop-ups for the panel to open WordPress.');
  const form = target.document.createElement('form');
  form.method = 'POST';
  form.action = data.url;
  const field = target.document.createElement('input');
  field.type = 'hidden';
  field.name = data.field;
  field.value = data.token;
  form.appendChild(field);
  target.document.body.appendChild(form);
  form.submit();
}

async function removeHelpers(button) {
  const agreed = await confirmAction({
    title: 'Remove the sign-in helper',
    text: 'Remove the sign-in helper from every site. The next sign-in installs it again.',
    confirmLabel: 'Remove helpers',
  });
  if (!agreed) return;
  clearNotice();
  busy(true);
  try {
    const reply = await call('/api/remove', { method: 'POST' });
    const data = reply.data || {};
    const removed = data.removed || 0;
    const failed = data.failed || [];
    let message = removed
      ? 'Removed from ' + removed + (removed === 1 ? ' site.' : ' sites.')
      : 'No site had the helper installed.';
    if (failed.length) message += ' Still in ' + failed.join('; ') + '.';
    reloadWithFlash(FLASH_KEY, message, failed.length ? 'warn' : 'ok');
  } catch (error) {
    busy(false);
    notify(error.message, 'error');
  }
}

const FLASH_KEY = 'clp-wp-login-flash';

async function setVarnishAutomatic(input) {
  const enabled = input.checked;
  clearNotice();
  busy(true);
  try {
    await call('/api/varnish-settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: enabled }) });
    reloadWithFlash(FLASH_KEY, enabled ? 'Automatic Varnish installation enabled. Check sites now to apply it immediately.' : 'Automatic installation stopped. Existing Varnish plugins remain installed.', 'ok');
  } catch (error) {
    input.checked = !enabled;
    busy(false);
    notify(error.message, 'error');
  }
}

async function setVarnishSite(input) {
  const included = input.checked;
  clearNotice();
  busy(true);
  try {
    await call('/api/varnish-site', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ domain: input.dataset.domain, excluded: !included }) });
    reloadWithFlash(FLASH_KEY, input.dataset.domain + (included ? ' included in automatic installation.' : ' excluded from automatic installation. Its plugin is unchanged.'), 'ok');
  } catch (error) {
    input.checked = !included;
    busy(false);
    notify(error.message, 'error');
  }
}

async function installVarnish(button) {
  const domain = button.dataset.domain;
  const action = button.dataset.varnishAction;
  const label = action === 'activate' ? 'Activate' : action === 'retry' ? 'Retry' : 'Install';
  const text = action === 'activate'
    ? 'Activate CLP Varnish Cache on ' + domain + '. If it is no longer installed, install it first.'
    : action === 'retry'
      ? 'Check CLP Varnish Cache on ' + domain + ' again, then install or activate it if needed.'
      : 'Install and activate the official CLP Varnish Cache plugin on ' + domain + '. An existing installation will be activated.';
  const agreed = await confirmAction({ title: label + ' CLP Varnish Cache', text: text, confirmLabel: label });
  if (!agreed) return;
  await runVarnishCheck('/api/varnish-install', { domain: domain });
}

async function syncVarnishSites(button) {
  await runVarnishCheck('/api/varnish-sync', {});
}

async function runVarnishCheck(path, body) {
  clearNotice();
  busy(true);
  notify('Checking WordPress sites and installing eligible plugins…', 'ok');
  try {
    const reply = await call(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = reply.data;
    let message = data.checked + (data.checked === 1 ? ' site checked. ' : ' sites checked. ') + data.installed + (data.installed === 1 ? ' plugin installed or activated.' : ' plugins installed or activated.');
    if (data.pending) message += ' ' + data.pending + ' remaining; check again to continue.';
    if (data.failed.length) message += ' Failed: ' + data.failed.join('; ');
    reloadWithFlash(FLASH_KEY, message, data.failed.length || data.pending ? 'warn' : 'ok');
  } catch (error) {
    busy(false);
    notify(error.message, 'error');
  }
}

showCarriedFlash(FLASH_KEY);

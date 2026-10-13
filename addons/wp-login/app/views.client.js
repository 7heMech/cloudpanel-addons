
// The window is opened inside the click, before anything is awaited: one
// opened after a fetch resolves is a popup the browser blocks. Agreeing to add
// a bypass is a click of its own, which opens the retry's window and passes it.
async function signIn(button, addBypass, opened) {
  const domain = button.dataset.domain;
  const target = addBypass ? opened : window.open('', '_blank');
  clearNotice();
  busy(true);
  try {
    const reply = await call('/api/sign-in', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: domain, addBypass: addBypass === true }),
    });
    const maintenance = reply.data.maintenance;
    if (maintenance) {
      if (target) target.close();
      busy(false);
      if (!maintenance.canBypass) {
        notify(maintenance.message, 'error');
        return;
      }
      confirmAction({
        title: 'Site in maintenance',
        text: maintenance.message,
        confirmLabel: 'Add IP and sign in',
        onAccept: function () { signIn(button, true, window.open('', '_blank')); },
      });
      return;
    }
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
    text: 'The must-use plugin is deleted from every site it is in. The next sign-in puts it back.',
    confirmLabel: 'Remove',
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

showCarriedFlash(FLASH_KEY);

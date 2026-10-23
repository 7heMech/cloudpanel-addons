// Browsers refuse WebAuthn on an IP address, so say so where it would fail.
function paintAddressWarning() {
  const warning = CLP_ROOT.getElementById('sk-address');
  if (warning) warning.hidden = !/^[\d.]+$|^\[/.test(location.hostname);
}
paintAddressWarning();

// Saved as a whole on every change, and repainted from what root stored.
async function saveSettings(input) {
  const roles = ['ROLE_ADMIN', 'ROLE_SITE_MANAGER', 'ROLE_USER'].filter(function (role) {
    return CLP_ROOT.getElementById('role-' + role).checked;
  });
  busy(true);
  try {
    const reply = await call('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roles: roles, syncedPasskeys: CLP_ROOT.getElementById('synced-passkeys').checked }),
    });
    repaintView(CLP_ROOT.getElementById('clp-content'), reply.html);
    paintAddressWarning();
    notify('Settings saved.', 'ok');
  } catch (error) {
    input.checked = !input.checked;
    notify(error.message, 'error');
  } finally {
    busy(false);
  }
}

async function revokeKey(button) {
  const user = button.dataset.user;
  const agreed = await confirmAction({
    title: 'Remove security key?',
    text: user + ' will no longer be able to sign in with "' + button.dataset.name + '". Their password still works.',
    confirmLabel: 'Remove key',
    danger: true,
  });
  if (!agreed) return;
  busy(true);
  try {
    const reply = await call('/api/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: user, id: button.dataset.id }),
    });
    repaintView(CLP_ROOT.getElementById('clp-content'), reply.html);
    paintAddressWarning();
    notify('Key removed.', 'ok');
  } catch (error) {
    notify(error.message, 'error');
  } finally {
    busy(false);
  }
}

// Browsers refuse WebAuthn on an IP address, so say so where it would fail. A
// key works only at the address it was added on, so mark the ones from another.
function paintAddressWarning() {
  const warning = CLP_ROOT.getElementById('sk-address');
  if (warning) warning.hidden = !/^[\d.]+$|^\[/.test(location.hostname);
  for (const cell of CLP_ROOT.querySelectorAll('.sk-host')) {
    cell.classList.toggle('is-elsewhere', cell.dataset.host !== location.host);
  }
}
paintAddressWarning();

// Search and the review filter only hide rows; every key is already on the page.
function filterKeys() {
  const find = CLP_ROOT.getElementById('sk-find').value.trim().toLowerCase();
  const show = CLP_ROOT.getElementById('sk-show').value;
  let keys = 0;
  let users = 0;
  for (const group of CLP_ROOT.querySelectorAll('.sk-group')) {
    let shown = 0;
    for (const row of group.querySelectorAll('.sk-key')) {
      const visible = (!find || row.dataset.find.includes(find))
        && (show === 'all'
          || (show === 'stale' && row.classList.contains('is-stale'))
          || (show === 'synced' && row.hasAttribute('data-synced'))
          || (show === 'inactive' && group.hasAttribute('data-inactive')));
      row.hidden = !visible;
      if (visible) shown++;
    }
    group.hidden = shown === 0;
    keys += shown;
    if (shown) users++;
  }
  const summary = CLP_ROOT.getElementById('sk-summary');
  const filtered = find || show !== 'all';
  summary.textContent = filtered
    ? keys + ' key' + (keys === 1 ? '' : 's') + ' for ' + users + ' user' + (users === 1 ? '' : 's') + ' shown'
    : summary.dataset.all;
  CLP_ROOT.getElementById('sk-none').hidden = keys > 0;
}

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

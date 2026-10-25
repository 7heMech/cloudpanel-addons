function rowState(row) {
  return {
    domain: row.dataset.domain,
    enabled: row.dataset.enabled === 'true',
    selected: Boolean(row.querySelector('.site-checkbox') && row.querySelector('.site-checkbox').checked),
  };
}

/** The state the server holds now, or why it could not be read. */
async function readState() {
  try {
    const reply = await call('/api/sites');
    return { ok: true, html: reply.html };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

// Reading the new state is part of the change, not something after it: the
// controls stay disabled until it is in hand, so a second click cannot start a
// change whose reply arrives first and paints the older state over the newer
// one. Painting waits for busy() to release, because busy() restores every
// control to what it was disabled as, which would undo what the paint decided.
async function change(path, body, failedAs) {
  clearNotice();
  busy(true);
  let failure = '';
  let state;
  try {
    await call(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (error) {
    failure = error.message;
  }
  try {
    state = await readState();
  } finally {
    busy(false);
  }
  if (state.ok) repaintView(CLP_ROOT.getElementById('clp-content'), state.html);
  if (failure) {
    notify(failedAs + failure, 'error');
    return null;
  }
  return state;
}

async function setDomains(domains, enabled) {
  if (!domains.length) return;
  const state = await change('/api/sites', { domains: domains, enabled: enabled }, 'Could not update the Cloudflare setting: ');
  if (!state) return;
  const one = domains.length === 1;
  const done = plural(domains.length, 'site') + (enabled ? ' now allow' : ' no longer allow') + (one ? 's' : '') + ' Cloudflare traffic only.';
  // The change landed; what is on screen is what could not be refreshed, and
  // saying only that it worked would hide rows that are no longer true.
  notify(state.ok ? done : done + ' The page may be out of date: ' + state.error, state.ok ? 'ok' : 'warn');
}

async function setSelectedSites(enabled) {
  const rows = siteRows().map(rowState).filter(function (row) { return row.selected; });
  if (!rows.length) return;
  const changing = rows.filter(function (row) { return row.enabled !== enabled; }).length;
  if (changing === 0) {
    notify('The selected sites are already ' + (enabled ? 'on' : 'off') + '; nothing to change.', 'ok');
    return;
  }
  const subject = plural(changing, 'site');
  const accepted = await confirmAction({
    title: enabled ? 'Allow only Cloudflare to reach ' + subject + '?' : 'Let any address reach ' + subject + ' again?',
    text: enabled
      ? 'A site not proxied through Cloudflare stops answering its visitors.'
      : 'These sites accept traffic from any address again.',
    confirmLabel: enabled ? 'Enable' : 'Disable',
    danger: enabled,
  });
  if (accepted) await setDomains(rows.map(function (row) { return row.domain; }), enabled);
}

// A single row is the common correction after a fleet-wide change, so it acts
// at once rather than behind a confirmation.
async function setOne(input) {
  const row = input.closest('tr[data-domain]');
  if (row) await setDomains([row.dataset.domain], input.checked);
}

async function setAutomatic(input) {
  const enabled = input.checked;
  const state = await change('/api/policy', { enabled: enabled }, 'Could not update the automatic policy: ');
  if (!state) return;
  const done = enabled
    ? 'New sites will allow Cloudflare only. Existing sites are unchanged.'
    : 'New sites are left alone. Existing sites are unchanged.';
  notify(state.ok ? done : done + ' The page may be out of date: ' + state.error, state.ok ? 'ok' : 'warn');
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', paintFleetSelection);
else paintFleetSelection();

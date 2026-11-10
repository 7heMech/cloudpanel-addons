function rowState(row) {
  return {
    domain: row.dataset.domain,
    enabled: row.dataset.enabled === 'true',
    selected: Boolean(row.querySelector('.site-checkbox') && row.querySelector('.site-checkbox').checked),
  };
}

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
  let reply = null;
  try {
    reply = await call(path, {
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
  state.reply = reply && reply.data;
  return state;
}

async function repaint() {
  const state = await readState();
  if (state.ok) repaintView(CLP_ROOT.getElementById('clp-content'), state.html);
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

async function setProtocols(input) {
  const enabled = input.checked;
  const state = await change('/api/protocols', { enabled: enabled }, 'Could not switch the protocols: ');
  if (!state) return;
  const done = enabled
    ? 'Rules on CloudPanel\'s Firewall page have a Protocol again.'
    : 'Every rule on CloudPanel\'s Firewall page is TCP again. The choices are kept.';
  notify(state.ok ? done : done + ' The page may be out of date: ' + state.error, state.ok ? 'ok' : 'warn');
}

function hetznerNotice(state) {
  const done = (state.reply && state.reply.notice) || 'Done.';
  notify(state.ok ? done : done + ' The page may be out of date: ' + state.error, state.ok ? 'ok' : 'warn');
}

async function connectHetzner(event) {
  event.preventDefault();
  const input = CLP_ROOT.getElementById('hetzner-token');
  const token = input.value.trim();
  input.value = '';
  if (!token) return;
  const state = await change('/api/hetzner/token', { token: token }, 'Could not connect Hetzner: ');
  if (state) hetznerNotice(state);
}

function showHetznerTokenForm() {
  const form = CLP_ROOT.getElementById('hetzner-token-form');
  form.hidden = false;
  CLP_ROOT.getElementById('hetzner-token').focus();
}

async function removeHetznerToken() {
  const accepted = await confirmAction({
    title: 'Remove the Hetzner token?',
    text: 'Firewall stops reading Hetzner. The token stays valid in Hetzner until you delete it there.',
    confirmLabel: 'Remove', danger: true,
  });
  if (!accepted) return;
  const state = await change('/api/hetzner/token/remove', {}, 'Could not remove the token: ');
  if (state) hetznerNotice(state);
}

// Root answers the first request with what the change would do, or refuses
// it; only the review it sent, confirmed, makes the change.
async function setHetzner(input, role) {
  const enabled = input.checked;
  input.checked = !enabled;
  clearNotice();
  busy(true);
  let reply = null;
  let failure = '';
  try {
    reply = await call('/api/hetzner/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: role, enabled: enabled }),
    });
  } catch (error) {
    failure = error.message;
  } finally {
    busy(false);
  }
  if (failure) {
    notify(failure, 'error');
    return;
  }
  const review = reply.data && reply.data.review;
  if (!review) {
    const state = await repaint();
    hetznerNotice(Object.assign(state, { reply: reply.data }));
    return;
  }
  const accepted = await confirmAction({
    title: review.title, text: review.text, details: review.details,
    confirmLabel: review.confirmLabel, danger: review.danger,
  });
  if (!accepted) return;
  const state = await change('/api/hetzner/switch', { role: role, enabled: enabled, confirm: review.digest }, 'Could not switch: ');
  if (!state) return;
  if (state.reply && state.reply.review) {
    notify('What this change would do has changed since you confirmed it; switch it again to see the new review.', 'warn');
    return;
  }
  hetznerNotice(state);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', paintFleetSelection);
else paintFleetSelection();

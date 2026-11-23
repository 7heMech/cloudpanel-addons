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
  if (state.ok) {
    repaintView(CLP_ROOT.getElementById('clp-content'), state.html);
    loadPanelGate();
  }
  if (failure) {
    notify(failedAs + failure, 'error');
    return null;
  }
  state.reply = reply && reply.data;
  return state;
}

async function repaint() {
  const state = await readState();
  if (state.ok) {
    repaintView(CLP_ROOT.getElementById('clp-content'), state.html);
    loadPanelGate();
  }
  return state;
}

// A gate that is off needs Cloudflare read to say what it lacks, so its card
// follows the page rather than holding the site table back. A repaint within
// a minute reuses that read; switching the gate drops it.
let panelGateRead = null;

async function loadPanelGate() {
  const card = CLP_ROOT.getElementById('panel-gate-card');
  if (!card || !card.hasAttribute('data-pending')) return;
  const swap = function (html) {
    const current = CLP_ROOT.getElementById('panel-gate-card');
    if (current && current.hasAttribute('data-pending') && html) current.outerHTML = html;
  };
  if (panelGateRead && Date.now() - panelGateRead.at < 60000) {
    swap(panelGateRead.html);
    return;
  }
  try {
    const reply = await call('/api/panel-gate');
    panelGateRead = { at: Date.now(), html: reply.html };
    swap(reply.html);
  } catch (error) {
    const status = card.querySelector('[role="status"]');
    if (status) status.textContent = 'The Panel gate could not be read: ' + error.message;
  }
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

function replyNotice(state) {
  const done = (state.reply && state.reply.notice) || 'Done.';
  notify(state.ok ? done : done + ' The page may be out of date: ' + state.error, state.ok ? 'ok' : 'warn');
}

// The dialog stays open, with the token, until Hetzner accepts it; closing it clears both.
async function connectHetzner(event) {
  event.preventDefault();
  const input = CLP_ROOT.getElementById('hetzner-token');
  const problem = CLP_ROOT.getElementById('hz-connect-error');
  const token = input.value.trim();
  if (!token) return;
  clearNotice();
  problem.hidden = true;
  busy(true);
  let reply = null;
  let failure = '';
  try {
    reply = await call('/api/hetzner/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token }),
    });
  } catch (error) {
    failure = error.message;
  } finally {
    busy(false);
  }
  const dialog = CLP_ROOT.getElementById('hz-connect-dialog');
  if (failure) {
    // Escape or the backdrop may have closed it meanwhile.
    if (!dialog.open) {
      notify('Could not connect Hetzner: ' + failure, 'error');
      return;
    }
    problem.textContent = failure;
    problem.hidden = false;
    input.focus();
    return;
  }
  dialog.close();
  const state = await repaint();
  replyNotice(Object.assign(state, { reply: reply.data }));
}

function resetHetznerConnect(dialog) {
  dialog.querySelector('#hetzner-token').value = '';
  dialog.querySelector('#hz-connect-error').hidden = true;
}

async function removeHetznerToken() {
  const accepted = await confirmAction({
    title: 'Remove the Hetzner token?',
    text: 'Firewall stops reading Hetzner. The token stays valid in Hetzner until you delete it there.',
    confirmLabel: 'Remove', danger: true,
  });
  if (!accepted) return;
  const state = await change('/api/hetzner/token/remove', {}, 'Could not remove the token: ');
  if (state) replyNotice(state);
}

// netcup's device sign-in: root asks netcup for a code, the operator grants
// access at netcup with it, and the page asks root, as often as netcup
// allows, whether that happened. Closing the dialog stops asking; the code
// then expires at netcup.
let netcupSignIn = null;

function stopNetcupConnect(run) {
  const stopping = run || netcupSignIn;
  if (stopping) stopping.stopped = true;
  if (netcupSignIn === stopping) netcupSignIn = null;
}

async function startNetcupConnect() {
  stopNetcupConnect();
  const run = { stopped: false };
  netcupSignIn = run;
  clearNotice();
  busy(true);
  let reply = null;
  let failure = '';
  try {
    reply = await call('/api/netcup/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  } catch (error) {
    failure = error.message;
  } finally {
    busy(false);
  }
  if (failure) {
    stopNetcupConnect(run);
    notify('Could not start netcup\'s sign-in: ' + failure, 'error');
    return;
  }
  if (run.stopped) return;
  const byId = function (id) { return CLP_ROOT.getElementById(id); };
  const dialog = byId('nc-connect-dialog');
  const status = byId('nc-connect-status');
  const problem = byId('nc-connect-error');
  const sign = reply.data;
  byId('nc-connect-code').textContent = sign.userCode;
  byId('nc-connect-link').href = sign.verificationUri;
  status.textContent = 'Waiting for netcup…';
  status.hidden = false;
  problem.hidden = true;
  dialog.showModal();
  const fail = function (message) {
    status.hidden = true;
    problem.textContent = message;
    problem.hidden = false;
  };
  let interval = sign.interval;
  const deadline = Date.now() + sign.expiresIn * 1000;
  while (Date.now() < deadline) {
    await new Promise(function (resolve) { setTimeout(resolve, interval * 1000); });
    if (run.stopped) return;
    let polled = null;
    try {
      polled = await call('/api/netcup/poll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    } catch (error) {
      if (!run.stopped) fail(error.message);
      stopNetcupConnect(run);
      return;
    }
    const data = polled.data || {};
    if (data.pending) {
      if (run.stopped) return;
      interval = data.interval || interval;
      continue;
    }
    // Granted: refresh unless a newer sign-in now owns the shared dialog.
    const owns = netcupSignIn === run;
    if (!owns && netcupSignIn) return;
    stopNetcupConnect(run);
    if (owns && dialog.open) dialog.close();
    const state = await readState();
    if (netcupSignIn) return;
    if (state.ok) {
      repaintView(CLP_ROOT.getElementById('clp-content'), state.html);
      loadPanelGate();
    }
    replyNotice(Object.assign(state, { reply: data }));
    return;
  }
  if (!run.stopped) fail('The code expired before access was granted; connect again.');
  stopNetcupConnect(run);
}

async function removeNetcupSignIn() {
  const accepted = await confirmAction({
    title: 'Disconnect netcup?',
    text: 'Firewall stops reading netcup, and asks netcup to revoke the sign-in.',
    confirmLabel: 'Disconnect', danger: true,
  });
  if (!accepted) return;
  const state = await change('/api/netcup/remove', {}, 'Could not disconnect netcup: ');
  if (state) replyNotice(state);
}

// The review in sections: what changes, the names that stop answering, what
// leaves it without effect or closes, and the way back.
function showHetznerReview(review) {
  const byId = function (id) { return CLP_ROOT.getElementById(id); };
  const dialog = byId('hz-review');
  byId('hz-review-title').textContent = review.title;
  byId('hz-review-text').textContent = review.text;
  const list = byId('hz-review-list');
  list.textContent = '';
  review.details.forEach(function (line) {
    const at = line.indexOf(' resolves to ');
    const item = document.createElement('li');
    const host = document.createElement('strong');
    host.textContent = at < 0 ? line : line.slice(0, at);
    item.appendChild(host);
    if (at >= 0) {
      const where = document.createElement('span');
      where.className = 'hint';
      where.textContent = line.slice(at + 1);
      item.appendChild(where);
    }
    list.appendChild(item);
  });
  byId('hz-review-label').textContent = review.listLabel;
  byId('hz-review-list-wrap').hidden = review.details.length === 0;
  const warn = byId('hz-review-warn');
  warn.textContent = '';
  review.warnings.forEach(function (line) {
    const paragraph = document.createElement('p');
    paragraph.textContent = line;
    warn.appendChild(paragraph);
  });
  if (review.closes.length) {
    const closes = document.createElement('ul');
    review.closes.forEach(function (line) {
      const item = document.createElement('li');
      item.textContent = line;
      closes.appendChild(item);
    });
    warn.appendChild(closes);
  }
  warn.hidden = warn.childElementCount === 0;
  const back = byId('hz-review-way-back');
  back.textContent = review.wayBack;
  back.hidden = !review.wayBack;
  const typed = byId('hz-review-typed');
  typed.value = '';
  byId('hz-review-typed-field').hidden = !review.typed;
  byId('hz-review-typed-word').textContent = review.typed;
  const accept = byId('hz-review-accept');
  accept.textContent = review.confirmLabel;
  accept.className = review.danger ? 'btn btn-danger' : 'btn btn-primary';
  const sync = function () { accept.disabled = Boolean(review.typed) && typed.value.trim() !== review.typed; };
  typed.oninput = sync;
  sync();
  dialog.returnValue = '';
  dialog.showModal();
  if (review.typed) typed.focus();
  return new Promise(function (resolve) {
    dialog.addEventListener('close', function () { resolve(dialog.returnValue === 'accept'); }, { once: true });
  });
}

// Root answers the first request with what the change would do, or refuses
// it; only the review it sent, confirmed, makes the change. `accept` shows
// the review and answers what to send with the confirmation, or null.
async function reviewedSwitch(input, path, body, accept) {
  const enabled = input.checked;
  input.checked = !enabled;
  clearNotice();
  busy(true);
  let reply = null;
  let failure = '';
  try {
    reply = await call(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ enabled: enabled }, body)),
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
    replyNotice(Object.assign(state, { reply: reply.data }));
    return;
  }
  const extra = await accept(review);
  if (!extra) return;
  const state = await change(path, Object.assign({ enabled: enabled, confirm: review.digest }, body, extra), 'Could not switch: ');
  if (!state) return;
  if (state.reply && state.reply.review) {
    notify('What this change would do has changed since you confirmed it; switch it again to see the new review.', 'warn');
    return;
  }
  replyNotice(state);
}

function setCloud(input, provider, role) {
  return reviewedSwitch(input, '/api/' + provider + '/switch', { role: role }, async function (review) {
    if (!await showHetznerReview(review)) return null;
    return { typed: CLP_ROOT.getElementById('hz-review-typed').value.trim() };
  });
}

function setPanelGate(input) {
  panelGateRead = null;
  return reviewedSwitch(input, '/api/panel-gate', {}, async function (review) {
    const accepted = await confirmAction({
      title: review.title, text: review.text, details: review.details,
      confirmLabel: review.confirmLabel, danger: review.danger,
    });
    return accepted ? {} : null;
  });
}

function firewallReady() {
  paintFleetSelection();
  loadPanelGate();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', firewallReady);
else firewallReady();

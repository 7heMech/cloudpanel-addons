function siteRows() {
  return Array.from(document.querySelectorAll('tr[data-domain]'));
}

function rowState(row) {
  return {
    domain: row.dataset.domain,
    enabled: row.dataset.enabled === 'true',
    excluded: row.dataset.excluded === 'true',
    selected: Boolean(row.querySelector('.site-checkbox') && row.querySelector('.site-checkbox').checked),
  };
}

function selectedRows() {
  return siteRows().filter(function (row) {
    const box = row.querySelector('.site-checkbox');
    return box && box.checked;
  });
}

function automaticOn() {
  const policy = document.getElementById('automatic-policy');
  return Boolean(policy && policy.checked);
}

function plural(count, word) {
  return count + ' ' + word + (count === 1 ? '' : 's');
}

function paintSummary() {
  const rowElements = siteRows();
  rowElements.forEach(function (row) {
    const box = row.querySelector('.site-checkbox');
    row.tabIndex = 0;
    row.setAttribute('aria-selected', String(Boolean(box && box.checked)));
  });
  const rows = rowElements.map(rowState);
  const on = rows.filter(function (row) { return row.enabled; }).length;
  const summary = document.getElementById('cf-summary');
  if (summary) {
    summary.textContent = rows.length === 0
      ? 'No sites found in CloudPanel.'
      : on + ' of ' + plural(rows.length, 'site') + ' allow Cloudflare only.';
  }
  const selected = selectedRows().length;
  const note = document.getElementById('cf-selection');
  if (note) note.textContent = selected === 0 ? 'No sites selected' : selected + ' of ' + rows.length + ' selected';
  ['enable-selected', 'disable-selected'].forEach(function (id) {
    const button = document.getElementById(id);
    if (button) button.disabled = selected === 0;
  });
  ['enable-all', 'disable-all'].forEach(function (id) {
    const button = document.getElementById(id);
    if (button) button.disabled = rows.length === 0;
  });
  const all = document.getElementById('select-all');
  if (all) {
    all.checked = rows.length > 0 && selected === rows.length;
    all.indeterminate = selected > 0 && selected < rows.length;
  }
  const allBtn = document.getElementById('select-all-btn');
  if (allBtn) {
    allBtn.disabled = rows.length === 0;
    allBtn.textContent = rows.length > 0 && selected === rows.length ? 'Deselect all' : 'Select all';
  }
}

function selectAllSites(checked) {
  document.querySelectorAll('.site-checkbox').forEach(function (box) { box.checked = checked; });
  paintSummary();
}

function toggleAllSites() {
  const rows = siteRows();
  selectAllSites(selectedRows().length < rows.length);
}

// Repaint from the server's answer rather than from what was asked for: the
// row that failed, the row somebody else changed and the exception bookkeeping
// all come back in the same reply.
function applyState(state) {
  const rows = new Map(siteRows().map(function (row) { return [row.dataset.domain, row]; }));
  const domains = (state.sites || []).map(function (site) { return site.domain; });
  if (domains.length !== rows.size || domains.some(function (domain) { return !rows.has(domain); })) {
    // The inventory itself moved; only a reload can draw rows that are not here.
    location.reload();
    return;
  }
  state.sites.forEach(function (site) {
    const row = rows.get(site.domain);
    row.dataset.enabled = String(site.enabled);
    row.dataset.excluded = String(site.excludedFromAutomatic);
    const input = row.querySelector('.site-switch');
    if (input) input.checked = site.enabled;
  });
  const policy = document.getElementById('automatic-policy');
  if (policy) policy.checked = Boolean(state.autoEnableNewSites);
  paintSummary();
}

/** The state the server holds now, or why it could not be read. */
async function readState() {
  try {
    return { ok: true, data: (await call('/api/sites')).data };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

// Reading the new state is part of the change, not something after it: the
// controls stay disabled until it is in hand, so a second click cannot start a
// change whose reply arrives first and paints the older state over the newer
// one. Painting waits for busy() to release, because busy() restores every
// control to what it was disabled as, which would undo what the paint decided.
async function setDomains(domains, enabled) {
  if (!domains.length) return false;
  clearNotice();
  busy(true);
  let failure = '';
  let state;
  try {
    await call('/api/sites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domains: domains, enabled: enabled }),
    });
  } catch (error) {
    failure = error.message;
  }
  try {
    state = await readState();
  } finally {
    busy(false);
  }
  if (state.ok) applyState(state.data);
  if (failure) {
    notify('Could not update the Cloudflare setting: ' + failure, 'error');
    return false;
  }
  const done = plural(domains.length, 'site') + (enabled ? ' now allow' : ' no longer allow') + ' Cloudflare traffic only.';
  // The change landed; what is on screen is what could not be refreshed, and
  // saying only that it worked would hide rows that are no longer true.
  notify(state.ok ? done : done + ' The page may be out of date: ' + state.error, state.ok ? 'ok' : 'warn');
  return true;
}

/** What an operation actually changes, counted from what is on screen. */
function planFor(rows, enabled) {
  const flagChanges = rows.filter(function (row) { return row.enabled !== enabled; });
  // Turning a site on clears its automatic exception; turning one off adds one.
  const exceptionChanges = rows.filter(function (row) { return enabled ? row.excluded : !row.excluded; });
  return { rows: rows, flagChanges: flagChanges, exceptionChanges: exceptionChanges };
}

function planDetails(plan, enabled) {
  const details = [];
  const off = plan.flagChanges.length;
  // The request rewrites the automatic exception list as well as the site flag,
  // so a site already on the wanted setting is not always a no-op. Say which
  // part of the change each count refers to.
  const later = automaticOn() ? '.' : ' if automatic enabling is turned on later.';
  if (enabled) {
    details.push(off === 0
      ? 'Every site here is already on.'
      : plural(off, 'site') + ' currently off ' + (off === 1 ? 'is' : 'are') + ' turned on.');
    if (plan.exceptionChanges.length) {
      details.push(plural(plan.exceptionChanges.length, 'site') + ' stop' + (plan.exceptionChanges.length === 1 ? 's' : '') +
        ' being excluded from automatic enabling' + later);
    }
  } else {
    details.push(off === 0
      ? 'Every site here is already off.'
      : plural(off, 'site') + ' currently on ' + (off === 1 ? 'is' : 'are') + ' turned off.');
    if (plan.exceptionChanges.length) {
      details.push(plural(plan.exceptionChanges.length, 'site') + ' become' + (plan.exceptionChanges.length === 1 ? 's' : '') +
        ' excluded from automatic enabling' + later);
    }
  }
  details.push('These choices replace what is set now and are not restored afterwards.');
  return details;
}

async function runBulk(rows, enabled, scope) {
  const plan = planFor(rows, enabled);
  if (plan.flagChanges.length === 0 && plan.exceptionChanges.length === 0) {
    notify(scope === 'all'
      ? 'Every site is already ' + (enabled ? 'on' : 'off') + '; nothing to change.'
      : 'The selected sites are already ' + (enabled ? 'on' : 'off') + '; nothing to change.', 'ok');
    return;
  }
  const subject = scope === 'all'
    ? 'all ' + plural(rows.length, 'site')
    : 'the ' + plural(rows.length, 'selected site');
  const accepted = await confirmAction({
    title: enabled
      ? 'Allow Cloudflare traffic only for ' + subject + '?'
      : 'Stop restricting ' + subject + ' to Cloudflare?',
    text: enabled
      ? 'Visitors reaching these sites from outside Cloudflare are blocked.'
      : 'These sites accept traffic from any address again.',
    details: planDetails(plan, enabled),
    confirmLabel: enabled ? 'Enable' : 'Disable',
    danger: !enabled,
  });
  if (!accepted) return;
  await setDomains(rows.map(function (row) { return row.domain; }), enabled);
}

function setAllSites(enabled) {
  runBulk(siteRows().map(rowState), enabled, 'all');
}

function setSelectedSites(enabled) {
  const rows = siteRows().map(rowState).filter(function (row) { return row.selected; });
  if (!rows.length) {
    notify('Select at least one site first.', 'warn');
    return;
  }
  runBulk(rows, enabled, 'selection');
}

// A single row is the common correction after a fleet-wide change, so it acts
// at once rather than behind a confirmation.
async function setOne(input) {
  const row = input.closest('tr[data-domain]');
  if (!row) return;
  await setDomains([row.dataset.domain], input.checked);
}

async function setAutomatic(input) {
  const enabled = input.checked;
  clearNotice();
  busy(true);
  let failure = '';
  let state;
  try {
    await call('/api/policy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: enabled }),
    });
  } catch (error) {
    failure = error.message;
  }
  try {
    state = await readState();
  } finally {
    busy(false);
  }
  if (state.ok) applyState(state.data);
  if (failure) {
    notify('Could not update the automatic policy: ' + failure, 'error');
    return;
  }
  const done = enabled
    ? 'New sites will allow Cloudflare only. Existing sites are unchanged.'
    : 'New sites are left alone. Existing sites are unchanged.';
  notify(state.ok ? done : done + ' The page may be out of date: ' + state.error, state.ok ? 'ok' : 'warn');
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', paintSummary);
else paintSummary();

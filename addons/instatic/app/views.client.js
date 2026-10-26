
async function act(domain, verb) {
  busy(true);
  try {
    const reply = await call('/api/instances/' + encodeURIComponent(domain) + '/' + verb, { method: 'POST' });
    if (reply.html) repaintView(CLP_ROOT.getElementById('clp-content'), reply.html);
    notify(domain + ': ' + verb + ' completed.', 'ok');
  } catch (e) {
    notify(verb + ' failed: ' + e.message, 'error');
  } finally {
    busy(false);
  }
}

async function takeSnapshot(domain) {
  busy(true);
  try {
    const res = await call('/api/instances/' + encodeURIComponent(domain) + '/snapshot', { method: 'POST' });
    busy(false);
    const snap = res && res.data && res.data.snapshot;
    const snapFile = snap ? snap.split('/').pop() : '';
    document.getElementById('snapshot-title').textContent = 'Snapshot created \u2014 ' + domain;
    document.getElementById('snapshot-file').textContent = snapFile || 'Snapshot archive created';
    document.getElementById('snapshot-path').textContent = snap || '(stored in instance snapshots directory)';
    document.getElementById('snapshot-dialog').showModal();
  } catch (e) {
    busy(false);
    notify('Snapshot failed: ' + e.message, 'error');
  }
}

async function showLogs(domain, port) {
  document.getElementById('logs-title').textContent = 'Logs \u2014 ' + domain;
  document.getElementById('logs-port-info').textContent = port
    ? 'Container listens on internal port 3001, mapped from host 127.0.0.1:' + port + ' for CloudPanel reverse proxy.'
    : '';
  const pre = document.getElementById('logs-body');
  pre.textContent = 'Loading\u2026';
  document.getElementById('logs-dialog').showModal();
  try {
    const body = await call('/api/instances/' + encodeURIComponent(domain) + '/logs');
    pre.textContent = (body && body.data && body.data.logs) || '(no output)';
  } catch (e) {
    pre.textContent = 'Could not fetch logs: ' + e.message;
  }
}

async function askStop(domain) {
  const agreed = await confirmAction({
    title: 'Stop ' + domain + '?',
    text: domain + ' is offline until it is started again.',
    confirmLabel: 'Stop',
    danger: true,
  });
  if (agreed) act(domain, 'stop');
}

/** True when version a is newer than b; both are x.y.z. */
function versionNewer(a, b) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

let pendingUpdate = null;
function askUpdate(domain, current) {
  pendingUpdate = domain;
  document.getElementById('update-domain').textContent = domain;
  document.getElementById('update-current').textContent = current;

  // Only versions newer than the one running: an update never goes back.
  const sel = document.getElementById('update-tag');
  let chosen = '';
  for (let i = 0; i < sel.options.length; i++) {
    const opt = sel.options[i];
    const newer = versionNewer(opt.value, current);
    opt.hidden = !newer;
    opt.disabled = !newer;
    if (newer && !chosen) chosen = opt.value;
  }
  // Options are newest first, so the first one left is the newest on offer.
  if (!chosen) { notify(domain + ' already runs the newest version.', 'ok'); return; }
  sel.value = chosen;
  document.getElementById('update-dialog').showModal();
}

async function confirmUpdate() {
  const tag = document.getElementById('update-tag').value.trim();
  if (!/^\d+\.\d+\.\d+$/.test(tag)) { notify('Choose a version to update to.', 'error'); return; }
  document.getElementById('update-dialog').close();
  busy(true);
  try {
    const reply = await call('/api/instances/' + encodeURIComponent(pendingUpdate) + '/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag: tag }),
    });
    // The update runs as a job; its page streams the log as it goes.
    if (reply.data && reply.data.job) {
      location.href = CLP_BASE + '/jobs/' + encodeURIComponent(reply.data.job);
      return;
    }
    if (reply.html) repaintView(CLP_ROOT.getElementById('clp-content'), reply.html);
    busy(false);
  } catch (error) {
    busy(false);
    notify('Update failed: ' + error.message, 'error');
  }
}

/** Updates or restarts the selected sites; each update is a job of its own, shown on its row. */
async function bulkInstatic(verb, tag) {
  let rows = selectedRows();
  if (verb === 'update') rows = rows.filter(function (row) { return versionNewer(tag, row.dataset.tag); });
  if (!rows.length) return notify('The selected sites already run ' + tag + '.', 'ok');
  const domains = rows.map(function (row) { return row.dataset.domain; });
  const accepted = await confirmAction({
    title: (verb === 'update' ? 'Update ' : 'Restart ') + plural(domains.length, 'site') + '?',
    text: verb === 'update'
      ? 'Each site is snapshotted, moved to ' + tag + ' and checked; one that fails its check goes back to its previous version.'
      : 'Each site is unavailable for a few seconds while its container restarts.',
    details: domains,
    confirmLabel: verb === 'update' ? 'Update' : 'Restart',
  });
  if (!accepted) return;
  busy(true);
  try {
    const reply = await call('/api/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ verb: verb, domains: domains, tag: tag }),
    });
    if (reply.html) repaintView(CLP_ROOT.getElementById('clp-content'), reply.html);
    const failed = (reply.data && reply.data.failed) || [];
    const done = (reply.data && reply.data.done) || [];
    if (failed.length) {
      notify(failed.map(function (entry) { return entry.domain + ': ' + entry.error; }).join('; '), 'error');
    } else {
      notify(verb === 'update' ? 'Updating ' + plural(done.length, 'site') + '; each row shows its progress.' : plural(done.length, 'site') + ' restarted.', 'ok');
    }
    watchDashboard();
  } catch (error) {
    notify(error.message, 'error');
  } finally {
    busy(false);
  }
}

/** While a job runs, the list is fetched again every few seconds so each row shows where it is. */
let dashboardTimer = null;
function watchDashboard() {
  clearTimeout(dashboardTimer);
  const card = CLP_ROOT.getElementById('instatic-sites');
  if (!card || !card.hasAttribute('data-working')) return;
  dashboardTimer = setTimeout(async function () {
    try {
      const reply = await call('/api/dashboard');
      if (reply.html && !CLP_ROOT.querySelector('dialog[open]')) {
        repaintView(CLP_ROOT.getElementById('clp-content'), reply.html);
        paintFleetSelection();
      }
    } catch (error) {
      // The next look tries again.
    }
    watchDashboard();
  }, 4000);
}

async function askDelete(domain) {
  const agreed = await confirmAction({
    title: 'Delete ' + domain + '?',
    text: 'This removes the container and the instance data, and the CloudPanel site if this addon created it. '
      + 'A final archive is written to /var/backups/clp-addons/instatic first.',
    typed: domain,
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!agreed) return;
  busy(true);
  try {
    const reply = await call('/api/instances/' + encodeURIComponent(domain) + '/delete', { method: 'POST' });
    if (reply.html) repaintView(CLP_ROOT.getElementById('clp-content'), reply.html);
    notify(domain + ' deleted.', 'ok');
  } catch (e) {
    notify('Delete failed: ' + e.message, 'error');
  } finally {
    busy(false);
  }
}

async function submitCreate(ev) {
  ev.preventDefault();
  const domain = document.getElementById('domain').value.trim().toLowerCase();
  const tag = document.getElementById('tag').value;
  const tls = document.getElementById('tls').checked;
  busy(true);
  try {
    const res = await call('/api/instances', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: domain, tag: tag, tls: tls })
    });
    if (res && res.data && res.data.job) {
      location.href = CLP_BASE + '/jobs/' + encodeURIComponent(res.data.job);
    } else {
      location.href = CLP_BASE + '/';
    }
  } catch (e) {
    busy(false);
    notify('Create failed: ' + e.message, 'error');
  }
  return false;
}

function initInstatic() {
  const watch = document.getElementById('job-watch');
  if (watch && watch.dataset.job) {
    watchJob(watch.dataset.job);
  }
  if (CLP_ROOT.getElementById('instatic-sites')) {
    paintFleetSelection();
    watchDashboard();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initInstatic);
} else {
  initInstatic();
}

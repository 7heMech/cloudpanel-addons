
async function act(domain, verb) {
  busy(true);
  try {
    const reply = await call('/api/instances/' + encodeURIComponent(domain) + '/' + verb, { method: 'POST' });
    repaintView(CLP_ROOT.getElementById('clp-content'), reply.html);
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
    repaintView(CLP_ROOT.getElementById('clp-content'), reply.html);
    notify(pendingUpdate + ' updated to ' + tag + '.', 'ok');
  } catch (error) {
    notify('Update failed: ' + error.message, 'error');
    const data = error.data;
    if (data && data.logs) {
      document.getElementById('logs-title').textContent =
        'Update failed — rolled back to ' + (data.restoredTag || 'the previous version');
      document.getElementById('logs-body').textContent = error.message + '\n\n' + data.logs;
      document.getElementById('logs-port-info').textContent = '';
      document.getElementById('logs-dialog').showModal();
    }
  } finally {
    busy(false);
  }
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
    repaintView(CLP_ROOT.getElementById('clp-content'), reply.html);
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
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initInstatic);
} else {
  initInstatic();
}

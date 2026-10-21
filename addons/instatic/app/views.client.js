
let currentLogDomain = '';
let currentLogPort = '';
let currentLogMode = 'container';

async function act(domain, verb) {
  busy(true);
  try {
    const reply = await call('/api/instances/' + encodeURIComponent(domain) + '/' + verb, { method: 'POST' });
    repaintView(CLP_ROOT.getElementById('clp-content'), reply.html);
    notify(domain + ': ' + verb + ' completed.', 'ok');
  } catch (e) {
    busy(false);
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
    alert('Snapshot failed: ' + e.message);
  }
}

async function fetchLogContent() {
  const pre = document.getElementById('logs-body');
  pre.textContent = 'Loading\u2026';
  try {
    if (currentLogMode === 'creation') {
      const body = await call('/api/instances/' + encodeURIComponent(currentLogDomain) + '/creation-log');
      pre.textContent = (body && body.data && body.data.log) || '(no creation log recorded)';
    } else {
      const body = await call('/api/instances/' + encodeURIComponent(currentLogDomain) + '/logs');
      pre.textContent = (body && body.data && body.data.logs) || '(no output)';
    }
  } catch (e) {
    pre.textContent = 'Could not fetch logs: ' + e.message;
  }
}

function switchLogs(mode) {
  currentLogMode = mode;
  const btnC = document.getElementById('btn-container-logs');
  const btnCr = document.getElementById('btn-creation-logs');
  if (btnC && btnCr) {
    if (mode === 'creation') {
      btnCr.classList.add('btn-primary');
      btnC.classList.remove('btn-primary');
    } else {
      btnC.classList.add('btn-primary');
      btnCr.classList.remove('btn-primary');
    }
  }
  fetchLogContent();
}

async function showLogs(domain, port) {
  currentLogDomain = domain;
  currentLogPort = port;
  currentLogMode = 'container';
  const dlg = document.getElementById('logs-dialog');
  const portInfo = document.getElementById('logs-port-info');
  document.getElementById('logs-title').textContent = 'Logs \u2014 ' + domain;
  if (portInfo) {
    portInfo.textContent = port ? 'Container listens on internal port 3001, mapped from host 127.0.0.1:' + port + ' for CloudPanel reverse proxy.' : '';
  }
  const btnC = document.getElementById('btn-container-logs');
  const btnCr = document.getElementById('btn-creation-logs');
  if (btnC && btnCr) {
    btnC.classList.add('btn-primary');
    btnCr.classList.remove('btn-primary');
  }
  dlg.showModal();
  fetchLogContent();
}

let pendingUpdate = null;
function askUpdate(domain, current) {
  pendingUpdate = domain;
  document.getElementById('update-domain').textContent = domain;
  document.getElementById('update-current').textContent = current;

  // The version to update to is picked from the list the registry actually
  // reports, not typed from memory. Typing it meant knowing a release had
  // happened, and nothing on this page ever said so.
  const sel = document.getElementById('update-tag');
  let chosen = '';
  for (let i = 0; i < sel.options.length; i++) {
    const opt = sel.options[i];
    const isCurrent = opt.value === current;
    opt.disabled = isCurrent;
    opt.textContent = opt.dataset.label + (isCurrent ? ' (running now)' : '');
    if (!isCurrent && !chosen) chosen = opt.value;
  }
  // Options are newest first, so the first enabled one is the newest on offer.
  sel.value = chosen || current;
  document.getElementById('update-dialog').showModal();
}

async function confirmUpdate() {
  const tag = document.getElementById('update-tag').value.trim();
  if (!/^\d+\.\d+\.\d+$/.test(tag)) {
    notify('Enter an exact version, for example 0.0.18.', 'error');
    return;
  }
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
      document.getElementById('logs-dialog').showModal();
    }
  } finally {
    busy(false);
  }
}

let pendingDelete = null;
function askDelete(domain) {
  pendingDelete = domain;
  document.getElementById('delete-domain').textContent = domain;
  document.getElementById('delete-confirm').value = '';
  document.getElementById('delete-dialog').showModal();
}

async function confirmDelete() {
  const typed = document.getElementById('delete-confirm').value.trim();
  if (typed !== pendingDelete) { alert('Type the domain exactly to confirm.'); return; }
  busy(true);
  try {
    const reply = await call('/api/instances/' + encodeURIComponent(pendingDelete) + '/delete', { method: 'POST' });
    repaintView(CLP_ROOT.getElementById('clp-content'), reply.html);
    notify(pendingDelete + ' deleted.', 'ok');
  } catch (e) {
    busy(false);
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
    alert('Create failed: ' + e.message);
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

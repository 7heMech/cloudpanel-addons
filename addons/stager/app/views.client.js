
function expandTarget(value, source) {
  const t = String(value || '').trim().toLowerCase().replace(/\.$/, '');
  if (!t) return '';
  return t.indexOf('.') === -1 ? t + '.' + source : t;
}

function previewTarget() {
  const input = document.getElementById('target');
  const source = document.getElementById('source-domain').value;
  const out = document.getElementById('target-preview');
  const full = expandTarget(input.value, source);
  out.textContent = full ? 'Will create ' + full : 'A label such as stg becomes stg.' + source;
}

async function startClone() {
  const source = document.getElementById('source-domain').value;
  const target = expandTarget(document.getElementById('target').value, source);
  const tls = document.getElementById('tls').checked;
  if (!target) { alert('Enter a hostname for the staging site.'); return false; }
  const payload = { source: source, target: target, tls: tls };
  // Present only when the source is an Instatic site. Read straight into the
  // request. The root job keeps it only until the source login succeeds.
  const email = document.getElementById('instatic-email');
  if (email) {
    const password = document.getElementById('instatic-password');
    const code = document.getElementById('instatic-mfa');
    if (!email.value || !password.value) {
      alert('Enter the source instance admin email and password.');
      return false;
    }
    payload.instaticEmail = email.value;
    payload.instaticPassword = password.value;
    if (code && code.value) payload.mfaCode = code.value;
  }
  busy(true);
  try {
    const body = await call('/api/clones', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    location.href = CLP_BASE + '/jobs/' + encodeURIComponent(body.data.job);
  } catch (e) {
    busy(false);
    alert('Could not start the clone: ' + e.message);
  }
  return false;
}

async function startPromote(job) {
  const fields = {};
  const ids = {
    instaticEmail: 'promote-src-email', instaticPassword: 'promote-src-password', mfaCode: 'promote-src-mfa',
    liveEmail: 'promote-dst-email', livePassword: 'promote-dst-password', liveMfaCode: 'promote-dst-mfa',
  };
  for (const key in ids) {
    const el = document.getElementById(ids[key]);
    if (el) fields[key] = el.value;
  }
  const needsCredentials = document.getElementById('promote-src-email');
  if (needsCredentials && (!fields.instaticEmail || !fields.instaticPassword || !fields.liveEmail || !fields.livePassword)) {
    alert('Enter the admin email and password for both instances.');
    return false;
  }
  const confirmField = document.getElementById('promote-confirm');
  const expected = confirmField.getAttribute('data-domain');
  if (confirmField.value.trim() !== expected) {
    alert('Type ' + expected + ' to confirm.');
    return false;
  }
  busy(true);
  try {
    const payload = { job: job };
    for (const key in fields) { if (fields[key]) payload[key] = fields[key]; }
    const body = await call('/api/promotions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    location.href = CLP_BASE + '/jobs/' + encodeURIComponent(body.data.job);
  } catch (e) {
    busy(false);
    alert('Could not start the promote: ' + e.message);
  }
  return false;
}

// Wired here rather than from an inline <script> inside the page body: the
// shell puts this script after <main>, so a call written next to the markup
// would run before any of these functions exist.
function initStager() {
  if (document.getElementById('target')) previewTarget();
  const watch = document.getElementById('job-watch');
  if (watch) watchJob(watch.getAttribute('data-job'));
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initStager);
} else {
  initStager();
}

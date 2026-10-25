// expandTarget is prepended by views.ts from service.ts, so the preview and
// the route expand a bare label the same way.

function previewTarget() {
  const input = document.getElementById('target');
  const source = document.getElementById('source-domain').value;
  const out = document.getElementById('target-preview');
  const full = expandTarget(input.value, source);
  out.textContent = full ? 'Will create ' + full : 'A label such as stg becomes ' + expandTarget('stg', source);
}

async function startClone() {
  const source = document.getElementById('source-domain').value;
  const target = expandTarget(document.getElementById('target').value, source);
  const tls = document.getElementById('tls').checked;
  if (!target) { notify('Enter a hostname for the staging site.', 'error'); return false; }
  const payload = { source: source, target: target, tls: tls };
  // Present only when the source is an Instatic site. Read straight into the
  // request. The root job keeps it only until the source login succeeds.
  const email = document.getElementById('instatic-email');
  if (email) {
    const password = document.getElementById('instatic-password');
    const code = document.getElementById('instatic-mfa');
    if (!email.value || !password.value) {
      notify('Enter the source instance admin email and password.', 'error');
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
    notify('Could not start the clone: ' + e.message, 'error');
  }
  return false;
}

async function startPromote(form) {
  const live = form.dataset.live;
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
    notify('Enter the admin email and password for both instances.', 'error');
    return false;
  }
  const agreed = await confirmAction({
    title: 'Promote ' + form.dataset.staging + ' to ' + live + '?',
    text: live + ' serves the replaced files from the moment the switch completes.',
    typed: live,
    confirmLabel: 'Promote',
    danger: true,
  });
  if (!agreed) return false;
  busy(true);
  try {
    const payload = { job: form.dataset.job };
    for (const key in fields) { if (fields[key]) payload[key] = fields[key]; }
    const body = await call('/api/promotions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    location.href = CLP_BASE + '/jobs/' + encodeURIComponent(body.data.job);
  } catch (e) {
    busy(false);
    notify('Could not start the promote: ' + e.message, 'error');
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

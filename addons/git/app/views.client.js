
function gitField(id) {
  const el = CLP_ROOT.getElementById(id);
  return el ? el.value.trim() : '';
}

async function saveGitConfig(domain) {
  const payload = {
    remote: gitField('git-remote'),
    branch: gitField('git-branch'),
    directory: gitField('git-directory'),
    postDeploy: gitField('git-post-deploy'),
  };
  if (!payload.remote || !payload.branch) {
    notify('Enter the repository URL and the branch to deploy.', 'error');
    return false;
  }
  busy(true);
  try {
    await call('/api/sites/' + encodeURIComponent(domain) + '/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    location.reload();
  } catch (e) {
    busy(false);
    notify('Could not save: ' + e.message, 'error');
  }
  return false;
}

async function forgetGitSite(domain) {
  const accepted = await confirmAction({
    title: 'Stop deploying this site?',
    text: 'The repository settings for ' + domain + ' are removed.',
    details: ['The checked-out files stay where they are.', 'The deploy key stays with the site user.'],
    confirmLabel: 'Stop deploying',
    danger: true,
  });
  if (!accepted) return;
  busy(true);
  try {
    await call('/api/sites/' + encodeURIComponent(domain) + '/config', { method: 'DELETE' });
    location.reload();
  } catch (e) {
    busy(false);
    notify('Could not remove the settings: ' + e.message, 'error');
  }
}

async function generateGitKey(domain, replace) {
  if (replace) {
    const accepted = await confirmAction({
      title: 'Replace the deploy key?',
      text: 'A new key is generated for ' + domain + '.',
      details: ['Deployments fail until the new public key is added to the repository.'],
      confirmLabel: 'Replace key',
      danger: true,
    });
    if (!accepted) return;
  }
  busy(true);
  try {
    await call('/api/sites/' + encodeURIComponent(domain) + '/key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ replace: replace === true }),
    });
    location.reload();
  } catch (e) {
    busy(false);
    notify('Could not generate the key: ' + e.message, 'error');
  }
}

function copyGitBlock(id, what) {
  const block = CLP_ROOT.getElementById(id);
  if (!block) return;
  const text = block.textContent || '';
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(
      function () { notify(what + ' copied.', 'ok'); },
      function () { notify('Select the ' + what.toLowerCase() + ' and copy it.', 'warn'); }
    );
    return;
  }
  // No clipboard API: select it so one keystroke finishes the job.
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(block);
  selection.removeAllRanges();
  selection.addRange(range);
  notify('Press Ctrl+C to copy the selection.', 'warn');
}

// A mode, not an action: no confirmation either way, and the switch goes back
// where it was if the change did not take.
async function setGitWebhook(domain, on) {
  busy(true);
  try {
    await call('/api/sites/' + encodeURIComponent(domain) + '/webhook',
      on ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' } : { method: 'DELETE' });
    location.reload();
  } catch (e) {
    busy(false);
    const box = CLP_ROOT.getElementById('git-webhook-toggle');
    if (box) box.checked = !on;
    notify('Could not change push to deploy: ' + e.message, 'error');
  }
}

async function rotateGitWebhook(domain) {
  const accepted = await confirmAction({
    title: 'Rotate the webhook URL?',
    text: 'A new URL is generated for ' + domain + '.',
    details: ['Deliveries fail until the new URL is pasted back into the repository.'],
    confirmLabel: 'Rotate URL',
    danger: true,
  });
  if (!accepted) return;
  busy(true);
  try {
    await call('/api/sites/' + encodeURIComponent(domain) + '/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ replace: true }),
    });
    location.reload();
  } catch (e) {
    busy(false);
    notify('Could not rotate the URL: ' + e.message, 'error');
  }
}

async function deployGitSite(domain) {
  busy(true);
  clearNotice();
  try {
    const body = await call('/api/deployments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: domain }),
    });
    const card = CLP_ROOT.getElementById('git-job-card');
    if (!card) {
      location.reload();
      return;
    }
    // Watched where it was started rather than on a page of its own: this view
    // is mounted inside the CloudPanel site page, and navigating away from it
    // would leave the panel behind to show a log.
    card.hidden = false;
    busy(false);
    const button = CLP_ROOT.getElementById('git-deploy');
    if (button) { button.disabled = true; button.textContent = 'Deploying…'; }
    const meta = CLP_ROOT.getElementById('git-job-meta');
    if (meta) meta.textContent = 'Started just now · Manual deployment';
    const error = CLP_ROOT.getElementById('git-job-error');
    if (error) error.hidden = true;
    updateJobUI({ state: 'queued', step: 'queued' }, '', card);
    watchJob(body.data.job, card);
  } catch (e) {
    busy(false);
    notify('Could not start the deployment: ' + e.message, 'error');
  }
}

function gitSelected() {
  return Array.from(CLP_ROOT.querySelectorAll('.git-select:checked:not(:disabled)')).map(function (box) {
    return box.getAttribute('data-domain');
  });
}

function gitSelectionChanged() {
  const count = gitSelected().length;
  const total = CLP_ROOT.querySelectorAll('.git-select:not(:disabled)').length;
  const button = CLP_ROOT.getElementById('git-deploy-selected');
  if (button) {
    button.disabled = count === 0;
    button.textContent = count ? 'Deploy selected (' + count + ')' : 'Deploy selected';
  }
  const all = CLP_ROOT.getElementById('git-select-all');
  if (all) {
    all.checked = total > 0 && count === total;
    all.indeterminate = count > 0 && count < total;
  }
  const mobile = CLP_ROOT.getElementById('git-select-mobile');
  if (mobile) mobile.textContent = total > 0 && count === total ? 'Deselect all' : 'Select all';
}

function toggleGitAll(checked) {
  CLP_ROOT.querySelectorAll('.git-select:not(:disabled)').forEach(function (box) { box.checked = checked; });
  gitSelectionChanged();
}

function selectGitAll() {
  toggleGitAll(gitSelected().length < CLP_ROOT.querySelectorAll('.git-select:not(:disabled)').length);
}

// The fleet answer to "deploy these": one request per site, reported together,
// so a failure names the site it belongs to instead of stopping the rest.
async function deployGitSelected() {
  const domains = gitSelected();
  if (domains.length === 0) return;
  const accepted = await confirmAction({
    title: 'Deploy ' + domains.length + ' site' + (domains.length === 1 ? '' : 's') + '?',
    text: 'Each site fetches its configured branch and runs its post-deploy command.',
    details: domains,
    confirmLabel: 'Deploy',
  });
  if (!accepted) return;
  busy(true);
  const failed = [];
  for (const domain of domains) {
    try {
      await call('/api/deployments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: domain }),
      });
    } catch (e) {
      failed.push(domain + ': ' + e.message);
    }
  }
  busy(false);
  if (failed.length) notify('Some deployments did not start. ' + failed.join(' '), 'error');
  else notify('Started ' + domains.length + ' deployment' + (domains.length === 1 ? '' : 's') + '.', 'ok');
  setTimeout(function () { location.reload(); }, 1200);
}

// The path is completed to a URL by the browser, which knows exactly which
// address the operator reached the panel on -- including behind a proxy that
// rewrites Host, where the address seen by the manager would be wrong.
function initGitWebhookUrl() {
  const block = CLP_ROOT.getElementById('git-webhook-url');
  if (!block) return;
  const url = location.origin + block.getAttribute('data-path');
  block.textContent = url;
  const curl = CLP_ROOT.getElementById('git-webhook-curl');
  if (curl) curl.textContent = 'curl -X POST ' + url;
}

function initGit() {
  initGitWebhookUrl();
  CLP_ROOT.querySelectorAll('.git-select').forEach(function (box) {
    box.addEventListener('change', gitSelectionChanged);
  });
  gitSelectionChanged();
  const watch = CLP_ROOT.getElementById('job-watch');
  if (watch) watchJob(watch.getAttribute('data-job'), CLP_ROOT.getElementById('git-job-card'));
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initGit);
} else {
  initGit();
}

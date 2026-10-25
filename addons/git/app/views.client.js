
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
    const reply = await call('/api/sites/' + encodeURIComponent(domain) + '/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    await showGitChange(reply, 'Repository settings saved.');
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
    const reply = await call('/api/sites/' + encodeURIComponent(domain) + '/config', { method: 'DELETE' });
    await showGitChange(reply, 'Repository disconnected.');
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
    const reply = await call('/api/sites/' + encodeURIComponent(domain) + '/key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ replace: replace === true }),
    });
    await showGitChange(reply, 'Deploy key generated. Add it to your repository before deploying.');
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
    const reply = await call('/api/sites/' + encodeURIComponent(domain) + '/webhook',
      on ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' } : { method: 'DELETE' });
    await showGitChange(reply, 'Push to deploy updated.');
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
    const reply = await call('/api/sites/' + encodeURIComponent(domain) + '/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ replace: true }),
    });
    await showGitChange(reply, 'Webhook URL rotated. Update it in your repository.');
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
    watchJob(body.data.job, null, gitJobFinished);
    await showGitChange({}, 'Deployment started for ' + domain + '.');
  } catch (e) {
    busy(false);
    notify('Could not start the deployment: ' + e.message, 'error');
  }
}

// The fleet answer to "deploy these": one request per site, reported together,
// so a failure names the site it belongs to instead of stopping the rest.
async function deployGitSelected() {
  const domains = selectedRows().map(function (row) { return row.dataset.domain; });
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
  const jobs = [];
  for (const domain of domains) {
    try {
      const reply = await call('/api/deployments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: domain }),
      });
      jobs.push(reply.data.job);
    } catch (e) {
      failed.push(domain + ': ' + e.message);
    }
  }
  try {
    if (jobs.length) await refreshGit();
  } catch (e) {
    failed.push('Could not refresh deployments: ' + e.message);
  }
  busy(false);
  jobs.forEach(function (id) { watchJob(id, null, gitJobFinished); });
  if (failed.length) notify('Some deployments did not start. ' + failed.join(' '), 'error');
  else notify('Started ' + domains.length + ' deployment' + (domains.length === 1 ? '' : 's') + '.', 'ok');
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

function paintGit(html) {
  repaintView(CLP_ROOT.getElementById('clp-content'), html);
  busy(false);
  initGit();
}

// The site page names its site; the fleet page names none.
async function refreshGit() {
  const site = CLP_ROOT.querySelector('[data-git-domain]');
  const domain = site ? site.getAttribute('data-git-domain') : '';
  const reply = await call('/api/view' + (domain ? '?domain=' + encodeURIComponent(domain) : ''));
  paintGit(reply.html);
}

// A change that landed is reported as done, with a warning if the page could not be redrawn.
async function showGitChange(reply, done) {
  try {
    if (reply.html) paintGit(reply.html);
    else await refreshGit();
    notify(done, 'ok');
  } catch (e) {
    busy(false);
    notify(done + ' The page could not be refreshed: ' + e.message, 'warn');
  }
}

async function gitJobFinished(job) {
  try {
    await refreshGit();
    notify(job.state === 'done' ? 'Deployment completed.' : 'Deployment failed: ' + (job.error || job.step),
      job.state === 'done' ? 'ok' : 'error');
  } catch (e) {
    busy(false);
    notify('Could not refresh the deployment: ' + e.message, 'error');
  }
}

function initGit() {
  initGitWebhookUrl();
  const watch = CLP_ROOT.getElementById('job-watch');
  if (watch) watchJob(watch.getAttribute('data-job'), null, gitJobFinished);
  CLP_ROOT.querySelectorAll('tr[data-job]').forEach(function (row) {
    watchJob(row.getAttribute('data-job'), null, gitJobFinished);
  });
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initGit);
} else {
  initGit();
}

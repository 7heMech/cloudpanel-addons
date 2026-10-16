
// The window is opened inside the click, before anything is awaited: one
// opened after a fetch resolves is a popup the browser blocks. Agreeing to add
// a bypass is a click of its own, which opens the retry's window and passes it.
async function signIn(button, addBypass, opened) {
  const domain = button.dataset.domain;
  const target = addBypass ? opened : window.open('', '_blank');
  clearNotice();
  busy(true);
  try {
    const reply = await call('/api/sign-in', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: domain, addBypass: addBypass === true }),
    });
    const maintenance = reply.data.maintenance;
    if (maintenance) {
      if (target) target.close();
      busy(false);
      if (!maintenance.canBypass) {
        notify(maintenance.message, 'error');
        return;
      }
      confirmAction({
        title: 'Site in maintenance',
        text: maintenance.message,
        confirmLabel: 'Add IP and sign in',
        onAccept: function () { signIn(button, true, window.open('', '_blank')); },
      });
      return;
    }
    submitToken(target, reply.data);
    busy(false);
    notify('Signing in to ' + domain + ' in a new tab.', 'ok');
  } catch (error) {
    if (target) target.close();
    busy(false);
    notify(error.message, 'error');
  }
}

// Posted rather than put in the address bar: a single-use secret in a query
// string is still a secret in the site's access log and in the browser history.
function submitToken(target, data) {
  if (!target) throw new Error('Allow pop-ups for the panel to open WordPress.');
  const form = target.document.createElement('form');
  form.method = 'POST';
  form.action = data.url;
  const field = target.document.createElement('input');
  field.type = 'hidden';
  field.name = data.field;
  field.value = data.token;
  form.appendChild(field);
  target.document.body.appendChild(form);
  form.submit();
}

// Make a change, then repaint everything below the heading from the server's
// answer, so a row that failed or that the change did not reach shows as it is.
async function change(path, body, describe) {
  const focused = CLP_ROOT.activeElement && CLP_ROOT.activeElement.id;
  clearNotice();
  busy(true);
  let reply;
  let failure = '';
  let html = '';
  let stale = '';
  try {
    reply = await call(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  } catch (error) {
    failure = error.message;
  }
  try {
    html = (await call('/api/dashboard')).data.html;
  } catch (error) {
    stale = error.message;
  }
  busy(false);
  if (html) {
    CLP_ROOT.getElementById('wp-dashboard').innerHTML = html;
    const again = focused && CLP_ROOT.getElementById(focused);
    if (again) again.focus();
  }
  if (failure) {
    notify(failure, 'error');
    return false;
  }
  const done = describe(reply.data || {});
  notify(stale ? done.text + ' The page may be out of date: ' + stale : done.text, stale ? 'warn' : done.kind || 'ok');
  return true;
}

async function setAutomatic(input) {
  const enabled = input.checked;
  if (!await change('/api/varnish-settings', { enabled: enabled }, function () {
    return { text: enabled
      ? 'Automatic installation is on. Sites are checked every 15 minutes, or now with Check now.'
      : 'Automatic installation is off. Installed plugins are left as they are.' };
  })) input.checked = !enabled;
}

async function setSiteAutomatic(input) {
  const domain = input.dataset.domain;
  const included = input.checked;
  if (!await change('/api/varnish-site', { domain: domain, excluded: !included }, function () {
    return { text: included
      ? domain + ' is included in automatic installation.'
      : domain + ' is excluded from automatic installation. Its plugin is left as it is.' };
  })) input.checked = !included;
}

function syncSummary(data) {
  let text = 'Checked ' + plural(data.checked, 'site') + '; ' + data.installed + ' installed or activated.';
  if (data.pending) text += ' ' + data.pending + ' still to check; check again to continue.';
  if (data.failed.length) text += ' ' + data.failed.length + ' failed; see the sites below.';
  return { text: text, kind: data.failed.length || data.pending ? 'warn' : 'ok' };
}

function checkSites() {
  change('/api/varnish-sync', {}, syncSummary);
}

async function installPlugin(button) {
  const domain = button.dataset.domain;
  const agreed = await confirmAction({
    title: button.textContent + ' CLP Varnish Cache on ' + domain + '?',
    text: 'CLP Varnish Cache is installed from WordPress.org if it is missing, then activated, as the site\'s own user.',
    confirmLabel: button.textContent,
  });
  if (!agreed) return;
  change('/api/varnish-install', { domain: domain }, function (data) {
    if (data.installed) return { text: 'CLP Varnish Cache is active on ' + domain + '.' };
    return { text: data.failed.length ? data.failed[0] : 'Nothing was installed on ' + domain + '; see its status below.', kind: 'warn' };
  });
}

async function removeHelpers() {
  const agreed = await confirmAction({
    title: 'Remove the sign-in helper?',
    text: 'The must-use plugin is deleted from every site it is in. The next sign-in puts it back.',
    confirmLabel: 'Remove',
  });
  if (!agreed) return;
  change('/api/remove', {}, function (data) {
    const failed = data.failed || [];
    let text = data.removed ? 'Removed from ' + plural(data.removed, 'site') + '.' : 'No site had the helper installed.';
    if (failed.length) text += ' Still in ' + failed.join('; ') + '.';
    return { text: text, kind: failed.length ? 'warn' : 'ok' };
  });
}

function mainwpSummary(data) {
  let text = 'Checked ' + plural(data.checked, 'site') + '; ' + data.connected + ' connected; ' + data.removed + ' cleaned up.';
  if (data.pending) text += ' ' + data.pending + ' pending; check again to continue.';
  if (data.failed.length) text += ' ' + data.failed.length + ' failed; see the sites below.';
  return { text: text, kind: data.pending || data.failed.length ? 'warn' : 'ok' };
}
function setMainwpAutomatic(input) {
  const enabled = input.checked;
  change('/api/mainwp-settings', { enabled: enabled }, function () {
    return { text: enabled ? 'MainWP automation is on. Sites are checked every 15 minutes.' : 'MainWP automation is off. Existing connections remain active until you clean up.' };
  });
}
function setMainwpDashboard(input) {
  if (!input.value) return;
  change('/api/mainwp-settings', { enabled: false, dashboard: input.value }, function () { return { text: 'MainWP Dashboard selected. Use Check now to refresh the sites.' }; });
}
function setMainwpSite(input) {
  change('/api/mainwp-site', { domain: input.dataset.domain, excluded: !input.checked }, function () { return { text: 'MainWP automatic installation updated. Existing connections are unchanged.' }; });
}
function checkMainwp() { change('/api/mainwp-sync', {}, mainwpSummary); }
async function connectMainwp(button) {
  const domain = button.dataset.domain;
  if (!await confirmAction({ title: 'Connect ' + domain + ' to MainWP?', text: 'MainWP Child is installed if missing and activated, and the selected Dashboard gains administrator access. Cleanup removes only changes owned by WordPress Tools.', confirmLabel: 'Connect' })) return;
  change('/api/mainwp-connect', { domain: domain, confirm: true }, mainwpSummary);
}
async function cleanupMainwp() {
  if (!await confirmAction({ title: 'Turn off and clean up MainWP?', text: 'Removes managed Dashboard connections and plugins installed by WordPress Tools. Plugins already installed by you stay, with their previous activation and connection settings restored. Existing manual connections are left alone.', confirmLabel: 'Turn off and clean up' })) return;
  change('/api/mainwp-cleanup', { confirm: true }, mainwpSummary);
}

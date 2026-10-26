
// The window is opened inside the click, before anything is awaited: one
// opened after a fetch resolves is a popup the browser blocks. Agreeing to add
// a bypass is a click of its own, which opens the retry's window and passes it.
async function signIn(button, addBypass, opened, allowBasicAuth) {
  const domain = button.dataset.domain;
  const target = (addBypass || allowBasicAuth) ? opened : signInWindow(domain);
  clearNotice();
  busy(true);
  try {
    const reply = await call('/api/sign-in', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: domain, addBypass: addBypass === true, allowBasicAuth: allowBasicAuth === true }),
    });
    const maintenance = reply.data.maintenance || reply.data.basicAuth;
    if (maintenance) {
      if (target) target.close();
      busy(false);
      if (!maintenance.canBypass) {
        notify(maintenance.message, 'error');
        return;
      }
      confirmAction({
        title: reply.data.basicAuth ? 'Site protected by basic authentication' : 'Site in maintenance',
        text: maintenance.message,
        confirmLabel: 'Add IP and sign in',
        onAccept: function () { signIn(button, addBypass || !!reply.data.maintenance, signInWindow(domain), allowBasicAuth || !!reply.data.basicAuth); },
      });
      return;
    }
    if (target) await windowLoaded(target, domain);
    submitToken(target, reply.data);
    busy(false);
    notify('Signing in to ' + domain + ' in a new tab.', 'ok');
  } catch (error) {
    if (target) target.close();
    busy(false);
    notify(error.message, 'error');
  }
}

// The window opens on this addon's page for that one site, whose policy lets
// the token's form go there; this page refuses every form.
function signInWindow(domain) {
  return window.open(CLP_BASE + '/sign-in/' + encodeURIComponent(domain), '_blank');
}

// The form can only go into that page once it has replaced the window's
// initial blank document.
async function windowLoaded(target, domain) {
  const path = CLP_BASE + '/sign-in/' + encodeURIComponent(domain);
  for (let waited = 0; waited < 10000; waited += 50) {
    if (target.closed) throw new Error('The sign-in window was closed.');
    try {
      if (target.location.pathname === path && target.document.readyState === 'complete') return;
    } catch (error) {
      // A window that failed to load shows a page this one cannot read.
    }
    await new Promise(function (resolve) { setTimeout(resolve, 50); });
  }
  throw new Error('The sign-in window did not load.');
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
  // Cut before WordPress loads: a page in that window could otherwise send
  // this panel tab somewhere else through window.opener.
  target.opener = null;
  form.submit();
}

// Make a change, then repaint everything below the heading from the server's
// answer, so a row that failed or that the change did not reach shows as it is.
async function change(path, body, describe) {
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
  if (html) repaintView(CLP_ROOT.getElementById('wp-dashboard'), html);
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

async function setMainwpAutomatic(input) {
  const enabled = input.checked;
  if (!await change('/api/mainwp-settings', { enabled: enabled }, function () {
    return { text: enabled
      ? 'MainWP automation is on. Sites are checked every 15 minutes, or now with Check now.'
      : 'MainWP automation is off. Connected sites stay connected.' };
  })) input.checked = !enabled;
}

function setMainwpDashboard(select) {
  if (!select.value) return;
  const automatic = CLP_ROOT.getElementById('mainwp-automatic');
  const enabled = Boolean(automatic && automatic.checked);
  const remote = select.value === '@remote';
  change('/api/mainwp-settings', remote ? { enabled: enabled, remote: true } : { enabled: enabled, dashboard: select.value }, function () {
    return { text: remote
      ? 'MainWP Child will be installed for a Dashboard on another server. Use Check now to see each site\'s MainWP Child.'
      : select.value + ' is the MainWP Dashboard. Use Check now to see which sites are connected to it.' };
  });
}

function mainwpSummary(data) {
  let text = 'Checked ' + plural(data.checked, 'site') + '; ' + (data.installed ? data.installed + ' installed, ' : '') +
    data.connected + ' connected, ' + data.removed + ' cleaned up.';
  if (data.pending) text += ' ' + data.pending + ' still to check; check again to continue.';
  if (data.failed.length) text += ' ' + data.failed.length + ' failed; see the sites below.';
  return { text: text, kind: data.failed.length || data.pending ? 'warn' : 'ok' };
}

function checkMainwp() {
  change('/api/mainwp-sync', {}, mainwpSummary);
}

async function connectMainwp(button) {
  const domain = button.dataset.domain;
  const remote = button.hasAttribute('data-remote');
  const agreed = await confirmAction(remote ? {
    title: button.textContent + ' MainWP Child on ' + domain + '?',
    text: 'MainWP Child is installed from WordPress.org if it is missing, and activated. Add the site in your MainWP Dashboard now, with the site\'s administrator login: MainWP Child turns itself off when no Dashboard connects within its connection timeout, 20 minutes unless changed in its settings.',
    confirmLabel: button.textContent,
  } : {
    title: button.textContent + ' ' + domain + ' to MainWP?',
    text: 'MainWP Child is installed from WordPress.org if it is missing, activated, and connected as the site\'s first administrator. The Dashboard can then manage the site.',
    confirmLabel: button.textContent,
  });
  if (!agreed) return;
  change('/api/mainwp-connect', { domain: domain, confirm: true }, function (data) {
    if (remote && data.installed) return { text: 'MainWP Child is active on ' + domain + '. Add the site in your MainWP Dashboard now.' };
    if (data.connected) return { text: domain + ' is connected to MainWP.' };
    return { text: data.failed.length ? data.failed[0] : domain + ' is not connected yet; see its status below.', kind: 'warn' };
  });
}

async function cleanupMainwp() {
  const agreed = await confirmAction({
    title: 'Turn off and clean up MainWP?',
    text: 'Automation stops. Connections WordPress Tools made are removed from the Dashboard, and Child plugins it installed are deleted. Connections and plugins you set up yourself stay.',
    confirmLabel: 'Turn off and clean up',
    danger: true,
  });
  if (!agreed) return;
  change('/api/mainwp-cleanup', { confirm: true }, mainwpSummary);
}

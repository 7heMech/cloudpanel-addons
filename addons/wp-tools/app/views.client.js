
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

// Each dashboard refresh gets a ticket so an older response cannot replace a newer one.
let dashboardAsked = 0;
// Authoritative defaults from the last successful save until a dashboard repaint catches up.
let savedDefaults = null;

function repaintDashboard(html, ticket) {
  if (!html || ticket !== dashboardAsked) return false;
  repaintView(CLP_ROOT.getElementById('wp-dashboard'), html);
  savedDefaults = null;
  if (defaultFound.length) paintDefaultResults();
  return true;
}

// Make a change, then repaint everything below the heading from the server's
// answer, so a row that failed or that the change did not reach shows as it is.
async function change(path, body, describe) {
  clearNotice();
  busy(true);
  // Any dashboard refresh already in flight predates this change.
  ++dashboardAsked;
  let reply;
  let failure = '';
  let html = '';
  let stale = '';
  try {
    reply = await call(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  } catch (error) {
    failure = error.message;
  }
  if (!failure && reply && reply.data && reply.data.pluginDefaults) {
    savedDefaults = reply.data.pluginDefaults;
  }
  const ticket = ++dashboardAsked;
  try {
    html = (await call('/api/dashboard')).data.html;
  } catch (error) {
    if (ticket === dashboardAsked) stale = error.message;
  }
  busy(false);
  repaintDashboard(html, ticket);
  followJobs();
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

async function setDomainLink(input) {
  const signIn = input.checked;
  if (!await change('/api/domain-link', { signIn: signIn }, function () {
    return { text: signIn
      ? 'The domain on a WordPress site\'s pages now signs in to WordPress.'
      : 'The domain on a WordPress site\'s pages opens the site again, with WP Login beside it.' };
  })) input.checked = !signIn;
}

async function setNewSiteManagers(input) {
  const siteManagers = input.checked;
  if (!await change('/api/new-site-settings', { siteManagers: siteManagers }, function () {
    return { text: siteManagers
      ? 'Site managers now see the Plugins row on CloudPanel\'s New WordPress Site form, without uploads.'
      : 'Only administrators see the Plugins row on CloudPanel\'s New WordPress Site form now.' };
  })) input.checked = !siteManagers;
}

// --- the server's default plugins for new sites ------------------------------

const MAX_DEFAULTS = 20;
let defaultFound = [];
let defaultTimer = null;
let defaultAsked = 0;
// Each save sends the whole list, so a second one waits for the first to repaint it.
let defaultSaving = false;

// As the page was last drawn, or from the last save until a dashboard repaint catches up.
function defaultAutomatic() {
  if (savedDefaults) return (savedDefaults.automatic || []).slice();
  const holder = CLP_ROOT.getElementById('wp-default-list');
  return holder ? (holder.dataset.automatic || '').split(' ').filter(Boolean) : [];
}

function defaultPlugins() {
  if (savedDefaults) {
    const automatic = savedDefaults.automatic || [];
    return (savedDefaults.server || []).map(function (plugin) {
      return {
        slug: plugin.slug,
        name: plugin.name,
        activate: Boolean(plugin.activate),
        automatic: automatic.indexOf(plugin.slug) !== -1,
      };
    });
  }
  return Array.prototype.map.call(CLP_ROOT.querySelectorAll('#wp-default-list > li[data-slug]'), function (row) {
    return { slug: row.dataset.slug, name: row.dataset.name, activate: row.hasAttribute('data-activate'), automatic: row.hasAttribute('data-automatic') };
  });
}

// A plugin automation now installs on every new site cannot be a default, so it goes with the next save.
async function saveDefaults(plugins, text) {
  const kept = plugins.filter(function (plugin) { return !plugin.automatic; }).map(function (plugin) {
    return { slug: plugin.slug, name: plugin.name, activate: plugin.activate };
  });
  defaultSaving = true;
  paintDefaultResults();
  let done = false;
  try {
    done = await change('/api/new-site-defaults', { plugins: kept }, function () { return { text: text }; });
  } finally {
    defaultSaving = false;
  }
  paintDefaultResults();
  return done;
}

async function setDefaultActivate(input) {
  const row = input.closest('li');
  if (defaultSaving) {
    input.checked = !input.checked;
    return;
  }
  const saved = await saveDefaults(defaultPlugins().map(function (plugin) {
    return plugin.slug === row.dataset.slug ? Object.assign({}, plugin, { activate: input.checked }) : plugin;
  }), input.checked ? row.dataset.name + ' is activated on new sites.' : row.dataset.name + ' is installed inactive on new sites.');
  // A repaint draws it from what was saved; without one, it goes back to what it was.
  if (!saved && input.isConnected) input.checked = !input.checked;
}

function removeDefault(button) {
  if (defaultSaving) return;
  const row = button.closest('li');
  saveDefaults(defaultPlugins().filter(function (plugin) { return plugin.slug !== row.dataset.slug; }),
    row.dataset.name + ' is no longer a default plugin.');
}

function addDefault(plugin) {
  if (defaultSaving) return;
  const plugins = defaultPlugins();
  if (plugins.filter(function (entry) { return !entry.automatic; }).length >= MAX_DEFAULTS) {
    notify('A new site takes at most ' + MAX_DEFAULTS + ' plugins.', 'error');
    return;
  }
  saveDefaults(plugins.concat([{ slug: plugin.slug, name: plugin.name, activate: true }]), plugin.name + ' is a default plugin now.');
}

function paintDefaultResults() {
  const results = CLP_ROOT.getElementById('wp-default-results');
  const search = CLP_ROOT.getElementById('wp-default-search');
  if (!results || !search) return;
  const chosen = defaultPlugins().map(function (plugin) { return plugin.slug; });
  const automaticSlugs = defaultAutomatic();
  results.textContent = '';
  defaultFound.forEach(function (plugin) {
    const row = document.createElement('li');
    row.setAttribute('role', 'presentation');
    const pick = document.createElement('button');
    pick.type = 'button';
    pick.className = 'wp-default-result';
    pick.setAttribute('role', 'option');
    const name = document.createElement('span');
    name.className = 'wp-plugin-name';
    name.textContent = plugin.name;
    const meta = document.createElement('span');
    meta.className = 'wp-note';
    meta.textContent = plugin.author ? 'by ' + plugin.author : '';
    const automatic = automaticSlugs.indexOf(plugin.slug) !== -1;
    const added = chosen.indexOf(plugin.slug) !== -1;
    const state = document.createElement('span');
    state.className = 'wp-default-add';
    state.textContent = automatic ? 'Automatic' : added ? 'Added' : 'Add';
    if (automatic) state.title = "Installed on every new site by WordPress Tools' automation";
    pick.append(name, meta, state);
    pick.disabled = automatic || added || defaultSaving;
    pick.addEventListener('click', function () { addDefault(plugin); });
    row.appendChild(pick);
    results.appendChild(row);
  });
  results.hidden = defaultFound.length === 0;
  search.setAttribute('aria-expanded', defaultFound.length ? 'true' : 'false');
}

function findDefaultSoon() {
  clearTimeout(defaultTimer);
  defaultTimer = setTimeout(findDefault, 350);
}

async function findDefault() {
  const search = CLP_ROOT.getElementById('wp-default-search');
  const term = search ? search.value.trim() : '';
  const ticket = ++defaultAsked;
  if (term.length < 2) {
    defaultFound = [];
    paintDefaultResults();
    return;
  }
  try {
    const reply = await call('/api/plugin-search?q=' + encodeURIComponent(term));
    if (ticket !== defaultAsked) return;
    defaultFound = reply.data.plugins;
    if (!defaultFound.length) notify('WordPress.org has no plugin matching “' + term + '”.', 'warn');
  } catch (error) {
    if (ticket === defaultAsked) notify(error.message, 'error');
    return;
  }
  paintDefaultResults();
}

function defaultSearchKey(event) {
  if (event.key === 'Enter') {
    event.preventDefault();
    clearTimeout(defaultTimer);
    findDefault();
  }
  if (event.key === 'Escape' && defaultFound.length) {
    event.preventDefault();
    defaultFound = [];
    paintDefaultResults();
  }
}

function syncSummary(data) {
  let text = 'Checked ' + plural(data.checked, 'site') + '; ' + data.installed + ' installed or activated.';
  if (data.pending) text += ' ' + data.pending + ' still to check; check again to continue.';
  if (data.failed.length) text += ' ' + data.failed.length + ' failed; see the sites below.';
  return { text: text, kind: data.failed.length || data.pending ? 'warn' : 'ok' };
}

function followJobs() {
  followJobProgress(jobFinished, markWorkingSite);
}

function markWorkingSite(job) {
  CLP_ROOT.querySelectorAll('.wp-status[data-policy="' + job.policy + '"].is-working').forEach(function (cell) {
    cell.classList.remove('is-working');
  });
  const row = job.site && CLP_ROOT.querySelector('tr[data-domain="' + CSS.escape(job.site) + '"]');
  const cell = row && row.querySelector('.wp-status[data-policy="' + job.policy + '"]');
  if (cell) cell.classList.add('is-working');
}

const JOB_SUMMARIES = {
  'varnish-check': syncSummary,
  'varnish-install': function (data, job) {
    const domain = job.domains[0];
    if (data.installed) return { text: 'CLP Varnish Cache is active on ' + domain + '.' };
    return { text: data.failed.length ? data.failed[0] : 'Nothing was installed on ' + domain + '; see its status below.', kind: 'warn' };
  },
  'mainwp-check': mainwpSummary,
  'mainwp-cleanup': mainwpSummary,
  'mainwp-connect': function (data, job) {
    if (job.domains.length === 1) {
      const domain = job.domains[0];
      if (data.installed) return { text: 'MainWP Child is active on ' + domain + '. Add the site in your MainWP Dashboard now.' };
      if (data.connected) return { text: domain + ' is connected to MainWP.' };
      return { text: data.failed.length ? data.failed[0] : domain + ' is not connected yet; see its status below.', kind: 'warn' };
    }
    let text = plural(data.connected, 'site') + ' connected to MainWP of ' + job.domains.length + ' chosen.';
    if (data.pending) text += ' ' + data.pending + ' not reached; connect them again to continue.';
    if (data.failed.length) text += ' ' + data.failed.length + ' failed; see the sites below.';
    return { text: text, kind: data.failed.length || data.pending ? 'warn' : 'ok' };
  },
  'new-site-plugins': function (data, job) {
    const plugins = data.plugins || [];
    const failed = plugins.filter(function (plugin) { return plugin.status === 'failed'; });
    if (data.outcome === 'superseded') return { text: 'The plugins chosen for ' + job.domains[0] + ' were replaced by a later choice.' };
    if (data.outcome !== 'done') return { text: 'No site called ' + job.domains[0] + ' was created, so no plugins were installed.', kind: 'warn' };
    if (failed.length) return { text: failed.length + ' of ' + plural(plugins.length, 'plugin') + ' could not be installed on ' + job.domains[0] + '; see below.', kind: 'warn' };
    return { text: plural(plugins.length, 'plugin') + ' installed on ' + job.domains[0] + '.' };
  },
};

async function jobFinished(job) {
  const ticket = ++dashboardAsked;
  let stale = '';
  try {
    repaintDashboard((await call('/api/dashboard')).data.html, ticket);
  } catch (error) {
    if (ticket === dashboardAsked) stale = error.message;
  }
  followJobs();
  if (job.state !== 'done') {
    notify('The job failed: ' + (job.error || job.step), 'error');
    return;
  }
  const done = JOB_SUMMARIES[job.task](job.result || { checked: 0, installed: 0, connected: 0, removed: 0, pending: 0, failed: [] }, job);
  notify(stale ? done.text + ' The page may be out of date: ' + stale : done.text, stale ? 'warn' : done.kind || 'ok');
}

function jobStarted() {
  return { text: 'Started. It runs in the background, so you can keep using the page or reload it.' };
}

function checkSites() {
  change('/api/varnish-sync', {}, jobStarted);
}

async function installPlugin(button) {
  const domain = button.dataset.domain;
  const agreed = await confirmAction({
    title: button.textContent + ' CLP Varnish Cache on ' + domain + '?',
    text: 'CLP Varnish Cache is installed from WordPress.org if it is missing, then activated, as the site\'s own user.' +
      (button.hasAttribute('data-network') ? ' This site is a multisite network, so the plugin is network-activated for every site in it.' : ''),
    confirmLabel: button.textContent,
  });
  if (!agreed) return;
  change('/api/varnish-install', { domain: domain }, jobStarted);
}

async function removeHelpers() {
  const agreed = await confirmAction({
    title: 'Remove the sign-in helper?',
    text: 'The sign-in is deleted from every site it is in. The next sign-in puts it back.',
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

function confirmEnforcement(dashboard) {
  return confirmAction({
    title: 'Keep every site connected to MainWP?',
    text: 'Every WordPress site on this server is connected to ' + dashboard + ', including sites connected to another Dashboard, and kept that way. Site administrators can no longer see, deactivate or disconnect MainWP Child.',
    confirmLabel: 'Turn on',
  });
}

async function setMainwpAutomatic(input) {
  const enabled = input.checked;
  const picker = CLP_ROOT.getElementById('mainwp-dashboard');
  const local = picker && picker.value !== '@remote';
  if (enabled && local && !await confirmEnforcement(picker.value)) {
    input.checked = false;
    return;
  }
  if (!await change('/api/mainwp-settings', { enabled: enabled }, function () {
    return { text: enabled
      ? 'MainWP automation is on. Sites are checked every 15 minutes, or now with Check now.'
      : local
        ? 'MainWP automation is off. Connected sites stay connected, and MainWP Child shows in their Plugins again after the next check.'
        : 'MainWP automation is off. Connected sites stay connected.' };
  })) input.checked = !enabled;
}

async function setMainwpDashboard(select) {
  if (!select.value) return;
  const automatic = CLP_ROOT.getElementById('mainwp-automatic');
  const enabled = Boolean(automatic && automatic.checked);
  const remote = select.value === '@remote';
  if (enabled && !remote && !await confirmEnforcement(select.value)) {
    const current = select.querySelector('option[selected]');
    select.value = current ? current.value : '';
    return;
  }
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
  change('/api/mainwp-sync', {}, jobStarted);
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
    text: 'MainWP Child is installed from WordPress.org if it is missing, activated, and connected as the site\'s first administrator, replacing any connection to another Dashboard. The Dashboard can then manage the site.',
    confirmLabel: button.textContent,
  });
  if (!agreed) return;
  change('/api/mainwp-connect', { domains: [domain], confirm: true }, jobStarted);
}

async function connectMainwpSites(domains) {
  const agreed = await confirmAction({
    title: 'Connect ' + plural(domains.length, 'site') + ' to MainWP?',
    text: 'On each site, MainWP Child is installed from WordPress.org if it is missing, activated, and connected as the site\'s first administrator, replacing any connection to another Dashboard. Sites already connected here are left as they are.',
    confirmLabel: 'Connect',
  });
  if (!agreed) return;
  change('/api/mainwp-connect', { domains: domains, confirm: true }, jobStarted);
}

function connectMainwpSelected() {
  connectMainwpSites(selectedRows().map(function (row) { return row.dataset.domain; }));
}

function connectMainwpAll() {
  connectMainwpSites(siteRows().filter(function (row) {
    const box = row.querySelector('.site-checkbox');
    return box && !box.disabled;
  }).map(function (row) { return row.dataset.domain; }));
}

async function cleanupMainwp() {
  const agreed = await confirmAction({
    title: 'Turn off and clean up MainWP?',
    text: 'Automation stops. Connections WordPress Tools made are removed from the Dashboard, and Child plugins it installed are deleted. Connections and plugins you set up yourself stay.',
    confirmLabel: 'Turn off and clean up',
    danger: true,
  });
  if (!agreed) return;
  change('/api/mainwp-cleanup', { confirm: true }, jobStarted);
}

followJobs();

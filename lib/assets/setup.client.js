// The Setup checklist on an administrator's addon pages. The tab keeps whether
// it was showing, so the header does not shift when the answer arrives.
const CLP_SETUP_KEY = 'clp-setup-shown';
const CLP_SETUP_URL = '/addons/api/setup';

function clpSetupParts() {
  return {
    chip: document.getElementById('clp-setup-chip'),
    nav: document.getElementById('clp-setup-nav'),
    panel: document.getElementById('clp-setup-panel'),
  };
}

function clpSetupShow(shown) {
  const parts = clpSetupParts();
  if (!parts.chip) return;
  parts.chip.hidden = !shown;
  parts.nav.hidden = !shown;
  try {
    if (shown) sessionStorage.setItem(CLP_SETUP_KEY, '1');
    else sessionStorage.removeItem(CLP_SETUP_KEY);
  } catch (error) {}
}

function clpSetupApply(data) {
  const parts = clpSetupParts();
  if (!parts.panel || !data) return;
  parts.panel.innerHTML = data.html;
  clpSetupShow(data.show);
}

async function clpSetupFetch(url, body) {
  const options = { credentials: 'same-origin', headers: { Accept: 'application/json' } };
  if (body) {
    options.method = 'POST';
    options.headers['Content-Type'] = 'application/json';
    options.headers['X-CLP-Addons-CSRF'] = csrf();
    options.body = JSON.stringify(body);
  }
  const response = await fetch(url, options);
  let reply = null;
  try { reply = await response.json(); } catch (error) {}
  if (!response.ok || !reply || !reply.ok) throw new Error((reply && reply.error) || 'request failed with ' + response.status);
  return reply.data;
}

async function clpSetupRequest(body) {
  const data = await clpSetupFetch(CLP_SETUP_URL, body);
  clpSetupApply(data);
  return data;
}

function clpSetupOpen(open) {
  const parts = clpSetupParts();
  if (!parts.panel) return;
  parts.panel.hidden = !open;
  // Below the header, which is taller on a phone than on a desktop.
  const header = document.querySelector('.clp-addon-header');
  if (open && header) parts.panel.style.setProperty('--clp-setup-top', (Math.max(header.getBoundingClientRect().bottom, 0) + 6) + 'px');
  [parts.chip, parts.nav].forEach(function (button) { button.setAttribute('aria-expanded', open ? 'true' : 'false'); });
  if (open) parts.panel.focus({ preventScroll: true });
}

function clpSetupToggle() {
  const parts = clpSetupParts();
  clpSetupOpen(parts.panel.hidden);
}

// The Addons page's Setup button, which also brings back a hidden checklist.
async function clpSetupReopen() {
  try {
    await clpSetupRequest({ hidden: false });
    clpSetupOpen(true);
  } catch (error) {
    notify(error.message, 'error');
  }
}

async function clpSetupAct(target) {
  const data = target.dataset;
  if (data.setupEnable) {
    try {
      // The Addons page follows the job, which restarts the manager.
      target.disabled = true;
      await clpSetupFetch('/addons/api/addons/' + encodeURIComponent(data.setupEnable) + '/enable', {});
      location.href = '/addons/';
    } catch (error) {
      target.disabled = false;
      notify(error.message, 'error');
    }
    return;
  }
  const body = data.setupSkip ? { skip: data.setupSkip }
    : data.setupUnskip ? { unskip: data.setupUnskip }
    : data.setupHide !== undefined ? { hidden: true }
    : null;
  if (!body) return;
  target.disabled = true;
  try {
    await clpSetupRequest(body);
    if (body.hidden) {
      clpSetupOpen(false);
      clpSetupShow(false);
      notify('Setup is hidden. Bring it back from the Addons page.', 'ok');
    }
  } catch (error) {
    target.disabled = false;
    notify(error.message, 'error');
  }
}

(function () {
  const parts = clpSetupParts();
  if (!parts.panel) return;
  let known = false;
  try { known = sessionStorage.getItem(CLP_SETUP_KEY) === '1'; } catch (error) {}
  if (known) clpSetupShow(true);
  parts.panel.addEventListener('click', function (event) {
    const target = event.target.closest('[data-setup-enable], [data-setup-skip], [data-setup-unskip], [data-setup-hide]');
    if (target) clpSetupAct(target);
  });
  document.addEventListener('click', function (event) {
    if (parts.panel.hidden || parts.panel.contains(event.target)) return;
    if (parts.chip.contains(event.target) || parts.nav.contains(event.target)) return;
    clpSetupOpen(false);
  });
  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape' || parts.panel.hidden) return;
    clpSetupOpen(false);
    (parts.chip.offsetParent ? parts.chip : parts.nav).focus();
  });
  clpSetupRequest(null).catch(function () { if (known) clpSetupShow(false); });
})();

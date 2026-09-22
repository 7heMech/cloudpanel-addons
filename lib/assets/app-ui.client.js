
// Where the elements of this page live: the document on a standalone addon
// page, and a shadow root on a page mounted into a CloudPanel site page, so
// that Bootstrap in the panel cannot reach this markup and these rules cannot
// reach the panel. Element lookups go through this; document APIs do not.
const CLP_ROOT = typeof CLP_MOUNT === 'undefined' ? document : CLP_MOUNT;

function syncTheme() {
  const dark = /(?:^|;\s*)theme=dark(?:;|$)/.test(document.cookie);
  document.documentElement.classList.toggle('dark', dark);
  const button = CLP_ROOT.getElementById('theme-switch');
  if (button) {
    button.setAttribute('aria-pressed', String(dark));
    button.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
  }
}
function toggleTheme() {
  const dark = !document.documentElement.classList.contains('dark');
  document.cookie = dark ? 'theme=dark; Path=/; SameSite=Lax' : 'theme=; Path=/; Max-Age=0; SameSite=Lax';
  syncTheme();
}
syncTheme();
window.addEventListener('pageshow', syncTheme);
window.addEventListener('focus', syncTheme);

// The account menu, closed by every way out of it: the button again, a click
// elsewhere, Escape, or the focus leaving it.
function accountMenu() {
  return {
    button: CLP_ROOT.getElementById('clp-account-button'),
    list: CLP_ROOT.getElementById('clp-account-menu'),
  };
}
function closeAccountMenu() {
  const parts = accountMenu();
  if (!parts.list || parts.list.hidden) return;
  parts.list.hidden = true;
  parts.button.setAttribute('aria-expanded', 'false');
}
function toggleAccountMenu() {
  const parts = accountMenu();
  if (!parts.list) return;
  const open = parts.list.hidden;
  parts.list.hidden = !open;
  parts.button.setAttribute('aria-expanded', String(open));
  if (open) {
    const first = parts.list.querySelector('a');
    if (first) first.focus();
  }
}
document.addEventListener('click', function (event) {
  const parts = accountMenu();
  if (!parts.list || parts.list.hidden) return;
  if (!parts.list.contains(event.target) && !parts.button.contains(event.target)) closeAccountMenu();
});
document.addEventListener('keydown', function (event) {
  if (event.key === 'Escape' || event.key === 'Esc') closeAccountMenu();
});
document.addEventListener('focusin', function (event) {
  const parts = accountMenu();
  if (!parts.list || parts.list.hidden) return;
  if (!parts.list.contains(event.target) && !parts.button.contains(event.target)) closeAccountMenu();
});

// Use the longest matching route so /new takes precedence over the list tab.
// Only the addon's own tabs: a site strip reproduces CloudPanel's navigation,
// whose active entry the server already knows and most of whose routes this
// page could never match.
const navLinks = Array.from(CLP_ROOT.querySelectorAll('[data-auto-active] .clp-addon-nav-link'));
const activeLink = navLinks.filter(function (link) {
  const path = new URL(link.href).pathname.replace(/\/$/, '');
  return location.pathname === path || location.pathname.indexOf(path + '/') === 0;
}).sort(function (a, b) { return b.href.length - a.href.length; })[0];
navLinks.forEach(function (link) {
  if (link === activeLink) link.setAttribute('aria-current', 'page');
  else link.removeAttribute('aria-current');
});

// The CSRF cookie is readable by this page on purpose; echoing it back in a
// header is what proves the request came from here and not another origin.
function csrf() {
  const m = document.cookie.match(/(?:^|;\s*)clp_addons_csrf=([^;]+)/);
  return m ? m[1] : '';
}

async function call(path, options) {
  const opts = Object.assign({ headers: {} }, options || {});
  opts.headers = Object.assign({ 'X-CLP-Addons-CSRF': csrf() }, opts.headers);
  // Every addon is served under a path on one hostname, so a bare '/api/...'
  // would reach the router rather than this addon. CLP_BASE is emitted into the
  // page by renderLayout; prefixing here fixes every caller at once.
  const res = await fetch(CLP_BASE + path, opts);
  let body = null;
  try { body = await res.json(); } catch (e) { /* non-JSON error page */ }
  if (!res.ok || !body || body.ok === false) {
    throw new Error((body && body.error) || ('request failed with ' + res.status));
  }
  return body;
}

// Remember what was already unavailable. Restoring every control to "enabled"
// handed back the switch of a site whose status could not be read and the bulk
// buttons of an empty selection.
function busy(on) {
  CLP_ROOT.querySelectorAll('button, input[type="checkbox"]').forEach(function (el) {
    if (on) {
      if (el.dataset.clpHeld === undefined) el.dataset.clpHeld = el.disabled ? '1' : '0';
      el.disabled = true;
    } else if (el.dataset.clpHeld !== undefined) {
      el.disabled = el.dataset.clpHeld === '1';
      delete el.dataset.clpHeld;
    }
  });
  document.body.style.cursor = on ? 'progress' : '';
}

// Feedback in the page rather than in a modal the browser owns: an addon that
// reports a failed toggle with alert() loses the row it was talking about.
let clpFlashTimer = 0;
function notify(message, kind) {
  const holder = CLP_ROOT.getElementById('clp-flash');
  if (!holder) {
    if (kind === 'error') alert(message);
    return;
  }
  clearTimeout(clpFlashTimer);
  holder.textContent = message;
  holder.className = kind === 'error' ? 'alert' : kind === 'warn' ? 'notice' : 'alert alert-ok';
  holder.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  holder.hidden = false;
  if (kind !== 'error') clpFlashTimer = setTimeout(function () { holder.hidden = true; }, 6000);
}

function clearNotice() {
  const holder = CLP_ROOT.getElementById('clp-flash');
  if (holder) holder.hidden = true;
}

function plural(count, word) {
  return count + ' ' + word + (count === 1 ? '' : 's');
}

/**
 * The shared confirmation. Takes {title, text, details, confirmLabel, danger}
 * and resolves true only if the operator accepted. Every value is written with
 * textContent, so a domain name in the summary stays a domain name.
 */
function confirmAction(options) {
  const opts = options || {};
  const dialog = CLP_ROOT.getElementById('clp-confirm');
  if (!dialog || typeof dialog.showModal !== 'function') {
    return Promise.resolve(confirm([opts.title, opts.text].concat(opts.details || []).filter(Boolean).join('\n\n')));
  }
  dialog.querySelector('#clp-confirm-title').textContent = opts.title || 'Are you sure?';
  dialog.querySelector('#clp-confirm-text').textContent = opts.text || '';
  const list = dialog.querySelector('#clp-confirm-details');
  list.textContent = '';
  (opts.details || []).forEach(function (item) {
    const entry = document.createElement('li');
    entry.textContent = item;
    list.appendChild(entry);
  });
  list.hidden = list.childElementCount === 0;
  const accept = dialog.querySelector('#clp-confirm-accept');
  accept.textContent = opts.confirmLabel || 'Continue';
  accept.className = opts.danger ? 'btn btn-danger' : 'btn btn-primary';
  return new Promise(function (resolve) {
    function onClose() {
      dialog.removeEventListener('close', onClose);
      accept.removeEventListener('click', onAccept);
      resolve(dialog.returnValue === 'accept');
    }
    function onAccept() { dialog.close('accept'); }
    dialog.addEventListener('close', onClose);
    accept.addEventListener('click', onAccept);
    dialog.returnValue = '';
    dialog.showModal();
  });
}

// A strip wider than its container scrolls; keep the tab the page is on and the
// tab the keyboard has reached in view. 'nearest' scrolls the strip, not the page.
(function () {
  const strip = CLP_ROOT.querySelector('.clp-addon-tabs');
  if (!strip) return;
  function reveal(el) {
    if (el && strip.scrollWidth > strip.clientWidth) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  reveal(strip.querySelector('[aria-current="page"]'));
  strip.addEventListener('focusin', function (event) { reveal(event.target); });
})();

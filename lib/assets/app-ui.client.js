
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
  // would reach the router rather than this addon.
  const res = await fetch(CLP_BASE + path, opts);
  let body = null;
  try { body = await res.json(); } catch (e) { /* non-JSON error page */ }
  if (!res.ok || !body || body.ok === false) {
    const failure = new Error((body && body.error) || ('request failed with ' + res.status));
    failure.data = body && body.data;
    throw failure;
  }
  return body;
}

let clpBusyFocus = null;

function busy(on) {
  if (on && !clpBusyFocus) clpBusyFocus = CLP_ROOT.activeElement;
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
  if (on) return;
  const focused = clpBusyFocus;
  clpBusyFocus = null;
  if (focused && focused.isConnected && !focused.disabled && focusLost()) focused.focus({ preventScroll: true });
}

function focusLost() {
  const active = CLP_ROOT.activeElement;
  return !active || active === document.body;
}

function repaintView(holder, html) {
  const active = clpBusyFocus || CLP_ROOT.activeElement;
  const focusId = active && holder.contains(active) ? active.id : '';
  const disclosures = new Map();
  holder.querySelectorAll('details[id]').forEach(function (details) {
    disclosures.set(details.id, details.open);
  });
  const ticked = new Set();
  holder.querySelectorAll('tr[data-domain] .site-checkbox:checked').forEach(function (box) {
    ticked.add(box.closest('tr[data-domain]').dataset.domain);
  });
  const kept = new Map();
  holder.querySelectorAll('[data-keep][id]').forEach(function (control) { kept.set(control.id, control.value); });
  holder.querySelectorAll('dialog[open]').forEach(function (dialog) { dialog.close(); });
  const scrollY = window.scrollY;
  holder.innerHTML = html;
  holder.querySelectorAll('details[id]').forEach(function (details) {
    if (disclosures.has(details.id)) details.open = disclosures.get(details.id);
  });
  holder.querySelectorAll('tr[data-domain] .site-checkbox').forEach(function (box) {
    if (ticked.has(box.closest('tr[data-domain]').dataset.domain) && !box.disabled) box.checked = true;
  });
  kept.forEach(function (value, id) {
    const control = CLP_ROOT.getElementById(id);
    if (control && holder.contains(control)) control.value = value;
  });
  if (typeof filterFleet === 'function') filterFleet();
  const focused = focusId && CLP_ROOT.getElementById(focusId);
  if (focused) focused.focus({ preventScroll: true });
  window.scrollTo(window.scrollX, scrollY);
}

CLP_ROOT.addEventListener('mouseover', function (event) {
  const cell = event.target.closest && event.target.closest('.fleet-table td.site-cell');
  if (!cell || cell.title) return;
  const cut = [cell].concat(Array.prototype.slice.call(cell.children)).some(function (node) { return node.scrollWidth > node.clientWidth; });
  if (cut) cell.title = cell.innerText.trim().split('\n').join(' · ');
});

// Feedback in the page rather than in a modal the browser owns: an addon that
// reports a failed toggle with alert() loses the row it was talking about.
//
// Messages stack, up to three, the newest nearest the edge they come in from,
// and one already showing is replaced rather than repeated. The holder is a
// popover, so it is drawn in the top layer and no dialog, menu or header covers
// it. It keeps out of the pointer's way: a switch near the top right is where a
// toast would land on a desktop, so when the pointer, or the last tap, is in
// the corner a new stack would start in, it starts at the other end of the
// screen instead. Hovering a message holds them all until the pointer leaves.
const CLP_TOAST_LIMIT = 3;
const CLP_TOAST_MS = 6000;
let clpPointerX = -1;
let clpPointerY = -1;
['pointermove', 'pointerdown'].forEach(function (type) {
  document.addEventListener(type, function (event) { clpPointerX = event.clientX; clpPointerY = event.clientY; },
    { passive: true, capture: true });
});

function toastEdge() {
  const phone = window.matchMedia('(max-width: 940px)').matches;
  const edge = phone ? 'bottom' : 'top';
  if (clpPointerX < 0) return edge;
  const width = phone ? window.innerWidth : Math.min(440, window.innerWidth - 48) + 48;
  if (clpPointerX < window.innerWidth - width) return edge;
  const band = 260;
  const near = edge === 'top' ? clpPointerY < (phone ? 12 : 92) + band : clpPointerY > window.innerHeight - band;
  return near ? (edge === 'top' ? 'bottom' : 'top') : edge;
}

function holdToast(toast, ms) {
  toast.clpLeft = ms;
  toast.clpAt = Date.now();
  toast.clpTimer = setTimeout(function () { dropToast(toast); }, ms);
}

function dropToast(toast) {
  clearTimeout(toast.clpTimer);
  const holder = toast.parentNode;
  toast.remove();
  if (holder && !holder.children.length) hideToasts(holder);
}

function hideToasts(holder) {
  // A holder that goes while the pointer is on it hears no mouseleave.
  holder.clpHovered = false;
  if (holder.hidePopover && holder.matches(':popover-open')) holder.hidePopover();
}

function notify(message, kind, link, stay) {
  const holder = CLP_ROOT.getElementById('clp-flash');
  if (!holder) {
    if (kind === 'error') alert(message);
    return;
  }
  if (!holder.dataset.wired) {
    holder.dataset.wired = '1';
    holder.addEventListener('mouseenter', function () {
      holder.clpHovered = true;
      Array.prototype.forEach.call(holder.children, function (toast) {
        if (!toast.clpTimer) return;
        clearTimeout(toast.clpTimer);
        toast.clpTimer = 0;
        toast.clpLeft -= Date.now() - toast.clpAt;
      });
    });
    holder.addEventListener('mouseleave', function () {
      holder.clpHovered = false;
      Array.prototype.forEach.call(holder.children, function (toast) {
        if (toast.clpLeft !== undefined && !toast.clpTimer) holdToast(toast, Math.max(toast.clpLeft, 1500));
      });
    });
  }
  Array.prototype.slice.call(holder.children).forEach(function (old) {
    if (old.dataset.message === message) dropToast(old);
  });
  // Placed when a stack starts, so one already showing does not jump.
  if (!holder.children.length) holder.dataset.edge = toastEdge();

  const toast = document.createElement('div');
  toast.className = 'clp-toast ' + (kind === 'error' ? 'alert' : kind === 'warn' ? 'notice' : 'alert alert-ok');
  toast.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  toast.dataset.message = message;
  const text = document.createElement('span');
  text.className = 'clp-flash-text';
  const at = link ? message.indexOf(link.text) : -1;
  if (at < 0) text.textContent = message;
  else {
    const anchor = document.createElement('a');
    anchor.href = link.href;
    anchor.textContent = link.text;
    text.append(message.slice(0, at), anchor, message.slice(at + link.text.length));
  }
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'clp-flash-close';
  close.setAttribute('aria-label', 'Dismiss');
  close.textContent = '×';
  close.onclick = function () { dropToast(toast); };
  toast.append(text, close);
  holder.append(toast);
  while (holder.children.length > CLP_TOAST_LIMIT) dropToast(holder.firstElementChild);
  // Shown again even when it is open: the top layer is ordered by when each
  // element entered it, so a stack opened before a dialog would be under it.
  if (holder.showPopover) {
    if (holder.matches(':popover-open')) holder.hidePopover();
    holder.showPopover();
  }
  // An error, or a message its caller keeps up, stays until it is dismissed;
  // one that arrives under the pointer waits for it to leave, as the rest do.
  if (kind !== 'error' && !stay) {
    if (holder.clpHovered) toast.clpLeft = CLP_TOAST_MS;
    else holdToast(toast, CLP_TOAST_MS);
  }
  return toast;
}

function placeRowMenu(menu) {
  const list = menu.querySelector('.actions');
  if (!list || !window.matchMedia('(min-width: 941px)').matches) return;
  const box = menu.querySelector('summary').getBoundingClientRect();
  list.style.right = Math.max(8, window.innerWidth - box.right) + 'px';
  list.style.top = '0px';
  const below = box.bottom + 6;
  list.style.top = (below + list.offsetHeight > window.innerHeight - 8 ? Math.max(8, box.top - 6 - list.offsetHeight) : below) + 'px';
  menu.dataset.placed = '';
}

// The filter menu of a fleet table is drawn over the page rather than inside its
// card, which clips what overflows it.
function placeFleetFilters() {
  const menu = CLP_ROOT.getElementById('fleet-show');
  if (!menu || !menu.open) return;
  const box = menu.querySelector('summary').getBoundingClientRect();
  const list = menu.querySelector('.fleet-show-menu');
  list.style.left = Math.max(8, Math.min(box.left, window.innerWidth - list.offsetWidth - 8)) + 'px';
  const room = window.innerHeight - 8 - (box.bottom + 4);
  const above = list.offsetHeight > room && box.top - 12 > room;
  list.style.top = above ? 'auto' : (box.bottom + 4) + 'px';
  list.style.bottom = above ? (window.innerHeight - box.top + 4) + 'px' : 'auto';
}
document.addEventListener('keydown', function (event) {
  const menu = CLP_ROOT.getElementById('fleet-show');
  if (event.key !== 'Escape' || !menu || !menu.open) return;
  menu.open = false;
  menu.querySelector('summary').focus();
});

document.addEventListener('toggle', function (event) {
  const menu = event.target;
  if (menu.id === 'fleet-show') return placeFleetFilters();
  if (!menu.classList || !menu.classList.contains('row-actions')) return;
  if (!menu.open) {
    delete menu.dataset.placed;
    return;
  }
  CLP_ROOT.querySelectorAll('details.row-actions[open]').forEach(function (other) { if (other !== menu) other.open = false; });
  placeRowMenu(menu);
}, true);
document.addEventListener('click', function (event) {
  CLP_ROOT.querySelectorAll('details.row-actions[open]').forEach(function (menu) {
    if (!menu.contains(event.target) || event.target.closest('.actions .btn')) menu.open = false;
  });
  const filters = CLP_ROOT.getElementById('fleet-show');
  if (filters && filters.open && event.composedPath().indexOf(filters) === -1) filters.open = false;
});
['scroll', 'resize'].forEach(function (type) {
  window.addEventListener(type, function () {
    CLP_ROOT.querySelectorAll('details.row-actions[open]').forEach(placeRowMenu);
    placeFleetFilters();
  }, true);
});

function clearNotice() {
  const holder = CLP_ROOT.getElementById('clp-flash');
  if (!holder) return;
  Array.prototype.slice.call(holder.children).forEach(dropToast);
  hideToasts(holder);
}

function plural(count, word) {
  return count + ' ' + word + (count === 1 ? '' : 's');
}

/**
 * The shared confirmation. Takes {title, text, details, confirmLabel, danger,
 * typed, onAccept} and resolves true only if the operator accepted. `typed` is
 * a word the operator must type before accepting, for what cannot be undone.
 * `onAccept` runs inside the accepting click, where opening a window is still
 * allowed. Every value is written with textContent, so a domain name stays a
 * domain name.
 */
function confirmAction(options) {
  const opts = options || {};
  const dialog = CLP_ROOT.getElementById('clp-confirm');
  if (!dialog || typeof dialog.showModal !== 'function') {
    const question = [opts.title, opts.text].concat(opts.details || []).filter(Boolean).join('\n\n');
    const agreed = opts.typed
      ? prompt(question + '\n\nType ' + opts.typed + ' to confirm.') === opts.typed
      : confirm(question);
    if (agreed && opts.onAccept) opts.onAccept();
    return Promise.resolve(agreed);
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
  const typedField = dialog.querySelector('#clp-confirm-typed-field');
  const typed = dialog.querySelector('#clp-confirm-typed');
  typedField.hidden = !opts.typed;
  typed.value = '';
  dialog.querySelector('#clp-confirm-typed-word').textContent = opts.typed || '';
  function syncTyped() { accept.disabled = Boolean(opts.typed) && typed.value.trim() !== opts.typed; }
  syncTyped();
  return new Promise(function (resolve) {
    function onClose() {
      dialog.removeEventListener('close', onClose);
      accept.removeEventListener('click', onAccept);
      typed.removeEventListener('input', syncTyped);
      typed.removeEventListener('keydown', onEnter);
      accept.disabled = false;
      resolve(dialog.returnValue === 'accept');
    }
    function onAccept() {
      if (accept.disabled) return;
      if (opts.onAccept) opts.onAccept();
      dialog.close('accept');
    }
    function onEnter(event) {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      onAccept();
    }
    dialog.addEventListener('close', onClose);
    accept.addEventListener('click', onAccept);
    typed.addEventListener('input', syncTyped);
    typed.addEventListener('keydown', onEnter);
    dialog.returnValue = '';
    dialog.showModal();
    if (opts.typed) typed.focus();
  });
}

// A press on a modal dialog's backdrop targets the dialog itself, outside its
// box; it closes the dialog, as Escape does.
CLP_ROOT.addEventListener('click', function (event) {
  const dialog = event.target;
  if (!(dialog instanceof HTMLDialogElement) || !dialog.open) return;
  const rect = dialog.getBoundingClientRect();
  const inside = event.clientX >= rect.left && event.clientX <= rect.right
    && event.clientY >= rect.top && event.clientY <= rect.bottom;
  if (!inside) dialog.close();
});

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

// Selects drawn like the menus are held at their widest option; see
// select-width.client.js, which lib/app-ui.ts puts ahead of this script.
clpHoldSelectWidths(CLP_ROOT, true);

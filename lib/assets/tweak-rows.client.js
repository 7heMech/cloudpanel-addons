function toggleNote(button) {
  const row = button.closest('.tweak-row');
  const open = row.classList.toggle('is-open');
  button.setAttribute('aria-expanded', open ? 'true' : 'false');
}

// The line a switch or button that starts slow work says while it runs, under
// its option, its row's note, or the fold, install block or card header it
// sits in. Past a moment it also says, in a message kept up while the work
// runs, that other settings wait. Returns what to call when the work ends.
function working(control, text) {
  const option = control.closest('.st-option');
  const row = option || control.closest('.tweak-row');
  const line = document.createElement('p');
  line.className = 'st-status st-working';
  line.setAttribute('role', 'status');
  line.innerHTML = '<span class="badge">Working</span> ';
  line.append(text);
  const after = option ? option.lastElementChild
    : row ? row.querySelector('.tweak-note') : control.closest('.st-fold, .st-install, .card-header');
  if (after) after.after(line);
  let warned = null;
  const page = setTimeout(function () {
    warned = notify(text + ' Other settings wait until it finishes.', 'warn', null, true);
  }, 600);
  return function () {
    clearTimeout(page);
    line.remove();
    if (warned) releaseToast(warned);
  };
}

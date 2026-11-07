function hold(on) {
  busy(on);
  CLP_ROOT.querySelectorAll('#clp-content select, #clp-content input:not([type="checkbox"])').forEach(function (el) {
    if (on) {
      if (el.dataset.stHeld === undefined) el.dataset.stHeld = el.disabled ? '1' : '0';
      el.disabled = true;
    } else if (el.dataset.stHeld !== undefined) {
      el.disabled = el.dataset.stHeld === '1';
      delete el.dataset.stHeld;
    }
  });
}

// What is running, said on the row it belongs to, and once over the page for a
// change slow enough that the other controls are noticed waiting.
function working(control, text) {
  const option = control.closest('.st-option');
  const row = option || control.closest('.tweak-row');
  const line = document.createElement('p');
  line.className = 'st-status st-working';
  line.setAttribute('role', 'status');
  line.innerHTML = '<span class="badge">Working</span> ';
  line.append(text);
  const after = option ? option.lastElementChild
    : row ? row.querySelector('.tweak-note') : control.closest('.st-fold, .st-install');
  after.after(line);
  const page = setTimeout(function () {
    notify(text + ' Other settings wait until it finishes.', 'warn');
    clearTimeout(clpFlashTimer);
  }, 600);
  return function () {
    clearTimeout(page);
    line.remove();
  };
}


function switchText(input) {
  const label = input.id && CLP_ROOT.querySelector('label[for="' + input.id + '"]');
  const name = label ? label.textContent : input.getAttribute('aria-label');
  return (input.checked ? 'Switching on ' : 'Switching off ') + name + '…';
}


// The profile's select, or one of the three switches; MySQL's applies at its next restart.
function setMemory(control) {
  if (control.tagName === 'SELECT') {
    const label = control.options[control.selectedIndex].textContent;
    return change(control, '/api/memory', { profile: control.value }, 'Switching to the ' + label + ' profile…', 'Saved.');
  }
  const key = control.dataset.setting.slice('memory-'.length);
  if (key === 'mysql') {
    return change(control, '/api/memory', { mysql: control.checked },
      control.checked ? 'Saving and checking MySQL sizes…' : 'Restoring CloudPanel’s MySQL sizes…',
      control.checked ? 'Saved. MySQL uses these sizes at its next restart.' : 'Saved. CloudPanel’s MySQL sizes return at its next restart.');
  }
  return change(control, '/api/memory', { [key]: control.checked }, switchText(control), 'Saved.');
}


function change(control, path, body, progress, done) {
  return send(path, body, done, control, progress);
}

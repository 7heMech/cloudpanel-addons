async function post(path, body) {
  return call(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
}

// One change at a time. A second one started while the first ran answered with
// the page as it stood before the first landed, repainted over it and put the
// first one's controls back as if it had stopped, so every control waits.
let stQueue = Promise.resolve();

function exclusive(task) {
  const next = stQueue.then(task, task);
  stQueue = next.catch(function () {});
  return next;
}

// busy() covers buttons and switches; this page also has selects and a time.
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
  const after = option ? option.lastElementChild : row.querySelector('.tweak-note');
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

function change(control, path, body, progress, done) {
  if (control !== stRebootPending.control) flushRebootTime();
  return exclusive(async function () {
    clearNotice();
    hold(true);
    const finish = working(control, progress);
    try {
      const reply = await post(path, body);
      finish();
      hold(false);
      repaintView(CLP_ROOT.getElementById('clp-content'), reply.html);
      notify(done, 'ok');
    } catch (error) {
      finish();
      if (control.type === 'checkbox') control.checked = !control.checked;
      if (control.dataset.current !== undefined) control.value = control.dataset.current;
      const mode = CLP_ROOT.getElementById('reboot-mode');
      if (mode && control.closest('.st-reboot-time')) {
        mode.value = mode.dataset.current;
        CLP_ROOT.getElementById('reboot-time').hidden = mode.value !== 'time';
      }
      hold(false);
      notify(error.message, 'error');
    }
  });
}

function switchText(input) {
  const label = input.id && CLP_ROOT.querySelector('label[for="' + input.id + '"]');
  const name = label ? label.textContent : input.getAttribute('aria-label');
  return (input.checked ? 'Switching on ' : 'Switching off ') + name + '…';
}

function setUpdates(input) {
  return change(input, '/api/updates', { [input.dataset.setting]: input.checked }, switchText(input), 'Saved.');
}

function setUploadGuard(input) {
  return change(input, '/api/upload-guard', { enabled: input.checked }, switchText(input), 'Saved.');
}

function setRealIp(input) {
  return change(input, '/api/real-ip', { enabled: input.checked }, switchText(input), 'Saved.');
}

// A change restarts the panel and waits for it to answer.
function setPanelPhp(select) {
  const label = select.options[select.selectedIndex].textContent;
  return change(select, '/api/panel-php', { php: select.value },
    'Switching the panel to ' + label + '…', 'The panel answers on ' + label + '.');
}

function installUpdates(button) {
  return change(button, '/api/install-updates', {}, 'Installing unattended-upgrades…', 'unattended-upgrades is installed.');
}

// A time field reports every digit typed as a change, so a time is saved once
// it is left or after a pause, with the value it had then: a repaint by
// another change in between would otherwise put the old time back first.
let stRebootPending = { timer: 0, control: null, value: '' };

function flushRebootTime() {
  const pending = stRebootPending;
  if (!pending.timer) return;
  clearTimeout(pending.timer);
  stRebootPending = { timer: 0, control: null, value: '' };
  change(pending.control, '/api/updates', { rebootTime: pending.value }, 'Saving the reboot time…', 'Reboot timing saved.');
}

function setRebootTime(control) {
  const time = CLP_ROOT.getElementById('reboot-time');
  const at = CLP_ROOT.getElementById('reboot-mode').value === 'time';
  time.hidden = !at;
  clearTimeout(stRebootPending.timer);
  stRebootPending = { timer: 0, control: null, value: '' };
  if (!at) return change(control, '/api/updates', { rebootTime: 'now' }, 'Saving the reboot time…', 'Reboot timing saved.');
  if (!time.value) return;
  if (control !== time) time.focus();
  stRebootPending = { timer: setTimeout(flushRebootTime, 1500), control: time, value: time.value };
}

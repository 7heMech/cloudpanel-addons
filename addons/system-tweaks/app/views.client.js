async function post(path, body) {
  return call(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
}

// A progress notice the caller put up stays until the reply replaces it.
async function change(input, path, body, done, keepNotice) {
  if (!keepNotice) clearNotice();
  busy(true);
  try {
    const reply = await post(path, body);
    busy(false);
    repaintView(CLP_ROOT.getElementById('clp-content'), reply.html);
    notify(done, 'ok');
  } catch (error) {
    if (input) input.checked = !input.checked;
    busy(false);
    notify(error.message, 'error');
  }
}

function setUpdates(input) {
  return change(input, '/api/updates', { [input.dataset.setting]: input.checked }, 'Saved.');
}

function setUploadGuard(input) {
  return change(input, '/api/upload-guard', { enabled: input.checked }, 'Saved.');
}

function setRealIp(input) {
  return change(input, '/api/real-ip', { enabled: input.checked }, 'Saved.');
}

// A change restarts the panel and waits for it to answer, so its notice stays up.
async function setPanelPhp(select) {
  select.disabled = true;
  const label = select.options[select.selectedIndex].textContent;
  notify('Switching the panel to ' + label + '…', 'warn');
  clearTimeout(clpFlashTimer);
  busy(true);
  try {
    const reply = await post('/api/panel-php', { php: select.value });
    busy(false);
    repaintView(CLP_ROOT.getElementById('clp-content'), reply.html);
    notify('The panel answers on ' + label + '.', 'ok');
  } catch (error) {
    select.value = select.dataset.current || '';
    select.disabled = false;
    busy(false);
    notify(error.message, 'error');
  }
}

function installUpdates() {
  notify('Installing unattended-upgrades…', 'warn');
  clearTimeout(clpFlashTimer);
  return change(null, '/api/install-updates', {}, 'unattended-upgrades is installed.', true);
}

function rebootModeChanged(select) {
  const time = select.form.elements.time;
  time.hidden = select.value !== 'time';
  time.disabled = time.hidden;
  time.required = !time.hidden;
}

function saveRebootTime(event, form) {
  event.preventDefault();
  if (!form.reportValidity()) return;
  const mode = form.elements.mode.value;
  const rebootTime = mode === 'existing' ? null : mode === 'now' ? 'now' : form.elements.time.value;
  return change(null, '/api/updates', { rebootTime }, 'Reboot timing saved.');
}

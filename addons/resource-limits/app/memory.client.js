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

function switchText(input) {
  const label = input.id && CLP_ROOT.querySelector('label[for="' + input.id + '"]');
  const name = label ? label.textContent : input.getAttribute('aria-label');
  return (input.checked ? 'Switching on ' : 'Switching off ') + name + '…';
}


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


async function restartMysql(button) {
  const agreed = await confirmAction({
    title: 'Restart MySQL?',
    text: 'Every site loses its database for a few seconds while MySQL restarts. Any other MySQL setting waiting for a restart applies too.',
    confirmLabel: 'Restart MySQL',
    danger: true,
  });
  if (!agreed) return;
  send('/api/mysql-restart', {}, 'MySQL restarted.', button, 'Restarting MySQL…');
}

function change(control, path, body, progress, done) {
  return send(path, body, done, control, progress);
}

async function guardChange(path, body) {
  var message = document.getElementById('guard-message');
  var buttons = document.querySelectorAll('#guard-settings button, #clean-now');
  buttons.forEach(function (button) { button.disabled = true; });
  message.hidden = false;
  message.textContent = 'Applying changes…';
  try {
    await call('/api/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    location.reload();
  } catch (error) {
    message.textContent = error.message;
    buttons.forEach(function (button) { button.disabled = false; });
  }
}
document.getElementById('guard-settings')?.addEventListener('submit', function (event) {
  event.preventDefault();
  function number(id) { return Number(document.getElementById(id).value); }
  guardChange('configure', {
    protection: document.getElementById('guard-protection').value === 'true',
    cleanLegacyTmp: document.getElementById('guard-legacy').value === 'true',
    scratchMiB: number('guard-size'), retentionHours: number('guard-age'),
    minFreeMiB: number('guard-free'), minFreePercent: number('guard-percent'), minInodePercent: number('guard-inodes')
  });
});
document.getElementById('clean-now')?.addEventListener('click', function () { guardChange('clean', {}); });

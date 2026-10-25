function openFromRow(button, event) {
  clpOpenTerminal(CLP_BASE, button.dataset.domain, event.shiftKey);
}

(function () {
  const find = document.getElementById('fleet-find');
  if (!find) return;
  find.addEventListener('keydown', function (event) {
    if (event.key !== 'Enter') return;
    const shown = siteRows().filter(function (row) { return !row.hidden; });
    if (shown.length !== 1) return;
    event.preventDefault();
    clpOpenTerminal(CLP_BASE, shown[0].dataset.domain, event.shiftKey);
  });
  if (window.matchMedia('(pointer: fine)').matches) find.focus();
})();

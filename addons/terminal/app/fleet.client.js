function openFromRow(button, event) {
  clpOpenTerminal(CLP_BASE, button.dataset.domain, event.shiftKey);
}

const terminalSearch = document.getElementById('terminal-search');
const terminalRows = Array.from(document.querySelectorAll('.terminal-site-table tbody tr[data-domain]'));

function visibleRows() {
  return terminalRows.filter(function (row) { return !row.hidden; });
}

function filterSites() {
  const query = terminalSearch.value.trim().toLowerCase();
  terminalRows.forEach(function (row) {
    row.hidden = query !== '' && row.dataset.search.indexOf(query) === -1;
  });
  const shown = visibleRows().length;
  document.getElementById('terminal-count').textContent = query
    ? shown + ' of ' + plural(terminalRows.length, 'site')
    : plural(terminalRows.length, 'site');
  document.getElementById('terminal-none').hidden = shown !== 0;
}

if (terminalSearch) {
  terminalSearch.addEventListener('input', filterSites);
  terminalSearch.addEventListener('keydown', function (event) {
    if (event.key !== 'Enter') return;
    const shown = visibleRows();
    if (shown.length !== 1) return;
    event.preventDefault();
    clpOpenTerminal(CLP_BASE, shown[0].dataset.domain, event.shiftKey);
  });
}


function siteRows() {
  return Array.from(CLP_ROOT.querySelectorAll('tr[data-domain]'));
}

function selectedRows() {
  return siteRows().filter(function (row) {
    const box = row.querySelector('.site-checkbox');
    return box && box.checked;
  });
}

function selectAllSites(checked, repaint) {
  CLP_ROOT.querySelectorAll('.site-checkbox').forEach(function (box) { box.checked = checked; });
  repaint();
}

function toggleAllSites(repaint) {
  selectAllSites(selectedRows().length < siteRows().length, repaint);
}

function toggleSiteSelection(event, row, repaint) {
  const target = event.target;
  if (target && target !== row && target.closest && target.closest('input, button, a, label, select, textarea')) return;
  if (event.type === 'keydown') {
    if (event.key !== ' ' && event.key !== 'Enter') return;
    event.preventDefault();
  }
  const box = row.querySelector('.site-checkbox');
  if (!box || box.disabled) return;
  box.checked = !box.checked;
  repaint();
}

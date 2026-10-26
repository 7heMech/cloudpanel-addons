function siteRows() {
  return Array.from(CLP_ROOT.querySelectorAll('tr[data-domain]'));
}

function shownSiteRows() {
  return siteRows().filter(function (row) { return !row.hidden; });
}

function selectedRows() {
  return siteRows().filter(function (row) {
    const box = row.querySelector('.site-checkbox');
    return box && box.checked;
  });
}

function selectAllSites(checked, repaint) {
  shownSiteRows().forEach(function (row) {
    const box = row.querySelector('.site-checkbox');
    if (box && !box.disabled) box.checked = checked;
  });
  (repaint || paintFleetSelection)();
}

function toggleAllSites(repaint) {
  selectAllSites(selectedRows().length < shownSiteRows().length, repaint);
}

function toggleSiteSelection(event, row, repaint) {
  const target = event.target;
  if (target && target !== row && target.closest && target.closest('input, button, a, label, select, textarea, details')) return;
  if (event.type === 'keydown') {
    if (event.key !== ' ' && event.key !== 'Enter') return;
    event.preventDefault();
  }
  const box = row.querySelector('.site-checkbox');
  if (!box || box.disabled) return;
  box.checked = !box.checked;
  (repaint || paintFleetSelection)();
}

/**
 * The selection by the ids every site table uses: `site-selection` for the
 * count, `select-all` and `select-all-btn`, and `data-needs-selection` on each
 * control that acts on the selected sites.
 */
function paintFleetSelection() {
  siteRows().forEach(function (row) {
    const box = row.querySelector('.site-checkbox');
    row.setAttribute('aria-selected', String(Boolean(box && box.checked)));
  });
  const rows = shownSiteRows();
  const chosen = selectedRows().length;
  const every = rows.length > 0 && chosen === rows.length;
  const note = CLP_ROOT.getElementById('site-selection');
  if (note) note.textContent = chosen === 0 ? 'No sites selected' : chosen + ' of ' + rows.length + ' selected';
  CLP_ROOT.querySelectorAll('[data-needs-selection]').forEach(function (control) { control.disabled = chosen === 0; });
  const all = CLP_ROOT.getElementById('select-all');
  if (all) {
    all.checked = every;
    all.indeterminate = chosen > 0 && !every;
  }
  const allBtn = CLP_ROOT.getElementById('select-all-btn');
  if (allBtn) {
    allBtn.disabled = rows.length === 0;
    allBtn.textContent = every ? 'Deselect all' : 'Select all';
  }
}

// On a phone a long list shows only its first ten sites until the rest are
// asked for, so what the page has below the list stays a short scroll away.
let fleetPhone = null;
let fleetShowAll = false;

function showAllSites() {
  fleetShowAll = true;
  filterFleet();
}

/**
 * Search, filter and the ten-site cut on a phone only hide rows; a hidden row is
 * also deselected, so a bulk action never reaches a site that is not on screen.
 * A row matches the search on `data-find` (its domain when absent) and the
 * filter on a word of `data-show`.
 */
function filterFleet() {
  const find = CLP_ROOT.getElementById('fleet-find');
  const show = CLP_ROOT.getElementById('fleet-show');
  if (!find && !show) return;
  if (!fleetPhone) {
    fleetPhone = window.matchMedia('(max-width: 940px)');
    fleetPhone.addEventListener('change', filterFleet);
  }
  const query = find ? find.value.trim().toLowerCase() : '';
  const tag = show ? show.value : '';
  const cut = fleetPhone.matches && !fleetShowAll ? 10 : Infinity;
  const rows = siteRows();
  let matched = 0;
  rows.forEach(function (row) {
    const words = ' ' + (row.dataset.show || '') + ' ';
    const matches = (!query || (row.dataset.find || row.dataset.domain).toLowerCase().indexOf(query) !== -1)
      && (!tag || words.indexOf(' ' + tag + ' ') !== -1);
    if (matches) matched++;
    row.hidden = !matches || matched > cut;
    if (row.hidden) {
      const box = row.querySelector('.site-checkbox');
      if (box) box.checked = false;
    }
  });
  const summary = CLP_ROOT.getElementById('fleet-summary');
  if (summary) summary.textContent = query || tag ? matched + ' of ' + plural(rows.length, 'site') : summary.dataset.all;
  const none = CLP_ROOT.getElementById('fleet-none');
  if (none) none.hidden = matched > 0;
  const more = CLP_ROOT.getElementById('fleet-more');
  if (more) {
    more.hidden = matched <= cut;
    more.querySelector('button').textContent = 'Show all ' + plural(matched, 'site');
  }
  paintFleetSelection();
}

filterFleet();

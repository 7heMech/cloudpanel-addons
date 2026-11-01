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

// The column the rows are sorted by, as the key of its `th[data-sort]`, and 1
// or -1; null keeps the order the server drew them in. Kept here rather than
// in the page so a repaint sorts its new rows the same way.
let fleetSort = null;
// The ticked filter words, kept here for the same reason.
let fleetShown = [];

function fleetHeads() {
  return Array.prototype.slice.call(CLP_ROOT.querySelectorAll('.fleet-table th[data-sort]'));
}

/** A heading click: sort by its column, or the other way round when it already is. */
function sortFleetBy(key) {
  fleetSort = { key: key, dir: fleetSort && fleetSort.key === key ? -fleetSort.dir : 1 };
  filterFleet();
}

function pickFleetSort(key) {
  fleetSort = { key: key, dir: 1 };
  filterFleet();
}

/**
 * Rows by the sorted column: the `data-sort-<key>` of a row where it has one
 * (a status column ranks by tone, worst first), else the text of its cell; rows
 * without a value go last either way, and ties go by domain.
 */
function sortFleet() {
  const heads = fleetHeads();
  heads.forEach(function (th) {
    th.tabIndex = 0;
    th.onclick = function () { sortFleetBy(th.dataset.sort); };
    th.onkeydown = function (event) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      sortFleetBy(th.dataset.sort);
    };
    th.setAttribute('aria-sort', fleetSort && th.dataset.sort === fleetSort.key ? (fleetSort.dir > 0 ? 'ascending' : 'descending') : 'none');
  });
  const picker = CLP_ROOT.getElementById('fleet-sort');
  if (picker) {
    if (!picker.options.length) {
      heads.forEach(function (th) { picker.add(new Option(th.dataset.sortLabel || th.textContent.trim(), th.dataset.sort)); });
    }
    picker.closest('label').hidden = heads.length === 0;
    picker.value = fleetSort ? fleetSort.key : 'domain';
  }
  const head = fleetSort && heads.find(function (th) { return th.dataset.sort === fleetSort.key; });
  if (!head) return;
  const key = fleetSort.key;
  const value = function (row) {
    if (key === 'domain') return row.dataset.domain;
    if (row.hasAttribute('data-sort-' + key)) return row.getAttribute('data-sort-' + key);
    const cell = row.cells[head.cellIndex];
    return cell ? cell.textContent.trim() : '';
  };
  const dir = fleetSort.dir;
  siteRows().sort(function (a, b) {
    const left = value(a);
    const right = value(b);
    if (left !== right && (!left || !right)) return left ? -1 : 1;
    return dir * left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' }) || a.dataset.domain.localeCompare(b.dataset.domain);
  }).forEach(function (row) { row.parentNode.appendChild(row); });
}

function pickFleetFilter() {
  fleetShown = Array.prototype.map.call(CLP_ROOT.querySelectorAll('#fleet-show input:checked'), function (box) { return box.value; });
  filterFleet();
}

function clearFleetFilters() {
  fleetShown = [];
  const menu = CLP_ROOT.getElementById('fleet-show');
  if (menu) menu.open = false;
  filterFleet();
}

/** The ticked boxes by group, and the label of the menu: what is shown, in as few words as fit. */
function paintFleetFilters() {
  const groups = {};
  const boxes = Array.prototype.slice.call(CLP_ROOT.querySelectorAll('#fleet-show input[type="checkbox"]'));
  const ticked = boxes.filter(function (box) {
    box.checked = fleetShown.indexOf(box.value) !== -1;
    if (box.checked) (groups[box.dataset.group] = groups[box.dataset.group] || []).push(box.value);
    return box.checked;
  });
  const label = CLP_ROOT.getElementById('fleet-show-label');
  if (label) label.textContent = ticked.length === 0 ? 'All sites' : ticked.length === 1 ? ticked[0].parentNode.textContent.trim() : ticked.length + ' filters';
  const menu = CLP_ROOT.getElementById('fleet-show');
  if (menu) menu.classList.toggle('is-filtering', ticked.length > 0);
  return Object.keys(groups).map(function (group) { return groups[group]; });
}

/**
 * Search, filter and the ten-site cut on a phone only hide rows; a hidden row is
 * also deselected, so a bulk action never reaches a site that is not on screen.
 * A row matches the search on `data-find` (its domain when absent) and the
 * filter on its words in `data-show`.
 */
function filterFleet() {
  // A table too short for search still sorts by its headings.
  sortFleet();
  const find = CLP_ROOT.getElementById('fleet-find');
  const show = CLP_ROOT.getElementById('fleet-show');
  if (!find && !show) return paintFleetSelection();
  if (!fleetPhone) {
    fleetPhone = window.matchMedia('(max-width: 940px)');
    fleetPhone.addEventListener('change', filterFleet);
  }
  const query = find ? find.value.trim().toLowerCase() : '';
  const groups = paintFleetFilters();
  const cut = fleetPhone.matches && !fleetShowAll ? 10 : Infinity;
  const rows = siteRows();
  let matched = 0;
  rows.forEach(function (row) {
    const words = ' ' + (row.dataset.show || '') + ' ';
    const matches = (!query || (row.dataset.find || row.dataset.domain).toLowerCase().indexOf(query) !== -1)
      && groups.every(function (group) { return group.some(function (word) { return words.indexOf(' ' + word + ' ') !== -1; }); });
    if (matches) matched++;
    row.hidden = !matches || matched > cut;
    if (row.hidden) {
      const box = row.querySelector('.site-checkbox');
      if (box) box.checked = false;
    }
  });
  const summary = CLP_ROOT.getElementById('fleet-summary');
  if (summary) summary.textContent = query || groups.length ? matched + ' of ' + plural(rows.length, 'site') : summary.dataset.all;
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

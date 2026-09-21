/** Show only the directives the chosen process manager actually reads. */
function paintProfileModes() {
  const root = CLP_ROOT.getElementById('category-profile');
  if (!root) return;
  const mode = root.querySelector('[data-field="pm"]').value;
  root.querySelectorAll('[data-modes]').forEach(function (field) {
    field.hidden = field.dataset.modes.split(' ').indexOf(mode) === -1;
  });
}

// Reads the dialog, or reports the first field that is not a whole number and
// returns null. The server checks all of this again; refusing here is only so
// an obvious slip does not cost a round trip.
function readProfile() {
  const root = CLP_ROOT.getElementById('category-profile');
  if (!root) return null;
  const profile = {};
  let bad = '';
  root.querySelectorAll('[data-field]').forEach(function (input) {
    const key = input.dataset.field;
    if (key === 'pm') { profile.pm = input.value; return; }
    const raw = input.value.trim();
    if (!/^[0-9]+$/.test(raw)) {
      if (!bad) bad = (CLP_ROOT.querySelector('label[for="' + input.id + '"]') || {}).textContent || key;
      return;
    }
    profile[key] = Number(raw);
  });
  if (bad) {
    notify(bad + ' must be a whole number.', 'error');
    return null;
  }
  return profile;
}

function writeProfile(profile) {
  const root = CLP_ROOT.getElementById('category-profile');
  if (!root) return;
  root.querySelectorAll('[data-field]').forEach(function (input) {
    input.value = profile[input.dataset.field];
  });
  paintProfileModes();
}

// A change here rewrites pool files, renames rows and moves counts between
// categories, so the page is drawn again by the server rather than patched in
// nine places. The message survives the reload, so what happened is still said.
const FLASH_KEY = 'clp-php-resources-flash';

function reloadWith(message, kind) {
  try { sessionStorage.setItem(FLASH_KEY, JSON.stringify({ message: message, kind: kind })); } catch (e) {}
  location.reload();
}

function showCarriedFlash() {
  let carried = null;
  try {
    carried = sessionStorage.getItem(FLASH_KEY);
    if (carried) sessionStorage.removeItem(FLASH_KEY);
  } catch (e) { return; }
  if (!carried) return;
  try {
    const flash = JSON.parse(carried);
    notify(flash.message, flash.kind);
  } catch (e) {}
}

function plural(count, word) {
  return count + ' ' + word + (count === 1 ? '' : 's');
}

/** What to say when a change landed on some sites and not on others. */
function withFailures(message, failures) {
  if (!failures || !failures.length) return { message: message, kind: 'ok' };
  return {
    message: message + ' ' + plural(failures.length, 'site') + ' could not be written: ' + failures.join('; '),
    kind: 'warn',
  };
}

async function send(path, body, done) {
  clearNotice();
  busy(true);
  try {
    const reply = await call(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const flash = withFailures(done, (reply.data || {}).failures);
    reloadWith(flash.message, flash.kind);
  } catch (error) {
    notify(error.message, 'error');
    busy(false);
  }
}

// --- categories -----------------------------------------------------------

function openCategoryDialog(button) {
  const dialog = CLP_ROOT.getElementById('category-dialog');
  if (!dialog) return;
  const row = button.closest('tr[data-category]');
  const category = row ? JSON.parse(row.dataset.category) : null;
  dialog.dataset.categoryId = category ? category.id : '';
  CLP_ROOT.getElementById('category-dialog-title').textContent = category ? 'Edit category' : 'New category';
  CLP_ROOT.getElementById('category-name').value = category ? category.name : '';
  CLP_ROOT.getElementById('category-description').value = category ? category.description : '';
  writeProfile(category ? category.profile : JSON.parse(dialog.dataset.defaultProfile));
  dialog.showModal();
}

/** Dismiss the modal only when the press landed on the native dialog backdrop. */
function closeCategoryDialogOnBackdrop(event) {
  const dialog = event.currentTarget;
  if (event.target !== dialog) return;
  const rect = dialog.getBoundingClientRect();
  const inside = event.clientX >= rect.left && event.clientX <= rect.right &&
    event.clientY >= rect.top && event.clientY <= rect.bottom;
  if (!inside) dialog.close();
}

async function saveCategory() {
  const dialog = CLP_ROOT.getElementById('category-dialog');
  const name = CLP_ROOT.getElementById('category-name').value.trim();
  if (!name) {
    notify('Give the category a name first.', 'warn');
    return;
  }
  const profile = readProfile();
  if (!profile) return;
  const id = dialog.dataset.categoryId || null;
  await send('/api/categories', {
    id: id,
    name: name,
    description: CLP_ROOT.getElementById('category-description').value.trim(),
    profile: profile,
  }, id
    ? 'Saved. Every site in this category now runs these limits.'
    : 'Category created. Assign sites to it below.');
}

async function deleteCategory(button) {
  const row = button.closest('tr[data-category]');
  const category = JSON.parse(row.dataset.category);
  const count = Number(row.dataset.sites || '0');
  const details = ['The name and its limits are removed, here and from the choice for new sites.'];
  if (count) {
    details.push(plural(count, 'site') + ' in it go back to what CloudPanel writes for a new site: on demand, 250 max children, 100 requests per worker.');
  }
  const accepted = await confirmAction({
    title: 'Delete ' + category.name + '?',
    text: 'The limits saved under this name are discarded.',
    details: details,
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!accepted) return;
  await send('/api/categories/delete', { id: category.id }, 'Category deleted.');
}

async function setDefaultCategory(select) {
  const id = select.value || null;
  const label = select.options[select.selectedIndex].textContent;
  await send('/api/default', { categoryId: id }, id
    ? 'New sites will join ' + label + '. Sites that already exist are unchanged.'
    : 'New sites will keep the CloudPanel limits. Sites that already exist are unchanged.');
}

// --- sites ----------------------------------------------------------------

function siteRows() {
  return Array.from(CLP_ROOT.querySelectorAll('tr[data-domain]'));
}

function selectedRows() {
  return siteRows().filter(function (row) {
    const box = row.querySelector('.site-checkbox');
    return box && box.checked;
  });
}

function paintSelection() {
  const rows = siteRows();
  rows.forEach(function (row) {
    const box = row.querySelector('.site-checkbox');
    row.setAttribute('aria-selected', String(Boolean(box && box.checked)));
  });
  const chosen = selectedRows();
  const note = CLP_ROOT.getElementById('site-selection');
  if (note) note.textContent = chosen.length === 0 ? 'No sites selected' : chosen.length + ' of ' + rows.length + ' selected';
  const apply = CLP_ROOT.getElementById('assign-selected');
  if (apply) apply.disabled = chosen.length === 0;
  const all = CLP_ROOT.getElementById('select-all');
  if (all) {
    all.checked = rows.length > 0 && chosen.length === rows.length;
    all.indeterminate = chosen.length > 0 && chosen.length < rows.length;
  }
  const allBtn = CLP_ROOT.getElementById('select-all-btn');
  if (allBtn) {
    allBtn.disabled = rows.length === 0;
    allBtn.textContent = rows.length > 0 && chosen.length === rows.length ? 'Deselect all' : 'Select all';
  }
}

function selectAllSites(checked) {
  CLP_ROOT.querySelectorAll('.site-checkbox').forEach(function (box) { box.checked = checked; });
  paintSelection();
}

function toggleAllSites() {
  const rows = siteRows();
  const chosen = selectedRows();
  selectAllSites(chosen.length < rows.length);
}

function categoryLabel(id) {
  const picker = CLP_ROOT.getElementById('bulk-category');
  const option = picker ? picker.querySelector('option[value="' + id + '"]') : null;
  return option ? option.textContent : id;
}

// One row is the ordinary correction after a fleet-wide change, so it acts at
// once rather than behind a confirmation: it chooses limits rather than
// destroying anything, and choosing again puts it back.
async function assignRow(select) {
  const row = select.closest('tr[data-domain]');
  const id = select.value || null;
  await send('/api/assign', { domains: [row.dataset.domain], categoryId: id }, id
    ? row.dataset.domain + ' is now in ' + categoryLabel(id) + '.'
    : row.dataset.domain + ' is back on the CloudPanel limits.');
}

async function assignSelected() {
  const rows = selectedRows();
  if (!rows.length) {
    notify('Select at least one site first.', 'warn');
    return;
  }
  const picker = CLP_ROOT.getElementById('bulk-category');
  if (!picker.value) {
    notify('Choose a category to put them in first.', 'warn');
    return;
  }
  const id = picker.value === 'none' ? null : picker.value;
  const label = picker.options[picker.selectedIndex].textContent;
  const moving = rows.filter(function (row) { return (row.dataset.categoryId || '') !== (id || ''); });
  if (!moving.length) {
    notify('Those sites are already there; nothing to change.', 'ok');
    return;
  }
  const accepted = await confirmAction({
    title: id
      ? 'Put ' + plural(rows.length, 'site') + ' in ' + label + '?'
      : 'Take ' + plural(rows.length, 'site') + ' out of their category?',
    text: id
      ? 'Their PHP-FPM pools are rewritten with the limits saved under that name, and PHP-FPM is reloaded.'
      : 'Their PHP-FPM pools go back to what CloudPanel writes for a new site.',
    details: [
      moving.length + ' of the ' + plural(rows.length, 'selected site') + ' change; the rest are already there.',
      'A reload does not interrupt requests that are already running.',
    ],
    confirmLabel: id ? 'Assign' : 'Remove',
    danger: !id,
  });
  if (!accepted) return;
  await send('/api/assign', {
    domains: rows.map(function (row) { return row.dataset.domain; }),
    categoryId: id,
  }, id
    ? plural(rows.length, 'site') + ' now follow ' + label + '.'
    : plural(rows.length, 'site') + ' are back on the CloudPanel limits.');
}

// Drift is what a PHP version change leaves behind: CloudPanel rewrites the
// pool file from its own template, and the category is no longer what runs.
// Repair fixes it within fifteen minutes; this is that same fix, now.
async function repairDrifted() {
  const groups = new Map();
  siteRows().forEach(function (row) {
    if (row.dataset.drifted !== 'true' || !row.dataset.categoryId) return;
    if (!groups.has(row.dataset.categoryId)) groups.set(row.dataset.categoryId, []);
    groups.get(row.dataset.categoryId).push(row.dataset.domain);
  });
  if (!groups.size) return;
  clearNotice();
  busy(true);
  const failures = [];
  let repaired = 0;
  for (const entry of groups) {
    try {
      const reply = await call('/api/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domains: entry[1], categoryId: entry[0] }),
      });
      const written = (reply.data || {}).failures || [];
      written.forEach(function (failure) { failures.push(failure); });
      repaired += entry[1].length - written.length;
    } catch (error) {
      failures.push(categoryLabel(entry[0]) + ': ' + error.message);
    }
  }
  const flash = withFailures(plural(repaired, 'site') + ' are back on the limits of their category.', failures);
  reloadWith(flash.message, flash.kind);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function () { showCarriedFlash(); paintSelection(); });
} else {
  showCarriedFlash();
  paintSelection();
}

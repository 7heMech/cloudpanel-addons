let archiveState = JSON.parse(CLP_ROOT.getElementById('archive-state')?.textContent || '{}');

function archiveRepaint(reply) {
  if (reply && reply.html) repaintView(CLP_ROOT.getElementById('archive-root'), reply.html);
  archiveState = JSON.parse(CLP_ROOT.getElementById('archive-state')?.textContent || '{}');
  paintFleetSelection();
  followJobProgress(archiveFinished);
}

async function archiveFinished() {
  try {
    archiveRepaint(await call('/api/state'));
  } catch (error) {
    notify(error.message, 'error');
  }
}

async function archivePost(path, body, from) {
  busy(true);
  try {
    const reply = await call(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (from) from.close();
    archiveRepaint(reply);
  } catch (error) {
    if (from && from.open) {
      let box = from.querySelector('.alert');
      if (!box) {
        box = document.createElement('div');
        box.className = 'alert';
        box.setAttribute('role', 'alert');
        from.querySelector('.dialog-header').after(box);
      }
      box.textContent = error.message;
    } else notify(error.message, 'error');
  } finally {
    busy(false);
  }
}

function archiveOpen() {
  if (archiveState.job) return notify('Wait for the running job to finish.', 'warn');
  const domains = selectedRows().map(function (row) { return row.dataset.domain; });
  if (!domains.length) return;
  const dialog = CLP_ROOT.getElementById('archive-dialog');
  const form = CLP_ROOT.getElementById('archive-form');
  form.reset();
  dialog.querySelectorAll('.alert').forEach(function (box) { box.remove(); });
  CLP_ROOT.getElementById('archive-heading').textContent = 'Archive ' + plural(domains.length, 'site') + '?';
  CLP_ROOT.getElementById('archive-list').innerHTML = domains.map(function (domain) {
    const li = document.createElement('li');
    li.textContent = domain;
    return li.outerHTML;
  }).join('');
  CLP_ROOT.getElementById('archive-submit').textContent = domains.length === 1 ? 'Archive and delete' : 'Archive and delete ' + domains.length;
  archiveSyncRedirect();
  dialog.showModal();
}

function archiveSyncRedirect() {
  const box = CLP_ROOT.getElementById('archive-form').elements.namedItem('redirect');
  const on = Boolean(box && box.checked);
  const fields = CLP_ROOT.getElementById('archive-redirect-fields');
  if (!fields) return;
  fields.hidden = !on;
  CLP_ROOT.getElementById('archive-keep-path').hidden = !on;
  CLP_ROOT.getElementById('archive-target').required = on;
}

function archiveStart(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const field = function (name) { return form.elements.namedItem(name); };
  const redirect = field('redirect') && field('redirect').checked
    ? { target: field('target').value.trim(), status: Number(field('status').value), keepPath: field('keepPath').checked, keepQuery: true }
    : null;
  archivePost('/api/archive', { domains: selectedRows().map(function (row) { return row.dataset.domain; }), redirect: redirect },
    CLP_ROOT.getElementById('archive-dialog'));
}

function archiveFind(id) {
  return archiveState.archives.find(function (archive) { return archive.id === id; });
}

async function archiveRestore(id) {
  const archive = archiveFind(id);
  const accepted = await confirmAction({
    title: 'Restore ' + archive.domain + '?',
    text: 'CloudPanel creates the site again, and its files and databases are put back from the archive. The archive stays.',
    details: archive.redirect ? ['If ' + archive.domain + ' is still a redirect domain, delete the redirect on the DNS page first.'] : [],
    confirmLabel: 'Restore',
  });
  if (accepted) archivePost('/api/restore', { id: id });
}

async function archiveDelete(id) {
  const archive = archiveFind(id);
  const accepted = await confirmAction({
    title: 'Delete the archive of ' + archive.domain + '?',
    text: 'Its files and databases are deleted from this server for good.',
    confirmLabel: 'Delete', danger: true, typed: archive.domain,
  });
  if (accepted) archivePost('/api/delete', { id: id });
}

/** A Sites row's Archive link opens this page with the site picked. */
(function () {
  const domain = new URLSearchParams(location.search).get('site');
  const row = domain && CLP_ROOT.querySelector('tr[data-domain="' + CSS.escape(domain) + '"]');
  const box = row && row.querySelector('.site-checkbox');
  if (box && !box.disabled) {
    box.checked = true;
    paintFleetSelection();
    archiveOpen();
  }
})();

paintFleetSelection();
followJobProgress(archiveFinished);

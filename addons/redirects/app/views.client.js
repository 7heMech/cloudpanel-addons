let redirState = JSON.parse(CLP_ROOT.getElementById('redir-state')?.textContent || '{}');
let redirReviewToken = '';
let redirShown = '';
let redirFound = [];

const REDIR_ACTION_LABELS = { create: 'Create', update: 'Update', delete: 'Delete', note: 'Note' };

function redirEsc(value) {
  return String(value).replace(/[&<>"']/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; });
}

function redirFindEntry(source) {
  return (redirState.redirects || []).find(function (candidate) { return candidate.source === source; });
}

function redirDialogError(dialog, message) {
  let box = dialog.querySelector('.redir-dialog-error');
  if (!box) {
    box = document.createElement('div');
    box.className = 'alert redir-dialog-error';
    box.setAttribute('role', 'alert');
    dialog.querySelector('.dialog-header').after(box);
  }
  box.textContent = message;
  box.scrollIntoView({ block: 'nearest' });
}

function redirOpen(id) {
  const dialog = CLP_ROOT.getElementById(id);
  dialog.querySelectorAll('.redir-dialog-error').forEach(function (box) { box.remove(); });
  if (!dialog.open) dialog.showModal();
  return dialog;
}

async function redirPost(path, body, from) {
  busy(true);
  try {
    const reply = await call(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    if (reply.html) {
      repaintView(CLP_ROOT.getElementById('redir-root'), reply.html);
      redirState = reply.data;
    }
    if (from) from.close();
    if (reply.data && reply.data.review) redirShowReview(reply.data.review, reply.data.notice);
    else if (reply.data && reply.data.notice) notify(reply.data.notice, 'ok');
    return reply;
  } catch (error) {
    const open = CLP_ROOT.querySelector('dialog[open]');
    if (open) redirDialogError(open, error.message);
    else notify(error.message, 'error');
    return null;
  } finally {
    busy(false);
  }
}

function redirChangesHtml(changes) {
  if (!changes.length) return '<p class="hint">Nothing to change.</p>';
  return '<ul class="redir-changes">' + changes.map(function (change) {
    return '<li><span class="badge redir-' + change.action + '">' + (REDIR_ACTION_LABELS[change.action] || redirEsc(change.action)) + '</span><div>' +
      '<strong>' + redirEsc(change.subject) + '</strong><span class="redir-change-detail">' + redirEsc(change.detail) + '</span>' +
      (change.before ? '<span class="hint">Now: ' + redirEsc(change.before) + '</span>' : '') +
      (change.waits ? '<span class="hint tone-warn">Waits for your review</span>' : '') + '</div></li>';
  }).join('') + '</ul>';
}

function redirProblemsHtml(problems) {
  return problems.length ? '<div class="alert">' + problems.map(redirEsc).join('<br>') + '</div>' : '';
}

function redirShowReview(review, notice) {
  redirReviewToken = review.token || '';
  CLP_ROOT.getElementById('redir-review-heading').textContent = review.title;
  CLP_ROOT.getElementById('redir-review-text').textContent = (notice ? notice + ' ' : '') + review.text;
  const busyItems = review.sites.filter(function (plan) { return plan.changes.length || plan.problems.length; });
  const quiet = review.sites.length - busyItems.length;
  CLP_ROOT.getElementById('redir-review-sites').innerHTML = busyItems.map(function (plan) {
    return '<section class="redir-review-item"><h3>' + redirEsc(plan.domain) + '</h3>' +
      redirProblemsHtml(plan.problems) + (plan.problems.length ? '' : redirChangesHtml(plan.changes)) + '</section>';
  }).join('') + (quiet ? '<p class="hint">' + plural(quiet, busyItems.length ? 'other redirect' : 'redirect') + ' already ' + (quiet === 1 ? 'matches' : 'match') + '.</p>' : '');
  const confirm = CLP_ROOT.getElementById('redir-review-confirm');
  confirm.textContent = review.confirmLabel;
  confirm.className = review.danger ? 'btn btn-danger' : 'btn btn-primary';
  confirm.hidden = review.blocked;
  redirOpen('redir-review-dialog');
}

function redirConfirm() {
  redirPost('/api/confirm', { token: redirReviewToken }, CLP_ROOT.getElementById('redir-review-dialog'));
}

async function redirCheck(button) {
  button.textContent = 'Checking…';
  if (!await redirPost('/api/check', {})) button.textContent = 'Check now';
}

function redirSetAutomatic(on) {
  redirPost('/api/automatic', { automatic: on });
}

// --- Add / edit / delete redirect ------------------------------------------

function redirSyncWhere() {
  const form = CLP_ROOT.getElementById('redir-edit-form');
  const mode = form.elements.namedItem('mode').value;
  const hasCf = (redirState.connections || []).length > 0;
  CLP_ROOT.getElementById('redir-where').textContent = mode === 'local'
    ? 'Served by a static stand-in site on this server with a Let\'s Encrypt certificate covering every effective host. Non-web DNS records stay untouched.'
    : hasCf
      ? 'If a connected Cloudflare zone matches, Cloudflare answers with a Single Redirect rule and proxied placeholder record. Otherwise a local stand-in site on this server answers it.'
      : 'With no Cloudflare connection, a static stand-in site on this server answers it and requests a Let\'s Encrypt certificate once the domain points here.';
}

function redirEdit(source) {
  const redirect = source ? redirFindEntry(source) : null;
  const form = CLP_ROOT.getElementById('redir-edit-form');
  form.reset();
  const field = function (name) { return form.elements.namedItem(name); };
  field('source').value = redirect ? redirect.source : '';
  field('source').readOnly = Boolean(redirect);
  field('target').value = redirect ? redirect.target : '';
  field('status').value = String(redirect ? redirect.status : 301);
  field('mode').value = redirect && redirect.mode === 'local' ? 'local' : 'auto';
  field('keepPath').checked = redirect ? redirect.keepPath : true;
  field('keepQuery').checked = redirect ? redirect.keepQuery : true;
  const hasCf = (redirState.connections || []).length > 0;
  CLP_ROOT.getElementById('redir-mode-field').hidden = !hasCf && !(redirect && redirect.mode === 'local');
  CLP_ROOT.getElementById('redir-delete-btn').hidden = !redirect;
  CLP_ROOT.getElementById('redir-edit-heading').textContent = redirect ? 'Edit ' + redirect.source : 'Add redirect';
  redirSyncWhere();
  CLP_ROOT.getElementById('redir-detail-dialog').close();
  redirOpen('redir-edit-dialog');
}

function redirSave(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const field = function (name) { return form.elements.namedItem(name); };
  redirPost('/api/redirects', {
    source: field('source').value.trim(),
    target: field('target').value.trim(),
    status: Number(field('status').value),
    mode: field('mode').value,
    keepPath: field('keepPath').checked,
    keepQuery: field('keepQuery').checked,
  }, CLP_ROOT.getElementById('redir-edit-dialog'));
}

async function redirDelete() {
  const dialog = CLP_ROOT.getElementById('redir-edit-dialog');
  const source = CLP_ROOT.getElementById('redir-edit-form').elements.namedItem('source').value;
  const redirect = redirFindEntry(source);
  dialog.close();
  const hasCf = (redirState.connections || []).length > 0;
  const cfServed = hasCf && redirect && redirect.mode !== 'local' && !redirect.standIn;
  if (redirState.automatic && cfServed) return redirPost('/api/redirects/delete', { source: source });
  const accepted = await confirmAction({
    title: 'Delete the redirect for ' + source + '?',
    text: redirect && redirect.standIn
      ? 'Its stand-in site is deleted from this server, so ' + source + ' stops redirecting. Non-web DNS records stay untouched.'
      : hasCf
        ? 'Redirects stops managing it. Any Cloudflare rule and DNS records stay as they are.'
        : 'Redirects stops managing it.',
    confirmLabel: 'Delete',
    danger: true,
  });
  if (accepted) redirPost('/api/redirects/delete', { source: source });
}

// --- Details dialog --------------------------------------------------------

function redirShowDetail(source) {
  const redirect = redirFindEntry(source);
  if (!redirect) return;
  redirShown = source;
  const plan = redirect.plan;
  const heading = CLP_ROOT.getElementById('redir-detail-heading');
  heading.textContent = source;
  const row = CLP_ROOT.querySelector('tr[data-redirect="' + CSS.escape(source) + '"]');
  const chip = row && row.querySelector('.redir-status .badge');
  if (chip) heading.appendChild(chip.cloneNode(true));

  let html = '';
  if (!plan) {
    html += '<p class="hint">Not checked yet. Check now reads Cloudflare and checks local stand-in sites.</p>';
  } else {
    html += redirProblemsHtml(plan.problems);
    if (plan.zone && plan.zone.status !== 'active' && plan.zone.nameServers.length) {
      html += '<div class="notice dns-nameservers"><span>Set ' + redirEsc(plan.zone.name) + '\'s nameservers at its registrar:</span>' +
        plan.zone.nameServers.map(function (server) {
          return '<span class="dns-copy"><code>' + redirEsc(server) + '</code><button class="dns-clip" type="button" title="Copy" aria-label="Copy ' + redirEsc(server) +
            '" onclick="redirCopyText(this.previousElementSibling.textContent)">' + REDIR_CLIPBOARD + '</button></span>';
        }).join('') + '</div>';
    }
    if (plan.zoneChoices.length) {
      html += '<div class="redir-choice"><label for="redir-zone-choice">Manage ' + redirEsc(plan.zoneChoices[0].zone) + ' through</label><div class="redir-inline">' +
        '<select id="redir-zone-choice">' + plan.zoneChoices.map(function (choice) {
          return '<option value="' + redirEsc(choice.connectionId + '/' + choice.zoneId) + '">' + redirEsc(choice.label) + '</option>';
        }).join('') + '</select><button class="btn" type="button" onclick="redirChooseZone()">Use this</button></div></div>';
    }
    if (plan.held && !plan.problems.length) {
      html += '<div class="notice">Cloudflare connections changed, so moving this redirect waits until you review and confirm the changes below.</div>';
    }
    if (!plan.problems.length && plan.changes.length) {
      html += '<h3 class="redir-section">' + (redirState.automatic ? 'To change' : 'Differences, not changed until Redirects is Automatic') + '</h3>' +
        redirChangesHtml(plan.changes);
      if (redirState.automatic && !plan.held && plan.changes.some(function (change) { return change.action !== 'note'; })) {
        html += '<p class="hint">The next check makes these, within 15 minutes.</p>';
      }
    }
  }

  const kept = [redirect.keepPath && 'path', redirect.keepQuery && 'query string'].filter(Boolean);
  const served = redirect.mode === 'local'
    ? 'A stand-in site on this server (forced local)'
    : plan && plan.zone
      ? 'Cloudflare' + (redirect.standIn ? ' (stand-in site retires once active)' : '')
      : redirect.standIn
        ? 'A stand-in site on this server'
        : (redirState.connections || []).length
          ? 'Cloudflare if a zone matches, else a stand-in site on this server'
          : 'A stand-in site on this server, once Redirects is Automatic';
  html += '<h3 class="redir-section">Redirect</h3><dl class="redir-facts">' +
    '<dt>Redirects to</dt><dd class="redir-change-detail">' + redirEsc(redirect.target) + '</dd>' +
    '<dt>Status</dt><dd>' + redirect.status + (kept.length ? ' · keeps the ' + kept.join(' and ') : '') + '</dd>' +
    '<dt>Served by</dt><dd>' + redirEsc(served) + '</dd>';
  if (plan && plan.zone) {
    html += '<dt>Zone</dt><dd>' + redirEsc(plan.zone.name) + ' · ' + redirEsc(plan.zone.status) + '</dd>' +
      '<dt>Through</dt><dd>' + redirEsc(plan.zone.connection) + ' · ' + redirEsc(plan.zone.account) + '</dd>';
  }
  html += '</dl>';
  CLP_ROOT.getElementById('redir-detail-body').innerHTML = html;
  const reviewBtn = CLP_ROOT.getElementById('redir-detail-review');
  const pending = plan && !plan.problems.length && plan.changes.some(function (change) { return change.action !== 'note'; });
  reviewBtn.hidden = !(redirState.automatic && plan && plan.held && pending);
  redirOpen('redir-detail-dialog');
}

function redirReviewHeld() {
  redirPost('/api/redirects/review', { source: redirShown }, CLP_ROOT.getElementById('redir-detail-dialog'));
}

async function redirChooseZone() {
  const redirect = redirFindEntry(redirShown);
  const choice = CLP_ROOT.getElementById('redir-zone-choice').value.split('/');
  await redirPost('/api/zone', {
    zone: redirect.plan.zoneChoices[0].zone,
    connectionId: choice[0],
    zoneId: choice[1],
  }, CLP_ROOT.getElementById('redir-detail-dialog'));
}

// --- Find & take over in Cloudflare ----------------------------------------

async function redirFind(button) {
  const label = button.textContent;
  button.textContent = 'Reading Cloudflare…';
  const reply = await redirPost('/api/redirects/find', {});
  button.textContent = label;
  if (reply && reply.data && reply.data.found) redirShowFound(reply.data.found);
}

function redirShowFound(found) {
  redirFound = found.redirects;
  const notes = found.notes.length ? '<div class="alert">' + found.notes.map(redirEsc).join('<br>') + '</div>' : '';
  CLP_ROOT.getElementById('redir-found-body').innerHTML = notes + (redirFound.length
    ? '<div class="table-scroll"><table class="fleet-table redir-found-table"><thead><tr><th class="site-select"><input type="checkbox" checked aria-label="Select all" onchange="redirSelectFound(this.checked)"></th>' +
      '<th>Domain</th><th>Redirects to</th><th>Status</th><th>Keep path</th></tr></thead><tbody>' + redirFound.map(function (redirect, index) {
        return '<tr><td class="site-select"><input type="checkbox" name="take" value="' + index + '" checked aria-label="Take over ' + redirEsc(redirect.source) + '"></td>' +
          '<td class="site-cell"><strong>' + redirEsc(redirect.source) + '</strong>' + (redirect.source === redirect.zone ? '<span class="hint">and www</span>' : '') + '</td>' +
          '<td data-label="Redirects to" class="redir-change-detail">' + redirEsc(redirect.target) + '</td>' +
          '<td data-label="Status">' + redirect.status + '</td>' +
          '<td data-label="Keep path"><label class="switch"><input type="checkbox" name="keepPath" data-index="' + index + '"' + (redirect.keepPath ? ' checked' : '') +
          ' aria-label="Keep the path for ' + redirEsc(redirect.source) + '"><span></span></label></td></tr>';
      }).join('') + '</tbody></table></div>'
    : '<div class="empty">No whole-domain redirect rules are waiting to be taken over.</div>');
  CLP_ROOT.getElementById('redir-found-submit').hidden = !redirFound.length;
  redirOpen('redir-found-dialog');
}

function redirSelectFound(on) {
  CLP_ROOT.querySelectorAll('#redir-found-body input[name="take"]').forEach(function (box) { box.checked = on; });
}

function redirTakeOver(event) {
  event.preventDefault();
  const body = CLP_ROOT.getElementById('redir-found-body');
  const chosen = Array.from(body.querySelectorAll('input[name="take"]:checked')).map(function (box) {
    const redirect = redirFound[Number(box.value)];
    const keepPath = body.querySelector('input[name="keepPath"][data-index="' + box.value + '"]').checked;
    return { source: redirect.source, target: redirect.target, status: redirect.status, keepPath: keepPath, keepQuery: redirect.keepQuery };
  });
  if (!chosen.length) return redirDialogError(CLP_ROOT.getElementById('redir-found-dialog'), 'Select at least one redirect.');
  redirPost('/api/redirects/take-over', { redirects: chosen }, CLP_ROOT.getElementById('redir-found-dialog'));
}

// --- Shared Cloudflare connections -----------------------------------------

function redirEditConnection(id) {
  const connection = id ? (redirState.connections || []).find(function (candidate) { return candidate.id === id; }) : null;
  const dialog = CLP_ROOT.getElementById('redir-cf-connection-dialog');
  const form = CLP_ROOT.getElementById('redir-cf-connection-form');
  form.reset();
  form.elements.namedItem('id').value = id || '';
  form.elements.namedItem('label').value = connection ? connection.label : '';
  const token = form.elements.namedItem('token');
  token.required = !connection;
  token.placeholder = connection ? 'Leave empty to keep the saved token' : 'Paste the token';

  if (redirState.tokens) dialog.dataset.cfTemplates = JSON.stringify(redirState.tokens);
  const dnsBox = CLP_ROOT.getElementById('redir-cf-scope-dns');
  const redirBox = CLP_ROOT.getElementById('redir-cf-scope-redirects');
  const gateBox = CLP_ROOT.getElementById('redir-cf-scope-gate');
  if (dnsBox) dnsBox.checked = Boolean(redirState.dnsEnabled);
  if (redirBox) redirBox.checked = true;
  if (gateBox) gateBox.checked = Boolean(redirState.firewallEnabled);
  cfSyncScope('redir-cf');

  const ips = redirState.serverIps || [];
  const ipsEl = CLP_ROOT.getElementById('redir-cf-token-ips');
  const ipsHint = CLP_ROOT.getElementById('redir-cf-token-ips-hint');
  if (ipsEl) ipsEl.textContent = ips.join(' ');
  if (ipsHint) ipsHint.hidden = !ips.length;

  CLP_ROOT.getElementById('redir-cf-connection-heading').textContent = connection ? 'Edit ' + connection.label : 'Connect Cloudflare';
  form.querySelector('[type="submit"]').textContent = connection ? 'Save' : 'Connect';
  const errBox = dialog.querySelector('[data-error]');
  if (errBox) { errBox.hidden = true; errBox.textContent = ''; }
  redirOpen('redir-cf-connection-dialog');
  token.focus();
}

function redirSaveConnection(event) {
  event.preventDefault();
  const form = event.currentTarget;
  redirPost('/api/connections', {
    id: form.elements.namedItem('id').value || null,
    label: form.elements.namedItem('label').value,
    token: form.elements.namedItem('token').value,
  }, CLP_ROOT.getElementById('redir-cf-connection-dialog'));
}

async function redirRemoveConnection(id) {
  const connection = (redirState.connections || []).find(function (candidate) { return candidate.id === id; });
  const accepted = await confirmAction({
    title: 'Remove ' + (connection ? connection.label : id) + '?',
    text: 'Its token is deleted from this server. DNS and Firewall share this connection; redirects using it will wait for review before changing.',
    confirmLabel: 'Remove',
    danger: true,
  });
  if (accepted) redirPost('/api/connections/remove', { id: id });
}

function redirCopyText(text) {
  if (!navigator.clipboard || !navigator.clipboard.writeText) return notify('Select ' + text + ' and copy it.', 'warn');
  navigator.clipboard.writeText(text).then(
    function () { notify(text + ' copied.', 'ok'); },
    function () { notify('Select ' + text + ' and copy it.', 'warn'); }
  );
}

function redirCopyElement(id, label) {
  const node = CLP_ROOT.getElementById(id);
  if (!node) return;
  const text = node.textContent || '';
  if (!navigator.clipboard || !navigator.clipboard.writeText) return notify('Select the text and copy it.', 'warn');
  navigator.clipboard.writeText(text).then(
    function () { notify((label || 'Text') + ' copied.', 'ok'); },
    function () { notify('Select the text and copy it.', 'warn'); }
  );
}

/** A press on the backdrop closes a dialog; a drag that started in a field and ended outside does not. */
CLP_ROOT.querySelectorAll('dialog').forEach(function (dialog) {
  dialog.addEventListener('mousedown', function (event) {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    const inside = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
    if (!inside) dialog.close();
  });
});

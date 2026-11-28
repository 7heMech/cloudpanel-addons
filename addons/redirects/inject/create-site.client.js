// Create Site redirect replacement helper on CloudPanel's native Create Site forms.
//
// Plain ES5, no shared client bundle, zero `name` attributes on any node, and
// zero submit interception so silent deletion stays off and CloudPanel's own
// submission flow (plus WP Tools and Auto-SSL) keeps working unchanged.
(function () {
  var box = document.querySelector('[data-clp-redirects-create-site]');
  if (!box) return;
  var form = box.closest('form');
  if (!form) return;
  var input = form.querySelector('input[id$="_domainName"], input[name$="[domainName]"]');
  if (!input) return;

  var url = box.getAttribute('data-url');
  var ACTION_LABELS = { create: 'Create', update: 'Update', delete: 'Delete', note: 'Note' };

  function normalizeHost(value) {
    var text = String(value || '').trim().toLowerCase();
    text = text.replace(/^https?:\/\//, '');
    var slash = text.indexOf('/');
    if (slash >= 0) text = text.slice(0, slash);
    return text.replace(/\.+$/, '');
  }

  function readCsrf() {
    var match = document.cookie.match(/(?:^|;\s*)clp_addons_csrf=([^;]+)/);
    return match ? match[1] : null;
  }

  function ensureCsrf() {
    var existing = readCsrf();
    if (existing) return Promise.resolve(existing);
    return fetch(url + '/api/session', { credentials: 'same-origin' }).then(function () {
      var token = readCsrf();
      if (!token) throw new Error('Redirects did not answer. Reload the page and try again.');
      return token;
    });
  }

  function postJson(path, body) {
    return ensureCsrf().then(function (token) {
      return fetch(url + path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-CLP-Addons-CSRF': token,
        },
        body: JSON.stringify(body),
      });
    }).then(function (response) {
      return response.json().catch(function () {
        return { ok: false, error: 'Redirects answered ' + response.status };
      });
    }, function () {
      return { ok: false, error: 'Redirects did not answer' };
    }).then(function (reply) {
      if (!reply || reply.ok !== true) throw new Error((reply && reply.error) || 'The Redirects request failed');
      return reply.data;
    });
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function init(data) {
    var redirects = Array.isArray(data.redirects) ? data.redirects.slice() : [];
    if (!redirects.length) return;

    // Position the inline notice right beneath the domain field's row when present.
    var domainRow = input.closest('.row');
    if (domainRow && domainRow.parentNode && domainRow.parentNode === box.parentNode) {
      domainRow.parentNode.insertBefore(box, domainRow.nextSibling);
    }

    // Confirmation <dialog> lives outside the form with zero named fields.
    var dialog = el('dialog', 'clp-redir-cs-dialog');
    dialog.setAttribute('aria-labelledby', 'clp-redir-cs-dialog-title');
    var head = el('div', 'clp-redir-cs-dialog-head');
    var titleEl = el('h5');
    titleEl.id = 'clp-redir-cs-dialog-title';
    var closeBtn = el('button', 'btn-close');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close');
    head.appendChild(titleEl);
    head.appendChild(closeBtn);

    var bodyEl = el('div', 'clp-redir-cs-dialog-body');
    var dialogError = el('div', 'alert alert-danger clp-redir-cs-dialog-error');
    dialogError.setAttribute('role', 'alert');
    dialogError.hidden = true;
    var dialogText = el('p', 'clp-redir-cs-dialog-text');
    var planBox = el('div', 'clp-redir-cs-plan');
    bodyEl.appendChild(dialogError);
    bodyEl.appendChild(dialogText);
    bodyEl.appendChild(planBox);

    var foot = el('div', 'clp-redir-cs-dialog-foot');
    var cancelBtn = el('button', 'btn btn-gray', 'Cancel');
    cancelBtn.type = 'button';
    var confirmBtn = el('button', 'btn btn-danger', 'Replace redirect');
    confirmBtn.type = 'button';
    foot.appendChild(cancelBtn);
    foot.appendChild(confirmBtn);

    dialog.appendChild(head);
    dialog.appendChild(bodyEl);
    dialog.appendChild(foot);
    document.body.appendChild(dialog);

    var dialogBusy = false;
    var pendingToken = '';
    var pendingSource = '';
    var replacedDomain = '';

    function showDialogError(message) {
      dialogError.textContent = message;
      dialogError.hidden = !message;
    }

    function setDialogBusy(on) {
      dialogBusy = on;
      confirmBtn.disabled = on;
      cancelBtn.disabled = on;
      closeBtn.disabled = on;
    }

    function closeDialog() {
      pendingToken = '';
      setDialogBusy(false);
      if (dialog.open) dialog.close();
    }

    function matchRedirect(host) {
      if (!host) return null;
      for (var i = 0; i < redirects.length; i++) {
        var entry = redirects[i];
        if (entry.source === host) return entry;
        if (Array.isArray(entry.hosts) && entry.hosts.indexOf(host) >= 0) return entry;
      }
      return null;
    }

    function servedSummary(entry) {
      if (entry.standIn && entry.zone) return 'Currently served by a local stand-in site and transitioning to Cloudflare (' + entry.zone + ').';
      if (entry.standIn) return 'Currently served by a local stand-in site on this server.';
      if (entry.servedBy === 'cloudflare') return 'Currently served by a Cloudflare Single Redirect rule' + (entry.zone ? ' in ' + entry.zone : '') + '.';
      return 'Configured in Redirects.';
    }

    function renderReplaced(domain) {
      box.textContent = '';
      var alert = el('div', 'alert alert-success clp-redir-cs-alert');
      alert.setAttribute('role', 'status');
      alert.appendChild(el('strong', '', 'Redirect removed. '));
      alert.appendChild(document.createTextNode('The redirect for ' + domain + ' was removed and non-web DNS records were left untouched. You can create the site now.'));
      box.appendChild(alert);
      box.hidden = false;
    }

    function renderError(message) {
      var existing = box.querySelector('.clp-redir-cs-inline-error');
      if (existing) existing.remove();
      var err = el('div', 'alert alert-danger clp-redir-cs-inline-error', message);
      err.setAttribute('role', 'alert');
      box.appendChild(err);
    }

    function renderReview(review, notice) {
      pendingToken = review.token || '';
      showDialogError('');
      titleEl.textContent = review.title || 'Replace redirect';
      dialogText.textContent = (notice ? notice + ' ' : '') + (review.text || '');
      planBox.textContent = '';

      var plans = Array.isArray(review.sites) ? review.sites : [];
      plans.forEach(function (plan) {
        if (plan.problems && plan.problems.length) {
          var err = el('div', 'alert alert-danger');
          err.setAttribute('role', 'alert');
          plan.problems.forEach(function (problem, idx) {
            if (idx) err.appendChild(document.createElement('br'));
            err.appendChild(document.createTextNode(problem));
          });
          planBox.appendChild(err);
          return;
        }
        var changes = Array.isArray(plan.changes) ? plan.changes : [];
        if (!changes.length) {
          planBox.appendChild(el('p', 'clp-redir-cs-muted', 'Removes the redirect entry from Redirects. No Cloudflare rule or stand-in site needs to be deleted.'));
          return;
        }
        var list = el('ul', 'clp-redir-cs-changes');
        changes.forEach(function (change) {
          var li = el('li');
          var badge = el('span', 'clp-redir-cs-badge clp-redir-cs-badge-' + change.action, ACTION_LABELS[change.action] || change.action);
          var detail = el('div', 'clp-redir-cs-change-body');
          detail.appendChild(el('strong', '', change.subject));
          if (change.detail) detail.appendChild(el('span', '', change.detail));
          li.appendChild(badge);
          li.appendChild(detail);
          list.appendChild(li);
        });
        planBox.appendChild(list);
      });

      confirmBtn.textContent = review.confirmLabel || 'Replace redirect';
      confirmBtn.hidden = Boolean(review.blocked);
      setDialogBusy(false);
      if (!dialog.open) dialog.showModal();
    }

    function renderNotice(entry, entered) {
      box.textContent = '';
      var alert = el('div', 'alert alert-warning clp-redir-cs-alert');
      alert.setAttribute('role', 'status');

      var main = el('div', 'clp-redir-cs-main');
      var lead = el('div', 'clp-redir-cs-lead');
      if (entered === entry.source) {
        lead.appendChild(el('strong', '', entry.source));
        lead.appendChild(document.createTextNode(' already redirects to '));
      } else {
        lead.appendChild(el('strong', '', entered));
        lead.appendChild(document.createTextNode(' is covered by the redirect on '));
        lead.appendChild(el('strong', '', entry.source));
        lead.appendChild(document.createTextNode(' to '));
      }
      lead.appendChild(el('code', 'clp-redir-cs-target', entry.target));
      lead.appendChild(document.createTextNode('.'));
      main.appendChild(lead);

      var note = el('div', 'clp-redir-cs-note', servedSummary(entry) + ' Non-web DNS records such as mail and verification stay untouched.');
      main.appendChild(note);

      var actions = el('div', 'clp-redir-cs-actions');
      var replaceBtn = el('button', 'btn btn-warning btn-sm clp-redir-cs-btn', 'Replace redirect with this site');
      replaceBtn.type = 'button';
      replaceBtn.addEventListener('click', function () {
        replaceBtn.disabled = true;
        replaceBtn.textContent = 'Checking redirect…';
        pendingSource = entry.source;
        postJson('/api/redirects/prepare-replace', { source: entry.source }).then(function (replyData) {
          replaceBtn.disabled = false;
          replaceBtn.textContent = 'Replace redirect with this site';
          if (!replyData || !replyData.review) {
            renderError('Redirects did not return a confirmation plan.');
            return;
          }
          renderReview(replyData.review, replyData.notice);
        }, function (failure) {
          replaceBtn.disabled = false;
          replaceBtn.textContent = 'Replace redirect with this site';
          renderError(failure.message || 'Could not inspect the redirect.');
        });
      });

      var manageLink = el('a', 'clp-redir-cs-link', 'Open Redirects');
      manageLink.href = url + '/';
      actions.appendChild(replaceBtn);
      actions.appendChild(manageLink);

      alert.appendChild(main);
      alert.appendChild(actions);
      box.appendChild(alert);
      box.hidden = false;
    }

    function sync() {
      var entered = normalizeHost(input.value);
      if (replacedDomain && entered === replacedDomain) {
        renderReplaced(replacedDomain);
        return;
      }
      replacedDomain = '';
      var matched = matchRedirect(entered);
      if (!matched) {
        box.textContent = '';
        box.hidden = true;
        return;
      }
      renderNotice(matched, entered);
    }

    closeBtn.addEventListener('click', closeDialog);
    cancelBtn.addEventListener('click', closeDialog);
    dialog.addEventListener('cancel', function (event) {
      if (dialogBusy) {
        event.preventDefault();
        return;
      }
      pendingToken = '';
    });
    dialog.addEventListener('close', function () {
      pendingToken = '';
      setDialogBusy(false);
    });
    dialog.addEventListener('mousedown', function (event) {
      if (dialogBusy || event.target !== dialog) return;
      var rect = dialog.getBoundingClientRect();
      var inside = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
      if (!inside) closeDialog();
    });

    confirmBtn.addEventListener('click', function () {
      if (!pendingToken || dialogBusy) return;
      var token = pendingToken;
      var source = pendingSource;
      setDialogBusy(true);
      showDialogError('');
      postJson('/api/confirm', { token: token }).then(function (confirmData) {
        if (confirmData && confirmData.review) {
          renderReview(confirmData.review, confirmData.notice);
          return;
        }
        redirects = redirects.filter(function (entry) { return entry.source !== source; });
        replacedDomain = normalizeHost(input.value) || source;
        closeDialog();
        renderReplaced(source);
      }, function (failure) {
        showDialogError(failure.message || 'Could not replace the redirect.');
        setDialogBusy(false);
      });
    });

    input.addEventListener('input', sync);
    input.addEventListener('change', sync);
    sync();
  }

  // Warm CSRF cookie and load local redirect list; never calls Cloudflare on page load.
  fetch(url + '/api/session', { credentials: 'same-origin' }).catch(function () {});
  fetch(url + '/api/create-site-helper', { credentials: 'same-origin', headers: { Accept: 'application/json' } }).then(function (response) {
    return response.ok ? response.json() : null;
  }).then(function (reply) {
    var data = reply && reply.ok ? reply.data : null;
    if (!data) return;
    init(data);
  }).catch(function () {});
})();

// Custom Domain DNS helper on CloudPanel's Admin -> Settings page.
//
// Written for CloudPanel's page: plain ES5, no shared client bundle, and zero
// `name` attributes on any control so Symfony never rejects extra form fields.
// Reads local DNS state on page load without calling Cloudflare; renders
// nothing when no Cloudflare connection exists.
(function () {
  var box = document.querySelector('[data-clp-dns-custom-domain]');
  if (!box) return;
  var form = box.closest('form');
  var group = box.previousElementSibling;
  if (!group || !group.classList || !group.classList.contains('input-group')) {
    group = box.parentNode && box.parentNode.querySelector('.input-group');
  }
  var input = group && group.querySelector('input');
  if (!form || !group || !input) return;

  var url = box.getAttribute('data-url');
  var ACTION_LABELS = { create: 'Create', update: 'Update', delete: 'Delete', note: 'Note' };

  function normalizeHost(value) {
    return String(value || '').trim().toLowerCase().replace(/\.+$/, '');
  }

  /** Eight unambiguous lowercase characters (~39 bits), starting with a letter. */
  function randomLabel() {
    var first = 'abcdefghjkmnpqrstuvwxyz';
    var rest = 'abcdefghjkmnpqrstuvwxyz23456789';
    var pick = function (alphabet) {
      var limit = Math.floor(256 / alphabet.length) * alphabet.length;
      var buf = new Uint8Array(1);
      var n = 256;
      while (n >= limit) {
        crypto.getRandomValues(buf);
        n = buf[0];
      }
      return alphabet[n % alphabet.length];
    };
    var out = pick(first);
    for (var i = 1; i < 8; i++) out += pick(rest);
    return out;
  }

  function findZone(host, zonesDesc) {
    for (var i = 0; i < zonesDesc.length; i++) {
      var zone = zonesDesc[i];
      if (host === zone || host.slice(-(zone.length + 1)) === '.' + zone) return zone;
    }
    return null;
  }

  function panelBase(value, savedBase, zonesDesc, savedPanelHost) {
    var clean = normalizeHost(value);
    if (clean) {
      if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(clean)) return '';
      var matched = findZone(clean, zonesDesc);
      if (matched) return matched;
      if (savedBase && (clean === savedBase || clean.slice(-(savedBase.length + 1)) === '.' + savedBase)) return savedBase;
      return clean;
    }
    if (zonesDesc.length === 1) return zonesDesc[0];
    if (savedPanelHost) {
      var currentZone = findZone(normalizeHost(savedPanelHost), zonesDesc);
      if (currentZone) return currentZone;
    }
    return '';
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
      if (!token) throw new Error('DNS did not answer. Reload the page and try again.');
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
        return { ok: false, error: 'DNS answered ' + response.status };
      });
    }, function () {
      return { ok: false, error: 'DNS did not answer' };
    }).then(function (reply) {
      if (!reply || reply.ok !== true) throw new Error((reply && reply.error) || 'The DNS request failed');
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
    var zones = Array.isArray(data.zones) ? data.zones.slice() : [];
    var zonesDesc = zones.slice().sort(function (a, b) { return b.length - a.length; });
    var ips = [];
    if (data.serverIps && data.serverIps.ipv4) ips.push(data.serverIps.ipv4);
    if (data.serverIps && data.serverIps.ipv6) ips.push(data.serverIps.ipv6);

    if (zones.length) {
      var datalist = el('datalist');
      datalist.id = 'clp-dns-zone-list';
      zones.forEach(function (zone) {
        var option = document.createElement('option');
        option.value = zone;
        datalist.appendChild(option);
      });
      box.appendChild(datalist);
      input.setAttribute('list', 'clp-dns-zone-list');
    }

    var randomBtn = el('button', 'btn btn-gray clp-dns-cd-random', 'Random');
    randomBtn.type = 'button';
    randomBtn.title = 'Generate an 8-character hostname under your zone';
    group.appendChild(randomBtn);

    var checkWrap = el('div', 'form-check clp-dns-cd-check');
    var checkbox = el('input', 'form-check-input');
    checkbox.type = 'checkbox';
    checkbox.id = 'clp-dns-cd-write';
    var checkLabel = el('label', 'form-check-label', 'Write unproxied DNS record before saving');
    checkLabel.setAttribute('for', 'clp-dns-cd-write');
    checkWrap.appendChild(checkbox);
    checkWrap.appendChild(checkLabel);

    var noteEl = el('div', 'form-text clp-dns-cd-note');
    var feedbackEl = el('div', 'clp-dns-cd-feedback');
    feedbackEl.hidden = true;

    box.appendChild(checkWrap);
    box.appendChild(noteEl);
    box.appendChild(feedbackEl);
    box.hidden = false;

    // Confirmation <dialog> lives outside the form with zero named fields.
    var dialog = el('dialog', 'clp-dns-cd-dialog');
    dialog.setAttribute('aria-labelledby', 'clp-dns-cd-dialog-title');
    var head = el('div', 'clp-dns-cd-dialog-head');
    var titleEl = el('h5');
    titleEl.id = 'clp-dns-cd-dialog-title';
    var closeBtn = el('button', 'btn-close');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close');
    head.appendChild(titleEl);
    head.appendChild(closeBtn);

    var bodyEl = el('div', 'clp-dns-cd-dialog-body');
    var dialogError = el('div', 'alert alert-danger clp-dns-cd-dialog-error');
    dialogError.setAttribute('role', 'alert');
    dialogError.hidden = true;
    var dialogText = el('p', 'clp-dns-cd-dialog-text');
    var planBox = el('div', 'clp-dns-cd-plan');
    bodyEl.appendChild(dialogError);
    bodyEl.appendChild(dialogText);
    bodyEl.appendChild(planBox);

    var foot = el('div', 'clp-dns-cd-dialog-foot');
    var cancelBtn = el('button', 'btn btn-gray', 'Cancel');
    cancelBtn.type = 'button';
    var confirmBtn = el('button', 'btn btn-primary', 'Write DNS and save');
    confirmBtn.type = 'button';
    foot.appendChild(cancelBtn);
    foot.appendChild(confirmBtn);

    dialog.appendChild(head);
    dialog.appendChild(bodyEl);
    dialog.appendChild(foot);
    document.body.appendChild(dialog);

    var lastInZone = null;
    var bypass = false;
    var busy = false;
    var dialogBusy = false;
    var confirmGen = 0;
    var pendingToken = '';
    var pendingName = '';
    var pendingSubmitter = null;

    function clearFeedback() {
      feedbackEl.textContent = '';
      feedbackEl.hidden = true;
    }

    function showError(message) {
      feedbackEl.textContent = '';
      var alert = el('div', 'alert alert-danger', message);
      alert.setAttribute('role', 'alert');
      feedbackEl.appendChild(alert);
      feedbackEl.hidden = false;
    }

    function showDialogError(message) {
      dialogError.textContent = message;
      dialogError.hidden = !message;
    }

    function showNameservers(zone) {
      feedbackEl.textContent = '';
      var alert = el('div');
      alert.setAttribute('role', 'status');
      if (zone.nameServers && zone.nameServers.length && typeof clpNameserverNotice === 'function') {
        clpNameserverNotice(
          alert,
          zone.name,
          zone.nameServers,
          'The DNS record is written, but CloudPanel cannot issue a Let’s Encrypt certificate until Cloudflare sees them. Once it does, save Custom Domain again.'
        );
      } else {
        alert.className = 'alert alert-warning';
        alert.textContent = zone.name + ' is ' + zone.status + '. Activate the zone in Cloudflare, then save Custom Domain again.';
      }
      feedbackEl.appendChild(alert);
      feedbackEl.hidden = false;
      alert.scrollIntoView({ block: 'nearest' });
    }

    function setFormBusy(on) {
      busy = on;
      var buttons = form.querySelectorAll('button[type="submit"], input[type="submit"]');
      Array.prototype.forEach.call(buttons, function (button) { button.disabled = on; });
    }

    function setDialogBusy(on) {
      dialogBusy = on;
      confirmBtn.disabled = on;
      cancelBtn.disabled = on;
      closeBtn.disabled = on;
    }

    function syncFromInput(forceAuto) {
      var clean = normalizeHost(input.value);
      var matched = clean ? findZone(clean, zonesDesc) : null;
      var inZone = Boolean(matched);
      if (forceAuto || lastInZone === null || inZone !== lastInZone) {
        checkbox.checked = inZone;
        lastInZone = inZone;
      }
      if (!clean) {
        noteEl.textContent = zones.length === 1
          ? 'Enter a hostname in ' + zones[0] + ' or choose Random.'
          : 'Enter a hostname in a connected Cloudflare zone to write its DNS record automatically.';
      } else if (matched) {
        if (checkbox.checked) {
          var target = ips.length ? ' pointing to ' + ips.join(' and ') : '';
          noteEl.textContent = 'Plans an unproxied record in ' + matched + target + ' and asks you to confirm before saving.' +
            (data.automatic ? ' DNS proxies it once the certificate is issued.' : '');
        } else {
          noteEl.textContent = 'DNS will not be changed before saving CloudPanel’s custom domain.';
        }
      } else {
        noteEl.textContent = checkbox.checked
          ? clean + ' is not in a connected Cloudflare zone. DNS will check whether a zone can be created when you save.'
          : clean + ' is not in a connected Cloudflare zone. Leave unchecked to manage its DNS elsewhere.';
      }
    }

    function renderReview(review, notice) {
      confirmGen++;
      pendingToken = review.token || '';
      showDialogError('');
      titleEl.textContent = review.title || 'Prepare DNS';
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
        if (plan.wildcardBlocked) {
          planBox.appendChild(el('p', 'clp-dns-cd-muted', plan.wildcardBlocked + '.'));
        }
        var changes = Array.isArray(plan.changes) ? plan.changes : [];
        if (!changes.length) {
          planBox.appendChild(el('p', 'clp-dns-cd-muted', plan.wildcard ? 'Covered by ' + plan.wildcard + '. No record changes needed.' : 'No DNS record changes needed.'));
          return;
        }
        var list = el('ul', 'clp-dns-cd-changes');
        changes.forEach(function (change) {
          var li = el('li');
          var badge = el('span', 'clp-dns-cd-badge clp-dns-cd-badge-' + change.action, ACTION_LABELS[change.action] || change.action);
          var detail = el('div', 'clp-dns-cd-change-body');
          detail.appendChild(el('strong', '', change.subject));
          if (change.detail) detail.appendChild(el('span', '', change.detail));
          if (change.before) detail.appendChild(el('span', 'clp-dns-cd-muted', 'Now: ' + change.before));
          li.appendChild(badge);
          li.appendChild(detail);
          list.appendChild(li);
        });
        planBox.appendChild(list);
      });

      confirmBtn.textContent = review.confirmLabel || 'Write DNS and save';
      confirmBtn.className = review.danger ? 'btn btn-danger' : 'btn btn-primary';
      confirmBtn.hidden = Boolean(review.blocked);
      setDialogBusy(false);
      if (!dialog.open) dialog.showModal();
    }

    function submitNativeForm() {
      bypass = true;
      var submitter = pendingSubmitter && pendingSubmitter.form === form ? pendingSubmitter : undefined;
      if (form.requestSubmit) form.requestSubmit(submitter);
      else form.submit();
    }

    function closeDialog() {
      confirmGen++;
      pendingToken = '';
      setDialogBusy(false);
      if (dialog.open) dialog.close();
    }

    randomBtn.addEventListener('click', function () {
      clearFeedback();
      var base = panelBase(input.value, input.getAttribute('data-clp-dns-random-base') || '', zonesDesc, data.panelHost);
      if (!base) {
        input.focus();
        noteEl.textContent = 'Enter a domain first, such as example.com, then choose Random.';
        return;
      }
      input.setAttribute('data-clp-dns-random-base', base);
      input.value = randomLabel() + '.' + base;
      syncFromInput(true);
      input.focus();
    });

    input.addEventListener('input', function () {
      clearFeedback();
      syncFromInput(false);
    });
    input.addEventListener('change', function () { syncFromInput(false); });
    checkbox.addEventListener('change', function () { syncFromInput(false); });

    closeBtn.addEventListener('click', closeDialog);
    cancelBtn.addEventListener('click', closeDialog);
    dialog.addEventListener('cancel', function (event) {
      if (dialogBusy) {
        event.preventDefault();
        return;
      }
      confirmGen++;
      pendingToken = '';
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
      var gen = confirmGen;
      var confirmedName = pendingName;
      setDialogBusy(true);
      showDialogError('');
      postJson('/api/confirm', { token: token }).then(function (confirmData) {
        if (!dialog.open || gen !== confirmGen || token !== pendingToken) {
          showError('DNS confirmation was dismissed. Review and save again.');
          return;
        }
        if (confirmData && confirmData.review) {
          renderReview(confirmData.review, confirmData.notice);
          return;
        }
        var plan = confirmData && confirmData.panelHost && confirmData.panelHost.plan;
        if (!plan) {
          showDialogError('DNS did not return a plan for ' + confirmedName + '.');
          setDialogBusy(false);
          return;
        }
        if (plan.problems && plan.problems.length) {
          showDialogError(plan.problems.join(' '));
          setDialogBusy(false);
          return;
        }
        if (!plan.zone) {
          showDialogError('DNS could not find a Cloudflare zone for ' + confirmedName + '.');
          setDialogBusy(false);
          return;
        }
        if (plan.zone.status !== 'active') {
          closeDialog();
          showNameservers(plan.zone);
          return;
        }
        if (plan.changes && plan.changes.some(function (change) { return change.action !== 'note'; })) {
          showDialogError('Some DNS changes could not be applied yet. Check DNS settings before saving.');
          setDialogBusy(false);
          return;
        }
        if (normalizeHost(input.value) !== confirmedName) {
          closeDialog();
          showError('Hostname changed after DNS confirmation. Review and save again.');
          return;
        }
        closeDialog();
        submitNativeForm();
      }, function (failure) {
        if (!dialog.open || gen !== confirmGen || token !== pendingToken) return;
        showDialogError(failure.message || 'DNS confirmation failed.');
        setDialogBusy(false);
      });
    });

    document.addEventListener('submit', function (event) {
      if (event.target !== form) return;
      if (bypass) {
        bypass = false;
        return;
      }
      if (!checkbox.checked) return;
      var name = normalizeHost(input.value);
      if (!name) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (busy) return;
      pendingName = name;
      pendingSubmitter = event.submitter || form.querySelector('button[type="submit"], input[type="submit"]');
      clearFeedback();
      setFormBusy(true);
      postJson('/api/panel-host', { name: name, prepareOnly: true }).then(function (replyData) {
        setFormBusy(false);
        if (!replyData || !replyData.review) {
          showError('DNS did not return a plan for ' + name + '.');
          return;
        }
        renderReview(replyData.review, replyData.notice);
      }, function (failure) {
        setFormBusy(false);
        showError('DNS could not plan ' + name + ': ' + (failure.message || 'unknown error'));
      });
    }, true);

    syncFromInput(true);
  }

  // Warm the CSRF cookie and read local DNS state in parallel; no Cloudflare API calls happen here.
  fetch(url + '/api/session', { credentials: 'same-origin' }).catch(function () {});
  fetch(url + '/api/panel-host-helper', { credentials: 'same-origin', headers: { Accept: 'application/json' } }).then(function (response) {
    return response.ok ? response.json() : null;
  }).then(function (reply) {
    var data = reply && reply.ok ? reply.data : null;
    if (!data || !data.connected) return;
    init(data);
  }).catch(function () {});
})();

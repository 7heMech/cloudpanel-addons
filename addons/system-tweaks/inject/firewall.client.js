// The Protocol field and column on CloudPanel's Firewall pages. Written for the
// panel's page, so plain ES5 with its own fetch. CloudPanel's own form posts
// nothing about a protocol: the add form tells System Tweaks which protocol the
// next rule with this port range gets, the edit form sets its rule's, and both
// then submit as CloudPanel's own form would.
(function () {
  var url = "ADDON_URL";
  var NAMES = { tcp: 'TCP', udp: 'UDP', both: 'TCP and UDP' };

  function csrf() {
    var read = function () {
      var match = document.cookie.match(/(?:^|;\s*)clp_addons_csrf=([^;]+)/);
      return match ? match[1] : null;
    };
    if (read()) return Promise.resolve(read());
    // A CloudPanel page sets no cookie of ours; this route hands one out.
    return fetch(url + '/api/session', { credentials: 'same-origin' }).then(function () {
      if (!read()) throw new Error('System Tweaks did not answer');
      return read();
    });
  }

  function call(path, body) {
    var ready = body ? csrf() : Promise.resolve(null);
    return ready.then(function (token) {
      var options = { credentials: 'same-origin', headers: { Accept: 'application/json' } };
      if (body) {
        options.method = 'POST';
        options.headers['Content-Type'] = 'application/json';
        options.headers['X-CLP-Addons-CSRF'] = token;
        options.body = JSON.stringify(body);
      }
      return fetch(url + path, options);
    }).then(function (response) {
      return response.json().catch(function () { return { ok: false, error: 'System Tweaks answered ' + response.status }; });
    }).then(function (reply) {
      if (!reply || reply.ok !== true) throw new Error((reply && reply.error) || 'System Tweaks did not answer');
      return reply;
    });
  }

  var cells = document.querySelectorAll('td[data-clp-fw-rule]');
  if (cells.length) {
    call('/api/firewall').then(function (reply) {
      var protocols = reply.protocols || {};
      Array.prototype.forEach.call(cells, function (cell) {
        cell.textContent = NAMES[protocols[cell.getAttribute('data-clp-fw-rule')] || 'tcp'];
      });
    }).catch(function () {});
    return;
  }

  var field = document.getElementById('clp-fw-protocol');
  var form = field && field.closest('form');
  if (!form) return;
  var select = document.getElementById('clp-fw-protocol-select');
  var rule = Number(field.getAttribute('data-rule')) || 0;
  var portRange = form.querySelector('input[id$="_portRange"]');
  var loaded = rule ? null : 'tcp';
  var sent = false;

  function showError(text) {
    var box = document.getElementById('clp-fw-protocol-error');
    if (!box) {
      box = document.createElement('div');
      box.id = 'clp-fw-protocol-error';
      box.className = 'alert alert-danger';
      box.setAttribute('role', 'alert');
      form.parentNode.insertBefore(box, form);
    }
    box.textContent = text;
  }

  if (rule) {
    // Shown once the rule's own protocol is known, so it never offers TCP for a UDP rule.
    call('/api/firewall').then(function (reply) {
      loaded = (reply.protocols || {})[String(rule)] || 'tcp';
      select.value = loaded;
      field.hidden = false;
    }).catch(function () {});
  } else {
    field.hidden = false;
  }

  document.addEventListener('submit', function (event) {
    if (event.target !== form || sent || field.hidden) return;
    var protocol = select.value;
    if (rule && protocol === loaded) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    var submitter = event.submitter || form.querySelector('button[type="submit"]');
    if (submitter) submitter.disabled = true;
    var body = rule ? { id: rule, protocol: protocol } : { portRange: portRange ? portRange.value : '', protocol: protocol };
    call(rule ? '/api/firewall/rule' : '/api/firewall/new-rule', body).then(function () {
      sent = true;
      if (submitter) submitter.disabled = false;
      if (form.requestSubmit) form.requestSubmit(submitter && submitter.form === form ? submitter : undefined); else form.submit();
    }, function (failure) {
      if (submitter) submitter.disabled = false;
      // A TCP rule is CloudPanel's own; nothing is lost by saving it without us.
      if (protocol === 'tcp' && !rule) { sent = true; form.submit(); return; }
      showError('The protocol could not be saved: ' + failure.message.replace(/\.?$/, '.') + ' Nothing was changed.');
    });
  }, true);
})();

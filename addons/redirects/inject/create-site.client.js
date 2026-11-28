// Create Site notice on CloudPanel's native Create Site forms: says when the
// entered domain is a redirect's, and that the new site replaces it.
//
// Plain ES5, no shared client bundle, zero `name` attributes on any node, and
// zero submit interception, so CloudPanel's own submission flow (plus WP Tools
// and Auto-SSL) keeps working unchanged.
(function () {
  var box = document.querySelector('[data-clp-redirects-create-site]');
  if (!box) return;
  var form = box.closest('form');
  if (!form) return;
  var input = form.querySelector('input[id$="_domainName"], input[name$="[domainName]"]');
  if (!input) return;

  var MOUNT = '/addons/redirects';
  if (box.getAttribute('data-url') !== MOUNT) return;

  function normalizeHost(value) {
    var text = String(value || '').trim().toLowerCase();
    text = text.replace(/^https?:\/\//, '');
    var slash = text.indexOf('/');
    if (slash >= 0) text = text.slice(0, slash);
    return text.replace(/\.+$/, '');
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function init(data) {
    var redirects = Array.isArray(data.redirects) ? data.redirects : [];
    if (!redirects.length) return;
    var automatic = data.automatic !== false;

    var domainRow = input.closest('.row');
    if (domainRow && domainRow.parentNode && domainRow.parentNode === box.parentNode) {
      domainRow.parentNode.insertBefore(box, domainRow.nextSibling);
    }

    function matchRedirect(host) {
      if (!host) return null;
      for (var i = 0; i < redirects.length; i++) {
        var entry = redirects[i];
        if (entry.source === host || (Array.isArray(entry.hosts) && entry.hosts.indexOf(host) >= 0)) return entry;
      }
      return null;
    }

    function outcome(entry, entered) {
      if (entry.standIn && entered === entry.source) {
        return 'Its stand-in site already uses this domain on this server, so delete the redirect in Redirects before creating the site.';
      }
      return 'Creating this site replaces the redirect: its Cloudflare rule and any stand-in site are removed' +
        (automatic ? '.' : ' once you review it in Redirects.');
    }

    function renderNotice(entry, entered) {
      box.textContent = '';
      var alert = el('div', 'alert alert-warning clp-redir-cs-alert');
      alert.setAttribute('role', 'status');
      var lead = el('div', 'clp-redir-cs-lead');
      if (entered === entry.source) {
        lead.appendChild(el('strong', '', entry.source));
        lead.appendChild(document.createTextNode(' redirects to '));
      } else {
        lead.appendChild(el('strong', '', entered));
        lead.appendChild(document.createTextNode(' is covered by the redirect on '));
        lead.appendChild(el('strong', '', entry.source));
        lead.appendChild(document.createTextNode(' to '));
      }
      lead.appendChild(el('code', 'clp-redir-cs-target', entry.target));
      lead.appendChild(document.createTextNode('.'));
      alert.appendChild(lead);
      var note = el('div', 'clp-redir-cs-note', outcome(entry, entered) + ' ');
      var link = el('a', 'clp-redir-cs-link', 'Open Redirects');
      link.href = MOUNT + '/';
      note.appendChild(link);
      alert.appendChild(note);
      box.appendChild(alert);
      box.hidden = false;
    }

    function sync() {
      var entered = normalizeHost(input.value);
      var matched = matchRedirect(entered);
      if (!matched) {
        box.textContent = '';
        box.hidden = true;
        return;
      }
      renderNotice(matched, entered);
    }

    input.addEventListener('input', sync);
    input.addEventListener('change', sync);
    sync();
  }

  // Reads the local redirect list; never calls Cloudflare.
  fetch(MOUNT + '/api/create-site-helper', { credentials: 'same-origin', headers: { Accept: 'application/json' } }).then(function (response) {
    return response.ok ? response.json() : null;
  }).then(function (reply) {
    var data = reply && reply.ok ? reply.data : null;
    if (data) init(data);
  }).catch(function () {});
})();

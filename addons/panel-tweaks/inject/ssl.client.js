(function () {
  var COOKIE = '__Host-clp_addons_ssl';

  function pending() {
    var match = document.cookie.match(/(?:^|; )__Host-clp_addons_ssl=([^;]*)/);
    return match && match[1] ? decodeURIComponent(match[1]).split(' ') : [];
  }
  function remember(domain, wanted) {
    var list = pending().filter(function (item) { return item && item !== domain; });
    if (wanted && domain) list.push(domain);
    document.cookie = COOKIE + '=' + encodeURIComponent(list.join(' ')) +
      '; Path=/; Secure; SameSite=Strict; Max-Age=' + (list.length ? 900 : 0);
  }

  var choice = document.getElementById('clp-auto-ssl');
  if (choice && choice.form) {
    var input = choice.form.querySelector('input[id$="_domainName"]');
    var domain = function () { return input ? input.value.trim().toLowerCase() : ''; };
    // CloudPanel answers a rejected creation with this form, the domain still filled in.
    remember(domain(), false);
    choice.form.addEventListener('submit', function () { remember(domain(), choice.checked); });
  }

  var boxes = document.querySelectorAll('[data-clp-auto-ssl]');
  for (var i = 0; i < boxes.length; i++) issue(boxes[i]);

  function issue(box) {
    var domain = box.getAttribute('data-clp-auto-ssl');
    var alert = box.querySelector('.alert');
    var issueUrl = new URL(box.getAttribute('data-issue-url'), location.href).href;
    var certificatesUrl = new URL(box.getAttribute('data-certificates-url'), location.href).href;
    // Forgotten before any request, so a refresh or Back never issues twice.
    remember(domain.toLowerCase(), false);

    function show(kind, text, link) {
      alert.className = 'alert alert-' + kind;
      alert.textContent = text;
      if (!link) return;
      var a = document.createElement('a');
      a.className = 'alert-link';
      a.href = certificatesUrl;
      a.textContent = link;
      alert.append(' ', a);
    }
    function parse(response) {
      return response.text().then(function (html) { return new DOMParser().parseFromString(html, 'text/html'); });
    }

    // With the DNS addon installed, its records are written first and decide
    // which names the certificate covers. Without it, only the created domain:
    // the form's default www name may have no DNS.
    function dnsNames() {
      return fetch('/addons/dns/api/session', { credentials: 'same-origin' }).then(function (response) {
        // DNS is not installed: 404 for an administrator, 403 for anyone else.
        if (response.status === 404 || response.status === 403) return null;
        if (!response.ok) throw new Error();
        return response.json();
      }).catch(function () {
        // Nothing was requested yet, so a refresh may start over.
        remember(domain.toLowerCase(), true);
        throw new Error('the DNS addon did not answer. Refresh this page to try again');
      }).then(function (session) {
        if (!session || session.ok !== true) return [domain];
        show('info', 'Writing the DNS records for ' + domain + '…');
        var csrf = document.cookie.match(/(?:^|;\s*)clp_addons_csrf=([^;]+)/);
        return fetch('/addons/dns/api/provision', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'X-CLP-Addons-CSRF': csrf ? csrf[1] : '' },
          body: JSON.stringify({ domain: domain, ssl: true })
        }).then(function (response) {
          return response.json();
        }).catch(function () {
          return null;
        }).then(function (reply) {
          if (!reply || !reply.ok) {
            remember(domain.toLowerCase(), true);
            throw new Error((reply && reply.error ? reply.error : 'DNS could not be prepared').replace(/\.?$/, '.') + ' Refresh this page to try again');
          }
          if (!reply.data.managed) return [domain];
          if (reply.data.ready) return reply.data.certificateNames;
          show('warning', 'DNS for ' + domain + ' is not ready: ' + reply.data.reason.replace(/\.?$/, '.') +
            ' The certificate will be requested automatically once it is.', 'Open SSL/TLS');
          return null;
        });
      });
    }

    dnsNames().then(function (names) {
      if (!names) return;
      show('info', 'Installing a Let\'s Encrypt certificate for ' + domain + '…');
      return fetch(issueUrl, { credentials: 'same-origin' }).then(parse).then(function (doc) {
        var token = doc.querySelector('input[name="site_lets_encrypt_certificate[_token]"]');
        if (!token || !token.form) throw new Error('CloudPanel\'s certificate form was not found.');
        var body = new FormData(token.form);
        body.delete('domains[]');
        names.forEach(function (name) { body.append('domains[]', name); });
        return fetch(issueUrl, { method: 'POST', body: body, credentials: 'same-origin' });
      }).then(finish);
    }).catch(fail);

    function finish(response) {
      // CloudPanel redirects to the certificate list only once the certificate is installed.
      if (response.url === certificatesUrl) {
        show('success', 'Let\'s Encrypt certificate installed for ' + domain + '.');
        window.dispatchEvent(new CustomEvent('clp-addons:ssl-installed', { detail: domain }));
        return;
      }
      return parse(response).then(function (doc) {
        var error = doc.querySelector('.alert-container .alert-danger');
        throw new Error(error ? error.textContent.trim() : 'CloudPanel did not confirm it.');
      });
    }

    function fail(error) {
      var reason = error.message.replace(/\.?$/, '.');
      show('danger', 'The Let\'s Encrypt certificate for ' + domain + ' was not installed: ' + reason, 'Open SSL/TLS');
    }
  }
})();

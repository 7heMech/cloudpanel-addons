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
    var certificateDomains = [domain];
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

    function api(path, body) {
      var match = document.cookie.match(/(?:^|; )clp_addons_csrf=([^;]*)/);
      return fetch('/addons/' + path, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Clp-Addons-Csrf': match ? decodeURIComponent(match[1]) : '' },
        body: JSON.stringify(body)
      }).then(function (response) { return response.json(); }).then(function (reply) {
        if (!reply.ok) throw new Error(reply.error || 'Site provisioning could not be checked.');
        return reply.data;
      });
    }

    fetch('/addons/panel-tweaks/api/session', { credentials: 'same-origin' }).then(function (response) {
      if (!response.ok) throw new Error('Could not start site provisioning.');
      return api('panel-tweaks/api/ssl-request', { domain: domain });
    }).then(function (intent) {
      if (intent.alreadyInstalled) { show('success', 'A certificate is already installed for ' + domain + '.'); return false; }
      if (!intent.domainsInstalled) return true;
      show('info', 'Preparing DNS and mail for ' + domain + '…');
      return api('domains/api/provision', { domain: domain }).then(function (result) {
        if (result.ready) {
          if (Array.isArray(result.certificateDomains)) {
            certificateDomains = result.certificateDomains.filter(function (name) {
              return typeof name === 'string' && (name.toLowerCase() === domain.toLowerCase() || name.toLowerCase() === 'www.' + domain.toLowerCase());
            });
            if (!certificateDomains.some(function (name) { return name.toLowerCase() === domain.toLowerCase(); })) certificateDomains.unshift(domain);
          }
          return true;
        }
        show('warning', result.reason + ' Automatic SSL will retry when DNS is ready.', 'Open SSL/TLS');
        return false;
      });
    }).then(function (ready) {
      if (!ready) return;
      show('info', 'Installing a Let\'s Encrypt certificate for ' + domain + '…');
      return fetch(issueUrl, { credentials: 'same-origin' }).then(parse).then(function (doc) {
      var token = doc.querySelector('input[name="site_lets_encrypt_certificate[_token]"]');
      if (!token || !token.form) throw new Error('CloudPanel\'s certificate form was not found.');
      var body = new FormData(token.form);
      body.delete('domains[]');
      certificateDomains.forEach(function (name) { body.append('domains[]', name); });
      return fetch(issueUrl, { method: 'POST', body: body, credentials: 'same-origin' });
    }).then(function (response) {
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
      });
    }).catch(function (error) {
      var reason = error.message.replace(/\.?$/, '.');
      show('danger', 'The Let\'s Encrypt certificate for ' + domain + ' was not installed: ' + reason, 'Open SSL/TLS');
    });
  }
})();

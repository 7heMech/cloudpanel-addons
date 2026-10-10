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
    // Capture, so it runs before CloudPanel's own submit handler.
    choice.form.addEventListener('submit', function () { remember(domain(), choice.checked); }, true);
  }

  var boxes = document.querySelectorAll('[data-clp-auto-ssl]');
  for (var i = 0; i < boxes.length; i++) issue(boxes[i]);

  function issue(box) {
    var domain = box.getAttribute('data-clp-auto-ssl');
    var alert = box.querySelector('.alert');
    var issueUrl = new URL(box.getAttribute('data-issue-url'), location.href).href;
    var certificatesUrl = new URL(box.getAttribute('data-certificates-url'), location.href).href;
    // Forgotten before any request, so a refresh or Back never issues twice.
    remember(domain, false);

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

    fetch(issueUrl, { credentials: 'same-origin' }).then(parse).then(function (doc) {
      var token = doc.querySelector('input[name="site_lets_encrypt_certificate[_token]"]');
      if (!token || !token.form) throw new Error('CloudPanel\'s certificate form was not found.');
      var body = new FormData(token.form);
      // Only the domain that was created: the form's default www name may have no DNS.
      body.delete('domains[]');
      body.append('domains[]', domain);
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
    }).catch(function (error) {
      var reason = error.message.replace(/\.?$/, '.');
      show('danger', 'The Let\'s Encrypt certificate for ' + domain + ' was not installed: ' + reason, 'Open SSL/TLS');
    });
  }
})();

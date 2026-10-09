(function () {
  var key = 'clp_addons_site_ssl';
  var result = document.getElementById('clp-auto-ssl-result');
  var message = document.getElementById('clp-auto-ssl-message');
  if (!result || !message) return;
  var pending;
  try {
    pending = JSON.parse(sessionStorage.getItem(key) || 'null');
    if (pending && pending.completion !== result.getAttribute('data-completion')) return;
    // Consume before any request: refresh and Back must never issue twice.
    sessionStorage.removeItem(key);
  } catch (e) { return; }
  if (!pending) return;
  var source = result;
  if (pending.completion === 'sites') {
    var sites = document.getElementById('clp-auto-ssl-sites');
    var rows = sites ? sites.querySelectorAll('[data-domain]') : [];
    source = null;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].getAttribute('data-domain').toLowerCase() === pending.domain) { source = rows[i]; break; }
    }
    if (!source) return;
  }
  var domain = source.getAttribute('data-domain').toLowerCase();
  var age = Date.now() - pending.at;
  if (pending.domain !== domain || pending.user !== source.getAttribute('data-site-user') ||
      pending.type !== source.getAttribute('data-site-type') || !Number.isFinite(age) || age < 0 || age > 3600000) return;

  function show(text, kind) {
    result.hidden = false;
    result.className = 'alert alert-' + kind;
    message.textContent = text + ' ';
  }
  function localUrl(raw) {
    var url = new URL(raw, location.href);
    if (url.origin !== location.origin) throw new Error('CloudPanel returned an unexpected certificate URL.');
    return url.href;
  }
  var certificatesUrl;
  var issueUrl;
  try {
    certificatesUrl = localUrl(source.getAttribute('data-certificates-url'));
    issueUrl = localUrl(source.getAttribute('data-issue-url'));
    var link = document.getElementById('clp-auto-ssl-link');
    if (link) link.href = certificatesUrl;
  } catch (e) { show(e.message, 'warning'); return; }

  function page(url, options) {
    return fetch(url, Object.assign({ credentials: 'same-origin' }, options)).then(function (response) {
      if (!response.ok) throw new Error('CloudPanel returned HTTP ' + response.status + '.');
      return response.text().then(function (html) {
        return { doc: new DOMParser().parseFromString(html, 'text/html'), url: response.url };
      });
    });
  }
  function installed(doc) {
    var state = doc.getElementById('clp-auto-ssl-certificate');
    if (!state || state.getAttribute('data-domain').toLowerCase() !== domain) {
      throw new Error('The installed certificate could not be checked. Open SSL certificates to check the result.');
    }
    return state.getAttribute('data-type');
  }

  show('Installing a Let\'s Encrypt SSL certificate for ' + domain + '… Keep this page open until it finishes.', 'info');
  page(certificatesUrl).then(function (current) {
    var type = installed(current.doc);
    if (type && type !== '1') {
      show('The site already has a certificate. It was kept.', 'success');
      return;
    }
    return page(issueUrl).then(function (formPage) {
      var form = formPage.doc.getElementById('create-lets-encrypt-certificate-form');
      if (!form || localUrl(form.getAttribute('action')) !== issueUrl || form.method.toLowerCase() !== 'post') {
        throw new Error('CloudPanel\'s certificate form is unavailable.');
      }
      var token = form.querySelector('input[name="site_lets_encrypt_certificate[_token]"]');
      if (!token || !token.value) throw new Error('CloudPanel\'s certificate token is unavailable.');
      var body = new FormData(form);
      // The panel defaults to apex + www. Only the hostname the operator entered
      // is requested, so an unused www record cannot break this issuance.
      body.delete('domains[]');
      body.append('domains[]', domain);
      return page(issueUrl, { method: 'POST', body: body }).then(function (reply) {
        if (localUrl(reply.url) !== certificatesUrl) {
          var error = reply.doc.querySelector('.alert-danger, .invalid-feedback');
          throw new Error(error ? error.textContent.trim().slice(0, 1000) : 'CloudPanel could not install the certificate. Check DNS and HTTP access.');
        }
        if (installed(reply.doc) !== '2') throw new Error('CloudPanel did not confirm a Let\'s Encrypt certificate.');
        if (pending.completion === 'sites') window.dispatchEvent(new CustomEvent('clp-addons:ssl-installed', {
          detail: { domain: domain, certificate: { type: '2',
            expiresAt: reply.doc.getElementById('clp-auto-ssl-certificate').getAttribute('data-expires-at') || '' } }
        }));
        show('Let\'s Encrypt SSL certificate installed for ' + domain + '.', 'success');
      });
    });
  }).catch(function (error) {
    show('Your site was created. SSL was not confirmed: ' + error.message + ' Use SSL certificates to check or retry.', 'warning');
  });
})();

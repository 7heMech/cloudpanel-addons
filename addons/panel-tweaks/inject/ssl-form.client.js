(function () {
  var key = 'clp_addons_site_ssl';
  var choice = document.getElementById('clp-auto-ssl');
  var form = choice && choice.closest('form');
  var domain = form && form.querySelector('input[id$="_domainName"]');
  var user = form && form.querySelector('input[id$="_siteUser"]');
  var error = document.getElementById('clp-auto-ssl-error');
  if (!form || !choice || !domain || !user) return;
  var existing = null;

  // Returning here after a rejected creation clears the attempted site's choice.
  try {
    sessionStorage.removeItem(key);
    sessionStorage.setItem(key, '');
    sessionStorage.removeItem(key);
  } catch (e) {
    choice.checked = false;
    choice.disabled = true;
    error.textContent = 'Automatic SSL needs browser session storage. After creation, open SSL certificates to install it.';
    error.hidden = false;
    return;
  }
  // A pending choice must never apply to a site that existed before creation.
  // Read the native list, using the same session and visibility as the form.
  fetch(choice.getAttribute('data-sites-url'), { credentials: 'same-origin' }).then(function (response) {
    if (!response.ok) throw new Error('site list unavailable');
    return response.text();
  }).then(function (html) {
    var sites = new DOMParser().parseFromString(html, 'text/html').getElementById('clp-auto-ssl-sites');
    if (!sites) throw new Error('site list unsupported');
    existing = Object.create(null);
    var rows = sites.querySelectorAll('[data-domain]');
    for (var i = 0; i < rows.length; i++) existing[rows[i].getAttribute('data-domain').toLowerCase()] = true;
    choice.disabled = false;
  }).catch(function () {
    choice.checked = false;
    error.textContent = 'Automatic SSL could not check the existing sites. After creation, open SSL certificates to install it.';
    error.hidden = false;
  });
  // Capture runs before CloudPanel's jQuery handler calls form.submit(). Native
  // browser validation has already succeeded; nothing delays the panel's submit.
  form.addEventListener('submit', function () {
    try {
      sessionStorage.removeItem(key);
      var hostname = domain.value.trim().toLowerCase();
      if (choice.checked && !existing) throw new Error('site list not ready');
      if (choice.checked && !existing[hostname]) sessionStorage.setItem(key, JSON.stringify({
        domain: hostname, user: user.value.trim(), type: choice.getAttribute('data-site-type'),
        completion: choice.getAttribute('data-completion'), at: Date.now()
      }));
      error.hidden = true;
    } catch (e) {
      error.textContent = 'Automatic SSL could not be remembered. After creation, open SSL certificates to install it.';
      error.hidden = false;
    }
  }, true);
})();

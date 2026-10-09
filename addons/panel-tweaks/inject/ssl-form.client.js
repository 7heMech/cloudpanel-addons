(function () {
  var key = 'clp_addons_wordpress_ssl';
  var form = document.getElementById('new-wordpress-site-form');
  var choice = document.getElementById('clp-auto-ssl');
  var domain = document.getElementById('site_new_word_press_domainName');
  var error = document.getElementById('clp-auto-ssl-error');
  if (!form || !choice || !domain) return;

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
  }
  // Capture runs before CloudPanel's jQuery handler calls form.submit(). Native
  // browser validation has already succeeded; nothing delays the panel's submit.
  form.addEventListener('submit', function () {
    try {
      sessionStorage.removeItem(key);
      if (choice.checked) sessionStorage.setItem(key, JSON.stringify({
        domain: domain.value.trim().toLowerCase(), at: Date.now()
      }));
      error.hidden = true;
    } catch (e) {
      error.textContent = 'Automatic SSL could not be remembered. After creation, open SSL certificates to install it.';
      error.hidden = false;
    }
  }, true);
})();

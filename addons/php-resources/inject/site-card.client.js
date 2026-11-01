(function () {
  var card = document.getElementById('clp-php-resources');
  var body = document.getElementById('clp-php-resources-body');
  if (!card || !body) return;
  // A deep link to an addon tab passes through this page and throws
  // its content away, so the card would be fetched to be discarded.
  if (new URLSearchParams(location.search).has('clp-addon')) return;
  fetch("ADDON_URL/site-card?domain=" + encodeURIComponent(card.dataset.domain), {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' }
  })
    .then(function (res) { return res.json(); })
    .then(function (payload) {
      if (!payload || payload.ok !== true) return;
      body.innerHTML = payload.html;
      card.hidden = false;
    })
    .catch(function () {});
})();

(function () {
  var links = document.querySelectorAll('a.clp-addons-git-row[data-domain]');
  if (!links.length) return;
  fetch("ADDON_URL/api/sites", {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' }
  })
    .then(function (res) { return res.json(); })
    .then(function (payload) {
      var deployed = {};
      if (payload && payload.ok === true) {
        (payload.domains || []).forEach(function (domain) { deployed[domain] = true; });
      }
      // Removed rather than left hidden: a row's actions may
      // have been moved into Panel Tweaks' menu by now, and
      // the menu styles the links inside it back into view.
      Array.prototype.forEach.call(links, function (link) {
        if (deployed[(link.dataset.domain || '').toLowerCase()]) link.hidden = false;
        else link.remove();
      });
    })
    .catch(function () {
      Array.prototype.forEach.call(links, function (link) { link.remove(); });
    });
})();

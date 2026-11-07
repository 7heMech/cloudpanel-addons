// Shows the root shell control to an administrator root allowed. Root answers
// through Terminal; a page asks at most once a minute per tab, and a box without
// Terminal, or a session that may not ask, leaves the control hidden.
// Plain ES5, because CloudPanel's own pages run it too.
(function () {
  var items = document.querySelectorAll("[data-clp-root-shell]");
  if (!items.length) return;
  function show(allowed) {
    if (!allowed) return;
    for (var i = 0; i < items.length; i++) {
      items[i].hidden = false;
      items[i].style.display = "";
    }
  }
  var key = "clp-root-shell";
  var now = Date.now();
  var cached = null;
  try { cached = JSON.parse(sessionStorage.getItem(key) || "null"); } catch (e) {}
  if (cached && now - cached.at < 60000) {
    show(cached.allowed);
    return;
  }
  fetch("ADDON_URL/api/root-access", { credentials: "same-origin", headers: { Accept: "application/json" } })
    .then(function (response) { return response.ok ? response.json() : null; })
    .then(function (reply) {
      var allowed = !!(reply && reply.ok && reply.data && reply.data.granted && !reply.data.problem);
      try { sessionStorage.setItem(key, JSON.stringify({ allowed: allowed, at: now })); } catch (e) {}
      show(allowed);
    })["catch"](function () {});
})();

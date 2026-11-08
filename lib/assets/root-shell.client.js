// Plain ES5, because CloudPanel's own pages run it too.
(function () {
  var items = document.querySelectorAll("[data-clp-root-shell]");
  if (!items.length) return;
  fetch("ADDON_URL/api/root-access", { credentials: "same-origin", headers: { Accept: "application/json" } })
    .then(function (response) { return response.ok ? response.json() : null; })
    .then(function (reply) {
      if (!(reply && reply.ok && reply.data && reply.data.granted && !reply.data.problem)) return;
      for (var i = 0; i < items.length; i++) {
        items[i].hidden = false;
        items[i].style.display = "";
      }
    })["catch"](function () {});
})();

// Plain ES5, because CloudPanel's own pages run it too.
//
// The controls are looked up once the page is parsed: on CloudPanel's pages
// this runs from the header item, ahead of the account menu's copy.
(function () {
  if (!document.querySelector("[data-clp-root-shell]")) return;
  function reveal() {
    var items = document.querySelectorAll("[data-clp-root-shell]");
    for (var i = 0; i < items.length; i++) {
      items[i].hidden = false;
      items[i].style.display = "";
    }
  }
  fetch("ADDON_URL/api/root-access", { credentials: "same-origin", headers: { Accept: "application/json" } })
    .then(function (response) { return response.ok ? response.json() : null; })
    .then(function (reply) {
      if (!(reply && reply.ok && reply.data && reply.data.granted && !reply.data.problem)) return;
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", reveal);
      else reveal();
    })["catch"](function () {});
})();

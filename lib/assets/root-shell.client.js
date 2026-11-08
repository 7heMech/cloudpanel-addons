// Plain ES5, because CloudPanel's own pages run it too.
//
// The controls are looked up once the page is parsed: on CloudPanel's pages
// this runs from the header item, ahead of the account menu's copy.
//
// The tab keeps the last answer, so a page that paints before the request
// returns, as the addons' own do, draws the controls in that first frame
// rather than pushing the tools aside a moment later. The request still runs
// on every page, and its answer is the one that stands.
(function () {
  if (!document.querySelector("[data-clp-root-shell]")) return;
  var KEY = "clp-root-shell";
  function show(granted) {
    var items = document.querySelectorAll("[data-clp-root-shell]");
    for (var i = 0; i < items.length; i++) {
      items[i].hidden = !granted;
      items[i].style.display = granted ? "" : "none";
    }
  }
  function remember(granted) {
    try {
      if (granted) sessionStorage.setItem(KEY, "1");
      else sessionStorage.removeItem(KEY);
    } catch (error) {}
  }
  function settle(granted) {
    remember(granted);
    show(granted);
    // The account menu's copy comes later in a panel page than this script.
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { show(granted); });
  }
  var known = false;
  try { known = sessionStorage.getItem(KEY) === "1"; } catch (error) {}
  if (known) settle(true);
  fetch("ADDON_URL/api/root-access", { credentials: "same-origin", headers: { Accept: "application/json" } })
    .then(function (response) { return response.ok ? response.json() : null; })
    .then(function (reply) {
      var granted = !!(reply && reply.ok && reply.data && reply.data.granted && !reply.data.problem);
      if (granted || known) settle(granted);
    })["catch"](function () { if (known) settle(false); });
})();

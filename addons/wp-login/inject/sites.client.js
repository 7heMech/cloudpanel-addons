
(function () {
  function csrf() {
    var match = document.cookie.match(/(?:^|;\s*)clp_addons_csrf=([^;]+)/);
    return match ? match[1] : "";
  }

  // This page is CloudPanel's, not the addon's, so the browser may hold no
  // token yet -- and a non-administrator has no addon page to have been given
  // one by. One GET, only when there is nothing to send.
  function ready() {
    if (csrf()) return Promise.resolve();
    return fetch("ADDON_URL/api/session", { credentials: "same-origin", headers: { Accept: "application/json" } })
      .then(function () {});
  }

  // Posted rather than put in the address bar: a single-use secret in a query
  // string is still a secret in the site's access log and in the browser's
  // history.
  function submit(target, data) {
    if (!target) {
      alert("Allow pop-ups for the panel to open WordPress.");
      return;
    }
    var form = target.document.createElement("form");
    form.method = "POST";
    form.action = data.url;
    var field = target.document.createElement("input");
    field.type = "hidden";
    field.name = data.field;
    field.value = data.token;
    form.appendChild(field);
    target.document.body.appendChild(form);
    form.submit();
  }

  function start(event) {
    var link = event.target.closest ? event.target.closest("a.clp-wp-login") : null;
    if (!link) return;
    event.preventDefault();
    if (link.dataset.busy === "1") return;
    link.dataset.busy = "1";
    // Opened inside the click, before anything is awaited: a window opened
    // after a fetch resolves is a popup the browser blocks.
    var target = window.open("", "_blank");
    ready()
      .then(function () {
        return fetch("ADDON_URL/api/sign-in", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", "X-CLP-Addons-CSRF": csrf(), Accept: "application/json" },
          body: JSON.stringify({ domain: link.getAttribute("data-clp-domain") })
        });
      })
      .then(function (response) { return response.json(); })
      .then(function (payload) {
        if (!payload || payload.ok !== true) throw new Error((payload && payload.error) || "sign-in unavailable");
        submit(target, payload.data);
      })
      .catch(function (error) {
        if (target) target.close();
        alert("WordPress sign-in failed: " + error.message);
      })
      .finally(function () { link.dataset.busy = "0"; });
  }

  // One listener on the document rather than one per row: the rows are the
  // panel's, and a filtered or re-sorted table moves them around.
  document.addEventListener("click", start);
})();

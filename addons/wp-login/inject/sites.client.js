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

  // CloudPanel's own Bootstrap modal, built once, so a message looks like the
  // panel's Delete Site dialog rather than the browser's. `onAccept` runs inside
  // the accepting click, where opening a window is still allowed.
  function dialog(title, text, acceptLabel, onAccept) {
    var Modal = window.bootstrap && window.bootstrap.Modal;
    if (!Modal) {
      if (!acceptLabel) alert(text);
      else if (confirm(text)) onAccept();
      return;
    }
    var el = document.getElementById("clp-wp-login-dialog");
    if (!el) {
      el = document.createElement("div");
      el.id = "clp-wp-login-dialog";
      el.className = "modal fade";
      el.tabIndex = -1;
      el.innerHTML = '<div class="modal-dialog modal-dialog-centered"><div class="modal-content">'
        + '<div class="modal-header"><h5 class="modal-title"></h5>'
        + '<button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button></div>'
        + '<div class="modal-body"><p class="mb-0"></p></div>'
        + '<div class="modal-footer d-flex justify-content-between">'
        + '<button type="button" class="btn btn-lg btn-white" data-bs-dismiss="modal"></button>'
        + '<button type="button" class="btn btn-lg btn-blue"></button></div>'
        + '</div></div>';
      document.body.appendChild(el);
    }
    // CloudPanel ships Bootstrap 5.0.1, which has no getOrCreateInstance.
    var modal = Modal.getInstance(el) || new Modal(el);
    var accept = el.querySelector(".btn-blue");
    el.querySelector(".modal-title").textContent = title;
    el.querySelector(".modal-body p").textContent = text;
    el.querySelector(".btn-white").textContent = acceptLabel ? "Cancel" : "Close";
    accept.hidden = !acceptLabel;
    accept.textContent = acceptLabel || "";
    accept.onclick = function () {
      modal.hide();
      onAccept();
    };
    modal.show();
  }

  // Posted rather than put in the address bar: a single-use secret in a query
  // string is still a secret in the site's access log and in the browser's
  // history.
  function submit(target, data) {
    if (!target) {
      dialog("WordPress sign-in", "Allow pop-ups for the panel to open WordPress.");
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

  // `target` is opened by the caller inside a click, before anything is
  // awaited: a window opened after a fetch resolves is a popup the browser
  // blocks.
  function signIn(domain, addBypass, target) {
    return ready()
      .then(function () {
        return fetch("ADDON_URL/api/sign-in", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", "X-CLP-Addons-CSRF": csrf(), Accept: "application/json" },
          body: JSON.stringify({ domain: domain, addBypass: addBypass })
        });
      })
      .then(function (response) { return response.json(); })
      .then(function (payload) {
        if (!payload || payload.ok !== true) throw new Error((payload && payload.error) || "sign-in unavailable");
        var maintenance = payload.data.maintenance;
        if (!maintenance) return submit(target, payload.data);
        if (target) target.close();
        if (!maintenance.canBypass) return dialog("Site in maintenance", maintenance.message);
        dialog("Site in maintenance", maintenance.message, "Add IP and sign in", function () {
          signIn(domain, true, window.open("", "_blank"));
        });
      })
      .catch(function (error) {
        if (target) target.close();
        dialog("WordPress sign-in failed", error.message);
      });
  }

  function start(event) {
    var link = event.target.closest ? event.target.closest("a.clp-wp-login") : null;
    if (!link) return;
    event.preventDefault();
    if (link.dataset.busy === "1") return;
    link.dataset.busy = "1";
    signIn(link.getAttribute("data-clp-domain"), false, window.open("", "_blank"))
      .finally(function () { link.dataset.busy = "0"; });
  }

  // One listener on the document rather than one per row: the rows are the
  // panel's, and a filtered or re-sorted table moves them around.
  document.addEventListener("click", start);
})();

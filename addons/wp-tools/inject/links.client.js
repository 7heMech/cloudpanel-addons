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
  // the accepting click, where opening a window is still allowed. Bootstrap
  // 5.0 ignores show() while the modal is still fading out, so a message that
  // arrives then waits for it to finish.
  var hiding = false;
  function dialog(title, text, acceptLabel, onAccept) {
    var Modal = window.bootstrap && window.bootstrap.Modal;
    if (!Modal) {
      if (!acceptLabel) alert(text);
      else if (confirm(text)) onAccept();
      return;
    }
    var el = document.getElementById("clp-wp-tools-dialog");
    if (!el) {
      el = document.createElement("div");
      el.id = "clp-wp-tools-dialog";
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
      el.addEventListener("hide.bs.modal", function () { hiding = true; });
      el.addEventListener("hidden.bs.modal", function () { hiding = false; });
    }
    if (hiding) {
      el.addEventListener("hidden.bs.modal", function () { dialog(title, text, acceptLabel, onAccept); }, { once: true });
      return;
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
      accept.onclick = null;
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
    // Cut before WordPress loads: a page in that window could otherwise send
    // this panel tab somewhere else through window.opener.
    target.opener = null;
    form.submit();
  }

  // `target` is opened by the caller inside a click, before anything is
  // awaited: a window opened after a fetch resolves is a popup the browser
  // blocks.
  function signIn(domain, addBypass, target, allowBasicAuth) {
    return ready()
      .then(function () {
        return fetch("ADDON_URL/api/sign-in", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", "X-CLP-Addons-CSRF": csrf(), Accept: "application/json" },
          body: JSON.stringify({ domain: domain, addBypass: addBypass, allowBasicAuth: allowBasicAuth === true })
        });
      })
      .then(function (response) { return response.json(); })
      .then(function (payload) {
        if (!payload || payload.ok !== true) throw new Error((payload && payload.error) || "sign-in unavailable");
        var maintenance = payload.data.maintenance || payload.data.basicAuth;
        var title = payload.data.basicAuth ? "Site protected by basic authentication" : "Site in maintenance";
        if (!maintenance) return submit(target, payload.data);
        if (target) target.close();
        if (!maintenance.canBypass) return dialog(title, maintenance.message);
        dialog(title, maintenance.message, "Add IP and sign in", function () {
          signIn(domain, addBypass || !!payload.data.maintenance, window.open("", "_blank"), allowBasicAuth || !!payload.data.basicAuth);
        });
      })
      .catch(function (error) {
        if (target) target.close();
        dialog("WordPress sign-in failed", error.message);
      });
  }

  function start(event) {
    var link = event.target.closest ? event.target.closest("a.clp-wp-tools") : null;
    if (!link) return;
    // The domain keeps the site's address, which a modified click opens.
    if (link.getAttribute("href") !== "#" && (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)) return;
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

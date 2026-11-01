(function() {
  if (window.__clpAddonsUpdateInit) return;
  window.__clpAddonsUpdateInit = true;

  function hide() {
    var notice = document.getElementById("clp-addons-update-notice");
    if (notice) notice.remove();
    var header = document.querySelector(".header");
    if (header) header.classList.remove("clp-addons-has-update");
  }

  function render(info) {
    if (!info || info.hasUpdate !== true || typeof info.latest !== "string") {
      hide();
      return;
    }
    var latest = info.latest.replace(/^v/, "");
    var header = document.querySelector(".header");
    var tools = header && header.querySelector(".navbar-right");
    if (!tools) return;
    var notice = document.getElementById("clp-addons-update-notice");
    if (!notice) {
      var holder = document.createElement("div");
      holder.innerHTML = "NOTICE_HTML";
      notice = holder.firstElementChild;
      tools.insertAdjacentElement("beforebegin", notice);
    }
    notice.querySelector(".update-label").textContent = "Addons · v" + latest + " available";
    notice.querySelector(".clp-addon-update-badge").title = "clp-addons v" + latest + " available";
    notice.querySelector(".clp-addon-changelog-link").href = "RELEASES_URL/tag/v" + encodeURIComponent(latest);
    header.classList.add("clp-addons-has-update");
  }

  var checking = false;
  var checkAgain = false;
  function check() {
    if (checking) {
      checkAgain = true;
      return;
    }
    checking = true;
    fetch("STATUS_URL", {
      cache: "no-store",
      headers: { Accept: "application/json" }
    })
    .then(function(response) { return response.ok ? response.json() : null; })
    .then(function(body) {
      render(body && body.ok !== false ? body.data : null);
    })
    .catch(function() { hide(); })
    .finally(function() {
      checking = false;
      if (checkAgain) {
        checkAgain = false;
        check();
      }
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", check, { once: true });
  else check();
  window.addEventListener("pageshow", function(event) { if (event.persisted) check(); });
  window.addEventListener("focus", check);
})();

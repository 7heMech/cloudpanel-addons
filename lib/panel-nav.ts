import type { AddonTarget } from "../cli/paths";
import { esc, escJs } from "./app-http";

export function headerUpdateScript(version: string): string {
  return `(function() {
  if (window.__clpAddonsUpdateInit) return;
  window.__clpAddonsUpdateInit = true;
  var currentVer = "${escJs(version)}";
  if (!currentVer || currentVer === "0.0.0-dev") return;

  function render(ver) {
    if (document.getElementById("clp-addons-update-notice")) return;
    var el = document.createElement("a");
    el.id = "clp-addons-update-notice";
    el.className = "clp-addon-update-badge";
    el.href = "https://github.com/7heMech/cloudpanel-addons/releases";
    el.target = "_blank";
    el.rel = "noopener";
    el.title = "clp-addons v" + ver + " available! Run 'clp-addons update' as root to upgrade.";
    el.innerHTML = '<span class="dot"></span><span class="update-label"></span><span class="close-btn" title="Dismiss">×</span>';
    el.querySelector(".update-label").textContent = "Update clp-addons: v" + ver;

    var close = el.querySelector(".close-btn");
    if (close) {
      close.onclick = function(e) {
        e.preventDefault();
        e.stopPropagation();
        try {
          localStorage.setItem("clp_addons_update_check", JSON.stringify({ time: Date.now() + 86400000, hasUpdate: false }));
        } catch(err) {}\
        el.remove();
      };
    }

    var nav = document.querySelector(".header .nav-link-container .clp-addon-nav");
    if (nav) nav.insertAdjacentElement("afterend", el);
  }

  try {
    var key = "clp_addons_update_check";
    var cache = JSON.parse(localStorage.getItem(key) || "null");
    var now = Date.now();
    if (cache && (now - cache.time < 15 * 60 * 1000)) {
      if (cache.hasUpdate && cache.latest) render(cache.latest);
      return;
    }
    fetch("https://api.github.com/repos/7heMech/cloudpanel-addons/releases/latest", {
      headers: { Accept: "application/vnd.github+json" }
    })
    .then(function(r) { return r.ok ? r.json() : null; })
    .then(function(data) {
      if (!data || !data.tag_name) return;
      var latest = data.tag_name.replace(/^v/, "");
      var cur = currentVer.replace(/^v/, "");
      var pa = latest.split("-")[0].split(".").map(Number);
      var pb = cur.split("-")[0].split(".").map(Number);
      var hasUpdate = false;
      for (var i = 0; i < 3; i++) {
        var diff = (pa[i] || 0) - (pb[i] || 0);
        if (diff !== 0) { hasUpdate = diff > 0; break; }
      }
      localStorage.setItem(key, JSON.stringify({ time: now, hasUpdate: hasUpdate, latest: latest }));
      if (hasUpdate) render(latest);
    })
    .catch(function() {});
  } catch(e) {}\
})();`;
}

/** Keep the single manager navigation entry after CloudPanel's native links. */
export function headerTarget(version: string): AddonTarget {
  return {
    slug: "header-nav",
    template: "Frontend/Partial/header.html.twig",
    anchorAfter: `<a href="{{ path('clp_sites') }}" title="{% trans %}Sites{% endtrans %}">{% trans %}Sites{% endtrans %}</a>`,
    required: true,
    snippet: (url) => `
      {% if is_granted('ROLE_ADMIN') %}
      <style>
        .clp-addon-update-badge { display:inline-flex; align-items:center; gap:5px; margin-left:15px; padding:2px 10px; font-size:12px; font-weight:600; color:#10b981; background:rgba(16,185,129,0.12); border:1px solid rgba(16,185,129,0.35); border-radius:12px; text-decoration:none; vertical-align:middle; transition:all 0.15s ease; }
        .clp-addon-update-badge:hover { background:rgba(16,185,129,0.22); color:#10b981; text-decoration:none; }
        .clp-addon-update-badge .dot { display:inline-block; width:7px; height:7px; border-radius:50%; background:#10b981; }
        .clp-addon-update-badge .close-btn { margin-left:4px; opacity:0.6; cursor:pointer; padding:0 2px; }
        .clp-addon-update-badge .close-btn:hover { opacity:1; }
      </style>
      <a href="${esc(url)}" class="clp-addon-nav" title="Addons">Addons</a>
      <script>${headerUpdateScript(version || process.env.CLP_ADDONS_VERSION || "")}</script>
      {% endif %}`,
  };
}

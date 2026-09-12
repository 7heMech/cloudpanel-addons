import type { AddonTarget } from "../cli/paths";
import { esc, escJs } from "./app-http";
import { UPDATE_STYLE, updateNoticeHtml } from "./update-ui";

export function headerUpdateScript(version: string, addonsUrl = "/addons/"): string {
  const updateUrl = `${addonsUrl.replace(/\/+$/, "")}/update`;
  return `(function() {
  if (window.__clpAddonsUpdateInit) return;
  window.__clpAddonsUpdateInit = true;
  var currentVer = "${escJs(version)}";
  if (!currentVer || currentVer === "0.0.0-dev") return;

  function isNewer(latest) {
    if (typeof latest !== "string" || !/^v?[0-9]+\\.[0-9]+\\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/.test(latest)) return false;
    var pa = latest.replace(/^v/, "").split(/[-+]/)[0].split(".").map(Number);
    var pb = currentVer.replace(/^v/, "").split(/[-+]/)[0].split(".").map(Number);
    for (var i = 0; i < 3; i++) {
      var diff = (pa[i] || 0) - (pb[i] || 0);
      if (diff !== 0) return diff > 0;
    }
    return false;
  }

  function render(latest) {
    // Recompare cached releases against the installed version so the tag goes
    // away immediately after an update, even within the cache lifetime.
    if (!isNewer(latest) || document.getElementById("clp-addons-update-notice")) return;
    var header = document.querySelector(".header");
    var tools = header && header.querySelector(".navbar-right");
    if (!tools) return;
    var holder = document.createElement("div");
    holder.innerHTML = "${escJs(updateNoticeHtml("", updateUrl))}";
    var el = holder.firstElementChild;
    var ver = latest.replace(/^v/, "");
    el.querySelector(".update-label").textContent = "v" + ver + " available";
    el.querySelector(".clp-addon-update-badge").title = "clp-addons v" + ver + " available";
    tools.insertAdjacentElement("beforebegin", el);
    header.classList.add("clp-addons-has-update");
  }

  function init() {
    var key = "clp_addons_update_check";
    var cache = null;
    var now = Date.now();
    try { cache = JSON.parse(localStorage.getItem(key) || "null"); } catch(e) {}
    if (cache && typeof cache.latest === "string" && now >= cache.time && now - cache.time < 15 * 60 * 1000) {
      render(cache.latest);
      return;
    }
    fetch("https://api.github.com/repos/7heMech/cloudpanel-addons/releases/latest", {
      headers: { Accept: "application/vnd.github+json" }
    })
    .then(function(r) { return r.ok ? r.json() : null; })
    .then(function(data) {
      if (!data || typeof data.tag_name !== "string") return;
      var latest = data.tag_name.replace(/^v/, "");
      try { localStorage.setItem(key, JSON.stringify({ time: now, latest: latest })); } catch(e) {}
      render(latest);
    })
    .catch(function() {});
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();
})();`;
}

// Only adjust the native header when there is a release to show. Flattening
// its right-hand wrapper lets the controls wrap with the logo and navigation.
const PANEL_UPDATE_STYLE = UPDATE_STYLE + `
.header.clp-addons-has-update { height: auto; min-height: 75px; flex-wrap: wrap; align-items: stretch; }
.header.clp-addons-has-update .navbar-right-container { display: contents !important; }
.header.clp-addons-has-update .nav-link-container,
.header.clp-addons-has-update .header-instance-information-container { flex: 1 1 0; min-width: 0; white-space: nowrap; }
.header.clp-addons-has-update .header-instance-information-container { overflow-x: auto; }
.header.clp-addons-has-update .header-instance-information-container > ul { float: none; width: max-content; min-width: 100%; padding: 26px 20px; }
.header.clp-addons-has-update .navbar-right { flex: 0 0 auto; padding-left: 0; margin-left: auto; }
.header #clp-addons-update-notice { margin: 0 16px; }
.header .header-instance-information-container + #clp-addons-update-notice { order: 3; flex: 1 0 100%; margin: 0; padding: 10px 20px;
  justify-content: flex-end; border-top: 1px solid var(--update-link-border); }
@media (max-width: 1250px) {
  .header #clp-addons-update-notice { order: 3; flex: 1 0 100%; margin: 0; padding: 10px 20px;
    justify-content: flex-end; border-top: 1px solid var(--update-link-border); }
}
@media (max-width: 960px) {
  .header.clp-addons-has-update .nav-link-container,
  .header.clp-addons-has-update .header-instance-information-container { order: 2; flex-basis: 100%; border-top: 1px solid #e2e2e233; }
  .header.clp-addons-has-update .nav-link-container { display: flex; }
  .header.clp-addons-has-update .nav-link-container > a { margin-left: 0; line-height: 48px; }
}
@media (max-width: 600px) {
  .header.clp-addons-has-update .logo { min-width: 0; padding: 20px 10px 0; margin: 0; border: 0; }
  .header.clp-addons-has-update .navbar-right > ul > li > a { padding: 0 8px; }
  .header.clp-addons-has-update .navbar-right > ul > li.admin-area > a { font-size: 0; }
  .header.clp-addons-has-update .navbar-right > ul > li.admin-area > a svg { margin: 0; }
  .header #clp-addons-update-notice,
  .header .header-instance-information-container + #clp-addons-update-notice { justify-content: center; padding: 10px 16px; }
}
`;

function updateSnippet(version: string, url: string): string {
  return `<style>${PANEL_UPDATE_STYLE}</style>
      <script>${headerUpdateScript(version || process.env.CLP_ADDONS_VERSION || "", url)}</script>`;
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
      <a href="${esc(url)}" class="clp-addon-nav" title="Addons">Addons</a>
      ${updateSnippet(version, url)}
      {% endif %}`,
  };
}

/** The Admin Area uses its own header without the frontend navigation. */
export function adminHeaderTarget(version: string): AddonTarget {
  return {
    slug: "admin-header-update",
    template: "Admin/Partial/header.html.twig",
    anchorBefore: "</header>",
    required: false,
    snippet: (url) => `
      {% if is_granted('ROLE_ADMIN') %}
      ${updateSnippet(version, url)}
      {% endif %}`,
  };
}

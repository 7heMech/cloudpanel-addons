import type { AddonTarget } from "../cli/paths";
import { esc, escJs } from "./app-http";
import { UPDATE_STYLE, updateNoticeHtml } from "./update-ui";

export function headerUpdateScript(addonsUrl = "/addons/"): string {
  const baseUrl = addonsUrl.replace(/\/+$/, "");
  const updateUrl = `${baseUrl}/update`;
  const statusUrl = `${baseUrl}/api/update`;
  return `(function() {
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
      holder.innerHTML = "${escJs(updateNoticeHtml("", updateUrl))}";
      notice = holder.firstElementChild;
      tools.insertAdjacentElement("beforebegin", notice);
    }
    notice.querySelector(".update-label").textContent = "Addons · v" + latest + " available";
    notice.querySelector(".clp-addon-update-badge").title = "clp-addons v" + latest + " available";
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
    fetch("${escJs(statusUrl)}", {
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

function updateSnippet(url: string): string {
  return `<style>${PANEL_UPDATE_STYLE}</style>
      <script>${headerUpdateScript(url)}</script>`;
}

/** Keep the single manager navigation entry after CloudPanel's native links. */
export function headerTarget(): AddonTarget {
  return {
    slug: "header-nav",
    template: "Frontend/Partial/header.html.twig",
    anchorAfter: `<a href="{{ path('clp_sites') }}" title="{% trans %}Sites{% endtrans %}">{% trans %}Sites{% endtrans %}</a>`,
    required: true,
    snippet: (url) => `
      {% if is_granted('ROLE_ADMIN') %}
      <a href="${esc(url)}" class="clp-addon-nav" title="Addons">Addons</a>
      ${updateSnippet(url)}
      {% endif %}`,
  };
}

/** The Admin Area uses its own header without the frontend navigation. */
export function adminHeaderTarget(): AddonTarget {
  return {
    slug: "admin-header-update",
    template: "Admin/Partial/header.html.twig",
    anchorBefore: "</header>",
    required: false,
    snippet: (url) => `
      {% if is_granted('ROLE_ADMIN') %}
      ${updateSnippet(url)}
      {% endif %}`,
  };
}

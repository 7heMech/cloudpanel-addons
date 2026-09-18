// What the WordPress Sign-In addon adds to CloudPanel's own Sites page.
//
// Two blocks, because the page has two places for them. The link belongs in the
// action cell, which is inside the template's `{% for site in sites %}` loop, so
// anything put there is emitted once per row -- the condition can be Twig, and
// the script cannot. The script and its one rule go above the table instead,
// where they are emitted once.
//
// Neither is `required`: a CloudPanel release that renames the sites card or
// the Manage link should cost the link, not stop the addon from being enabled.
// The addon's own page signs in to the same sites either way.

import type { AddonTarget } from "../../../lib/addon-target";
import { WORDPRESS_APPLICATIONS } from "../action";

const WORDPRESS = `{% if site.application in [${WORDPRESS_APPLICATIONS.map((name) => `'${name}'`).join(", ")}] %}`;

const STYLE = `
.clp-wp-login { margin-left: 0.75rem; white-space: nowrap; }
`;

// Written for the panel's page, not for an addon page: no shared client code
// reaches here, so this is plain ES5 with its own fetch. It reads nothing out
// of the document but the domain the template wrote into the link.
const SCRIPT = `
(function () {
  function csrf() {
    var match = document.cookie.match(/(?:^|;\\s*)clp_addons_csrf=([^;]+)/);
    return match ? match[1] : "";
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
    fetch("ADDON_URL/api/sign-in", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-CLP-Addons-CSRF": csrf(), Accept: "application/json" },
      body: JSON.stringify({ domain: link.getAttribute("data-clp-domain") })
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
`;

export const WP_LOGIN_TARGETS: AddonTarget[] = [
  {
    slug: "sites-script",
    template: "Frontend/Site/index.html.twig",
    anchorBefore: '<div class="card card-table">',
    required: false,
    snippet: (url) => `
          {% if is_granted('ROLE_ADMIN') %}
          <style>${STYLE}</style>
          <script>${SCRIPT.split("ADDON_URL").join(url)}</script>
          {% endif %}`,
  },
  {
    slug: "sites-action",
    template: "Frontend/Site/index.html.twig",
    anchorAfter: `<a href="{{ path('clp_site', {'domainName': site.domainName}) }}">{% trans %}Manage{% endtrans %}</a>`,
    required: false,
    snippet: () => `
        {% if is_granted('ROLE_ADMIN') %}${WORDPRESS}
          <a href="#" class="clp-wp-login" data-clp-domain="{{ site.domainName }}" title="Sign in to WordPress as its first administrator">WP Login</a>
        {% endif %}{% endif %}`,
  },
];

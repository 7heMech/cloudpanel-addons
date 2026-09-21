// What the PHP Resources addon adds to the CloudPanel UI: one read-only card
// on a site's Settings tab, under the panel's own PHP Settings form.
//
// Read-only because the limits belong to a category rather than to a site --
// changing them for one site alone is not a thing this addon does, and a form
// here would promise it. The card says which category the site is in and what
// its pool is running; the addon page is where that is decided.
//
// The values cannot come from Twig: they are in a pool file and a policy the
// panel knows nothing about. So the card is empty markup that fills itself from
// the addon, and stays hidden if it cannot.

import type { AddonTarget } from "../../../lib/addon-target";

// Read-only rows in a form the panel draws with bordered inputs: the label is
// dimmed rather than recoloured, so it follows CloudPanel's own light and dark
// stylesheets instead of pinning a colour of its own.
const STYLE = [
  "#clp-php-resources .col-form-label { padding-bottom: 0; opacity: .7; }",
  "#clp-php-resources .clp-addon-readonly { padding: 2px 0 14px; overflow-wrap: anywhere; }",
].join(" ");

export const PHP_RESOURCES_TARGETS: AddonTarget[] = [
  {
    // Inside the panel's own `{% if phpSettingsForm is defined %}`, so the card
    // appears exactly where a pool file exists: a static or Node.js site has no
    // PHP settings form and gets nothing.
    slug: "site-settings-card",
    template: "Frontend/Site/settings.html.twig",
    anchorAfter: `            {{ form_end(phpSettingsForm) }}
          </div>`,
    required: false,
    snippet: (url) => `
          {% if is_granted('ROLE_ADMIN') %}
          <div class="card" id="clp-php-resources" data-domain="{{ site.domainName }}" hidden>
            <div class="card-header d-flex justify-content-between">
              <div>PHP-FPM Resources</div>
              <a class="btn btn-gray btn-lg" href="${url}/">Manage</a>
            </div>
            <div class="card-body card-body-no-padding">
              <div class="card-form" id="clp-php-resources-body"></div>
            </div>
          </div>
          <style>${STYLE}</style>
          <script>
            (function () {
              var card = document.getElementById('clp-php-resources');
              var body = document.getElementById('clp-php-resources-body');
              if (!card || !body) return;
              // A deep link to an addon tab passes through this page and throws
              // its content away, so the card would be fetched to be discarded.
              if (new URLSearchParams(location.search).has('clp-addon')) return;
              fetch('${url}/site-card?domain=' + encodeURIComponent(card.dataset.domain), {
                credentials: 'same-origin',
                headers: { Accept: 'application/json' }
              })
                .then(function (res) { return res.json(); })
                .then(function (payload) {
                  if (!payload || payload.ok !== true) return;
                  body.innerHTML = payload.html;
                  card.hidden = false;
                })
                .catch(function () {});
            })();
          </script>
          {% endif %}`,
  },
];

// What the Redirects addon adds to the CloudPanel UI: one read-only card on a
// site's Settings tab, saying where that site sends its visitors.
//
// Read-only because a redirect is a fleet-level decision with a fleet page of
// its own, and because the card has to stay honest about what is applied. The
// values cannot come from Twig -- the panel knows the vhost text, not the
// redirect inside it -- so the card is empty markup that fills itself from the
// addon and stays hidden when the site has no redirect, which is most sites.

import type { AddonTarget } from "../../../lib/addon-target";

const STYLE = [
  "#clp-redirects .col-form-label { padding-bottom: 0; opacity: .7; }",
  "#clp-redirects .clp-addon-readonly { padding: 2px 0 14px; overflow-wrap: anywhere; }",
].join(" ");

export const REDIRECTS_TARGETS: AddonTarget[] = [
  {
    // After the Site User Settings card, which every site type has: a redirect
    // site is static, so anchoring to one of the language-specific forms would
    // place the card on every site except the ones that have a redirect.
    slug: "site-settings-card",
    template: "Frontend/Site/settings.html.twig",
    anchorAfter: `          {{ form_end(siteUserSettingsForm) }}
        </div>`,
    required: false,
    snippet: (url) => `
        {% if is_granted('ROLE_ADMIN') %}
        <div class="card" id="clp-redirects" data-domain="{{ site.domainName }}" hidden>
          <div class="card-header d-flex justify-content-between">
            <div>Redirect</div>
            <a class="btn btn-gray btn-lg" href="${url}/">Manage</a>
          </div>
          <div class="card-body card-body-no-padding">
            <div class="card-form" id="clp-redirects-body"></div>
          </div>
        </div>
        <style>${STYLE}</style>
        <script>
          (function () {
            var card = document.getElementById('clp-redirects');
            var body = document.getElementById('clp-redirects-body');
            if (!card || !body) return;
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

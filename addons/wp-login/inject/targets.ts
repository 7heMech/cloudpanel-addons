// What the WordPress Sign-In addon adds to CloudPanel's own Sites page.
//
// Two blocks, because the page has two places for them. The link belongs in the
// action cell, which is inside the template's `{% for site in sites %}` loop, so
// anything put there is emitted once per row -- the condition can be Twig, and
// the script cannot. The script and its one rule go above the table instead,
// where they are emitted once.
//
// Neither block asks for ROLE_ADMIN. CloudPanel lists a `ROLE_USER` only the
// sites `user_sites` maps to their account, so the rows a non-administrator
// sees are already theirs, and the sign-in route checks that again as root
// rather than trusting the page it was clicked on.
//
// Neither is `required`: a CloudPanel release that renames the sites card or
// the Manage link should cost the link, not stop the addon from being enabled.
// The addon's own page signs in to the same sites either way.

import type { AddonTarget } from "../../../lib/addon-target";
import { ROW_ACTION_CLASS } from "../../../lib/row-actions";
import { WORDPRESS_APPLICATIONS } from "../action";

const WORDPRESS = `{% if site.application in [${WORDPRESS_APPLICATIONS.map((name) => `'${name}'`).join(", ")}] %}`;

import STYLE from "./sites.css" with { type: "text" };

// Written for the panel's page, not for an addon page: no shared client code
// reaches here, so this is plain ES5 with its own fetch. It reads nothing out
// of the document but the domain the template wrote into the link.
import SCRIPT from "./sites.client.js" with { type: "text" };

export const WP_LOGIN_TARGETS: AddonTarget[] = [
  {
    slug: "sites-script",
    template: "Frontend/Site/index.html.twig",
    anchorBefore: '<div class="card card-table">',
    required: false,
    snippet: (url) => `
          <style>${STYLE}</style>
          <script>${SCRIPT.split("ADDON_URL").join(url)}</script>`,
  },
  {
    slug: "sites-action",
    template: "Frontend/Site/index.html.twig",
    anchorBefore: `<a href="{{ path('clp_site', {'domainName': site.domainName}) }}">{% trans %}Manage{% endtrans %}</a>`,
    required: false,
    snippet: () => `
        ${WORDPRESS}
          <a href="#" class="clp-wp-login ${ROW_ACTION_CLASS}" data-clp-domain="{{ site.domainName }}" title="Sign in to WordPress as its first administrator">WP Login</a>
        {% endif %}`,
  },
];

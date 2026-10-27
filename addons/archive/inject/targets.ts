// The Sites row's way into Archive Sites: a link to the addon page with the
// site picked, where the archive is confirmed. Archiving is rare, so like
// Stager's Clone it sits in the row's action menu only, before Manage, and the
// panel's own Manage keeps its place.
import type { AddonTarget } from "../../../lib/addon-target";
import { MENU_ONLY_CLASS, MENU_ONLY_STYLE, ROW_ACTION_CLASS } from "../../../lib/row-actions";

export const ARCHIVE_TARGETS: AddonTarget[] = [
  {
    slug: "site-list-style",
    template: "Frontend/Site/index.html.twig",
    anchorBefore: '<div class="card card-table">',
    required: false,
    snippet: () => `
          {% if is_granted('ROLE_ADMIN') %}
          <style>${MENU_ONLY_STYLE}</style>
          {% endif %}`,
  },
  {
    slug: "site-list-action",
    template: "Frontend/Site/index.html.twig",
    anchorBefore: `<a href="{{ path('clp_site', {'domainName': site.domainName}) }}">{% trans %}Manage{% endtrans %}</a>`,
    required: false,
    snippet: (url) => `{% if is_granted('ROLE_ADMIN') %}<a class="${ROW_ACTION_CLASS} ${MENU_ONLY_CLASS}" href="${url}/?site={{ site.domainName|url_encode }}">Archive</a>{% endif %}`,
  },
];

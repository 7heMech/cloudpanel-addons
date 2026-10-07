// What the Terminal addon adds to CloudPanel's own pages: a link in each Sites
// row and one at the right end of a site's tab strip. Neither is a tab -- the
// terminal opens in a window of its own -- and both are for administrators
// only, which the manager's gate enforces again.
//
// Neither is `required`: a CloudPanel release that moves either anchor should
// cost the link, not stop the addon from being enabled. Addons → Terminal
// opens every site either way.

import type { AddonTarget } from "../../../lib/addon-target";
import { SITE_TAB_TEMPLATE } from "../../../lib/panel-nav";
import { ROW_ACTION_CLASS } from "../../../lib/row-actions";
import { OPEN_JS } from "../app/views";

import STYLE from "./links.css" with { type: "text" };
import LINKS_JS from "./links.client.js" with { type: "text" };

const ADMIN = "{% if is_granted('ROLE_ADMIN') %}";

function script(url: string): string {
  return `
          <style>${STYLE}</style>
          <script>${`${OPEN_JS}${LINKS_JS}`.split("ADDON_URL").join(url)}</script>`;
}

export const TERMINAL_TARGETS: AddonTarget[] = [
  {
    slug: "sites-script",
    template: "Frontend/Site/index.html.twig",
    anchorBefore: '<div class="card card-table">',
    required: false,
    snippet: (url) => `
        ${ADMIN}${script(url)}
        {% endif %}`,
  },
  {
    slug: "sites-action",
    template: "Frontend/Site/index.html.twig",
    anchorBefore: `<a href="{{ path('clp_site', {'domainName': site.domainName}) }}">{% trans %}Manage{% endtrans %}</a>`,
    required: false,
    snippet: (url) => `
        ${ADMIN}
          <a href="${url}/sites/{{ site.domainName|url_encode }}" class="clp-terminal-open ${ROW_ACTION_CLASS}" data-clp-domain="{{ site.domainName }}" style="margin-right: 0.75rem;" title="Open a shell as this site's user">Terminal</a>
        {% endif %}`,
  },
  {
    // Beside the tab list rather than in it: the list scrolls sideways when a
    // site has many tabs, and this must stay in view whatever the others add.
    slug: "site-button",
    template: SITE_TAB_TEMPLATE,
    anchorAfter: "  </ul>",
    required: false,
    snippet: (url) => `
        ${ADMIN}
          <a href="${url}/sites/{{ site.domainName|url_encode }}" class="clp-terminal-open clp-terminal-tab" data-clp-domain="{{ site.domainName }}" title="Open a shell as this site's user" aria-label="Terminal"><span aria-hidden="true">&gt;_</span><span class="clp-terminal-label">Terminal</span></a>${script(url)}
        {% endif %}`,
  },
];

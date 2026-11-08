// What the Terminal addon adds to CloudPanel's own pages: a link in each Sites
// row, one at the right end of a site's tab strip, and a root shell control in
// both headers that only an administrator root allowed sees. Neither is a tab
// -- the terminal opens in a window of its own -- and both are for
// administrators only, which the manager's gate enforces again.
//
// Neither is `required`: a CloudPanel release that moves either anchor should
// cost the link, not stop the addon from being enabled. Addons → Terminal
// opens every site either way.

import type { AddonTarget } from "../../../lib/addon-target";
import { ROW_ACTION_CLASS } from "../../../lib/row-actions";
import { OPEN_JS } from "../app/views";

import STYLE from "./links.css" with { type: "text" };
import LINKS_JS from "./links.client.js" with { type: "text" };
import { ANCHORS, TEMPLATES } from "../../../lib/panel-anchors";
import { rootShellLink, rootShellScript } from "../../../lib/root-shell";
import HEADER_STYLE from "./header.css" with { type: "text" };

const ADMIN = "{% if is_granted('ROLE_ADMIN') %}";

function script(url: string): string {
  return `
          <style>${STYLE}</style>
          <script>${`${OPEN_JS}${LINKS_JS}`.split("ADDON_URL").join(url)}</script>`;
}

export const TERMINAL_TARGETS: AddonTarget[] = [
  {
    slug: "sites-script",
    template: TEMPLATES.sites,
    anchorBefore: ANCHORS.sitesTable,
    required: false,
    snippet: (url) => `
        ${ADMIN}${script(url)}
        {% endif %}`,
  },
  {
    slug: "sites-action",
    template: TEMPLATES.sites,
    anchorBefore: ANCHORS.siteManageLink,
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
    template: TEMPLATES.siteTabs,
    anchorAfter: "  </ul>",
    required: false,
    snippet: (url) => `
        ${ADMIN}
          <a href="${url}/sites/{{ site.domainName|url_encode }}" class="clp-terminal-open clp-terminal-tab" data-clp-domain="{{ site.domainName }}" title="Open a shell as this site's user" aria-label="Terminal"><span aria-hidden="true">&gt;_</span><span class="clp-terminal-label">Terminal</span></a>${script(url)}
        {% endif %}`,
  },
  // Just before the account menu, in the main header beside Admin Area and in
  // the Admin Area's own beside notifications. Hidden until root's answer says
  // this administrator may open one.
  ...[TEMPLATES.header, TEMPLATES.adminHeader].map((template, index): AddonTarget => ({
    slug: index === 0 ? "root-shell" : "root-shell-admin",
    template,
    anchorBefore: '<li class="user-avatar">',
    required: false,
    snippet: (url) => `
        ${ADMIN}
        <li class="clp-root-shell" data-clp-root-shell style="display: none;">${rootShellLink(url, "", '<span class="clp-root-shell-label">Root terminal</span>')}<style>${HEADER_STYLE}</style><script>${rootShellScript(url)}</script></li>
        {% endif %}`,
  })),
];

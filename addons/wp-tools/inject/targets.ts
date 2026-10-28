// What the WordPress Tools addon adds to CloudPanel's own pages: a WP Login link
// in each Sites row and, at the top of every site page, a domain that signs in
// -- or, with that switched off, a WP Login link beside the panel's own.
//
// The Sites page takes two blocks, because it has two places for them. The link
// belongs in the action cell, which is inside the template's
// `{% for site in sites %}` loop, so anything put there is emitted once per row
// -- the condition can be Twig, and the script cannot. The script and its rules
// go above the table instead, where they are emitted once.
//
// The site pages' Domain box is a partial rendered once per page, so its link
// carries the script and rule with it. Which link it is depends on a setting,
// read when the templates are rendered; the addon's page renders them again
// when it changes.
//
// No block asks for ROLE_ADMIN. CloudPanel lists and opens for a `ROLE_USER`
// only the sites `user_sites` maps to their account, so the sites a
// non-administrator sees are already theirs, and the sign-in route checks that again as root
// rather than trusting the page it was clicked on.
//
// None is `required`: a CloudPanel release that renames the sites card, the
// Manage link or the Domain box should cost the link, not stop the addon from
// being enabled. The addon's own page signs in to the same sites either way.

import type { AddonTarget } from "../../../lib/addon-target";
import { ROW_ACTION_CLASS } from "../../../lib/row-actions";
import { DEFAULT_WP_TOOLS_PATHS, WORDPRESS_APPLICATIONS } from "../action";
import { DEFAULT_DOMAIN_LINK, readDomainLink } from "../domain-link";

const WORDPRESS = `{% if site.application in [${WORDPRESS_APPLICATIONS.map((name) => `'${name}'`).join(", ")}] %}`;

import STYLE from "./links.css" with { type: "text" };

// Written for the panel's pages, not for an addon page: no shared client code
// reaches here, so this is plain ES5 with its own fetch. It reads nothing out
// of the document but the domain the template wrote into the link.
import SCRIPT from "./links.client.js" with { type: "text" };

function script(url: string): string {
  return `
          <style>${STYLE}</style>
          <script>${SCRIPT.split("ADDON_URL").join(url)}</script>`;
}

// CloudPanel's own external-link icon, from the Domain link beside it.
const EXTERNAL_ICON = '<svg width="12" height="12" aria-hidden="true" focusable="false" data-prefix="fal" data-icon="external-link" role="img" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path d="M440,256H424a8,8,0,0,0-8,8V464a16,16,0,0,1-16,16H48a16,16,0,0,1-16-16V112A16,16,0,0,1,48,96H248a8,8,0,0,0,8-8V72a8,8,0,0,0-8-8H48A48,48,0,0,0,0,112V464a48,48,0,0,0,48,48H400a48,48,0,0,0,48-48V264A8,8,0,0,0,440,256ZM500,0,364,.34a12,12,0,0,0-12,12v10a12,12,0,0,0,12,12L454,34l.7.71L131.51,357.86a12,12,0,0,0,0,17l5.66,5.66a12,12,0,0,0,17,0L477.29,57.34l.71.7-.34,90a12,12,0,0,0,12,12h10a12,12,0,0,0,12-12L512,12A12,12,0,0,0,500,0Z"></path></svg>';

const TITLE = "Sign in to WordPress as its first administrator";

/**
 * The Domain box's addition.
 *
 * Signing in from the domain puts a link of our own in place of the panel's,
 * which a rule hides: the panel's markup is matched, never rewritten. Ours
 * keeps the site's address, so a Ctrl-, Cmd- or middle-click -- which the
 * script leaves to the browser -- still opens the site in a new tab.
 */
export function siteInfoSnippet(url: string, signIn: boolean): string {
  const link = signIn
    ? `<a href="https://{{ site.domainName }}" class="clp-wp-tools clp-wp-tools-domain view-site-link" data-clp-domain="{{ site.domainName }}" title="${TITLE}. Ctrl-click opens the site.">{{ site.domainName }} ${EXTERNAL_ICON}</a>
          <style>.site-info-value > a.view-site-link:not(.clp-wp-tools) { display: none; }</style>`
    : `<a href="#" class="clp-wp-tools view-site-link" data-clp-domain="{{ site.domainName }}" title="${TITLE}">WP Login ${EXTERNAL_ICON}</a>`;
  return `
        ${WORDPRESS}
          ${link}${script(url)}
        {% endif %}`;
}

/** Root work, at render time; an unreadable setting is the default. */
function storedSignIn(): boolean {
  try {
    return readDomainLink(DEFAULT_WP_TOOLS_PATHS.domainLinkState).signIn;
  } catch {
    return DEFAULT_DOMAIN_LINK.signIn;
  }
}

export const WP_TOOLS_TARGETS: AddonTarget[] = [
  {
    slug: "sites-script",
    template: "Frontend/Site/index.html.twig",
    anchorBefore: '<div class="card card-table">',
    required: false,
    snippet: script,
  },
  {
    slug: "sites-action",
    template: "Frontend/Site/index.html.twig",
    anchorBefore: `<a href="{{ path('clp_site', {'domainName': site.domainName}) }}">{% trans %}Manage{% endtrans %}</a>`,
    required: false,
    snippet: () => `
        ${WORDPRESS}
          <a href="#" class="clp-wp-tools ${ROW_ACTION_CLASS}" data-clp-domain="{{ site.domainName }}" title="${TITLE}">WP Login</a>
        {% endif %}`,
  },
  {
    // The end of the Domain link, the only icon in the partial.
    slug: "site-info-link",
    template: "Frontend/Site/Partial/site-info.html.twig",
    anchorAfter: "</svg>\n      </a>",
    required: false,
    snippet: (url) => siteInfoSnippet(url, storedSignIn()),
  },
];

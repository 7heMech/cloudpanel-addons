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
// when it changes. Those pages give Twig a site without its application, so the
// link is drawn hidden on every PHP site and the script shows it once the addon
// says the site is a WordPress.
//
// No block asks for ROLE_ADMIN. CloudPanel lists and opens for a `ROLE_USER`
// only the sites `user_sites` maps to their account, so the sites a
// non-administrator sees are already theirs, and the sign-in route checks that again as root
// rather than trusting the page it was clicked on.
//
// The New WordPress Site form gets a Plugins row, and the page a new site
// lands on says how they were installed. Unlike the links, both are for
// administrators, and for site managers only while an administrator allows it
// -- a setting read at render time, like the domain link's -- and the upload
// control is an administrator's whatever it says: see "Plugins for a new site"
// in docs/decisions/wp-tools.md.
//
// None is `required`: a CloudPanel release that renames the sites card, the
// Manage link or the Domain box should cost the link, not stop the addon from
// being enabled. The addon's own page signs in to the same sites either way.

import type { AddonTarget } from "../../../lib/addon-target";
import { ROW_ACTION_CLASS } from "../../../lib/row-actions";
import { DEFAULT_WP_TOOLS_PATHS, WORDPRESS_APPLICATIONS } from "../action";
import { DEFAULT_DOMAIN_LINK, readDomainLink } from "../domain-link";
import { DEFAULT_NEW_SITE_ACCESS, readNewSiteAccess } from "../new-site-access";

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
 * which a rule hides once the script has shown ours: the panel's markup is
 * matched, never rewritten. The two look the same, so the swap does not show.
 * Ours keeps the site's address, so a Ctrl-, Cmd- or middle-click -- which the
 * script leaves to the browser -- still opens the site in a new tab.
 */
export function siteInfoSnippet(url: string, signIn: boolean): string {
  const link = signIn
    ? `<a href="https://{{ site.domainName }}" hidden class="clp-wp-tools clp-wp-tools-domain view-site-link" data-clp-domain="{{ site.domainName }}" data-clp-site-kind title="${TITLE}. Ctrl-click opens the site.">{{ site.domainName }} ${EXTERNAL_ICON}</a>`
    : `<a href="#" hidden class="clp-wp-tools view-site-link" data-clp-domain="{{ site.domainName }}" data-clp-site-kind title="${TITLE}">WP Login ${EXTERNAL_ICON}</a>`;
  return `
        {% if site.type == 'php' %}
          ${link}${script(url)}
        {% endif %}`;
}

import NEW_SITE_STYLE from "./new-site.css" with { type: "text" };
import NEW_SITE_SCRIPT from "./new-site.client.js" with { type: "text" };
import NEW_SITE_DONE_SCRIPT from "./new-site-done.client.js" with { type: "text" };
import { ANCHORS, TEMPLATES } from "../../../lib/panel-anchors";

/** Who the new-site blocks are drawn for. */
function choosers(siteManagers: boolean): string {
  return `{% if is_granted('ROLE_ADMIN')${siteManagers ? " or is_granted('ROLE_SITE_MANAGER')" : ""} %}`;
}

/**
 * The Plugins row, before the form's Back and Create buttons. The inputs have
 * no names, since Symfony refuses a field its form does not declare. The upload
 * control is drawn for administrators only.
 */
export function newSiteFormSnippet(url: string, siteManagers: boolean): string {
  return `
            ${choosers(siteManagers)}
            <div class="row clp-wp-plugins" id="clp-wp-plugins" data-url="${url}">
              <div class="col-12">
                <label class="col-form-label" for="clp-wp-plugin-search">Plugins</label>
                <div class="clp-wp-plugins-bar">
                  <input type="search" class="form-control" id="clp-wp-plugin-search" placeholder="Search WordPress.org plugins" autocomplete="off"
                    role="combobox" aria-expanded="false" aria-controls="clp-wp-plugin-results" aria-describedby="clp-wp-plugins-note">
                  {% if is_granted('ROLE_ADMIN') %}<label class="btn btn-gray clp-wp-plugins-upload">Upload .zip<input type="file" id="clp-wp-plugin-file" accept=".zip,application/zip" multiple></label>{% endif %}
                </div>
                <ul class="clp-wp-plugin-results" id="clp-wp-plugin-results" role="listbox" aria-label="WordPress.org plugins" hidden></ul>
                <ul class="clp-wp-plugin-chosen" id="clp-wp-plugin-chosen" aria-label="Plugins to install" hidden></ul>
                <div class="form-text" id="clp-wp-plugins-note">Installed as the site's own user once WordPress is set up.{% if is_granted('ROLE_ADMIN') %} A zip may be up to 32 MB.{% endif %}</div>
                <div class="alert alert-danger clp-wp-plugins-error" id="clp-wp-plugins-error" role="alert" hidden></div>
              </div>
            </div>
            <style>${NEW_SITE_STYLE}</style>
            <script>${NEW_SITE_SCRIPT}</script>
            {% endif %}`;
}

/**
 * Where a created WordPress site lands, shaped like CloudPanel's flash
 * messages above it. The domain is read as Panel Tweaks' certificate status
 * reads it, from the credentials the panel keeps for this page.
 */
export function newSiteDoneSnippet(url: string, siteManagers: boolean): string {
  return `
      ${choosers(siteManagers)}
      {% set clpWpPluginsSite = (app.session.get('siteCredentials')|default({}))['Site'|trans]|default({}) %}
      {% set clpWpPluginsDomain = (clpWpPluginsSite['Domain Name'|trans]|default(''))|replace({'https://': '', 'http://': ''})|trim('/')|lower %}
      <div class="alert-container" id="clp-wp-plugins-status" data-url="${url}" data-domain="{{ clpWpPluginsDomain }}"{% if is_granted('ROLE_ADMIN') %} data-admin{% endif %} hidden>
        <div class="alert alert-info" role="status"></div>
      </div>
      <style>${NEW_SITE_STYLE}</style>
      <script>${NEW_SITE_DONE_SCRIPT}</script>
      {% endif %}`;
}

/** Root work, at render time; an unreadable setting is the default, off. */
function storedSiteManagers(): boolean {
  try {
    return readNewSiteAccess(DEFAULT_WP_TOOLS_PATHS.newSiteAccessState).siteManagers;
  } catch {
    return DEFAULT_NEW_SITE_ACCESS.siteManagers;
  }
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
    template: TEMPLATES.sites,
    anchorBefore: ANCHORS.sitesTable,
    required: false,
    snippet: script,
  },
  {
    slug: "sites-action",
    template: TEMPLATES.sites,
    anchorBefore: ANCHORS.siteManageLink,
    required: false,
    snippet: () => `
        ${WORDPRESS}
          <a href="#" class="clp-wp-tools ${ROW_ACTION_CLASS}" data-clp-domain="{{ site.domainName }}" title="${TITLE}">WP Login</a>
        {% endif %}`,
  },
  {
    // The end of the Domain link, the only icon in the partial.
    slug: "site-info-link",
    template: TEMPLATES.siteInfo,
    anchorAfter: "</svg>\n      </a>",
    required: false,
    snippet: (url) => siteInfoSnippet(url, storedSignIn()),
  },
  {
    slug: "new-site-plugins",
    template: TEMPLATES.newWordPressSite,
    anchorBefore: ANCHORS.newSiteButtons,
    required: false,
    snippet: (url) => newSiteFormSnippet(url, storedSiteManagers()),
  },
  {
    slug: "new-site-plugins-status",
    template: TEMPLATES.wordPressInstalled,
    anchorBefore: ANCHORS.wordPressInstalledCard,
    required: false,
    snippet: (url) => newSiteDoneSnippet(url, storedSiteManagers()),
  },
];

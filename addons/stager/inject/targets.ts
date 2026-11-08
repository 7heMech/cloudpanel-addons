// These snippets use Twig's `site`, so they are only correct in templates that
// set it as a loop variable; check before adding a target elsewhere.

import type { AddonTarget } from "../../../lib/addon-target";
import { ADDON_SITE_TABS } from "../../../lib/site-context";
import { MENU_ONLY_CLASS, MENU_ONLY_STYLE } from "../../../lib/row-actions";
import { ANCHORS, TEMPLATES } from "../../../lib/panel-anchors";

const TAB_LABEL = ADDON_SITE_TABS.find((tab) => tab.slug === "stager")!.label;

/**
 * Mirrors CLONABLE_TYPES in addons/stager/action.ts as literal `site.type`
 * values, so a Node.js or Python site shows no action that only answers with
 * an error. Twig cannot see whether a reverse proxy fronts an Instatic
 * instance, so the action shows on every reverse proxy and the action refuses
 * the others by name.
 */
const CLONABLE = "{% if site.type in ['php', 'static', 'reverse-proxy'] %}";

export const STAGER_TARGETS: AddonTarget[] = [
  {
    // Shares the Maintenance tab's anchor. anchorAfter snippets go in in
    // reverse addon order, giving Logs, Maintenance, Staging, the order
    // ADDON_SITE_TABS gives the reproduced strip.
    slug: "site-tab",
    template: TEMPLATES.siteTabs,
    anchorAfter: ANCHORS.siteLogsTab,
    required: true,
    snippet: (url) => `
        {% if is_granted('ROLE_ADMIN') %}${CLONABLE}
          <li>
            <a href="${url}?domain={{ site.domainName|url_encode }}">${TAB_LABEL}</a>
          </li>
        {% endif %}{% endif %}`,
  },
  // Cloning is rare, so it is menu-only. The hiding rule is emitted here, not
  // by the addon that draws the menu, so a box without that menu shows it in
  // neither place.
  {
    slug: "site-list-style",
    template: TEMPLATES.sites,
    anchorBefore: ANCHORS.sitesTable,
    required: false,
    snippet: () => `
          {% if is_granted('ROLE_ADMIN') %}
          <style>${MENU_ONLY_STYLE}</style>
          {% endif %}`,
  },
  {
    slug: "site-list-action",
    template: TEMPLATES.sites,
    anchorAfter: ANCHORS.siteManageLink,
    required: false,
    snippet: (url) => `
        {% if is_granted('ROLE_ADMIN') %}${CLONABLE}
          <a class="${MENU_ONLY_CLASS}" href="${url}/new?source={{ site.domainName|url_encode }}">Clone</a>
        {% endif %}{% endif %}`,
  },
];

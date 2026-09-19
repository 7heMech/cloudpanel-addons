import type { AddonTarget } from "../../../lib/addon-target";
import { SITE_TAB_TEMPLATE } from "../../../lib/panel-nav";
import { ADDON_SITE_TABS } from "../../../lib/site-context";

// The label the panel's strip shows and the label the addon's own reproduction
// of that strip shows are the same string, from lib/site-context.
const LABEL = ADDON_SITE_TABS.find((tab) => tab.slug === "git")!.label;

export const GIT_TARGETS: AddonTarget[] = [
  {
    // The anchor the Maintenance and Staging tabs use. The injector applies
    // anchorAfter snippets in reverse addon order, so `git` is inserted last
    // and therefore sits first: Logs, Git, Maintenance, Staging -- the order
    // ADDON_SITE_TABS gives the reproduced strip too.
    slug: "site-tab",
    template: SITE_TAB_TEMPLATE,
    anchorAfter: `      <a href="{{ path('clp_site_logs', {'domainName': site.domainName}) }}">{% trans %}Logs{% endtrans %}</a>
    </li>`,
    required: true,
    snippet: (url) => `
        {% if is_granted('ROLE_ADMIN') %}
          <li>
            <a href="${url}?domain={{ site.domainName|url_encode }}">${LABEL}</a>
          </li>
        {% endif %}`,
  },
  {
    // Beside Stager's Clone, on the same anchor: the fleet is where an operator
    // decides which site to deploy, and CloudPanel's own site list is the fleet
    // page they are already on.
    slug: "site-list-action",
    template: "Frontend/Site/index.html.twig",
    anchorAfter: `<a href="{{ path('clp_site', {'domainName': site.domainName}) }}">{% trans %}Manage{% endtrans %}</a>`,
    required: false,
    snippet: (url) => `
        {% if is_granted('ROLE_ADMIN') %}
          <a href="${url}?domain={{ site.domainName|url_encode }}" style="margin-left: 0.75rem;">Deploy from Git</a>
        {% endif %}`,
  },
];

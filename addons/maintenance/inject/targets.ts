import type { AddonTarget } from "../../../cli/paths";
import { ADDON_SITE_TABS } from "../../../lib/site-context";

// The label the panel's strip shows and the label the addon's own reproduction
// of that strip shows are the same string, from lib/site-context.
const LABEL = ADDON_SITE_TABS.find((tab) => tab.slug === "maintenance")!.label;

export const MAINTENANCE_TARGETS: AddonTarget[] = [
  {
    slug: "site-tab",
    template: "Frontend/Site/Partial/tab-container.html.twig",
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
];

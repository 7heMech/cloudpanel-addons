import type { AddonTarget } from "../../../lib/addon-target";
import { ADDON_SITE_TABS } from "../../../lib/site-context";

// The label the panel's strip shows and the label the addon's own reproduction
// of that strip shows are the same string, from lib/site-context.
const LABEL = ADDON_SITE_TABS.find((tab) => tab.slug === "php-resources")!.label;

// A pool file exists only for a site CloudPanel recorded PHP settings for, and
// `site.type` is what the template can see of that. A static or Node.js site
// gets no tab rather than a tab that could only ever explain itself away.
const HAS_A_POOL = "{% if site.type == 'php' and is_granted('ROLE_ADMIN') %}";

export const PHP_RESOURCES_TARGETS: AddonTarget[] = [
  {
    // The anchor the Maintenance and Stager tabs use. Snippets sharing an
    // anchor are applied in descending addon name, each just after it, so the
    // strip settles on ascending name: Logs, Maintenance, Resources, Staging.
    slug: "site-tab",
    template: "Frontend/Site/Partial/tab-container.html.twig",
    anchorAfter: `      <a href="{{ path('clp_site_logs', {'domainName': site.domainName}) }}">{% trans %}Logs{% endtrans %}</a>
    </li>`,
    required: true,
    snippet: (url) => `
        ${HAS_A_POOL}
          <li>
            <a href="${url}?domain={{ site.domainName|url_encode }}">${LABEL}</a>
          </li>
        {% endif %}`,
  },
];

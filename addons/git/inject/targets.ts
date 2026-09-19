import type { AddonTarget } from "../../../lib/addon-target";
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

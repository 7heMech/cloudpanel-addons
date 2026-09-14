import type { AddonTarget } from "../../../cli/paths";

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
            <a href="${url}?domain={{ site.domainName|url_encode }}">Maintenance</a>
          </li>
        {% endif %}`,
  },
];

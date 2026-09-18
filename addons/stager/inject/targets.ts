// What the Stager addon adds to the CloudPanel UI.
//
// Markup and placement only. The injector in cli/inject.ts owns the markers,
// the pristine snapshot, the hash gate and the ordering, so everything here is
// data.
//
// The snippet is Twig rather than plain HTML, which the Instatic addon's are
// not. That is the point of it: the button has to name the site whose page it
// is rendered on, and `{{ site.domainName }}` is how the template already does
// that. It also means this block is only correct where `site` is in scope --
// the target template sets it as a loop variable, and nothing else may be
// added here without checking.

import type { AddonTarget } from "../../../lib/addon-target";
import { ADDON_SITE_TABS } from "../../../lib/site-context";

// The label the panel's strip shows and the label the addon's own reproduction
// of that strip shows are the same string, from lib/site-context.
const TAB_LABEL = ADDON_SITE_TABS.find((tab) => tab.slug === "stager")!.label;

export const STAGER_TARGETS: AddonTarget[] = [
  {
    // The same anchor the Maintenance addon's tab uses. The injector applies
    // anchorAfter snippets in reverse addon order, so `stager` goes in first
    // and `maintenance` is then inserted ahead of it: Logs, Maintenance,
    // Staging -- which is the order ADDON_SITE_TABS gives the reproduced strip
    // too. It settles on the same file however many times it runs.
    slug: "site-tab",
    template: "Frontend/Site/Partial/tab-container.html.twig",
    anchorAfter: `      <a href="{{ path('clp_site_logs', {'domainName': site.domainName}) }}">{% trans %}Logs{% endtrans %}</a>
    </li>`,
    required: true,
    snippet: (url) => `
        {% if is_granted('ROLE_ADMIN') %}
          <li>
            <a href="${url}?domain={{ site.domainName|url_encode }}">${TAB_LABEL}</a>
          </li>
        {% endif %}`,
  },
];

import type { AddonTarget } from "../../../lib/addon-target";
import { ADDON_SITE_TABS } from "../../../lib/site-context";
import { ANCHORS, TEMPLATES } from "../../../lib/panel-anchors";

// The label the panel's strip shows and the label the addon's own reproduction
// of that strip shows are the same string, from lib/site-context.
const LABEL = ADDON_SITE_TABS.find((tab) => tab.slug === "maintenance")!.label;

export const MAINTENANCE_TARGETS: AddonTarget[] = [
  {
    slug: "site-tab",
    template: TEMPLATES.siteTabs,
    anchorAfter: ANCHORS.siteLogsTab,
    required: true,
    snippet: (url) => `
        {% if is_granted('ROLE_ADMIN') %}
          <li>
            <a href="${url}?domain={{ site.domainName|url_encode }}">${LABEL}</a>
          </li>
        {% endif %}`,
  },
];

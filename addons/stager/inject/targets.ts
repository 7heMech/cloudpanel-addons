// What the Stager addon adds to the CloudPanel UI.
//
// Markup and placement only. The injector in cli/inject.ts owns the markers,
// the pristine snapshot, the hash gate and the ordering, so everything here is
// data.
//
// Both snippets are Twig rather than plain HTML, which the Instatic addon's are
// not. That is the point of them: the button has to name the site whose page it
// is rendered on, and `{{ site.domainName }}` is how the template already does
// that. It also means these blocks are only correct where `site` is in scope --
// both target templates that either receive it as an include parameter or set
// it as a loop variable, and nothing else may be added here without checking.

import type { AddonTarget } from "../../../cli/paths";

/**
 * The site types the wrapper will clone, guarded here too so a Node.js or
 * Python site does not show a button that only ever answers with an error.
 * These are the literal `site.type` column values, and they must stay in step
 * with CLONABLE_TYPES in the wrapper -- which is the thing that actually
 * decides, and which this only mirrors.
 *
 * A reverse-proxy site is clonable only when its backend is an Instatic
 * instance this box manages, and Twig cannot see that: the fact lives in the
 * Instatic addon's own records. So the button appears on every reverse proxy
 * and the wrapper refuses the ones that are not, by name. Showing it and
 * explaining the refusal is better than the alternative, which would be
 * teaching the panel's templates about another addon's state directory.
 */
const CLONABLE = "{% if site.type in ['php', 'static', 'reverse-proxy'] %}";

export const STAGER_TARGETS: AddonTarget[] = [
  {
    slug: "site-tab",
    template: "Frontend/Site/Partial/tab-container.html.twig",
    // The last tab in the row, so the panel's own order is untouched. This
    // partial is included by every per-site page, which is what puts the button
    // on each site rather than on one page listing them.
    anchorAfter: `      <a href="{{ path('clp_site_logs', {'domainName': site.domainName}) }}">{% trans %}Logs{% endtrans %}</a>
    </li>`,
    required: true,
    snippet: (url) => `
        ${CLONABLE}
          <li>
            <a href="${url}/new?source={{ site.domainName|url_encode }}" target="_blank" rel="noopener">Staging</a>
          </li>
        {% endif %}`,
  },
  {
    slug: "site-list-action",
    template: "Frontend/Site/index.html.twig",
    anchorAfter: `<a href="{{ path('clp_site', {'domainName': site.domainName}) }}">{% trans %}Manage{% endtrans %}</a>`,
    required: false,
    snippet: (url) => `
        ${CLONABLE}
          <a href="${url}/new?source={{ site.domainName|url_encode }}" target="_blank" rel="noopener" style="margin-left: 0.75rem;">Clone</a>
        {% endif %}`,
  },
];

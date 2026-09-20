import type { AddonTarget } from "../../../lib/addon-target";
import { SITE_TAB_TEMPLATE } from "../../../lib/panel-nav";
import { ROW_ACTION_CLASS } from "../../../lib/row-actions";
import { ADDON_SITE_TABS } from "../../../lib/site-context";

// The label the panel's strip shows and the label the addon's own reproduction
// of that strip shows are the same string, from lib/site-context.
//
// Both roles are named in every condition rather than relying on CloudPanel's
// role hierarchy, which this addon does not own: a site manager reaches these
// pages because the manager's gate lets that role into this addon's mount.
const LABEL = ADDON_SITE_TABS.find((tab) => tab.slug === "git")!.label;

/** CloudPanel's own site list, which this addon adds a row action to. */
const SITE_LIST_TEMPLATE = "Frontend/Site/index.html.twig";

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
        {% if is_granted('ROLE_ADMIN') or is_granted('ROLE_SITE_MANAGER') %}
          <li>
            <a href="${url}?domain={{ site.domainName|url_encode }}">${LABEL}</a>
          </li>
        {% endif %}`,
  },
  {
    // Left of the panel's own Manage, which keeps the rightmost place: the
    // fleet is where an operator decides which site to deploy, and CloudPanel's
    // own site list is the fleet page they are already on.
    //
    // Hidden as it is rendered. Whether a site has a repository is in this
    // addon's own record, which Twig cannot see, so the row offers the link
    // only once the script below has said which sites deploy, and drops it
    // from the rows that do not.
    slug: "site-list-action",
    template: SITE_LIST_TEMPLATE,
    anchorBefore: `<a href="{{ path('clp_site', {'domainName': site.domainName}) }}">{% trans %}Manage{% endtrans %}</a>`,
    required: false,
    snippet: (url) => `
        {% if is_granted('ROLE_ADMIN') or is_granted('ROLE_SITE_MANAGER') %}
          <a class="clp-addons-git-row ${ROW_ACTION_CLASS}" data-domain="{{ site.domainName }}" hidden
            href="${url}?domain={{ site.domainName|url_encode }}" style="margin-right: 0.75rem; white-space: nowrap;">Deploy from Git</a>
        {% endif %}`,
  },
  {
    // After the table rather than inside the loop, so one page asks once.
    slug: "site-list-script",
    template: SITE_LIST_TEMPLATE,
    anchorAfter: `                </tbody>
              </table>`,
    required: false,
    snippet: (url) => `
              {% if is_granted('ROLE_ADMIN') or is_granted('ROLE_SITE_MANAGER') %}
              <script>
                (function () {
                  var links = document.querySelectorAll('a.clp-addons-git-row[data-domain]');
                  if (!links.length) return;
                  fetch('${url}/api/sites', {
                    credentials: 'same-origin',
                    headers: { Accept: 'application/json' }
                  })
                    .then(function (res) { return res.json(); })
                    .then(function (payload) {
                      var deployed = {};
                      if (payload && payload.ok === true) {
                        (payload.domains || []).forEach(function (domain) { deployed[domain] = true; });
                      }
                      // Removed rather than left hidden: a row's actions may
                      // have been moved into Panel Tweaks' menu by now, and
                      // the menu styles the links inside it back into view.
                      Array.prototype.forEach.call(links, function (link) {
                        if (deployed[(link.dataset.domain || '').toLowerCase()]) link.hidden = false;
                        else link.remove();
                      });
                    })
                    .catch(function () {
                      Array.prototype.forEach.call(links, function (link) { link.remove(); });
                    });
                })();
              </script>
              {% endif %}`,
  },
];

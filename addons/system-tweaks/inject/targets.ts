// What System Tweaks adds to CloudPanel's own Firewall pages: a Protocol field
// after Port Range on the add and edit forms, and a Protocol column after Port
// Range in the rules table. CloudPanel's table has no protocol, so both fill
// themselves from System Tweaks; see "Firewall" in docs/decisions/system-tweaks.md.
//
// None is `required`: a CloudPanel release that reshapes these pages should
// cost the field, not stop System Tweaks from being enabled.

import type { AddonTarget } from "../../../lib/addon-target";
import { TEMPLATES } from "../../../lib/panel-anchors";
import SCRIPT from "./firewall.client.js" with { type: "text" };
import STYLE from "./firewall.css" with { type: "text" };

const PORT_RANGE_FIELD = `              <div class="col-2 {{ (form_errors(form.portRange) ? 'has-error' : '') }}">
                {{ form_label(form.portRange, null, {'label_attr': {'class': 'form-label'}}) }}
                {{ form_widget(form.portRange) }}
              </div>`;

const script = (url: string) => `<style>${STYLE}</style>
              <script>${SCRIPT.split("ADDON_URL").join(url)}</script>`;

// No `name`: Symfony refuses a field its form does not declare, so the choice
// goes to System Tweaks just before the form does.
const formField = (url: string) => `
              <div class="col-2 clp-fw-protocol" id="clp-fw-protocol" data-rule="{{ form.vars.value.id|default('') }}" hidden>
                <label class="form-label" for="clp-fw-protocol-select">Protocol</label>
                <select class="form-select form-select-lg" id="clp-fw-protocol-select">
                  <option value="tcp" selected>TCP</option>
                  <option value="udp">UDP</option>
                  <option value="both">TCP and UDP</option>
                </select>
              </div>
              ${script(url)}`;

export const SYSTEM_TWEAKS_TARGETS: AddonTarget[] = [
  {
    slug: "firewall-add-protocol",
    template: TEMPLATES.firewallAddRule,
    anchorAfter: PORT_RANGE_FIELD,
    required: false,
    snippet: formField,
  },
  {
    slug: "firewall-edit-protocol",
    template: TEMPLATES.firewallEditRule,
    anchorAfter: PORT_RANGE_FIELD,
    required: false,
    snippet: formField,
  },
  {
    slug: "firewall-protocol-heading",
    template: TEMPLATES.firewall,
    anchorAfter: `                  <th>
                    {% trans %}Port Range{% endtrans %}
                  </th>`,
    required: false,
    snippet: () => `
                  <th class="clp-fw-protocol-heading">
                    Protocol
                  </th>`,
  },
  {
    slug: "firewall-protocol-cell",
    template: TEMPLATES.firewall,
    anchorAfter: `                  <td>
                    {{ rule.portRange }}
                  </td>`,
    required: false,
    snippet: () => `
                  <td class="clp-fw-protocol-cell" data-clp-fw-rule="{{ rule.id }}"></td>`,
  },
  {
    slug: "firewall-protocol-script",
    template: TEMPLATES.firewall,
    anchorAfter: `              </tbody>
            </table>`,
    required: false,
    snippet: (url) => `
            ${script(url)}`,
  },
];

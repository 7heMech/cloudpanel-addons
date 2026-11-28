import type { AddonTarget } from "../../../lib/addon-target";
import { NAMESERVER_NOTICE_JS } from "../../../lib/nameserver-notice";
import { TEMPLATES } from "../../../lib/panel-anchors";
import SCRIPT from "./custom-domain.client.js" with { type: "text" };
import STYLE from "./custom-domain.css" with { type: "text" };

const CUSTOM_DOMAIN_INPUT_GROUP = `                <div class="input-group">
                  <span class="input-group-text">https://</span>
                  {{ form_widget(customDomainForm.domainName) }}
                </div>`;

/**
 * Injected after the Custom Domain input group on Admin -> Settings.
 * Keeps zero `name` attributes on every control so Symfony never rejects extra
 * form fields, and renders nothing until DNS reports a Cloudflare connection.
 */
export function customDomainSnippet(addonUrl: string): string {
  return `
                <div class="clp-dns-cd" data-clp-dns-custom-domain data-url="${addonUrl}" hidden></div>
                <style>${STYLE}</style>
                <script>${NAMESERVER_NOTICE_JS}\n${SCRIPT}</script>`;
}

export const CUSTOM_DOMAIN_TARGET: AddonTarget = {
  slug: "custom-domain-dns",
  template: TEMPLATES.adminSettings,
  anchorAfter: CUSTOM_DOMAIN_INPUT_GROUP,
  // A panel release that reshapes Admin -> Settings costs the helper, not the addon.
  required: false,
  snippet: customDomainSnippet,
};

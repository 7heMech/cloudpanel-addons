import type { AddonTarget } from "../../../lib/addon-target";
import { NAMESERVER_NOTICE_JS } from "../../../lib/nameserver-notice";
import SCRIPT from "./nameservers.client.js" with { type: "text" };

/** Above the certificates card, where flash messages also sit, on every site's SSL/TLS tab. */
export function nameserversSnippet(addonUrl: string): string {
  return `
        <div data-clp-dns-site data-status-url="${addonUrl}/api/site?domain={{ site.domainName|url_encode }}"></div>
        <script>${NAMESERVER_NOTICE_JS}\n${SCRIPT}</script>`;
}

export const DNS_TARGETS: AddonTarget[] = [{
  slug: "site-nameservers",
  template: "Frontend/Site/certificates.html.twig",
  anchorBefore: '<div class="card card-table">',
  // A panel release that changes this card costs the notice, not the addon.
  required: false,
  snippet: nameserversSnippet,
}];

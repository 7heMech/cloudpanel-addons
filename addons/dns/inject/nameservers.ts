import type { AddonTarget } from "../../../lib/addon-target";
import SCRIPT from "./nameservers.client.js" with { type: "text" };

const STYLE = `.clp-dns-nameservers { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.clp-dns-nameservers .btn { display: inline-flex; align-items: center; gap: 10px; max-width: 100%; }
.clp-dns-nameservers code { color: inherit; font-size: 14px; overflow-wrap: anywhere; }
.clp-dns-nameservers span { color: #0078d4; font-size: 13px; }`;

/** Above the certificates card, where flash messages also sit, on every site's SSL/TLS tab. */
export function nameserversSnippet(addonUrl: string): string {
  return `
        <div data-clp-dns-site data-status-url="${addonUrl}/api/site?domain={{ site.domainName|url_encode }}"><style>${STYLE}</style></div>
        <script>${SCRIPT}</script>`;
}

export const DNS_TARGETS: AddonTarget[] = [{
  slug: "site-nameservers",
  template: "Frontend/Site/certificates.html.twig",
  anchorBefore: '<div class="card card-table">',
  // A panel release that changes this card costs the notice, not the addon.
  required: false,
  snippet: nameserversSnippet,
}];

import type { AddonTarget } from "../../../lib/addon-target";
import SCRIPT from "./nameservers.client.js" with { type: "text" };

const STYLE = `.clp-dns-nameservers { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 10px; }
.clp-dns-nameservers code { padding: 4px 8px; border-radius: 4px; background: rgba(0,0,0,.06); color: inherit; font-size: 14px; }
html.dark .clp-dns-nameservers code { background: rgba(255,255,255,.08); }`;

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

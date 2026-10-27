import type { AddonTarget } from "../../../lib/addon-target";
import { CLIPBOARD } from "../clipboard";
import SCRIPT from "./nameservers.client.js" with { type: "text" };

const STYLE = `.clp-dns-nameservers { margin-top: 10px; }
.clp-dns-nameservers > div { display: flex; align-items: center; gap: 4px; }
.clp-dns-nameservers code { color: inherit; font-size: 14px; overflow-wrap: anywhere; }
.clp-dns-nameservers button { display: inline-flex; padding: 4px; border: 0; border-radius: 4px; background: none;
  color: inherit; opacity: .65; cursor: pointer; }
.clp-dns-nameservers button:hover, .clp-dns-nameservers button:focus-visible { opacity: 1; background: rgba(0,0,0,.06); }
.clp-dns-nameservers button.copied { color: #198754; opacity: 1; }`;

/** Above the certificates card, where flash messages also sit, on every site's SSL/TLS tab. */
export function nameserversSnippet(addonUrl: string): string {
  return `
        <div data-clp-dns-site data-status-url="${addonUrl}/api/site?domain={{ site.domainName|url_encode }}"
          data-clipboard="${CLIPBOARD.replaceAll('"', "&quot;")}"><style>${STYLE}</style></div>
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

import type { AddonTarget } from "../../../lib/addon-target";
import SCRIPT from "./ssl.client.js" with { type: "text" };

export const NATIVE_SSL_TYPES = ["wordpress", "php", "static", "nodejs", "python", "reverse-proxy"] as const;

/** The domains whose creation form was submitted with the option checked. */
const PENDING = `{% set clpSslPending = (app.request.cookies.get('__Host-clp_addons_ssl') ?? '')|split(' ') %}`;

/** No name: Symfony rejects a field its form does not declare. */
export function sslFormSnippet(on: boolean): string {
  return on ? `
            <div class="row">
              <div class="col-12">
                <div class="form-check">
                  <input class="form-check-input" type="checkbox" id="clp-auto-ssl" checked aria-describedby="clp-auto-ssl-note">
                  <label class="form-check-label" for="clp-auto-ssl">Install a Let's Encrypt certificate after creation</label>
                </div>
                <div class="form-text" id="clp-auto-ssl-note">For this domain name only. Its DNS must point to this server.</div>
              </div>
            </div>
            <script>${SCRIPT}</script>` : "";
}

/** Shaped like CloudPanel's flash messages, which sit directly above it. */
function status(domain: string): string {
  return `
      <div class="alert-container" data-clp-auto-ssl="{{ ${domain} }}"
        data-certificates-url="{{ path('clp_site_certificates', {'domainName': ${domain}}) }}"
        data-issue-url="{{ path('clp_site_lets_encrypt_certificate_new', {'domainName': ${domain}}) }}">
        <div class="alert alert-info" role="status">Installing a Let's Encrypt certificate for {{ ${domain} }}…</div>
      </div>`;
}

/** Where the five other native creators redirect. Only a new site still on its self-signed placeholder qualifies. */
export function sslSitesSnippet(on: boolean): string {
  return on ? `
      ${PENDING}
      {% for clpSslSite in sites|filter(site => site.domainName|lower in clpSslPending and site.certificate
        and site.certificate.type == constant('App\\\\Entity\\\\Certificate::TYPE_SELF_SIGNED')) %}${status("clpSslSite.domainName")}
      {% endfor %}
      <script>${SCRIPT}</script>` : "";
}

/** WordPress's credentials page, reached only from a creation that succeeded. */
export function sslWordPressSnippet(on: boolean): string {
  return on ? `
      ${PENDING}
      {% set clpSslSite = (app.session.get('siteCredentials')|default({}))['Site'|trans]|default({}) %}
      {% set clpSslDomain = (clpSslSite['Domain Name'|trans]|default(''))|replace({'https://': ''})|lower %}
      {% if clpSslDomain and clpSslDomain in clpSslPending %}${status("clpSslDomain")}
      <script>${SCRIPT}</script>
      {% endif %}` : "";
}

export function sslTargets(enabled: () => boolean): AddonTarget[] {
  return [
    ...NATIVE_SSL_TYPES.map((type) => ({
      slug: `${type}-ssl-option`,
      template: `Frontend/Site/New/${type}.html.twig`,
      anchorBefore: '            <div class="row">\n              <div class="col-6 text-start">',
      required: false,
      snippet: () => sslFormSnippet(enabled()),
    })),
    {
      slug: "sites-ssl",
      template: "Frontend/Site/index.html.twig",
      anchorBefore: '<div class="card card-table">',
      required: false,
      snippet: () => sslSitesSnippet(enabled()),
    },
    {
      slug: "wordpress-ssl",
      template: "Frontend/Site/New/wordpress-installed.html.twig",
      anchorBefore: '      <div class="card">',
      required: false,
      snippet: () => sslWordPressSnippet(enabled()),
    },
  ];
}

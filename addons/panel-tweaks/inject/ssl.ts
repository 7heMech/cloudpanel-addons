import type { AddonTarget } from "../../../lib/addon-target";
import FORM_SCRIPT from "./ssl-form.client.js" with { type: "text" };
import COMPLETE_SCRIPT from "./ssl-complete.client.js" with { type: "text" };

/** No name: this is a browser choice, not an extra Symfony form field. */
export function sslFormSnippet(on: boolean): string {
  return on ? `
          <div class="row">
            <div class="col-12">
              <div class="form-check">
                <input class="form-check-input" type="checkbox" id="clp-auto-ssl" checked aria-describedby="clp-auto-ssl-note">
                <label class="form-check-label" for="clp-auto-ssl">Install a Let's Encrypt SSL certificate after creation</label>
              </div>
              <div class="form-text" id="clp-auto-ssl-note">For the entered hostname only. Its DNS must point to this server and HTTP must be reachable.</div>
              <div class="form-text" id="clp-auto-ssl-error" role="alert" hidden></div>
            </div>
          </div>
          <script>${FORM_SCRIPT}</script>` : "";
}

export function sslCompleteSnippet(on: boolean): string {
  return on ? `
      {% set clpSslSite = (app.session.get('siteCredentials')|default({}))['Site'|trans]|default({}) %}
      {% set clpSslDomain = (clpSslSite['Domain Name'|trans]|default(''))|replace({'https://': ''}) %}
      {% if clpSslDomain %}
      <div id="clp-auto-ssl-result" class="alert" role="status" aria-live="polite" hidden
        data-domain="{{ clpSslDomain }}"
        data-certificates-url="{{ path('clp_site_certificates', {'domainName': clpSslDomain}) }}"
        data-issue-url="{{ path('clp_site_lets_encrypt_certificate_new', {'domainName': clpSslDomain}) }}">
        <span id="clp-auto-ssl-message"></span>
        <a href="{{ path('clp_site_certificates', {'domainName': clpSslDomain}) }}">SSL certificates</a>
      </div>
      <script>${COMPLETE_SCRIPT}</script>
      {% endif %}` : "";
}

/** Machine-readable installed state; no translated success-message guessing. */
export function sslCertificateSnippet(on: boolean): string {
  return on ? `<span id="clp-auto-ssl-certificate" hidden data-domain="{{ site.domainName }}"
    data-type="{{ installedCertificate ? installedCertificate.type : '' }}"></span>` : "";
}

export function sslTargets(enabled: () => boolean): AddonTarget[] {
  return [
    {
      slug: "wordpress-ssl-option",
      template: "Frontend/Site/New/wordpress.html.twig",
      anchorBefore: '            <div class="pre-install-container">',
      required: false,
      snippet: () => sslFormSnippet(enabled()),
    },
    {
      slug: "wordpress-ssl-complete",
      template: "Frontend/Site/New/wordpress-installed.html.twig",
      anchorBefore: '      <div class="card">',
      required: false,
      snippet: () => sslCompleteSnippet(enabled()),
    },
    {
      slug: "ssl-installed-state",
      template: "Frontend/Site/certificates.html.twig",
      anchorBefore: '      <div class="site-content">',
      required: false,
      snippet: () => sslCertificateSnippet(enabled()),
    },
  ];
}

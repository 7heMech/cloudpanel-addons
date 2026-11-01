// CloudPanel's own templates the addons patch, and the lines in them that more
// than one addon anchors to. A CloudPanel release that moves one of these moves
// every addon's block with it, so each is written once. An anchor only one
// addon uses stays beside its target.

export const TEMPLATES = {
  login: "Frontend/Login/login.html.twig",
  loginLayout: "Frontend/Login/layout.html.twig",
  header: "Frontend/Partial/header.html.twig",
  adminHeader: "Admin/Partial/header.html.twig",
  accountSecurity: "Frontend/User/Account/security.html.twig",
  sites: "Frontend/Site/index.html.twig",
  siteTabs: "Frontend/Site/Partial/tab-container.html.twig",
  siteInfo: "Frontend/Site/Partial/site-info.html.twig",
  siteSettings: "Frontend/Site/settings.html.twig",
  siteCertificates: "Frontend/Site/certificates.html.twig",
  newSite: "Frontend/Site/New/index.html.twig",
  newWordPressSite: "Frontend/Site/New/wordpress.html.twig",
  wordPressInstalled: "Frontend/Site/New/wordpress-installed.html.twig",
} as const;

export const ANCHORS = {
  /** The card around the Sites table. */
  sitesTable: '<div class="card card-table">',
  /** A Sites row's Manage link, the last of its actions. */
  siteManageLink: `<a href="{{ path('clp_site', {'domainName': site.domainName}) }}">{% trans %}Manage{% endtrans %}</a>`,
  /** The Logs tab, the last of a site's own tabs. */
  siteLogsTab: `      <a href="{{ path('clp_site_logs', {'domainName': site.domainName}) }}">{% trans %}Logs{% endtrans %}</a>
    </li>`,
  /** The row holding a new-site form's buttons. */
  newSiteButtons: '            <div class="row">\n              <div class="col-6 text-start">',
  /** The first card on the page a new WordPress site lands on. */
  wordPressInstalledCard: '      <div class="card">',
} as const;

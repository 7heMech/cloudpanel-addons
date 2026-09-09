import type { AddonTarget } from "../cli/paths";

/** Keep native navigation first; adjacent addon links share one separator. */
export function headerTarget(label: string): AddonTarget {
  return {
    slug: "header-nav",
    template: "Frontend/Partial/header.html.twig",
    anchorAfter: `<a href="{{ path('clp_sites') }}" title="{% trans %}Sites{% endtrans %}">{% trans %}Sites{% endtrans %}</a>`,
    required: true,
    snippet: (url) => `
      <style>
        /* 20px on either side of the divider, plus the native 15px link padding. */
        .header .nav-link-container .clp-addon-nav { display:inline-block; border-left:1px solid var(--clp-border-color, #eaeaea); padding-left:35px; margin-left:20px; }
        .header .nav-link-container .clp-addon-nav ~ .clp-addon-nav { border-left:0; padding-left:0; margin-left:0; }
      </style>
      <a href="${url}" class="clp-addon-nav" target="_blank" rel="noopener" title="${label}">${label}</a>`,
  };
}

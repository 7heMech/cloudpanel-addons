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
        /* Keep the native 10px margin + 15px padding after the divider, with an extra 20px gap on both sides. */
        .header .nav-link-container .clp-addon-nav { display:inline-block; border-left:1px solid var(--clp-border-color, #eaeaea); padding-left:45px; margin-left:20px; }
        .header .nav-link-container .clp-addon-nav ~ .clp-addon-nav { border-left:0; padding-left:15px; margin-left:10px; }
      </style>
      <a href="${url}" class="clp-addon-nav" target="_blank" rel="noopener" title="${label}">${label}</a>`,
  };
}

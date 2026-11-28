import type { AddonTarget } from "../../../lib/addon-target";
import { ANCHORS } from "../../../lib/panel-anchors";
import SCRIPT from "./create-site.client.js" with { type: "text" };
import STYLE from "./create-site.css" with { type: "text" };

export const NATIVE_SITE_TYPES = ["wordpress", "php", "static", "nodejs", "python", "reverse-proxy"] as const;

/**
 * Injected before the Create button row on CloudPanel's six native Create Site
 * forms, restricted to administrators via Twig. Only informs: keeps zero `name`
 * attributes so Symfony never rejects undeclared fields, and never intercepts
 * form submission.
 */
export function createSiteRedirectSnippet(addonUrl: string): string {
  return `
            {% if is_granted('ROLE_ADMIN') %}
            <div class="clp-redir-cs" data-clp-redirects-create-site data-url="${addonUrl}" hidden></div>
            <style>${STYLE}</style>
            <script>${SCRIPT}</script>
            {% endif %}`;
}

export const CREATE_SITE_TARGETS: AddonTarget[] = NATIVE_SITE_TYPES.map((type) => ({
  slug: `${type}-redirect-replace`,
  template: `Frontend/Site/New/${type}.html.twig`,
  anchorBefore: ANCHORS.newSiteButtons,
  required: false,
  snippet: createSiteRedirectSnippet,
}));

// What the Instatic addon adds to the CloudPanel UI.
//
// Markup and placement only. The injector in cli/inject.ts owns the markers,
// the pristine snapshot, the hash gate and the ordering, so everything here is
// data: a second addon is this file plus a registry entry, not a second copy of
// the patching machinery.

import type { AddonTarget } from "../../../cli/paths";

export const INSTATIC_TARGETS: AddonTarget[] = [
  {
    slug: "header-nav",
    template: "Frontend/Partial/header.html.twig",
    anchorAfter: '<div class="nav-link-container w-100">',
    required: true,
    snippet: (url) => `
        <a href="${url}" class="nav-link" target="_blank" rel="noopener">Instatic</a>`,
  },
  {
    slug: "new-site-card",
    template: "Frontend/Site/New/index.html.twig",
    anchorAfter: '<div class="site-type-container">',
    required: false,
    snippet: (url) => `
          <div class="application">
            <div class="application-image">
              <svg width="160" height="160" viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
                <rect width="160" height="160" rx="24" fill="#0f172a"/>
                <path d="M40 45h80v14H40zm0 28h80v14H40zm0 28h55v14H40z" fill="#38bdf8"/>
                <circle cx="115" cy="108" r="7" fill="#f43f5e"/>
              </svg>
            </div>
            <div class="deploy-application-container">
              <a href="${url}/new" class="btn btn-white" target="_blank" rel="noopener">Instatic Site</a>
            </div>
          </div>`,
  },
];

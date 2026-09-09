// What the Instatic addon adds to the CloudPanel UI.
//
// Markup and placement only. The injector in cli/inject.ts owns the markers,
// the pristine snapshot, the hash gate and the ordering, so everything here is
// data: a second addon is this file plus a registry entry, not a second copy of
// the patching machinery.

import type { AddonTarget } from "../../../cli/paths";
import { headerTarget } from "../../../lib/panel-nav";

export const INSTATIC_TARGETS: AddonTarget[] = [
  headerTarget("Instatic"),
  {
    slug: "new-site-card",
    template: "Frontend/Site/New/index.html.twig",
    anchorAfter: '<div class="site-type-container">',
    required: false,
    snippet: (url) => `
          <div class="application">
            <div class="application-image">
              <svg role="img" aria-label="Instatic" width="80" height="80" style="display:block;max-width:100%;max-height:100%;margin:auto" viewBox="0 0 256 256" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect width="256" height="256" fill="white"/>
                <path d="M167.667 207.333V227.167H88.3333V207.333H167.667ZM88.3333 207.333H48.6667V187.5H88.3333V207.333ZM207.333 207.333H167.667V187.5H207.333V207.333ZM48.6667 187.5H28.8333V167.667H48.6667V187.5ZM167.667 187.5H88.3333V167.667H167.667V187.5ZM227.167 187.5H207.333V167.667H227.167V187.5ZM88.3333 167.667H48.6667V147.833H88.3333V167.667ZM207.333 167.667H167.667V147.833H207.333V167.667ZM48.6667 147.833H28.8333V128H48.6667V147.833ZM167.667 48.6667H207.333V68.5H227.167V108.167H207.333V128H167.667V147.833H88.3333V128H48.6667V108.167H28.8333V68.5H48.6667V48.6667H88.3333V28.8333H167.667V48.6667ZM227.167 147.833H207.333V128H227.167V147.833Z" fill="black"/>
                <path d="M0 0h20v20H0zM236 0h20v20h-20zM236 236h20v20h-20zM0 236h20v20H0z" fill="black"/>
              </svg>
            </div>
            <div class="deploy-application-container">
              <a href="${url}/new" class="btn btn-white" target="_blank" rel="noopener">Instatic Site</a>
            </div>
          </div>`,
  },
];

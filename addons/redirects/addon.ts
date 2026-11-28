import type { AddonDefinition } from "../../lib/addon-definition";
import { tryRun } from "../../lib/command";
import { queueAddonPass } from "../../lib/job-store";
import { executeRedirectsAction, runRedirectsAction, type RedirectsActionOptions } from "./action";
import { handle } from "./app/index";
import { CREATE_SITE_TARGETS } from "./inject/create-site";
import { REDIRECTS_ACTIONS } from "./setup";

export const REDIRECTS_ADDON: AddonDefinition = {
  name: "redirects",
  title: "Redirects",
  description: "Forward domains at Cloudflare's edge with Single Redirect rules, or with local stand-in sites.",
  added: "2.3.0-rc.1",
  changed: [
    {
      in: "2.3.0-rc.1",
      note: "Redirect domains and local stand-in sites moved out of DNS into this standalone Redirects addon. A CloudPanel site created at a redirect's domain now replaces the redirect: Redirects removes its Cloudflare rule and stand-in site, at once when Automatic and after review in Ask first. Deleting a redirect always removes its Cloudflare rule, after a review.",
    },
  ],
  targets: CREATE_SITE_TARGETS,
  actionNeeded: REDIRECTS_ACTIONS,
  handler: handle,
  action: runRedirectsAction,
  newSites: {
    label: "Redirects",
    run: async (options) => {
      const { replaced, waiting } = await executeRedirectsAction(["sync-sites"], (options ?? {}) as RedirectsActionOptions) as { replaced: string[]; waiting: string[] };
      return [
        replaced.length ? `removed ${replaced.join(", ")}, replaced by new sites` : "",
        waiting.length ? `${waiting.join(", ")} replaced by new sites once Redirects is Automatic` : "",
      ].filter(Boolean).join("; ") || null;
    },
  },
  withdrawn: () => {
    tryRun("systemctl", ["stop", "clp-addon-redirects-reconcile"]);
  },
  repair: {
    label: "Redirects",
    run: () => {
      queueAddonPass({ addon: "redirects", verb: "reconcile", description: "Check and enforce redirect domains and stand-in sites", runtime: 1800 });
      return null;
    },
  },
};

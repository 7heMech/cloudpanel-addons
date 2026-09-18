import { handle } from "./app/index";
import {
  executeRedirectsAction, runRedirectsAction, type ReconcileResult, type RedirectsActionOptions,
} from "./action";
import { REDIRECTS_TARGETS } from "./inject/targets";
import type { AddonDefinition } from "../../cli/addon-catalog";

export const REDIRECTS_ADDON: AddonDefinition = {
  name: "redirects",
  title: "Redirects",
  description: "Point whole CloudPanel sites at another URL with a 301 or 302, and keep them pointed there.",
  targets: REDIRECTS_TARGETS,
  handler: handle,
  action: runRedirectsAction,
  // CloudPanel regenerates a site's vhost whenever it touches the site, and a
  // certificate install is the one an operator never watches. Repair is where
  // a redirect that went missing is noticed, which is every fifteen minutes.
  maintenance: {
    label: "redirects",
    run: async (options) => {
      const result = await executeRedirectsAction(
        ["reconcile"],
        (options ?? {}) as RedirectsActionOptions,
      ) as ReconcileResult;
      if (result.repaired.length === 0) return null;
      const count = result.repaired.length;
      return `${count} redirect${count === 1 ? "" : "s"} put back (${result.repaired.join(", ")})`;
    },
  },
};

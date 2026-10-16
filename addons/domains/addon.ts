import type { AddonDefinition } from "../../cli/addon-catalog";
import { DOMAINS_RECONCILE_SERVICE } from "../../cli/paths";
import { runCommand } from "../../cli/action-common";
import { executeDomainsAction, runDomainsAction, type DomainsActionOptions } from "./action";
import { handle } from "./app/index";

export const DOMAINS_ADDON: AddonDefinition = {
  name: "domains", title: "DNS & Mail",
  description: "Keep each site's Cloudflare DNS and Mailcow domain correct through shared profiles.",
  targets: [], handler: handle, action: runDomainsAction,
  newSites: { label: "DNS and mail", run: async (options) => { await executeDomainsAction(["sync-sites"], (options ?? {}) as DomainsActionOptions); return null; } },
  maintenance: { label: "DNS and mail", run: () => {
    const result = runCommand("systemctl", ["start", "--no-block", DOMAINS_RECONCILE_SERVICE]);
    if (!result.ok) throw new Error("Could not queue DNS and mail reconciliation");
    return null;
  } },
};

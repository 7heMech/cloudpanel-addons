import type { AddonDefinition } from "../../cli/addon-catalog";
import { runCommand } from "../../cli/action-common";
import { DNS_RECONCILE_SERVICE } from "../../cli/paths";
import { executeDnsAction, runDnsAction, type DnsActionOptions } from "./action";
import { handle } from "./app/index";

export const DNS_ADDON: AddonDefinition = {
  name: "dns",
  title: "DNS",
  description: "Keep each site's Cloudflare DNS to a profile of records, with Mailcow set up for its mail.",
  targets: [],
  handler: handle,
  action: runDnsAction,
  newSites: {
    label: "DNS",
    run: async (options) => {
      const { joined } = await executeDnsAction(["sync-sites"], (options ?? {}) as DnsActionOptions) as { joined: string[] };
      return joined.length ? `${joined.join(", ")} joined the default profile` : null;
    },
  },
  // The check reads and writes Cloudflare and Mailcow, which can take a while
  // for a large fleet, so repair only queues it rather than holding its lock.
  maintenance: {
    label: "DNS",
    run: () => {
      const result = runCommand("systemctl", ["start", "--no-block", DNS_RECONCILE_SERVICE]);
      if (!result.ok) throw new Error(`could not queue ${DNS_RECONCILE_SERVICE}`);
      return null;
    },
  },
};

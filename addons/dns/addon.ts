import type { AddonDefinition } from "../../cli/addon-catalog";
import { queueAddonPass } from "../../cli/job-store";
import { tryRun } from "../../cli/util";
import { executeDnsAction, runDnsAction, type DnsActionOptions } from "./action";
import { handle } from "./app/index";

export const DNS_ADDON: AddonDefinition = {
  name: "dns",
  title: "DNS",
  description: "Keep each site's Cloudflare DNS to a profile of records, with Mailcow set up for its mail.",
  added: "2.0",
  targets: [],
  handler: handle,
  action: runDnsAction,
  withdrawn: () => {
    tryRun("systemctl", ["stop", "clp-addon-dns-reconcile"]);
  },
  newSites: {
    label: "DNS",
    run: async (options) => {
      const { joined } = await executeDnsAction(["sync-sites"], (options ?? {}) as DnsActionOptions) as { joined: string[] };
      return joined.length ? `${joined.join(", ")} joined the default profile` : null;
    },
  },
  maintenance: {
    label: "DNS",
    run: () => {
      queueAddonPass({ addon: "dns", verb: "reconcile", description: "Check and enforce DNS for CloudPanel sites", runtime: 1800 });
      return null;
    },
  },
};

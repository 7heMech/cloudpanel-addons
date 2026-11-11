import type { AddonDefinition } from "../../lib/addon-definition";
import { queueAddonPass } from "../../lib/job-store";
import { tryRun } from "../../lib/command";
import { executeDnsAction, runDnsAction, type DnsActionOptions } from "./action";
import { handle } from "./app/index";
import { DNS_TARGETS } from "./inject/nameservers";

export const DNS_ADDON: AddonDefinition = {
  name: "dns",
  title: "DNS",
  description: "Keep each site's Cloudflare DNS to a profile of records, with Mailcow set up for its mail.",
  added: "2.0.0-rc.1",
  changed: [
    { in: "2.2.0-rc.1", note: "Settings shows the permissions each Cloudflare token is missing. A token made before 2.0.0-rc.10 needs API Tokens: Read added to show them." },
  ],
  targets: DNS_TARGETS,
  handler: handle,
  action: runDnsAction,
  // From the page a new site lands on and from its SSL/TLS page, by whoever
  // can open them; root refuses a site that is not the caller's.
  selfScopedRoutes: ["GET /api/session", "POST /api/provision", "GET /api/site"],
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
  repair: {
    label: "DNS",
    run: () => {
      queueAddonPass({ addon: "dns", verb: "reconcile", description: "Check and enforce DNS for CloudPanel sites", runtime: 1800 });
      return null;
    },
  },
};

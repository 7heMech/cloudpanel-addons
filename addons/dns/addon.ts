import type { AddonDefinition } from "../../lib/addon-definition";
import { queueAddonPass } from "../../lib/job-store";
import { tryRun } from "../../lib/command";
import { executeDnsAction, runDnsAction, type DnsActionOptions } from "./action";
import { handle } from "./app/index";
import { DNS_TARGETS } from "./inject/nameservers";
import { DNS_ACTIONS, DNS_SETUP } from "./setup";

export const DNS_ADDON: AddonDefinition = {
  name: "dns",
  title: "DNS",
  description: "Keep each site's Cloudflare DNS to a profile of records, with Mailcow set up for its mail.",
  added: "2.0.0-rc.1",
  changed: [
    { in: "2.2.0-rc.3", note: "DNS deletes a subdomain site's own A, AAAA and CNAME records once an unobstructed matching wildcard covers the site. New installs' Web preset writes an apex-only *.{domain} wildcard instead of www. Panel hostname offers a random label generator and hands off to a proxied wildcard after the certificate is issued." },
    { in: "2.2.0-rc.1", note: "Panel hostname: DNS points the name you give CloudPanel's custom domain at this server, and proxies it once CloudPanel has its certificate." },
    { in: "2.2.0-rc.1", note: "Each Cloudflare connection shows its token's permissions. A token made before 2.0.0-rc.10 needs API Tokens: Read added in Cloudflare to show them." },
  ],
  targets: DNS_TARGETS,
  setup: DNS_SETUP,
  actionNeeded: DNS_ACTIONS,
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
  certificates: {
    label: "DNS",
    run: async (options) => {
      const { line } = await executeDnsAction(["sync-panel-host"], (options ?? {}) as DnsActionOptions) as { line: string | null };
      return line;
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

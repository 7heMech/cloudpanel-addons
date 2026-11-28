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
  description: "Keep each site's DNS records to a profile across Cloudflare or PowerDNS, with Mailcow set up for its mail.",
  added: "2.0.0-rc.1",
  changed: [
    { in: "2.3.0-rc.1", note: "When Panel Tweaks requests SSL for new sites, a site whose DNS zone was just created now waits for its nameservers (shown to copy) instead of a certificate request that would fail, and with DNS on Automatic, sites made outside Create Site in the last 15 minutes, such as with clpctl, also get their certificate once DNS is ready." },
    { in: "2.3.0-rc.1", note: "CloudPanel's Admin → Settings Custom Domain form now offers a Random hostname button, connected-zone suggestions, and a checkbox to write the DNS record before CloudPanel requests its Let's Encrypt certificate." },
    { in: "2.3.0-rc.1", note: "DNS now supports PowerDNS Authoritative API v1 alongside Cloudflare. Profiles are provider-neutral: Cloudflare-only proxy and zone settings hide when no Cloudflare connection is configured, and redirects on PowerDNS keep local stand-in sites with server A/AAAA records." },
    { in: "2.3.0-rc.1", note: "Cloudflare connections are now shared with Firewall. The Connect Cloudflare dialog lets you create one token covering DNS, Firewall's Panel gate, or both." },
    { in: "2.2.0-rc.3", note: "DNS now splits into Sites, Redirects, Profiles, Settings and Activity tabs (with a first-run card before Cloudflare is connected). Automatic sync lives under Settings, Mailcow and Server addresses fold into disclosures, and saving a Panel hostname requires a Cloudflare connection." },
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

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
  description: "Keep each domain's HTTP and Mail DNS roles in sync across Cloudflare or PowerDNS, with optional Mailcow integration.",
  added: "2.0.0-rc.1",
  changed: [
    { in: "2.3.0-rc.1", note: "DNS profiles now separate a domain's HTTP role (Site, Redirect, or DNS-only) from its independent Mail role (None, Mailcow, Google Workspace, DMARC, or custom record templates). Existing combinatorial profiles such as Web and Mailcow migrate automatically without changing live DNS records, and Mailcow now has its own tab that stays hidden behind a Connect Mailcow card until linked." },
    { in: "2.3.0-rc.1", note: "Cloudflare zone-wide edge settings (SSL/TLS mode, Always Use HTTPS, Let's Encrypt and webmail Full SSL rules, and WAF skip IPs) moved out of DNS profiles into Firewall's Cloudflare edge tab. Existing zone options migrate automatically on upgrade." },
    { in: "2.3.0-rc.1", note: "With Panel Tweaks' automatic SSL on, a new site whose DNS zone was just created now waits for its nameservers (shown to copy) instead of requesting a certificate that would fail. With DNS also on Automatic, self-signed sites made outside Create Site in the last 15 minutes, such as with clpctl, are queued for a certificate request once DNS is ready." },
    { in: "2.3.0-rc.1", note: "Redirect domains and their stand-in sites moved to the standalone Redirects addon, and DNS has no Redirects tab. A redirect domain stays in DNS's Sites table, marked Redirect, so you can still give it a Mail role. Existing redirects, stand-ins, Cloudflare rules and mail profiles migrate automatically on upgrade." },
    { in: "2.3.0-rc.1", note: "CloudPanel's Admin → Settings Custom Domain form now offers a Random hostname button, connected-zone suggestions, and a checkbox to write the DNS record before CloudPanel requests its Let's Encrypt certificate." },
    { in: "2.3.0-rc.1", note: "DNS now supports PowerDNS Authoritative API v1 alongside Cloudflare. Profiles are provider-neutral: Cloudflare-only proxy and zone settings hide when no Cloudflare connection is configured." },
    { in: "2.3.0-rc.1", note: "Cloudflare connections are now shared across DNS, Redirects and Firewall. The Connect Cloudflare dialog lets you create one token covering any combination of those scopes." },
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
      return joined.length ? `${joined.join(", ")} joined the default DNS roles` : null;
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

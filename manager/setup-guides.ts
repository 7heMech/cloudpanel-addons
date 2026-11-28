// Cross-addon procedures shown below Setup's path card. Each entry links two
// or more addons into one concrete workflow so operators can discover how
// newly shipped addons work together without crowding the step paths.
import { ADDONS } from "../addons/catalog";

export interface SetupGuideStep {
  title: string;
  detail: string;
  /** Matching Setup step id when the step lives in Setup, so clicking jumps straight there. */
  stepId?: string;
  /** Fallback or direct addon page link. */
  href: string;
  linkLabel: string;
}

export interface SetupGuide {
  id: string;
  title: string;
  description: string;
  /** Addon catalog keys this workflow connects, in the order they appear. */
  addons: { name: string; title: string }[];
  steps: SetupGuideStep[];
}

function addonRef(name: keyof typeof ADDONS): { name: string; title: string } {
  return { name, title: ADDONS[name]!.title };
}

export const SETUP_GUIDES: SetupGuide[] = [
  {
    id: "cloudflare-edge-lockdown",
    title: "Cloudflare edge lockdown",
    description: "Proxy every site record through Cloudflare, then drop direct hits on the origin.",
    addons: [addonRef("firewall"), addonRef("dns")],
    steps: [
      {
        title: "Connect Cloudflare DNS",
        detail: "Verify a Cloudflare token so DNS can proxy your zones and keep records synced.",
        stepId: "dns-connection",
        href: "/addons/dns/#dns-connection",
        linkLabel: "Go to Connect DNS",
      },
      {
        title: "Confirm every site record is proxied",
        detail: "Check in DNS that every site you plan to lock down has its records proxied through Cloudflare before dropping direct origin traffic.",
        href: "/addons/dns/#sites",
        linkLabel: "Open DNS sites",
      },
      {
        title: "Restrict HTTP and HTTPS to Cloudflare",
        detail: "Allow traffic on ports 80 and 443 from Cloudflare IP ranges only.",
        href: "/addons/firewall/#sites",
        linkLabel: "Open Firewall",
      },
      {
        title: "Put Panel gate in front of CloudPanel",
        detail: "Require Cloudflare Access sign-in on your panel hostname and close direct port 8443.",
        stepId: "panel-gate",
        href: "/addons/firewall/#panel-gate-card",
        linkLabel: "Go to Panel gate",
      },
    ],
  },
  {
    id: "new-wordpress-automation",
    title: "Zero-touch WordPress onboarding",
    description: "New WordPress sites get DNS records, Let's Encrypt SSL, Varnish or MainWP defaults, and outgoing mail automatically.",
    addons: [addonRef("wp-tools"), addonRef("dns"), addonRef("panel-tweaks"), addonRef("smtp")],
    steps: [
      {
        title: "Turn on Automatic DNS records",
        detail: "Write A and AAAA records as soon as CloudPanel creates a site.",
        stepId: "dns-automatic",
        href: "/addons/dns/#dns-mode",
        linkLabel: "Go to Automatic DNS records",
      },
      {
        title: "Enable Certificate at site creation",
        detail: "Request a Let's Encrypt certificate right after each new site finishes creating.",
        stepId: "auto-ssl",
        href: "/addons/panel-tweaks/#pt-sites",
        linkLabel: "Go to Certificate at site creation",
      },
      {
        title: "Configure new-site WordPress defaults",
        detail: "Set automatic CLP Varnish Cache installation and MainWP Child enrollment for new WordPress sites.",
        href: "/addons/wp-tools/#settings",
        linkLabel: "Open WordPress Tools",
      },
      {
        title: "Assign Mail for new sites",
        detail: "Enroll every newly created site into your default outgoing SMTP relay profile.",
        stepId: "smtp-new-sites",
        href: "/addons/smtp/#smtp-profiles",
        linkLabel: "Go to Mail for new sites",
      },
    ],
  },
  {
    id: "staging-clones-live-dns",
    title: "Staging copies with live DNS",
    description: "Clone a production site to a staging subdomain with DNS records written automatically.",
    addons: [addonRef("stager"), addonRef("dns")],
    steps: [
      {
        title: "Enable Automatic DNS records",
        detail: "Allow DNS to write records for staging subdomains as soon as Stager creates the site.",
        stepId: "dns-automatic",
        href: "/addons/dns/#dns-mode",
        linkLabel: "Go to Automatic DNS records",
      },
      {
        title: "Create a staging copy",
        detail: "Clone a WordPress, PHP, static, or Instatic site onto a staging hostname.",
        href: "/addons/stager/new",
        linkLabel: "Open Stager",
      },
      {
        title: "Promote tested changes back to live",
        detail: "Review the staging copy, then push files and database changes back to the production site.",
        href: "/addons/stager/",
        linkLabel: "Open Staging sites",
      },
    ],
  },
];

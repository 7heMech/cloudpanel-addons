/** The public sender policy is separate from the root-only SMTP credentials. */
export interface SmtpSiteRule {
  mode: "force" | "allow";
  /** Used by force mode, and as the fallback when an allowed message has no From. */
  sender: string;
  /** Extra sending domains explicitly granted to this CloudPanel site. */
  domains: string[];
  /** Exact additional addresses, for providers that authorize individual senders. */
  addresses: string[];
}

export interface SmtpRelay {
  host: string;
  port: number;
  username: string;
  password: string;
}

export interface SmtpPolicy {
  version: 1;
  relay: SmtpRelay | null;
  /** A sending domain can use a separate provider and credential. */
  relayOverrides: Record<string, SmtpRelay>;
  defaultRule: SmtpSiteRule;
  siteRules: Record<string, SmtpSiteRule>;
}

export interface SmtpSubmissionSite {
  domain: string;
  uid: number;
  user: string;
  rule: SmtpSiteRule;
}

export interface SmtpSubmissionPolicy {
  version: 1;
  sites: SmtpSubmissionSite[];
}

const DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const ADDRESS = /^[A-Za-z0-9._%+-]+@([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)$/i;

export const DEFAULT_RULE: SmtpSiteRule = {
  mode: "force", sender: "noreply@{domain}", domains: [], addresses: [],
};

export function emptySmtpPolicy(): SmtpPolicy {
  return { version: 1, relay: null, relayOverrides: {}, defaultRule: { ...DEFAULT_RULE }, siteRules: {} };
}

export function smtpDomain(value: unknown): string {
  if (typeof value !== "string") throw new Error("domain must be a hostname");
  const domain = value.toLowerCase().replace(/\.$/, "");
  if (domain.length > 253 || !DOMAIN.test(domain)) throw new Error(`invalid domain: ${value}`);
  return domain;
}

export function smtpAddress(value: unknown): string {
  if (typeof value !== "string" || value.length > 254 || !ADDRESS.test(value)) {
    throw new Error("sender must be a single email address");
  }
  return value.toLowerCase();
}

export function senderFor(template: string, domain: string): string {
  if (typeof template !== "string" || template.length > 254 ||
      template.replaceAll("{domain}", "").includes("{")) {
    throw new Error("sender template may contain only {domain}");
  }
  return smtpAddress(template.replaceAll("{domain}", domain));
}

export function parseRule(value: unknown): SmtpSiteRule {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("sender rule must be an object");
  const rule = value as Record<string, unknown>;
  if (rule.mode !== "force" && rule.mode !== "allow") throw new Error("sender mode must be force or allow");
  if (typeof rule.sender !== "string") throw new Error("sender template is required");
  senderFor(rule.sender, "example.com");
  if (!Array.isArray(rule.domains) || !Array.isArray(rule.addresses) ||
      rule.domains.length > 30 || rule.addresses.length > 100) throw new Error("too many allowed senders");
  return {
    mode: rule.mode,
    sender: rule.sender.toLowerCase(),
    domains: rule.mode === "allow" ? [...new Set(rule.domains.map(smtpDomain))].sort() : [],
    addresses: rule.mode === "allow" ? [...new Set(rule.addresses.map(smtpAddress))].sort() : [],
  };
}

export function parseRelay(value: unknown): SmtpRelay {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("SMTP relay must be an object");
  const relay = value as Record<string, unknown>;
  const host = smtpDomain(relay.host);
  if (!Number.isInteger(relay.port) || Number(relay.port) < 1 || Number(relay.port) > 65535) {
    throw new Error("SMTP port must be 1–65535");
  }
  if (typeof relay.username !== "string" || !relay.username || relay.username.length > 254 || /[\s\x00-\x1f:]/.test(relay.username)) {
    throw new Error("SMTP username is invalid");
  }
  if (typeof relay.password !== "string" || !relay.password || relay.password.length > 1024 || /[\s\x00-\x1f]/.test(relay.password)) {
    throw new Error("SMTP password is invalid");
  }
  return { host, port: Number(relay.port), username: relay.username, password: relay.password };
}

export function senderGrants(site: Pick<SmtpSubmissionSite, "domain" | "rule">): { addresses: string[]; domains: string[] } {
  const addresses = [senderFor(site.rule.sender, site.domain)];
  if (site.rule.mode === "force") return { addresses, domains: [] };
  return {
    addresses: [...new Set([...addresses, ...site.rule.addresses])],
    domains: [...new Set([site.domain, ...site.rule.domains])],
  };
}

export function permittedSender(site: SmtpSubmissionSite, address: string): boolean {
  const sender = smtpAddress(address);
  const domain = sender.slice(sender.lastIndexOf("@") + 1);
  const grants = senderGrants(site);
  return grants.addresses.includes(sender) || grants.domains.includes(domain);
}

/** The public sender policy is separate from the root-only SMTP credentials. */
export interface SmtpSiteRule {
  /** From template: {from.local} and {from.domain} come from the app's From, {site} is the site's domain. */
  sender: string;
  /** Domains {from.domain} may keep besides the site's own. */
  domains: string[];
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

export const DEFAULT_RULE: SmtpSiteRule = { sender: "noreply@{site}", domains: [] };
export const FALLBACK_LOCAL = "noreply";

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

export interface RequestedSender { local: string; domain: string }

export function senderFor(template: string, site: string, from?: RequestedSender | null): string {
  return smtpAddress(template
    .replaceAll("{from.local}", from?.local ?? FALLBACK_LOCAL)
    .replaceAll("{from.domain}", from?.domain ?? site)
    .replaceAll("{site}", site));
}

export function parseSenderTemplate(value: unknown): string {
  if (typeof value !== "string" || value.length > 254) throw new Error("From address is required");
  const template = value.trim().toLowerCase();
  const at = template.lastIndexOf("@");
  const local = template.slice(0, at);
  const domain = template.slice(at + 1);
  if (["{from.local}", "{from.domain}", "{site}"].reduce((rest, token) => rest.replaceAll(token, ""), template).match(/[{}]/)) {
    throw new Error("From may use only {from.local}, {from.domain} and {site}");
  }
  if (at < 1 || local.includes("{from.domain}") || domain.includes("{from.local}") ||
      (domain.includes("{from.domain}") && domain !== "{from.domain}")) {
    throw new Error("From must be name@domain, with {from.local} before the @ and {from.domain} as the whole domain");
  }
  senderFor(template, "example.com", { local: "wordpress", domain: "example.com" });
  return template;
}

export function parseRule(value: unknown): SmtpSiteRule {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("sender rule must be an object");
  const rule = value as Record<string, unknown>;
  const sender = parseSenderTemplate(rule.sender);
  const domains = rule.domains ?? [];
  if (!Array.isArray(domains) || domains.length > 30) throw new Error("too many allowed domains");
  return { sender, domains: sender.includes("{from.domain}") ? [...new Set(domains.map(smtpDomain))].sort() : [] };
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

/** Domains the app's own From domain may keep; anything else is foreign. */
export function allowedDomains(site: Pick<SmtpSubmissionSite, "domain" | "rule">): string[] {
  return [...new Set([site.domain, ...site.rule.domains])];
}

/** Envelope senders a site's Unix account may use, as Postfix sender map entries. */
export function senderGrants(site: Pick<SmtpSubmissionSite, "domain" | "rule">): string[] {
  const { sender } = site.rule;
  const domains = sender.includes("{from.domain}") ? allowedDomains(site) : [site.domain];
  return [...new Set(domains.map((domain) => {
    const address = senderFor(sender, site.domain, { local: FALLBACK_LOCAL, domain });
    return sender.includes("{from.local}") ? address.slice(address.lastIndexOf("@")) : address;
  }))];
}

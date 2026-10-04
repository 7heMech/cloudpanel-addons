import type { Stats } from "node:fs";

/** Shared by the root action and the PHP mail wrapper, so nothing here may hold a password for the wrapper. */
export interface SmtpRelay {
  host: string;
  port: number;
  username: string;
  password: string;
}

/** A relay account and the From its sites send with. A null relay discards the mail of its sites. */
export interface SmtpProfile {
  id: string;
  name: string;
  relay: SmtpRelay | null;
  /** From template: {site} is the site's domain, {from.local} and {from.domain} come from the app's From. */
  sender: string;
}

/** What the wrapper reads for one site, from a file only that site's group can read. */
export interface SmtpSubmissionRule {
  version: 1;
  /** The value of {site}. */
  site: string;
  /** Null for a site in no profile: its From is kept, and only an envelope sender outside `allowed` is dropped. */
  sender: string | null;
  /** Domains a requested From may keep. */
  allowed: string[];
}
export type SmtpRewriteRule = SmtpSubmissionRule & { sender: string };

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const DOMAIN = new RegExp(`^${LABEL}(?:\\.${LABEL})+$`);
const ADDRESS = new RegExp(`^[A-Za-z0-9._%+'-]+@(${LABEL}(?:\\.${LABEL})+)$`, "i");

export const DEFAULT_SENDER = "noreply@{site}";
export const FALLBACK_LOCAL = "noreply";

/** A regular file, not a link, that only `uid` can have written. */
export function trustedFile(stat: Stats, uid: number): boolean {
  return stat.isFile() && stat.uid === uid && (stat.mode & 0o022) === 0;
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

export function parseRelay(value: unknown): SmtpRelay {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("SMTP relay must be an object");
  const relay = value as Record<string, unknown>;
  const host = smtpDomain(relay.host);
  if (!Number.isInteger(relay.port) || Number(relay.port) < 1 || Number(relay.port) > 65535) {
    throw new Error("SMTP port must be 1–65535");
  }
  if (relay.port === 465) throw new Error("port 465 needs implicit TLS, which this relay does not support; use 587 or 2525 with STARTTLS");
  if (typeof relay.username !== "string" || !relay.username || relay.username.length > 254 || /[\s\x00-\x1f:]/.test(relay.username)) {
    throw new Error("SMTP username is invalid");
  }
  if (typeof relay.password !== "string" || !relay.password || relay.password.length > 1024 || /[\s\x00-\x1f]/.test(relay.password)) {
    throw new Error("SMTP password is invalid");
  }
  return { host, port: Number(relay.port), username: relay.username, password: relay.password };
}

/**
 * The value of {site}. WordPress drops a leading www. from its own From, and
 * CloudPanel redirects the bare name to a www. site, so a www. site owns the
 * bare domain unless another site is that domain.
 */
export function siteName(domain: string, otherSites: ReadonlySet<string>): string {
  const bare = domain.startsWith("www.") ? domain.slice(4) : "";
  return bare.includes(".") && !otherSites.has(bare) ? bare : domain;
}

export function submissionRule(domain: string, site: string, sender: string, grants: readonly string[]): SmtpRewriteRule {
  return { version: 1, site, sender, allowed: [...new Set([site, domain, ...grants])] };
}

/** Envelope senders a site may use, as Postfix sender patterns: `@domain` or an exact address. */
export function envelopeGrants(rule: SmtpRewriteRule): string[] {
  const { sender } = rule;
  const domains = sender.includes("{from.domain}") ? rule.allowed : [rule.site];
  const fromTemplate = domains.map((domain) => {
    const address = senderFor(sender, rule.site, { local: FALLBACK_LOCAL, domain });
    return sender.includes("{from.local}") ? address.slice(address.lastIndexOf("@")) : address;
  });
  return [...new Set([...rule.allowed.map((domain) => `@${domain}`), ...fromTemplate])];
}

/**
 * What DNS keeps: profiles of record templates, which site uses which, and the
 * connections and settings the templates draw on. Everything here is checked
 * the same way whether it arrives from the page or from the saved policy.
 */
import { isIP } from "node:net";
import { ActionFailure, failAction, oneLine } from "../../cli/action-common";

export const RECORD_TYPES = ["A", "AAAA", "CNAME", "MX", "TXT", "SRV", "CAA"] as const;
export type RecordType = (typeof RECORD_TYPES)[number];

/** Cloudflare's own TTL choices; 1 is Auto, and the only one a proxied record takes. */
export const TTLS = [1, 60, 120, 300, 600, 900, 1800, 3600, 7200, 18000, 43200, 86400];

export const SSL_MODES = ["off", "flexible", "full", "strict"] as const;
export type SslMode = (typeof SSL_MODES)[number];

export const PROXIABLE: readonly RecordType[] = ["A", "AAAA", "CNAME"];
export const PRIORITISED: readonly RecordType[] = ["MX", "SRV"];

const MAX_PROFILES = 24;
const MAX_RECORDS = 60;
const MAX_CONNECTIONS = 12;
const MAX_SKIP_IPS = 20;
const NAME_MAX = 40;

export interface RecordTemplate {
  type: RecordType;
  name: string;
  content: string;
  proxied: boolean;
  ttl: number;
  /** MX and SRV only. */
  priority: number | null;
  /** Only when the site's domain is its zone's apex, as `www` should be. */
  apexOnly: boolean;
}

export interface AccountRef {
  connectionId: string;
  accountId: string;
}

export interface ZoneOptions {
  /** Null leaves the zone's own setting alone. */
  ssl: SslMode | null;
  alwaysHttps: boolean | null;
  /** Full SSL for Let's Encrypt's HTTP-01 path, so a proxied site can get its first certificate. */
  acmeFullSsl: boolean;
  /** Full SSL for `webmail.` hosts, whose origin is the mail server. */
  webmailFullSsl: boolean;
  /** Addresses that skip Super Bot Fight Mode and managed WAF rules, such as a MainWP Dashboard. */
  skipFirewallIps: string[];
  /** Where a missing zone is created, or null to report it instead. */
  createIn: AccountRef | null;
}

export interface Profile {
  id: string;
  name: string;
  mode: "report" | "enforce";
  records: RecordTemplate[];
  /** Add each site's domain to Mailcow, with DKIM and the shared mailbox's sender permission. */
  mailcow: boolean;
  zone: ZoneOptions;
}

export interface Connection {
  id: string;
  label: string;
}

export interface MailcowSettings {
  /** The API's HTTPS origin; empty until Mailcow is set up. */
  url: string;
  /** What `{mailcow.host}` stands for. */
  host: string;
  /** A domain whose key new domains share, or empty to generate one per domain. */
  dkimSource: string;
  dkimSelector: string;
  dkimBits: number;
  /** A mailbox that is allowed to send as every Mailcow domain, such as SMTP Relay's. */
  sharedMailbox: string;
}

export interface ZoneChoice {
  connectionId: string;
  zoneId: string;
}

export interface Policy {
  version: 1;
  profiles: Profile[];
  defaultProfileId: string | null;
  /** Domain to profile id. A site that is absent is left alone. */
  assignments: Record<string, string>;
  knownSiteIds: number[];
  connections: Connection[];
  /** Zone name to the connection and zone that manage it, where more than one could. */
  zoneChoices: Record<string, ZoneChoice>;
  /** Overrides for `{ipv4}` and `{ipv6}`; empty uses what was detected. */
  server: { ipv4: string; ipv6: string };
  mailcow: MailcowSettings;
}

/** Root-only, and never part of anything sent to the browser. */
export interface Secrets {
  cloudflare: Record<string, string>;
  mailcowKey: string;
}

export const EMPTY_MAILCOW: MailcowSettings = {
  url: "", host: "", dkimSource: "", dkimSelector: "dkim", dkimBits: 2048, sharedMailbox: "",
};

// ---------------------------------------------------------------------------
// Small parsers
// ---------------------------------------------------------------------------

const LABEL = "(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)";
const HOSTNAME_RE = new RegExp(`^${LABEL}(?:\\.${LABEL})+$`);

/** A DNS name as records use it: underscores allowed, a leading `*.` allowed, no trailing dot. */
export function dnsName(value: string): boolean {
  const name = value.startsWith("*.") ? value.slice(2) : value;
  return value.length <= 253 && HOSTNAME_RE.test(name);
}

export function hostname(value: unknown, what: string): string {
  if (typeof value !== "string") failAction(`${what} must be a hostname`);
  const name = value.trim().toLowerCase().replace(/\.$/, "");
  if (!dnsName(name) || name.startsWith("*.")) failAction(`${what} must be a hostname`);
  return name;
}

export function optionalHostname(value: unknown, what: string): string {
  return value === "" || value == null ? "" : hostname(value, what);
}

export function profileId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) failAction("that is not a profile identifier");
  return value;
}

export function connectionId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) failAction("that is not a connection identifier");
  return value;
}

export function cloudflareId(value: unknown, what: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{32}$/.test(value)) failAction(`${what} is not a Cloudflare identifier`);
  return value;
}

function flag(value: unknown, what: string): boolean {
  if (typeof value !== "boolean") failAction(`${what} must be on or off`);
  return value;
}

function integer(value: unknown, what: string, min: number, max: number): number {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isInteger(number) || number < min || number > max) {
    failAction(`${what} must be a whole number from ${min} to ${max}`);
  }
  return number;
}

export function ipAddress(value: unknown, family: 4 | 6, what: string): string {
  if (value === "" || value == null) return "";
  if (typeof value !== "string" || isIP(value.trim()) !== family) failAction(`${what} must be an IPv${family} address`);
  return value.trim().toLowerCase();
}

function anyIp(value: unknown): string {
  if (typeof value !== "string" || !isIP(value.trim())) failAction(`${String(value)} is not an IP address`);
  return value.trim().toLowerCase();
}

export function mailbox(value: unknown, what: string): string {
  if (value === "" || value == null) return "";
  if (typeof value !== "string") failAction(`${what} must be an email address`);
  const address = value.trim().toLowerCase();
  const at = address.lastIndexOf("@");
  if (at < 1 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(address.slice(0, at))) failAction(`${what} must be an email address`);
  hostname(address.slice(at + 1), what);
  return address;
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

/** Placeholders a template may use, and where. Checked again when a template is rendered. */
export const NAME_PLACEHOLDERS = ["domain", "zone", "sub", "mailcow.selector"];
export const CONTENT_PLACEHOLDERS = ["domain", "zone", "sub", "ipv4", "ipv6", "mailcow.host", "mailcow.selector", "mailcow.dkim"];

function templateText(value: unknown, what: string, max: number, allowed: string[]): string {
  if (typeof value !== "string") failAction(`${what} must be text`);
  const text = value.trim();
  if (/[\u0000-\u001f\u007f]/.test(text)) failAction(`${what} contains a control character`);
  if (text.length > max) failAction(`${what} must be at most ${max} characters`);
  for (const [, token] of text.matchAll(/\{([^{}]*)\}/g)) {
    if (!allowed.includes(token!)) failAction(`${what} uses {${token}}, which is not a placeholder here`);
  }
  return text;
}

export function parseRecord(value: unknown, position: number): RecordTemplate {
  const where = `Record ${position}`;
  if (!value || typeof value !== "object" || Array.isArray(value)) failAction(`${where} is malformed`);
  const raw = value as Record<string, unknown>;
  const type = RECORD_TYPES.find((candidate) => candidate === raw.type);
  if (!type) failAction(`${where} has a record type this addon does not manage`);
  const name = templateText(raw.name, `${where}'s name`, 253, NAME_PLACEHOLDERS).toLowerCase();
  if (!name) failAction(`${where} needs a name, such as {domain}`);
  const content = templateText(raw.content, `${where}'s content`, 4096, CONTENT_PLACEHOLDERS);
  if (!content) failAction(`${where} needs content`);
  const proxied = PROXIABLE.includes(type) ? flag(raw.proxied ?? false, `${where}'s proxy`) : false;
  const ttl = proxied ? 1 : integer(raw.ttl ?? 1, `${where}'s TTL`, 1, 86400);
  if (!TTLS.includes(ttl)) failAction(`${where}'s TTL must be one of Cloudflare's: Auto, 1, 2, 5, 10, 15 or 30 minutes, or 1, 2, 5, 12 or 24 hours`);
  const priority = PRIORITISED.includes(type) ? integer(raw.priority ?? null, `${where}'s priority`, 0, 65535) : null;
  return { type, name, content, proxied, ttl, priority, apexOnly: flag(raw.apexOnly ?? false, `${where}'s apex-only setting`) };
}

function parseZoneOptions(value: unknown): ZoneOptions {
  const raw = (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  const ssl = raw.ssl == null || raw.ssl === "" ? null : SSL_MODES.find((mode) => mode === raw.ssl);
  if (ssl === undefined) failAction("the SSL/TLS mode must be Off, Flexible, Full or Full (strict)");
  const alwaysHttps = raw.alwaysHttps == null || raw.alwaysHttps === "" ? null : flag(raw.alwaysHttps, "Always Use HTTPS");
  if (raw.skipFirewallIps != null && !Array.isArray(raw.skipFirewallIps)) failAction("the firewall skip list must be a list");
  const ips = [...new Set(((raw.skipFirewallIps ?? []) as unknown[]).map(anyIp))];
  if (ips.length > MAX_SKIP_IPS) failAction(`at most ${MAX_SKIP_IPS} addresses can skip the firewall`);
  let createIn: AccountRef | null = null;
  if (raw.createIn != null && raw.createIn !== "") {
    const ref = raw.createIn as Record<string, unknown>;
    if (typeof ref !== "object") failAction("the account for new zones is malformed");
    createIn = { connectionId: connectionId(ref.connectionId), accountId: cloudflareId(ref.accountId, "the account for new zones") };
  }
  return {
    ssl,
    alwaysHttps,
    acmeFullSsl: flag(raw.acmeFullSsl ?? false, "the Let's Encrypt rule"),
    webmailFullSsl: flag(raw.webmailFullSsl ?? false, "the webmail rule"),
    skipFirewallIps: ips,
    createIn,
  };
}

export function parseProfile(value: unknown): Profile {
  if (!value || typeof value !== "object" || Array.isArray(value)) failAction("the profile is malformed");
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.records)) failAction("the profile's records must be a list");
  if (raw.records.length > MAX_RECORDS) failAction(`a profile can hold at most ${MAX_RECORDS} records`);
  if (raw.mode !== "report" && raw.mode !== "enforce") failAction("the mode must be Report only or Enforce");
  return {
    id: profileId(raw.id),
    name: oneLine(raw.name, "the profile name", NAME_MAX, true),
    mode: raw.mode,
    records: raw.records.map((record, index) => parseRecord(record, index + 1)),
    mailcow: flag(raw.mailcow ?? false, "Mailcow setup"),
    zone: parseZoneOptions(raw.zone),
  };
}

/** What changes a site's DNS or Mailcow, as opposed to the name or the mode. */
export function profileEffect(profile: Profile): string {
  return JSON.stringify([profile.records, profile.mailcow, profile.zone]);
}

// ---------------------------------------------------------------------------
// The saved policy
// ---------------------------------------------------------------------------

export function parseMailcow(value: unknown): MailcowSettings {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const bits = Number(raw.dkimBits ?? 2048);
  if (![1024, 2048, 3072, 4096].includes(bits)) failAction("the DKIM key size must be 1024, 2048, 3072 or 4096");
  return {
    url: raw.url ? mailcowOrigin(raw.url) : "",
    host: optionalHostname(raw.host, "the mail hostname"),
    dkimSource: optionalHostname(raw.dkimSource, "the DKIM source domain"),
    dkimSelector: dkimSelector(raw.dkimSelector ?? "dkim"),
    dkimBits: bits,
    sharedMailbox: mailbox(raw.sharedMailbox, "the shared mailbox"),
  };
}

export function dkimSelector(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?$/i.test(value.trim())) {
    failAction("the DKIM selector must be letters, digits, dashes or underscores");
  }
  return value.trim().toLowerCase();
}

export function mailcowOrigin(value: unknown): string {
  if (typeof value !== "string") failAction("the Mailcow address must be an HTTPS URL");
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    failAction("the Mailcow address must be an HTTPS URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    failAction("the Mailcow address must be an HTTPS origin, such as https://mail.example.com");
  }
  return url.origin;
}

export function parseConnections(value: unknown): Connection[] {
  if (!Array.isArray(value)) failAction("the connections must be a list");
  if (value.length > MAX_CONNECTIONS) failAction(`at most ${MAX_CONNECTIONS} Cloudflare connections can be added`);
  return value.map((entry) => {
    const raw = (entry ?? {}) as Record<string, unknown>;
    return { id: connectionId(raw.id), label: oneLine(raw.label, "the connection name", NAME_MAX, true) };
  });
}

export function parsePolicy(value: unknown): Policy {
  const raw = (value ?? {}) as Partial<Policy>;
  if (raw.version !== 1 || !Array.isArray(raw.profiles) || !raw.assignments || typeof raw.assignments !== "object") {
    failAction("the DNS policy is malformed");
  }
  try {
    const profiles = raw.profiles.map(parseProfile);
    if (profiles.length > MAX_PROFILES) failAction(`at most ${MAX_PROFILES} profiles`);
    const ids = new Set(profiles.map((profile) => profile.id));
    const choices: Record<string, ZoneChoice> = {};
    for (const [zone, choice] of Object.entries(raw.zoneChoices ?? {})) {
      choices[hostname(zone, "a zone")] = { connectionId: connectionId(choice.connectionId), zoneId: cloudflareId(choice.zoneId, "a zone") };
    }
    return {
      version: 1,
      profiles,
      defaultProfileId: raw.defaultProfileId && ids.has(raw.defaultProfileId) ? raw.defaultProfileId : null,
      assignments: Object.fromEntries(Object.entries(raw.assignments)
        .filter(([, id]) => ids.has(id))
        .map(([domain, id]) => [hostname(domain, "an assigned site"), id])),
      knownSiteIds: [...new Set((raw.knownSiteIds ?? []).filter((id) => Number.isSafeInteger(id) && id > 0))],
      connections: parseConnections(raw.connections ?? []),
      zoneChoices: choices,
      server: {
        ipv4: ipAddress(raw.server?.ipv4, 4, "the server IPv4 override"),
        ipv6: ipAddress(raw.server?.ipv6, 6, "the server IPv6 override"),
      },
      mailcow: parseMailcow(raw.mailcow),
    };
  } catch (error) {
    if (error instanceof ActionFailure) failAction(`the DNS policy is malformed: ${error.message}`);
    throw error;
  }
}

export function parseSecrets(value: unknown): Secrets {
  const raw = (value ?? {}) as Partial<Secrets>;
  const cloudflare: Record<string, string> = {};
  for (const [id, token] of Object.entries(raw.cloudflare ?? {})) {
    if (typeof token === "string" && token) cloudflare[connectionId(id)] = token;
  }
  return { cloudflare, mailcowKey: typeof raw.mailcowKey === "string" ? raw.mailcowKey : "" };
}

/** A Cloudflare API token or Mailcow key as pasted: one printable run, no spaces. */
export function secretText(value: unknown, what: string): string {
  if (typeof value !== "string") failAction(`${what} must be text`);
  const secret = value.trim();
  if (!/^[\x21-\x7e]{20,512}$/.test(secret)) failAction(`${what} does not look like one`);
  return secret;
}

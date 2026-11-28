/**
 * What DNS keeps: composable HTTP and Mail role profiles, which domain uses
 * which roles, and the connections and settings the templates draw on.
 * Everything here is checked the same way whether it arrives from the page or
 * from the saved policy.
 */
import { isIP } from "node:net";
import { ActionFailure, failAction } from "../../lib/action";
import { cloudflareId, connectionId, dnsName, secretText } from "../../lib/dns-name";
import { oneLine } from "../../lib/validate";
import {
  parsePowerDnsDefaultTtl, parsePowerDnsNameservers, parsePowerDnsServerId, parsePowerDnsUrl,
} from "./powerdns";
import { isSpf } from "./spf";

export { cloudflareId, connectionId, dnsName, secretText };

/** A zone or account identifier for any DNS provider (Cloudflare 32-hex, PowerDNS zone/server id, etc.). */
export function providerId(value: unknown, what: string): string {
  if (typeof value !== "string" || !/^[\x21-\x2e\x30-\x7e]{1,255}$/.test(value)) {
    failAction(`${what} is not a valid provider identifier`);
  }
  return value;
}

const RECORD_TYPES = ["A", "AAAA", "CNAME", "MX", "TXT", "SRV", "CAA"] as const;
type RecordType = (typeof RECORD_TYPES)[number];

/** Cloudflare's own TTL choices; 1 is Auto, and the only one a proxied record takes. */
const TTLS = [1, 60, 120, 300, 600, 900, 1800, 3600, 7200, 18000, 43200, 86400];

export const PROFILE_ROLES = ["http", "mail"] as const;
export type ProfileRole = (typeof PROFILE_ROLES)[number];

/** A domain's mutually exclusive HTTP role: serving a CloudPanel site, redirecting elsewhere, or DNS-only (no HTTP records). */
export type HttpRole = "site" | "redirect" | "dns-only";
export const PROXIABLE: readonly RecordType[] = ["A", "AAAA", "CNAME"];
const PRIORITISED: readonly RecordType[] = ["MX", "SRV"];

export const MAX_PROFILES = 48;
const MAX_RECORDS = 60;
export const MAX_CONNECTIONS = 12;
const MAX_REDIRECTS = 500;
const NAME_MAX = 40;

export interface RecordTemplate {
  type: RecordType;
  name: string;
  content: string;
  proxied: boolean;
  ttl: number;
  /** MX and SRV only. */
  priority: number | null;
  /** Only when the site's domain is its zone's apex, such as `*.{domain}` or `webmail.{domain}`. */
  apexOnly: boolean;
}

export interface AccountRef {
  connectionId: string;
  accountId: string;
}

export interface Profile {
  id: string;
  name: string;
  role: ProfileRole;
  records: RecordTemplate[];
  /** Mail profiles only: add each site's domain to Mailcow, with DKIM and the shared mailbox's sender permission. */
  mailcow: boolean;
}

/** Composable roles assigned to a CloudPanel site. Null `http` is DNS-only (no web records managed). */
export interface SiteAssignment {
  http: string | null;
  mail: string | null;
}

/** A host whose requests Cloudflare, or a stand-in site on this server, sends elsewhere. */
export interface Redirect {
  /** A zone apex, which covers its `www` too, or one host inside a zone. */
  source: string;
  target: string;
  status: RedirectStatus;
  keepPath: boolean;
  keepQuery: boolean;
  /** Optional Mail profile whose records (and Mailcow setup) apply alongside the redirect. */
  mailProfileId: string | null;
}

export const REDIRECT_STATUSES = [301, 302, 307, 308] as const;
export type RedirectStatus = (typeof REDIRECT_STATUSES)[number];

export interface Connection {
  id: string;
  label: string;
}

export interface PowerDnsConnection {
  id: string;
  label: string;
  url: string;
  serverId: string;
  defaultTtl: number;
  createZones: boolean;
  nameservers: string[];
}

export interface MailcowSettings {
  /** The API's HTTPS origin; empty until Mailcow is set up. */
  url: string;
  /** What `{mailcow.host}` stands for: always the hostname of `url`. */
  host: string;
  /** A domain whose key new domains share, or empty to generate one per domain. */
  dkimSource: string;
  dkimSelector: string;
  dkimBits: number;
  /** A mailbox that is allowed to send as every Mailcow domain, such as SMTP Relay's. */
  sharedMailbox: string;
}

interface ZoneChoice {
  connectionId: string;
  zoneId: string;
}

export interface Policy {
  version: 2;
  /** Off is Ask first: DNS reads and shows what differs, and writes nothing until this is turned on through a review. */
  automatic: boolean;
  /** The account a missing zone is created in; null uses the only account the connections reach. */
  createIn: AccountRef | null;
  profiles: Profile[];
  /** Default HTTP profile for new CloudPanel sites; null leaves HTTP as DNS-only. */
  defaultHttpProfileId: string | null;
  /** Default Mail profile for new CloudPanel sites; null leaves Mail as None. */
  defaultMailProfileId: string | null;
  /** Domain to its HTTP and Mail profile ids. A site that is absent is left alone. */
  assignments: Record<string, SiteAssignment>;
  redirects: Redirect[];
  knownSiteIds: number[];
  /** New sites whose changes beyond their own address records wait for an administrator's review. */
  held: string[];
  connections: Connection[];
  /** PowerDNS Authoritative API v1 connections stored in dns/policy.json. */
  powerdns?: PowerDnsConnection[];
  /** Zone name to the connection and zone that manage it, where more than one could. */
  zoneChoices: Record<string, ZoneChoice>;
  /** Overrides for `{ipv4}` and `{ipv6}`; empty uses what was detected. */
  server: { ipv4: string; ipv6: string };
  mailcow: MailcowSettings;
  /** The name DNS points at this server for CloudPanel's custom domain; null for none. */
  panelHost: string | null;
}

/** Root-only, and never part of anything sent to the browser. */
export interface Secrets {
  cloudflare: Record<string, string>;
  powerdns?: Record<string, string>;
  mailcowKey: string;
}

export const EMPTY_MAILCOW: MailcowSettings = {
  url: "", host: "", dkimSource: "", dkimSelector: "dkim", dkimBits: 2048, sharedMailbox: "",
};

/** Whether Mailcow currently has both an origin URL and an API key saved. */
export function isMailcowLinked(mailcow: Pick<MailcowSettings, "url">, secrets: Pick<Secrets, "mailcowKey">): boolean {
  return Boolean(mailcow.url && secrets.mailcowKey);
}

/** Combines an optional HTTP profile and an optional Mail profile into one effective template for rendering and planning. */
export function composeProfiles(http: Profile | null, mail: Profile | null): Profile | null {
  if (!http && !mail) return null;
  if (http && !mail) return http;
  if (!http && mail) return mail;
  return {
    id: `${http!.id}+${mail!.id}`,
    name: `${http!.name} + ${mail!.name}`,
    role: "http",
    records: [...http!.records, ...mail!.records],
    mailcow: mail!.mailcow,
  };
}

// ---------------------------------------------------------------------------
// Small parsers
// ---------------------------------------------------------------------------

export function hostname(value: unknown, what: string): string {
  if (typeof value !== "string") failAction(`${what} must be a hostname`);
  const name = value.trim().toLowerCase().replace(/\.$/, "");
  if (!dnsName(name) || name.startsWith("*.")) failAction(`${what} must be a hostname`);
  return name;
}

function optionalHostname(value: unknown, what: string): string {
  return value === "" || value == null ? "" : hostname(value, what);
}

export function profileId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) failAction("that is not a profile identifier");
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
const NAME_PLACEHOLDERS = ["domain", "zone", "sub", "mailcow.selector"];
const CONTENT_PLACEHOLDERS = ["domain", "zone", "sub", "ipv4", "ipv6", "mailcow.host", "mailcow.selector", "mailcow.dkim"];
const MAILCOW_PLACEHOLDER = /\{mailcow\./;

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
  if (!TTLS.includes(ttl)) failAction(`${where}'s TTL must be Auto, 1, 2, 5, 10, 15 or 30 minutes, or 1, 2, 5, 12 or 24 hours`);
  const priority = PRIORITISED.includes(type) ? integer(raw.priority ?? null, `${where}'s priority`, 0, 65535) : null;
  return { type, name, content, proxied, ttl, priority, apexOnly: flag(raw.apexOnly ?? false, `${where}'s apex-only setting`) };
}

export function parseAccountRef(value: unknown): AccountRef | null {
  if (value == null || value === "") return null;
  if (typeof value !== "object" || Array.isArray(value)) failAction("the account for new zones is malformed");
  const ref = value as Record<string, unknown>;
  return { connectionId: connectionId(ref.connectionId), accountId: providerId(ref.accountId, "the account for new zones") };
}

function parseLegacyProfile(value: unknown): Omit<Profile, "role"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) failAction("the profile is malformed");
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.records)) failAction("the profile's records must be a list");
  if (raw.records.length > MAX_RECORDS) failAction(`a profile can hold at most ${MAX_RECORDS} records`);
  return {
    id: profileId(raw.id),
    name: oneLine(raw.name, "the profile name", NAME_MAX, true),
    records: raw.records.map((record, index) => parseRecord(record, index + 1)),
    mailcow: flag(raw.mailcow ?? false, "Mailcow setup"),
  };
}

export function parseProfile(value: unknown): Profile {
  if (!value || typeof value !== "object" || Array.isArray(value)) failAction("the profile is malformed");
  const raw = value as Record<string, unknown>;
  const base = parseLegacyProfile(value);
  const role: ProfileRole = raw.role === undefined
    ? (base.mailcow ? "mail" : "http")
    : PROFILE_ROLES.find((candidate) => candidate === raw.role) ?? failAction("the profile role must be http or mail");
  if (role === "http" && base.mailcow) failAction("only a Mail profile can set up Mailcow");
  if (role === "http" && base.records.some((row) => MAILCOW_PLACEHOLDER.test(row.name + row.content))) {
    failAction("HTTP profiles cannot use {mailcow.…} placeholders; put them in a Mail profile");
  }
  return { ...base, role };
}

/** What changes a site's DNS or Mailcow, as opposed to the name. */
export function profileEffect(profile: Profile): string {
  return JSON.stringify([profile.role, profile.records, profile.mailcow]);
}

// ---------------------------------------------------------------------------
// The saved policy (v2, with deterministic migration from v1)
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

/** Mailcow's HTTPS origin, from either that origin or its bare hostname. */
function mailcowOrigin(value: unknown): string {
  if (typeof value !== "string") failAction("the Mailcow address must be a hostname or an HTTPS URL");
  const text = value.trim();
  let url: URL;
  try {
    url = new URL(text.includes("://") ? text : `https://${text}`);
  } catch {
    failAction("the Mailcow address must be a hostname or an HTTPS URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    failAction("the Mailcow address must be a hostname, such as mail.example.com, or an HTTPS origin");
  }
  return url.origin;
}

function parseConnections(value: unknown): Connection[] {
  if (!Array.isArray(value)) failAction("the connections must be a list");
  if (value.length > MAX_CONNECTIONS) failAction(`at most ${MAX_CONNECTIONS} Cloudflare connections can be added`);
  return value.map((entry) => {
    const raw = (entry ?? {}) as Record<string, unknown>;
    return { id: connectionId(raw.id), label: oneLine(raw.label, "the connection name", NAME_MAX, true) };
  });
}

export function parsePowerDnsConnection(value: unknown, fallbackId?: string): PowerDnsConnection {
  if (!value || typeof value !== "object" || Array.isArray(value)) failAction("the PowerDNS connection is malformed");
  const raw = value as Record<string, unknown>;
  const id = connectionId(raw.id ?? fallbackId);
  const url = parsePowerDnsUrl(raw.url);
  const serverId = parsePowerDnsServerId(raw.serverId);
  const defaultTtl = parsePowerDnsDefaultTtl(raw.defaultTtl);
  const createZones = flag(raw.createZones ?? false, "Create missing zones");
  const nameservers = parsePowerDnsNameservers(raw.nameservers, createZones);
  const named = oneLine(raw.label, "the connection name", NAME_MAX, false);
  const label = named || new URL(url).hostname.slice(0, NAME_MAX) || "PowerDNS";
  return { id, label, url, serverId, defaultTtl, createZones, nameservers };
}

function parsePowerDnsConnections(value: unknown): PowerDnsConnection[] {
  if (value == null) return [];
  if (!Array.isArray(value)) failAction("the PowerDNS connections must be a list");
  if (value.length > MAX_CONNECTIONS) failAction(`at most ${MAX_CONNECTIONS} PowerDNS connections can be added`);
  const seen = new Set<string>();
  return value.map((entry) => {
    const parsed = parsePowerDnsConnection(entry);
    if (seen.has(parsed.id)) failAction(`PowerDNS connection ${parsed.id} is listed twice`);
    seen.add(parsed.id);
    return parsed;
  });
}

/**
 * A policy saved with a mode on each profile is Automatic only when every
 * profile that has sites enforced; anything less asks first, so no site starts
 * being written without a review. Its account for new zones is the first a
 * profile named.
 */
function legacyAutomatic(raw: Record<string, unknown>): { automatic: boolean; createIn: unknown } {
  const profiles = raw.profiles as { id?: unknown; mode?: unknown; zone?: { createIn?: unknown } }[];
  const assignments = (raw.assignments ?? {}) as Record<string, unknown>;
  const used = profiles.filter((profile) => Object.values(assignments).includes(profile.id as string));
  return {
    automatic: used.length > 0 && used.every((profile) => profile.mode === "enforce"),
    createIn: profiles.map((profile) => profile.zone?.createIn).find((ref) => ref) ?? null,
  };
}

const WEB_ROW_NAMES = new Set(["{domain}", "www.{domain}", "*.{domain}"]);

function isWebRow(row: RecordTemplate): boolean {
  return (row.type === "A" || row.type === "AAAA" || row.type === "CNAME") && WEB_ROW_NAMES.has(row.name);
}

function isMailRecord(row: RecordTemplate): boolean {
  if (row.type === "MX") return true;
  if (MAILCOW_PLACEHOLDER.test(row.name + row.content)) return true;
  const name = row.name.toLowerCase();
  if (
    name.startsWith("autoconfig.")
    || name.startsWith("autodiscover.")
    || name.startsWith("_autodiscover._tcp.")
    || name.startsWith("webmail.")
    || name.startsWith("_dmarc.")
    || name.startsWith("_mta-sts.")
    || name.startsWith("_smtp._tls.")
    || name.startsWith("mta-sts.")
    || name.includes("._domainkey.")
  ) return true;
  if (row.type === "TXT") {
    const content = row.content.trim();
    if (isSpf(content) || /^v=DKIM1(?:;|\s|$)/i.test(content) || /^v=DMARC1(?:;|\s|$)/i.test(content)) return true;
  }
  return false;
}

function standardMailcowRecords(records: RecordTemplate[]): boolean {
  const summary = records.map((row) => `${row.type}|${row.name}|${row.content}|${row.priority ?? ""}|${row.proxied}|${row.ttl}|${row.apexOnly}`);
  return summary.length === 7
    && summary[0] === "MX|{domain}|{mailcow.host}|10|false|1|false"
    && summary[1] === "TXT|{domain}|v=spf1 mx ~all||false|1|false"
    && summary[2] === "TXT|{mailcow.selector}._domainkey.{domain}|{mailcow.dkim}||false|1|false"
    && summary[3] === "CNAME|autoconfig.{domain}|{mailcow.host}||false|1|true"
    && summary[4] === "CNAME|autodiscover.{domain}|{mailcow.host}||false|1|true"
    && summary[5] === "SRV|_autodiscover._tcp.{domain}|0 443 {mailcow.host}|0|false|1|true"
    && summary[6] === "CNAME|webmail.{domain}|{mailcow.host}||true|1|true";
}

function allocateId(preferred: string, taken: Set<string>): string {
  const clean = preferred.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "profile";
  if (!taken.has(clean)) {
    taken.add(clean);
    return clean;
  }
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = `${clean.slice(0, 64 - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
}

function trimName(text: string, suffix = ""): string {
  const trimmed = text.trim();
  if (!suffix) return trimmed.slice(0, NAME_MAX);
  return `${trimmed.slice(0, Math.max(1, NAME_MAX - suffix.length)).trimEnd()}${suffix}`;
}

/**
 * Splits saved v1 single-profile policies into composable HTTP and Mail role
 * profiles without altering the rendered records or Mailcow settings of any
 * assigned site or redirect.
 */
function migrateV1PolicyWithMapping(raw: Record<string, unknown>, base: {
  automatic: boolean;
  createIn: AccountRef | null;
  connections: Connection[];
  powerdns: PowerDnsConnection[];
  zoneChoices: Record<string, ZoneChoice>;
  server: { ipv4: string; ipv6: string };
  mailcow: MailcowSettings;
  panelHost: string | null;
  knownSiteIds: number[];
}): { policy: Policy; mapping: Map<string, SiteAssignment> } {
  const legacyProfiles = (raw.profiles as unknown[]).map(parseLegacyProfile);
  if (legacyProfiles.length > MAX_PROFILES) failAction(`at most ${MAX_PROFILES} profiles`);
  const legacyIds = new Set<string>();
  for (const profile of legacyProfiles) {
    if (legacyIds.has(profile.id)) failAction(`profile ${profile.id} is listed twice`);
    legacyIds.add(profile.id);
  }
  const rawAssignments = raw.assignments as Record<string, unknown>;
  const legacyAssignments: [string, string][] = [];
  for (const [domain, id] of Object.entries(rawAssignments)) {
    if (typeof id === "string" && legacyIds.has(id)) {
      legacyAssignments.push([hostname(domain, "an assigned site"), id]);
    }
  }
  const rawRedirects = Array.isArray(raw.redirects) ? raw.redirects : [];
  const legacyRedirectProfileIds = new Set<string>();
  for (const entry of rawRedirects) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const pid = (entry as Record<string, unknown>).profileId;
    if (typeof pid === "string" && legacyIds.has(pid)) legacyRedirectProfileIds.add(pid);
  }
  const legacyDefault = typeof raw.defaultProfileId === "string" && legacyIds.has(raw.defaultProfileId) ? raw.defaultProfileId : null;
  const usedIds = new Set<string>([
    ...legacyAssignments.map(([, id]) => id),
    ...legacyRedirectProfileIds,
    ...(legacyDefault ? [legacyDefault] : []),
  ]);

  interface Classified {
    profile: Omit<Profile, "role">;
    httpRows: RecordTemplate[];
    mailRows: RecordTemplate[];
    kind: "http" | "mail" | "both";
  }

  const classified: Classified[] = legacyProfiles.map((profile) => {
    const usedByRedirect = legacyRedirectProfileIds.has(profile.id);
    // In v1, renderRedirect dropped only web rows and kept every other row
    // (including non-mail custom records such as TXT _verify). For any profile
    // referenced by a redirect, classify all non-web rows into the Mail role
    // so migrated redirects keep custom records without copying web rows.
    const mailRows = usedByRedirect
      ? profile.records.filter((row) => !isWebRow(row))
      : profile.records.filter(isMailRecord);
    const httpRows = usedByRedirect
      ? profile.records.filter(isWebRow)
      : profile.records.filter((row) => !isMailRecord(row));
    const hasMail = profile.mailcow || mailRows.length > 0;
    const hasWeb = httpRows.some(isWebRow);
    if (!hasMail) {
      return { profile, httpRows: profile.records, mailRows: [], kind: "http" };
    }
    if (!hasWeb) {
      return { profile, httpRows: [], mailRows: profile.records, kind: "mail" };
    }
    return { profile, httpRows, mailRows, kind: "both" };
  });

  const profiles: Profile[] = [];
  const takenIds = new Set<string>();
  const mapping = new Map<string, SiteAssignment>();

  const effectKey = (role: ProfileRole, records: RecordTemplate[], mailcow: boolean): string =>
    JSON.stringify([role, records, mailcow]);

  // Pass 1: register pure HTTP and pure Mail profiles first with their exact original IDs so combinatorial profiles deduplicate into them.
  for (const item of classified) {
    if (item.kind === "both") continue;
    const { profile } = item;
    if (item.kind === "http") {
      const migrated: Profile = { id: profile.id, name: profile.name, role: "http", records: item.httpRows, mailcow: false };
      takenIds.add(migrated.id);
      profiles.push(migrated);
      mapping.set(profile.id, { http: migrated.id, mail: null });
    } else {
      const migrated: Profile = { id: profile.id, name: profile.name, role: "mail", records: item.mailRows, mailcow: profile.mailcow };
      takenIds.add(migrated.id);
      profiles.push(migrated);
      mapping.set(profile.id, { http: null, mail: migrated.id });
    }
  }

  // Pass 2: split combinatorial profiles into reusable HTTP + Mail profiles.
  for (const item of classified) {
    if (item.kind !== "both") continue;
    const { profile, httpRows, mailRows } = item;
    const httpEffect = effectKey("http", httpRows, false);
    const existingHttp = profiles.find((candidate) => candidate.role === "http" && profileEffect(candidate) === httpEffect);

    // An untouched, unused default "Web and Mailcow" profile on an unlinked install is dropped rather than seeding an unused Mailcow profile.
    const untouchedUnusedWebMailcow = profile.id === "web-mailcow"
      && profile.name === "Web and Mailcow"
      && profile.mailcow
      && !usedIds.has(profile.id)
      && !base.mailcow.url
      && Boolean(existingHttp && existingHttp.id === "web")
      && standardMailcowRecords(mailRows);
    if (untouchedUnusedWebMailcow) continue;

    let httpId: string;
    if (existingHttp) {
      httpId = existingHttp.id;
    } else {
      const strippedName = profile.name.replace(/\s+(?:and|\+)\s+mailcow$/i, "").trim() || profile.name;
      const strippedId = profile.id.replace(/-mailcow$/i, "") || profile.id;
      httpId = allocateId(strippedId, takenIds);
      profiles.push({
        id: httpId,
        name: trimName(strippedName),
        role: "http",
        records: httpRows,
        mailcow: false,
      });
    }

    const mailEffect = effectKey("mail", mailRows, profile.mailcow);
    const existingMail = profiles.find((candidate) => candidate.role === "mail" && profileEffect(candidate) === mailEffect);
    let mailId: string;
    if (existingMail) {
      mailId = existingMail.id;
    } else {
      const isStandardMailcow = profile.mailcow && (profile.id === "web-mailcow" || standardMailcowRecords(mailRows));
      mailId = allocateId(isStandardMailcow ? "mailcow" : `${profile.id}-mail`, takenIds);
      const mailName = isStandardMailcow && mailId === "mailcow"
        ? "Mailcow"
        : trimName(profile.name, " (Mail)");
      profiles.push({
        id: mailId,
        name: mailName,
        role: "mail",
        records: mailRows,
        mailcow: profile.mailcow,
      });
    }

    mapping.set(profile.id, { http: httpId, mail: mailId });
  }

  if (profiles.length > MAX_PROFILES) failAction(`at most ${MAX_PROFILES} profiles`);
  const mailIds = new Set(profiles.filter((profile) => profile.role === "mail").map((profile) => profile.id));

  const assignments: Record<string, SiteAssignment> = {};
  for (const [domain, legacyId] of legacyAssignments) {
    const mapped = mapping.get(legacyId);
    if (mapped && (mapped.http || mapped.mail)) assignments[domain] = { ...mapped };
  }

  const redirects = parseRedirects(
    rawRedirects.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
      const item = entry as Record<string, unknown>;
      const legacyId = typeof item.profileId === "string" ? item.profileId : null;
      const mappedMail = legacyId ? (mapping.get(legacyId)?.mail ?? null) : null;
      return { ...item, mailProfileId: item.mailProfileId ?? mappedMail };
    }),
    mailIds,
  );

  const defaultMapped = legacyDefault ? mapping.get(legacyDefault) : undefined;
  const heldRaw = Array.isArray(raw.held) ? raw.held : [];
  const held = [...new Set(heldRaw.filter((domain): domain is string => typeof domain === "string"
    && (Boolean(assignments[domain]) || redirects.some((redirect) => redirect.source === domain))))];

  return {
    policy: {
      version: 2,
      automatic: base.automatic,
      createIn: base.createIn,
      profiles,
      defaultHttpProfileId: defaultMapped?.http ?? null,
      defaultMailProfileId: defaultMapped?.mail ?? null,
      assignments,
      redirects,
      held,
      knownSiteIds: base.knownSiteIds,
      connections: base.connections,
      powerdns: base.powerdns,
      zoneChoices: base.zoneChoices,
      server: base.server,
      mailcow: base.mailcow,
      panelHost: base.panelHost,
    },
    mapping,
  };
}

function parsePolicyBase(raw: Record<string, unknown>) {
  const legacy = typeof raw.automatic === "boolean" ? { automatic: raw.automatic, createIn: raw.createIn } : legacyAutomatic(raw);
  const choices: Record<string, ZoneChoice> = {};
  for (const [zone, choice] of Object.entries((raw.zoneChoices ?? {}) as Record<string, { connectionId?: unknown; zoneId?: unknown }>)) {
    choices[hostname(zone, "a zone")] = { connectionId: connectionId(choice?.connectionId), zoneId: providerId(choice?.zoneId, "a zone") };
  }
  const createIn = parseAccountRef(legacy.createIn);
  const parsedConnections = parseConnections(raw.connections ?? []);
  const parsedPowerDns = parsePowerDnsConnections(raw.powerdns ?? []);
  const keepCreateIn = createIn && (
    createIn.connectionId.startsWith("pdns-")
      ? parsedPowerDns.some((connection) => connection.id === createIn.connectionId)
      : !parsedConnections.length || parsedConnections.some((connection) => connection.id === createIn.connectionId)
  );
  const serverRaw = (raw.server ?? {}) as Record<string, unknown>;
  const knownSiteIds = [...new Set(((Array.isArray(raw.knownSiteIds) ? raw.knownSiteIds : []) as unknown[])
    .filter((id): id is number => typeof id === "number" && Number.isSafeInteger(id) && id > 0))];
  return {
    automatic: legacy.automatic,
    // Cloudflare connections live in the shared store, so a cf-* createIn stays valid even when policy.json's legacy list is empty.
    createIn: keepCreateIn ? createIn : null,
    connections: parsedConnections,
    powerdns: parsedPowerDns,
    zoneChoices: choices,
    server: {
      ipv4: ipAddress(serverRaw.ipv4, 4, "the server IPv4 override"),
      ipv6: ipAddress(serverRaw.ipv6, 6, "the server IPv6 override"),
    },
    mailcow: parseMailcow(raw.mailcow),
    panelHost: raw.panelHost == null ? null : hostname(raw.panelHost, "the panel hostname"),
    knownSiteIds,
  };
}

/**
 * Collects unmigrated legacy `zone` blocks from an on-disk `policy.json` keyed
 * by v2 profile id. When the on-disk file is still v1, propagates each legacy
 * profile's `zone` block onto the v2 HTTP and Mail profile ids produced by
 * migration so Firewall's edge migration still sees active site and redirect
 * zone options even if DNS saves v2 first.
 */
export function legacyProfileZones(onDisk: unknown): Map<string, unknown> {
  const zones = new Map<string, unknown>();
  if (!onDisk || typeof onDisk !== "object" || Array.isArray(onDisk)) return zones;
  const raw = onDisk as Record<string, unknown>;
  if (!Array.isArray(raw.profiles)) return zones;
  for (const entry of raw.profiles) {
    if (entry && typeof entry === "object" && !Array.isArray(entry)
      && typeof (entry as { id?: unknown }).id === "string" && Object.hasOwn(entry, "zone")) {
      zones.set((entry as { id: string }).id, (entry as { zone: unknown }).zone);
    }
  }
  if (!zones.size || raw.version !== 1 || !raw.assignments || typeof raw.assignments !== "object" || Array.isArray(raw.assignments)) {
    return zones;
  }
  try {
    const { mapping } = migrateV1PolicyWithMapping(raw, parsePolicyBase(raw));
    for (const [legacyId, assigned] of mapping) {
      if (!zones.has(legacyId)) continue;
      const legacyZone = zones.get(legacyId);
      if (assigned.http && !zones.has(assigned.http)) zones.set(assigned.http, legacyZone);
      if (assigned.mail && !zones.has(assigned.mail)) zones.set(assigned.mail, legacyZone);
    }
  } catch {
    // Fall back to direct id matching if the legacy policy cannot be parsed.
  }
  return zones;
}

function parseAssignment(value: unknown, httpIds: Set<string>, mailIds: Set<string>): SiteAssignment | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) failAction("a site assignment is malformed");
  const raw = value as Record<string, unknown>;
  const httpRaw = raw.http == null || raw.http === "" ? null : profileId(raw.http);
  const mailRaw = raw.mail == null || raw.mail === "" ? null : profileId(raw.mail);
  const http = httpRaw && httpIds.has(httpRaw) ? httpRaw : null;
  const mail = mailRaw && mailIds.has(mailRaw) ? mailRaw : null;
  return http || mail ? { http, mail } : null;
}

export function parsePolicy(value: unknown): Policy {
  const raw = (value ?? {}) as Record<string, unknown>;
  if ((raw.version !== 1 && raw.version !== 2) || !Array.isArray(raw.profiles) || !raw.assignments || typeof raw.assignments !== "object" || Array.isArray(raw.assignments)) {
    failAction("the DNS policy is malformed");
  }
  try {
    const base = parsePolicyBase(raw);

    if (raw.version === 1) return migrateV1PolicyWithMapping(raw, base).policy;

    const profiles = (raw.profiles as unknown[]).map(parseProfile);
    if (profiles.length > MAX_PROFILES) failAction(`at most ${MAX_PROFILES} profiles`);
    const seenIds = new Set<string>();
    for (const profile of profiles) {
      if (seenIds.has(profile.id)) failAction(`profile ${profile.id} is listed twice`);
      seenIds.add(profile.id);
    }
    const httpIds = new Set(profiles.filter((profile) => profile.role === "http").map((profile) => profile.id));
    const mailIds = new Set(profiles.filter((profile) => profile.role === "mail").map((profile) => profile.id));
    const assignments: Record<string, SiteAssignment> = {};
    for (const [domain, entry] of Object.entries(raw.assignments as Record<string, unknown>)) {
      const parsed = parseAssignment(entry, httpIds, mailIds);
      if (parsed) assignments[hostname(domain, "an assigned site")] = parsed;
    }
    const redirects = parseRedirects(raw.redirects, mailIds);
    const heldRaw = Array.isArray(raw.held) ? raw.held : [];
    const held = [...new Set(heldRaw.filter((domain): domain is string => typeof domain === "string"
      && (Boolean(assignments[domain]) || redirects.some((redirect) => redirect.source === domain))))];
    const defaultHttp = typeof raw.defaultHttpProfileId === "string" && httpIds.has(raw.defaultHttpProfileId)
      ? raw.defaultHttpProfileId : null;
    const defaultMail = typeof raw.defaultMailProfileId === "string" && mailIds.has(raw.defaultMailProfileId)
      ? raw.defaultMailProfileId : null;

    return {
      version: 2,
      automatic: base.automatic,
      createIn: base.createIn,
      profiles,
      defaultHttpProfileId: defaultHttp,
      defaultMailProfileId: defaultMail,
      assignments,
      redirects,
      held,
      knownSiteIds: base.knownSiteIds,
      connections: base.connections,
      powerdns: base.powerdns,
      zoneChoices: base.zoneChoices,
      server: base.server,
      mailcow: base.mailcow,
      panelHost: base.panelHost,
    };
  } catch (error) {
    if (error instanceof ActionFailure) failAction(`the DNS policy is malformed: ${error.message}`);
    throw error;
  }
}

/** An absolute http(s) URL with no credentials or fragment; with the path kept, no query either, and no trailing slash. */
function redirectTarget(value: unknown, keepPath: boolean): string {
  if (typeof value !== "string") failAction("The target must be a URL, such as https://example.com");
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    failAction("The target must be a URL, such as https://example.com");
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.hash || !dnsName(url.hostname)) {
    failAction("The target must be an http or https URL, such as https://example.com");
  }
  if (keepPath && url.search) failAction("A target that keeps the path cannot have a query string");
  const text = url.href;
  if (/["'$;{}\\\s]/.test(text) || text.length > 1024) failAction("The target has characters a redirect cannot carry");
  return keepPath ? text.replace(/\/+$/, "") : text;
}

export function parseRedirect(value: unknown, mailProfiles?: Set<string>): Redirect {
  if (!value || typeof value !== "object" || Array.isArray(value)) failAction("the redirect is malformed");
  const raw = value as Record<string, unknown>;
  const source = hostname(raw.source, "The redirect's domain");
  const keepPath = flag(raw.keepPath ?? true, "Keep path");
  const target = redirectTarget(raw.target, keepPath);
  const host = new URL(target).hostname;
  if (host === source || host === `www.${source}`) failAction(`${source} cannot redirect to itself`);
  const status = REDIRECT_STATUSES.find((code) => code === Number(raw.status ?? 301));
  if (!status) failAction("The status must be 301, 302, 307 or 308");
  const rawMail = raw.mailProfileId !== undefined ? raw.mailProfileId : raw.profileId;
  const mail = rawMail == null || rawMail === "" ? null : profileId(rawMail);
  return {
    source, target, status, keepPath, keepQuery: flag(raw.keepQuery ?? true, "Keep query string"),
    mailProfileId: mail && (!mailProfiles || mailProfiles.has(mail)) ? mail : null,
  };
}

export function parseRedirects(value: unknown, mailProfiles?: Set<string>): Redirect[] {
  if (value == null) return [];
  if (!Array.isArray(value)) failAction("the redirects must be a list");
  if (value.length > MAX_REDIRECTS) failAction(`at most ${MAX_REDIRECTS} redirect domains`);
  const redirects = value.map((entry) => parseRedirect(entry, mailProfiles));
  const seen = new Set<string>();
  for (const redirect of redirects) {
    if (seen.has(redirect.source)) failAction(`${redirect.source} is listed as a redirect twice`);
    seen.add(redirect.source);
  }
  return redirects.sort((a, b) => a.source.localeCompare(b.source));
}

export function parseSecrets(value: unknown): Secrets {
  const raw = (value ?? {}) as Partial<Secrets>;
  const cloudflare: Record<string, string> = {};
  for (const [id, token] of Object.entries(raw.cloudflare ?? {})) {
    if (typeof token === "string" && token) cloudflare[connectionId(id)] = token;
  }
  const powerdns: Record<string, string> = {};
  for (const [id, key] of Object.entries(raw.powerdns ?? {})) {
    if (typeof key === "string" && key) powerdns[connectionId(id)] = key;
  }
  return { cloudflare, powerdns, mailcowKey: typeof raw.mailcowKey === "string" ? raw.mailcowKey : "" };
}

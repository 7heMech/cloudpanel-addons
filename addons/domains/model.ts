import { isIP } from "node:net";
import { validateDomain } from "../../lib/app-http";

export type Mode = "report" | "enforce";
export type RecordType = "A" | "AAAA" | "CNAME" | "MX" | "TXT" | "SRV";
export interface RecordTemplate {
  type: RecordType;
  name: string;
  content: string;
  apexOnly?: boolean;
  proxy?: "web" | "on" | "off";
  priority?: number;
  data?: { priority: number; weight: number; port: number; target: string };
}
export interface Profile {
  id: string;
  name: string;
  mode: Mode;
  serverIpv4: string;
  serverIpv6: string;
  mailEnabled: boolean;
  mailHost: string;
  mailIpv4: string;
  mailIpv6: string;
  webmailHost: string;
  spfIncludes: string[];
  spfByDomain: Record<string, string[]>;
  sharedMailbox: string;
  dkimSource: string;
  dkimSelector: string;
  dkimBits: number;
  webProxied: boolean;
  proxyAfterCertificate: boolean;
  createZones: boolean;
  zoneSettings: boolean;
  acmeRule: boolean;
  webmailRule: boolean;
  mainwpIps: string[];
  templates: RecordTemplate[];
}
export interface Connections { accountId: string; cloudflareToken: string; mailcowUrl: string; mailcowKey: string }
export interface Policy {
  version: 1;
  profiles: Profile[];
  defaultProfileId: string | null;
  assignments: Record<string, string>;
  knownSiteIds: number[];
}
export interface PanelSite { id: number; domain: string; type: string; certificateReady: boolean; certificateNames: string[]; placeholder: boolean; cloudflareOnly: boolean }
export interface DnsRecord {
  id?: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
  proxied?: boolean;
  priority?: number;
  data?: { priority: number; weight: number; port: number; target: string };
  comment?: string;
  tags?: string[];
}
export interface Zone { id: string; name: string; status: string; nameServers: string[] }
export interface Change {
  action: "create" | "update" | "delete" | "conflict";
  service: "dns" | "mailcow" | "zone" | "rule";
  name: string;
  detail: string;
  before?: DnsRecord;
  after?: DnsRecord;
  conflict?: boolean;
  deferred?: boolean;
}
export interface SitePlan {
  domain: string;
  type: string;
  profileId: string | null;
  mode: Mode;
  certificateReady: boolean;
  waitingCertificate: boolean;
  unproxiedWeb?: boolean;
  hasWebAddress?: boolean;
  zone: Zone | null;
  changes: Change[];
  errors: string[];
  cloudflareOnly?: boolean;
  ssl?: { requested: boolean; attempts: number; state: string; nextAttemptAt: number };
}
export interface Orphan { domain: string; zoneId: string; zoneName: string; records: DnsRecord[] }
export interface State {
  profiles: Profile[];
  defaultProfileId: string | null;
  connections: { accountId: string; mailcowUrl: string; hasCloudflareToken: boolean; hasMailcowKey: boolean };
  detectedIps: { ipv4: string; ipv6: string };
  sites: SitePlan[];
  orphans: Orphan[];
  scannedAt: string | null;
  errors: string[];
  retryAt: number;
}
export interface Review { token: string; title: string; sites: SitePlan[]; removal?: Orphan; expiresAt: number; blocked?: boolean }
export interface Reply extends State { review?: Review }

export const DEFAULT_TEMPLATES: RecordTemplate[] = [
  { type: "A", name: "{domain}", content: "{server.ipv4}", proxy: "web" },
  { type: "AAAA", name: "{domain}", content: "{server.ipv6}", proxy: "web" },
  { type: "A", name: "www.{domain}", content: "{server.ipv4}", proxy: "web", apexOnly: true },
  { type: "AAAA", name: "www.{domain}", content: "{server.ipv6}", proxy: "web", apexOnly: true },
  { type: "MX", name: "{domain}", content: "{mail.host}", priority: 10 },
  { type: "TXT", name: "{domain}", content: "{spf}" },
  { type: "TXT", name: "{selector}._domainkey.{domain}", content: "{dkim}" },
  { type: "CNAME", name: "autoconfig.{domain}", content: "{mail.host}", proxy: "off" },
  { type: "CNAME", name: "autodiscover.{domain}", content: "{mail.host}", proxy: "off" },
  { type: "SRV", name: "_autodiscover._tcp.{domain}", content: "", data: { priority: 0, weight: 0, port: 443, target: "{mail.host}" } },
  { type: "CNAME", name: "webmail.{domain}", content: "{webmail.host}", proxy: "on", apexOnly: true },
];
export const PRESET_PROFILE: Profile = {
  id: "cloudpanel-mailcow", name: "CloudPanel + Mailcow", mode: "report",
  serverIpv4: "", serverIpv6: "", mailEnabled: true, mailHost: "mail.example.com",
  mailIpv4: "192.0.2.25", mailIpv6: "2001:db8::25", webmailHost: "webmail.example.com",
  spfIncludes: [], spfByDomain: {}, sharedMailbox: "relay@example.com", dkimSource: "",
  dkimSelector: "dkim", dkimBits: 2048, webProxied: true, proxyAfterCertificate: false, createZones: false,
  zoneSettings: true, acmeRule: true, webmailRule: true, mainwpIps: [], templates: DEFAULT_TEMPLATES,
};

export const emptyPolicy = (): Policy => ({ version: 1, profiles: [structuredClone(PRESET_PROFILE)], defaultProfileId: null, assignments: {}, knownSiteIds: [] });
export function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
export function text(value: unknown, label: string, max = 253): string {
  if (typeof value !== "string" || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`${label} is invalid`);
  return value.trim();
}
export function domain(value: unknown, label = "Domain"): string {
  const result = validateDomain(value);
  if (!result) throw new Error(`${label} must be a hostname`);
  return result;
}
function flag(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be on or off`);
  return value;
}
function integer(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label} is invalid`);
  return value;
}
function list(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be a list`);
  return value;
}
function includes(value: unknown): string[] {
  return [...new Set(list(value, "SPF includes").map((v) => {
    const name = text(v, "SPF include").replace(/^include:/, "").toLowerCase().replace(/\.$/, "");
    if (!recordName(name) || name.startsWith("*.")) throw new Error("SPF include must be a DNS hostname");
    return name;
  }))];
}
function ip(value: unknown, family: number, label: string): string {
  const result = text(value, label);
  if (result && isIP(result) !== family) throw new Error(`${label} must be IPv${family}`);
  return result;
}
export function recordName(value: string): boolean {
  return value.length <= 253 && /^(?:\*\.)?[a-z0-9_](?:[a-z0-9_-]{0,62})(?:\.[a-z0-9_][a-z0-9_-]{0,62})+$/.test(value);
}
export function parseProfile(value: unknown): Profile {
  const v = object(value, "Profile");
  const id = text(v.id, "Profile id", 64);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error("Profile id is invalid");
  const name = text(v.name, "Profile name", 80);
  if (!name || !["report", "enforce"].includes(String(v.mode))) throw new Error("Profile name or mode is invalid");
  const spfByDomain = Object.fromEntries(Object.entries(object(v.spfByDomain, "Per-domain SPF includes")).map(([k, val]) => [domain(k), includes(val)]));
  const templates = list(v.templates, "Record templates").map((raw): RecordTemplate => {
    const t = object(raw, "Record template");
    if (!["A", "AAAA", "CNAME", "MX", "TXT", "SRV"].includes(String(t.type))) throw new Error("Unsupported record template type");
    const result: RecordTemplate = { type: t.type as RecordType, name: text(t.name, "Record name", 512), content: text(t.content, "Record content", 16_384) };
    if (t.apexOnly !== undefined) result.apexOnly = flag(t.apexOnly, "Apex only");
    if (t.proxy !== undefined) {
      if (!["web", "on", "off"].includes(String(t.proxy))) throw new Error("Proxy mode is invalid");
      if (!["A", "AAAA", "CNAME"].includes(result.type)) throw new Error("Only address and CNAME records can be proxied");
      result.proxy = t.proxy as RecordTemplate["proxy"];
    }
    if (t.priority !== undefined) result.priority = integer(t.priority, 0, 65535, "Priority");
    if (result.type === "MX" && result.priority === undefined) throw new Error("MX requires a priority");
    if (result.type === "SRV") {
      const d = object(t.data, "SRV data");
      result.data = { priority: integer(d.priority, 0, 65535, "SRV priority"), weight: integer(d.weight, 0, 65535, "SRV weight"), port: integer(d.port, 1, 65535, "SRV port"), target: text(d.target, "SRV target", 512) };
    }
    return result;
  });
  const p: Profile = {
    id, name, mode: v.mode as Mode,
    serverIpv4: ip(v.serverIpv4, 4, "Server IPv4"), serverIpv6: ip(v.serverIpv6, 6, "Server IPv6"),
    mailEnabled: flag(v.mailEnabled, "Mail setup"), mailHost: v.mailHost ? domain(v.mailHost, "Mail host") : "",
    mailIpv4: ip(v.mailIpv4, 4, "Mail IPv4"), mailIpv6: ip(v.mailIpv6, 6, "Mail IPv6"),
    webmailHost: v.webmailHost ? domain(v.webmailHost, "Webmail host") : "",
    spfIncludes: includes(v.spfIncludes), spfByDomain,
    sharedMailbox: text(v.sharedMailbox, "Shared mailbox", 254), dkimSource: v.dkimSource ? domain(v.dkimSource, "DKIM source") : "",
    dkimSelector: text(v.dkimSelector, "DKIM selector", 63), dkimBits: integer(v.dkimBits, 1024, 4096, "DKIM bits"),
    webProxied: flag(v.webProxied, "Web proxy"),
    proxyAfterCertificate: flag(v.proxyAfterCertificate, "Certificate ordering"), createZones: flag(v.createZones, "Zone creation"),
    zoneSettings: flag(v.zoneSettings, "Zone settings"), acmeRule: flag(v.acmeRule, "ACME rule"),
    webmailRule: flag(v.webmailRule, "Webmail rule"), mainwpIps: [...new Set(list(v.mainwpIps, "MainWP IPs").map((v) => {
      const result = text(v, "MainWP IP"); if (!isIP(result)) throw new Error("MainWP IP is invalid"); return result;
    }))], templates,
  };
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(p.dkimSelector) || ![1024, 2048, 3072, 4096].includes(p.dkimBits)) throw new Error("DKIM selector or key size is invalid");
  if (p.sharedMailbox && !/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[^@]+$/.test(p.sharedMailbox)) throw new Error("Shared mailbox must be an email address");
  if (p.sharedMailbox) domain(p.sharedMailbox.split("@")[1], "Shared mailbox domain");
  if (p.webProxied && !p.proxyAfterCertificate && !p.acmeRule && p.templates.some((t) => t.proxy === "web")) throw new Error("Choose the ACME rule or proxy after certificate for web proxying");
  return p;
}

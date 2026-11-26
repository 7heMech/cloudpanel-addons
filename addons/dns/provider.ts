/**
 * Provider-neutral DNS adapter types and capability flags. Each DNS provider
 * (Cloudflare, PowerDNS, and follow-on adapters such as Hetzner Cloud DNS or
 * netcup CCP DNS) implements `DnsProvider`, while Cloudflare-only edge
 * features sit behind the optional `edge` client.
 */
import type { TokenAccess } from "../../lib/cloudflare/access";
import type { CfRuleset, RuleWrite } from "../../lib/cloudflare/api";

export type ProviderKind = "cloudflare" | "powerdns";

export const PROVIDER_LABELS: Record<ProviderKind, string> = {
  cloudflare: "Cloudflare",
  powerdns: "PowerDNS",
};

export interface ProviderCapabilities {
  /** Whether records can be proxied through the provider's edge. */
  proxy: boolean;
  /** Whether the provider exposes zone-wide SSL/TLS and HTTPS settings. */
  zoneSettings: boolean;
  /** Whether the provider exposes zone-wide HTTP config and firewall rulesets. */
  zoneRules: boolean;
  /** Whether redirect domains can run as edge redirect rules without a local stand-in site. */
  edgeRedirects: boolean;
  /** Whether this connection can create missing zones automatically. */
  createZone: boolean;
  /** Whether `ttl: 1` means provider-managed Auto TTL; false resolves 1 to `defaultTtl`. */
  autoTtl: boolean;
  /** Whether records store per-record comments returned on read. */
  comments: boolean;
}

export interface DnsAccount {
  id: string;
  name: string;
}

export interface DnsZone {
  id: string;
  name: string;
  status: string;
  nameServers: string[];
  account: DnsAccount;
}

export interface DnsRecord {
  id: string;
  type: string;
  name: string;
  /** TXT unquoted; SRV and CAA as their text form; CNAME/MX targets without trailing dot. */
  content: string;
  proxied: boolean;
  ttl: number;
  priority: number | null;
  comment: string | null;
}

export type RecordWrite = Pick<DnsRecord, "type" | "name" | "content" | "proxied" | "ttl" | "priority">;

export interface RecordOp {
  action: "create" | "update" | "delete";
  record: RecordWrite;
  /** The published record an update or delete acts on. */
  current?: DnsRecord;
}

export interface ProviderCheckResult {
  active: boolean;
  status: string;
  accounts: DnsAccount[];
  zones: DnsZone[];
  error: string | null;
  /** Cloudflare token access policy read; omitted by providers without token introspection. */
  token?: TokenAccess;
}

export interface CloudflareEdgeClient {
  setting(zoneId: string, setting: string): Promise<string>;
  setSetting(zoneId: string, setting: string, value: string): Promise<void>;
  entrypoint(zoneId: string, phase: string): Promise<CfRuleset | null>;
  createEntrypoint(zoneId: string, phase: string, rules: RuleWrite[]): Promise<CfRuleset>;
  addRule(zoneId: string, phase: string, rulesetId: string, rule: RuleWrite): Promise<CfRuleset>;
  updateRule(zoneId: string, phase: string, rulesetId: string, ruleId: string, rule: RuleWrite): Promise<CfRuleset>;
  deleteRule(zoneId: string, phase: string, rulesetId: string, ruleId: string): Promise<void>;
}

export interface DnsProvider {
  readonly kind: ProviderKind;
  readonly capabilities: ProviderCapabilities;
  readonly defaultTtl: number;
  readonly edge?: CloudflareEdgeClient;

  discover(readTokens?: boolean): Promise<ProviderCheckResult>;
  listZones(): Promise<DnsZone[]>;
  createZone?(name: string, accountId?: string): Promise<DnsZone>;
  listRecords(zone: DnsZone): Promise<DnsRecord[]>;
  /**
   * Applies `ops` to `zone` starting from `currentRecords`, returning the
   * updated full record list. Calls `onApplied` after each persisted operation
   * (per record on Cloudflare, or for every op after an atomic RRset PATCH).
   */
  applyRecords(
    zone: DnsZone,
    ops: RecordOp[],
    currentRecords: DnsRecord[],
    options?: { comment?: string; onApplied?: (op: RecordOp, records: DnsRecord[]) => void },
  ): Promise<DnsRecord[]>;
  refusedPermissions?(): string[];
}

/** Normalizes a desired record to what `provider` supports before diffing. */
export function normalizeRecordForProvider(
  record: RecordWrite,
  provider: Pick<DnsProvider, "capabilities" | "defaultTtl">,
): RecordWrite {
  const proxied = provider.capabilities.proxy ? record.proxied : false;
  const ttl = proxied ? 1 : !provider.capabilities.autoTtl && record.ttl === 1 ? provider.defaultTtl : record.ttl;
  return proxied === record.proxied && ttl === record.ttl ? record : { ...record, proxied, ttl };
}

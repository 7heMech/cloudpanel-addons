/**
 * PowerDNS Authoritative Server HTTP API v1 adapter.
 *
 * Uses `ProviderHttp` (no redirects, 15-second timeout, 8 MiB response cap,
 * `X-API-Key` header), enforces HTTPS on public hosts while allowing plain HTTP
 * on loopback, RFC 1918, RFC 6598 (Tailscale) and IPv6 ULA addresses, formats
 * records in PowerDNS master-file wire form (trailing dots, UTF-8 byte-safe
 * 255-octet TXT chunking), and sends atomic RRset PATCHes that preserve
 * unmanaged records sharing the same `(name, type)`.
 */
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { failAction } from "../../lib/action";
import { dnsName, unquoteTxt } from "../../lib/dns-name";
import { errorMessage } from "../../lib/errors";
import { type ApiFetch, ProviderError, ProviderHttp } from "../../lib/provider-http";
import type {
  DnsProvider, DnsRecord, DnsZone, ProviderCapabilities, ProviderCheckResult, RecordOp, RecordWrite,
} from "./provider";

export const DEFAULT_POWERDNS_SERVER_ID = "localhost";
export const DEFAULT_POWERDNS_TTL = 300;
const MIN_POWERDNS_TTL = 60;
const MAX_POWERDNS_TTL = 86400;
const MAX_NAMESERVERS = 16;

export interface PowerDnsConfig {
  label: string;
  url: string;
  serverId: string;
  defaultTtl: number;
  createZones: boolean;
  nameservers: string[];
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

/** Expands an IPv6 literal into eight 16-bit groups, or returns null if malformed. */
function parseIpv6Groups(ip: string): number[] | null {
  if (isIP(ip) !== 6) return null;
  let normalized = ip.toLowerCase();
  const lastColon = normalized.lastIndexOf(":");
  if (normalized.includes(".")) {
    const v4 = normalized.slice(lastColon + 1).split(".").map(Number);
    if (v4.length !== 4 || v4.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
    const hi = ((v4[0]! << 8) | v4[1]!).toString(16);
    const lo = ((v4[2]! << 8) | v4[3]!).toString(16);
    normalized = `${normalized.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":").filter(Boolean) : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":").filter(Boolean) : [];
  const missing = 8 - (left.length + right.length);
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const parts = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  const groups = parts.map((part) => Number.parseInt(part, 16));
  if (groups.length !== 8 || groups.some((group) => !Number.isInteger(group) || group < 0 || group > 0xffff)) return null;
  return groups;
}

/** Whether plain HTTP is allowed to reach `bareHost` without TLS. */
export function isPrivatePowerDnsHost(bareHost: string): boolean {
  const host = bareHost.toLowerCase();
  if (host === "localhost") return true;
  if (isIP(host) === 4) {
    const octets = host.split(".").map(Number);
    const [a, b] = octets;
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 10) return true; // 10.0.0.0/8 RFC 1918
    if (a === 172 && b! >= 16 && b! <= 31) return true; // 172.16.0.0/12 RFC 1918
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 RFC 1918
    if (a === 100 && b! >= 64 && b! <= 127) return true; // 100.64.0.0/10 RFC 6598 (Tailscale)
    return false;
  }
  if (isIP(host) === 6) {
    const groups = parseIpv6Groups(host);
    if (!groups) return false;
    // ::1 loopback
    if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true;
    // fc00::/7 Unique Local Address (ULA)
    if ((groups[0]! & 0xfe00) === 0xfc00) return true;
    return false;
  }
  return false;
}

/**
 * Validates and normalizes a PowerDNS API base URL. Accepts `https://` for any
 * host and `http://` only for loopback, RFC 1918, RFC 6598 (100.64.0.0/10),
 * and IPv6 ULA (fc00::/7). Strips trailing slashes and an optional `/api/v1`.
 */
export function parsePowerDnsUrl(value: unknown): string {
  if (typeof value !== "string") failAction("The PowerDNS URL must be an https:// or private http:// URL");
  const text = value.trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    failAction("The PowerDNS URL must be a valid URL, such as https://ns1.example.com or http://127.0.0.1:8081");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    failAction("The PowerDNS URL must start with https:// or http://");
  }
  if (url.username || url.password) failAction("The PowerDNS URL must not include credentials");
  if (url.search || url.hash) failAction("The PowerDNS URL must not include a query string or fragment");
  const bareHost = url.hostname.startsWith("[") && url.hostname.endsWith("]")
    ? url.hostname.slice(1, -1).toLowerCase()
    : url.hostname.toLowerCase();
  if (!bareHost || (bareHost !== "localhost" && isIP(bareHost) === 0 && !dnsName(bareHost))) {
    failAction("The PowerDNS URL must have a valid hostname or IP address");
  }
  if (url.protocol === "http:" && !isPrivatePowerDnsHost(bareHost)) {
    failAction("Plain HTTP is only allowed for localhost, RFC 1918, Tailscale (100.64.0.0/10) or IPv6 ULA addresses; use https:// for public PowerDNS endpoints");
  }
  const cleanPath = url.pathname.replace(/\/+$/, "").replace(/\/api\/v1$/i, "");
  return `${url.origin}${cleanPath}`;
}

export function parsePowerDnsServerId(value: unknown): string {
  if (value === "" || value == null) return DEFAULT_POWERDNS_SERVER_ID;
  if (typeof value !== "string") failAction("The PowerDNS server ID must be text");
  const id = value.trim();
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(id)) failAction("The PowerDNS server ID must be letters, digits, dots, dashes or underscores");
  return id;
}

export function parsePowerDnsDefaultTtl(value: unknown): number {
  if (value === "" || value == null) return DEFAULT_POWERDNS_TTL;
  const ttl = typeof value === "string" ? Number(value.trim()) : value;
  if (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl < MIN_POWERDNS_TTL || ttl > MAX_POWERDNS_TTL) {
    failAction(`The PowerDNS default TTL must be a whole number from ${MIN_POWERDNS_TTL} to ${MAX_POWERDNS_TTL}`);
  }
  return ttl;
}

export function parsePowerDnsApiKey(value: unknown): string {
  if (typeof value !== "string") failAction("The PowerDNS API key must be text");
  const key = value.trim();
  if (!/^[\x21-\x7e]{8,512}$/.test(key)) failAction("The PowerDNS API key must be 8 to 512 printable characters with no spaces");
  return key;
}

export function parsePowerDnsNameservers(value: unknown, required: boolean): string[] {
  const rawList = value == null ? []
    : typeof value === "string" ? value.split(/[\s,]+/).filter(Boolean)
    : Array.isArray(value) ? value
    : failAction("PowerDNS nameservers must be a list of hostnames");
  const parsed: string[] = [];
  const seen = new Set<string>();
  for (const entry of rawList) {
    if (typeof entry !== "string") failAction("Each PowerDNS nameserver must be a hostname");
    const host = entry.trim().toLowerCase().replace(/\.$/, "");
    if (!host) continue;
    if (!dnsName(host) || host.startsWith("*.")) failAction(`${host} is not a valid nameserver hostname`);
    if (!seen.has(host)) {
      seen.add(host);
      parsed.push(host);
    }
  }
  if (parsed.length > MAX_NAMESERVERS) failAction(`At most ${MAX_NAMESERVERS} PowerDNS nameservers can be configured`);
  if (required && !parsed.length) failAction("Enter at least one nameserver to enable creating PowerDNS zones");
  return parsed;
}

// ---------------------------------------------------------------------------
// Wire formatting and parsing
// ---------------------------------------------------------------------------

export function ensureTrailingDot(name: string): string {
  return name.endsWith(".") ? name : `${name}.`;
}

export function stripTrailingDot(name: string): string {
  return name.replace(/\.+$/, "");
}

/**
 * Splits a TXT string into quoted master-file character strings of at most 255
 * UTF-8 octets each, never splitting a multi-byte Unicode code point.
 */
export function quotePowerDnsTxt(value: string): string {
  if (value.length === 0) return '""';
  const chunks: string[] = [];
  let current = "";
  let bytes = 0;
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (bytes + charBytes > 255) {
      chunks.push(`"${current}"`);
      current = "";
      bytes = 0;
    }
    current += char === '"' || char === "\\" ? `\\${char}` : char;
    bytes += charBytes;
  }
  if (current.length > 0 || chunks.length === 0) chunks.push(`"${current}"`);
  return chunks.join(" ");
}

/** Formats a canonical `RecordWrite` into PowerDNS master-file record content. */
export function formatPowerDnsContent(record: RecordWrite): string {
  const type = record.type.toUpperCase();
  if (type === "CNAME") return ensureTrailingDot(record.content.trim().toLowerCase());
  if (type === "MX") return `${record.priority ?? 0} ${ensureTrailingDot(record.content.trim().toLowerCase())}`;
  if (type === "SRV") {
    const [weight, port, target] = record.content.trim().split(/\s+/);
    return `${record.priority ?? 0} ${Number(weight)} ${Number(port)} ${ensureTrailingDot(target!.toLowerCase())}`;
  }
  if (type === "CAA") {
    const match = /^(\d+)\s+(\S+)\s+"?(.*?)"?$/.exec(record.content.trim());
    return match ? `${Number(match[1])} ${match[2]!.toLowerCase()} "${match[3]}"` : record.content.trim();
  }
  if (type === "TXT") return quotePowerDnsTxt(record.content);
  return record.content.trim();
}

/** Deterministic synthetic ID for PowerDNS records, which have no provider UUID. */
export function powerDnsRecordId(type: string, name: string, content: string, priority: number | null): string {
  const key = `${type.toUpperCase()}|${name.toLowerCase()}|${priority ?? ""}|${content}`;
  return `pdns:${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderError("PowerDNS", "returned a reply this addon does not understand");
  }
  return value as Record<string, unknown>;
}

function asText(value: unknown, max = 4096): string {
  if (typeof value !== "string" || value.length > max) {
    throw new ProviderError("PowerDNS", "returned a value this addon does not understand");
  }
  return value;
}

function parseZoneId(value: unknown): string {
  const raw = asText(value, 260).trim();
  if (!raw || /[\u0000-\u001f\u007f/\s]/.test(raw)) {
    throw new ProviderError("PowerDNS", "returned a zone identifier this addon does not understand");
  }
  return raw;
}

function parsePriority(raw: string, name: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new ProviderError("PowerDNS", `returned an invalid priority for ${name}`);
  }
  return value;
}

function parseRrsetRecord(rrsetName: string, rrsetType: string, ttl: number, rawContent: string): DnsRecord {
  const type = rrsetType.toUpperCase();
  const name = stripTrailingDot(rrsetName.toLowerCase());
  let content = rawContent.trim();
  let priority: number | null = null;

  if (type === "A") {
    if (isIP(content) !== 4) throw new ProviderError("PowerDNS", `returned an address record for ${name} that is not an IPv4 address`);
  } else if (type === "AAAA") {
    if (isIP(content) !== 6) throw new ProviderError("PowerDNS", `returned an address record for ${name} that is not an IPv6 address`);
  } else if (type === "CNAME") {
    content = stripTrailingDot(content.toLowerCase());
  } else if (type === "MX") {
    const match = /^(\d+)\s+(\S+)$/.exec(content);
    if (!match) throw new ProviderError("PowerDNS", `returned a malformed MX record for ${name}`);
    priority = parsePriority(match[1]!, name);
    content = stripTrailingDot(match[2]!.toLowerCase());
  } else if (type === "SRV") {
    const match = /^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)$/.exec(content);
    if (!match) throw new ProviderError("PowerDNS", `returned a malformed SRV record for ${name}`);
    priority = parsePriority(match[1]!, name);
    const weight = parsePriority(match[2]!, name);
    const port = parsePriority(match[3]!, name);
    content = `${weight} ${port} ${stripTrailingDot(match[4]!.toLowerCase())}`;
  } else if (type === "CAA") {
    const match = /^(\d+)\s+(\S+)\s+"?(.*?)"?$/.exec(content);
    if (!match) throw new ProviderError("PowerDNS", `returned a malformed CAA record for ${name}`);
    content = `${Number(match[1])} ${match[2]!.toLowerCase()} "${match[3]}"`;
  } else if (type === "TXT") {
    content = unquoteTxt(content);
  }

  return {
    id: powerDnsRecordId(type, name, content, priority),
    type,
    name,
    content,
    proxied: false,
    ttl,
    priority,
    comment: null,
  };
}

// ---------------------------------------------------------------------------
// Provider client
// ---------------------------------------------------------------------------

interface PowerDnsRrsetPatch {
  name: string;
  type: string;
  changetype: "REPLACE" | "DELETE";
  ttl?: number;
  records?: { content: string; disabled: boolean }[];
}

export class PowerDnsProvider implements DnsProvider {
  readonly kind = "powerdns" as const;
  readonly capabilities: ProviderCapabilities;
  readonly defaultTtl: number;
  readonly http: ProviderHttp;
  /** Disabled RRset entries per zone from the latest listRecords read, preserved verbatim across writes. */
  private readonly disabledByZone = new Map<string, Map<string, { content: string; ttl: number }[]>>();

  constructor(
    private readonly config: PowerDnsConfig,
    apiKey: string,
    fetcher?: ApiFetch,
    backoff?: { until: number },
  ) {
    this.defaultTtl = config.defaultTtl;
    this.capabilities = {
      proxy: false,
      zoneSettings: false,
      zoneRules: false,
      edgeRedirects: false,
      createZone: config.createZones,
      autoTtl: false,
      comments: false,
    };
    this.http = new ProviderHttp("PowerDNS", config.url, { "X-API-Key": apiKey }, fetcher, backoff);
  }

  private serverPath(rest = ""): string {
    return `/api/v1/servers/${encodeURIComponent(this.config.serverId)}${rest}`;
  }

  private async call(path: string, method = "GET", body?: unknown): Promise<unknown> {
    const { status, json } = await this.http.request(path, method, body);
    if (status >= 200 && status < 300) return json;
    const raw = json && typeof json === "object" && !Array.isArray(json) ? json as Record<string, unknown> : {};
    const detail = typeof raw.error === "string" && raw.error.trim()
      ? this.http.clean(raw.error.trim()).slice(0, 200)
      : `HTTP ${status}`;
    throw new ProviderError("PowerDNS", detail, status);
  }

  private parseZone(value: unknown, nameServers: string[] = []): DnsZone {
    const raw = asObject(value);
    const zoneId = parseZoneId(raw.id ?? raw.name);
    const name = stripTrailingDot(asText(raw.name, 255).toLowerCase());
    if (!dnsName(name)) throw new ProviderError("PowerDNS", "returned a zone with an invalid name");
    return {
      id: zoneId,
      name,
      status: "active",
      nameServers,
      account: { id: this.config.serverId, name: this.config.label },
    };
  }

  async discover(): Promise<ProviderCheckResult> {
    try {
      const server = asObject(await this.call(this.serverPath()));
      const daemon = typeof server.daemon_type === "string" ? server.daemon_type.toLowerCase() : "authoritative";
      if (daemon && daemon !== "authoritative") {
        return {
          active: false,
          status: "invalid",
          accounts: [],
          zones: [],
          error: `PowerDNS endpoint is a ${daemon} server, not an authoritative server`,
        };
      }
      const zones = await this.listZones();
      const accounts = this.config.createZones
        ? [{ id: this.config.serverId, name: this.config.label }]
        : [];
      return { active: true, status: "active", accounts, zones, error: null };
    } catch (error) {
      return { active: false, status: "error", accounts: [], zones: [], error: errorMessage(error) };
    }
  }

  async listZones(): Promise<DnsZone[]> {
    const result = await this.call(this.serverPath("/zones"));
    if (!Array.isArray(result)) throw new ProviderError("PowerDNS", "returned a zone list this addon does not understand");
    return result.map((entry) => this.parseZone(entry));
  }

  async createZone(name: string): Promise<DnsZone> {
    if (!this.config.createZones) {
      throw new ProviderError("PowerDNS", "zone creation is disabled for this connection");
    }
    if (!this.config.nameservers.length) {
      throw new ProviderError("PowerDNS", "configure at least one nameserver before creating zones");
    }
    const created = await this.call(this.serverPath("/zones"), "POST", {
      name: ensureTrailingDot(name.toLowerCase()),
      kind: "Native",
      nameservers: this.config.nameservers.map(ensureTrailingDot),
    });
    return this.parseZone(created, [...this.config.nameservers]);
  }

  async listRecords(zone: DnsZone): Promise<DnsRecord[]> {
    const raw = asObject(await this.call(this.serverPath(`/zones/${encodeURIComponent(zone.id)}`)));
    const rrsets = raw.rrsets;
    if (!Array.isArray(rrsets)) throw new ProviderError("PowerDNS", "returned a zone without rrsets");
    const records: DnsRecord[] = [];
    const disabled = new Map<string, { content: string; ttl: number }[]>();
    for (const entry of rrsets) {
      const rrset = asObject(entry);
      const rrsetName = asText(rrset.name, 255);
      const rrsetType = asText(rrset.type, 16).toUpperCase();
      const ttl = Number(rrset.ttl ?? this.defaultTtl);
      if (!Number.isInteger(ttl) || ttl < 0) {
        throw new ProviderError("PowerDNS", `returned an invalid TTL for ${stripTrailingDot(rrsetName)}`);
      }
      const key = `${rrsetType}|${stripTrailingDot(rrsetName).toLowerCase()}`;
      const items = Array.isArray(rrset.records) ? rrset.records : [];
      for (const item of items) {
        const record = asObject(item);
        const content = asText(record.content, 4096);
        if (record.disabled === true) {
          const list = disabled.get(key) ?? [];
          list.push({ content, ttl });
          disabled.set(key, list);
          continue;
        }
        records.push(parseRrsetRecord(rrsetName, rrsetType, ttl, content));
      }
    }
    this.disabledByZone.set(zone.id, disabled);
    return records;
  }

  async applyRecords(
    zone: DnsZone,
    ops: RecordOp[],
    currentRecords: DnsRecord[],
    options: { comment?: string; onApplied?: (op: RecordOp, records: DnsRecord[]) => void } = {},
  ): Promise<DnsRecord[]> {
    if (!ops.length) return [...currentRecords];

    const touched = new Map<string, { name: string; type: string; preferredTtl?: number }>();
    const mark = (name: string, type: string, ttl?: number) => {
      const key = `${type.toUpperCase()}|${name.toLowerCase()}`;
      const existing = touched.get(key) ?? { name: name.toLowerCase(), type: type.toUpperCase() };
      if (ttl !== undefined) existing.preferredTtl = ttl;
      touched.set(key, existing);
    };

    const nextRecords: DnsRecord[] = currentRecords.map((record) => ({ ...record }));
    for (const op of ops) {
      if (op.action === "delete") {
        const target = op.current!;
        mark(target.name, target.type);
        const index = nextRecords.findIndex((record) => record.id === target.id);
        if (index >= 0) nextRecords.splice(index, 1);
      } else if (op.action === "update") {
        const target = op.current!;
        const ttl = op.record.ttl === 1 ? this.defaultTtl : op.record.ttl;
        mark(target.name, target.type);
        mark(op.record.name, op.record.type, ttl);
        const updated: DnsRecord = {
          id: powerDnsRecordId(op.record.type, op.record.name, op.record.content, op.record.priority),
          type: op.record.type.toUpperCase(),
          name: op.record.name.toLowerCase(),
          content: op.record.content,
          proxied: false,
          ttl,
          priority: op.record.priority,
          comment: null,
        };
        const index = nextRecords.findIndex((record) => record.id === target.id);
        if (index >= 0) nextRecords[index] = updated;
        else nextRecords.push(updated);
      } else {
        const ttl = op.record.ttl === 1 ? this.defaultTtl : op.record.ttl;
        mark(op.record.name, op.record.type, ttl);
        nextRecords.push({
          id: powerDnsRecordId(op.record.type, op.record.name, op.record.content, op.record.priority),
          type: op.record.type.toUpperCase(),
          name: op.record.name.toLowerCase(),
          content: op.record.content,
          proxied: false,
          ttl,
          priority: op.record.priority,
          comment: null,
        });
      }
    }

    const rrsets: PowerDnsRrsetPatch[] = [];
    const disabledMap = this.disabledByZone.get(zone.id);
    for (const { name, type, preferredTtl } of touched.values()) {
      const key = `${type}|${name}`;
      const remaining = nextRecords.filter((record) => record.name === name && record.type === type);
      const disabledSiblings = disabledMap?.get(key) ?? [];
      if (!remaining.length && !disabledSiblings.length) {
        rrsets.push({ name: ensureTrailingDot(name), type, changetype: "DELETE" });
        continue;
      }
      const ttl = preferredTtl ?? remaining[0]?.ttl ?? disabledSiblings[0]?.ttl ?? this.defaultTtl;
      // PowerDNS stores a single TTL per RRset, so every record in this RRset adopts it.
      for (const record of remaining) record.ttl = ttl;
      for (const sibling of disabledSiblings) sibling.ttl = ttl;
      const seen = new Set<string>();
      const wireRecords: { content: string; disabled: boolean }[] = [];
      for (const record of remaining) {
        const wire = formatPowerDnsContent(record);
        if (seen.has(wire)) continue;
        seen.add(wire);
        wireRecords.push({ content: wire, disabled: false });
      }
      for (const sibling of disabledSiblings) {
        if (seen.has(sibling.content)) continue;
        seen.add(sibling.content);
        wireRecords.push({ content: sibling.content, disabled: true });
      }
      rrsets.push({
        name: ensureTrailingDot(name),
        type,
        ttl,
        changetype: "REPLACE",
        records: wireRecords,
      });
    }

    await this.call(this.serverPath(`/zones/${encodeURIComponent(zone.id)}`), "PATCH", { rrsets });
    for (const op of ops) options.onApplied?.(op, nextRecords);
    return nextRecords;
  }
}

/**
 * The Cloudflare API calls DNS makes, each reply checked against the shape the
 * API documents before anything is decided from it.
 */
import { isIP } from "node:net";
import { type ApiFetch, ProviderError, ProviderHttp } from "./http";
import { dnsName } from "./model";

const API = "https://api.cloudflare.com/client/v4";
const MAX_INVENTORY = 100_000;

export interface CfAccount {
  id: string;
  name: string;
}

export interface CfZone {
  id: string;
  name: string;
  status: string;
  nameServers: string[];
  account: CfAccount;
}

export interface CfRecord {
  id: string;
  type: string;
  name: string;
  /** TXT unquoted; SRV and CAA as their text form. */
  content: string;
  proxied: boolean;
  ttl: number;
  priority: number | null;
  comment: string | null;
}

export interface CfRule {
  id: string;
  ref: string;
  action: string;
  expression: string;
  description: string;
  enabled: boolean;
  action_parameters?: unknown;
  logging?: unknown;
}

export interface CfRuleset {
  id: string;
  rules: CfRule[];
}

/** A record as it is written: what `CfRecord` holds, without the identity Cloudflare gives it. */
export type RecordWrite = Pick<CfRecord, "type" | "name" | "content" | "proxied" | "ttl" | "priority">;

export type RuleWrite = Omit<CfRule, "id">;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProviderError("Cloudflare", "returned a reply this addon does not understand");
  return value as Record<string, unknown>;
}

function id(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{32}$/.test(value)) throw new ProviderError("Cloudflare", "returned an identifier this addon does not understand");
  return value;
}

function text(value: unknown, max = 4096): string {
  if (typeof value !== "string" || value.length > max) throw new ProviderError("Cloudflare", "returned a value this addon does not understand");
  return value;
}

/** `"chunk" "chunk"` as one string, which is how a long TXT value travels. */
export function unquoteTxt(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('"')) return trimmed;
  const chunks = [...trimmed.matchAll(/"((?:[^"\\]|\\.)*)"\s*/g)];
  if (chunks.map((chunk) => chunk[0]).join("").trim() !== trimmed) return trimmed;
  return chunks.map((chunk) => chunk[1]!.replace(/\\(["\\])/g, "$1")).join("");
}

/** Every TXT value quoted, in strings of at most 255 characters, as DNS carries them. */
export function quoteTxt(value: string): string {
  const chunks = value.match(/[\s\S]{1,255}/g) ?? [""];
  return chunks.map((chunk) => `"${chunk.replace(/(["\\])/g, "\\$1")}"`).join(" ");
}

function parseZone(value: unknown): CfZone {
  const raw = object(value);
  const account = object(raw.account);
  const nameServers = Array.isArray(raw.name_servers) ? raw.name_servers.map((server) => text(server, 253).toLowerCase()) : [];
  const name = text(raw.name, 253).toLowerCase();
  if (!dnsName(name)) throw new ProviderError("Cloudflare", "returned a zone with an invalid name");
  return {
    id: id(raw.id),
    name,
    status: text(raw.status, 40),
    nameServers,
    account: { id: id(account.id), name: typeof account.name === "string" ? account.name.slice(0, 120) : "" },
  };
}

function parseAccount(value: unknown): CfAccount {
  const raw = object(value);
  return { id: id(raw.id), name: typeof raw.name === "string" ? raw.name.slice(0, 120) : "" };
}

function dataNumber(data: Record<string, unknown>, key: string): number {
  const value = Number(data[key]);
  if (!Number.isInteger(value) || value < 0 || value > 65535) throw new ProviderError("Cloudflare", `returned a record with an invalid ${key}`);
  return value;
}

export function parseRecord(value: unknown): CfRecord {
  const raw = object(value);
  const type = text(raw.type, 16).toUpperCase();
  const name = text(raw.name, 253).toLowerCase().replace(/\.$/, "");
  let content = typeof raw.content === "string" ? raw.content : "";
  let priority = raw.priority == null ? null : Number(raw.priority);
  if (type === "TXT") content = unquoteTxt(content);
  if (type === "SRV" && raw.data && typeof raw.data === "object") {
    const data = raw.data as Record<string, unknown>;
    priority = dataNumber(data, "priority");
    content = `${dataNumber(data, "weight")} ${dataNumber(data, "port")} ${text(data.target, 253).toLowerCase().replace(/\.$/, "")}`;
  }
  if (type === "CAA" && raw.data && typeof raw.data === "object") {
    const data = raw.data as Record<string, unknown>;
    content = `${dataNumber(data, "flags")} ${text(data.tag, 32)} "${text(data.value, 1024)}"`;
  }
  if (type === "A" && isIP(content) !== 4 || type === "AAAA" && isIP(content) !== 6) {
    throw new ProviderError("Cloudflare", `returned an address record for ${name} that is not an address`);
  }
  const ttl = Number(raw.ttl ?? 1);
  if (!Number.isInteger(ttl) || ttl < 1) throw new ProviderError("Cloudflare", `returned an invalid TTL for ${name}`);
  if (priority !== null && (!Number.isInteger(priority) || priority < 0 || priority > 65535)) {
    throw new ProviderError("Cloudflare", `returned an invalid priority for ${name}`);
  }
  return {
    id: id(raw.id),
    type,
    name,
    content,
    proxied: raw.proxied === true,
    ttl,
    priority: type === "MX" || type === "SRV" ? priority : null,
    comment: typeof raw.comment === "string" ? raw.comment : null,
  };
}

function parseRuleset(value: unknown): CfRuleset {
  const raw = object(value);
  if (!Array.isArray(raw.rules ?? [])) throw new ProviderError("Cloudflare", "returned a ruleset this addon does not understand");
  const rules = ((raw.rules ?? []) as unknown[]).map((entry) => {
    const rule = object(entry);
    return {
      id: id(rule.id),
      ref: typeof rule.ref === "string" ? rule.ref : "",
      action: text(rule.action, 64),
      expression: text(rule.expression, 8192),
      description: typeof rule.description === "string" ? rule.description : "",
      enabled: rule.enabled !== false,
      action_parameters: rule.action_parameters,
      logging: rule.logging,
    };
  });
  return { id: id(raw.id), rules };
}

/** The body Cloudflare is sent for a record. */
function recordBody(record: RecordWrite): Record<string, unknown> {
  const body: Record<string, unknown> = { type: record.type, name: record.name, ttl: record.ttl };
  if (record.type === "A" || record.type === "AAAA" || record.type === "CNAME") body.proxied = record.proxied;
  if (record.type === "SRV") {
    const [weight, port, target] = record.content.split(/\s+/);
    body.data = { priority: record.priority ?? 0, weight: Number(weight), port: Number(port), target };
  } else if (record.type === "CAA") {
    const match = /^(\d+)\s+(\S+)\s+"?(.*?)"?$/.exec(record.content)!;
    body.data = { flags: Number(match[1]), tag: match[2], value: match[3] };
  } else {
    body.content = record.type === "TXT" ? quoteTxt(record.content) : record.content;
  }
  if (record.type === "MX") body.priority = record.priority ?? 0;
  return body;
}

export class CloudflareApi {
  readonly http: ProviderHttp;

  constructor(token: string, fetcher?: ApiFetch, backoff?: { until: number }) {
    this.http = new ProviderHttp("Cloudflare", API, { Authorization: `Bearer ${token}` }, fetcher, backoff);
  }

  /** The envelope's `result`, or the API's own reason for refusing. */
  private async call(path: string, method = "GET", body?: unknown): Promise<{ result: unknown; info: unknown; status: number }> {
    const { status, json } = await this.http.request(path, method, body);
    const reply = json && typeof json === "object" ? json as Record<string, unknown> : {};
    if (reply.success === true && status < 400) return { result: reply.result, info: reply.result_info, status };
    const errors = Array.isArray(reply.errors) ? reply.errors as { code?: unknown; message?: unknown }[] : [];
    const reasons = errors
      .map((error) => `${typeof error.message === "string" ? this.http.clean(error.message).slice(0, 160) : "error"}${Number.isInteger(error.code) ? ` (${error.code})` : ""}`)
      .join("; ");
    throw new ProviderError("Cloudflare", reasons || `HTTP ${status}`, status);
  }

  private async pages<T>(path: string, perPage: number, parse: (value: unknown) => T & { id: string }): Promise<T[]> {
    const items: T[] = [];
    const seen = new Set<string>();
    let total: number | null = null;
    for (let page = 1; ; page++) {
      const separator = path.includes("?") ? "&" : "?";
      const { result, info } = await this.call(`${path}${separator}page=${page}&per_page=${perPage}`);
      const meta = object(info);
      if (!Array.isArray(result) || meta.page !== page || !Number.isSafeInteger(meta.total_count) || !Number.isSafeInteger(meta.total_pages)) {
        throw new ProviderError("Cloudflare", "returned a page this addon does not understand");
      }
      const count = meta.total_count as number;
      if (count > MAX_INVENTORY) throw new ProviderError("Cloudflare", "returned more entries than this addon reads");
      if (total !== null && count !== total) throw new ProviderError("Cloudflare", "changed while it was being read; check again");
      total = count;
      for (const entry of result) {
        const item = parse(entry);
        if (seen.has(item.id)) throw new ProviderError("Cloudflare", "returned the same entry twice while paging; check again");
        seen.add(item.id);
        items.push(item);
      }
      if (page >= (meta.total_pages as number)) break;
      if (result.length === 0) throw new ProviderError("Cloudflare", "stopped returning entries part way through");
    }
    if (items.length !== total) throw new ProviderError("Cloudflare", "returned fewer entries than it counted; check again");
    return items;
  }

  /** Whether the token is active. User tokens and account tokens verify at different paths. */
  async verify(): Promise<{ active: boolean; status: string }> {
    try {
      const { result } = await this.call("/user/tokens/verify");
      const status = text(object(result).status, 40);
      return { active: status === "active", status };
    } catch (error) {
      if (!(error instanceof ProviderError) || error.status === 429) throw error;
    }
    for (const account of await this.accounts()) {
      try {
        const { result } = await this.call(`/accounts/${account.id}/tokens/verify`);
        const status = text(object(result).status, 40);
        return { active: status === "active", status };
      } catch (error) {
        if (!(error instanceof ProviderError) || error.status === 429) throw error;
      }
    }
    return { active: false, status: "invalid" };
  }

  /** The accounts the token can see. A token without account permissions sees none, which is not an error. */
  async accounts(): Promise<CfAccount[]> {
    try {
      return await this.pages("/accounts", 50, parseAccount);
    } catch (error) {
      if (error instanceof ProviderError && (error.status === 401 || error.status === 403)) return [];
      throw error;
    }
  }

  zones(): Promise<CfZone[]> {
    return this.pages("/zones", 50, parseZone);
  }

  records(zoneId: string): Promise<CfRecord[]> {
    return this.pages(`/zones/${id(zoneId)}/dns_records`, 1000, parseRecord);
  }

  async createRecord(zoneId: string, record: RecordWrite, comment: string): Promise<CfRecord> {
    const { result } = await this.call(`/zones/${id(zoneId)}/dns_records`, "POST", { ...recordBody(record), comment });
    return parseRecord(result);
  }

  /** Leaves the record's comment and tags as they are. */
  async updateRecord(zoneId: string, recordId: string, record: RecordWrite): Promise<CfRecord> {
    const { result } = await this.call(`/zones/${id(zoneId)}/dns_records/${id(recordId)}`, "PATCH", recordBody(record));
    return parseRecord(result);
  }

  async deleteRecord(zoneId: string, recordId: string): Promise<void> {
    await this.call(`/zones/${id(zoneId)}/dns_records/${id(recordId)}`, "DELETE");
  }

  async setting(zoneId: string, setting: string): Promise<string> {
    const { result } = await this.call(`/zones/${id(zoneId)}/settings/${setting}`);
    return text(object(result).value, 40);
  }

  async setSetting(zoneId: string, setting: string, value: string): Promise<void> {
    await this.call(`/zones/${id(zoneId)}/settings/${setting}`, "PATCH", { value });
  }

  /** The zone's ruleset for one phase, or null when it has none yet. */
  async entrypoint(zoneId: string, phase: string): Promise<CfRuleset | null> {
    try {
      const { result } = await this.call(`/zones/${id(zoneId)}/rulesets/phases/${phase}/entrypoint`);
      return parseRuleset(result);
    } catch (error) {
      if (error instanceof ProviderError && error.status === 404) return null;
      throw error;
    }
  }

  async createEntrypoint(zoneId: string, phase: string, rules: RuleWrite[]): Promise<CfRuleset> {
    const { result } = await this.call(`/zones/${id(zoneId)}/rulesets`, "POST", { name: "CloudPanel DNS", kind: "zone", phase, rules });
    return parseRuleset(result);
  }

  /** Adds one rule, leaving the phase's other rules alone. */
  async addRule(zoneId: string, rulesetId: string, rule: RuleWrite): Promise<CfRuleset> {
    const { result } = await this.call(`/zones/${id(zoneId)}/rulesets/${rulesetId}/rules`, "POST", rule);
    return parseRuleset(result);
  }

  async updateRule(zoneId: string, rulesetId: string, ruleId: string, rule: RuleWrite): Promise<CfRuleset> {
    const { result } = await this.call(`/zones/${id(zoneId)}/rulesets/${rulesetId}/rules/${ruleId}`, "PATCH", rule);
    return parseRuleset(result);
  }

  async createZone(accountId: string, name: string): Promise<CfZone> {
    const { result } = await this.call("/zones", "POST", { name, account: { id: id(accountId) }, type: "full" });
    return parseZone(result);
  }
}

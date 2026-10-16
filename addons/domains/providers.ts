import { isIP } from "node:net";
import { ProviderError, ProviderHttp, type ApiFetch } from "../../lib/provider-http";
import { domain, object, recordName, text, type Connections, type DnsRecord, type Profile, type Zone } from "./model";

export function providerId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{32}$/.test(value)) throw new Error("Cloudflare returned an invalid identifier");
  return value;
}
function cfObject(value: unknown): Record<string, unknown> {
  let v: Record<string, unknown>;
  try { v = object(value, "Response"); } catch { throw new ProviderError("Cloudflare", "malformed response"); }
  if (v.success !== true) {
    const codes = Array.isArray(v.errors) ? v.errors.map((e) => e && typeof e === "object" && Number.isSafeInteger(e.code) ? String(e.code) : "unknown").join(", ") : "unknown";
    throw new ProviderError("Cloudflare", `API refused the request (codes: ${codes.slice(0, 120)})`);
  }
  return v;
}
function parseZone(raw: unknown): Zone {
  const v = object(raw, "Cloudflare zone");
  if (!Array.isArray(v.name_servers) || !v.name_servers.every((s) => typeof s === "string")) throw new ProviderError("Cloudflare", "zone nameservers are malformed");
  return { id: providerId(v.id), name: domain(v.name), status: text(v.status, "Zone status", 40), nameServers: v.name_servers.map((s) => domain(s)) };
}
export function parseRecord(raw: unknown): DnsRecord {
  const v = object(raw, "Cloudflare record");
  const name = text(v.name, "Record name").toLowerCase().replace(/\.$/, "");
  const type = text(v.type, "Record type", 16);
  if (!recordName(name) || !/^[A-Z0-9]+$/.test(type) || !Number.isSafeInteger(v.ttl) || Number(v.ttl) < 1) throw new ProviderError("Cloudflare", "record is malformed");
  const result: DnsRecord = { id: providerId(v.id), name, type, content: text(v.content, "Record content", 16_384), ttl: Number(v.ttl) };
  if (type === "TXT") result.content = v.content as string;
  if (v.proxied !== undefined) {
    if (typeof v.proxied !== "boolean") throw new ProviderError("Cloudflare", "proxy flag is malformed");
    result.proxied = v.proxied;
  }
  if (v.priority !== undefined) {
    if (!Number.isInteger(v.priority) || Number(v.priority) < 0 || Number(v.priority) > 65535) throw new ProviderError("Cloudflare", "record priority is malformed");
    result.priority = Number(v.priority);
  }
  if (type === "A" && isIP(result.content) !== 4 || type === "AAAA" && isIP(result.content) !== 6) throw new ProviderError("Cloudflare", "address record is malformed");
  if (["CNAME", "MX"].includes(type)) domain(result.content);
  if (type === "SRV") {
    const d = object(v.data, "SRV data");
    if (![d.priority, d.weight, d.port].every((n) => Number.isInteger(n) && Number(n) >= 0 && Number(n) <= 65535)) throw new ProviderError("Cloudflare", "SRV data is malformed");
    result.data = { priority: Number(d.priority), weight: Number(d.weight), port: Number(d.port), target: domain(d.target) };
  }
  if (v.comment !== undefined && v.comment !== null) result.comment = text(v.comment, "Record comment", 500);
  if (v.tags !== undefined) {
    if (!Array.isArray(v.tags) || !v.tags.every((v) => typeof v === "string" && v.length <= 256 && !/[\x00-\x1f]/.test(v))) throw new ProviderError("Cloudflare", "record tags are malformed");
    result.tags = v.tags;
  }
  return result;
}

export class Cloudflare {
  readonly http: ProviderHttp;
  constructor(private readonly config: Connections, fetcher?: ApiFetch, retryAt = 0) {
    this.http = new ProviderHttp("Cloudflare", "https://api.cloudflare.com/client/v4", { Authorization: `Bearer ${config.cloudflareToken}` }, fetcher, retryAt);
  }
  private async request(path: string, method?: string, body?: unknown): Promise<Record<string, unknown>> {
    return cfObject(await this.http.request(path, method, body));
  }
  private async pages<T>(path: string, perPage: number, parse: (value: unknown) => T & { id?: string }): Promise<T[]> {
    const result: T[] = [];
    const ids = new Set<string>();
    let total = -1;
    for (let page = 1; ; page++) {
      const raw = await this.request(`${path}${path.includes("?") ? "&" : "?"}page=${page}&per_page=${perPage}`);
      const info = object(raw.result_info, "Cloudflare pagination");
      if (!Array.isArray(raw.result) || info.page !== page || info.count !== raw.result.length || !Number.isSafeInteger(info.total_count) || Number(info.total_count) < 0 || Number(info.total_count) > 1_000_000 || !Number.isSafeInteger(info.total_pages) || Number(info.total_pages) < 0 || Number(info.total_pages) > Number(info.total_count) + 1) throw new ProviderError("Cloudflare", "pagination is malformed; no partial inventory will be used");
      if (total !== -1 && info.total_count !== total) throw new ProviderError("Cloudflare", "inventory changed while paging; scan again");
      total = Number(info.total_count);
      for (const item of raw.result) {
        const parsed = parse(item);
        const id = parsed.id;
        if (!id || ids.has(id)) throw new ProviderError("Cloudflare", "duplicate or missing identifier in paginated inventory");
        ids.add(id); result.push(parsed);
      }
      if (page >= Number(info.total_pages)) {
        if (result.length !== total) throw new ProviderError("Cloudflare", "incomplete paginated inventory");
        return result;
      }
      if (!raw.result.length || result.length >= total) throw new ProviderError("Cloudflare", "pagination made no progress");
    }
  }
  zones(): Promise<Zone[]> { return this.pages(`/zones?account.id=${this.config.accountId}`, 50, parseZone); }
  records(zone: string): Promise<DnsRecord[]> { return this.pages(`/zones/${providerId(zone)}/dns_records`, 100, parseRecord); }
  async createZone(name: string): Promise<Zone> {
    return parseZone((await this.request("/zones", "POST", { account: { id: this.config.accountId }, name, type: "full" })).result);
  }
  async writeRecord(zone: string, record: DnsRecord): Promise<DnsRecord> {
    const { id, content, ...rest } = record;
    const body = { ...rest, ...(record.type === "SRV" ? {} : { content }) };
    const path = `/zones/${providerId(zone)}/dns_records${id ? `/${providerId(id)}` : ""}`;
    return parseRecord((await this.request(path, id ? "PATCH" : "POST", body)).result);
  }
  async deleteRecord(zone: string, id: string): Promise<void> { await this.request(`/zones/${providerId(zone)}/dns_records/${providerId(id)}`, "DELETE"); }
  async setting(zone: string, name: "ssl" | "always_use_https"): Promise<string> {
    const raw = object((await this.request(`/zones/${providerId(zone)}/settings/${name}`)).result, "Zone setting");
    return text(raw.value, "Zone setting", 40);
  }
  async setSetting(zone: string, name: string, value: string): Promise<void> { await this.request(`/zones/${providerId(zone)}/settings/${name}`, "PATCH", { value }); }
  async entrypoint(zone: string, phase: string): Promise<Ruleset | null> {
    try {
      return parseRuleset((await this.request(`/zones/${providerId(zone)}/rulesets/phases/${phase}/entrypoint`)).result);
    } catch (e) { if (e instanceof ProviderError && e.status === 404) return null; throw e; }
  }
  async writeRule(zone: string, phase: string, set: Ruleset | null, rule: Rule, id?: string): Promise<void> {
    if (!set) {
      await this.request(`/zones/${providerId(zone)}/rulesets`, "POST", { name: "CloudPanel Addons", kind: "zone", phase, rules: [rule] });
    } else {
      await this.request(`/zones/${providerId(zone)}/rulesets/${set.id}/rules${id ? `/${providerId(id)}` : ""}`, id ? "PATCH" : "POST", rule);
    }
  }
}
export interface Rule { ref: string; action: string; expression: string; description: string; enabled: boolean; action_parameters: Record<string, unknown>; logging?: { enabled: boolean } }
export interface Ruleset { id: string; rules: (Partial<Rule> & { id: string })[] }
function parseRuleset(raw: unknown): Ruleset {
  const v = object(raw, "Cloudflare ruleset");
  if (!Array.isArray(v.rules)) throw new ProviderError("Cloudflare", "ruleset is malformed");
  return { id: providerId(v.id), rules: v.rules.map((r) => ({ ...object(r, "Rule"), id: providerId(r?.id) })) };
}

export interface Dkim { selector: string; txt: string }
export class Mailcow {
  readonly http: ProviderHttp;
  constructor(config: Connections, fetcher?: ApiFetch, retryAt = 0) {
    this.http = new ProviderHttp("Mailcow", `${config.mailcowUrl}/api/v1`, { "X-API-Key": config.mailcowKey }, fetcher, retryAt);
  }
  private async get(path: string): Promise<unknown> {
    const v = await this.http.request(path);
    if (Array.isArray(v) && v.some((row) => row && typeof row === "object" && ["danger", "error"].includes(row.type))) throw new ProviderError("Mailcow", "API refused the read");
    if (v && typeof v === "object" && !Array.isArray(v) && "type" in v) throw new ProviderError("Mailcow", "API refused the read");
    return v;
  }
  private async post(path: string, body: unknown): Promise<void> {
    const v = await this.http.request(path, "POST", body);
    const rows = Array.isArray(v) ? v : [v];
    if (!rows.length || rows.some((r) => !r || typeof r !== "object" || r.type !== "success")) throw new ProviderError("Mailcow", "API refused the change; check permissions and domain/mailbox limits");
  }
  async hasDomain(name: string): Promise<boolean> {
    const raw = await this.get(`/get/domain/${encodeURIComponent(name)}`);
    if (Array.isArray(raw) && raw.length === 0 || raw === null || raw === false) return false;
    const v = object(Array.isArray(raw) && raw.length === 1 ? raw[0] : raw, "Mailcow domain");
    if (domain(v.domain_name) !== name) throw new ProviderError("Mailcow", "domain response did not match the request");
    return true;
  }
  async dkim(name: string): Promise<Dkim | null> {
    const raw = await this.get(`/get/dkim/${encodeURIComponent(name)}`);
    if (Array.isArray(raw) && raw.length === 0 || raw === null || raw === false) return null;
    const v = object(raw, "Mailcow DKIM");
    if (Object.keys(v).length === 0) return null;
    const selector = text(v.dkim_selector, "Mailcow DKIM selector", 63);
    const key = text(v.pubkey, "Mailcow DKIM public key", 8192);
    const txt = unquoteTxt(text(v.dkim_txt, "Mailcow DKIM TXT", 16_384));
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(selector) || !/^[a-z0-9+/]+={0,2}$/i.test(key) || !/^v=DKIM1;/i.test(txt) || /(?:^|;)\s*p=([^;\s]+)/.exec(txt)?.[1] !== key) throw new ProviderError("Mailcow", "DKIM public key and TXT disagree or are malformed");
    return { selector, txt };
  }
  async mailbox(address: string): Promise<string[]> {
    const raw = await this.get(`/get/mailbox/${encodeURIComponent(address)}`);
    const v = Array.isArray(raw) ? raw.length === 1 ? raw[0] : null : raw;
    const box = object(v, "Mailcow shared mailbox");
    if (box.username !== address || !Array.isArray(box.sender_acl) || !box.sender_acl.every((v) => typeof v === "string" && v.length < 255 && !/[\x00-\x1f]/.test(v))) throw new ProviderError("Mailcow", "shared mailbox or sender ACL is missing/malformed; no ACL will be overwritten");
    return box.sender_acl.slice();
  }
  addDomain(name: string): Promise<void> {
    return this.post("/add/domain", { domain: name, active: "1", aliases: "400", mailboxes: "10", defquota: "3072", maxquota: "10240", quota: "10240", backupmx: "0", relay_all_recipients: "0", restart_sogo: "0", key_size: "0" });
  }
  addDkim(name: string, p: Profile): Promise<void> {
    return p.dkimSource ? this.post("/add/dkim_duplicate", { from_domain: p.dkimSource, to_domain: name })
      : this.post("/add/dkim", { domains: name, dkim_selector: p.dkimSelector, key_size: String(p.dkimBits) });
  }
  setAcl(address: string, acl: string[]): Promise<void> { return this.post("/edit/mailbox", { items: [address], attr: { sender_acl: acl } }); }
}
export function unquoteTxt(value: string): string {
  if (!value.startsWith('"')) return value;
  const chunks = [...value.matchAll(/"((?:[^"\\]|\\.)*)"\s*/g)];
  if (chunks.map((c) => c[0]).join("") !== value) throw new Error("Malformed quoted DNS TXT");
  return chunks.map((c) => c[1]!.replace(/\\(["\\])/g, "$1")).join("");
}

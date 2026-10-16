import type { ApiFetch } from "../../lib/provider-http";
import type { DnsRecord, Zone } from "../../addons/domains/model";

// Contracts: Cloudflare DNS/Rulesets API and mailcow data/web/api/openapi.yaml.
export class FakeDomainsApis {
  serial = 1;
  zones: Zone[] = [];
  records = new Map<string, DnsRecord[]>();
  settings = new Map<string, string>();
  rules = new Map<string, { id: string; rules: Record<string, unknown>[] }>();
  mailDomains = new Set<string>();
  dkim = new Map<string, { dkim_selector: string; pubkey: string; dkim_txt: string; privkey: string }>();
  mailboxes = new Map<string, string[]>();
  calls: { host: string; path: string; method: string; body: any }[] = [];
  intercept?: (url: URL, init: RequestInit) => Response | undefined;
  id(): string { return (this.serial++).toString(16).padStart(32, "0"); }
  zone(name = "example.net", status = "active"): Zone {
    const zone = { id: this.id(), name, status, nameServers: ["alice.ns.cloudflare.com", "bob.ns.cloudflare.com"] };
    this.zones.push(zone); this.records.set(zone.id, []); return zone;
  }
  record(zone: Zone, record: Partial<DnsRecord> & { name: string; type: string; content: string }): DnsRecord {
    const result = { ttl: 1, proxied: false, ...record, id: record.id ?? this.id() };
    this.records.get(zone.id)!.push(result); return result;
  }
  key(domain: string, selector = "dkim", publicKey = Buffer.from("fake-rsa-public-key".repeat(32)).toString("base64")): void {
    this.dkim.set(domain, { dkim_selector: selector, pubkey: publicKey, dkim_txt: `v=DKIM1;k=rsa;t=s;s=email;p=${publicKey}`, privkey: "PRIVATE-DKIM-MUST-NOT-ESCAPE" });
  }
  writes(): typeof this.calls { return this.calls.filter((c) => c.method !== "GET"); }
  private cf(result: unknown, info?: Record<string, number>): Response { return Response.json({ success: true, errors: [], messages: [], result, ...(info ? { result_info: info } : {}) }); }
  private page(items: any[], url: URL): Response {
    const per = Number(url.searchParams.get("per_page")), page = Number(url.searchParams.get("page"));
    const result = items.slice((page - 1) * per, page * per);
    return this.cf(result, { count: result.length, page, per_page: per, total_count: items.length, total_pages: Math.ceil(items.length / per) });
  }
  fetch: ApiFetch = async (address, init) => {
    const url = new URL(address), path = url.pathname, method = init.method ?? "GET", body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    this.calls.push({ host: url.host, path, method, body });
    const intercepted = this.intercept?.(url, init); if (intercepted) return intercepted;
    if (url.host === "api.cloudflare.com") {
      if (new Headers(init.headers).get("authorization") !== "Bearer cf-test-token") throw new Error("Wrong Cloudflare authentication");
      const p = path.replace("/client/v4", "");
      if (p === "/zones" && method === "GET") return this.page(this.zones.map((z) => ({ id: z.id, name: z.name, status: z.status, name_servers: z.nameServers })), url);
      if (p === "/zones" && method === "POST") { const z = this.zone(body.name, "pending"); return this.cf({ id: z.id, name: z.name, status: z.status, name_servers: z.nameServers }); }
      const record = /^\/zones\/([^/]+)\/dns_records(?:\/([^/]+))?$/.exec(p);
      if (record) {
        const records = this.records.get(record[1]!)!;
        if (method === "GET") return this.page(records, url);
        if (method === "DELETE") { this.records.set(record[1]!, records.filter((r) => r.id !== record[2])); return this.cf({ id: record[2] }); }
        if (method === "POST" || method === "PATCH") {
          if (!["A", "AAAA", "CNAME", "MX", "TXT", "SRV"].includes(body.type)) throw new Error("Unsupported fake record");
          if (body.type === "CNAME" && records.some((r) => r.name === body.name && r.id !== record[2])) return Response.json({ success: false, errors: [{ code: 81053, message: "Existing record" }], result: null });
          if (["A", "AAAA"].includes(body.type) && records.some((r) => r.name === body.name && r.type === "CNAME")) return Response.json({ success: false, errors: [{ code: 81054, message: "Existing CNAME" }], result: null });
          const txt = body.type === "TXT" && !body.content.startsWith('"') ? { content: (body.content.match(/.{1,255}/g) ?? [""]).map((s: string) => JSON.stringify(s)).join(" ") } : {};
          const r = { ...body, ...txt, id: record[2] ?? this.id(), ...(body.type === "SRV" ? { content: `${body.data.priority} ${body.data.weight} ${body.data.port} ${body.data.target}` } : {}) };
          this.records.set(record[1]!, [...records.filter((r) => r.id !== record[2]), r]); return this.cf(r);
        }
      }
      const setting = /^\/zones\/([^/]+)\/settings\/([^/]+)$/.exec(p);
      if (setting) {
        const key = `${setting[1]}:${setting[2]}`;
        if (method === "PATCH") this.settings.set(key, body.value);
        return this.cf({ id: setting[2], value: this.settings.get(key) ?? (setting[2] === "ssl" ? "full" : "off"), editable: true });
      }
      const entry = /^\/zones\/([^/]+)\/rulesets\/phases\/([^/]+)\/entrypoint$/.exec(p);
      if (entry && method === "GET") {
        const set = this.rules.get(`${entry[1]}:${entry[2]}`);
        return set ? this.cf(set) : Response.json({ success: false, errors: [{ code: 10003, message: "ruleset not found" }], result: null }, { status: 404 });
      }
      const createSet = /^\/zones\/([^/]+)\/rulesets$/.exec(p);
      if (createSet && method === "POST") {
        const key = `${createSet[1]}:${body.phase}`;
        if (this.rules.has(key)) throw new Error("Replacing an existing entrypoint is forbidden");
        const set = { id: this.id(), rules: body.rules.map((r: object) => ({ ...r, id: this.id() })) }; this.rules.set(key, set); return this.cf(set);
      }
      const rule = /^\/zones\/([^/]+)\/rulesets\/([^/]+)\/rules(?:\/([^/]+))?$/.exec(p);
      if (rule && ["POST", "PATCH"].includes(method)) {
        const set = [...this.rules.values()].find((s) => s.id === rule[2])!;
        const r = { ...body, id: rule[3] ?? this.id() }; set.rules = [...set.rules.filter((r) => r.id !== rule[3]), r]; return this.cf(set);
      }
    } else if (url.host === "mail.example.net") {
      if (new Headers(init.headers).get("x-api-key") !== "mc-test-key") throw new Error("Wrong Mailcow authentication");
      const p = path.replace("/api/v1", "");
      const get = /^\/get\/(domain|dkim|mailbox)\/(.+)$/.exec(p);
      if (get && method === "GET") {
        const name = decodeURIComponent(get[2]!);
        if (get[1] === "domain") return Response.json(this.mailDomains.has(name) ? { domain_name: name, active: "1" } : []);
        if (get[1] === "dkim") return Response.json(this.dkim.get(name) ?? {});
        if (get[1] === "mailbox") return Response.json(this.mailboxes.has(name) ? { username: name, sender_acl: this.mailboxes.get(name), active: "1" } : []);
      }
      if (method === "POST") {
        if (p === "/add/domain") {
          if (body.active !== "1" || !body.domain || body.key_size !== "0") throw new Error("Wrong Mailcow domain contract");
          this.mailDomains.add(body.domain);
        } else if (p === "/add/dkim") {
          if (!body.domains || !body.dkim_selector || !["1024", "2048", "3072", "4096"].includes(body.key_size)) throw new Error("Wrong DKIM generation contract");
          this.key(body.domains, body.dkim_selector);
        } else if (p === "/add/dkim_duplicate") {
          if (!this.dkim.has(body.from_domain)) return Response.json([{ type: "danger", msg: ["dkim_missing", body.from_domain], log: ["dkim", "duplicate", body] }]);
          this.dkim.set(body.to_domain, structuredClone(this.dkim.get(body.from_domain)!));
        } else if (p === "/edit/mailbox") {
          if (body.items.length !== 1 || Object.keys(body.attr).join() !== "sender_acl" || !Array.isArray(body.attr.sender_acl)) throw new Error("Wrong sender ACL contract");
          this.mailboxes.set(body.items[0], body.attr.sender_acl);
        } else throw new Error(`Unexpected fake Mailcow mutation: ${p}`);
        return Response.json([{ type: "success", msg: ["saved"], log: ["fake", body] }]);
      }
    }
    throw new Error(`Unexpected fake API request: ${method} ${url.host}${path}`);
  };
}

// Fakes of the parts of Cloudflare's v4 API and Mailcow's API that DNS uses,
// answering in their documented shapes: Cloudflare's success/errors/result
// envelope with result_info pages and per-token access, and Mailcow's HTTP 200
// with `type: "danger"` for a refusal and `{}` for nothing found.
import type { ApiFetch } from "../../addons/dns/http";

export interface FakeToken {
  /** User tokens verify at /user/tokens/verify, account tokens at /accounts/:id/tokens/verify. */
  owner: "user" | "account";
  accounts: string[];
  status?: string;
  /** Whether it holds Account Settings Read, which /accounts needs. */
  listAccounts?: boolean;
  zoneEdit?: boolean;
}

interface Zone {
  id: string;
  name: string;
  status: string;
  name_servers: string[];
  account: { id: string; name: string };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

let serial = 0;
export const hexId = (): string => (++serial).toString(16).padStart(32, "a");

export class FakeCloudflare {
  tokens = new Map<string, FakeToken>();
  accounts = new Map<string, string>();
  zones: Zone[] = [];
  records = new Map<string, Record<string, unknown>[]>();
  settings = new Map<string, string>();
  rulesets = new Map<string, { id: string; rules: Record<string, unknown>[] }>();
  calls: { method: string; path: string; token: string; body?: unknown }[] = [];
  /** After this many more calls, answer 429 with this Retry-After. */
  limit: { after: number; retryAfter: string } | null = null;
  /** Refuse an update that changes a rule's ref, in case Cloudflare keeps the one a rule has. */
  keepsRefs = false;

  account(name: string): string {
    const id = hexId();
    this.accounts.set(id, name);
    return id;
  }

  token(value: string, token: FakeToken): void {
    this.tokens.set(value, { status: "active", listAccounts: true, ...token });
  }

  zone(name: string, accountId: string, status = "active"): Zone {
    const zone = { id: hexId(), name, status, name_servers: ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"], account: { id: accountId, name: this.accounts.get(accountId)! } };
    this.zones.push(zone);
    this.records.set(zone.id, []);
    return zone;
  }

  record(zoneName: string, record: Record<string, unknown>, accountId?: string): Record<string, unknown> {
    const zone = this.zones.find((candidate) => candidate.name === zoneName && (!accountId || candidate.account.id === accountId))!;
    const full = { id: hexId(), ttl: 1, proxied: false, comment: null, ...record };
    this.records.get(zone.id)!.push(full);
    return full;
  }

  recordsOf(zoneName: string): Record<string, unknown>[] {
    return this.records.get(this.zones.find((zone) => zone.name === zoneName)!.id)!;
  }

  writes(): { method: string; path: string }[] {
    return this.calls.filter((call) => call.method !== "GET");
  }

  private error(status: number, code: number, message: string): Response {
    return json({ success: false, errors: [{ code, message }], messages: [], result: null }, status);
  }

  private ok(result: unknown, info?: Record<string, number>): Response {
    return json({ success: true, errors: [], messages: [], result, ...(info ? { result_info: info } : {}) });
  }

  private page(items: unknown[], url: URL, max: number): Response {
    const page = Number(url.searchParams.get("page") ?? 1);
    const perPage = Number(url.searchParams.get("per_page") ?? 20);
    if (perPage > max) return this.error(400, 1004, "per_page must be at most " + max);
    const result = items.slice((page - 1) * perPage, page * perPage);
    return this.ok(result, { page, per_page: perPage, count: result.length, total_count: items.length, total_pages: Math.max(1, Math.ceil(items.length / perPage)) });
  }

  private zoneFor(id: string, token: FakeToken): Zone | Response {
    const zone = this.zones.find((candidate) => candidate.id === id);
    if (!zone) return this.error(404, 7003, "Could not route to /zones/" + id);
    if (!token.accounts.includes(zone.account.id)) return this.error(403, 9109, "Unauthorized to access requested resource");
    return zone;
  }

  private writeRecord(zone: Zone, body: Record<string, unknown>, id?: string): Response {
    const records = this.records.get(zone.id)!;
    const name = String(body.name);
    if (name !== zone.name && !name.endsWith(`.${zone.name}`)) return this.error(400, 9005, "Content for record is invalid");
    const others = records.filter((record) => record.name === name && record.id !== id);
    if (body.type === "CNAME" && others.length) return this.error(400, 81053, "An A, AAAA, or CNAME record with that host already exists.");
    if (others.some((record) => record.type === "CNAME")) return this.error(400, 81054, "A CNAME record with that host already exists.");
    if ("proxied" in body && !["A", "AAAA", "CNAME"].includes(String(body.type))) return this.error(400, 9004, "This record type cannot be proxied.");
    const record: Record<string, unknown> = { ...(id ? records.find((candidate) => candidate.id === id) : { comment: null }), ...body, id: id ?? hexId() };
    if (body.type === "SRV") {
      const data = body.data as Record<string, number | string>;
      record.priority = data.priority;
      record.content = `${data.weight} ${data.port} ${data.target}`;
    }
    if (body.type === "CAA") {
      const data = body.data as Record<string, number | string>;
      record.content = `${data.flags} ${data.tag} "${data.value}"`;
    }
    if (records.some((candidate) => candidate.id !== record.id && candidate.type === record.type && candidate.name === record.name && candidate.content === record.content)) {
      return this.error(400, 81058, "An identical record already exists.");
    }
    if (body.proxied) record.ttl = 1;
    this.records.set(zone.id, [...records.filter((candidate) => candidate.id !== record.id), record]);
    return this.ok(record);
  }

  fetch: ApiFetch = async (address, init) => {
    const url = new URL(address);
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    const bearer = new Headers(init.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
    const path = url.pathname.replace("/client/v4", "");
    this.calls.push({ method, path, token: bearer, body });
    if (init.redirect !== "error") throw new Error("redirects must be refused");
    if (this.limit) {
      if (this.limit.after <= 0) return json({ success: false, errors: [{ code: 971, message: "Please wait and consider throttling your request speed" }] }, 429, { "Retry-After": this.limit.retryAfter });
      this.limit.after--;
    }
    const token = this.tokens.get(bearer);
    if (!token) return this.error(401, 10000, "Authentication error");

    if (path === "/user/tokens/verify") {
      return token.owner === "user" ? this.ok({ id: hexId(), status: token.status }) : this.error(401, 1000, "Invalid API Token");
    }
    const accountVerify = /^\/accounts\/([^/]+)\/tokens\/verify$/.exec(path);
    if (accountVerify) {
      return token.owner === "account" && token.accounts.includes(accountVerify[1]!) ? this.ok({ id: hexId(), status: token.status }) : this.error(401, 1000, "Invalid API Token");
    }
    if (path === "/accounts") {
      if (!token.listAccounts) return this.error(403, 9109, "Unauthorized to access requested resource");
      return this.page(token.accounts.map((id) => ({ id, name: this.accounts.get(id), type: "standard" })), url, 50);
    }
    if (path === "/zones" && method === "GET") {
      return this.page(this.zones.filter((zone) => token.accounts.includes(zone.account.id)), url, 50);
    }
    if (path === "/zones" && method === "POST") {
      const account = (body!.account as { id: string }).id;
      if (!token.zoneEdit || !token.accounts.includes(account)) return this.error(403, 9109, "Unauthorized to access requested resource");
      if (this.zones.some((zone) => zone.name === body!.name && zone.account.id === account)) return this.error(400, 1061, "already exists");
      return this.ok(this.zone(String(body!.name), account, "pending"));
    }

    const zoneMatch = /^\/zones\/([^/]+)(\/.*)$/.exec(path);
    if (!zoneMatch) return this.error(404, 7000, "No route for that URI");
    const zone = this.zoneFor(zoneMatch[1]!, token);
    if (zone instanceof Response) return zone;
    const rest = zoneMatch[2]!;

    const record = /^\/dns_records(?:\/([^/]+))?$/.exec(rest);
    if (record) {
      if (method === "GET") return this.page(this.records.get(zone.id)!, url, 5_000_000);
      if (method === "POST") return this.writeRecord(zone, body!);
      if (!this.records.get(zone.id)!.some((candidate) => candidate.id === record[1])) return this.error(404, 81044, "Record does not exist.");
      if (method === "PATCH") return this.writeRecord(zone, body!, record[1]);
      if (method === "DELETE") {
        this.records.set(zone.id, this.records.get(zone.id)!.filter((candidate) => candidate.id !== record[1]));
        return this.ok({ id: record[1] });
      }
    }
    const setting = /^\/settings\/([a-z_]+)$/.exec(rest);
    if (setting) {
      const key = `${zone.id}:${setting[1]}`;
      if (method === "PATCH") this.settings.set(key, String(body!.value));
      return this.ok({ id: setting[1], value: this.settings.get(key) ?? (setting[1] === "ssl" ? "full" : "off"), editable: true });
    }
    const entrypoint = /^\/rulesets\/phases\/([a-z_]+)\/entrypoint$/.exec(rest);
    if (entrypoint && method === "GET") {
      const ruleset = this.rulesets.get(`${zone.id}:${entrypoint[1]}`);
      return ruleset ? this.ok({ ...ruleset, phase: entrypoint[1], kind: "zone" }) : this.error(404, 10003, `could not find entrypoint ruleset in the '${entrypoint[1]}' phase`);
    }
    if (rest === "/rulesets" && method === "POST") {
      const key = `${zone.id}:${body!.phase}`;
      if (this.rulesets.has(key)) return this.error(400, 20217, "A similar configuration with rules already exists and overwriting will have unintended consequences.");
      const ruleset = { id: hexId(), rules: (body!.rules as Record<string, unknown>[]).map((rule) => ({ ...rule, id: hexId() })) };
      this.rulesets.set(key, ruleset);
      return this.ok(ruleset);
    }
    const rule = /^\/rulesets\/([^/]+)\/rules(?:\/([^/]+))?$/.exec(rest);
    if (rule) {
      const ruleset = [...this.rulesets.entries()].find(([key, set]) => key.startsWith(zone.id) && set.id === rule[1])?.[1];
      if (!ruleset) return this.error(404, 10003, "ruleset not found");
      if (method === "POST") {
        const id = hexId();
        ruleset.rules.push({ ...body, id, ref: body!.ref ?? id });
      } else if (method === "PATCH") {
        const current = ruleset.rules.find((candidate) => candidate.id === rule[2]);
        if (!current) return this.error(404, 10003, "rule not found");
        if (this.keepsRefs && body!.ref !== undefined && body!.ref !== current.ref) return this.error(400, 20021, "the rule's ref cannot be changed");
        ruleset.rules = ruleset.rules.map((candidate) => candidate === current ? { ...body, id: rule[2], ref: body!.ref ?? current.ref } : candidate);
      } else if (method === "DELETE") {
        if (!ruleset.rules.some((candidate) => candidate.id === rule[2])) return this.error(404, 10003, "rule not found");
        ruleset.rules = ruleset.rules.filter((candidate) => candidate.id !== rule[2]);
      }
      return this.ok(ruleset);
    }
    return this.error(404, 7000, "No route for that URI");
  };
}

export const MAILCOW_KEY = "MC-0123456789ABCDEF-0123456789";

export class FakeMailcow {
  domains = new Set<string>();
  dkim = new Map<string, { dkim_selector: string; dkim_txt: string; pubkey: string; length: string; privkey: string }>();
  mailboxes = new Map<string, { sender_acl?: string[] }>();
  calls: { method: string; path: string; body?: unknown }[] = [];
  /** Mailcow versions before sender_acl was reported. */
  reportsAcl = true;
  apiKey = MAILCOW_KEY;

  key(domain: string, selector = "dkim", publicKey = Buffer.from(`key-of-${domain}`.repeat(12)).toString("base64")): void {
    this.dkim.set(domain, { dkim_selector: selector, pubkey: publicKey, dkim_txt: `v=DKIM1;k=rsa;t=s;s=email;p=${publicKey}`, length: "2048", privkey: "" });
  }

  writes(): { method: string; path: string; body?: unknown }[] {
    return this.calls.filter((call) => call.method !== "GET");
  }

  fetch: ApiFetch = async (address, init) => {
    const url = new URL(address);
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    const path = url.pathname.replace("/api/v1", "");
    this.calls.push({ method, path, body });
    if (new Headers(init.headers).get("x-api-key") !== this.apiKey) return json({ type: "error", msg: "authentication failed" }, 401);
    const success = (msg: string[]) => json([{ type: "success", log: ["fake", body], msg }]);
    const danger = (msg: string[]) => json([{ type: "danger", log: ["fake", body], msg }]);

    const get = /^\/get\/(domain|dkim|mailbox)\/(.+)$/.exec(path);
    if (get && method === "GET") {
      const name = decodeURIComponent(get[2]!);
      if (get[1] === "domain") return json(this.domains.has(name) ? { domain_name: name, active: "1", mboxes_in_domain: 0 } : {});
      if (get[1] === "dkim") return json(this.dkim.get(name) ?? {});
      const box = this.mailboxes.get(name);
      if (!box) return json({});
      return json({ username: name, active: "1", ...(this.reportsAcl ? { sender_acl: box.sender_acl ?? [] } : {}) });
    }
    if (method !== "POST") return json({ type: "error", msg: "only POST is allowed here" }, 405);
    if (path === "/add/domain") {
      if (this.domains.has(String(body!.domain))) return danger(["domain_exists", String(body!.domain)]);
      if (body!.key_size !== 0) throw new Error("the addon must stop Mailcow generating its own DKIM key");
      this.domains.add(String(body!.domain));
      return json([{ type: "success", msg: ["rl_saved", body!.domain] }, { type: "success", msg: ["domain_added", body!.domain] }]);
    }
    if (path === "/add/dkim") {
      if (![1024, 2048, 3072, 4096].includes(Number(body!.key_size))) return danger(["dkim_key_length_invalid"]);
      this.key(String(body!.domains), String(body!.dkim_selector));
      return success(["dkim_added", String(body!.domains)]);
    }
    if (path === "/add/dkim_duplicate") {
      const source = this.dkim.get(String(body!.from_domain));
      if (!source) return danger(["dkim_domain_or_sel_invalid", String(body!.from_domain)]);
      this.dkim.set(String(body!.to_domain), { ...source });
      return success(["dkim_duplicated", String(body!.from_domain), String(body!.to_domain)]);
    }
    if (path === "/edit/mailbox") {
      const items = body!.items as string[];
      const acl = (body!.attr as { sender_acl: string[] }).sender_acl;
      const box = this.mailboxes.get(items[0]!);
      if (!box) return danger(["access_denied"]);
      // Mailcow skips a domain it does not host, with a danger entry, and keeps the rest.
      const valid = acl.filter((entry) => entry === "*" || !entry.startsWith("@") || this.domains.has(entry.slice(1)));
      box.sender_acl = valid;
      return valid.length === acl.length ? success(["mailbox_modified", items[0]!]) : danger(["sender_acl_invalid"]);
    }
    return json({ type: "error", msg: "route not found" }, 404);
  };
}

/** One fetch for both fakes, by host, the way the real one reaches two servers. */
export function routed(cloudflare: FakeCloudflare, mailcow: FakeMailcow): ApiFetch {
  return (address, init) => new URL(address).host === "api.cloudflare.com" ? cloudflare.fetch(address, init) : mailcow.fetch(address, init);
}

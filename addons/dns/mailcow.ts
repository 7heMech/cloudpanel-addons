/**
 * The Mailcow API calls DNS makes. Mailcow answers a refused change with HTTP
 * 200 and `type: "danger"`, and a missing object with `{}`, so both are read
 * from the body rather than the status.
 */
import { type ApiFetch, ProviderError, ProviderHttp } from "./http";

export interface MailcowDkim {
  selector: string;
  /** The TXT value to publish, exactly as Mailcow holds it. */
  txt: string;
}

function empty(value: unknown): boolean {
  if (value == null || value === false) return true;
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === "object" && Object.keys(value).length === 0;
}

function single(value: unknown): Record<string, unknown> | null {
  const entry = Array.isArray(value) && value.length === 1 ? value[0] : value;
  return entry && typeof entry === "object" && !Array.isArray(entry) ? entry as Record<string, unknown> : null;
}

function refusal(value: unknown): string | null {
  const entries = Array.isArray(value) ? value : [value];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const { type, msg } = entry as { type?: unknown; msg?: unknown };
    if (type === "danger" || type === "error") {
      const words = Array.isArray(msg) ? msg.filter((part) => typeof part === "string").join(" ") : typeof msg === "string" ? msg : "";
      return words || "refused the request";
    }
  }
  return null;
}

export class MailcowApi {
  readonly http: ProviderHttp;

  constructor(origin: string, key: string, fetcher?: ApiFetch, backoff?: { until: number }) {
    this.http = new ProviderHttp("Mailcow", `${origin}/api/v1`, { "X-API-Key": key }, fetcher, backoff);
  }

  private refuse(status: number, json: unknown): void {
    if (status === 401 || status === 403) throw new ProviderError("Mailcow", "refused the API key", status);
    if (status >= 400) throw new ProviderError("Mailcow", `HTTP ${status}`, status);
    const refused = refusal(json);
    if (refused) throw new ProviderError("Mailcow", this.http.clean(refused).slice(0, 160), status);
  }

  private async read(path: string): Promise<unknown> {
    const { status, json } = await this.http.request(path);
    this.refuse(status, json);
    return json;
  }

  private async write(path: string, body: unknown): Promise<void> {
    const { status, json } = await this.http.request(path, "POST", body);
    this.refuse(status, json);
    const entries = Array.isArray(json) ? json : [json];
    if (!entries.some((entry) => entry && typeof entry === "object" && (entry as { type?: unknown }).type === "success")) {
      throw new ProviderError("Mailcow", "did not confirm the change", status);
    }
  }

  async hasDomain(domain: string): Promise<boolean> {
    const reply = await this.read(`/get/domain/${encodeURIComponent(domain)}`);
    if (empty(reply)) return false;
    const entry = single(reply);
    if (!entry || String(entry.domain_name ?? "").toLowerCase() !== domain) throw new ProviderError("Mailcow", `answered for another domain than ${domain}`);
    return true;
  }

  async dkim(domain: string): Promise<MailcowDkim | null> {
    const reply = await this.read(`/get/dkim/${encodeURIComponent(domain)}`);
    if (empty(reply)) return null;
    const entry = single(reply);
    const selector = typeof entry?.dkim_selector === "string" ? entry.dkim_selector : "";
    const txt = typeof entry?.dkim_txt === "string" ? entry.dkim_txt.replace(/\s+/g, "") : "";
    const key = typeof entry?.pubkey === "string" ? entry.pubkey.replace(/\s+/g, "") : "";
    if (!/^[a-z0-9][a-z0-9_-]{0,62}$/i.test(selector) || !/^v=DKIM1;/i.test(txt) || !key || !txt.endsWith(`p=${key}`)) {
      throw new ProviderError("Mailcow", `returned a DKIM key for ${domain} this addon does not understand`);
    }
    return { selector: selector.toLowerCase(), txt };
  }

  /** The mailbox's sender ACL, or null when this Mailcow does not report it. */
  async senderAcl(address: string): Promise<string[] | null> {
    const reply = await this.read(`/get/mailbox/${encodeURIComponent(address)}`);
    if (empty(reply)) throw new ProviderError("Mailcow", `has no mailbox ${address}`);
    const entry = single(reply);
    if (!entry || String(entry.username ?? "").toLowerCase() !== address) throw new ProviderError("Mailcow", `answered for another mailbox than ${address}`);
    if (!Array.isArray(entry.sender_acl)) return null;
    return entry.sender_acl.filter((item): item is string => typeof item === "string").map((item) => item.toLowerCase());
  }

  /** `key_size: 0` keeps Mailcow from generating its own key, so the profile's choice is the one made. */
  addDomain(domain: string): Promise<void> {
    return this.write("/add/domain", {
      domain, active: 1, aliases: 400, mailboxes: 10, defquota: 3072, maxquota: 10240, quota: 10240,
      backupmx: 0, relay_all_recipients: 0, restart_sogo: 0, key_size: 0,
    });
  }

  duplicateDkim(from: string, to: string): Promise<void> {
    return this.write("/add/dkim_duplicate", { from_domain: from, to_domain: to });
  }

  generateDkim(domain: string, selector: string, bits: number): Promise<void> {
    return this.write("/add/dkim", { domains: domain, dkim_selector: selector, key_size: bits });
  }

  /** Mailcow replaces the whole list, so this is always the list read a moment ago plus what is new. */
  setSenderAcl(address: string, acl: string[]): Promise<void> {
    return this.write("/edit/mailbox", { items: [address], attr: { sender_acl: acl } });
  }
}

export function aclAllows(acl: string[], domain: string): boolean {
  return acl.includes("*") || acl.includes(`@${domain}`) || acl.includes(domain);
}

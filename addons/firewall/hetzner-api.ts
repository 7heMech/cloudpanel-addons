/**
 * The parts of Hetzner Cloud's API that Firewall uses, through the shared
 * provider client. The token goes only into the Authorization header, and every
 * message that leaves here has it redacted.
 */
import { ProviderError, ProviderHttp, type ApiFetch } from "../../lib/provider-http";

export const HETZNER_API = "https://api.hetzner.cloud/v1";
export const METADATA_INSTANCE_ID = "http://169.254.169.254/hetzner/v1/metadata/instance-id";
const METADATA_HOSTNAME = "http://169.254.169.254/hetzner/v1/metadata/hostname";

export interface HetznerRule {
  direction: "in" | "out";
  protocol: string;
  port?: string | null;
  source_ips?: string[];
  destination_ips?: string[];
  description?: string | null;
}

export interface HetznerFirewall {
  id: number;
  name: string;
  labels: Record<string, string>;
  rules: HetznerRule[];
  applied_to: { type: string; server?: { id: number }; label_selector?: { selector: string }; applied_to_resources?: { type: string; server?: { id: number } }[] }[];
}

export interface HetznerServer {
  id: number;
  name: string;
  firewalls: { id: number; status: string }[];
}

interface Action { id: number; status: string; error?: { code: string; message: string } | null }

export class HetznerError extends ProviderError {
  constructor(message: string, status: number, readonly code: string) {
    super("Hetzner", message, status);
  }
}

/** A Hetzner Cloud API token: letters and digits, 64 of them today. */
export function validToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9]{32,128}$/.test(value);
}

async function metadata(url: string, fetcher: ApiFetch, timeoutMs: number): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, { signal: controller.signal, redirect: "error" });
    const text = response.ok ? (await response.text()).trim() : "";
    if (!response.ok) await response.body?.cancel();
    return response.ok ? text : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** This server's id from Hetzner Cloud's metadata service, or null anywhere else. */
export async function hetznerServerId(fetcher: ApiFetch = fetch, timeoutMs = 1500): Promise<number | null> {
  const text = await metadata(METADATA_INSTANCE_ID, fetcher, timeoutMs);
  return text !== null && /^[1-9]\d{0,15}$/.test(text) ? Number(text) : null;
}

/** This server's hostname from the metadata service: its name in Hetzner when it was created. */
export async function hetznerHostname(fetcher: ApiFetch = fetch, timeoutMs = 1500): Promise<string | null> {
  const text = await metadata(METADATA_HOSTNAME, fetcher, timeoutMs);
  return text !== null && /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(text) ? text : null;
}

export class HetznerApi {
  private readonly http: ProviderHttp;

  constructor(
    private readonly token: string,
    fetcher: ApiFetch = fetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
    timeoutMs?: number,
  ) {
    this.http = new ProviderHttp("Hetzner", HETZNER_API, { Authorization: `Bearer ${token}` }, fetcher, { until: 0 }, timeoutMs);
  }

  clean(text: string): string {
    return this.http.clean(text);
  }

  private async call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const { status, json } = await this.http.request(path, method, body);
    if (status >= 200 && status < 300) return json as T;
    const error = (json as { error?: { code?: unknown; message?: unknown } } | null)?.error;
    const code = typeof error?.code === "string" ? error.code : "";
    const message = typeof error?.message === "string" ? error.message : `HTTP ${status}`;
    throw new HetznerError(this.clean(code ? `${message} (${code})` : message), status, code);
  }

  async server(id: number): Promise<HetznerServer> {
    const { server } = await this.call<{ server: { id: number; name: string; public_net?: { firewalls?: { id: number; status: string }[] } } }>(`/servers/${id}`);
    return { id: server.id, name: server.name, firewalls: server.public_net?.firewalls ?? [] };
  }

  /** Every firewall in the project, or those a label selector picks. */
  async firewalls(labelSelector?: string): Promise<HetznerFirewall[]> {
    const all: HetznerFirewall[] = [];
    for (let page = 1; page; ) {
      const query = new URLSearchParams({ page: String(page), per_page: "50" });
      if (labelSelector) query.set("label_selector", labelSelector);
      const reply = await this.call<{ firewalls: HetznerFirewall[]; meta?: { pagination?: { next_page?: number | null } } }>(`/firewalls?${query}`);
      all.push(...reply.firewalls);
      page = reply.meta?.pagination?.next_page ?? 0;
    }
    return all;
  }

  async firewall(id: number): Promise<HetznerFirewall> {
    return (await this.call<{ firewall: HetznerFirewall }>(`/firewalls/${id}`)).firewall;
  }

  async create(name: string, labels: Record<string, string>, rules: HetznerRule[], serverId: number): Promise<HetznerFirewall> {
    const reply = await this.call<{ firewall: HetznerFirewall; actions: Action[] }>("/firewalls", "POST", {
      name, labels, rules, apply_to: [{ type: "server", server: { id: serverId } }],
    });
    await this.settle(reply.actions);
    return reply.firewall;
  }

  async setRules(id: number, rules: HetznerRule[]): Promise<void> {
    await this.settle((await this.call<{ actions: Action[] }>(`/firewalls/${id}/actions/set_rules`, "POST", { rules })).actions);
  }

  async setLabels(id: number, labels: Record<string, string>): Promise<void> {
    await this.call(`/firewalls/${id}`, "PUT", { labels });
  }

  async apply(id: number, serverId: number): Promise<void> {
    const body = { apply_to: [{ type: "server", server: { id: serverId } }] };
    await this.settle((await this.call<{ actions: Action[] }>(`/firewalls/${id}/actions/apply_to_resources`, "POST", body)).actions);
  }

  async remove(id: number, serverId: number): Promise<void> {
    const body = { remove_from: [{ type: "server", server: { id: serverId } }] };
    await this.settle((await this.call<{ actions: Action[] }>(`/firewalls/${id}/actions/remove_from_resources`, "POST", body)).actions);
  }

  async delete(id: number): Promise<void> {
    await this.call(`/firewalls/${id}`, "DELETE");
  }

  /** Waits for Hetzner to finish the actions a change started, up to half a minute. */
  private async settle(actions: Action[] | undefined): Promise<void> {
    for (const started of actions ?? []) {
      let action = started;
      for (let tries = 0; action.status === "running" && tries < 30; tries++) {
        await this.sleep(1000);
        action = (await this.call<{ action: Action }>(`/actions/${action.id}`)).action;
      }
      if (action.status === "error") {
        throw new HetznerError(this.clean(`${action.error?.message ?? "an action failed"} (${action.error?.code ?? "error"})`), 0, action.error?.code ?? "");
      }
      if (action.status === "running") throw new HetznerError("Hetzner is still applying the change; reload the page in a minute", 0, "running");
    }
  }
}

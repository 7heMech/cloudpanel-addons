// A fake of the parts of Hetzner Cloud's API that Firewall uses, answering in
// its documented shapes: `{ error: { code, message } }` for a refusal, firewalls
// with `applied_to`, servers with `public_net.firewalls`, and actions that
// finish at once. The metadata service answers when `serverId` is set.
import type { ApiFetch } from "../../lib/provider-http";
import type { HetznerFirewall, HetznerRule } from "../../addons/firewall/hetzner-api";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const refuse = (status: number, code: string, message: string) => json({ error: { code, message } }, status);

export class FakeHetzner {
  firewalls: HetznerFirewall[] = [];
  servers = new Map<number, string>();
  calls: { method: string; path: string; body?: unknown }[] = [];
  /** What the metadata service answers on this "server"; null for not Hetzner Cloud. */
  serverId: number | null;
  /** An error message that repeats the token, as some providers' do. */
  echoToken = false;
  /** Answer every apply with not_found, as if another server deleted the firewall each time. */
  applyNotFound = false;
  private nextId = 1000;

  constructor(readonly token: string, serverId: number | null = 166224552) {
    this.serverId = serverId;
    if (serverId) this.servers.set(serverId, "cp-fra-1");
  }

  firewall(name: string, rules: HetznerRule[], servers: number[] = [], labels: Record<string, string> = {}): HetznerFirewall {
    const firewall: HetznerFirewall = {
      id: this.nextId++, name, labels, rules,
      applied_to: servers.map((id) => ({ type: "server", server: { id } })),
    };
    this.firewalls.push(firewall);
    return firewall;
  }

  /** The firewalls attached to a server, as its `public_net.firewalls` lists them. */
  attachedTo(serverId: number): HetznerFirewall[] {
    return this.firewalls.filter((firewall) => firewall.applied_to.some((entry) => entry.server?.id === serverId));
  }

  writes(): { method: string; path: string; body?: unknown }[] {
    return this.calls.filter((call) => call.method !== "GET");
  }

  /** As the fetch of a server with this id; the metadata service answers for it. */
  fetchAs(serverId: number | null): ApiFetch {
    return async (url, init) => {
      if (url.startsWith("http://169.254.169.254/")) {
        if (serverId === null) throw new Error("connect ECONNREFUSED");
        return new Response(String(serverId));
      }
      return this.api(url, init);
    };
  }

  fetch: ApiFetch = (url, init) => this.fetchAs(this.serverId)(url, init);

  private async api(url: string, init: RequestInit): Promise<Response> {
    const { pathname, searchParams } = new URL(url);
    const path = pathname.replace(/^\/v1/, "");
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    this.calls.push({ method, path: `${path}${searchParams.size ? `?${searchParams}` : ""}`, ...(body === undefined ? {} : { body }) });
    const auth = (init.headers as Record<string, string>).Authorization;
    if (auth !== `Bearer ${this.token}`) {
      return refuse(401, "unauthorized", this.echoToken ? `unable to authenticate with ${auth?.replace("Bearer ", "")}` : "unable to authenticate");
    }

    let match = /^\/servers\/(\d+)$/.exec(path);
    if (match && method === "GET") {
      const id = Number(match[1]);
      if (!this.servers.has(id)) return refuse(404, "not_found", "server not found");
      return json({ server: { id, name: this.servers.get(id), public_net: { firewalls: this.attachedTo(id).map((firewall) => ({ id: firewall.id, status: "applied" })) } } });
    }
    if (path === "/firewalls" && method === "GET") {
      const selector = searchParams.get("label_selector");
      const [key, value] = selector?.split("=") ?? [];
      const list = selector ? this.firewalls.filter((firewall) => firewall.labels[key!] === value) : this.firewalls;
      const page = Number(searchParams.get("page") ?? 1);
      const per = Number(searchParams.get("per_page") ?? 25);
      const slice = list.slice((page - 1) * per, page * per);
      return json({ firewalls: structuredClone(slice), meta: { pagination: { page, per_page: per, next_page: page * per < list.length ? page + 1 : null } } });
    }
    if (path === "/firewalls" && method === "POST") {
      if (this.firewalls.some((firewall) => firewall.name === body.name)) return refuse(409, "uniqueness_error", "name is already used");
      const firewall = this.firewall(body.name, body.rules, body.apply_to.map((entry: { server: { id: number } }) => entry.server.id), body.labels);
      return json({ firewall: structuredClone(firewall), actions: [{ id: 1, status: "success" }] }, 201);
    }
    match = /^\/firewalls\/(\d+)(?:\/actions\/(\w+))?$/.exec(path);
    const firewall = match ? this.firewalls.find((item) => item.id === Number(match![1])) : undefined;
    if (match && !firewall) return refuse(404, "not_found", "firewall not found");
    if (match && firewall) {
      const action = match[2];
      if (!action && method === "GET") return json({ firewall: structuredClone(firewall) });
      if (!action && method === "PUT") { firewall.labels = body.labels; return json({ firewall: structuredClone(firewall) }); }
      if (!action && method === "DELETE") {
        if (firewall.applied_to.length) return refuse(422, "resource_in_use", "firewall is still in use");
        this.firewalls = this.firewalls.filter((item) => item !== firewall);
        return new Response(null, { status: 204 });
      }
      const done = json({ actions: [{ id: 2, status: "success" }] }, 201);
      if (action === "set_rules") { firewall.rules = body.rules; return done; }
      if (action === "apply_to_resources") {
        if (this.applyNotFound) return refuse(404, "not_found", "firewall not found");
        const id = body.apply_to[0].server.id;
        if (firewall.applied_to.some((entry) => entry.server?.id === id)) return refuse(422, "firewall_already_applied", "already applied");
        firewall.applied_to.push({ type: "server", server: { id } });
        return done;
      }
      if (action === "remove_from_resources") {
        const id = body.remove_from[0].server.id;
        firewall.applied_to = firewall.applied_to.filter((entry) => entry.server?.id !== id);
        return done;
      }
    }
    return refuse(404, "not_found", `no route for ${method} ${path}`);
  }
}

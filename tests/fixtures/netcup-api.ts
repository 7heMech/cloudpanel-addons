// A fake of netcup's Keycloak realm and the parts of the SCP REST API that
// Firewall uses, in the shapes of netcup's OpenAPI document
// (/scp-core/api/v1/openapi) and the realm's discovery document: OAuth errors
// as `{ error, error_description }`, SCP errors as `{ code, message }`, policy
// writes and firewall writes answering 202 with a task that finishes on its
// first read, and the policy listing without rules. Refresh tokens rotate on
// every use, as Keycloak's "revoke refresh token" setting makes them. The
// address filter on `/servers` finds nothing for IPv6, which the spec leaves
// open, and userinfo's `id` claim, which the discovery document does not list,
// can be left out.
import type { ApiFetch } from "../../lib/provider-http";
import type { NetcupFirewall, NetcupPolicy, NetcupRule } from "../../addons/firewall/netcup-api";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

interface FakeServer {
  id: number; name: string; nickname: string | null; mac: string; ip: string | null;
  ipv6: { networkPrefix: string; cidr: string } | null;
  firewall: { copied: number[]; user: number[]; active: boolean };
  /** Failover IPv4 addresses routed to this interface. */
  routed: string[];
  disabled: boolean;
  /** Answer reads of the server's interfaces with this HTTP status instead. */
  interfacesStatus: number | null;
}

export class FakeNetcup {
  policies: NetcupPolicy[] = [];
  servers: FakeServer[] = [];
  calls: { method: string; path: string; body?: unknown }[] = [];
  userId = 4711;
  /** The customer number, which is the SCP username. */
  username = "123456";
  /** Whether userinfo carries the `id` claim, or a different id to carry. */
  userinfoId: boolean | number = true;
  /** The state every task reads as after it started. */
  taskState = "FINISHED";
  /** Answer the device poll with this HTTP status instead. */
  pollStatus: number | null = null;
  /** Answer reads of a server's firewall with this HTTP status instead. */
  firewallReadStatus: number | null = null;
  /** How many task reads to answer with 503 first. */
  taskReadFailures = 0;
  /** Answer firewall writes with 204 and no task. */
  firewallNoTask = false;
  /** Whether the operator granted access to the pending device code. */
  granted = false;
  /** Refused with `access_denied` instead, as when the operator clicks No. */
  denied = false;
  /** The refresh token issued last; each use of one replaces it with a new one. */
  refreshToken: string | null = null;
  private valid = new Set<string>();
  /** Refuse every firewall write with this validation message. */
  refuseFirewall: string | null = null;
  revoked: string[] = [];
  private accessTokens = new Set<string>();
  private serial = 0;
  private nextId = 300;
  private tasks = new Map<string, number>();

  constructor() {
    this.server(512345, "v2202411000000001", "cp-nue-1", "aa:bb:cc:00:00:01", "203.0.113.24");
    this.policy("netcup Mail block", [
      { direction: "EGRESS", protocol: "TCP", action: "DROP", destinationPorts: "25", description: "Block outgoing SMTP" },
    ], "copied");
  }

  server(id: number, name: string, nickname: string | null, mac: string, ip: string | null, ipv6: FakeServer["ipv6"] = null): FakeServer {
    const server = { id, name, nickname, mac, ip, ipv6, firewall: { copied: [], user: [], active: true }, routed: [], disabled: false, interfacesStatus: null };
    this.servers.push(server);
    const mail = this.policies.find((policy) => policy.name === "netcup Mail block");
    if (mail) server.firewall.copied = [mail.id] as never;
    return server;
  }

  policy(name: string, rules: NetcupRule[], on: "copied" | number[] = [], description: string | null = null): NetcupPolicy {
    const policy: NetcupPolicy = { id: this.nextId++, name, description, rules };
    this.policies.push(policy);
    if (on === "copied") for (const server of this.servers) (server.firewall.copied as number[]).push(policy.id);
    else for (const id of on) (this.servers.find((server) => server.id === id)!.firewall.user as number[]).push(policy.id);
    return policy;
  }

  /** A sign-in Keycloak already issued, as after the device grant. */
  issue(): string {
    this.refreshToken = `eyJrefresh.${++this.serial}.signature-of-the-refresh-token`;
    this.valid.add(this.refreshToken);
    return this.refreshToken;
  }

  /** Ends every session, as when the operator revokes access in netcup or the offline session expires. */
  revokeAll(): void {
    this.valid.clear();
  }

  named(name: string): NetcupPolicy[] {
    return this.policies.filter((policy) => policy.name === name);
  }

  /** The policy names on a server's interface, user ones in order. */
  userPolicies(serverId = 512345): string[] {
    return this.servers.find((server) => server.id === serverId)!.firewall.user.map((id) => this.policies.find((policy) => policy.id === id)!.name);
  }

  writes(): { method: string; path: string; body?: unknown }[] {
    return this.calls.filter((call) => call.method !== "GET" && !call.path.startsWith("/realms/"));
  }

  private access(): string {
    const token = `access-${++this.serial}-token-value`;
    this.accessTokens.add(token);
    return token;
  }

  private firewallOf(server: FakeServer): NetcupFirewall {
    const byId = (id: number) => structuredClone(this.policies.find((policy) => policy.id === id)!);
    const user = server.firewall.user.map(byId);
    const drops = user.some((policy) => (policy.rules ?? []).some((rule) => rule.direction === "INGRESS"));
    return {
      copiedPolicies: server.firewall.copied.map(byId), userPolicies: user,
      ingressImplicitRule: drops ? "DROP_ALL" : "ACCEPT_ALL", egressImplicitRule: "ACCEPT_ALL", active: server.firewall.active,
    };
  }

  private task(): { uuid: string; state: string } {
    const uuid = `task-${++this.serial}`;
    this.tasks.set(uuid, 0);
    return { uuid, state: "RUNNING" };
  }

  fetch: ApiFetch = async (url, init) => {
    const { pathname, searchParams } = new URL(url);
    const method = init.method ?? "GET";
    const raw = typeof init.body === "string" ? init.body : undefined;
    const form = raw && (init.headers as Record<string, string>)["Content-Type"] === "application/x-www-form-urlencoded" ? new URLSearchParams(raw) : null;
    const body = raw && !form ? JSON.parse(raw) : undefined;
    this.calls.push({ method, path: `${pathname}${searchParams.size ? `?${searchParams}` : ""}`, ...(body === undefined ? {} : { body }) });
    if (!url.startsWith("https://www.servercontrolpanel.de/")) throw new Error(`unexpected host in ${url}`);

    const oidc = "/realms/scp/protocol/openid-connect";
    if (pathname.startsWith(oidc)) {
      const path = pathname.slice(oidc.length);
      const oauthError = (error: string, description: string) => json({ error, error_description: description }, 400);
      if (path === "/auth/device" && method === "POST") {
        if (form?.get("client_id") !== "scp") return oauthError("invalid_client", "Invalid client");
        return json({
          device_code: "device-code-0123456789abcdefghijklmnopqrstuv", user_code: "BQMU-KITQ",
          verification_uri: "https://www.servercontrolpanel.de/realms/scp/device",
          verification_uri_complete: "https://www.servercontrolpanel.de/realms/scp/device?user_code=BQMU-KITQ",
          expires_in: 600, interval: 5,
        });
      }
      if (path === "/token" && method === "POST") {
        const grant = form?.get("grant_type");
        if (grant === "urn:ietf:params:oauth:grant-type:device_code") {
          if (this.pollStatus) return json({ error: "temporarily_unavailable" }, this.pollStatus);
          if (this.denied) return oauthError("access_denied", "Access denied");
          if (!this.granted) return oauthError("authorization_pending", "The authorization request is still pending");
          this.granted = false;
          return json({ access_token: this.access(), refresh_token: this.issue(), token_type: "Bearer", expires_in: 300 });
        }
        if (grant === "refresh_token") {
          const used = form?.get("refresh_token") ?? "";
          if (!this.valid.delete(used)) return oauthError("invalid_grant", "Invalid refresh token");
          return json({ access_token: this.access(), refresh_token: this.issue(), token_type: "Bearer", expires_in: 300 });
        }
        return oauthError("unsupported_grant_type", "Unsupported grant_type");
      }
      if (path === "/revoke" && method === "POST") {
        const token = form?.get("token") ?? "";
        this.revoked.push(token);
        this.valid.delete(token);
        return new Response(null, { status: 200 });
      }
      if (path === "/userinfo" && method === "GET") {
        const auth = (init.headers as Record<string, string>).Authorization?.replace("Bearer ", "") ?? "";
        if (!this.accessTokens.has(auth)) return json({ error: "invalid_token" }, 401);
        const id = typeof this.userinfoId === "number" ? this.userinfoId : this.userId;
        return json({ sub: "f3a1c2d4", ...(this.userinfoId ? { id: String(id) } : {}), preferred_username: this.username });
      }
      return oauthError("invalid_request", `no route for ${method} ${path}`);
    }

    const path = pathname.replace(/^\/scp-core\/api\/v1/, "");
    const auth = (init.headers as Record<string, string>).Authorization?.replace("Bearer ", "") ?? "";
    if (!this.accessTokens.has(auth)) return json({ message: "Authorization header missing." }, 401);
    const notFound = (what: string) => json({ code: "NOT_FOUND", message: `${what} not found.` }, 404);

    if (path === "/servers" && method === "GET") {
      const ip = searchParams.get("ip");
      const offset = Number(searchParams.get("offset") ?? 0);
      const limit = Number(searchParams.get("limit") ?? 20);
      return json(this.servers.filter((server) => !ip || [server.ip ?? "", ...server.routed].some((each) => each.includes(ip))).slice(offset, offset + limit)
        .map(({ id, name, nickname, disabled }) => ({ id, name, nickname, hostname: null, disabled, template: null })));
    }
    if (path === "/tasks" && method === "GET") {
      return json([{ uuid: "task-old", name: "Reset password", state: "FINISHED", executingUser: { id: 17, username: "netcup-support" } }]);
    }
    let match = /^\/users\/(\d+)$/.exec(path);
    if (match && method === "GET") {
      if (Number(match[1]) !== this.userId) return json({ code: "FORBIDDEN", message: "Access denied." }, 403);
      return json({ id: this.userId, username: this.username, firstname: "Ada", lastname: "Example", email: "ada@example.com", company: null });
    }
    match = /^\/servers\/(\d+)\/logs$/.exec(path);
    if (match && method === "GET") {
      return json([{ type: "INFO", executingUser: { id: this.userId, username: this.username }, date: "2026-11-01T10:00:00Z", logKey: "server.start", message: "Server started" }]);
    }
    match = /^\/servers\/(\d+)\/interfaces$/.exec(path);
    if (match && method === "GET") {
      const server = this.servers.find((each) => each.id === Number(match![1]));
      if (!server) return notFound("Server");
      if (server.interfacesStatus) return json({ code: "FORBIDDEN", message: "Access denied." }, server.interfacesStatus);
      return json([{
        mac: server.mac, driver: "virtio", speedInMBits: 2500,
        ipv4Addresses: [
          ...server.ip ? [{ id: 1, interfaceMac: server.mac, type: "IP", ip: server.ip, cidr: `${server.ip}/22`, gateway: null, rdns: null, destinationIp: null, editable: false }] : [],
          ...server.routed.map((ip, i) => ({ id: 10 + i, interfaceMac: server.mac, type: "ROUTED_IP", ip, cidr: `${ip}/32`, gateway: null, rdns: null, destinationIp: server.ip, editable: true })),
        ],
        ipv6Addresses: server.ipv6 ? [{ id: 2, interfaceMac: server.mac, type: "IP", ...server.ipv6, gateway: "fe80::1", linkLocal: false, rdns: {}, destinationIp: null, editable: false }] : [],
      }]);
    }
    match = /^\/servers\/(\d+)\/interfaces\/([0-9a-f:]+)\/firewall$/.exec(path);
    if (match) {
      const server = this.servers.find((each) => each.id === Number(match![1]) && each.mac === match![2]);
      if (!server) return json({ code: "NOT_FOUND", message: "Firewall not found.", errors: [] }, 404);
      if (method === "GET") return this.firewallReadStatus ? json({ code: "UNAVAILABLE", message: "Service unavailable." }, this.firewallReadStatus) : json(this.firewallOf(server));
      if (method === "PUT") {
        if (this.refuseFirewall) return json({ code: "VALIDATION", message: "Validation error.", errors: [{ field: "userPolicies", message: this.refuseFirewall }] }, 422);
        const ids = (list: { id: number }[]) => list.map((item) => item.id);
        if (ids(body.userPolicies).some((id) => !this.policies.some((policy) => policy.id === id))) return json({ code: "NOT_FOUND", message: "Firewall policy not found." }, 404);
        server.firewall = { copied: ids(body.copiedPolicies), user: ids(body.userPolicies), active: body.active ?? true } as never;
        return this.firewallNoTask ? new Response(null, { status: 204 }) : json(this.task(), 202);
      }
    }
    match = /^\/users\/(\d+)\/firewall-policies(?:\/(\d+))?$/.exec(path);
    if (match) {
      if (Number(match[1]) !== this.userId) return json({ code: "FORBIDDEN", message: "Access denied." }, 403);
      if (!match[2] && method === "GET") {
        const offset = Number(searchParams.get("offset") ?? 0);
        const limit = Number(searchParams.get("limit") ?? 20);
        const copied = new Set(this.servers.flatMap((server) => server.firewall.copied));
        return json(this.policies.filter((policy) => !copied.has(policy.id)).slice(offset, offset + limit)
          .map(({ id, name, description }) => ({ id, name, description })));
      }
      if (!match[2] && method === "POST") {
        const policy = this.policy(body.name, body.rules ?? [], [], body.description ?? null);
        return json(structuredClone(policy), 201);
      }
      const policy = this.policies.find((each) => each.id === Number(match![2]));
      if (!policy) return notFound("Firewall policy");
      if (method === "GET") return json(structuredClone({ ...policy, rules: policy.rules!.map((rule) => ({ sourcePorts: null, destinations: [], numberOfEffectiveRules: Math.max(1, rule.sources?.length ?? 0), ...rule })) }));
      if (method === "PUT") {
        Object.assign(policy, { name: body.name, description: body.description ?? null, rules: body.rules ?? [] });
        return json({ firewallPolicy: structuredClone(policy), taskInfo: this.task() }, 202);
      }
    }
    match = /^\/tasks\/([\w-]+)$/.exec(path);
    if (match && method === "GET") {
      if (!this.tasks.has(match[1]!)) return notFound("Task");
      if (this.taskReadFailures > 0 && this.taskReadFailures--) return json({ code: "UNAVAILABLE", message: "Service unavailable." }, 503);
      return json({ uuid: match[1], name: "Update firewall", state: this.taskState, message: null, responseError: this.taskState === "ERROR" ? { code: "ERROR", message: "The hypervisor did not answer." } : null });
    }
    return json({ code: "NOT_FOUND", message: `no route for ${method} ${path}` }, 404);
  };
}

/**
 * The parts of netcup's Server Control Panel (SCP) REST API that Firewall
 * uses, and the OAuth sign-in in front of it, through the shared provider
 * client. Shapes follow netcup's OpenAPI document at
 * https://www.servercontrolpanel.de/scp-core/api/v1/openapi and the realm's
 * discovery document. Tokens go only into the Authorization header or the
 * OAuth form, and every message that leaves here has them redacted.
 */
import { errorMessage } from "../../lib/errors";
import { ProviderError, ProviderHttp, redact, type ApiFetch } from "../../lib/provider-http";

export const NETCUP_HOST = "https://www.servercontrolpanel.de";
export const SCP_API = `${NETCUP_HOST}/scp-core/api/v1`;
export const NETCUP_OIDC = `${NETCUP_HOST}/realms/scp/protocol/openid-connect`;
/** The public client netcup's own docs and tools use for the device sign-in. */
const CLIENT_ID = "scp";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

export interface NetcupRule {
  description?: string | null;
  direction: "INGRESS" | "EGRESS";
  protocol: "TCP" | "UDP" | "ICMP" | "ICMPv6";
  action: "ACCEPT" | "DROP";
  /** Empty or missing is any address. */
  sources?: string[] | null;
  sourcePorts?: string | null;
  destinations?: string[] | null;
  /** A port or a range; missing is any port. */
  destinationPorts?: string | null;
  numberOfEffectiveRules?: number;
}

export interface NetcupPolicy {
  id: number;
  name: string;
  description?: string | null;
  rules?: NetcupRule[];
}

export interface NetcupFirewall {
  copiedPolicies: NetcupPolicy[];
  userPolicies: NetcupPolicy[];
  ingressImplicitRule?: "ACCEPT_ALL" | "DROP_ALL";
  egressImplicitRule?: "ACCEPT_ALL" | "DROP_ALL";
  active: boolean;
}

export interface NetcupServer { id: number; name: string; nickname?: string | null; hostname?: string | null }

export interface NetcupInterface { mac: string; ipv4Addresses?: { ip: string }[]; ipv6Addresses?: { networkPrefix: string; cidr?: string }[] }

interface UserMinimal { id?: number; username?: string }

interface TaskInfo { uuid: string; state: string; message?: string | null; responseError?: { message?: string } | null; executingUser?: UserMinimal | null }

/** The states a task that did not finish ends in. */
export const TASK_FAILED = new Set(["ERROR", "CANCELED", "WAITING_FOR_CANCEL", "ROLLBACK"]);

export interface DeviceSignIn {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}

export interface NetcupTokens { access_token: string; refresh_token?: string }

export class NetcupError extends ProviderError {
  constructor(readonly detail: string, status: number, readonly code: string) {
    super("netcup", detail, status);
  }
}

/** A Keycloak refresh token: a JWT, or an opaque token of the same alphabet. */
export function validRefreshToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._~+/=-]{16,8192}$/.test(value);
}

const MAC = /^[a-fA-F0-9]{2}(:[a-fA-F0-9]{2}){5}$/;

/** netcup's Keycloak: the device sign-in, refreshing, revoking, and who signed in. */
export class NetcupAuth {
  private readonly http: ProviderHttp;
  private readonly secrets: string[] = [];

  constructor(private readonly fetcher: ApiFetch = fetch, private readonly timeoutMs?: number) {
    this.http = new ProviderHttp("netcup", NETCUP_OIDC, {}, fetcher, { until: 0 }, timeoutMs);
  }

  clean(text: string): string {
    return redact(text, this.secrets);
  }

  private async form<T>(path: string, fields: Record<string, string>): Promise<T> {
    this.secrets.push(...Object.entries(fields).filter(([key]) => /token|code/.test(key)).map(([, value]) => value));
    const { status, json } = await this.http.request(path, "POST", new URLSearchParams({ client_id: CLIENT_ID, ...fields }));
    if (status >= 200 && status < 300) return json as T;
    const body = json as { error?: unknown; error_description?: unknown } | null;
    const code = typeof body?.error === "string" ? body.error : "";
    const message = typeof body?.error_description === "string" ? body.error_description : code || `HTTP ${status}`;
    throw new NetcupError(this.clean(code && message !== code ? `${message} (${code})` : message), status, code);
  }

  startDevice(): Promise<DeviceSignIn> {
    return this.form<DeviceSignIn>("/auth/device", { scope: "openid offline_access" });
  }

  /** The tokens once the operator granted access, else why not yet: `authorization_pending` or `slow_down`. */
  async pollDevice(deviceCode: string): Promise<NetcupTokens | { pending: "authorization_pending" | "slow_down" }> {
    try {
      return await this.form<NetcupTokens>("/token", { grant_type: DEVICE_GRANT, device_code: deviceCode });
    } catch (error) {
      if (error instanceof NetcupError && (error.code === "authorization_pending" || error.code === "slow_down")) return { pending: error.code };
      throw error;
    }
  }

  /** A new access token, and a new refresh token when Keycloak rotates them. */
  refresh(refreshToken: string): Promise<NetcupTokens> {
    return this.form<NetcupTokens>("/token", { grant_type: "refresh_token", refresh_token: refreshToken });
  }

  async revoke(refreshToken: string): Promise<void> {
    await this.form("/revoke", { token: refreshToken, token_type_hint: "refresh_token" });
  }

  /** Who signed in: the customer number, which is the SCP username, and an `id` claim when the realm adds one. */
  async userinfo(accessToken: string): Promise<{ id: number | null; username: string | null }> {
    this.secrets.push(accessToken);
    const http = new ProviderHttp("netcup", NETCUP_OIDC, { Authorization: `Bearer ${accessToken}` }, this.fetcher, { until: 0 }, this.timeoutMs);
    const { status, json } = await http.request("/userinfo");
    if (status < 200 || status >= 300) throw new NetcupError(`userinfo answered HTTP ${status}`, status, status === 401 ? "unauthorized" : "");
    const claims = json as { id?: unknown; preferred_username?: unknown } | null;
    const id = Number(claims?.id);
    return {
      id: Number.isSafeInteger(id) && id > 0 ? id : null,
      username: typeof claims?.preferred_username === "string" && claims.preferred_username ? claims.preferred_username : null,
    };
  }
}

export interface NetcupApiOptions {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** When to stop waiting for tasks, across every write of one action. */
  deadline?: number;
  timeoutMs?: number;
}

export class NetcupApi {
  private readonly http: ProviderHttp;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(accessToken: string, fetcher: ApiFetch = fetch, private readonly options: NetcupApiOptions = {}) {
    this.http = new ProviderHttp("netcup", SCP_API, { Authorization: `Bearer ${accessToken}` }, fetcher, { until: 0 }, options.timeoutMs);
    this.sleep = options.sleep ?? ((ms) => Bun.sleep(ms));
    this.now = options.now ?? Date.now;
  }

  clean(text: string): string {
    return this.http.clean(text);
  }

  private async call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const { status, json } = await this.http.request(path, method, body);
    if (status >= 200 && status < 300) return json as T;
    const error = json as { code?: unknown; message?: unknown; errors?: { field?: unknown; message?: unknown }[] } | null;
    const code = typeof error?.code === "string" ? error.code : "";
    const fields = (Array.isArray(error?.errors) ? error.errors : [])
      .map((field) => `${String(field.field ?? "")}: ${String(field.message ?? "")}`).join("; ");
    const message = typeof error?.message === "string" && error.message ? error.message : `HTTP ${status}`;
    throw new NetcupError(this.clean(fields ? `${message} (${fields})` : message), status, code);
  }

  private static mac(mac: string): string {
    if (!MAC.test(mac)) throw new NetcupError(`${mac} is not an interface's MAC address`, 0, "");
    return mac.toLowerCase();
  }

  /** Every item of a listing, page by page, until a page is empty or brings nothing new. */
  private async all<T extends { id: number }>(path: string): Promise<T[]> {
    const found = new Map<number, T>();
    for (let offset = 0; ;) {
      const page = await this.call<T[]>(`${path}${path.includes("?") ? "&" : "?"}limit=100&offset=${offset}`);
      const before = found.size;
      for (const item of page) found.set(item.id, item);
      if (!page.length || found.size === before) return [...found.values()];
      offset += page.length;
    }
  }

  /** The servers in the account with this address; the filter may match more than the address, so callers check. */
  serversByIp(ip: string): Promise<NetcupServer[]> {
    return this.call<NetcupServer[]>(`/servers?${new URLSearchParams({ ip })}`);
  }

  servers(): Promise<NetcupServer[]> {
    return this.all<NetcupServer>("/servers");
  }

  /** The user, which answers only for the signed-in account's own id. */
  user(userId: number): Promise<UserMinimal> {
    return this.call<UserMinimal>(`/users/${userId}`);
  }

  /** Who ran the account's recent tasks and this server's logged actions: the SCP users that can sign in to it. */
  async executingUsers(serverId?: number): Promise<UserMinimal[]> {
    const tasks = await this.call<TaskInfo[]>("/tasks?limit=50");
    const logs = serverId ? await this.call<{ executingUser?: UserMinimal | null }[]>(`/servers/${serverId}/logs?limit=50`) : [];
    return [...tasks, ...logs].flatMap((entry) => entry.executingUser ? [entry.executingUser] : []);
  }

  interfaces(serverId: number): Promise<NetcupInterface[]> {
    return this.call<NetcupInterface[]>(`/servers/${serverId}/interfaces?loadRdns=false`);
  }

  firewall(serverId: number, mac: string): Promise<NetcupFirewall> {
    return this.call<NetcupFirewall>(`/servers/${serverId}/interfaces/${NetcupApi.mac(mac)}/firewall`);
  }

  /** Replaces the policies on the interface, in order, and waits until netcup applied them. */
  async setFirewall(serverId: number, mac: string, userPolicies: number[], copiedPolicies: number[]): Promise<void> {
    const task = await this.call<TaskInfo>(`/servers/${serverId}/interfaces/${NetcupApi.mac(mac)}/firewall`, "PUT", {
      userPolicies: userPolicies.map((id) => ({ id })), copiedPolicies: copiedPolicies.map((id) => ({ id })), active: true,
    });
    await this.settle(task);
  }

  /** Every policy in the account. The listing may leave out the rules; `policy` has them. */
  policies(userId: number): Promise<NetcupPolicy[]> {
    return this.all<NetcupPolicy>(`/users/${userId}/firewall-policies`);
  }

  policy(userId: number, id: number): Promise<NetcupPolicy> {
    return this.call<NetcupPolicy>(`/users/${userId}/firewall-policies/${id}`);
  }

  createPolicy(userId: number, name: string, description: string, rules: NetcupRule[]): Promise<NetcupPolicy> {
    return this.call<NetcupPolicy>(`/users/${userId}/firewall-policies`, "POST", { name, description, rules });
  }

  /** Rewrites a policy, and waits until netcup applied it to every server that has it. */
  async updatePolicy(userId: number, id: number, name: string, description: string, rules: NetcupRule[]): Promise<void> {
    const reply = await this.call<{ taskInfo?: TaskInfo }>(`/users/${userId}/firewall-policies/${id}`, "PUT", { name, description, rules });
    if (reply?.taskInfo) await this.settle(reply.taskInfo);
  }

  /**
   * Waits for a task netcup started, up to a minute or the action's deadline.
   * netcup took the change once it answered with the task, so every failure
   * from here is `running` or the state the task ended in, never a refusal.
   */
  private async settle(started: TaskInfo): Promise<void> {
    let task = started;
    const until = Math.min(this.now() + 60_000, this.options.deadline ?? Infinity);
    while ((task.state === "PENDING" || task.state === "RUNNING") && this.now() < until) {
      await this.sleep(1000);
      try {
        task = await this.call<TaskInfo>(`/tasks/${encodeURIComponent(task.uuid)}`);
      } catch (error) {
        throw new NetcupError(`took the change, but could not be asked whether it finished (${this.clean(errorMessage(error))})`, 0, "running");
      }
    }
    if (task.state === "PENDING" || task.state === "RUNNING") throw new NetcupError("took the change and is still applying it", 0, "running");
    if (task.state !== "FINISHED") {
      throw new NetcupError(this.clean(`took the change, but its task ended in ${task.state}: ${task.responseError?.message || task.message || "no reason given"}`), 0, task.state);
    }
  }
}

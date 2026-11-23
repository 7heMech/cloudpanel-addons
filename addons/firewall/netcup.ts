/**
 * netcup's server firewall in front of this server, letting only Cloudflare
 * reach its web ports and panel. netcup filters by policies, shared across the
 * account's servers and assigned per interface: the addon owns up to four,
 * found by name and its mark in their description, the same as Hetzner's
 * firewalls. See "netcup firewall" in docs/decisions/firewall.md.
 */
import { networkInterfaces } from "node:os";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { ActionFailure, failAction } from "../../lib/action";
import { writeOrRemove } from "../../lib/atomic-write";
import { requireSuccess, runCommand, type CommandResult } from "../../lib/command";
import { errorMessage } from "../../lib/errors";
import { withFileLock } from "../../lib/file-lock";
import { PANEL_CUSTOM_DOMAIN_FILE, PANEL_CUSTOM_DOMAIN_VHOST } from "../../lib/panel-custom-domain";
import { addonConfigFile, addonStateDir, CLOUDFLARE_IPS_PATH, DISTRO_NGINX_SITES_DIR, LOCK_DIR, PANEL_DB, ROOT_UID } from "../../lib/paths";
import { ProviderError, type ApiFetch } from "../../lib/provider-http";
import { readState, writeState } from "../../lib/root-state";
import {
  ANYONE, canonicalList, CLOUD_ROLES, contains, describeOpenings, disableReview, enableReview, firmwareVendor, mayRewriteAt, OPEN_DESCRIPTION, openToOthers,
  parseCidr, planFor, portsOf, readCloudflareRangesFrom, readSync as readSyncFile, roleView, ROLES, RULE_DESCRIPTION, sshMissing, sshPorts,
  writeSync as writeSyncFile,
  type Access, type Cidr, type CloudConnectedView, type CloudflareRanges, type CloudReview, type CloudRole, type CloudSetupState, type Guard,
  type HostPaths, type Plan, type PlanContext, type ProviderWords, type SeenState,
} from "./cloud-firewall";
import {
  NETCUP_HOST, NetcupApi, NetcupAuth, NetcupError, TASK_FAILED, validRefreshToken,
  type NetcupFirewall, type NetcupInterface, type NetcupPolicy, type NetcupRule, type NetcupServer,
} from "./netcup-api";
import { DEFAULT_FIREWALL_PATHS } from "./protocols";

/** Marks a policy as the addon's; a policy with one of its names but not this is never changed. */
const OWNER_MARK = "Managed by clp-addons";
/** When the writer's Cloudflare list was last refreshed, so a server with an older list leaves a newer one alone. */
const LIST_AT = /; Cloudflare's list of (\d{1,12})$/;

const WORDS: ProviderWords = {
  provider: "netcup",
  noun: "policy",
  console: "netcup's SCP console",
  nothingClosedYet: "No policy on this server has inbound rules yet, so netcup also closes every port the addon's policies do not open:",
  allOpenAgain: "no policy on this server has inbound rules any more, so netcup lets anyone reach every port again",
  closesMore: "netcup tracks only TCP connections: once it drops by default, replies to this server's own UDP traffic other than NTP to time.cloudflare.com and ptbtime1.ptb.de are dropped unless a policy allows them.",
};
const NO_TIMESYNCD = " This server does not keep time with systemd-timesyncd, so point its NTP client at those two servers, or its clock stops syncing.";

interface NetcupPaths extends HostPaths {
  tokenFile: string;
  /** A device sign-in in progress: its code, which only root reads. */
  deviceFile: string;
  syncFile: string;
  lockFile: string;
  /** Held while the refresh token is used and replaced, so two processes never spend the same one. */
  tokenLockFile: string;
  ranges: string;
  /** The firmware's vendor, which names netcup on its servers. */
  vendor: string;
  /** systemd-timesyncd's drop-in pointing it at the NTP servers the policies let replies in from. */
  timeSyncFile: string;
}

export const DEFAULT_NETCUP_PATHS: NetcupPaths = {
  tokenFile: `${addonStateDir("firewall")}/netcup-token.json`,
  deviceFile: `${addonStateDir("firewall")}/netcup-device.json`,
  syncFile: `${addonStateDir("firewall")}/netcup.json`,
  lockFile: `${LOCK_DIR}/firewall-netcup.lock`,
  tokenLockFile: `${LOCK_DIR}/firewall-netcup-token.lock`,
  ranges: CLOUDFLARE_IPS_PATH,
  panelDb: PANEL_DB,
  nginxSitesDir: DISTRO_NGINX_SITES_DIR,
  customDomain: PANEL_CUSTOM_DOMAIN_FILE,
  customDomainVhost: PANEL_CUSTOM_DOMAIN_VHOST,
  protocolsFile: DEFAULT_FIREWALL_PATHS.stateFile,
  terminalConfig: addonConfigFile("terminal"),
  vendor: "/sys/class/dmi/id/sys_vendor",
  timeSyncFile: "/etc/systemd/timesyncd.conf.d/zz-clp-addons-netcup.conf",
  rootUid: ROOT_UID,
  panelUid: null,
};

export interface NetcupOptions {
  paths?: Partial<NetcupPaths>;
  fetch?: ApiFetch;
  sleep?: (ms: number) => Promise<void>;
  resolve?: (host: string) => Promise<string[]>;
  run?: (command: string, args: string[]) => CommandResult;
  now?: () => number;
  /** This server's public IPv4 and global IPv6 addresses. */
  addresses?: () => string[];
  /** The MAC addresses of this server's interfaces. */
  macs?: () => string[];
}

function pathsOf(options: NetcupOptions): NetcupPaths {
  return { ...DEFAULT_NETCUP_PATHS, ...options.paths };
}

const nowOf = (options: NetcupOptions) => (options.now ?? Date.now)();
const addressesOf = (options: NetcupOptions) => (options.addresses ?? publicAddresses)();

/** How long a switch may wait for netcup's tasks, so it answers within the gateway's 240 seconds. */
const SWITCH_BUDGET_MS = 180_000;
/** How long a sign-in poll may spend scanning and locking after the grant, well under the gateway's 240 seconds. */
const POLL_BUDGET_MS = 90_000;
/** How long a page read may spend on netcup, well under `list`'s 60-second gateway timeout. */
const VIEW_BUDGET_MS = 25_000;
/** How long a no-match server scan is remembered, so page loads do not rescan every time. */
const UNMATCHED_FOR_MS = 15 * 60_000;

const TERMINAL_OAUTH_ERRORS = new Set([
  "access_denied", "expired_token", "invalid_grant", "invalid_client", "unauthorized_client", "invalid_request",
]);

function readCloudflareRanges(options: NetcupOptions): CloudflareRanges {
  return readCloudflareRangesFrom(pathsOf(options), "the netcup policies");
}

// --- Rules ------------------------------------------------------------------

/**
 * Inbound ICMP and ICMPv6 from anyone. Each of the addon's policies makes
 * netcup drop by default; IPv4 needs ICMP for path MTU discovery, and IPv6
 * stops working without neighbour discovery, router advertisements and Packet
 * Too Big, which would cut off a server with no IPv4.
 */
const ICMPV4: NetcupRule = {
  description: "ICMP, for path MTU discovery, kept by clp-addons", direction: "INGRESS", protocol: "ICMP", action: "ACCEPT", sources: [],
};
const ICMPV6: NetcupRule = {
  description: "ICMPv6, which IPv6 needs, kept by clp-addons", direction: "INGRESS", protocol: "ICMPv6", action: "ACCEPT", sources: [],
};
/**
 * netcup tracks only TCP, so replies to the server's NTP queries are new
 * inbound UDP, landing on Linux's default ephemeral ports. Source port 123 is
 * what NTP reflection floods come from, so only these servers' replies are let
 * in, and timesyncd is pointed at the same addresses. DNS needs no rule:
 * netcup always lets its own resolvers through.
 */
export const NTP_SERVERS: Record<string, string[]> = {
  "time.cloudflare.com": ["162.159.200.1", "162.159.200.123", "2606:4700:f1::1", "2606:4700:f1::123"],
  "ptbtime1.ptb.de": ["192.53.103.108", "2001:638:610:be01::108"],
};
const NTP_ADDRESSES = Object.values(NTP_SERVERS).flat();
const NTP_SOURCES = NTP_ADDRESSES.map((address) => parseCidr(address)!.text);
const NTP_REPLIES: NetcupRule[] = [false, true].map((v6) => ({
  description: "NTP replies from the pinned time servers, kept by clp-addons", direction: "INGRESS", protocol: "UDP", action: "ACCEPT",
  sources: NTP_SOURCES.filter((source) => source.includes(":") === v6), sourcePorts: "123", destinationPorts: "32768-60999",
}));
const FIXED: NetcupRule[] = [ICMPV4, ICMPV6, ...NTP_REPLIES];
const isNtpReply = (rule: NetcupRule) => rule.protocol === "UDP" && rule.sourcePorts === "123" && rule.destinationPorts === "32768-60999"
  && !rule.destinations?.length && Boolean(rule.sources?.length) && canonicalList(rule.sources).every((source) => NTP_SOURCES.includes(source));

/** The rules of one of the addon's policies: a pure function of the list, one rule per port and address family. */
export function netcupRules(role: CloudRole, ranges: string[]): NetcupRule[] {
  const families = [ranges.filter((range) => !range.includes(":")), ranges.filter((range) => range.includes(":"))];
  return [...CLOUD_ROLES[role].ports.flatMap((port) => families.map((sources) => ({
    description: RULE_DESCRIPTION, direction: "INGRESS" as const, protocol: "TCP" as const, action: "ACCEPT" as const,
    sources: [...sources], destinationPorts: String(port),
  }))), ...FIXED.map((rule) => ({ ...rule, sources: [...rule.sources!] }))];
}

/** The rules of a role's policy open to anyone: fixed, so every server writes the same. */
export function netcupOpenRules(role: CloudRole): NetcupRule[] {
  return [...CLOUD_ROLES[role].ports.map((port) => ({
    description: OPEN_DESCRIPTION, direction: "INGRESS" as const, protocol: "TCP" as const, action: "ACCEPT" as const,
    sources: [], destinationPorts: String(port),
  })), ...FIXED.map((rule) => ({ ...rule, sources: [...rule.sources!] }))];
}

/** Two rule sets with the same signature allow the same traffic, whatever order or spelling netcup returns. */
export function netcupSignature(rules: NetcupRule[] | undefined): string {
  return JSON.stringify((rules ?? []).map((rule) => JSON.stringify([
    rule.direction, rule.protocol, rule.action, rule.sourcePorts ?? "", rule.destinationPorts ?? "",
    canonicalList(rule.sources), canonicalList(rule.destinations), rule.description ?? "",
  ])).sort());
}

function descriptionFor(access: Access, refreshedAt: number): string {
  return access === "open" ? `${OWNER_MARK}; open to anyone` : `${OWNER_MARK}; Cloudflare's list of ${refreshedAt}`;
}

/** A policy by what it lets reach this server, in netcup's order. A rule for another destination lets no client in. */
function guardOf(policy: NetcupPolicy, ours: Cidr[] = []): Guard {
  const hits = (dest: Cidr) => dest.prefix === 0 || ours.some((address) => contains(dest, address));
  return {
    name: policy.name,
    rules: (policy.rules ?? []).flatMap((rule) => {
      if (rule.direction !== "INGRESS") return [];
      const rawSources = rule.sources?.length ? rule.sources : ANYONE;
      let sources = rawSources;
      if (rule.destinations?.length) {
        const dests = rule.destinations.map(parseCidr).filter((cidr): cidr is Cidr => cidr !== null);
        const hitsV4 = dests.some((dest) => !dest.v6 && hits(dest));
        const hitsV6 = dests.some((dest) => dest.v6 && hits(dest));
        sources = rawSources.filter((src) => {
          const cidr = parseCidr(src);
          return cidr !== null && (cidr.v6 ? hitsV6 : hitsV4);
        });
        if (!sources.length) return [];
      }
      return [{
        protocol: rule.protocol.toLowerCase(),
        port: rule.destinationPorts || "any",
        sources,
        accept: rule.action === "ACCEPT",
        ...(rule.sourcePorts ? { sourcePorts: rule.sourcePorts } : {}),
      }];
    }),
  };
}

const hasIngress = (policy: NetcupPolicy) => (policy.rules ?? []).some((rule) => rule.direction === "INGRESS");

function ownerOf(policy: NetcupPolicy): { role: CloudRole; access: Access } | null {
  if (!(policy.description ?? "").startsWith(OWNER_MARK)) return null;
  for (const role of ROLES) {
    if (policy.name === CLOUD_ROLES[role].name) return { role, access: "cloudflare" };
    if (policy.name === CLOUD_ROLES[role].open) return { role, access: "open" };
  }
  return null;
}

function owned(policies: NetcupPolicy[], role: CloudRole, access: Access = "cloudflare"): NetcupPolicy[] {
  return policies.filter((policy) => ownerOf(policy)?.role === role && ownerOf(policy)?.access === access).sort((a, b) => a.id - b.id);
}

export function mayRewrite(policy: NetcupPolicy, refreshedAt: number, now = Date.now()): boolean {
  return mayRewriteAt(Number(LIST_AT.exec(policy.description ?? "")?.[1]), refreshedAt, now);
}

// --- This server ------------------------------------------------------------

const PRIVATE_V4 = [
  "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12",
  "192.0.0.0/24", "192.168.0.0/16", "198.18.0.0/15",
].map((range) => parseCidr(range)!);

const GLOBAL_V6 = parseCidr("2000::/3")!;

export function isPublicAddress(address: string): boolean {
  const cidr = parseCidr(address);
  return cidr !== null && (cidr.v6 ? contains(GLOBAL_V6, cidr) : !PRIVATE_V4.some((range) => contains(range, cidr)));
}

/** The public IPv4 and global IPv6 addresses on this server's interfaces, IPv4 first: netcup puts them there, with no NAT in between. */
export function publicAddresses(): string[] {
  const found = new Set<string>();
  for (const list of Object.values(networkInterfaces())) {
    for (const entry of list ?? []) {
      if (!entry.internal && isPublicAddress(entry.address)) found.add(entry.address);
    }
  }
  return [...found].sort((a, b) => Number(a.includes(":")) - Number(b.includes(":")) || a.localeCompare(b));
}

export function interfaceMacs(): string[] {
  const found = new Set<string>();
  for (const list of Object.values(networkInterfaces())) {
    for (const entry of list ?? []) if (!entry.internal && entry.mac && entry.mac !== "00:00:00:00:00:00") found.add(entry.mac.toLowerCase());
  }
  return [...found];
}

export function isNetcup(vendorFile: string): boolean {
  return firmwareVendor(vendorFile).toLowerCase().includes("netcup");
}

// --- Stored state -----------------------------------------------------------

interface NetcupSync extends SeenState {
  /** The SCP user id, which netcup's policy endpoints are under. */
  userId?: number;
  /** This server in the account, as found by its interface or address. */
  serverId?: number;
  mac?: string;
  serverName?: string;
  /** When the account last had no server matching this one. */
  unmatchedAt?: number;
  /** Whether one of the addon's policies, Cloudflare or open, was last seen on this server. */
  held?: boolean;
}

interface DeviceState {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  interval: number;
  expiresAt: number;
}

function readToken(paths: NetcupPaths): string | null {
  const stored = readState<{ refreshToken?: unknown } | null>(paths.tokenFile, paths.rootUid, () => null);
  return validRefreshToken(stored?.refreshToken) ? stored.refreshToken : null;
}

function readSync(paths: NetcupPaths): NetcupSync {
  return readSyncFile<NetcupSync>(paths.syncFile, paths.rootUid);
}

function writeSync(paths: NetcupPaths, change: Partial<NetcupSync>): void {
  writeSyncFile<NetcupSync>(paths.syncFile, paths.rootUid, change);
}

async function withNetcupLock<T>(paths: NetcupPaths, body: () => Promise<T>, timeoutSeconds = 120): Promise<T> {
  return withFileLock(paths.lockFile, timeoutSeconds, "another netcup firewall change is running", body);
}

// --- Time sync --------------------------------------------------------------

const TIMESYNCD = "systemd-timesyncd";
const TIME_SYNC = `# Managed by clp-addons Firewall: netcup's policies let NTP replies in only from these servers.
[Time]
NTP=
NTP=${NTP_ADDRESSES.join(" ")}
FallbackNTP=
`;

const runOf = (options: NetcupOptions) => options.run ?? ((command: string, args: string[]) => runCommand(command, args, 30_000));
const timesyncdActive = (options: NetcupOptions) => runOf(options)("systemctl", ["is-active", TIMESYNCD]).stdout.trim() === "active";

/**
 * Puts timesyncd's drop-in in place, or takes it away, restarting timesyncd
 * when that changes it. The empty assignments clear servers set elsewhere,
 * and keep timesyncd off the pool, whose replies the policies drop. Other NTP
 * clients are left alone.
 */
function setTimeSync(options: NetcupOptions, on: boolean): string | null {
  const file = pathsOf(options).timeSyncFile;
  const want = on && timesyncdActive(options) ? TIME_SYNC : null;
  let have: string | null = null;
  try { have = readFileSync(file, "utf8"); } catch { /* none yet */ }
  if (have === want) return null;
  writeOrRemove(file, want, { mode: 0o644, createParent: true });
  requireSuccess(runOf(options)("systemctl", ["try-restart", TIMESYNCD]), `restarting ${TIMESYNCD} failed`);
  const servers = Object.keys(NTP_SERVERS).join(" and ");
  return want ? `${TIMESYNCD} pointed at ${servers}` : `${TIMESYNCD} no longer pointed at ${servers}`;
}

/**
 * Points timesyncd at the pinned NTP servers while any of the addon's policies
 * was last seen on this server: an open one makes netcup drop by default too.
 * Without a sign-in nothing says whether they are still there, so the drop-in
 * stays as it is; the pinned servers keep time either way.
 */
export function keepNetcupTimeSync(options: NetcupOptions = {}): string | null {
  const paths = pathsOf(options);
  if (!readToken(paths)) return null;
  const stored = readSync(paths);
  return setTimeSync(options, stored.held ?? Boolean(stored.seen?.web || stored.seen?.panel));
}

function withdrawNetcupTimeSync(options: NetcupOptions = {}): string | null {
  return setTimeSync(options, false);
}

/** A notice's last sentence when time sync could not follow a change. */
function timeSyncFailed(error: unknown): string {
  return ` This server's time sync could not be changed (${errorMessage(error).replace(/\.$/, "")}); repair tries again.`;
}

/** Whether netcup refuses the saved sign-in for good, so only signing in again helps. */
function signInRefused(error: unknown): boolean {
  return error instanceof NetcupError && (error.code === "invalid_grant" || error.code === "unauthorized" || error.status === 401);
}

/**
 * An access token from the saved refresh token. Keycloak may rotate the
 * refresh token on every use, so the new one is saved before the access
 * token is used, under a lock so no two processes spend the same one.
 */
async function signIn(paths: NetcupPaths, options: NetcupOptions, deadline?: number, tokenLockSeconds = 30): Promise<{ api: NetcupApi; auth: NetcupAuth; access: string; accountId?: number }> {
  let auth = new NetcupAuth(options.fetch);
  let accountId: number | undefined;
  const access = await withFileLock(paths.tokenLockFile, tokenLockSeconds, "another netcup sign-in is being refreshed", async () => {
    const token = readToken(paths);
    if (!token) failAction("Connect netcup first");
    accountId = readSync(paths).userId;
    const left = deadline === undefined ? undefined : deadline - nowOf(options);
    if (left !== undefined && left <= 0) throw new NetcupError("the request timed out", 0, "timeout");
    auth = new NetcupAuth(options.fetch, left === undefined ? undefined : Math.min(15_000, left));
    const tokens = await auth.refresh(token);
    if (validRefreshToken(tokens.refresh_token) && tokens.refresh_token !== token) {
      writeState(paths.tokenFile, { refreshToken: tokens.refresh_token }, paths.rootUid);
    }
    return tokens.access_token;
  });
  return { api: new NetcupApi(access, options.fetch, { sleep: options.sleep, now: options.now, deadline }), auth, access, accountId };
}

interface Target { serverId: number; mac: string; serverName: string }

const isRoutedIp = (entry: { type?: string | null; destinationIp?: string | null }) =>
  entry.type === "ROUTED_IP" || Boolean(entry.destinationIp);

/** An IPv6 prefix netcup lists for an interface; `cidr` may be the whole prefix or only its length. */
function prefixOf(entry: { networkPrefix: string; cidr?: string }): Cidr | null {
  const cidr = entry.cidr ?? "";
  const prefix = parseCidr(cidr.includes("/") ? cidr : `${entry.networkPrefix}/${/^\d{1,3}$/.test(cidr) ? cidr : "64"}`);
  return prefix?.v6 && prefix.prefix >= 64 ? prefix : null;
}

/** Whether netcup's interface carries one of this server's non-routed IPv4 addresses or a /64+ IPv6 prefix holding one of its IPv6 addresses. */
function matchesAddress(entry: NetcupInterface, addresses: Cidr[]): boolean {
  if (entry.ipv4Addresses?.some((ip) => !isRoutedIp(ip) && addresses.some((address) => !address.v6 && parseCidr(ip.ip)?.text === address.text))) {
    return true;
  }
  return (entry.ipv6Addresses ?? []).some((net) => {
    if (isRoutedIp(net)) return false;
    const prefix = prefixOf(net);
    return prefix !== null && addresses.some((address) => contains(prefix, address));
  });
}

/**
 * This server in the account: MAC across all candidates first, falling back to
 * non-routed addresses only when no MAC matches anywhere. Disabled servers and
 * a 4xx from one server's interfaces are skipped so one bad server never breaks
 * the search.
 */
async function findServer(api: NetcupApi, addresses: string[], macs: string[]): Promise<Target | null> {
  const ours = addresses.map(parseCidr).filter((cidr): cidr is Cidr => cidr !== null);
  const ourMacs = macs.map((mac) => mac.toLowerCase());
  const tried = new Set<number>();
  let byAddress: Target | null = null;
  const check = async (server: NetcupServer): Promise<Target | null> => {
    if (server.disabled || tried.has(server.id)) return null;
    tried.add(server.id);
    let interfaces: NetcupInterface[];
    try {
      interfaces = await api.interfaces(server.id);
    } catch (error) {
      if (error instanceof NetcupError && error.status >= 400 && error.status < 500 && error.status !== 401) return null;
      throw error;
    }
    const macHit = interfaces.find((entry) => ourMacs.includes(entry.mac.toLowerCase()));
    if (macHit) return { serverId: server.id, mac: macHit.mac.toLowerCase(), serverName: server.nickname || server.name };
    if (!byAddress) {
      const addrHit = interfaces.find((entry) => matchesAddress(entry, ours));
      if (addrHit) byAddress = { serverId: server.id, mac: addrHit.mac.toLowerCase(), serverName: server.nickname || server.name };
    }
    return !ourMacs.length ? byAddress : null;
  };
  for (const address of addresses) {
    let servers: NetcupServer[];
    try {
      servers = await api.serversByIp(address);
    } catch (error) {
      if (address.includes(":") && error instanceof NetcupError && (error.status === 400 || error.status === 422)) continue;
      throw error;
    }
    for (const server of servers) {
      const found = await check(server);
      if (found) return found;
    }
  }
  for (const server of await api.servers()) {
    const found = await check(server);
    if (found) return found;
  }
  return byAddress;
}

/** Writes netcup.json, under the netcup lock unless the caller holds it; an unlocked read writes only for its own account. */
async function saveSync(paths: NetcupPaths, change: Partial<NetcupSync>, locked: boolean, accountId?: number): Promise<void> {
  if (locked) return writeSync(paths, change);
  await withNetcupLock(paths, async () => {
    if (readToken(paths) && readSync(paths).userId === accountId) writeSync(paths, change);
  }, 0).catch(() => {});
}

/** Where this server is in the account, kept from the last time it was found; null when no server there is this one. */
async function locate(paths: NetcupPaths, options: NetcupOptions, api: NetcupApi, locked: boolean, fresh = false, accountId?: number): Promise<Target | null> {
  const stored = readSync(paths);
  const sameAccount = locked || stored.userId === accountId;
  if (!fresh && sameAccount && stored.serverId && stored.mac && stored.serverName) {
    return { serverId: stored.serverId, mac: stored.mac, serverName: stored.serverName };
  }
  const now = nowOf(options);
  if (!fresh && sameAccount && stored.unmatchedAt && now >= stored.unmatchedAt && now - stored.unmatchedAt < UNMATCHED_FOR_MS) return null;
  const found = await findServer(api, addressesOf(options), (options.macs ?? interfaceMacs)());
  await saveSync(paths, found
    ? { serverId: found.serverId, mac: found.mac, serverName: found.serverName, unmatchedAt: undefined }
    : { serverId: undefined, mac: undefined, serverName: undefined, unmatchedAt: now }, locked, accountId);
  return found;
}

/**
 * The SCP user id the policy endpoints are under, which is not the customer
 * number: userinfo's `id` claim where the realm adds one and `GET /users/<id>`
 * confirms it; else a user that ran this account's tasks or this server's
 * logged actions under the signed-in username, checked the same way.
 */
async function findUserId(api: NetcupApi, auth: NetcupAuth, access: string, serverId?: number): Promise<number> {
  const { id, username } = await auth.userinfo(access);
  const same = (name?: string) => !username || name?.toLowerCase() === username.toLowerCase();
  const verify = async (candidate: number): Promise<boolean> => {
    try {
      return same((await api.user(candidate)).username);
    } catch (error) {
      if (error instanceof NetcupError && (error.status === 403 || error.status === 404)) return false;
      throw error;
    }
  };
  if (id && await verify(id)) return id;
  const candidates = new Set((await api.executingUsers(serverId)).filter((user) => user.id && user.id !== id && same(user.username)).map((user) => user.id!));
  for (const candidate of candidates) {
    if (await verify(candidate)) return candidate;
  }
  failAction("netcup did not say which SCP user this sign-in is: userinfo has no usable id, and no task or log of this account names one");
}

/** The SCP user id, kept in netcup.json once found; callers hold the netcup lock. */
async function userIdOf(paths: NetcupPaths, api: NetcupApi, auth: NetcupAuth, access: string, serverId?: number): Promise<number> {
  const stored = readSync(paths).userId;
  if (stored) return stored;
  const userId = await findUserId(api, auth, access, serverId);
  writeSync(paths, { userId });
  return userId;
}

const unmatched = (options: NetcupOptions) => {
  const addresses = addressesOf(options);
  return `No server in this netcup account has this server's address${addresses.length ? ` (${addresses.join(", ")})` : ""}; connect the account that holds it`;
};

/** The interface's firewall, finding the server again once when netcup no longer knows the one kept; `missing` says why there is none. */
async function readFirewall(paths: NetcupPaths, options: NetcupOptions, api: NetcupApi, locked: boolean, accountId?: number): Promise<{ target: Target; firewall: NetcupFirewall } | { missing: string }> {
  for (let fresh = false; ; fresh = true) {
    const target = await locate(paths, options, api, locked, fresh, accountId);
    if (!target) return { missing: unmatched(options) };
    try {
      return { target, firewall: await api.firewall(target.serverId, target.mac) };
    } catch (error) {
      if (!(error instanceof NetcupError && error.status === 404)) throw error;
      if (fresh) return { missing: `netcup's firewall is not set up on ${target.serverName} yet: open Firewall for it in SCP and click Configure` };
    }
  }
}

async function firewallOf(paths: NetcupPaths, options: NetcupOptions, api: NetcupApi, locked: boolean): Promise<{ target: Target; firewall: NetcupFirewall }> {
  const read = await readFirewall(paths, options, api, locked);
  if ("missing" in read) failAction(read.missing);
  return read;
}

const OFF = "netcup's firewall is off for this server, so no policy has any effect. Turn it on under Firewall in SCP";

// --- What the page shows ----------------------------------------------------

export type NetcupView =
  | { state: "absent" }
  /** `address` is this server's public address, IPv4 first, for the operator to find the account that holds it. */
  | { state: "disconnected"; address: string | null }
  /** `connected` when a sign-in is saved, which the page then offers to replace or remove. */
  | { state: "error"; connected: boolean; error: string }
  | CloudConnectedView;

/** The policies on the interface, netcup's copied ones first, as one ordered list. */
function attachedOf(firewall: NetcupFirewall): (NetcupPolicy & { copied?: boolean })[] {
  return [...(firewall.copiedPolicies ?? []).map((policy) => ({ ...policy, copied: true })), ...(firewall.userPolicies ?? [])];
}

/** What the Setup checklist reads, without asking netcup. */
export function netcupSetupState(options: NetcupOptions = {}): CloudSetupState {
  const paths = pathsOf(options);
  const token = readToken(paths) !== null;
  const stored = token ? readSync(paths) : {};
  return { cloud: isNetcup(paths.vendor) || token, token, seen: stored.seen ?? {}, seenAt: stored.seenAt ?? null };
}

function seenOf(firewall: NetcupFirewall): Record<CloudRole, boolean> {
  const user = firewall.active ? firewall.userPolicies ?? [] : [];
  return { web: owned(user, "web").length > 0, panel: owned(user, "panel").length > 0 };
}

function heldOf(firewall: NetcupFirewall): boolean {
  const user = firewall.active ? firewall.userPolicies ?? [] : [];
  return ROLES.some((role) => owned(user, role).length > 0 || owned(user, role, "open").length > 0);
}

export async function netcupView(options: NetcupOptions = {}): Promise<NetcupView> {
  const paths = pathsOf(options);
  const now = nowOf(options);
  if (!readToken(paths)) {
    if (!isNetcup(paths.vendor)) return { state: "absent" };
    return { state: "disconnected", address: addressesOf(options)[0] ?? null };
  }
  const deadline = now + VIEW_BUDGET_MS;
  const ours = addressesOf(options).map(parseCidr).filter((cidr): cidr is Cidr => cidr !== null);
  let clean = (text: string) => text;
  try {
    const { api, auth, accountId } = await signIn(paths, options, deadline, 5);
    clean = (text) => auth.clean(api.clean(text));
    const read = await readFirewall(paths, options, api, false, accountId);
    if ("missing" in read) {
      await withNetcupLock(paths, async () => {
        const stored = readSync(paths);
        if (readToken(paths) && stored.userId === accountId && (stored.seenAt ?? 0) < now) writeSync(paths, { seen: { web: false, panel: false }, held: false, seenAt: now });
      }, 0).catch(() => {});
      return { state: "error", connected: true, error: `${read.missing}.` };
    }
    const { target, firewall } = read;
    const attached = attachedOf(firewall);
    const others = attached.filter((policy) => policy.copied || !ownerOf(policy));
    const otherGuards = others.map((policy) => guardOf(policy, ours));
    let ranges: CloudflareRanges | null = null;
    let rangesProblem: string | null = null;
    try { ranges = readCloudflareRanges(options); } catch (error) { rangesProblem = errorMessage(error); }
    const user = firewall.userPolicies ?? [];
    const roles = {} as CloudConnectedView["roles"];
    for (const role of ROLES) {
      const on = owned(user, role)[0];
      const open = owned(user, role, "open")[0];
      const current = !on || !ranges || netcupSignature(on.rules) === netcupSignature(netcupRules(role, ranges.ranges));
      roles[role] = roleView(role, Boolean(on), CLOUD_ROLES[role].name, open?.name ?? null, current, otherGuards, ranges, WORDS.noun);
    }
    await withNetcupLock(paths, async () => {
      const stored = readSync(paths);
      if (readToken(paths) && stored.userId === accountId && (stored.seenAt ?? 0) < now) writeSync(paths, { seen: seenOf(firewall), held: heldOf(firewall), seenAt: now });
    }, 0).catch(() => {});
    return {
      state: "connected", serverId: target.serverId, serverName: target.serverName, roles,
      others: others.map((policy) => policy.name),
      terminal: existsSync(paths.terminalConfig),
      sshClosed: user.some((policy) => ownerOf(policy)) ? sshMissing(sshPorts(options.run), otherGuards) : [],
      rangesProblem,
      blocked: firewall.active ? null : `${OFF}.`,
    };
  } catch (error) {
    if (signInRefused(error)) return { state: "error", connected: true, error: "netcup no longer accepts the saved sign-in; connect again." };
    if (error instanceof ActionFailure) return { state: "error", connected: true, error: `${error.message}.` };
    return { state: "error", connected: true, error: `netcup could not be read: ${clean(errorMessage(error))}` };
  }
}

// --- Signing in -------------------------------------------------------------

export interface NetcupSignIn { userCode: string; verificationUri: string; interval: number; expiresIn: number }

/** Starts netcup's device sign-in: the page shows the code and the link, and polls until the operator has granted access. */
export async function connectNetcup(options: NetcupOptions = {}): Promise<NetcupSignIn> {
  const paths = pathsOf(options);
  const auth = new NetcupAuth(options.fetch);
  let device;
  try {
    device = await auth.startDevice();
  } catch (error) {
    failAction(`Could not start netcup's sign-in: ${auth.clean(errorMessage(error))}`);
  }
  const link = device.verification_uri_complete || device.verification_uri;
  if (typeof link !== "string" || !link.startsWith(`${NETCUP_HOST}/`) || !/^[A-Z0-9-]{4,16}$/i.test(device.user_code ?? "")) {
    failAction("netcup's sign-in answered with an unexpected link or code");
  }
  const interval = Math.min(Math.max(Number(device.interval) || 5, 1), 60);
  const expiresIn = Math.min(Math.max(Number(device.expires_in) || 600, 60), 3600);
  writeState(paths.deviceFile, {
    deviceCode: device.device_code, userCode: device.user_code, verificationUri: link, interval, expiresAt: nowOf(options) + expiresIn * 1000,
  } satisfies DeviceState, paths.rootUid);
  return { userCode: device.user_code, verificationUri: link, interval, expiresIn };
}

/** Asks netcup whether the operator granted access; once they have, keeps the refresh token and finds this server. */
export async function pollNetcup(options: NetcupOptions = {}): Promise<{ pending: true; interval: number } | { notice: string }> {
  const paths = pathsOf(options);
  const device = readState<DeviceState | null>(paths.deviceFile, paths.rootUid, () => null);
  if (!device) failAction("No netcup sign-in is waiting; connect again");
  if (device.expiresAt <= nowOf(options)) {
    rmSync(paths.deviceFile, { force: true });
    failAction("The code expired before access was granted; connect again");
  }
  const auth = new NetcupAuth(options.fetch);
  let reply;
  try {
    reply = await auth.pollDevice(device.deviceCode);
  } catch (error) {
    const code = error instanceof NetcupError ? error.code : "";
    // Anything else may pass, and the code stays good until it expires, so the page keeps asking.
    if (!TERMINAL_OAUTH_ERRORS.has(code)) return { pending: true, interval: device.interval };
    rmSync(paths.deviceFile, { force: true });
    if (code === "access_denied") failAction("Access was denied in netcup; connect again to retry");
    if (code === "expired_token") failAction("The code expired before access was granted; connect again");
    failAction(`netcup's sign-in failed: ${auth.clean(errorMessage(error))}; connect again`);
  }
  if ("pending" in reply) {
    const interval = reply.pending === "slow_down" ? Math.min(device.interval + 5, 60) : device.interval;
    if (interval !== device.interval) writeState(paths.deviceFile, { ...device, interval }, paths.rootUid);
    return { pending: true, interval };
  }
  rmSync(paths.deviceFile, { force: true });
  if (!validRefreshToken(reply.refresh_token)) failAction("netcup gave no refresh token; connect again and allow offline access");
  const refreshToken = reply.refresh_token;
  const deadline = nowOf(options) + POLL_BUDGET_MS;
  const api = new NetcupApi(reply.access_token, options.fetch, { sleep: options.sleep, now: options.now, deadline });
  let saved = false;
  try {
    const found = await findServer(api, addressesOf(options), (options.macs ?? interfaceMacs)());
    if (!found && readToken(paths)) failAction(unmatched(options));
    const userId = await findUserId(api, auth, reply.access_token, found?.serverId);
    return await withNetcupLock(paths, async () => {
      const previous = await withFileLock(paths.tokenLockFile, 15, "another netcup sign-in is being refreshed", async () => {
        const current = readToken(paths);
        if (current && !found) failAction(unmatched(options));
        writeState(paths.tokenFile, { refreshToken }, paths.rootUid);
        try {
          writeState(paths.syncFile, found
            ? { userId, serverId: found.serverId, mac: found.mac, serverName: found.serverName }
            : { userId, unmatchedAt: nowOf(options) }, paths.rootUid);
        } catch (syncError) {
          try {
            if (current) writeState(paths.tokenFile, { refreshToken: current }, paths.rootUid);
            else rmSync(paths.tokenFile, { force: true });
          } catch {
            // The new token stays saved, revoked below, so it is never used against the old account's state.
            try { rmSync(paths.syncFile, { force: true }); } catch { /* the revoked token still asks to connect again */ }
          }
          throw syncError;
        }
        saved = true;
        return current;
      });
      if (previous && previous !== refreshToken) await auth.revoke(previous).catch(() => {});
      return { notice: found ? `Connected to netcup; this server is ${found.serverName} there.` : `Connected to netcup. ${unmatched(options)}.` };
    }, 15);
  } catch (error) {
    if (!saved) await auth.revoke(refreshToken).catch(() => {});
    if (error instanceof ActionFailure) throw error;
    failAction(`Signed in, but netcup could not be read: ${auth.clean(api.clean(errorMessage(error)))}`);
  }
}

export async function disconnectNetcup(options: NetcupOptions = {}): Promise<{ notice: string }> {
  const paths = pathsOf(options);
  return withNetcupLock(paths, async () => {
    rmSync(paths.deviceFile, { force: true });
    const token = readToken(paths);
    if (!token) return { notice: "No netcup sign-in is saved." };
    let unchecked = "";
    let active = true;
    let mine: NetcupPolicy[] = [];
    let auth = new NetcupAuth(options.fetch);
    let clean = (text: string) => auth.clean(text);
    const uncheckedBecause = (why: string) => ` netcup could not be asked which policies this server has (${why}); a clp-addons policy still there stays, and no longer follows Cloudflare's list.`;
    try {
      const session = await signIn(paths, options);
      auth = session.auth;
      clean = (text) => session.auth.clean(session.api.clean(text));
      const read = await readFirewall(paths, options, session.api, true);
      if ("missing" in read) unchecked = uncheckedBecause(read.missing);
      else {
        active = read.firewall.active;
        mine = (read.firewall.userPolicies ?? []).filter((policy) => ownerOf(policy));
      }
    } catch (error) {
      // A leaked or revoked sign-in must always be removable; any other failure may pass, and must not leave a policy behind unseen.
      if (!signInRefused(error)) {
        failAction(`Could not ask netcup which policies this server has: ${(error instanceof ActionFailure ? error.message : clean(errorMessage(error))).replace(/\.$/, "")}. Try again; disconnecting now would leave a clp-addons policy on this server that no longer follows Cloudflare's list`);
      }
      unchecked = uncheckedBecause("it refuses the saved sign-in");
    }
    const on = mine.filter((policy) => ownerOf(policy)!.access === "cloudflare");
    if (on.length && active) {
      failAction(`Turn both switches off first: ${on.map((policy) => policy.name).join(" and ")} would stay on this server and no longer follow Cloudflare's list`);
    }
    const open = mine.filter((policy) => ownerOf(policy)!.access === "open").map((policy) => policy.name);
    const inactive = on.length
      ? ` ${on.map((policy) => policy.name).join(" and ")} stay${on.length === 1 ? "s" : ""} on this server while netcup's firewall is off, and will no longer follow Cloudflare's list; remove ${on.length === 1 ? "it" : "them"} in SCP before turning the firewall on again.`
      : "";
    const staying = open.length ? ` ${open.join(" and ")} stay${open.length === 1 ? "s" : ""} on this server, so those ports stay open to anyone; remove ${open.length === 1 ? "it" : "them"} in SCP if you no longer want that.` : "";
    // Under the token lock, so a refresh running now cannot write a rotated token back.
    const revoked = await withFileLock(paths.tokenLockFile, 30, "another netcup sign-in is being refreshed", async () => {
      const done = await auth.revoke(readToken(paths) ?? token).then(() => true, () => false);
      rmSync(paths.tokenFile, { force: true });
      rmSync(paths.syncFile, { force: true });
      return done;
    });
    let timeSync = "";
    if (!open.length && !on.length) {
      try { withdrawNetcupTimeSync(options); } catch (error) { timeSync = timeSyncFailed(error); }
    }
    return { notice: `The netcup sign-in is removed${revoked ? " and revoked" : "; netcup could not be asked to revoke it, so it lapses once unused"}.${inactive}${staying}${unchecked}${timeSync}` };
  });
}

// --- Changes ----------------------------------------------------------------

function failureText(clean: (text: string) => string, error: unknown, doing: string): string {
  if (error instanceof ActionFailure) return error.message;
  if (signInRefused(error)) return `netcup no longer accepts the saved sign-in; connect again to ${doing}`;
  return `Could not ${doing}: ${clean(errorMessage(error))}`;
}

/** Why a write of this server's policies failed, and what it left: netcup took the change once it answered with a task, and changed nothing when it refused it. */
function writeFailure(clean: (text: string) => string, error: unknown, doing: string): string {
  const detail = error instanceof NetcupError ? clean(error.detail).replace(/\.$/, "") : "";
  if (error instanceof NetcupError && error.code === "running") {
    return `Could not wait for netcup to ${doing}: netcup ${detail}. Reload the page in a minute to see what this server has.`;
  }
  if (error instanceof NetcupError && TASK_FAILED.has(error.code)) return `Could not ${doing}: netcup ${detail}. See Firewall in SCP for what this server has now.`;
  const refused = error instanceof ActionFailure || (error instanceof ProviderError && error.status >= 400 && error.status < 500);
  return `${failureText(clean, error, doing)}. ${refused ? "Nothing on this server was changed." : "netcup may have taken it anyway; reload the page to see what this server has."}`;
}

type Attached = NetcupPolicy & { copied?: boolean };

/** Everything a switch decides from, read once. */
async function context(options: NetcupOptions, deadline: number) {
  const paths = pathsOf(options);
  if (!readToken(paths)) failAction("Connect netcup first");
  let session: Awaited<ReturnType<typeof signIn>>;
  let found: Awaited<ReturnType<typeof firewallOf>>;
  let userId: number;
  let policies: NetcupPolicy[];
  try {
    session = await signIn(paths, options, deadline);
    found = await firewallOf(paths, options, session.api, true);
    userId = await userIdOf(paths, session.api, session.auth, session.access, found.target.serverId);
    policies = await session.api.policies(userId);
  } catch (error) {
    failAction(failureText((text) => text, error, "read this server's policies"));
  }
  const { api, auth } = session;
  const target = { ...found.target, userId };
  const { firewall } = found;
  if (!firewall.active) failAction(`${OFF} first`);
  const attached: Attached[] = attachedOf(firewall);
  const user = firewall.userPolicies ?? [];
  const byRole = (access: Access) => Object.fromEntries(ROLES.map((role) => [role, owned(user, role, access)[0] ?? null])) as Record<CloudRole, NetcupPolicy | null>;
  const userIngress = user.some(hasIngress);
  const fallsOpenNow = firewall.ingressImplicitRule ? firewall.ingressImplicitRule === "ACCEPT_ALL" : !userIngress;
  const ours = addressesOf(options).map(parseCidr).filter((cidr): cidr is Cidr => cidr !== null);
  return {
    paths, api, target, firewall, policies, attached,
    now: nowOf(options),
    clean: (text: string) => auth.clean(api.clean(text)),
    guard: (policy: NetcupPolicy) => guardOf(policy, ours),
    serverName: target.serverName,
    others: attached.filter((policy) => policy.copied || !ownerOf(policy)),
    cloudflare: byRole("cloudflare"),
    open: byRole("open"),
    fallsOpenNow,
    /** Dropping by default with no inbound rule of the operator's: netcup's own policies did that, and keep doing it. */
    dropsAnyway: !fallsOpenNow && !userIngress,
  };
}
type Context = Awaited<ReturnType<typeof context>>;

/**
 * netcup drops by default once a policy on the interface has an inbound rule.
 * Whether netcup's copied policies count is not documented, so what they do
 * now is what they keep doing.
 */
function planContext(ctx: Context, ranges: string[]): PlanContext<Attached> {
  return {
    ...ctx,
    fallsOpenAfter: (after) => !ctx.dropsAnyway && !after.some((policy) => !policy.copied && hasIngress(policy)),
    standIn: (role, access) => ({
      id: 0, name: access === "open" ? CLOUD_ROLES[role].open : CLOUD_ROLES[role].name,
      description: descriptionFor(access, 0), rules: access === "open" ? netcupOpenRules(role) : netcupRules(role, ranges),
    }),
  };
}

async function rewrite(api: NetcupApi, userId: number, policy: NetcupPolicy, description: string, rules: NetcupRule[]): Promise<void> {
  await api.updatePolicy(userId, policy.id, policy.name, description, rules,
    (answered) => answered.description === description && netcupSignature(answered.rules) === netcupSignature(rules));
}

/**
 * Whether a policy only lets Cloudflare reach the role's ports: TCP accepts
 * on exactly those ports, each from the same sources, both address families,
 * every source inside this server's list, ICMP, and NTP replies from the pinned
 * servers. A newer list that adds a range fails this until this server's list catches up, and is then rewritten
 * to this server's list for a while; only Cloudflare stays let in throughout.
 */
function cloudflareOnly(role: CloudRole, rules: NetcupRule[] | undefined, ranges: string[]): boolean {
  const cloudflare = ranges.map(parseCidr).filter((cidr): cidr is Cidr => cidr !== null);
  const ports = CLOUD_ROLES[role].ports.map(String);
  const sources = new Map<string, Set<string>>();
  for (const rule of rules ?? []) {
    if (rule.direction !== "INGRESS" || rule.action !== "ACCEPT") return false;
    if (rule.protocol === "ICMP" || rule.protocol === "ICMPv6" || isNtpReply(rule)) continue;
    if (rule.protocol !== "TCP" || rule.sourcePorts || rule.destinations?.length || !rule.sources?.length) return false;
    if (!ports.includes(rule.destinationPorts ?? "")) return false;
    const set = sources.get(rule.destinationPorts!) ?? new Set<string>();
    for (const raw of rule.sources) {
      const cidr = parseCidr(raw);
      if (!cidr || !cloudflare.some((range) => contains(range, cidr))) return false;
      set.add(cidr.text);
    }
    sources.set(rule.destinationPorts!, set);
  }
  const each = ports.map((port) => [...(sources.get(port) ?? [])].sort());
  const first = each[0]!;
  return each.every((list) => list.join() === first.join()) && first.some((text) => !text.includes(":")) && first.some((text) => text.includes(":"));
}

/**
 * Rewrites an owned policy's rules to the list unless they match, or a server
 * with a newer list wrote them and they still let only Cloudflare in.
 */
async function bringCurrent(api: NetcupApi, userId: number, role: CloudRole, policy: NetcupPolicy, list: CloudflareRanges, now = Date.now()): Promise<"current" | "rewritten" | "newer"> {
  const rules = netcupRules(role, list.ranges);
  if (netcupSignature(policy.rules) === netcupSignature(rules)) return "current";
  if (!mayRewrite(policy, list.refreshedAt, now) && cloudflareOnly(role, policy.rules, list.ranges)) return "newer";
  await rewrite(api, userId, policy, descriptionFor("cloudflare", list.refreshedAt), rules);
  return "rewritten";
}

/** Puts an open policy's fixed rules back unless they match. */
async function bringOpenCurrent(api: NetcupApi, userId: number, role: CloudRole, policy: NetcupPolicy): Promise<boolean> {
  if (netcupSignature(policy.rules) === netcupSignature(netcupOpenRules(role))) return false;
  await rewrite(api, userId, policy, descriptionFor("open", 0), netcupOpenRules(role));
  return true;
}

/** The role's policy of that access, current, creating it if the account has none; returns its id. */
async function ensurePolicy(ctx: Context, role: CloudRole, access: Access, list: CloudflareRanges | null): Promise<number> {
  const { api, target } = ctx;
  const name = access === "open" ? CLOUD_ROLES[role].open : CLOUD_ROLES[role].name;
  const existing = owned(ctx.policies, role, access)[0];
  if (!existing) {
    if (ctx.policies.some((policy) => policy.name === name)) {
      failAction(`A policy named ${name} already exists in this netcup account without "${OWNER_MARK}" in its description; rename or delete it in SCP`);
    }
    const rules = access === "open" ? netcupOpenRules(role) : netcupRules(role, list!.ranges);
    return (await api.createPolicy(target.userId, name, descriptionFor(access, list?.refreshedAt ?? 0), rules)).id;
  }
  const full = await api.policy(target.userId, existing.id);
  if (access === "open") await bringOpenCurrent(api, target.userId, role, full);
  else await bringCurrent(api, target.userId, role, full, list!, ctx.now);
  return existing.id;
}

/**
 * Carries out a plan in one write: netcup replaces the interface's policies
 * at once, so nothing is open or closed in between, and a refused write
 * changes nothing. The addon's policies go after the operator's, so a drop of
 * theirs still comes first.
 */
async function apply(ctx: Context, role: CloudRole, enabled: boolean, plan: Plan<Attached>, list: CloudflareRanges | null): Promise<void> {
  const ids = new Map<string, number>();
  const wanted: [CloudRole, Access][] = [...[...plan.cloudflare].map((each) => [each, "cloudflare"] as [CloudRole, Access]), ...[...plan.open].map((each) => [each, "open"] as [CloudRole, Access])];
  for (const [each, access] of wanted) {
    const kept = access === "open" ? ctx.open[each] : ctx.cloudflare[each];
    const name = access === "open" ? CLOUD_ROLES[each].open : CLOUD_ROLES[each].name;
    try {
      ids.set(name, kept?.id ?? await ensurePolicy(ctx, each, access, list));
    } catch (error) {
      failAction(`${failureText(ctx.clean, error, `prepare ${name}`)}. Nothing on this server was changed.`);
    }
  }
  const user = ctx.firewall.userPolicies ?? [];
  const keep = new Set(ids.values());
  const operators = user.filter((policy) => !ownerOf(policy)).map((policy) => policy.id);
  const addons = [...user.filter((policy) => keep.has(policy.id)).map((policy) => policy.id),
    ...[...keep].filter((id) => !user.some((policy) => policy.id === id))];
  try {
    await ctx.api.setFirewall(ctx.target.serverId, ctx.target.mac, [...operators, ...addons], (ctx.firewall.copiedPolicies ?? []).map((policy) => policy.id));
  } catch (error) {
    failAction(writeFailure(ctx.clean, error, enabled ? `put ${CLOUD_ROLES[role].name} on this server` : `take ${CLOUD_ROLES[role].name} off this server`));
  }
}

/**
 * The two switches. Turning one on puts the role's Cloudflare policy on this
 * server after the safeguards pass and the operator confirmed the review; off
 * takes it off, likewise confirmed. Either also puts on or takes off the open
 * policies the plan calls for, in the same write. Each check runs here, never
 * only in the page.
 */
export async function setNetcupRole(
  role: CloudRole,
  enabled: boolean,
  confirm: unknown,
  options: NetcupOptions = {},
  typed?: unknown,
): Promise<{ review: CloudReview } | { notice: string }> {
  const paths = pathsOf(options);
  const deadline = nowOf(options) + SWITCH_BUDGET_MS;
  return withNetcupLock(paths, async () => {
    const ctx = await context(options, deadline);
    const title = CLOUD_ROLES[role].title;
    const on = ctx.cloudflare[role];
    const stale = ctx.open[role];
    if (enabled && on && !stale) return { notice: `${title} is already on.` };
    if (!enabled && !on) return { notice: `${title} is already off.` };
    let list: CloudflareRanges | null = null;
    if (enabled) {
      try { list = readCloudflareRanges(options); } catch (error) { failAction(errorMessage(error)); }
    } else {
      try { list = readCloudflareRanges(options); } catch { /* turning off needs no list */ }
    }
    const planning = planContext(ctx, list?.ranges ?? []);
    const plan = planFor(planning, role, enabled);
    const words = timesyncdActive(options) ? WORDS : { ...WORDS, closesMore: `${WORDS.closesMore}${NO_TIMESYNCD}` };
    const review = enabled
      ? await enableReview(role, planning, plan, list!.ranges, paths, options, words)
      : disableReview(role, planning, plan, list?.ranges ?? null, paths, options, words);
    if (confirm !== review.digest) return { review };
    if (review.typed && (typeof typed !== "string" || typed.trim() !== review.typed)) {
      failAction(`Type the server's name, ${review.typed}, to confirm`);
    }
    await apply(ctx, role, enabled, plan, list);
    if (enabled) writeSync(paths, { rangesHash: list!.hash });
    writeSync(paths, { seen: { web: plan.cloudflare.has("web"), panel: plan.cloudflare.has("panel") }, held: plan.cloudflare.size + plan.open.size > 0, seenAt: nowOf(options) });
    let timeSync = "";
    try { keepNetcupTimeSync(options); } catch (error) { timeSync = timeSyncFailed(error); }
    if (!enabled) return { notice: `${title} is off.${timeSync}` };
    const stillOpen = describeOpenings(openToOthers(role, ctx.others.map(ctx.guard), list!.ranges), WORDS.noun);
    return {
      notice: `${stillOpen.length
        ? `${CLOUD_ROLES[role].name} is on this server, but has no effect yet: ${stillOpen.join(" ")}`
        : `netcup now lets only Cloudflare reach ${portsOf(role)}.`}${timeSync}`,
    };
  }, 60);
}

/**
 * Keeps the addon's policies in this netcup account in line with the list,
 * writing only what differs. `ranges` is the list watcher's pass, which asks
 * netcup nothing unless the list changed since the last pass; `repair` reads
 * the policies and this server every time, so a change made in SCP is put
 * back and the switches as last seen stay current. Policies are never
 * deleted: netcup does not say whether deleting one still in use takes it off
 * the servers that have it.
 */
export async function syncNetcup(mode: "repair" | "ranges", options: NetcupOptions = {}): Promise<string | null> {
  const paths = pathsOf(options);
  if (!existsSync(paths.tokenFile)) return null;
  return withNetcupLock(paths, async () => {
    if (!readToken(paths)) return null;
    const list = readCloudflareRanges(options);
    const stored = readSync(paths);
    if (mode === "ranges" && stored.rangesHash === list.hash) return null;
    let clean = (text: string) => text;
    let rewritten = 0, reopened = 0, newer = 0, stale = 0;
    let missing = "";
    let failure = "";
    try {
      const { api, auth, access } = await signIn(paths, options);
      clean = (text) => auth.clean(api.clean(text));
      const userId = await userIdOf(paths, api, auth, access, stored.serverId);
      for (const listed of await api.policies(userId)) {
        const owner = ownerOf(listed);
        if (!owner) continue;
        const policy = await api.policy(userId, listed.id);
        if (owner.access === "open") {
          if (await bringOpenCurrent(api, userId, owner.role, policy)) reopened++;
          continue;
        }
        const result = await bringCurrent(api, userId, owner.role, policy, list, nowOf(options));
        if (result === "rewritten") rewritten++;
        if (result === "newer") newer++;
      }
      if (mode === "repair") {
        const read = await readFirewall(paths, options, api, true);
        if ("missing" in read) {
          missing = read.missing;
          writeSync(paths, { seen: { web: false, panel: false }, held: false, seenAt: nowOf(options) });
        } else {
          const { target, firewall } = read;
          const user = firewall.userPolicies ?? [];
          // An open policy beside its role's Cloudflare one only lets everyone else in.
          const extra = ROLES.flatMap((role) => owned(user, role).length ? owned(user, role, "open") : []);
          if (extra.length && firewall.active) {
            const keep = user.filter((policy) => !extra.includes(policy)).map((policy) => policy.id);
            await api.setFirewall(target.serverId, target.mac, keep, (firewall.copiedPolicies ?? []).map((policy) => policy.id));
            stale = extra.length;
          }
          writeSync(paths, { seen: seenOf(firewall), held: heldOf(firewall), seenAt: nowOf(options) });
        }
      }
    } catch (error) {
      failure = signInRefused(error) ? "netcup policies: netcup no longer accepts the saved sign-in; connect again" : `netcup policies: ${clean(errorMessage(error))}`;
    }
    // From the switches as last seen, so a repair that cannot reach netcup still puts the drop-in back.
    let timeSync: string | null = null;
    if (mode === "repair") {
      try { timeSync = keepNetcupTimeSync(options); } catch (error) { failure = [failure, `netcup time sync: ${errorMessage(error)}`].filter(Boolean).join("; "); }
    }
    if (failure) throw new Error(failure);
    if (stored.rangesHash !== list.hash) writeSync(paths, { rangesHash: list.hash });
    const count = (n: number, what: string) => `${n} ${what.replace("{s}", n === 1 ? "y" : "ies")}`;
    const lines = [
      rewritten ? `${count(rewritten, "netcup polic{s}")} set to Cloudflare's list` : "",
      reopened ? `${count(reopened, "netcup polic{s}")} open to anyone put back` : "",
      stale ? `${count(stale, "netcup polic{s}")} open to anyone taken off beside a Cloudflare one` : "",
      newer ? `${newer} netcup polic${newer === 1 ? "y follows" : "ies follow"} a newer Cloudflare list from another server` : "",
      missing,
      timeSync ?? "",
    ].filter(Boolean);
    return lines.join("; ") || null;
  });
}

/**
 * netcup's server firewall in front of this server, letting only Cloudflare
 * reach its web ports and panel. netcup filters by policies, shared across the
 * account's servers and assigned per interface: the addon owns up to four,
 * found by name and its mark in their description, the same as Hetzner's
 * firewalls. See "netcup firewall" in docs/decisions/firewall.md.
 */
import { networkInterfaces } from "node:os";
import { existsSync, rmSync } from "node:fs";
import { ActionFailure, failAction } from "../../lib/action";
import type { CommandResult } from "../../lib/command";
import { errorMessage } from "../../lib/errors";
import { withFileLock } from "../../lib/file-lock";
import { PANEL_CUSTOM_DOMAIN_FILE, PANEL_CUSTOM_DOMAIN_VHOST } from "../../lib/panel-custom-domain";
import { addonConfigFile, addonStateDir, CLOUDFLARE_IPS_PATH, DISTRO_NGINX_SITES_DIR, LOCK_DIR, PANEL_DB, ROOT_UID } from "../../lib/paths";
import type { ApiFetch } from "../../lib/provider-http";
import { readState, writeState } from "../../lib/root-state";
import {
  canonicalList, CLOUD_ROLES, contains, describeOpenings, disableReview, enableReview, firmwareVendor, mayRewriteAt, OPEN_DESCRIPTION, openToOthers,
  parseCidr, planFor, portsOf, readCloudflareRangesFrom, readSync as readSyncFile, roleView, ROLES, RULE_DESCRIPTION, sshMissing, sshPorts,
  writeSync as writeSyncFile,
  type Access, type CloudConnectedView, type CloudflareRanges, type CloudReview, type CloudRole, type CloudSetupState, type Guard,
  type HostPaths, type Plan, type PlanContext, type ProviderWords, type SeenState,
} from "./cloud-firewall";
import {
  NETCUP_HOST, NetcupApi, NetcupAuth, NetcupError, validRefreshToken,
  type NetcupFirewall, type NetcupPolicy, type NetcupRule,
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
  closesMore: "netcup tracks only TCP connections: once it drops by default, replies to this server's own UDP traffic, such as NTP and DNS to resolvers other than netcup's, are dropped unless a policy allows them.",
};

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
  /** This server's public IPv4 addresses. */
  addresses?: () => string[];
}

function pathsOf(options: NetcupOptions): NetcupPaths {
  return { ...DEFAULT_NETCUP_PATHS, ...options.paths };
}

const nowOf = (options: NetcupOptions) => (options.now ?? Date.now)();

function readCloudflareRanges(options: NetcupOptions): CloudflareRanges {
  return readCloudflareRangesFrom(pathsOf(options), "the netcup policies");
}

// --- Rules ------------------------------------------------------------------

/** The rules of one of the addon's policies: a pure function of the list, one rule per port and address family. */
export function netcupRules(role: CloudRole, ranges: string[]): NetcupRule[] {
  const families = [ranges.filter((range) => !range.includes(":")), ranges.filter((range) => range.includes(":"))];
  return CLOUD_ROLES[role].ports.flatMap((port) => families.map((sources) => ({
    description: RULE_DESCRIPTION, direction: "INGRESS" as const, protocol: "TCP" as const, action: "ACCEPT" as const,
    sources: [...sources], destinationPorts: String(port),
  })));
}

/** The rules of a role's policy open to anyone: fixed, so every server writes the same. */
export function netcupOpenRules(role: CloudRole): NetcupRule[] {
  return CLOUD_ROLES[role].ports.map((port) => ({
    description: OPEN_DESCRIPTION, direction: "INGRESS" as const, protocol: "TCP" as const, action: "ACCEPT" as const,
    sources: [], destinationPorts: String(port),
  }));
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

/** A policy by what it lets in, in netcup's order. A rule tied to source ports lets no client in. */
function guardOf(policy: NetcupPolicy): Guard {
  return {
    name: policy.name,
    rules: (policy.rules ?? []).filter((rule) => rule.direction === "INGRESS" && !rule.sourcePorts).map((rule) => ({
      protocol: rule.protocol.toLowerCase(),
      port: rule.destinationPorts || "any",
      sources: rule.sources?.length ? rule.sources : ["0.0.0.0/0", "::/0"],
      accept: rule.action === "ACCEPT",
    })),
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

const PRIVATE_V4 = ["10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16"].map((range) => parseCidr(range)!);

/** The public IPv4 addresses on this server's interfaces: netcup puts them there, with no NAT in between. */
export function publicAddresses(): string[] {
  const found = new Set<string>();
  for (const list of Object.values(networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.internal || entry.family !== "IPv4") continue;
      const cidr = parseCidr(entry.address);
      if (cidr && !PRIVATE_V4.some((range) => contains(range, cidr))) found.add(entry.address);
    }
  }
  return [...found].sort();
}

export function isNetcup(vendorFile: string): boolean {
  return firmwareVendor(vendorFile).toLowerCase().includes("netcup");
}

// --- Stored state -----------------------------------------------------------

interface NetcupSync extends SeenState {
  /** The SCP user id, which netcup's policy endpoints are under. */
  userId?: number;
  /** This server in the account, as found by its address. */
  serverId?: number;
  mac?: string;
  serverName?: string;
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

/** Whether netcup refuses the saved sign-in for good, so only signing in again helps. */
function signInRefused(error: unknown): boolean {
  return error instanceof NetcupError && (error.code === "invalid_grant" || error.code === "unauthorized" || error.status === 401);
}

/**
 * An access token from the saved refresh token. Keycloak may rotate the
 * refresh token on every use, so the new one is saved before the access
 * token is used, under a lock so no two processes spend the same one.
 */
async function signIn(paths: NetcupPaths, options: NetcupOptions): Promise<{ api: NetcupApi; auth: NetcupAuth; access: string }> {
  const auth = new NetcupAuth(options.fetch);
  const access = await withFileLock(paths.tokenLockFile, 30, "another netcup sign-in is being refreshed", async () => {
    const token = readToken(paths);
    if (!token) failAction("Connect netcup first");
    const tokens = await auth.refresh(token);
    if (validRefreshToken(tokens.refresh_token) && tokens.refresh_token !== token) {
      writeState(paths.tokenFile, { refreshToken: tokens.refresh_token }, paths.rootUid);
    }
    return tokens.access_token;
  });
  return { api: new NetcupApi(access, options.fetch, options.sleep), auth, access };
}

interface Target { userId: number; serverId: number; mac: string; serverName: string }

/** This server in the account: the server and interface netcup lists with one of its public addresses. */
async function findServer(api: NetcupApi, addresses: string[]): Promise<Omit<Target, "userId"> | null> {
  for (const address of addresses) {
    for (const server of await api.serversByIp(address)) {
      const found = (await api.interfaces(server.id)).find((entry) => entry.ipv4Addresses?.some((ip) => ip.ip === address));
      if (found) return { serverId: server.id, mac: found.mac.toLowerCase(), serverName: server.nickname || server.name };
    }
  }
  return null;
}

/** Where this server is in the account, kept from the last time it was found; null when no server there has its address. */
async function locate(paths: NetcupPaths, options: NetcupOptions, api: NetcupApi, auth: NetcupAuth, access: string, fresh = false): Promise<Target | null> {
  const stored = readSync(paths);
  const userId = stored.userId ?? await auth.userId(access);
  if (!fresh && stored.serverId && stored.mac && stored.serverName) {
    if (stored.userId !== userId) writeSync(paths, { userId });
    return { userId, serverId: stored.serverId, mac: stored.mac, serverName: stored.serverName };
  }
  const found = await findServer(api, (options.addresses ?? publicAddresses)());
  writeSync(paths, { userId, serverId: found?.serverId, mac: found?.mac, serverName: found?.serverName });
  return found && { userId, ...found };
}

const unmatched = (options: NetcupOptions) => {
  const addresses = (options.addresses ?? publicAddresses)();
  return `No server in this netcup account has this server's address${addresses.length ? ` (${addresses.join(", ")})` : ""}; connect the account that holds it`;
};

/** The interface's firewall, finding the server again once when netcup no longer knows the one kept. */
async function firewallOf(paths: NetcupPaths, options: NetcupOptions, api: NetcupApi, auth: NetcupAuth, access: string): Promise<{ target: Target; firewall: NetcupFirewall }> {
  let target = await locate(paths, options, api, auth, access);
  if (!target) failAction(unmatched(options));
  try {
    return { target, firewall: await api.firewall(target.serverId, target.mac) };
  } catch (error) {
    if (!(error instanceof NetcupError && error.status === 404)) throw error;
  }
  target = await locate(paths, options, api, auth, access, true);
  if (!target) failAction(unmatched(options));
  try {
    return { target, firewall: await api.firewall(target.serverId, target.mac) };
  } catch (error) {
    if (error instanceof NetcupError && error.status === 404) {
      failAction(`netcup's firewall is not set up on ${target.serverName} yet: open Firewall for it in SCP and click Configure`);
    }
    throw error;
  }
}

const OFF = "netcup's firewall is off for this server, so no policy has any effect. Turn it on under Firewall in SCP";

// --- What the page shows ----------------------------------------------------

export type NetcupView =
  | { state: "absent" }
  /** `address` is this server's public IPv4, for the operator to find the account that holds it. */
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

export async function netcupView(options: NetcupOptions = {}): Promise<NetcupView> {
  const paths = pathsOf(options);
  const now = nowOf(options);
  if (!readToken(paths)) {
    if (!isNetcup(paths.vendor)) return { state: "absent" };
    return { state: "disconnected", address: (options.addresses ?? publicAddresses)()[0] ?? null };
  }
  let clean = (text: string) => text;
  try {
    const { api, auth, access } = await signIn(paths, options);
    clean = (text) => auth.clean(api.clean(text));
    const { target, firewall } = await firewallOf(paths, options, api, auth, access);
    const attached = attachedOf(firewall);
    const others = attached.filter((policy) => policy.copied || !ownerOf(policy));
    let ranges: CloudflareRanges | null = null;
    let rangesProblem: string | null = null;
    try { ranges = readCloudflareRanges(options); } catch (error) { rangesProblem = errorMessage(error); }
    const user = firewall.userPolicies ?? [];
    const roles = {} as CloudConnectedView["roles"];
    for (const role of ROLES) {
      const on = owned(user, role)[0];
      const open = owned(user, role, "open")[0];
      const current = !on || !ranges || netcupSignature(on.rules) === netcupSignature(netcupRules(role, ranges.ranges));
      roles[role] = roleView(role, Boolean(on), CLOUD_ROLES[role].name, open?.name ?? null, current, others.map(guardOf), ranges, WORDS.noun);
    }
    await withNetcupLock(paths, async () => {
      if (readToken(paths) && (readSync(paths).seenAt ?? 0) < now) writeSync(paths, { seen: seenOf(firewall), seenAt: now });
    }, 0).catch(() => {});
    return {
      state: "connected", serverId: target.serverId, serverName: target.serverName, roles,
      others: others.map((policy) => policy.name),
      terminal: existsSync(paths.terminalConfig),
      sshClosed: user.some((policy) => ownerOf(policy)) ? sshMissing(sshPorts(options.run), others.map(guardOf)) : [],
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
    rmSync(paths.deviceFile, { force: true });
    if (error instanceof NetcupError && error.code === "access_denied") failAction("Access was denied in netcup; connect again to retry");
    if (error instanceof NetcupError && error.code === "expired_token") failAction("The code expired before access was granted; connect again");
    failAction(`netcup's sign-in failed: ${auth.clean(errorMessage(error))}`);
  }
  if ("pending" in reply) {
    const interval = reply.pending === "slow_down" ? Math.min(device.interval + 5, 60) : device.interval;
    if (interval !== device.interval) writeState(paths.deviceFile, { ...device, interval }, paths.rootUid);
    return { pending: true, interval };
  }
  rmSync(paths.deviceFile, { force: true });
  if (!validRefreshToken(reply.refresh_token)) failAction("netcup gave no refresh token; connect again and allow offline access");
  const refreshToken = reply.refresh_token;
  const api = new NetcupApi(reply.access_token, options.fetch, options.sleep);
  let userId: number;
  let found: Awaited<ReturnType<typeof findServer>>;
  try {
    userId = await auth.userId(reply.access_token);
    found = await findServer(api, (options.addresses ?? publicAddresses)());
  } catch (error) {
    await auth.revoke(refreshToken).catch(() => {});
    failAction(`Signed in, but netcup could not be read: ${auth.clean(api.clean(errorMessage(error)))}`);
  }
  return withNetcupLock(paths, async () => {
    const previous = readToken(paths);
    await withFileLock(paths.tokenLockFile, 30, "another netcup sign-in is being refreshed", async () => {
      writeState(paths.tokenFile, { refreshToken }, paths.rootUid);
    });
    rmSync(paths.syncFile, { force: true });
    writeSync(paths, { userId, serverId: found?.serverId, mac: found?.mac, serverName: found?.serverName });
    if (previous && previous !== refreshToken) await auth.revoke(previous).catch(() => {});
    return { notice: found ? `Connected to netcup; this server is ${found.serverName} there.` : `Connected to netcup. ${unmatched(options)}.` };
  });
}

export async function disconnectNetcup(options: NetcupOptions = {}): Promise<{ notice: string }> {
  const paths = pathsOf(options);
  return withNetcupLock(paths, async () => {
    rmSync(paths.deviceFile, { force: true });
    const token = readToken(paths);
    if (!token) return { notice: "No netcup sign-in is saved." };
    let unchecked = "";
    let mine: NetcupPolicy[] = [];
    let auth = new NetcupAuth(options.fetch);
    let clean = (text: string) => auth.clean(text);
    try {
      const session = await signIn(paths, options);
      auth = session.auth;
      clean = (text) => session.auth.clean(session.api.clean(text));
      const { firewall } = await firewallOf(paths, options, session.api, session.auth, session.access);
      mine = (firewall.userPolicies ?? []).filter((policy) => ownerOf(policy));
    } catch (error) {
      // A leaked or revoked sign-in must always be removable; the operator is told what could not be checked.
      const why = signInRefused(error) ? "it refuses the saved sign-in" : error instanceof ActionFailure ? error.message : clean(errorMessage(error));
      unchecked = ` netcup could not be asked which policies this server has (${why}); a clp-addons policy still there stays, and no longer follows Cloudflare's list.`;
    }
    const on = mine.filter((policy) => ownerOf(policy)!.access === "cloudflare");
    if (on.length) {
      failAction(`Turn both switches off first: ${on.map((policy) => policy.name).join(" and ")} would stay on this server and no longer follow Cloudflare's list`);
    }
    const open = mine.map((policy) => policy.name);
    const staying = open.length ? ` ${open.join(" and ")} stay${open.length === 1 ? "s" : ""} on this server, so those ports stay open to anyone; remove ${open.length === 1 ? "it" : "them"} in SCP if you no longer want that.` : "";
    const current = readToken(paths) ?? token;
    const revoked = await auth.revoke(current).then(() => true, () => false);
    rmSync(paths.tokenFile, { force: true });
    rmSync(paths.syncFile, { force: true });
    return { notice: `The netcup sign-in is removed${revoked ? " and revoked" : "; netcup could not be asked to revoke it, so it lapses once unused"}.${staying}${unchecked}` };
  });
}

// --- Changes ----------------------------------------------------------------

function failureText(clean: (text: string) => string, error: unknown, doing: string): string {
  if (error instanceof ActionFailure) return error.message;
  if (signInRefused(error)) return `netcup no longer accepts the saved sign-in; connect again to ${doing}`;
  return `Could not ${doing}: ${clean(errorMessage(error))}`;
}

type Attached = NetcupPolicy & { copied?: boolean };

/** Everything a switch decides from, read once. */
async function context(options: NetcupOptions) {
  const paths = pathsOf(options);
  if (!readToken(paths)) failAction("Connect netcup first");
  let session: Awaited<ReturnType<typeof signIn>>;
  let found: Awaited<ReturnType<typeof firewallOf>>;
  let policies: NetcupPolicy[];
  try {
    session = await signIn(paths, options);
    found = await firewallOf(paths, options, session.api, session.auth, session.access);
    policies = await session.api.policies(found.target.userId);
  } catch (error) {
    failAction(failureText((text) => text, error, "read this server's policies"));
  }
  const { api, auth } = session;
  const { target, firewall } = found;
  if (!firewall.active) failAction(`${OFF} first`);
  const attached: Attached[] = attachedOf(firewall);
  const user = firewall.userPolicies ?? [];
  const byRole = (access: Access) => Object.fromEntries(ROLES.map((role) => [role, owned(user, role, access)[0] ?? null])) as Record<CloudRole, NetcupPolicy | null>;
  const userIngress = user.some(hasIngress);
  const fallsOpenNow = firewall.ingressImplicitRule ? firewall.ingressImplicitRule === "ACCEPT_ALL" : !userIngress;
  return {
    paths, api, target, firewall, policies, attached,
    clean: (text: string) => auth.clean(api.clean(text)),
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
    ...ctx, guard: guardOf,
    fallsOpenAfter: (after) => !ctx.dropsAnyway && !after.some((policy) => !policy.copied && hasIngress(policy)),
    standIn: (role, access) => ({
      id: 0, name: access === "open" ? CLOUD_ROLES[role].open : CLOUD_ROLES[role].name,
      description: descriptionFor(access, 0), rules: access === "open" ? netcupOpenRules(role) : netcupRules(role, ranges),
    }),
  };
}

/** Rewrites an owned policy's rules to the list unless they match, or a server with a newer list wrote them. */
async function bringCurrent(api: NetcupApi, userId: number, role: CloudRole, policy: NetcupPolicy, list: CloudflareRanges, now = Date.now()): Promise<"current" | "rewritten" | "newer"> {
  const rules = netcupRules(role, list.ranges);
  if (netcupSignature(policy.rules) === netcupSignature(rules)) return "current";
  if (!mayRewrite(policy, list.refreshedAt, now)) return "newer";
  await api.updatePolicy(userId, policy.id, policy.name, descriptionFor("cloudflare", list.refreshedAt), rules);
  return "rewritten";
}

/** Puts an open policy's fixed rules back unless they match. */
async function bringOpenCurrent(api: NetcupApi, userId: number, role: CloudRole, policy: NetcupPolicy): Promise<boolean> {
  if (netcupSignature(policy.rules) === netcupSignature(netcupOpenRules(role))) return false;
  await api.updatePolicy(userId, policy.id, policy.name, descriptionFor("open", 0), netcupOpenRules(role));
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
  else await bringCurrent(api, target.userId, role, full, list!);
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
    const doing = enabled ? `put ${CLOUD_ROLES[role].name} on this server` : `take ${CLOUD_ROLES[role].name} off this server`;
    failAction(`${failureText(ctx.clean, error, doing)}. Nothing on this server was changed.`);
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
  return withNetcupLock(paths, async () => {
    const ctx = await context(options);
    const title = CLOUD_ROLES[role].title;
    const on = ctx.cloudflare[role];
    const stale = ctx.open[role];
    if (enabled && on && stale) {
      // Left from outside the addon; with the Cloudflare one on it only lets everyone else in.
      const user = (ctx.firewall.userPolicies ?? []).filter((policy) => policy.id !== stale.id).map((policy) => policy.id);
      try {
        await ctx.api.setFirewall(ctx.target.serverId, ctx.target.mac, user, (ctx.firewall.copiedPolicies ?? []).map((policy) => policy.id));
      } catch (error) {
        failAction(failureText(ctx.clean, error, `take ${stale.name} off`));
      }
      return { notice: `${title} is on; ${stale.name} was still on this server and is now off.` };
    }
    if (enabled && on) return { notice: `${title} is already on.` };
    if (!enabled && !on) return { notice: `${title} is already off.` };
    let list: CloudflareRanges | null = null;
    if (enabled) {
      try { list = readCloudflareRanges(options); } catch (error) { failAction(errorMessage(error)); }
    } else {
      try { list = readCloudflareRanges(options); } catch { /* turning off needs no list */ }
    }
    const planning = planContext(ctx, list?.ranges ?? []);
    const plan = planFor(planning, role, enabled);
    const review = enabled
      ? await enableReview(role, planning, plan, list!.ranges, paths, options, WORDS)
      : disableReview(role, planning, plan, list?.ranges ?? null, paths, options, WORDS);
    if (confirm !== review.digest) return { review };
    if (review.typed && (typeof typed !== "string" || typed.trim() !== review.typed)) {
      failAction(`Type the server's name, ${review.typed}, to confirm`);
    }
    await apply(ctx, role, enabled, plan, list);
    if (enabled) writeSync(paths, { rangesHash: list!.hash });
    writeSync(paths, { seen: { web: plan.cloudflare.has("web"), panel: plan.cloudflare.has("panel") }, seenAt: nowOf(options) });
    if (!enabled) return { notice: `${title} is off.` };
    const stillOpen = describeOpenings(openToOthers(role, ctx.others.map(guardOf), list!.ranges), WORDS.noun);
    return {
      notice: stillOpen.length
        ? `${CLOUD_ROLES[role].name} is on this server, but has no effect yet: ${stillOpen.join(" ")}`
        : `netcup now lets only Cloudflare reach ${portsOf(role)}.`,
    };
  });
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
    try {
      const { api, auth, access } = await signIn(paths, options);
      clean = (text) => auth.clean(api.clean(text));
      const userId = stored.userId ?? await auth.userId(access);
      if (stored.userId !== userId) writeSync(paths, { userId });
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
        const { target, firewall } = await firewallOf(paths, options, api, auth, access);
        const user = firewall.userPolicies ?? [];
        // An open policy beside its role's Cloudflare one only lets everyone else in.
        const extra = ROLES.flatMap((role) => owned(user, role).length ? owned(user, role, "open") : []);
        if (extra.length && firewall.active) {
          const keep = user.filter((policy) => !extra.includes(policy)).map((policy) => policy.id);
          await api.setFirewall(target.serverId, target.mac, keep, (firewall.copiedPolicies ?? []).map((policy) => policy.id));
          stale = extra.length;
        }
        writeSync(paths, { seen: seenOf(firewall), seenAt: nowOf(options) });
      }
    } catch (error) {
      if (signInRefused(error)) throw new Error("netcup policies: netcup no longer accepts the saved sign-in; connect again");
      throw new Error(`netcup policies: ${clean(errorMessage(error))}`);
    }
    if (stored.rangesHash !== list.hash) writeSync(paths, { rangesHash: list.hash });
    const count = (n: number, what: string) => `${n} ${what.replace("{s}", n === 1 ? "y" : "ies")}`;
    const lines = [
      rewritten ? `${count(rewritten, "netcup polic{s}")} set to Cloudflare's list` : "",
      reopened ? `${count(reopened, "netcup polic{s}")} open to anyone put back` : "",
      stale ? `${count(stale, "netcup polic{s}")} open to anyone taken off beside a Cloudflare one` : "",
      newer ? `${newer} netcup polic${newer === 1 ? "y follows" : "ies follow"} a newer Cloudflare list from another server` : "",
    ].filter(Boolean);
    return lines.join("; ") || null;
  });
}

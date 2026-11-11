/**
 * Hetzner Cloud Firewalls that let only Cloudflare reach this server's web
 * ports and panel. The addon owns up to four firewalls per Hetzner project,
 * found by label: per role, one whose rules are computed from CloudPanel's
 * Cloudflare list the same way on every server, and one open to anyone for
 * when the switch is off. Each server attaches them to itself alone. See
 * "Hetzner Cloud Firewall" in docs/decisions/firewall.md.
 */
import { createHash } from "node:crypto";
import { Resolver } from "node:dns/promises";
import { chmodSync, closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { ActionFailure, failAction } from "../../lib/action";
import { runCommand, type CommandResult } from "../../lib/command";
import { errorMessage } from "../../lib/errors";
import { withFileLock } from "../../lib/file-lock";
import { panelCustomDomain, PANEL_CUSTOM_DOMAIN_FILE, PANEL_CUSTOM_DOMAIN_VHOST } from "../../lib/panel-custom-domain";
import { withPanelDb } from "../../lib/panel-db";
import { addonConfigFile, addonStateDir, CLOUDFLARE_IPS_PATH, DISTRO_NGINX_SITES_DIR, LOCK_DIR, PANEL_DB, ROOT_UID } from "../../lib/paths";
import { trustedText } from "../../lib/trusted-file";
import type { ApiFetch } from "../../lib/provider-http";
import { readState, writeState } from "../../lib/root-state";
import { panelUserUid } from "../../lib/sso-auth";
import { HetznerApi, HetznerError, hetznerHostname, hetznerServerId, validToken, type HetznerFirewall, type HetznerRule, type HetznerServer } from "./hetzner-api";
import { DEFAULT_FIREWALL_PATHS, ipv4, ipv6, panelRulePorts } from "./protocols";

export type HetznerRole = "web" | "panel";
/** `name` lets only Cloudflare reach the ports; `open` lets anyone, for while the switch is off. */
export const HETZNER_ROLES: Record<HetznerRole, { name: string; open: string; ports: number[]; title: string }> = {
  web: { name: "clp-addons-cloudflare-web", open: "clp-addons-open-web", ports: [80, 443], title: "Sites through Cloudflare only" },
  panel: { name: "clp-addons-cloudflare-panel", open: "clp-addons-open-panel", ports: [8443], title: "Panel through Cloudflare only" },
};
const ROLES = Object.keys(HETZNER_ROLES) as HetznerRole[];
type Access = "cloudflare" | "open";
const OWNER_KEY = "managed-by";
const OWNER_VALUE = "clp-addons";
export const OWNER_SELECTOR = `${OWNER_KEY}=${OWNER_VALUE}`;
const ROLE_KEY = "clp-addons-role";
/** `open` on the firewalls open to anyone; the Cloudflare ones have none. */
const ACCESS_KEY = "clp-addons-access";
/** When the writer's Cloudflare list was last refreshed, so a server with an older list leaves a newer one alone. */
const RANGES_KEY = "clp-addons-ranges-at";
const RULE_DESCRIPTION = "Cloudflare, kept current by clp-addons";
const OPEN_DESCRIPTION = "Anyone, kept by clp-addons";
const ANYONE = ["0.0.0.0/0", "::/0"];
const MAX_RANGES_BYTES = 64 * 1024;

interface HetznerPaths {
  tokenFile: string;
  syncFile: string;
  lockFile: string;
  ranges: string;
  panelDb: string;
  nginxSitesDir: string;
  customDomain: string;
  customDomainVhost: string;
  /** CloudPanel's Firewall page protocols, for the ports a change would close. */
  protocolsFile: string;
  /** Present while the Terminal addon is enabled, which the page then offers as the way to a shell. */
  terminalConfig: string;
  /** The firmware's vendor, which is Hetzner on Hetzner Cloud. */
  vendor: string;
  rootUid: number;
  panelUid: number | null;
}

export const DEFAULT_HETZNER_PATHS: HetznerPaths = {
  tokenFile: `${addonStateDir("firewall")}/hetzner-token.json`,
  syncFile: `${addonStateDir("firewall")}/hetzner.json`,
  lockFile: `${LOCK_DIR}/firewall-hetzner.lock`,
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

export interface HetznerOptions {
  paths?: Partial<HetznerPaths>;
  fetch?: ApiFetch;
  sleep?: (ms: number) => Promise<void>;
  /** A hostname's A and AAAA addresses; none when it does not resolve. */
  resolve?: (host: string) => Promise<string[]>;
  run?: (command: string, args: string[]) => CommandResult;
  now?: () => number;
}

function pathsOf(options: HetznerOptions): HetznerPaths {
  return { ...DEFAULT_HETZNER_PATHS, ...options.paths };
}

// --- Address ranges ---------------------------------------------------------

interface Cidr { v6: boolean; bits: bigint; prefix: number; text: string; hostBits: boolean }

function maskBits(bits: bigint, width: number, prefix: number): bigint {
  const shift = BigInt(width - prefix);
  return (bits >> shift) << shift;
}

/** An address or a CIDR, always written as `network/prefix`. */
export function parseCidr(raw: string): Cidr | null {
  const [address = "", prefixText, extra] = raw.trim().split("/");
  if (extra !== undefined || (prefixText !== undefined && !/^\d{1,3}$/.test(prefixText))) return null;
  const v4 = ipv4(address);
  const v6 = v4 ? null : ipv6(address);
  if (!v4 && !v6) return null;
  const width = v4 ? 32 : 128;
  const prefix = prefixText === undefined ? width : Number(prefixText);
  if (prefix > width) return null;
  let bits = 0n;
  for (const group of v4 ?? v6!) bits = (bits << (v4 ? 8n : 16n)) | BigInt(group);
  const network = maskBits(bits, width, prefix);
  let text: string;
  if (v4) {
    text = [24n, 16n, 8n, 0n].map((shift) => String((network >> shift) & 255n)).join(".");
  } else {
    const groups = [112n, 96n, 80n, 64n, 48n, 32n, 16n, 0n].map((shift) => Number((network >> shift) & 0xffffn));
    let best = -1, length = 0;
    for (let i = 0; i < 8;) {
      if (groups[i] !== 0) { i++; continue; }
      let j = i;
      while (j < 8 && groups[j] === 0) j++;
      if (j - i > length) { best = i; length = j - i; }
      i = j;
    }
    const hex = groups.map((group) => group.toString(16));
    text = length < 2 ? hex.join(":") : `${hex.slice(0, best).join(":")}::${hex.slice(best + length).join(":")}`;
  }
  return { v6: !v4, bits: network, prefix, text: `${text}/${prefix}`, hostBits: network !== bits };
}

function contains(outer: Cidr, inner: Cidr): boolean {
  const width = outer.v6 ? 128 : 32;
  return outer.v6 === inner.v6 && outer.prefix <= inner.prefix && maskBits(inner.bits, width, outer.prefix) === outer.bits;
}

function sortRanges(ranges: Cidr[]): string[] {
  return [...ranges].sort((a, b) => Number(a.v6) - Number(b.v6) || (a.bits < b.bits ? -1 : a.bits > b.bits ? 1 : a.prefix - b.prefix))
    .map((range) => range.text);
}

/**
 * CloudPanel's `/etc/nginx/cloudflare/ips`: `allow <range>;` lines and a final
 * `deny all;`. Anything else in it is refused, since an empty or wrong list
 * here would shut out every visitor.
 */
export function parseCloudflareRanges(text: string): string[] {
  const ranges = new Map<string, Cidr>();
  for (const [index, line] of text.split("\n").entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || /^deny\s+all\s*;$/.test(trimmed)) continue;
    const raw = /^allow\s+(\S+?)\s*;$/.exec(trimmed)?.[1];
    const range = raw ? parseCidr(raw) : null;
    if (!raw || !range) throw new Error(`line ${index + 1} is not an allow line with an address range`);
    if (range.hostBits) throw new Error(`${raw} on line ${index + 1} is not a network address`);
    if (range.prefix < (range.v6 ? 16 : 8)) throw new Error(`${raw} on line ${index + 1} is wider than any Cloudflare range`);
    ranges.set(range.text, range);
  }
  const list = [...ranges.values()];
  if (!list.length) throw new Error("it lists no ranges");
  if (!list.some((range) => !range.v6)) throw new Error("it lists no IPv4 ranges");
  if (!list.some((range) => range.v6)) throw new Error("it lists no IPv6 ranges");
  return sortRanges(list);
}

interface CloudflareRanges { ranges: string[]; refreshedAt: number; hash: string }

/** The list, read only from a file root or the panel account owns and no one else can write. */
export function readCloudflareRanges(options: HetznerOptions = {}): CloudflareRanges {
  const paths = pathsOf(options);
  const owners = [paths.rootUid, paths.panelUid ?? panelUserUid() ?? paths.rootUid];
  let text: string;
  let refreshedAt: number;
  try {
    const fd = openSync(paths.ranges, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.size > MAX_RANGES_BYTES || !owners.includes(info.uid) || (info.mode & 0o022) !== 0) {
        throw new Error("are not in a trusted regular file");
      }
      text = readFileSync(fd, "utf8");
      refreshedAt = Math.floor(info.mtimeMs / 1000);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new Error(`Cloudflare's ranges in ${paths.ranges} ${code === "ENOENT" ? "are missing" : code ? "cannot be read" : errorMessage(error)}; the Hetzner firewalls were not changed`);
  }
  let ranges: string[];
  try { ranges = parseCloudflareRanges(text); }
  catch (error) { throw new Error(`Cloudflare's ranges in ${paths.ranges} are unusable: ${errorMessage(error)}; the Hetzner firewalls were not changed`); }
  return { ranges, refreshedAt, hash: createHash("sha256").update(ranges.join("\n")).digest("hex") };
}

// --- Rules ------------------------------------------------------------------

/** The rules of one of the addon's firewalls: a pure function of the list, so every server computes the same. */
export function desiredRules(role: HetznerRole, ranges: string[]): HetznerRule[] {
  return HETZNER_ROLES[role].ports.map((port) => ({
    direction: "in", protocol: "tcp", port: String(port), source_ips: [...ranges], description: RULE_DESCRIPTION,
  }));
}

/** The rules of a role's firewall open to anyone: fixed, so every server writes the same. */
export function openRules(role: HetznerRole): HetznerRule[] {
  return HETZNER_ROLES[role].ports.map((port) => ({
    direction: "in", protocol: "tcp", port: String(port), source_ips: [...ANYONE], description: OPEN_DESCRIPTION,
  }));
}

function canonicalList(list: string[] | undefined): string[] {
  return [...new Set((list ?? []).map((ip) => parseCidr(ip)?.text ?? ip))].sort();
}

/** Two rule sets with the same signature allow the same traffic, whatever order or spelling Hetzner returns. */
export function rulesSignature(rules: HetznerRule[]): string {
  return JSON.stringify(rules.map((rule) => JSON.stringify([
    rule.direction, rule.protocol, rule.port ?? "", canonicalList(rule.source_ips), canonicalList(rule.destination_ips), rule.description ?? "",
  ])).sort());
}

function portCovers(port: string | null | undefined, target: number): boolean {
  if (port === "any") return true;
  const match = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(port ?? "");
  if (!match) return false;
  return Number(match[1]) <= target && target <= Number(match[2] ?? match[1]);
}

/** The sources a firewall lets reach a TCP port. */
function openings(firewall: HetznerFirewall, port: number): Cidr[] {
  return firewall.rules
    .filter((rule) => rule.direction === "in" && rule.protocol === "tcp" && portCovers(rule.port, port))
    .flatMap((rule) => (rule.source_ips ?? []).map(parseCidr).filter((cidr): cidr is Cidr => cidr !== null));
}

/** Whether one inbound rule of these firewalls lets some source reach the whole range. */
function rangeAllowed(firewalls: HetznerFirewall[], protocol: "tcp" | "udp", from: number, to: number): boolean {
  return firewalls.some((firewall) => firewall.rules.some((rule) => rule.direction === "in" && rule.protocol === protocol
    && (rule.source_ips ?? []).length > 0 && portCovers(rule.port, from) && portCovers(rule.port, to)));
}

/** Whether every range can reach the port through one of the firewalls. */
function reachable(firewalls: HetznerFirewall[], port: number, ranges: string[]): boolean {
  const sources = firewalls.flatMap((firewall) => openings(firewall, port));
  return ranges.map(parseCidr).every((range) => range && sources.some((source) => contains(source, range)));
}

export interface Opening { port: number; firewall: string; sources: string[] }

/** What another firewall still lets reach the role's ports from outside Cloudflare, which leaves the addon's without effect. */
export function openToOthers(role: HetznerRole, others: HetznerFirewall[], ranges: string[]): Opening[] {
  const cloudflare = ranges.map(parseCidr).filter((cidr): cidr is Cidr => cidr !== null);
  const found: Opening[] = [];
  for (const port of HETZNER_ROLES[role].ports) {
    for (const firewall of others) {
      const sources = openings(firewall, port).filter((source) => !cloudflare.some((range) => contains(range, source)));
      if (sources.length) found.push({ port, firewall: firewall.name, sources: [...new Set(sources.map((source) => source.text))] });
    }
  }
  return found;
}

export function describeOpenings(openings: Opening[]): string[] {
  return openings.map((opening) => {
    const anyone = opening.sources.some((source) => source.endsWith("/0"));
    return `${opening.port} is still open to ${anyone ? "anyone" : opening.sources.join(", ")} through firewall ${opening.firewall}.`;
  });
}

function roleOf(firewall: HetznerFirewall): HetznerRole | null {
  if (firewall.labels?.[OWNER_KEY] !== OWNER_VALUE) return null;
  const role = firewall.labels[ROLE_KEY];
  return role === "web" || role === "panel" ? role : null;
}

function accessOf(firewall: HetznerFirewall): Access {
  return firewall.labels?.[ACCESS_KEY] === "open" ? "open" : "cloudflare";
}

function owned(firewalls: HetznerFirewall[], role: HetznerRole, access: Access = "cloudflare"): HetznerFirewall[] {
  return firewalls.filter((firewall) => roleOf(firewall) === role && accessOf(firewall) === access).sort((a, b) => a.id - b.id);
}

function openLabels(role: HetznerRole): Record<string, string> {
  return { [OWNER_KEY]: OWNER_VALUE, [ROLE_KEY]: role, [ACCESS_KEY]: "open" };
}

function labelsFor(role: HetznerRole, refreshedAt: number, current: Record<string, string> = {}): Record<string, string> {
  return { ...current, [OWNER_KEY]: OWNER_VALUE, [ROLE_KEY]: role, [RANGES_KEY]: String(refreshedAt) };
}

/**
 * Whether a server whose list was refreshed at `refreshedAt` may rewrite this
 * firewall's rules. A time more than a day ahead of this server's clock is
 * not believed, so a writer with a wrong clock cannot hold the rules for good.
 */
export function mayRewrite(firewall: HetznerFirewall, refreshedAt: number, now = Date.now()): boolean {
  const written = Number(firewall.labels?.[RANGES_KEY]);
  return !Number.isFinite(written) || written <= refreshedAt || written > now / 1000 + 86_400;
}

// --- This server ------------------------------------------------------------

/** The TCP ports sshd listens on: from `ss`, else from sshd's own configuration. */
export function sshPorts(run: (command: string, args: string[]) => CommandResult = (command, args) => runCommand(command, args, 10_000)): number[] {
  const ports = new Set<number>();
  const ss = run("ss", ["-Htlnp"]);
  if (ss.ok) {
    for (const line of ss.stdout.split("\n")) {
      if (!/\("sshd",pid=/.test(line)) continue;
      const port = Number(/:(\d{1,5})$/.exec(line.trim().split(/\s+/)[3] ?? "")?.[1]);
      if (port > 0 && port < 65536) ports.add(port);
    }
  }
  if (!ports.size) {
    const config = run("sshd", ["-T"]);
    if (config.ok) for (const match of config.stdout.matchAll(/^port (\d{1,5})$/gm)) ports.add(Number(match[1]));
  }
  return [...ports].sort((a, b) => a - b);
}

async function systemResolve(host: string): Promise<string[]> {
  const resolver = new Resolver({ timeout: 3000, tries: 2 });
  const [v4, v6] = await Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)]);
  return [...(v4.status === "fulfilled" ? v4.value : []), ...(v6.status === "fulfilled" ? v6.value : [])];
}

/** Why a hostname would not reach this server through Cloudflare, or null when it would. */
async function notThroughCloudflare(host: string, ranges: string[], resolve: (host: string) => Promise<string[]>): Promise<string | null> {
  const cloudflare = ranges.map(parseCidr).filter((cidr): cidr is Cidr => cidr !== null);
  const addresses = await resolve(host).catch(() => []);
  if (!addresses.length) return "does not resolve";
  const outside = addresses.filter((address) => {
    const cidr = parseCidr(address);
    return !cidr || !cloudflare.some((range) => contains(range, cidr));
  });
  // Sorted, so a resolver's rotating order does not change the review's digest.
  return outside.length ? `resolves to ${[...new Set(outside)].sort().join(", ")}` : null;
}

/** Every hostname the sites answer to: each site's domain and the other names its vhost's server_name lists. */
function siteHostnames(paths: HetznerPaths): string[] {
  if (!existsSync(paths.panelDb)) return [];
  const domains = withPanelDb(paths.panelDb, (db) => db.query("SELECT domain_name FROM site ORDER BY domain_name").all()
    .map((row) => String((row as { domain_name: unknown }).domain_name).toLowerCase()));
  const hosts = new Set(domains);
  for (const domain of domains) {
    const vhost = trustedText(`${paths.nginxSitesDir}/${domain}.conf`, paths.rootUid);
    for (const match of vhost?.matchAll(/^[ \t]*server_name[ \t]+([^;]+);/gm) ?? []) {
      for (const name of match[1]!.trim().split(/\s+/)) {
        const host = name.toLowerCase();
        if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) && !parseCidr(host)) hosts.add(host);
      }
    }
  }
  return [...hosts];
}

function customDomain(paths: HetznerPaths): string | undefined {
  return panelCustomDomain([paths.rootUid, paths.panelUid ?? panelUserUid() ?? paths.rootUid], paths.customDomain, paths.customDomainVhost);
}

// --- Stored state -----------------------------------------------------------

function readToken(paths: HetznerPaths): string | null {
  const stored = readState<{ token?: unknown } | null>(paths.tokenFile, paths.rootUid, () => null);
  return validToken(stored?.token) ? stored.token : null;
}

interface SyncState {
  rangesHash?: string;
  /** This server's id, kept while a token is saved, for when the metadata service does not answer. */
  serverId?: number;
  /** Until when the page treats this server as not on Hetzner Cloud without asking again. */
  absentUntil?: number;
  /** Which switches were on when Hetzner was last read, and when, for the Setup checklist. */
  seen?: Record<HetznerRole, boolean>;
  seenAt?: number;
}

function readSync(paths: HetznerPaths): SyncState {
  return readState<SyncState>(paths.syncFile, paths.rootUid, () => ({}));
}

function writeSync(paths: HetznerPaths, change: Partial<SyncState>): void {
  writeState(paths.syncFile, { ...readSync(paths), ...change }, paths.rootUid);
}

/** Keeps what Hetzner just said about this server's switches, and when. */
function remember(paths: HetznerPaths, seen: Record<HetznerRole, boolean>, now: number): void {
  writeSync(paths, { seen, seenAt: now });
}

/** How long the page believes the metadata service's silence: it is quick to answer on Hetzner Cloud. */
const ABSENT_FOR_MS = 10 * 60_000;

/**
 * This server's id: the metadata service's answer, asked twice before giving
 * up, else the id kept when a token was connected, so a moment's silence
 * from the service does not look like a server off Hetzner Cloud.
 */
async function serverIdOf(paths: HetznerPaths, options: HetznerOptions): Promise<number | null> {
  const probed = await hetznerServerId(options.fetch) ?? await hetznerServerId(options.fetch);
  if (probed !== null) return probed;
  return readToken(paths) ? readSync(paths).serverId ?? null : null;
}

async function withHetznerLock<T>(paths: HetznerPaths, body: () => Promise<T>): Promise<T> {
  mkdirSync(dirname(paths.lockFile), { recursive: true });
  chmodSync(dirname(paths.lockFile), 0o700);
  return withFileLock(paths.lockFile, 120, "another Hetzner firewall change is running", body);
}

function apiFor(token: string, options: HetznerOptions): HetznerApi {
  return new HetznerApi(token, options.fetch, options.sleep);
}

// --- What the page shows ----------------------------------------------------

export interface HetznerRoleView {
  /** The role's Cloudflare firewall is attached here. */
  on: boolean;
  /** The role's Cloudflare firewall: the one attached, else the project's. */
  firewall: string | null;
  /** The role's firewall open to anyone, while it is attached here. */
  open: string | null;
  /** The rules match the current list. */
  current: boolean;
  /** Set while on: what other firewalls still let reach these ports from outside Cloudflare. */
  stillOpen: string[];
}

export type HetznerView =
  | { state: "absent" }
  /** `serverName` is the hostname the metadata service reports, the server's name when it was created. */
  | { state: "disconnected"; serverId: number; serverName: string | null }
  /** `connected` when a token is saved, which the page then offers to replace or remove. */
  | { state: "error"; connected: boolean; error: string }
  | {
    state: "connected";
    serverId: number;
    serverName: string;
    roles: Record<HetznerRole, HetznerRoleView>;
    /** The other firewalls attached to this server. */
    others: string[];
    /** The Terminal addon is enabled, so the page offers it for a shell. */
    terminal: boolean;
    /** While one of the addon's firewalls is attached: the ports sshd listens on that no other firewall allows. */
    sshClosed: number[];
    rangesProblem: string | null;
  };

function sshMissing(ports: number[], others: HetznerFirewall[]): number[] {
  return ports.filter((port) => !others.some((firewall) => openings(firewall, port).length));
}

/** What the Setup checklist reads, without asking Hetzner: whether this is Hetzner Cloud, a token, and the switches as last seen. */
export function hetznerSetupState(options: HetznerOptions = {}): {
  cloud: boolean; token: boolean; seen: Partial<Record<HetznerRole, boolean>>; seenAt: number | null;
} {
  const paths = pathsOf(options);
  let vendor = "";
  try { vendor = readFileSync(paths.vendor, "utf8").trim(); } catch { /* not a VM that says */ }
  const token = readToken(paths) !== null;
  const stored = token ? readSync(paths) : {};
  return { cloud: vendor === "Hetzner" || token, token, seen: stored.seen ?? {}, seenAt: stored.seenAt ?? null };
}

export async function hetznerView(options: HetznerOptions = {}): Promise<HetznerView> {
  const paths = pathsOf(options);
  const now = (options.now ?? Date.now)();
  const token = readToken(paths);
  if (!token && (readSync(paths).absentUntil ?? 0) > now) return { state: "absent" };
  const serverId = token ? await serverIdOf(paths, options) : await hetznerServerId(options.fetch);
  if (serverId === null) {
    writeSync(paths, { absentUntil: now + ABSENT_FOR_MS });
    return { state: "absent" };
  }
  if (!token) return { state: "disconnected", serverId, serverName: await hetznerHostname(options.fetch) };
  const api = apiFor(token, options);
  try {
    const [server, firewalls] = await Promise.all([api.server(serverId), api.firewalls()]);
    const attachedIds = new Set(server.firewalls.map((firewall) => firewall.id));
    const attached = firewalls.filter((firewall) => attachedIds.has(firewall.id));
    const others = attached.filter((firewall) => !roleOf(firewall));
    let ranges: CloudflareRanges | null = null;
    let rangesProblem: string | null = null;
    try { ranges = readCloudflareRanges(options); } catch (error) { rangesProblem = errorMessage(error); }
    const roles = {} as Record<HetznerRole, HetznerRoleView>;
    for (const role of ROLES) {
      const mine = owned(firewalls, role);
      const on = mine.find((firewall) => attachedIds.has(firewall.id));
      roles[role] = {
        on: Boolean(on),
        firewall: (on ?? mine[0])?.name ?? null,
        open: owned(attached, role, "open")[0]?.name ?? null,
        current: !on || !ranges || rulesSignature(on.rules) === rulesSignature(desiredRules(role, ranges.ranges)),
        stillOpen: on && ranges ? describeOpenings(openToOthers(role, others, ranges.ranges)) : [],
      };
    }
    remember(paths, { web: roles.web.on, panel: roles.panel.on }, now);
    return {
      state: "connected", serverId, serverName: server.name, roles,
      others: others.map((firewall) => firewall.name),
      terminal: existsSync(paths.terminalConfig),
      sshClosed: attached.some((firewall) => roleOf(firewall)) ? sshMissing(sshPorts(options.run), others) : [],
      rangesProblem,
    };
  } catch (error) {
    return { state: "error", connected: true, error: `Hetzner could not be read: ${api.clean(errorMessage(error))}` };
  }
}

// --- Changes ----------------------------------------------------------------

async function requireServer(options: HetznerOptions): Promise<number> {
  const serverId = await serverIdOf(pathsOf(options), options);
  if (serverId === null) failAction("This server is not a Hetzner Cloud server; Hetzner's metadata service does not answer here");
  return serverId;
}

function hetznerFailure(api: HetznerApi, error: unknown, doing: string): never {
  if (error instanceof HetznerError && error.code === "unauthorized") failAction(`Hetzner no longer accepts the saved token; connect a new one to ${doing}`);
  if (error instanceof HetznerError && error.code === "forbidden") failAction(`The saved token is read-only; connect a Read & Write token to ${doing}`);
  failAction(`Could not ${doing}: ${api.clean(errorMessage(error))}`);
}

export async function connectHetzner(body: Record<string, unknown>, options: HetznerOptions = {}): Promise<{ notice: string }> {
  const paths = pathsOf(options);
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!validToken(token)) failAction("Paste the API token Hetzner showed you: letters and digits only");
  const serverId = await requireServer(options);
  const api = apiFor(token, options);
  let name: string;
  try {
    name = (await api.server(serverId)).name;
  } catch (error) {
    if (error instanceof HetznerError && error.code === "unauthorized") failAction("Hetzner did not accept this token");
    if (error instanceof HetznerError && error.code === "not_found") {
      failAction(`This token's project does not have this server (id ${serverId}); create the token in the project the server is in`);
    }
    failAction(`Could not check the token: ${api.clean(errorMessage(error))}`);
  }
  return withHetznerLock(paths, async () => {
    writeState(paths.tokenFile, { token }, paths.rootUid);
    writeSync(paths, { serverId, absentUntil: undefined });
    return { notice: `Connected to the Hetzner project of ${name}.` };
  });
}

export async function disconnectHetzner(options: HetznerOptions = {}): Promise<{ notice: string }> {
  const paths = pathsOf(options);
  return withHetznerLock(paths, async () => {
    const token = readToken(paths);
    if (!token) return { notice: "No Hetzner token is saved." };
    const serverId = await serverIdOf(paths, options);
    let unchecked = "";
    let staying = "";
    if (serverId !== null) {
      const api = apiFor(token, options);
      try {
        const [server, firewalls] = await Promise.all([api.server(serverId), api.firewalls(OWNER_SELECTOR)]);
        const attached = new Set(server.firewalls.map((firewall) => firewall.id));
        const mine = firewalls.filter((firewall) => roleOf(firewall) && attached.has(firewall.id));
        const on = mine.filter((firewall) => accessOf(firewall) === "cloudflare");
        if (on.length) {
          failAction(`Turn both switches off first: ${on.map((firewall) => firewall.name).join(" and ")} would stay attached to this server and no longer follow Cloudflare's list`);
        }
        // Their rules never change, so they need no token; they keep what the switches promised open.
        const open = mine.map((firewall) => firewall.name);
        if (open.length) staying = ` ${open.join(" and ")} stay${open.length === 1 ? "s" : ""} attached, so those ports stay open to anyone; detach ${open.length === 1 ? "it" : "them"} in Hetzner Console if you no longer want that.`;
      } catch (error) {
        if (error instanceof ActionFailure) throw error;
        // A leaked or revoked token must always be removable; the operator is told what could not be checked.
        const refused = error instanceof HetznerError && (error.code === "unauthorized" || error.code === "forbidden" || error.code === "not_found");
        const why = refused ? "it refuses this token" : api.clean(errorMessage(error));
        unchecked = ` Hetzner could not be asked what is attached to this server (${why}); a clp-addons firewall still attached there stays, and no longer follows Cloudflare's list.`;
      }
    }
    rmSync(paths.tokenFile, { force: true });
    rmSync(paths.syncFile, { force: true });
    return { notice: `The Hetzner token is removed. It stays valid in Hetzner until you delete it there.${staying}${unchecked}` };
  });
}

export interface HetznerReview {
  title: string;
  /** What changes, in a sentence or two. */
  text: string;
  /** Introduces `details`. */
  listLabel: string;
  /** The hostnames that stop answering. */
  details: string[];
  /** What leaves the change without effect. */
  warnings: string[];
  /** What anyone could reach before and nothing lets through afterwards. */
  closes: string[];
  /** How to reach the panel or a shell if that goes wrong. */
  wayBack: string;
  /** What the operator types to go ahead, when ports close; empty when nothing does. */
  typed: string;
  confirmLabel: string;
  danger: boolean;
  /** What the page sends back to go ahead; it changes when what the review says changes. */
  digest: string;
}

function reviewOf(role: HetznerRole, enabled: boolean, fields: Omit<HetznerReview, "digest">): HetznerReview {
  const digest = createHash("sha256").update(JSON.stringify({ role, enabled, ...fields })).digest("hex").slice(0, 32);
  return { ...fields, digest };
}

/** Everything a switch decides from, read once. */
async function context(options: HetznerOptions) {
  const paths = pathsOf(options);
  const serverId = await requireServer(options);
  const token = readToken(paths);
  if (!token) failAction("Connect a Hetzner token first");
  const api = apiFor(token, options);
  let server: HetznerServer;
  let firewalls: HetznerFirewall[];
  try {
    [server, firewalls] = await Promise.all([api.server(serverId), api.firewalls()]);
  } catch (error) {
    hetznerFailure(api, error, "read this server's firewalls");
  }
  const attachedIds = new Set(server.firewalls.map((firewall) => firewall.id));
  const attached = firewalls.filter((firewall) => attachedIds.has(firewall.id));
  const byRole = (access: Access) => Object.fromEntries(ROLES.map((role) => [role, owned(attached, role, access)[0] ?? null])) as Record<HetznerRole, HetznerFirewall | null>;
  return {
    paths, serverId, serverName: server.name, api, firewalls, attached,
    others: attached.filter((firewall) => !roleOf(firewall)),
    cloudflare: byRole("cloudflare"),
    open: byRole("open"),
  };
}
type Context = Awaited<ReturnType<typeof context>>;

/** A firewall of the addon's as it will be, for checking a change before the firewall exists. */
function standIn(role: HetznerRole, access: Access, ranges: string[]): HetznerFirewall {
  return access === "open"
    ? { id: 0, name: HETZNER_ROLES[role].open, labels: openLabels(role), rules: openRules(role), applied_to: [] }
    : { id: 0, name: HETZNER_ROLES[role].name, labels: labelsFor(role, 0), rules: desiredRules(role, ranges), applied_to: [] };
}

interface Plan {
  /** The roles whose Cloudflare firewall is on this server afterwards. */
  cloudflare: Set<HetznerRole>;
  /** The roles whose open firewall is on this server afterwards. */
  open: Set<HetznerRole>;
  /** Every firewall on this server afterwards. */
  after: HetznerFirewall[];
}

/**
 * The addon's firewalls on this server once `role` is switched. A role whose
 * switch is off gets its open firewall where no other firewall allows its
 * ports and they would otherwise close: when nothing was attached, while its
 * Cloudflare firewall comes off, or while the open one is already there. A
 * port another firewall closed on purpose stays closed. With no switch on and
 * no other firewall, nothing of the addon's stays, and Hetzner lets anyone
 * reach every port.
 */
function planFor(ctx: Context, role: HetznerRole, enabled: boolean, ranges: string[]): Plan {
  const cloudflare = new Set(ROLES.filter((each) => each === role ? enabled : ctx.cloudflare[each] !== null));
  const open = new Set<HetznerRole>();
  if (cloudflare.size || ctx.others.length) {
    for (const each of ROLES) {
      if (cloudflare.has(each)) continue;
      const ports = HETZNER_ROLES[each].ports;
      const needed = ports.some((port) => !ctx.others.some((firewall) => openings(firewall, port).length));
      const reachable = !ctx.attached.length || ports.some((port) => ctx.attached.some((firewall) => openings(firewall, port).length));
      if (needed && (ctx.open[each] || reachable)) open.add(each);
    }
  }
  const after = [
    ...ctx.others,
    ...[...cloudflare].map((each) => ctx.cloudflare[each] ?? standIn(each, "cloudflare", ranges)),
    ...[...open].map((each) => ctx.open[each] ?? standIn(each, "open", ranges)),
  ];
  return { cloudflare, open, after };
}

interface Watched { protocol: "tcp" | "udp"; from: number; to: number; ssh: boolean }

/** The ports sshd listens on and those CloudPanel's Firewall page opens. */
function watchedPorts(paths: HetznerPaths, options: HetznerOptions): Watched[] {
  const list: Watched[] = sshPorts(options.run).map((port) => ({ protocol: "tcp", from: port, to: port, ssh: true }));
  const rules = panelRulePorts({ paths: { stateFile: paths.protocolsFile, panelDb: paths.panelDb, rootUid: paths.rootUid } });
  for (const rule of rules) {
    const [from = 0, to = from] = rule.portRange.split("-").map(Number);
    for (const protocol of rule.protocols) {
      if (!list.some((item) => item.protocol === protocol && item.from <= from && to <= item.to)) list.push({ protocol, from, to, ssh: false });
    }
  }
  return list;
}

/** What anyone could reach before the change and no firewall lets through after it, in words. */
function closingLines(ctx: Context, plan: Plan, watched: Watched[]): { lines: string[]; ssh: boolean } {
  const allowed = (firewalls: HetznerFirewall[], item: Watched) => !firewalls.length || rangeAllowed(firewalls, item.protocol, item.from, item.to);
  const closing = watched.filter((item) => allowed(ctx.attached, item) && !allowed(plan.after, item));
  const ports = (items: Watched[]) => {
    const names = items.map((item) => item.from === item.to ? String(item.from) : `${item.from}-${item.to}`);
    return names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  };
  const ssh = closing.filter((item) => item.ssh);
  const lines = ssh.length ? [`SSH on port${ssh.length === 1 ? "" : "s"} ${ports(ssh)}: site users can no longer connect over SFTP`] : [];
  for (const protocol of ["tcp", "udp"] as const) {
    const rest = closing.filter((item) => !item.ssh && item.protocol === protocol);
    if (rest.length) lines.push(`${protocol.toUpperCase()} ${ports(rest)}, opened on CloudPanel's Firewall page`);
  }
  return { lines, ssh: ssh.length > 0 };
}

const portsOf = (role: HetznerRole) => {
  const ports = HETZNER_ROLES[role].ports;
  return `port${ports.length === 1 ? "" : "s"} ${ports.join(" and ")}`;
};

/** The open firewalls a change attaches, in words. */
function opening(ctx: Context, plan: Plan, except?: HetznerRole): string {
  return [...plan.open].filter((role) => role !== except && !ctx.open[role])
    .map((role) => ` ${portsOf(role)[0]!.toUpperCase()}${portsOf(role).slice(1)} stay${HETZNER_ROLES[role].ports.length === 1 ? "s" : ""} open to anyone through ${HETZNER_ROLES[role].open}.`).join("");
}

/** When ports close, what the operator must type, and the way back to a shell. */
function closingFields(ctx: Context, plan: Plan, options: HetznerOptions) {
  const closes = closingLines(ctx, plan, watchedPorts(ctx.paths, options));
  const shell = !closes.ssh ? "" : existsSync(ctx.paths.terminalConfig)
    ? "Terminal still gives a root shell from this panel, and Hetzner Console's web console always does."
    : "Hetzner Console's web console still gives a root shell.";
  return { closes: closes.lines, shell, ssh: closes.ssh, typed: closes.lines.length ? ctx.serverName : "" };
}

async function enableReview(role: HetznerRole, ctx: Context, plan: Plan, ranges: string[], options: HetznerOptions): Promise<HetznerReview> {
  const resolve = options.resolve ?? systemResolve;
  const domain = customDomain(ctx.paths);
  const stillOpen = describeOpenings(openToOthers(role, ctx.others, ranges));
  const warnings = stillOpen.length ? [`No effect yet: ${stillOpen.join(" ")}`] : [];
  const closing = closingFields(ctx, plan, options);
  const lead = closing.closes.length ? ["No firewall is attached to this server yet, so Hetzner also closes every port the addon's firewalls do not open:"] : [];
  if (role === "panel") {
    if (!domain) {
      failAction("Refused: CloudPanel has no custom domain. Add one under Admin → Settings in CloudPanel, proxied through Cloudflare (the orange cloud), so the panel still answers once port 8443 is closed to everyone else.");
    }
    const problem = await notThroughCloudflare(domain, ranges, resolve);
    if (problem) {
      failAction(`Refused: CloudPanel's custom domain ${domain} ${problem}, which is not Cloudflare. Proxy it through Cloudflare (the orange cloud) first, or the panel would answer nowhere.`);
    }
    // CloudPanel serves its custom domain from the sites' Nginx on 443, so Cloudflare must reach 443.
    if (!reachable(plan.after, 443, ranges)) {
      failAction(`Refused: ${domain} is served on port 443, and no firewall on this server lets Cloudflare reach 443. Turn on Sites through Cloudflare only first, or allow 443 in another firewall.`);
    }
    return reviewOf(role, true, {
      title: "Let only Cloudflare reach CloudPanel?",
      text: `CloudPanel will answer only at https://${domain}; https://<this server's IP>:8443 stops answering.${opening(ctx, plan, role)}`,
      listLabel: "", details: [], warnings: [...lead, ...warnings], closes: closing.closes,
      wayBack: closing.ssh
        ? `If ${domain} stops working, Hetzner Console's web console still gives a root shell.`
        : `If ${domain} stops working, reach the panel through an SSH tunnel to 127.0.0.1:8443.`,
      typed: closing.typed, confirmLabel: "Turn on", danger: true,
    });
  }
  const hosts = [...new Set([...siteHostnames(ctx.paths), ...(domain ? [domain] : [])])];
  // A name that does not resolve answers no one now, so only names that reach this server elsewhere are listed.
  const problems = await Promise.all(hosts.map(async (host) => {
    const problem = await notThroughCloudflare(host, ranges, resolve);
    return problem && problem !== "does not resolve" ? `${host}${host === domain ? " (CloudPanel)" : ""} ${problem}` : null;
  }));
  const failing = problems.filter((problem): problem is string => problem !== null).sort();
  return reviewOf(role, true, {
    title: "Let only Cloudflare reach the sites?",
    text: `Hetzner will drop every connection to ports 80 and 443 that does not come from Cloudflare.${failing.length ? "" : " Every site resolves to Cloudflare."}${opening(ctx, plan, role)}`,
    listLabel: failing.length === 1 ? "This hostname does not resolve to Cloudflare and stops answering"
      : failing.length ? `These ${failing.length} hostnames do not resolve to Cloudflare and stop answering` : "",
    details: failing, warnings: [...lead, ...warnings], closes: closing.closes, wayBack: closing.shell,
    typed: closing.typed, confirmLabel: "Turn on", danger: true,
  });
}

function disableReview(role: HetznerRole, ctx: Context, plan: Plan, ranges: string[] | null, options: HetznerOptions): HetznerReview {
  const on = ctx.cloudflare[role]!;
  // The panel switch needs Cloudflare to reach 443 for the custom domain; this one may be what lets it.
  if (role === "web" && plan.cloudflare.has("panel")) {
    const cut = ranges ? !reachable(plan.after, 443, ranges) : !plan.after.some((firewall) => openings(firewall, 443).length);
    if (cut) {
      failAction("Refused: with Panel through Cloudflare only on, CloudPanel's custom domain needs Cloudflare to reach 443, and no other firewall on this server allows it. Turn off Panel through Cloudflare only first, or allow 443 in another firewall; otherwise only an SSH tunnel to 127.0.0.1:8443 reaches the panel.");
    }
  }
  const ports = portsOf(role);
  const removed = ROLES.filter((each) => ctx.open[each] && !plan.open.has(each)).map((each) => HETZNER_ROLES[each].open);
  const alsoOff = removed.length ? ` ${removed.join(" and ")} come${removed.length === 1 ? "s" : ""} off too.` : "";
  const text = plan.open.has(role)
    ? `Anyone can reach ${ports} again: ${HETZNER_ROLES[role].open} takes the place of ${on.name} on this server.`
    : !plan.after.length
      ? `${on.name} comes off, and no firewall stays on this server, so Hetzner lets anyone reach every port again.${alsoOff}`
      : `${on.name} comes off; ${ports} are then open as ${ctx.others.map((firewall) => firewall.name).join(", ")} allow${ctx.others.length === 1 ? "s" : ""}.${alsoOff}`;
  const closing = closingFields(ctx, plan, options);
  return reviewOf(role, false, {
    title: `Turn off ${HETZNER_ROLES[role].title}?`,
    text: `${text}${opening(ctx, plan, role)}`,
    listLabel: "", details: [], warnings: closing.closes.length ? ["Nothing on this server lets anyone reach these any more:"] : [],
    closes: closing.closes, wayBack: closing.shell, typed: closing.typed,
    confirmLabel: "Turn off", danger: closing.closes.length > 0,
  });
}

/** Rewrites an owned firewall's rules to the list unless they match, or a server with a newer list wrote them. */
async function bringCurrent(api: HetznerApi, role: HetznerRole, firewall: HetznerFirewall, list: CloudflareRanges, now = Date.now()): Promise<"current" | "rewritten" | "newer"> {
  const rules = desiredRules(role, list.ranges);
  if (rulesSignature(firewall.rules) === rulesSignature(rules)) return "current";
  if (!mayRewrite(firewall, list.refreshedAt, now)) return "newer";
  await api.setRules(firewall.id, rules);
  await api.setLabels(firewall.id, labelsFor(role, list.refreshedAt, firewall.labels));
  return "rewritten";
}

/** Puts an open firewall's fixed rules back unless they match. */
async function bringOpenCurrent(api: HetznerApi, role: HetznerRole, firewall: HetznerFirewall): Promise<boolean> {
  if (rulesSignature(firewall.rules) === rulesSignature(openRules(role))) return false;
  await api.setRules(firewall.id, openRules(role));
  return true;
}

async function attach(role: HetznerRole, access: Access, ctx: Context, list: CloudflareRanges | null): Promise<void> {
  const { api, serverId } = ctx;
  const name = access === "open" ? HETZNER_ROLES[role].open : HETZNER_ROLES[role].name;
  const create = async () => {
    try {
      if (access === "open") await api.create(name, openLabels(role), openRules(role), serverId);
      else await api.create(name, labelsFor(role, list!.refreshedAt), desiredRules(role, list!.ranges), serverId);
      return true;
    } catch (error) {
      if (error instanceof HetznerError && error.code === "uniqueness_error") return false;
      throw error;
    }
  };
  let existing = owned(ctx.firewalls, role, access)[0];
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!existing) {
      if (await create()) return;
      // Another server created it a moment ago, or a firewall of that name is not the addon's.
      existing = owned(await api.firewalls(OWNER_SELECTOR), role, access)[0];
      if (!existing) {
        failAction(`A firewall named ${name} already exists in this Hetzner project without the label ${OWNER_SELECTOR}; rename or delete it in Hetzner's console`);
      }
    }
    if (access === "open") await bringOpenCurrent(api, role, existing);
    else await bringCurrent(api, role, existing, list!);
    try {
      await api.apply(existing.id, serverId);
      return;
    } catch (error) {
      if (error instanceof HetznerError && error.code === "firewall_already_applied") return;
      // Deleted by another server's repair between the read and now: create it again.
      if (error instanceof HetznerError && error.code === "not_found") { existing = undefined; continue; }
      throw error;
    }
  }
  failAction(`${name} was deleted by another server each time it was attached; try again`);
}

async function detach(ctx: Context, on: HetznerFirewall): Promise<void> {
  const { api, serverId } = ctx;
  try {
    await api.remove(on.id, serverId);
  } catch (error) {
    if (error instanceof HetznerError && error.code === "firewall_managed_by_label_selector") {
      failAction(`${on.name} is applied to this server by a label selector, which the addon never uses; remove that in Hetzner's console`);
    }
    if (!(error instanceof HetznerError && error.code === "firewall_already_removed")) throw error;
  }
  await deleteIfUnused(api, on.id);
}

async function deleteIfUnused(api: HetznerApi, id: number): Promise<boolean> {
  try {
    const firewall = await api.firewall(id);
    if (firewall.applied_to.length || !roleOf(firewall)) return false;
    await api.delete(id);
    return true;
  } catch (error) {
    // Attached by another server in between, or already gone.
    if (error instanceof HetznerError && (error.code === "resource_in_use" || error.code === "not_found")) return false;
    throw error;
  }
}

/**
 * The two switches. Turning one on attaches the role's Cloudflare firewall to
 * this server after the safeguards pass and the operator confirmed the
 * review; off takes it off, likewise confirmed. Either also attaches or takes
 * off the open firewalls the plan calls for: those go on first, so a port the
 * plan keeps open is not closed in between. Each check runs here, never only
 * in the page.
 */
export async function setHetznerRole(
  role: HetznerRole,
  enabled: boolean,
  confirm: unknown,
  options: HetznerOptions = {},
): Promise<{ review: HetznerReview } | { notice: string }> {
  const paths = pathsOf(options);
  return withHetznerLock(paths, async () => {
    const ctx = await context(options);
    const title = HETZNER_ROLES[role].title;
    const on = ctx.cloudflare[role];
    if (enabled && on) return { notice: `${title} is already on.` };
    if (!enabled && !on) return { notice: `${title} is already off.` };
    let list: CloudflareRanges | null = null;
    if (enabled) {
      try { list = readCloudflareRanges(options); } catch (error) { failAction(errorMessage(error)); }
    } else {
      try { list = readCloudflareRanges(options); } catch { /* turning off needs no list */ }
    }
    const plan = planFor(ctx, role, enabled, list?.ranges ?? []);
    const review = enabled ? await enableReview(role, ctx, plan, list!.ranges, options) : disableReview(role, ctx, plan, list?.ranges ?? null, options);
    if (confirm !== review.digest) return { review };
    try {
      for (const each of plan.open) if (!ctx.open[each]) await attach(each, "open", ctx, list);
      if (enabled) {
        await attach(role, "cloudflare", ctx, list);
        writeSync(paths, { rangesHash: list!.hash });
      } else {
        await detach(ctx, on!);
      }
      for (const each of ROLES) if (ctx.open[each] && !plan.open.has(each)) await detach(ctx, ctx.open[each]!);
    } catch (error) {
      if (error instanceof ActionFailure) throw error;
      hetznerFailure(ctx.api, error, enabled ? `attach ${HETZNER_ROLES[role].name}` : `detach ${on!.name}`);
    }
    remember(paths, { web: plan.cloudflare.has("web"), panel: plan.cloudflare.has("panel") }, (options.now ?? Date.now)());
    if (!enabled) return { notice: `${title} is off.` };
    const stillOpen = describeOpenings(openToOthers(role, ctx.others, list!.ranges));
    return {
      notice: stillOpen.length
        ? `${HETZNER_ROLES[role].name} is attached, but has no effect yet: ${stillOpen.join(" ")}`
        : `Hetzner now lets only Cloudflare reach ${portsOf(role)}.`,
    };
  });
}

/**
 * Keeps the addon's firewalls in this Hetzner project in line with the list,
 * writing only what differs. `ranges` is the list watcher's pass, which asks
 * Hetzner nothing unless the list changed since the last pass; `repair` reads
 * the firewalls and this server every time, so a change made in Hetzner's
 * console is put back and the switches as last seen stay current.
 */
export async function syncHetzner(mode: "repair" | "ranges", options: HetznerOptions = {}): Promise<string | null> {
  const paths = pathsOf(options);
  if (!existsSync(paths.tokenFile)) return null;
  return withHetznerLock(paths, async () => {
    const token = readToken(paths);
    if (!token) return null;
    const list = readCloudflareRanges(options);
    const stored = readSync(paths);
    if (mode === "ranges" && stored.rangesHash === list.hash) return null;
    const api = apiFor(token, options);
    let rewritten = 0, reopened = 0, newer = 0, deleted = 0;
    try {
      const firewalls = await api.firewalls(OWNER_SELECTOR);
      for (const firewall of firewalls) {
        const role = roleOf(firewall);
        if (!role) continue;
        if (!firewall.applied_to.length) {
          if (await deleteIfUnused(api, firewall.id)) { deleted++; continue; }
        }
        if (accessOf(firewall) === "open") {
          if (await bringOpenCurrent(api, role, firewall)) reopened++;
          continue;
        }
        const result = await bringCurrent(api, role, firewall, list, (options.now ?? Date.now)());
        if (result === "rewritten") rewritten++;
        if (result === "newer") newer++;
      }
      const serverId = mode === "repair" ? await serverIdOf(paths, options) : null;
      if (serverId !== null) {
        const attached = new Set((await api.server(serverId)).firewalls.map((firewall) => firewall.id));
        const on = (role: HetznerRole) => owned(firewalls, role).some((firewall) => attached.has(firewall.id));
        remember(paths, { web: on("web"), panel: on("panel") }, (options.now ?? Date.now)());
      }
    } catch (error) {
      throw new Error(`Hetzner firewalls: ${api.clean(errorMessage(error))}`);
    }
    if (stored.rangesHash !== list.hash) writeSync(paths, { rangesHash: list.hash });
    const count = (n: number, what: string) => `${n} ${what.replace("{s}", n === 1 ? "" : "s")}`;
    const lines = [
      rewritten ? `${count(rewritten, "Hetzner firewall{s}")} set to Cloudflare's list` : "",
      reopened ? `${count(reopened, "Hetzner firewall{s}")} open to anyone put back` : "",
      deleted ? `${count(deleted, "unused Hetzner firewall{s}")} deleted` : "",
      newer ? `${newer} Hetzner firewall${newer === 1 ? " follows" : "s follow"} a newer Cloudflare list from another server` : "",
    ].filter(Boolean);
    return lines.join("; ") || null;
  });
}

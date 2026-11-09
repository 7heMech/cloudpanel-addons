/**
 * Hetzner Cloud Firewalls that let only Cloudflare reach this server's web
 * ports and panel. The addon owns two firewalls per Hetzner project, found by
 * label, whose rules are computed from CloudPanel's Cloudflare list the same
 * way on every server; each server attaches them to itself alone. See
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
import { addonStateDir, CLOUDFLARE_IPS_PATH, LOCK_DIR, PANEL_DB, ROOT_UID } from "../../lib/paths";
import type { ApiFetch } from "../../lib/provider-http";
import { readState, writeState } from "../../lib/root-state";
import { panelUserUid } from "../../lib/sso-auth";
import { HetznerApi, HetznerError, hetznerServerId, validToken, type HetznerFirewall, type HetznerRule, type HetznerServer } from "./hetzner-api";
import { ipv4, ipv6 } from "./protocols";

export type HetznerRole = "web" | "panel";
export const HETZNER_ROLES: Record<HetznerRole, { name: string; ports: number[]; title: string }> = {
  web: { name: "clp-addons-cloudflare-web", ports: [80, 443], title: "Sites through Cloudflare only" },
  panel: { name: "clp-addons-cloudflare-panel", ports: [8443], title: "Panel through Cloudflare only" },
};
const OWNER_KEY = "managed-by";
const OWNER_VALUE = "clp-addons";
export const OWNER_SELECTOR = `${OWNER_KEY}=${OWNER_VALUE}`;
const ROLE_KEY = "clp-addons-role";
/** When the writer's Cloudflare list was last refreshed, so a server with an older list leaves a newer one alone. */
const RANGES_KEY = "clp-addons-ranges-at";
const RULE_DESCRIPTION = "Cloudflare, kept current by clp-addons";
const MAX_RANGES_BYTES = 64 * 1024;

interface HetznerPaths {
  tokenFile: string;
  syncFile: string;
  lockFile: string;
  ranges: string;
  panelDb: string;
  customDomain: string;
  customDomainVhost: string;
  rootUid: number;
  panelUid: number | null;
}

export const DEFAULT_HETZNER_PATHS: HetznerPaths = {
  tokenFile: `${addonStateDir("firewall")}/hetzner-token.json`,
  syncFile: `${addonStateDir("firewall")}/hetzner.json`,
  lockFile: `${LOCK_DIR}/firewall-hetzner.lock`,
  ranges: CLOUDFLARE_IPS_PATH,
  panelDb: PANEL_DB,
  customDomain: PANEL_CUSTOM_DOMAIN_FILE,
  customDomainVhost: PANEL_CUSTOM_DOMAIN_VHOST,
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

function owned(firewalls: HetznerFirewall[], role: HetznerRole): HetznerFirewall[] {
  return firewalls.filter((firewall) => roleOf(firewall) === role).sort((a, b) => a.id - b.id);
}

function labelsFor(role: HetznerRole, refreshedAt: number, current: Record<string, string> = {}): Record<string, string> {
  return { ...current, [OWNER_KEY]: OWNER_VALUE, [ROLE_KEY]: role, [RANGES_KEY]: String(refreshedAt) };
}

/** Whether a server whose list was refreshed at `refreshedAt` may rewrite this firewall's rules. */
export function mayRewrite(firewall: HetznerFirewall, refreshedAt: number): boolean {
  const written = Number(firewall.labels?.[RANGES_KEY]);
  return !Number.isFinite(written) || written <= refreshedAt;
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

function siteDomains(paths: HetznerPaths): string[] {
  if (!existsSync(paths.panelDb)) return [];
  return withPanelDb(paths.panelDb, (db) => db.query("SELECT domain_name FROM site ORDER BY domain_name").all()
    .map((row) => String((row as { domain_name: unknown }).domain_name)));
}

function customDomain(paths: HetznerPaths): string | undefined {
  return panelCustomDomain([paths.rootUid, paths.panelUid ?? panelUserUid() ?? paths.rootUid], paths.customDomain, paths.customDomainVhost);
}

// --- Stored state -----------------------------------------------------------

function readToken(paths: HetznerPaths): string | null {
  const stored = readState<{ token?: unknown } | null>(paths.tokenFile, paths.rootUid, () => null);
  return validToken(stored?.token) ? stored.token : null;
}

function readSync(paths: HetznerPaths): { rangesHash?: string } {
  return readState<{ rangesHash?: string }>(paths.syncFile, paths.rootUid, () => ({}));
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
  on: boolean;
  firewall: string | null;
  /** The rules match the current list. */
  current: boolean;
  /** Set while on: what other firewalls still let reach these ports from outside Cloudflare. */
  stillOpen: string[];
}

export type HetznerView =
  | { state: "absent" }
  | { state: "disconnected"; serverId: number }
  /** `connected` when a token is saved, which the page then offers to replace or remove. */
  | { state: "error"; connected: boolean; error: string }
  | {
    state: "connected";
    serverId: number;
    serverName: string;
    roles: Record<HetznerRole, HetznerRoleView>;
    /** The other firewalls attached to this server. */
    others: string[];
    /** Set when a switch is on and no other firewall allows SSH. */
    sshProblem: string | null;
    rangesProblem: string | null;
  };

function sshMissing(ports: number[], others: HetznerFirewall[]): string | null {
  if (!ports.length) return "the port sshd listens on could not be found";
  const missing = ports.filter((port) => !others.some((firewall) => openings(firewall, port).length));
  if (!missing.length) return null;
  const list = missing.join(", ");
  return others.length
    ? `no other firewall on this server (${others.map((firewall) => firewall.name).join(", ")}) allows SSH on port ${list}`
    : `no other firewall is attached to this server to allow SSH on port ${list}`;
}

export async function hetznerView(options: HetznerOptions = {}): Promise<HetznerView> {
  const paths = pathsOf(options);
  const serverId = await hetznerServerId(options.fetch);
  if (serverId === null) return { state: "absent" };
  const token = readToken(paths);
  if (!token) return { state: "disconnected", serverId };
  const api = apiFor(token, options);
  try {
    const [server, firewalls] = await Promise.all([api.server(serverId), api.firewalls()]);
    const attached = new Set(server.firewalls.map((firewall) => firewall.id));
    const others = firewalls.filter((firewall) => attached.has(firewall.id) && !roleOf(firewall));
    let ranges: CloudflareRanges | null = null;
    let rangesProblem: string | null = null;
    try { ranges = readCloudflareRanges(options); } catch (error) { rangesProblem = errorMessage(error); }
    const roles = {} as Record<HetznerRole, HetznerRoleView>;
    for (const role of Object.keys(HETZNER_ROLES) as HetznerRole[]) {
      const mine = owned(firewalls, role);
      const on = mine.find((firewall) => attached.has(firewall.id));
      roles[role] = {
        on: Boolean(on),
        firewall: (on ?? mine[0])?.name ?? null,
        current: !on || !ranges || rulesSignature(on.rules) === rulesSignature(desiredRules(role, ranges.ranges)),
        stillOpen: on && ranges ? describeOpenings(openToOthers(role, others, ranges.ranges)) : [],
      };
    }
    const anyOn = roles.web.on || roles.panel.on;
    return {
      state: "connected", serverId, serverName: server.name, roles,
      others: others.map((firewall) => firewall.name),
      sshProblem: anyOn ? sshMissing(sshPorts(options.run), others) : null,
      rangesProblem,
    };
  } catch (error) {
    return { state: "error", connected: true, error: `Hetzner could not be read: ${api.clean(errorMessage(error))}` };
  }
}

// --- Changes ----------------------------------------------------------------

async function requireServer(options: HetznerOptions): Promise<number> {
  const serverId = await hetznerServerId(options.fetch);
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
    return { notice: `Connected to the Hetzner project of ${name}.` };
  });
}

export async function disconnectHetzner(options: HetznerOptions = {}): Promise<{ notice: string }> {
  const paths = pathsOf(options);
  return withHetznerLock(paths, async () => {
    const token = readToken(paths);
    if (!token) return { notice: "No Hetzner token is saved." };
    const serverId = await hetznerServerId(options.fetch);
    if (serverId !== null) {
      const api = apiFor(token, options);
      try {
        const [server, firewalls] = await Promise.all([api.server(serverId), api.firewalls(OWNER_SELECTOR)]);
        const attached = new Set(server.firewalls.map((firewall) => firewall.id));
        const on = firewalls.filter((firewall) => roleOf(firewall) && attached.has(firewall.id));
        if (on.length) {
          failAction(`Turn both switches off first: ${on.map((firewall) => firewall.name).join(" and ")} would stay attached to this server and no longer follow Cloudflare's list`);
        }
      } catch (error) {
        // A token Hetzner refuses can always be removed; it could not turn anything off either.
        if (!(error instanceof HetznerError && (error.code === "unauthorized" || error.code === "forbidden" || error.code === "not_found"))) {
          if (error instanceof ActionFailure) throw error;
          failAction(`Could not check what is attached to this server, so the token was kept: ${api.clean(errorMessage(error))}`);
        }
      }
    }
    rmSync(paths.tokenFile, { force: true });
    rmSync(paths.syncFile, { force: true });
    return { notice: "The Hetzner token is removed. It stays valid in Hetzner until you delete it there." };
  });
}

export interface HetznerReview {
  title: string;
  text: string;
  details: string[];
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
async function context(role: HetznerRole, options: HetznerOptions) {
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
  const mine = owned(firewalls, role);
  return {
    paths, serverId, api, attached, mine,
    others: attached.filter((firewall) => !roleOf(firewall)),
    on: mine.find((firewall) => attachedIds.has(firewall.id)) ?? null,
  };
}

async function enableReview(role: HetznerRole, ctx: Awaited<ReturnType<typeof context>>, ranges: string[], options: HetznerOptions): Promise<HetznerReview> {
  const ssh = sshMissing(sshPorts(options.run), ctx.others);
  if (ssh) {
    failAction(`Refused: ${ssh}. Hetzner drops whatever no attached firewall allows, so ${HETZNER_ROLES[role].name} alone would shut SSH out. Attach a firewall that allows SSH to this server in Hetzner's console first.`);
  }
  const resolve = options.resolve ?? systemResolve;
  const domain = customDomain(ctx.paths);
  const stillOpen = describeOpenings(openToOthers(role, ctx.others, ranges));
  const noEffect = stillOpen.length ? ` It has no effect there until that changes: ${stillOpen.join(" ")}` : "";
  if (role === "panel") {
    if (!domain) {
      failAction("Refused: CloudPanel has no custom domain. Add one under Admin → Settings in CloudPanel, proxied through Cloudflare (the orange cloud), so the panel still answers once port 8443 is closed to everyone else.");
    }
    const problem = await notThroughCloudflare(domain, ranges, resolve);
    if (problem) {
      failAction(`Refused: CloudPanel's custom domain ${domain} ${problem}, which is not Cloudflare. Proxy it through Cloudflare (the orange cloud) first, or the panel would answer nowhere.`);
    }
    // CloudPanel serves its custom domain from the sites' Nginx on 443, so Cloudflare must reach 443.
    if (!reachable(ctx.attached, 443, ranges)) {
      failAction(`Refused: ${domain} is served on port 443, and no firewall on this server lets Cloudflare reach 443. Turn on Sites through Cloudflare only first, or allow 443 in another firewall.`);
    }
    return reviewOf(role, true, {
      title: "Let only Cloudflare reach CloudPanel?",
      text: `CloudPanel will answer only at https://${domain}; https://<this server's IP>:8443 stops answering. If ${domain} stops working, reach the panel through an SSH tunnel to 127.0.0.1:8443.${noEffect}`,
      details: [], confirmLabel: "Turn on", danger: true,
    });
  }
  const hosts = [...new Set([...siteDomains(ctx.paths), ...(domain ? [domain] : [])])];
  const problems = await Promise.all(hosts.map(async (host) => {
    const problem = await notThroughCloudflare(host, ranges, resolve);
    return problem ? `${host}${host === domain ? " (CloudPanel)" : ""} ${problem}` : null;
  }));
  const failing = problems.filter((problem): problem is string => problem !== null).sort();
  return reviewOf(role, true, {
    title: "Let only Cloudflare reach the sites?",
    text: `Hetzner will drop every connection to ports 80 and 443 that does not come from Cloudflare. ${failing.length
      ? `${failing.length === 1 ? "This hostname does" : `These ${failing.length} hostnames do`} not resolve to Cloudflare and stop${failing.length === 1 ? "s" : ""} answering:`
      : "Every site resolves to Cloudflare."}${noEffect}`,
    details: failing, confirmLabel: "Turn on", danger: true,
  });
}

function disableReview(role: HetznerRole, ctx: Awaited<ReturnType<typeof context>>, on: HetznerFirewall): HetznerReview {
  const remaining = ctx.attached.filter((firewall) => firewall.id !== on.id);
  const ports = HETZNER_ROLES[role].ports;
  const closed = ports.filter((port) => !remaining.some((firewall) => openings(firewall, port).length));
  const portText = (list: number[]) => list.join(" and ");
  let text: string;
  if (!remaining.length) text = "No other firewall is attached to this server, so Hetzner lets anyone reach every port again.";
  else if (closed.length) {
    text = `No other firewall on this server (${remaining.map((firewall) => firewall.name).join(", ")}) allows ${portText(closed)}, so ${role === "web"
      ? "every site stops answering, to Cloudflare too" : "port 8443 closes to everyone; the custom domain keeps working"}. Allow ${closed.length === 1 ? "it" : "them"} there first to open ${closed.length === 1 ? "it" : "them"} to anyone.`;
  } else text = `Ports ${portText(ports)} are then open as ${remaining.map((firewall) => firewall.name).join(", ")} allow${remaining.length === 1 ? "s" : ""}.`;
  return reviewOf(role, false, {
    title: `Turn off ${HETZNER_ROLES[role].title}?`,
    text: `${on.name} is detached from this server. ${text}`,
    details: [], confirmLabel: "Turn off", danger: closed.length > 0 && role === "web",
  });
}

/** Rewrites an owned firewall's rules to the list unless they match, or a server with a newer list wrote them. */
async function bringCurrent(api: HetznerApi, role: HetznerRole, firewall: HetznerFirewall, list: CloudflareRanges): Promise<"current" | "rewritten" | "newer"> {
  const rules = desiredRules(role, list.ranges);
  if (rulesSignature(firewall.rules) === rulesSignature(rules)) return "current";
  if (!mayRewrite(firewall, list.refreshedAt)) return "newer";
  await api.setRules(firewall.id, rules);
  await api.setLabels(firewall.id, labelsFor(role, list.refreshedAt, firewall.labels));
  return "rewritten";
}

async function attach(role: HetznerRole, ctx: Awaited<ReturnType<typeof context>>, list: CloudflareRanges): Promise<void> {
  const { api, serverId } = ctx;
  const create = async () => {
    try {
      await api.create(HETZNER_ROLES[role].name, labelsFor(role, list.refreshedAt), desiredRules(role, list.ranges), serverId);
      return true;
    } catch (error) {
      if (error instanceof HetznerError && error.code === "uniqueness_error") return false;
      throw error;
    }
  };
  let existing = ctx.mine[0];
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!existing) {
      if (await create()) return;
      // Another server created it a moment ago, or a firewall of that name is not the addon's.
      existing = owned(await api.firewalls(OWNER_SELECTOR), role)[0];
      if (!existing) {
        failAction(`A firewall named ${HETZNER_ROLES[role].name} already exists in this Hetzner project without the label ${OWNER_SELECTOR}; rename or delete it in Hetzner's console`);
      }
    }
    await bringCurrent(api, role, existing, list);
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
}

async function detach(ctx: Awaited<ReturnType<typeof context>>, on: HetznerFirewall): Promise<void> {
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
 * The two switches. Turning one on attaches the role's firewall to this server
 * after the safeguards pass and the operator confirmed the review; off detaches
 * it, likewise confirmed. Each check runs here, never only in the page.
 */
export async function setHetznerRole(
  role: HetznerRole,
  enabled: boolean,
  confirm: unknown,
  options: HetznerOptions = {},
): Promise<{ review: HetznerReview } | { notice: string }> {
  const paths = pathsOf(options);
  return withHetznerLock(paths, async () => {
    const ctx = await context(role, options);
    const title = HETZNER_ROLES[role].title;
    if (enabled && ctx.on) return { notice: `${title} is already on.` };
    if (!enabled && !ctx.on) return { notice: `${title} is already off.` };
    let list: CloudflareRanges | null = null;
    if (enabled) {
      try { list = readCloudflareRanges(options); } catch (error) { failAction(errorMessage(error)); }
    }
    const review = enabled ? await enableReview(role, ctx, list!.ranges, options) : disableReview(role, ctx, ctx.on!);
    if (confirm !== review.digest) return { review };
    try {
      if (enabled) {
        await attach(role, ctx, list!);
        writeState(paths.syncFile, { ...readSync(paths), rangesHash: list!.hash }, paths.rootUid);
      } else {
        await detach(ctx, ctx.on!);
      }
    } catch (error) {
      if (error instanceof ActionFailure) throw error;
      hetznerFailure(ctx.api, error, enabled ? `attach ${HETZNER_ROLES[role].name}` : `detach ${ctx.on!.name}`);
    }
    if (!enabled) return { notice: `${title} is off.` };
    const stillOpen = describeOpenings(openToOthers(role, ctx.others, list!.ranges));
    const ports = HETZNER_ROLES[role].ports.join(" and ");
    return {
      notice: stillOpen.length
        ? `${HETZNER_ROLES[role].name} is attached, but has no effect yet: ${stillOpen.join(" ")}`
        : `Hetzner now lets only Cloudflare reach port${role === "web" ? "s" : ""} ${ports}.`,
    };
  });
}

/**
 * Keeps the addon's firewalls in this Hetzner project in line with the list,
 * writing only what differs. `ranges` is the list watcher's pass, which asks
 * Hetzner nothing unless the list changed since the last pass; `repair` reads
 * the firewalls every time, so a change made in Hetzner's console is put back.
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
    let rewritten = 0, newer = 0, deleted = 0;
    try {
      for (const firewall of await api.firewalls(OWNER_SELECTOR)) {
        const role = roleOf(firewall);
        if (!role) continue;
        if (!firewall.applied_to.length) {
          if (await deleteIfUnused(api, firewall.id)) { deleted++; continue; }
        }
        const result = await bringCurrent(api, role, firewall, list);
        if (result === "rewritten") rewritten++;
        if (result === "newer") newer++;
      }
    } catch (error) {
      throw new Error(`Hetzner firewalls: ${api.clean(errorMessage(error))}`);
    }
    if (stored.rangesHash !== list.hash) writeState(paths.syncFile, { ...stored, rangesHash: list.hash }, paths.rootUid);
    const lines = [
      rewritten ? `${rewritten} Hetzner firewall${rewritten === 1 ? "" : "s"} set to Cloudflare's list` : "",
      deleted ? `${deleted} unused Hetzner firewall${deleted === 1 ? "" : "s"} deleted` : "",
      newer ? `${newer} Hetzner firewall${newer === 1 ? " follows" : "s follow"} a newer Cloudflare list from another server` : "",
    ].filter(Boolean);
    return lines.join("; ") || null;
  });
}

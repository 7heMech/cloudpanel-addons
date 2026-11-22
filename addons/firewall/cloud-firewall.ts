/**
 * What the provider firewalls in front of this server share, whichever
 * provider holds it: Cloudflare's list as rules, the two roles and their ports,
 * what a set of firewalls lets through, which open-to-anyone firewalls a change
 * needs, the review a switch shows, and what the Setup checklist keeps. Each
 * provider maps its own firewalls to `Guard`s and carries out the plan through
 * its API. See "Provider firewalls" in docs/decisions/firewall.md.
 */
import { createHash } from "node:crypto";
import { Resolver } from "node:dns/promises";
import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync } from "node:fs";
import { failAction } from "../../lib/action";
import { runCommand, type CommandResult } from "../../lib/command";
import { errorMessage } from "../../lib/errors";
import { panelCustomDomain } from "../../lib/panel-custom-domain";
import { withPanelDb } from "../../lib/panel-db";
import { readState, writeState } from "../../lib/root-state";
import { panelUserUid } from "../../lib/sso-auth";
import { trustedText } from "../../lib/trusted-file";
import { ipv4, ipv6, panelRulePorts } from "./protocols";

export type CloudRole = "web" | "panel";
/** `name` lets only Cloudflare reach the ports; `open` lets anyone, for while the switch is off. */
export const CLOUD_ROLES: Record<CloudRole, { name: string; open: string; ports: number[]; title: string }> = {
  web: { name: "clp-addons-cloudflare-web", open: "clp-addons-open-web", ports: [80, 443], title: "Sites through Cloudflare only" },
  panel: { name: "clp-addons-cloudflare-panel", open: "clp-addons-open-panel", ports: [8443], title: "Panel through Cloudflare only" },
};
export const ROLES = Object.keys(CLOUD_ROLES) as CloudRole[];
export type Access = "cloudflare" | "open";
export const RULE_DESCRIPTION = "Cloudflare, kept current by clp-addons";
export const OPEN_DESCRIPTION = "Anyone, kept by clp-addons";
export const ANYONE = ["0.0.0.0/0", "::/0"];
const MAX_RANGES_BYTES = 64 * 1024;

// --- Address ranges ---------------------------------------------------------

export interface Cidr { v6: boolean; bits: bigint; prefix: number; text: string; hostBits: boolean }

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

export function contains(outer: Cidr, inner: Cidr): boolean {
  const width = outer.v6 ? 128 : 32;
  return outer.v6 === inner.v6 && outer.prefix <= inner.prefix && maskBits(inner.bits, width, outer.prefix) === outer.bits;
}

function sortRanges(ranges: Cidr[]): string[] {
  return [...ranges].sort((a, b) => Number(a.v6) - Number(b.v6) || (a.bits < b.bits ? -1 : a.bits > b.bits ? 1 : a.prefix - b.prefix))
    .map((range) => range.text);
}

/** A list of addresses in canonical form, deduplicated and sorted, for comparing what two providers spell differently. */
export function canonicalList(list: string[] | null | undefined): string[] {
  return [...new Set((list ?? []).map((ip) => parseCidr(ip)?.text ?? ip))].sort();
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

export interface CloudflareRanges { ranges: string[]; refreshedAt: number; hash: string }

export interface RangesSource { ranges: string; rootUid: number; panelUid: number | null }

/**
 * The list, read only from a file root or the panel account owns and no one
 * else can write. `unchanged` names what a failure leaves alone.
 */
export function readCloudflareRangesFrom(source: RangesSource, unchanged: string): CloudflareRanges {
  const owners = [source.rootUid, source.panelUid ?? panelUserUid() ?? source.rootUid];
  let text: string;
  let refreshedAt: number;
  try {
    const fd = openSync(source.ranges, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
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
    throw new Error(`Cloudflare's ranges in ${source.ranges} ${code === "ENOENT" ? "are missing" : code ? "cannot be read" : errorMessage(error)}; ${unchanged} were not changed`);
  }
  let ranges: string[];
  try { ranges = parseCloudflareRanges(text); }
  catch (error) { throw new Error(`Cloudflare's ranges in ${source.ranges} are unusable: ${errorMessage(error)}; ${unchanged} were not changed`); }
  return { ranges, refreshedAt, hash: createHash("sha256").update(ranges.join("\n")).digest("hex") };
}

/**
 * Whether a server whose list was refreshed at `refreshedAt` may rewrite rules
 * another wrote from a list of `written`. A time more than a day ahead of this
 * server's clock is not believed, so a writer with a wrong clock cannot hold
 * the rules for good.
 */
export function mayRewriteAt(written: number, refreshedAt: number, now = Date.now()): boolean {
  return !Number.isFinite(written) || written <= refreshedAt || written > now / 1000 + 86_400;
}

// --- What a set of firewalls lets through -----------------------------------

/** One inbound rule, as every provider's maps to it. `port` is a port, a range, or `any`. */
export interface InboundRule { protocol: string; port: string; sources: string[]; accept: boolean }

/** A firewall, or a policy, by what it lets in, in the order the provider applies its rules. */
export interface Guard { name: string; rules: InboundRule[] }

export function portCovers(port: string, target: number): boolean {
  if (port === "any") return true;
  const match = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(port);
  if (!match) return false;
  return Number(match[1]) <= target && target <= Number(match[2] ?? match[1]);
}

/** The sources a guard lets reach a TCP port. */
export function openings(guard: Guard, port: number): Cidr[] {
  return guard.rules
    .filter((rule) => rule.accept && rule.protocol === "tcp" && portCovers(rule.port, port))
    .flatMap((rule) => rule.sources.map(parseCidr).filter((cidr): cidr is Cidr => cidr !== null));
}

/**
 * Whether some source of the family can reach the whole port range through
 * these guards, rule by rule in order: the first rule for it decides, and a
 * drop decides only when it covers the whole family. `fallsOpen` is what
 * happens when no rule decides.
 */
export function allows(guards: Guard[], fallsOpen: boolean, protocol: "tcp" | "udp", from: number, to: number, v6: boolean): boolean {
  for (const rule of guards.flatMap((guard) => guard.rules)) {
    if (rule.protocol !== protocol || !portCovers(rule.port, from) || !portCovers(rule.port, to)) continue;
    const family = rule.sources.map(parseCidr).filter((cidr): cidr is Cidr => cidr?.v6 === v6);
    if (rule.accept && family.length) return true;
    if (!rule.accept && family.some((cidr) => cidr.prefix === 0)) return false;
  }
  return fallsOpen;
}

/** Whether every range can reach the port through one of the guards. */
export function reachable(guards: Guard[], port: number, ranges: string[]): boolean {
  const sources = guards.flatMap((guard) => openings(guard, port));
  return ranges.map(parseCidr).every((range) => range && sources.some((source) => contains(source, range)));
}

export interface Opening { port: number; firewall: string; sources: string[] }

/** What another guard still lets reach the role's ports from outside Cloudflare, which leaves the addon's without effect. */
export function openToOthers(role: CloudRole, others: Guard[], ranges: string[]): Opening[] {
  const cloudflare = ranges.map(parseCidr).filter((cidr): cidr is Cidr => cidr !== null);
  const found: Opening[] = [];
  for (const port of CLOUD_ROLES[role].ports) {
    for (const guard of others) {
      const sources = openings(guard, port).filter((source) => !cloudflare.some((range) => contains(range, source)));
      if (sources.length) found.push({ port, firewall: guard.name, sources: [...new Set(sources.map((source) => source.text))] });
    }
  }
  return found;
}

export function describeOpenings(openings: Opening[], noun = "firewall"): string[] {
  return openings.map((opening) => {
    const anyone = opening.sources.some((source) => source.endsWith("/0"));
    return `${opening.port} is still open to ${anyone ? "anyone" : opening.sources.join(", ")} through ${noun} ${opening.firewall}.`;
  });
}

/** The ports sshd listens on that no guard allows from anywhere. */
export function sshMissing(ports: number[], others: Guard[]): number[] {
  return ports.filter((port) => !others.some((guard) => openings(guard, port).length));
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

/** sshd's ports, or 22 when neither ss nor its configuration names one, so a closing SSH is never missed. */
function sshPortsOr22(run?: (command: string, args: string[]) => CommandResult): number[] {
  const ports = sshPorts(run);
  return ports.length ? ports : [22];
}

export async function systemResolve(host: string): Promise<string[]> {
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

/** The files a review reads on this server. */
export interface HostPaths {
  panelDb: string;
  nginxSitesDir: string;
  customDomain: string;
  customDomainVhost: string;
  /** CloudPanel's Firewall page protocols, for the ports a change would close. */
  protocolsFile: string;
  /** Present while the Terminal addon is enabled, which the page then offers as the way to a shell. */
  terminalConfig: string;
  rootUid: number;
  panelUid: number | null;
}

export interface HostOptions {
  /** A hostname's A and AAAA addresses; none when it does not resolve. */
  resolve?: (host: string) => Promise<string[]>;
  run?: (command: string, args: string[]) => CommandResult;
}

/** Every hostname the sites answer to: each site's domain and the other names its vhost's server_name lists. */
function siteHostnames(paths: HostPaths): string[] {
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

function customDomain(paths: HostPaths): string | undefined {
  return panelCustomDomain([paths.rootUid, paths.panelUid ?? panelUserUid() ?? paths.rootUid], paths.customDomain, paths.customDomainVhost);
}

interface Watched { protocol: "tcp" | "udp"; from: number; to: number; ssh: boolean }

/** The ports sshd listens on and those CloudPanel's Firewall page opens; `unread` when the page's rules could not be read. */
function watchedPorts(paths: HostPaths, options: HostOptions): { list: Watched[]; unread: boolean } {
  const list: Watched[] = sshPortsOr22(options.run).map((port) => ({ protocol: "tcp", from: port, to: port, ssh: true }));
  let rules: ReturnType<typeof panelRulePorts>;
  try {
    rules = panelRulePorts({ paths: { stateFile: paths.protocolsFile, panelDb: paths.panelDb, rootUid: paths.rootUid } });
  } catch {
    return { list, unread: true };
  }
  for (const rule of rules) {
    const [from = 0, to = from] = rule.portRange.split("-").map(Number);
    for (const protocol of rule.protocols) {
      if (!list.some((item) => item.protocol === protocol && item.from <= from && to <= item.to)) list.push({ protocol, from, to, ssh: false });
    }
  }
  return { list, unread: false };
}

// --- Planning a switch ------------------------------------------------------

/** A provider's firewalls on this server as a change sees them, with how to read each one as a `Guard`. */
export interface PlanContext<F> {
  serverName: string;
  attached: F[];
  /** The attached firewalls that are not the addon's. */
  others: F[];
  cloudflare: Record<CloudRole, F | null>;
  open: Record<CloudRole, F | null>;
  /** Whether the provider lets in what no attached rule decides, now. */
  fallsOpenNow: boolean;
  guard: (firewall: F) => Guard;
  /** Whether it would with only these attached. */
  fallsOpenAfter: (after: F[]) => boolean;
  /** One of the addon's firewalls as it will be, for checking a change before it exists. */
  standIn: (role: CloudRole, access: Access) => F;
}

export interface Plan<F> {
  /** The roles whose Cloudflare firewall is on this server afterwards. */
  cloudflare: Set<CloudRole>;
  /** The roles whose open firewall is on this server afterwards. */
  open: Set<CloudRole>;
  /** Every firewall on this server afterwards, the operator's first. */
  after: F[];
}

/**
 * The addon's firewalls on this server once `role` is switched. A role whose
 * switch is off gets its open firewall where no other firewall allows any of
 * its ports and they would otherwise close: when nothing closed them before,
 * while its Cloudflare firewall comes off, or while the open one is already
 * there. A port another firewall closed on purpose stays closed. When nothing
 * left would close a port, nothing of the addon's stays.
 */
export function planFor<F>(ctx: PlanContext<F>, role: CloudRole, enabled: boolean): Plan<F> {
  const cloudflare = new Set(ROLES.filter((each) => each === role ? enabled : ctx.cloudflare[each] !== null));
  const open = new Set<CloudRole>();
  const base = [...ctx.others, ...[...cloudflare].map((each) => ctx.cloudflare[each] ?? ctx.standIn(each, "cloudflare"))];
  if (!ctx.fallsOpenAfter(base)) {
    const others = ctx.others.map(ctx.guard);
    const attached = ctx.attached.map(ctx.guard);
    for (const each of ROLES) {
      if (cloudflare.has(each)) continue;
      const ports = CLOUD_ROLES[each].ports;
      // Only when nothing of the operator's allows any of the ports: the open firewall opens them all.
      const needed = ports.every((port) => !others.some((guard) => openings(guard, port).length));
      const reachableNow = ctx.fallsOpenNow || ports.some((port) => attached.some((guard) => openings(guard, port).length));
      if (needed && (ctx.open[each] || reachableNow)) open.add(each);
    }
  }
  const after = [...base, ...[...open].map((each) => ctx.open[each] ?? ctx.standIn(each, "open"))];
  return { cloudflare, open, after };
}

// --- The review -------------------------------------------------------------

export interface CloudReview {
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

/** How a provider's reviews speak. */
export interface ProviderWords {
  /** "Hetzner", "netcup". */
  provider: string;
  /** What the provider calls one of the addon's firewalls. */
  noun: string;
  /** Where the provider still gives a root shell, as a sentence's subject. */
  console: string;
  /** Introduces the closing ports when nothing closed any before. */
  nothingClosedYet: string;
  /** Why anyone can reach every port once nothing of the addon's stays. */
  allOpenAgain: string;
  /** What else stops arriving once the provider drops by default, if anything. */
  closesMore?: string;
}

function reviewOf(role: CloudRole, enabled: boolean, fields: Omit<CloudReview, "digest">): CloudReview {
  const digest = createHash("sha256").update(JSON.stringify({ role, enabled, ...fields })).digest("hex").slice(0, 32);
  return { ...fields, digest };
}

/** What anyone could reach before the change and nothing lets through after it, in words; IPv4 and IPv6 apart. */
function closingLines<F>(ctx: PlanContext<F>, plan: Plan<F>, watched: Watched[]): { lines: string[]; ssh: boolean } {
  const before = ctx.attached.map(ctx.guard);
  const after = plan.after.map(ctx.guard);
  const afterOpen = ctx.fallsOpenAfter(plan.after);
  const closing = watched.flatMap((item) => {
    const lost = [false, true].filter((v6) => allows(before, ctx.fallsOpenNow, item.protocol, item.from, item.to, v6)
      && !allows(after, afterOpen, item.protocol, item.from, item.to, v6));
    return lost.length ? [{ ...item, only: lost.length === 1 ? (lost[0] ? " over IPv6" : " over IPv4") : "" }] : [];
  });
  const ports = (items: typeof closing) => {
    const names = items.map((item) => `${item.from === item.to ? item.from : `${item.from}-${item.to}`}${item.only}`);
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

export const portsOf = (role: CloudRole) => {
  const ports = CLOUD_ROLES[role].ports;
  return `port${ports.length === 1 ? "" : "s"} ${ports.join(" and ")}`;
};

/** The open firewalls a change attaches, in words. */
function opening<F>(ctx: PlanContext<F>, plan: Plan<F>, except?: CloudRole): string {
  return [...plan.open].filter((role) => role !== except && !ctx.open[role])
    .map((role) => ` ${portsOf(role)[0]!.toUpperCase()}${portsOf(role).slice(1)} stay${CLOUD_ROLES[role].ports.length === 1 ? "s" : ""} open to anyone through ${CLOUD_ROLES[role].open}.`).join("");
}

/** When ports close: what introduces them, what the operator must type, and the way back to a shell. */
function closingFields<F>(ctx: PlanContext<F>, plan: Plan<F>, paths: HostPaths, options: HostOptions, words: ProviderWords) {
  const watched = watchedPorts(paths, options);
  const closes = closingLines(ctx, plan, watched.list);
  const shell = !closes.ssh ? "" : existsSync(paths.terminalConfig)
    ? `${words.console} still gives a root shell, and so does Terminal from this panel, for an administrator root allows one.`
    : `${words.console} still gives a root shell.`;
  const lead = !closes.lines.length ? []
    : ctx.fallsOpenNow ? [words.nothingClosedYet] : ["Nothing on this server lets anyone reach these any more:"];
  const unread = watched.unread ? ["CloudPanel's Firewall rules could not be read, so only SSH was checked."] : [];
  const more = words.closesMore && ctx.fallsOpenNow && !ctx.fallsOpenAfter(plan.after) ? [words.closesMore] : [];
  return { closes: closes.lines, lead: [...unread, ...more, ...lead], shell, ssh: closes.ssh, typed: closes.lines.length ? ctx.serverName : "" };
}

/** Why turning a role on is refused, or what it would do. */
export async function enableReview<F>(
  role: CloudRole, ctx: PlanContext<F>, plan: Plan<F>, ranges: string[], paths: HostPaths, options: HostOptions, words: ProviderWords,
): Promise<CloudReview> {
  const resolve = options.resolve ?? systemResolve;
  const domain = customDomain(paths);
  const stillOpen = describeOpenings(openToOthers(role, ctx.others.map(ctx.guard), ranges), words.noun);
  const warnings = stillOpen.length ? [`No effect yet: ${stillOpen.join(" ")}`] : [];
  const closing = closingFields(ctx, plan, paths, options, words);
  if (role === "panel") {
    if (!domain) {
      failAction("Refused: CloudPanel has no custom domain. Add one under Admin → Settings in CloudPanel, proxied through Cloudflare (the orange cloud), so the panel still answers once port 8443 is closed to everyone else.");
    }
    const problem = await notThroughCloudflare(domain, ranges, resolve);
    if (problem) {
      failAction(`Refused: CloudPanel's custom domain ${domain} ${problem}, which is not Cloudflare. Proxy it through Cloudflare (the orange cloud) first, or the panel would answer nowhere.`);
    }
    // CloudPanel serves its custom domain from the sites' Nginx on 443, so Cloudflare must reach 443.
    if (!reachable(plan.after.map(ctx.guard), 443, ranges)) {
      failAction(`Refused: ${domain} is served on port 443, and no ${words.noun} on this server lets Cloudflare reach 443. Turn on Sites through Cloudflare only first, or allow 443 in another ${words.noun}.`);
    }
    return reviewOf(role, true, {
      title: "Let only Cloudflare reach CloudPanel?",
      text: `CloudPanel will answer only at https://${domain}; https://<this server's IP>:8443 stops answering.${opening(ctx, plan, role)}`,
      listLabel: "", details: [], warnings: [...warnings, ...closing.lead], closes: closing.closes,
      wayBack: closing.ssh
        ? `If ${domain} stops working, ${words.console} still gives a root shell.`
        : `If ${domain} stops working, reach the panel through an SSH tunnel to 127.0.0.1:8443.`,
      typed: closing.typed, confirmLabel: "Turn on", danger: true,
    });
  }
  const hosts = [...new Set([...siteHostnames(paths), ...(domain ? [domain] : [])])];
  // A name that does not resolve answers no one now, so only names that reach this server elsewhere are listed.
  const problems = await Promise.all(hosts.map(async (host) => {
    const problem = await notThroughCloudflare(host, ranges, resolve);
    return problem && problem !== "does not resolve" ? `${host}${host === domain ? " (CloudPanel)" : ""} ${problem}` : null;
  }));
  const failing = problems.filter((problem): problem is string => problem !== null).sort();
  return reviewOf(role, true, {
    title: "Let only Cloudflare reach the sites?",
    text: `${words.provider} will drop every connection to ports 80 and 443 that does not come from Cloudflare.${failing.length ? "" : " Every site resolves to Cloudflare."}${opening(ctx, plan, role)}`,
    listLabel: failing.length === 1 ? "This hostname does not resolve to Cloudflare and stops answering"
      : failing.length ? `These ${failing.length} hostnames do not resolve to Cloudflare and stop answering` : "",
    details: failing, warnings: [...warnings, ...closing.lead], closes: closing.closes, wayBack: closing.shell,
    typed: closing.typed, confirmLabel: "Turn on", danger: true,
  });
}

/** Why turning a role off is refused, or what it would do. */
export function disableReview<F>(
  role: CloudRole, ctx: PlanContext<F>, plan: Plan<F>, ranges: string[] | null, paths: HostPaths, options: HostOptions, words: ProviderWords,
): CloudReview {
  const on = ctx.guard(ctx.cloudflare[role]!);
  const after = plan.after.map(ctx.guard);
  // The panel switch needs Cloudflare to reach 443 for the custom domain; this one may be what lets it.
  if (role === "web" && plan.cloudflare.has("panel")) {
    const cut = ranges ? !reachable(after, 443, ranges) : !after.some((guard) => openings(guard, 443).length);
    if (cut) {
      failAction(`Refused: with Panel through Cloudflare only on, CloudPanel's custom domain needs Cloudflare to reach 443, and no other ${words.noun} on this server allows it. Turn off Panel through Cloudflare only first, or allow 443 in another ${words.noun}; otherwise only an SSH tunnel to 127.0.0.1:8443 reaches the panel.`);
    }
  }
  const ports = portsOf(role);
  const removed = ROLES.filter((each) => ctx.open[each] && !plan.open.has(each)).map((each) => CLOUD_ROLES[each].open);
  const alsoOff = removed.length ? ` ${removed.join(" and ")} come${removed.length === 1 ? "s" : ""} off too.` : "";
  const others = ctx.others.map(ctx.guard);
  const text = plan.open.has(role)
    ? `Anyone can reach ${ports} again: ${CLOUD_ROLES[role].open} takes the place of ${on.name} on this server.`
    : ctx.fallsOpenAfter(plan.after)
      ? `${on.name} comes off, and ${words.allOpenAgain}.${alsoOff}`
      : `${on.name} comes off; ${ports} are then open as ${others.map((guard) => guard.name).join(", ")} allow${others.length === 1 ? "s" : ""}.${alsoOff}`;
  const closing = closingFields(ctx, plan, paths, options, words);
  return reviewOf(role, false, {
    title: `Turn off ${CLOUD_ROLES[role].title}?`,
    text: `${text}${opening(ctx, plan, role)}`,
    listLabel: "", details: [], warnings: closing.lead,
    closes: closing.closes, wayBack: closing.shell, typed: closing.typed,
    confirmLabel: "Turn off", danger: closing.closes.length > 0,
  });
}

// --- What the page shows ----------------------------------------------------

export interface CloudRoleView {
  /** The role's Cloudflare firewall is attached here. */
  on: boolean;
  /** The role's Cloudflare firewall: the one attached, else the account's. */
  firewall: string | null;
  /** The role's firewall open to anyone, while it is attached here. */
  open: string | null;
  /** The rules match the current list. */
  current: boolean;
  /** Set while on: what other firewalls still let reach these ports from outside Cloudflare. */
  stillOpen: string[];
}

export interface CloudConnectedView {
  state: "connected";
  serverId: number;
  serverName: string;
  roles: Record<CloudRole, CloudRoleView>;
  /** The other firewalls attached to this server. */
  others: string[];
  /** The Terminal addon is enabled, so the page offers it for a shell. */
  terminal: boolean;
  /** While one of the addon's firewalls is attached: the ports sshd listens on that no other firewall allows. */
  sshClosed: number[];
  rangesProblem: string | null;
  /** Why the switches cannot act here, when the provider's firewall itself is off. */
  blocked?: string | null;
}

/** What a page shows of one role, from the firewalls attached here and the addon's in the account. */
export function roleView(
  on: Guard | undefined, owned: Guard | undefined, open: Guard | undefined, current: boolean, role: CloudRole,
  others: Guard[], ranges: CloudflareRanges | null, noun: string,
): CloudRoleView {
  return {
    on: Boolean(on),
    firewall: (on ?? owned)?.name ?? null,
    open: open?.name ?? null,
    current,
    stillOpen: on && ranges ? describeOpenings(openToOthers(role, others, ranges.ranges), noun) : [],
  };
}

// --- What the Setup checklist reads -----------------------------------------

/** Which switches were on when the provider was last read, and when. */
export interface SeenState {
  rangesHash?: string;
  seen?: Record<CloudRole, boolean>;
  seenAt?: number;
}

export function readSync<T extends SeenState>(file: string, rootUid: number): T {
  return readState<T>(file, rootUid, () => ({}) as T);
}

export function writeSync<T extends SeenState>(file: string, rootUid: number, change: Partial<T>): void {
  writeState(file, { ...readSync<T>(file, rootUid), ...change }, rootUid);
}

export interface CloudSetupState { cloud: boolean; token: boolean; seen: Partial<Record<CloudRole, boolean>>; seenAt: number | null }

/** The firmware's vendor, which names the provider on its virtual servers; "" when it does not say. */
export function firmwareVendor(file: string): string {
  try { return readFileSync(file, "utf8").trim(); } catch { return ""; }
}

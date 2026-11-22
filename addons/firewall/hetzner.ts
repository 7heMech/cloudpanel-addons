/**
 * Hetzner Cloud Firewalls that let only Cloudflare reach this server's web
 * ports and panel. The addon owns up to four firewalls per Hetzner project,
 * found by label: per role, one whose rules are computed from CloudPanel's
 * Cloudflare list the same way on every server, and one open to anyone for
 * when the switch is off. Each server attaches them to itself alone. See
 * "Hetzner Cloud Firewall" in docs/decisions/firewall.md.
 */
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
  ANYONE, canonicalList, CLOUD_ROLES, disableReview, enableReview, firmwareVendor, mayRewriteAt, OPEN_DESCRIPTION, planFor, portsOf,
  readCloudflareRangesFrom, readSync as readSyncFile, ROLES, RULE_DESCRIPTION, sshMissing, sshPorts, writeSync as writeSyncFile,
  describeOpenings, openToOthers, roleView,
  type Access, type CloudConnectedView, type CloudflareRanges, type CloudReview, type CloudRole, type CloudSetupState, type Guard,
  type HostPaths, type Plan, type PlanContext, type ProviderWords, type SeenState,
} from "./cloud-firewall";
import { HetznerApi, HetznerError, hetznerHostname, hetznerServerId, validToken, type HetznerFirewall, type HetznerRule, type HetznerServer } from "./hetzner-api";
import { DEFAULT_FIREWALL_PATHS } from "./protocols";

export { parseCidr, parseCloudflareRanges, sshPorts } from "./cloud-firewall";
export type HetznerRole = CloudRole;
export const HETZNER_ROLES = CLOUD_ROLES;
/** Hetzner applies at most this many firewalls to one server. */
const MAX_FIREWALLS = 5;
const OWNER_KEY = "managed-by";
const OWNER_VALUE = "clp-addons";
export const OWNER_SELECTOR = `${OWNER_KEY}=${OWNER_VALUE}`;
const ROLE_KEY = "clp-addons-role";
/** `open` on the firewalls open to anyone; the Cloudflare ones have none. */
const ACCESS_KEY = "clp-addons-access";
/** When the writer's Cloudflare list was last refreshed, so a server with an older list leaves a newer one alone. */
const RANGES_KEY = "clp-addons-ranges-at";

const WORDS: ProviderWords = {
  provider: "Hetzner",
  noun: "firewall",
  console: "Hetzner Console's web console",
  nothingClosedYet: "No firewall is attached to this server yet, so Hetzner also closes every port the addon's firewalls do not open:",
  allOpenAgain: "no firewall stays on this server, so Hetzner lets anyone reach every port again",
};

interface HetznerPaths extends HostPaths {
  tokenFile: string;
  syncFile: string;
  lockFile: string;
  ranges: string;
  /** The firmware's vendor, which is Hetzner on Hetzner Cloud. */
  vendor: string;
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

export function readCloudflareRanges(options: HetznerOptions = {}): CloudflareRanges {
  return readCloudflareRangesFrom(pathsOf(options), "the Hetzner firewalls");
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

/** Two rule sets with the same signature allow the same traffic, whatever order or spelling Hetzner returns. */
export function rulesSignature(rules: HetznerRule[]): string {
  return JSON.stringify(rules.map((rule) => JSON.stringify([
    rule.direction, rule.protocol, rule.port ?? "", canonicalList(rule.source_ips), canonicalList(rule.destination_ips), rule.description ?? "",
  ])).sort());
}

/** A firewall by what it lets in: Hetzner's rules only allow, and any of them may let a source in. */
function guardOf(firewall: HetznerFirewall): Guard {
  return {
    name: firewall.name,
    rules: firewall.rules.filter((rule) => rule.direction === "in")
      .map((rule) => ({ protocol: rule.protocol, port: rule.port ?? "", sources: rule.source_ips ?? [], accept: true })),
  };
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

/** Whether a server whose list was refreshed at `refreshedAt` may rewrite this firewall's rules. */
export function mayRewrite(firewall: HetznerFirewall, refreshedAt: number, now = Date.now()): boolean {
  return mayRewriteAt(Number(firewall.labels?.[RANGES_KEY]), refreshedAt, now);
}

// --- Stored state -----------------------------------------------------------

function readToken(paths: HetznerPaths): string | null {
  const stored = readState<{ token?: unknown } | null>(paths.tokenFile, paths.rootUid, () => null);
  return validToken(stored?.token) ? stored.token : null;
}

interface SyncState extends SeenState {
  /** This server's id, kept while a token is saved, for when the metadata service does not answer. */
  serverId?: number;
  /** Until when the page treats this server as not on Hetzner Cloud without asking again. */
  absentUntil?: number;
}

function readSync(paths: HetznerPaths): SyncState {
  return readSyncFile<SyncState>(paths.syncFile, paths.rootUid);
}

function writeSync(paths: HetznerPaths, change: Partial<SyncState>): void {
  writeSyncFile<SyncState>(paths.syncFile, paths.rootUid, change);
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

async function withHetznerLock<T>(paths: HetznerPaths, body: () => Promise<T>, timeoutSeconds = 120): Promise<T> {
  return withFileLock(paths.lockFile, timeoutSeconds, "another Hetzner firewall change is running", body);
}

function apiFor(token: string, options: HetznerOptions): HetznerApi {
  return new HetznerApi(token, options.fetch, options.sleep);
}

// --- What the page shows ----------------------------------------------------

export type HetznerView =
  | { state: "absent" }
  /** `serverName` is the hostname the metadata service reports, the server's name when it was created. */
  | { state: "disconnected"; serverId: number; serverName: string | null }
  /** `connected` when a token is saved, which the page then offers to replace or remove. */
  | { state: "error"; connected: boolean; error: string }
  | CloudConnectedView;

/** What the Setup checklist reads, without asking Hetzner: whether this is Hetzner Cloud, a token, and the switches as last seen. */
export function hetznerSetupState(options: HetznerOptions = {}): CloudSetupState {
  const paths = pathsOf(options);
  const token = readToken(paths) !== null;
  const stored = token ? readSync(paths) : {};
  return { cloud: firmwareVendor(paths.vendor) === "Hetzner" || token, token, seen: stored.seen ?? {}, seenAt: stored.seenAt ?? null };
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
    const roles = {} as CloudConnectedView["roles"];
    for (const role of ROLES) {
      const mine = owned(firewalls, role);
      const on = mine.find((firewall) => attachedIds.has(firewall.id));
      const open = owned(attached, role, "open")[0];
      const current = !on || !ranges || rulesSignature(on.rules) === rulesSignature(desiredRules(role, ranges.ranges));
      roles[role] = roleView(on && guardOf(on), mine[0] && guardOf(mine[0]), open && guardOf(open), current, role, others.map(guardOf), ranges, WORDS.noun);
    }
    // Only while no change holds the lock, which records what it sees itself; only while the token is still
    // saved, so a read racing its removal does not bring hetzner.json back; and only when nothing recorded
    // since this read began, whose view would be newer.
    await withHetznerLock(paths, async () => {
      if (readToken(paths) && (readSync(paths).seenAt ?? 0) < now) remember(paths, { web: roles.web.on, panel: roles.panel.on }, now);
    }, 0).catch(() => {});
    return {
      state: "connected", serverId, serverName: server.name, roles,
      others: others.map((firewall) => firewall.name),
      terminal: existsSync(paths.terminalConfig),
      sshClosed: attached.some((firewall) => roleOf(firewall)) ? sshMissing(sshPorts(options.run), others.map(guardOf)) : [],
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

function failureText(api: HetznerApi, error: unknown, doing: string): string {
  if (error instanceof ActionFailure) return error.message;
  if (error instanceof HetznerError && error.code === "unauthorized") return `Hetzner no longer accepts the saved token; connect a new one to ${doing}`;
  if (error instanceof HetznerError && error.code === "forbidden") return `The saved token is read-only; connect a Read & Write token to ${doing}`;
  return `Could not ${doing}: ${api.clean(errorMessage(error))}`;
}

function hetznerFailure(api: HetznerApi, error: unknown, doing: string): never {
  failAction(failureText(api, error, doing));
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

export type HetznerReview = CloudReview;

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

/** Once any firewall is attached, Hetzner drops all inbound traffic no attached firewall allows. */
function planContext(ctx: Context, ranges: string[]): PlanContext<HetznerFirewall> {
  return {
    ...ctx, fallsOpenNow: !ctx.attached.length, guard: guardOf,
    fallsOpenAfter: (after) => !after.length,
    standIn: (role, access) => standIn(role, access, ranges),
  };
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

/** Attaches the role's firewall of that access to this server, creating it if needed; returns it. */
async function attach(role: HetznerRole, access: Access, ctx: Context, list: CloudflareRanges | null): Promise<HetznerFirewall> {
  const { api, serverId } = ctx;
  const name = access === "open" ? HETZNER_ROLES[role].open : HETZNER_ROLES[role].name;
  const create = async () => {
    try {
      return access === "open"
        ? await api.create(name, openLabels(role), openRules(role), serverId)
        : await api.create(name, labelsFor(role, list!.refreshedAt), desiredRules(role, list!.ranges), serverId);
    } catch (error) {
      if (error instanceof HetznerError && error.code === "uniqueness_error") return null;
      throw error;
    }
  };
  let existing = owned(ctx.firewalls, role, access)[0];
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!existing) {
      const created = await create();
      if (created) return created;
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
      return existing;
    } catch (error) {
      if (error instanceof HetznerError && error.code === "firewall_already_applied") return existing;
      // Deleted by another server's repair between the read and now: create it again.
      if (error instanceof HetznerError && error.code === "not_found") { existing = undefined; continue; }
      throw error;
    }
  }
  failAction(`${name} was deleted by another server each time it was attached; try again`);
}

async function detach(ctx: Context, on: HetznerFirewall): Promise<void> {
  await takeOff(ctx, on);
  await deleteIfUnused(ctx.api, on.id);
}

/** Takes a firewall off this server and keeps it, so a change that fails later can put it back. */
async function takeOff(ctx: Context, on: HetznerFirewall): Promise<void> {
  const { api, serverId } = ctx;
  try {
    await api.remove(on.id, serverId);
  } catch (error) {
    if (error instanceof HetznerError && error.code === "firewall_managed_by_label_selector") {
      failAction(`${on.name} is applied to this server by a label selector, which the addon never uses; remove that in Hetzner's console`);
    }
    if (!(error instanceof HetznerError && error.code === "firewall_already_removed")) throw error;
  }
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

interface Step { what: string; run: () => Promise<void>; undo: () => Promise<void> }

/**
 * Carries out a plan one firewall at a time. Turning on attaches the role's
 * Cloudflare firewall first, so a refusal there leaves what is attached as it
 * was; open firewalls go on before any comes off. At Hetzner's limit there is
 * no room for that, so firewalls come off first and a refused attach follows
 * them. A step that fails puts back what the earlier ones did, and the failure
 * says what is attached if that fails too.
 */
async function apply(ctx: Context, role: HetznerRole, enabled: boolean, plan: Plan<HetznerFirewall>, list: CloudflareRanges | null): Promise<void> {
  const attached = new Set(ctx.attached.map((firewall) => firewall.name));
  const adding = (each: HetznerRole, access: Access): Step => {
    let firewall: HetznerFirewall | null = null;
    const name = access === "open" ? HETZNER_ROLES[each].open : HETZNER_ROLES[each].name;
    return {
      what: `attach ${name}`,
      run: async () => { firewall = await attach(each, access, ctx, list); attached.add(name); },
      undo: async () => { await detach(ctx, firewall!); attached.delete(name); },
    };
  };
  const removing = (firewall: HetznerFirewall): Step => ({
    what: `detach ${firewall.name}`,
    run: async () => { await takeOff(ctx, firewall); attached.delete(firewall.name); },
    undo: async () => { await ctx.api.apply(firewall.id, ctx.serverId); attached.add(firewall.name); },
  });
  const adds = [
    ...(enabled ? [adding(role, "cloudflare")] : []),
    ...[...plan.open].filter((each) => !ctx.open[each]).map((each) => adding(each, "open")),
  ];
  const removed = [
    ...(enabled ? [] : [ctx.cloudflare[role]!]),
    ...ROLES.filter((each) => ctx.open[each] && !plan.open.has(each)).map((each) => ctx.open[each]!),
  ];
  const removes = removed.map(removing);
  const steps = ctx.attached.length + adds.length > MAX_FIREWALLS ? [...removes, ...adds] : [...adds, ...removes];
  const done: Step[] = [];
  for (const step of steps) {
    try {
      await step.run();
      done.push(step);
    } catch (error) {
      const failure = failureText(ctx.api, error, step.what);
      // attach() may have created or rewritten a firewall it then could not apply; repair deletes one nothing uses.
      if (!done.length) failAction(`${failure}. Nothing was attached or taken off.`);
      for (const back of done.reverse()) {
        try { await back.undo(); } catch (undoError) {
          failAction(`${failure}. Putting back what the change had done failed too (${failureText(ctx.api, undoError, back.what)}); attached to this server now: ${[...attached].join(", ") || "nothing"}.`);
        }
      }
      failAction(`${failure}. What the change had already done was put back.`);
    }
  }
  // Kept until every step held, so a failure could put them back; repair deletes any this misses.
  for (const firewall of removed) await deleteIfUnused(ctx.api, firewall.id).catch(() => false);
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
  /** What the operator typed, checked here as well as in the page when the review asks for it. */
  typed?: unknown,
): Promise<{ review: HetznerReview } | { notice: string }> {
  const paths = pathsOf(options);
  return withHetznerLock(paths, async () => {
    const ctx = await context(options);
    const title = HETZNER_ROLES[role].title;
    const on = ctx.cloudflare[role];
    const stale = ctx.open[role];
    if (enabled && on && stale) {
      // Left by a change that failed half way; with the Cloudflare one attached it only lets everyone else in.
      try { await detach(ctx, stale); } catch (error) {
        if (error instanceof ActionFailure) throw error;
        hetznerFailure(ctx.api, error, `detach ${stale.name}`);
      }
      return { notice: `${title} is on; ${stale.name} was still attached and is now off.` };
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
    if (plan.after.length > MAX_FIREWALLS) {
      failAction(`Refused: Hetzner allows at most ${MAX_FIREWALLS} firewalls on a server, and this change would leave ${plan.after.length}: ${plan.after.map((firewall) => firewall.name).join(", ")}. Detach one of your own in Hetzner Console first.`);
    }
    const review = enabled
      ? await enableReview(role, planning, plan, list!.ranges, paths, options, WORDS)
      : disableReview(role, planning, plan, list?.ranges ?? null, paths, options, WORDS);
    if (confirm !== review.digest) return { review };
    if (review.typed && (typeof typed !== "string" || typed.trim() !== review.typed)) {
      failAction(`Type the server's name, ${review.typed}, to confirm`);
    }
    await apply(ctx, role, enabled, plan, list);
    if (enabled) writeSync(paths, { rangesHash: list!.hash });
    remember(paths, { web: plan.cloudflare.has("web"), panel: plan.cloudflare.has("panel") }, (options.now ?? Date.now)());
    if (!enabled) return { notice: `${title} is off.` };
    const stillOpen = describeOpenings(openToOthers(role, ctx.others.map(guardOf), list!.ranges));
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
    let rewritten = 0, reopened = 0, newer = 0, deleted = 0, stale = 0;
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
        // An open firewall beside its role's Cloudflare one, left by a change that failed half way, only lets everyone else in.
        for (const role of ROLES) {
          const open = owned(firewalls, role, "open").find((firewall) => attached.has(firewall.id));
          if (!on(role) || !open) continue;
          await api.remove(open.id, serverId).catch((error) => {
            if (!(error instanceof HetznerError && error.code === "firewall_already_removed")) throw error;
          });
          await deleteIfUnused(api, open.id);
          stale++;
        }
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
      stale ? `${count(stale, "Hetzner firewall{s}")} open to anyone taken off beside a Cloudflare one` : "",
      newer ? `${newer} Hetzner firewall${newer === 1 ? " follows" : "s follow"} a newer Cloudflare list from another server` : "",
    ].filter(Boolean);
    return lines.join("; ") || null;
  });
}

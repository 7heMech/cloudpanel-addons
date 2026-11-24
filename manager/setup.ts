// The Setup checklist, as root reads it: what the enabled addons need fixed
// now, each enabled addon's steps checked against the server, a disabled
// addon's steps offered with Enable, and what each administrator skipped or hid.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { ADDONS, addonEnabled, offeredAddonNames } from "../addons/catalog";
import { detectAddresses } from "../addons/dns/addresses";
import { parsePolicy, parseSecrets } from "../addons/dns/model";
import { SETUP_LEVELS, type ActionNeeded, type ActionNeededCheck, type SetupCheck, type SetupLevel, type SetupStep } from "../lib/addon-definition";
import { writeFileAtomic } from "../lib/atomic-write";
import { errorMessage } from "../lib/errors";
import { withFileLockSync } from "../lib/file-lock";
import { panelCustomDomainCertificate } from "../lib/panel-custom-domain";
import { withPanelDb } from "../lib/panel-db";
import { addonStateDir, CONFIG_DIR, PANEL_DB } from "../lib/paths";
import { readState } from "../lib/root-state";
import { panelUserUid } from "../lib/sso-auth";

const PREFS_FILE = `${addonStateDir("manager")}/setup.json`;
/** The checks' last answer, before anyone's skips, so moving between pages does not run them all again. */
const CACHE_FILE = `${addonStateDir("manager")}/setup-checks.json`;
export const CACHE_MS = 60_000;
/** Root's switch for Setup as a whole: while it exists, nothing is checked and no page shows Setup. */
export const SETUP_OFF_FILE = `${CONFIG_DIR}/setup-off`;
/** How long one check may take before it reads as not checked; the others go on without it. */
export const CHECK_LIMIT_MS = 10_000;

export interface SetupItem {
  id: string;
  level: SetupLevel;
  title: string;
  href: string;
  why?: string;
  /** Declared prerequisite step ids, preserved even after prerequisites complete so path ordering stays stable. */
  requires?: string[];
  /** The addon the step belongs to, offered with Enable while it is off and the step not done; null for one about CloudPanel itself. */
  addon: { name: string; title: string; enabled: boolean } | null;
  state: SetupCheck["state"] | "skipped" | "blocked";
  reason: string;
  /** The check's own reason before prerequisites overrode it with "Needs ... first". */
  ownReason?: string;
  /** Unmet prerequisite steps when state is `blocked`. */
  blockedBy?: { id: string; title: string }[];
}

export interface ActionItem extends ActionNeeded {
  id: string;
  addon: { name: string; title: string } | null;
}

/** Local server facts that let /addons/setup render guided inline flows without calling external APIs. */
export interface SetupContext {
  customDomain: { name: string; issued: boolean } | null;
  /** External HTTPS hostname detected on the current request when no CloudPanel custom domain exists, such as a Cloudflare Tunnel. */
  proxyHost?: string | null;
  dnsConnected: boolean;
  dnsAutomatic: boolean;
  dnsPanelHost: string | null;
  dnsZones: string[];
  serverIps: { ipv4: string | null; ipv6: string | null };
}

export interface SetupView {
  /** Root switched Setup off; nothing was checked. */
  off: boolean;
  hidden: boolean;
  actions: ActionItem[];
  steps: SetupItem[];
  context?: SetupContext;
  /** Enabled addon names on this server, used to mark inactive addons in cross-addon Guides. */
  enabledAddons?: string[];
  /** Step ids this administrator skipped, so request-time unblocking still honors skips. */
  skippedIds?: string[];
}

interface UserPrefs { hidden?: true; skipped?: string[] }
type Prefs = Record<string, UserPrefs>;

/** CloudPanel's own Remote Backups, which no addon sets up. */
export function remoteBackupsCheck(config: Record<string, string>): SetupCheck {
  const enabled = ["1", "true"].includes((config.remote_backup_enabled ?? "").trim().toLowerCase());
  const provider = (config.remote_backup_storage_provider ?? "").trim();
  if (enabled && provider) return { state: "done", reason: `On, to ${provider}` };
  return { state: "todo", reason: provider ? "Set up but switched off" : "Sites are backed up on this server only" };
}

function panelConfig(panelDb: string): Record<string, string> {
  return withPanelDb(panelDb, (db) => Object.fromEntries(
    db.query<{ key: string; value: unknown }, []>("SELECT key, value FROM config WHERE key LIKE 'remote_backup_%'").all()
      .map((row) => [row.key, String(row.value ?? "")]),
  ));
}

export const CORE_SETUP: SetupStep[] = [
  {
    id: "remote-backups",
    level: "sites",
    title: "Remote backups",
    href: "/admin/remote-backup",
    why: "Stores scheduled site backups off this server so a disk or host failure does not lose data.",
    check: (options) => remoteBackupsCheck(panelConfig(String(options?.panelDb ?? PANEL_DB))),
  },
];

function readSetupContext(): SetupContext {
  const customDomain = panelCustomDomainCertificate([0, panelUserUid() ?? 0]) ?? null;
  let dnsConnected = false;
  let dnsAutomatic = false;
  let dnsPanelHost: string | null = null;
  let dnsZones: string[] = [];
  let overrideIpv4 = "";
  let overrideIpv6 = "";
  try {
    const dir = addonStateDir("dns");
    const raw = readState<unknown>(`${dir}/policy.json`, 0, () => null);
    if (raw !== null) {
      const policy = parsePolicy(raw);
      const secrets = parseSecrets(readState(`${dir}/secrets.json`, 0, () => ({})));
      const status = readState<{ connections?: { zoneNames?: string[] }[] }>(`${dir}/status.json`, 0, () => ({}));
      dnsConnected = policy.connections.some((connection) => Boolean(secrets.cloudflare[connection.id]));
      dnsAutomatic = policy.automatic;
      dnsPanelHost = policy.panelHost;
      overrideIpv4 = policy.server.ipv4.trim();
      overrideIpv6 = policy.server.ipv6.trim();
      dnsZones = [...new Set((status.connections ?? []).flatMap((connection) => connection.zoneNames ?? []))].sort();
    }
  } catch { /* DNS state unreadable or not initialized */ }
  let detected: { ipv4: string | null; ipv6: string | null } = { ipv4: null, ipv6: null };
  try { detected = detectAddresses(); } catch { /* best-effort */ }
  const serverIps = { ipv4: overrideIpv4 || detected.ipv4, ipv6: overrideIpv6 || detected.ipv6 };
  return { customDomain, dnsConnected, dnsAutomatic, dnsPanelHost, dnsZones, serverIps };
}

/** A check's answer, or why there is none: it threw, or it outlasted the limit. */
async function within<T>(run: () => T | Promise<T>, limitMs: number): Promise<{ value: T } | { error: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<{ error: string }>((resolve) => {
    timer = setTimeout(() => resolve({ error: `took longer than ${Math.round(limitMs / 1000)} seconds` }), limitMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(run).then((value) => ({ value }), (error) => ({ error: errorMessage(error) })), late]);
  } finally {
    clearTimeout(timer);
  }
}

interface SetupSource {
  /** Each addon's steps and Action needed checks, in catalog order, and whether it is on. */
  addons: { name: string; title: string; enabled: boolean; steps: SetupStep[]; actions?: ActionNeededCheck[] }[];
  core: SetupStep[];
}

/** Leaves out an addon this box's architecture cannot run, unless it is enabled already. */
function catalogSource(arch: string = process.arch): SetupSource {
  const offered = offeredAddonNames(arch);
  return {
    addons: offered.flatMap((name) => {
      const spec = ADDONS[name]!;
      if (!spec.setup?.length && !spec.actionNeeded?.length) return [];
      return [{ name, title: spec.title, enabled: addonEnabled(spec), steps: spec.setup ?? [], actions: spec.actionNeeded ?? [] }];
    }),
    core: CORE_SETUP,
  };
}

/**
 * What the enabled addons need fixed now. A check that fails or outlasts the
 * limit raises nothing: Action needed is for what is known to be wrong.
 */
export async function actionItems(source: SetupSource = catalogSource(), options: Record<string, unknown> = {}, limitMs = CHECK_LIMIT_MS): Promise<ActionItem[]> {
  const found = await Promise.all(source.addons.filter((addon) => addon.enabled).flatMap((addon) => (addon.actions ?? []).map(async (action) => {
    const result = await within(() => action.check(options), limitMs);
    if ("error" in result) return [];
    return result.value.map((found, index): ActionItem => ({
      ...typeof found === "string"
        ? { title: action.title ?? "Action needed", reason: found, href: action.href ?? `/addons/${addon.name}/` }
        : found,
      id: index ? `${action.id}-${index}` : action.id, addon: { name: addon.name, title: addon.title },
    }));
  })));
  return found.flat();
}

/**
 * Orders steps within a single path so any step whose prerequisites live in the
 * same path sits right below its last same-path prerequisite (keeping catalog
 * order among peers). Keeps causal branches contiguous both while locked and
 * after unlocking.
 */
export function orderPathSteps(steps: SetupItem[]): SetupItem[] {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const children = new Map<string, SetupItem[]>();
  const roots: SetupItem[] = [];
  for (const step of steps) {
    const reqIds = (step.requires ?? step.blockedBy?.map((req) => req.id) ?? [])
      .filter((id) => byId.has(id) && id !== step.id);
    const parentId = reqIds.length ? reqIds[reqIds.length - 1]! : null;
    if (parentId) {
      const list = children.get(parentId) ?? [];
      list.push(step);
      children.set(parentId, list);
    } else {
      roots.push(step);
    }
  }
  const ordered: SetupItem[] = [];
  const visited = new Set<string>();
  const visit = (step: SetupItem) => {
    if (visited.has(step.id)) return;
    visited.add(step.id);
    ordered.push(step);
    for (const child of children.get(step.id) ?? []) visit(child);
  };
  for (const root of roots) visit(root);
  for (const step of steps) visit(step);
  return ordered;
}

/** Every step, by path: CloudPanel's own first, then the addons' in catalog order, with same-path dependents placed under their prerequisite. */
export async function setupSteps(
  prefs: UserPrefs,
  source: SetupSource = catalogSource(),
  options: Record<string, unknown> = {},
  limitMs = CHECK_LIMIT_MS,
): Promise<SetupItem[]> {
  const skipped = new Set(prefs.skipped ?? []);
  const entries = [
    ...source.core.map((step) => ({ step, addon: null })),
    ...source.addons.flatMap((addon) => addon.steps.map((step) => ({ step, addon }))),
  ];
  const raw = await Promise.all(entries.map(async ({ step, addon }): Promise<{ item: SetupItem; step: SetupStep } | null> => {
    const off: SetupCheck | null = addon && !addon.enabled ? { state: "todo", reason: `${addon.title} is off` } : null;
    const checked = async (): Promise<SetupCheck> => {
      const result = await within(() => step.check(options), limitMs);
      return "error" in result ? { state: "todo", reason: `Could not be checked: ${result.error}` } : result.value;
    };
    const found = off && !step.whileOff ? off : await checked();
    const result = off && found.state === "todo" ? off : found;
    if (step.hostSpecific && result.state === "na") return null;
    const item: SetupItem = {
      id: step.id, level: step.level, title: step.title, href: result.href ?? step.href,
      ...(step.why ? { why: step.why } : {}),
      ...(step.requires?.length ? { requires: step.requires } : {}),
      addon: addon && { name: addon.name, title: addon.title, enabled: addon.enabled },
      state: result.state === "todo" && skipped.has(step.id) ? "skipped" : result.state,
      reason: result.reason,
    };
    return { item, step };
  }));
  const present = raw.filter((entry): entry is { item: SetupItem; step: SetupStep } => entry !== null);
  const byId = new Map(present.map((entry) => [entry.item.id, entry.item]));
  const items = present.map(({ item, step }): SetupItem => {
    if (!step.requires?.length || item.state === "done") return item;
    const unmet = step.requires
      .map((reqId) => byId.get(reqId))
      .filter((req): req is SetupItem => Boolean(req && req.state !== "done"));
    if (!unmet.length) return item;
    return {
      ...item,
      state: "blocked",
      ownReason: item.reason,
      blockedBy: unmet.map((req) => ({ id: req.id, title: req.title })),
      reason: `Needs ${unmet.map((req) => req.title).join(" and ")} first`,
    };
  });
  const order = Object.keys(SETUP_LEVELS) as SetupLevel[];
  return order.flatMap((level) => orderPathSteps(items.filter((item) => item.level === level)));
}

export function readSetupPrefs(file = PREFS_FILE): Prefs {
  try {
    const stored: unknown = JSON.parse(readFileSync(file, "utf-8"));
    return stored && typeof stored === "object" && !Array.isArray(stored) ? stored as Prefs : {};
  } catch {
    return {};
  }
}

export function setupOff(file = SETUP_OFF_FILE): boolean {
  return existsSync(file);
}

/** `clp-addons setup on|off`: whether it changed anything. */
export function switchSetup(on: boolean, file = SETUP_OFF_FILE): boolean {
  if (on !== setupOff(file)) return false;
  if (on) rmSync(file, { force: true });
  else writeFileAtomic(file, "Setup is off; clp-addons setup on turns it back on.\n", { mode: 0o644, createParent: true });
  return true;
}

const CACHE_VERSION = 2;
interface Checked { v?: number; at: number; actions: ActionItem[]; steps: SetupItem[]; context?: SetupContext; enabledAddons?: string[] }

/**
 * The checks' answer, from the cache while it is under a minute old unless
 * `fresh`: opening Setup asks fresh, so what it lists then is current.
 */
export async function cachedChecks(
  compute: () => Promise<Omit<Checked, "at" | "v">>,
  cache: { file?: string; now?: number; fresh?: boolean } = {},
): Promise<Omit<Checked, "at" | "v">> {
  const file = cache.file ?? CACHE_FILE;
  const now = cache.now ?? Date.now();
  if (!cache.fresh) {
    try {
      const stored = JSON.parse(readFileSync(file, "utf-8")) as Checked;
      if (stored.v === CACHE_VERSION && now - stored.at >= 0 && now - stored.at < CACHE_MS && Array.isArray(stored.actions) && Array.isArray(stored.steps)) {
        return {
          actions: stored.actions,
          steps: stored.steps,
          ...(stored.context ? { context: stored.context } : {}),
          ...(Array.isArray(stored.enabledAddons) ? { enabledAddons: stored.enabledAddons } : {}),
        };
      }
    } catch { /* none yet, or unreadable: check again */ }
  }
  const checked = await compute();
  try {
    writeFileAtomic(file, `${JSON.stringify({ v: CACHE_VERSION, at: now, ...checked })}\n`, { mode: 0o600, createParent: true });
  } catch { /* the answer stands without a cache */ }
  return checked;
}

export async function setupView(
  user: string,
  file = PREFS_FILE,
  source?: SetupSource,
  options?: Record<string, unknown>,
  offFile = SETUP_OFF_FILE,
  cache: { file?: string; now?: number; fresh?: boolean } = {},
): Promise<SetupView> {
  const prefs = readSetupPrefs(file)[user] ?? {};
  const hidden = prefs.hidden === true;
  if (setupOff(offFile)) return { off: true, hidden, actions: [], steps: [] };
  const compute = async () => {
    const [actions, steps] = await Promise.all([actionItems(source, options), setupSteps({}, source, options)]);
    const enabled = source
      ? undefined
      : Object.values(ADDONS).filter((spec) => addonEnabled(spec)).map((spec) => spec.name);
    return {
      actions,
      steps,
      ...(!source ? { context: readSetupContext() } : {}),
      ...(enabled ? { enabledAddons: enabled } : {}),
    };
  };
  // A source given in place of the catalog is a test's, which the shared cache must not answer for.
  const checked = source ? await compute() : await cachedChecks(compute, cache);
  const skipped = new Set(prefs.skipped ?? []);
  const steps = checked.steps.map((step) => step.state === "todo" && skipped.has(step.id) ? { ...step, state: "skipped" as const } : step);
  return {
    off: false, hidden, actions: checked.actions, steps,
    ...(checked.context ? { context: checked.context } : {}),
    ...(checked.enabledAddons ? { enabledAddons: checked.enabledAddons } : {}),
    ...(skipped.size ? { skippedIds: [...skipped].sort() } : {}),
  };
}

const FQDN_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/**
 * Extracts a standard-port HTTPS hostname from a request arriving through an
 * external tunnel or reverse proxy (such as Cloudflare Tunnel). Direct access
 * on port 8443, IP literals, localhost and plain HTTP return null.
 */
export function proxyHostFromRequest(req: Request): string | null {
  const rawHost = (req.headers.get("x-forwarded-host") || req.headers.get("host") || "").split(",")[0]!.trim().toLowerCase();
  if (!rawHost || rawHost.includes(":") || rawHost === "localhost" || /^\d+(?:\.\d+){3}$/.test(rawHost) || !FQDN_RE.test(rawHost)) {
    return null;
  }
  const proto = (req.headers.get("x-forwarded-proto") || "").split(",")[0]!.trim().toLowerCase();
  const cfVisitor = req.headers.get("cf-visitor") || "";
  const isHttps = proto === "https" || cfVisitor.includes('"https"') || Boolean(req.headers.get("cf-ray"));
  return isHttps ? rawHost : null;
}

/**
 * When CloudPanel has no built-in Custom Domain but the administrator reached
 * the panel over a trusted HTTPS hostname through a tunnel or reverse proxy,
 * mark Panel hostname done, unblock Passkeys (keeping its own reason), and keep
 * Panel gate open with a proxy-specific reminder to confirm port 8443 is closed.
 */
export function applyRequestOrigin(view: SetupView, proxyHost: string | null): SetupView {
  if (view.off || !proxyHost || view.context?.customDomain) return view;
  const skipped = new Set(view.skippedIds ?? []);
  const context: SetupContext = view.context
    ? { ...view.context, proxyHost }
    : { customDomain: null, proxyHost, dnsConnected: false, dnsAutomatic: false, dnsPanelHost: null, dnsZones: [], serverIps: { ipv4: null, ipv6: null } };
  const steps = view.steps.map((step): SetupItem => {
    if (step.id === "panel-hostname" && step.state !== "done") {
      return { ...step, state: "done", blockedBy: undefined, ownReason: undefined, reason: `CloudPanel answers at ${proxyHost} via a reverse proxy or tunnel` };
    }
    if (step.id === "panel-gate" && step.state !== "done") {
      return {
        ...step,
        state: skipped.has(step.id) ? "skipped" : "todo",
        blockedBy: undefined,
        ownReason: undefined,
        reason: `Reached via ${proxyHost}; confirm direct port 8443 is blocked and ${proxyHost} is protected at your proxy or tunnel`,
      };
    }
    if (step.state === "blocked" && step.blockedBy?.some((req) => req.id === "panel-hostname")) {
      const remaining = step.blockedBy.filter((req) => req.id !== "panel-hostname");
      if (remaining.length) {
        return { ...step, blockedBy: remaining, reason: `Needs ${remaining.map((req) => req.title).join(" and ")} first` };
      }
      const fallbackPasskeyReason = step.addon && !step.addon.enabled
        ? `${step.addon.title} is off`
        : "No administrator has a security key yet";
      const restored = step.ownReason;
      const reason = step.id === "passkeys"
        ? (restored && !restored.toLowerCase().includes("panel hostname") ? restored : fallbackPasskeyReason)
        : (restored ?? step.reason);
      return { ...step, state: skipped.has(step.id) ? "skipped" : "todo", blockedBy: undefined, ownReason: undefined, reason };
    }
    return step;
  });
  return { ...view, steps, context };
}

export type SetupChange = { skip: string } | { unskip: string } | { hidden: boolean };

export function changeSetupPrefs(user: string, change: SetupChange, file = PREFS_FILE): void {
  withFileLockSync(`${file}.lock`, 5, "another Setup change is being saved", () => {
    const prefs = readSetupPrefs(file);
    const mine: UserPrefs = { ...prefs[user] };
    const skipped = new Set(mine.skipped ?? []);
    if ("skip" in change) skipped.add(change.skip);
    else if ("unskip" in change) skipped.delete(change.unskip);
    else if (change.hidden) mine.hidden = true;
    else delete mine.hidden;
    if (skipped.size) mine.skipped = [...skipped].sort();
    else delete mine.skipped;
    if (Object.keys(mine).length) prefs[user] = mine;
    else delete prefs[user];
    writeFileAtomic(file, `${JSON.stringify(prefs)}\n`, { mode: 0o600, createParent: true });
  });
}

/** Every step id an addon or CloudPanel declares, so a skip names a real one. */
export function setupStepIds(source: SetupSource = catalogSource()): string[] {
  return [...source.core, ...source.addons.flatMap((addon) => addon.steps)].map((step) => step.id);
}

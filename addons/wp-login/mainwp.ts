import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { writeFileAtomic } from "../../lib/atomic-write";
import { runWp, wpReply, type WpOptions, type WpSite } from "./wp-cli";
import PHP from "./mainwp.php" with { type: "text" };

export type MainwpStatus = "missing" | "not-connected" | "connected" | "unsupported" | "error";
interface Snapshot {
  options: Record<string, string>; meta: Record<string, string | null>; admin: number;
  active: boolean; tables: string[]; cron: Record<string, unknown>; uploads?: boolean;
}
interface Connection { id: number; key: string }
export interface MainwpRecord {
  status: MainwpStatus; seen: boolean; checkedAt: string; error: string;
  ownedPlugin: boolean; ownedConnection: boolean;
  snapshot?: Snapshot; token?: string; connection?: Connection; phase?: "install" | "connect" | "cleanup"; orphanKey?: string;
}
interface Retired { domain: string; connection: Connection }
export interface MainwpState {
  enabled: boolean; dashboard: string; excluded: string[]; cleanup: boolean;
  sites: Record<string, MainwpRecord>; retired: Retired[];
}
export interface MainwpView {
  enabled: boolean; dashboard: string; excluded: string[]; cleanup: boolean;
  sites: Record<string, Pick<MainwpRecord, "status" | "seen" | "checkedAt" | "error" | "ownedPlugin" | "ownedConnection">>;
  owned: number;
}
export interface MainwpRun {
  statePath: string; runuser: string; sites: WpSite[]; domains: Set<string>;
  domain?: string; dueOnly?: boolean;
}
interface ChildStatus {
  multisite: boolean; installed: boolean; active: boolean; key: string; securityId: string; admin: string; snapshot: Snapshot;
}
export interface MainwpResult { checked: number; connected: number; removed: number; pending: number; failed: string[] }
const emptyResult = (): MainwpResult => ({ checked: 0, connected: 0, removed: 0, pending: 0, failed: [] });
export const emptyMainwpState = (): MainwpState => ({ enabled: false, dashboard: "", excluded: [], cleanup: false, sites: {}, retired: [] });
const STATUSES: MainwpStatus[] = ["missing", "not-connected", "connected", "unsupported", "error"];
const keyValid = (value: unknown): value is string => typeof value === "string" && (!value || /^[a-f0-9]{64}$/.test(value));
const connectionValid = (value: Connection | undefined) => value && Number.isSafeInteger(value.id) && value.id > 0 && keyValid(value.key) && Boolean(value.key);
export function readMainwpState(path: string): MainwpState {
  if (!existsSync(path)) return emptyMainwpState();
  const state = JSON.parse(readFileSync(path, "utf8")) as MainwpState;
  if (!state || typeof state.enabled !== "boolean" || typeof state.dashboard !== "string" || typeof state.cleanup !== "boolean"
    || !Array.isArray(state.excluded) || !state.excluded.every((entry) => typeof entry === "string")
    || !state.sites || typeof state.sites !== "object" || Array.isArray(state.sites) || !Array.isArray(state.retired)) throw new Error("the MainWP settings are invalid");
  for (const record of Object.values(state.sites)) {
    if (!record || !STATUSES.includes(record.status) || typeof record.seen !== "boolean" || typeof record.checkedAt !== "string" || typeof record.error !== "string"
      || typeof record.ownedPlugin !== "boolean" || typeof record.ownedConnection !== "boolean"
      || (record.orphanKey !== undefined && !keyValid(record.orphanKey))
      || (record.token !== undefined && !/^[a-f0-9]{64}$/.test(record.token))
      || (record.phase !== undefined && !["install", "connect", "cleanup"].includes(record.phase))
      || (record.connection !== undefined && !connectionValid(record.connection))
      || ((record.ownedPlugin || record.ownedConnection || record.phase) && !validSnapshot(record.snapshot))) throw new Error("the MainWP site record is invalid");
  }
  if (!state.retired.every((entry) => typeof entry.domain === "string" && connectionValid(entry.connection))) throw new Error("the MainWP cleanup record is invalid");
  return state;
}
function validSnapshot(value: Snapshot | undefined): value is Snapshot {
  return Boolean(value && Number.isSafeInteger(value.admin) && value.admin > 0 && typeof value.active === "boolean"
    && value.options && typeof value.options === "object" 
    && Object.values(value.options).every((entry) => typeof entry === "string")
    && value.meta && typeof value.meta === "object" 
    && Object.values(value.meta).every((entry) => entry === null || typeof entry === "string")
    && Array.isArray(value.tables) && value.tables.every((entry) => typeof entry === "string") && value.cron && typeof value.cron === "object");
}
export function saveMainwpState(path: string, state: MainwpState): void {
  writeFileAtomic(path, JSON.stringify(state) + "\n", { mode: 0o600, createParent: true });
}
export function mainwpView(state: MainwpState): MainwpView {
  return { enabled: state.enabled, dashboard: state.dashboard, excluded: state.excluded, cleanup: state.cleanup,
    owned: Object.values(state.sites).filter((r) => r.snapshot).length + state.retired.length,
    sites: Object.fromEntries(Object.entries(state.sites).map(([domain, r]) => [domain, {
      status: r.status, seen: r.seen, checkedAt: r.checkedAt, error: r.error, ownedPlugin: r.ownedPlugin, ownedConnection: r.ownedConnection,
    }])) };
}
function prune(state: MainwpState, domains: Set<string>): void {
  state.excluded = state.excluded.filter((domain) => domains.has(domain));
  for (const [domain, record] of Object.entries(state.sites)) if (!domains.has(domain)) {
    if (record.ownedConnection && record.connection) state.retired.push({ domain, connection: record.connection });
    delete state.sites[domain];
  }
}
async function bridge<T>(run: MainwpRun, site: WpSite, options: WpOptions, deadline: number, input: Record<string, unknown>): Promise<T> {
  const reply = wpReply<T & { error?: string }>(await runWp(run, site, ["eval", PHP.replace(/^<\?php\s*/, "")], options, deadline, input), "CLP-ADDONS-MAINWP:");
  if (!reply || typeof reply !== "object" || reply.error) throw new Error(`MainWP ${input.op} failed. Check the plugin, administrator, HTTPS and existing connection in WordPress.`);
  return reply;
}
async function child(run: MainwpRun, site: WpSite, options: WpOptions, deadline: number): Promise<ChildStatus> {
  const data = await bridge<ChildStatus>(run, site, options, deadline, { op: "status" });
  if (typeof data.multisite !== "boolean" || typeof data.installed !== "boolean" || typeof data.active !== "boolean" || !keyValid(data.key)
    || typeof data.securityId !== "string" || typeof data.admin !== "string") throw new Error("MainWP returned an invalid child status");
  return data;
}
function recordNow(previous?: MainwpRecord): MainwpRecord {
  return { status: "error", seen: false, ownedPlugin: false, ownedConnection: false, ...previous, checkedAt: new Date().toISOString(), error: "" };
}
function paired(status: ChildStatus, connection?: Connection | null): connection is Connection {
  return Boolean(status.installed && status.active && status.key && connection && status.key === connection.key);
}
function recoverOwnership(record: MainwpRecord, status: ChildStatus, connection?: Connection | null): void {
  if (record.snapshot && connection && ((record.token && record.token === status.securityId && paired(status, connection)) || (record.orphanKey && record.orphanKey === connection.key))) {
    record.ownedConnection = true;
    record.connection = connection!;
  }
}
export async function configureMainwp(run: MainwpRun, options: WpOptions, enabled: boolean, dashboard?: string): Promise<MainwpView> {
  const state = readMainwpState(run.statePath);
  prune(state, run.domains);
  if (state.cleanup && enabled) throw new Error("finish MainWP cleanup before enabling automation");
  if (dashboard !== undefined && dashboard !== state.dashboard) {
    if (Object.values(state.sites).some((r) => r.snapshot) || state.retired.length) throw new Error("clean up the managed MainWP connections before changing Dashboard");
    const site = run.sites.find((entry) => entry.domain === dashboard);
    if (!site) throw new Error("choose a WordPress Dashboard on this server");
    await bridge(run, site, options, Date.now() + 30_000, { op: "dashboard-status", domains: [] });
    state.dashboard = dashboard;
    for (const record of Object.values(state.sites)) {
      if (record.status !== "unsupported") record.status = "not-connected";
      record.checkedAt = ""; record.error = "";
    }
  }
  if (enabled && !run.sites.some((entry) => entry.domain === state.dashboard)) throw new Error("choose a WordPress Dashboard on this server");
  state.enabled = enabled;
  saveMainwpState(run.statePath, state);
  return mainwpView(state);
}
export async function syncMainwp(run: MainwpRun, options: WpOptions = {}, cleanup = false): Promise<MainwpResult> {
  const state = readMainwpState(run.statePath);
  const result = emptyResult();
  if (run.dueOnly && !state.enabled && !state.cleanup && !state.retired.length && !Object.values(state.sites).some((r) => r.phase)) return result;
  prune(state, run.domains);
  if (cleanup) { state.enabled = false; state.cleanup = true; }
  saveMainwpState(run.statePath, state);
  const candidates = run.sites.filter((s) => s.domain !== state.dashboard && (state.cleanup || state.sites[s.domain]?.phase || !state.excluded.includes(s.domain)) && (!run.domain || s.domain === run.domain));
  if (run.domain && (candidates.length !== 1 || state.excluded.includes(run.domain))) throw new Error("that site is excluded or is not an eligible WordPress child");
  const due = candidates.filter((s) => state.cleanup ? Boolean(state.sites[s.domain]?.snapshot)
    : !run.dueOnly || Boolean(state.sites[s.domain]?.phase) || (state.enabled && !state.sites[s.domain]?.seen && state.sites[s.domain]?.status !== "unsupported"));
  if (!due.length && !state.retired.length) {
    if (state.cleanup) state.cleanup = false;
    saveMainwpState(run.statePath, state);
    return result;
  }
  const selected = due.sort((a, b) => (state.sites[a.domain]?.checkedAt ?? "").localeCompare(state.sites[b.domain]?.checkedAt ?? "")).slice(0, 64);
  result.pending = due.length - selected.length;
  const deadline = Date.now() + (run.dueOnly ? 25_000 : 90_000);
  const dashboard = run.sites.find((s) => s.domain === state.dashboard);
  let connections: Record<string, Connection | null> = {};
  let dashboardError = "";
  try {
    if (!dashboard) throw new Error("the selected MainWP Dashboard is unavailable");
    connections = (await bridge<{ sites: Record<string, Connection | null> }>(run, dashboard, options, deadline,
      { op: "dashboard-status", domains: selected.map((s) => s.domain) })).sites;
    if (!connections || typeof connections !== "object" || !Object.values(connections).every((v) => v === null || connectionValid(v))) throw new Error("MainWP returned invalid Dashboard records");
  } catch (error) { dashboardError = error instanceof Error ? error.message : "the Dashboard check failed"; }
  for (const site of selected) {
    if (Date.now() > deadline - 1_000) { result.pending++; continue; }
    const record = recordNow(state.sites[site.domain]);
    state.sites[site.domain] = record;
    try {
      if (record.snapshot && record.phase) {
        await bridge(run, site, options, deadline, { op: "restore-auth", snapshot: record.snapshot, deactivate: true });
      }
      let status = await child(run, site, options, deadline);
      if (status.multisite) { record.status = "unsupported"; continue; }
      const connection = connections[site.domain];
      recoverOwnership(record, status, connection);
      if (state.cleanup) {
        if (!record.snapshot) continue;
        record.phase = "cleanup";
        saveMainwpState(run.statePath, state);
        if (record.token === status.securityId && status.key) { record.orphanKey = status.key; saveMainwpState(run.statePath, state); }
        const key = record.connection?.key || record.orphanKey || "";
        await bridge(run, site, options, deadline, { op: "cleanup", snapshot: record.snapshot, key, removePlugin: record.ownedPlugin });
        if (record.ownedConnection && record.connection) {
          if (dashboardError) throw new Error(dashboardError);
          await bridge(run, dashboard!, options, deadline, { op: "dashboard-remove", url: `https://${site.domain}`, id: record.connection.id, key: record.connection.key });
        } else if (dashboardError && record.orphanKey) throw new Error(dashboardError);
        record.status = record.ownedPlugin ? "missing" : "not-connected";
        delete record.snapshot; delete record.token; delete record.connection; delete record.phase; delete record.orphanKey;
        record.ownedPlugin = false; record.ownedConnection = false;
        result.removed++;
        continue;
      }
      if (dashboardError) throw new Error(dashboardError);
      if (paired(status, connection)) {
        if (record.phase && record.ownedConnection) result.connected++;
        record.status = "connected"; record.seen = true;
        delete record.token; delete record.phase;
        continue;
      }
      record.status = status.installed ? "not-connected" : "missing";
      if (record.phase && !run.domain) {
        delete record.phase;
        record.status = "error"; record.error = "Enrollment interrupted. Retry to continue.";
        continue;
      }
      const seenBefore = record.seen;
      if (status.installed) record.seen = true;
      if (!run.domain && (status.installed || seenBefore || !state.enabled)) continue;
      if (run.domain && record.snapshot && record.token === status.securityId && status.key && !connection) {
        await bridge(run, site, options, deadline, { op: "cleanup", snapshot: record.snapshot, key: status.key, removePlugin: false });
        status = await child(run, site, options, deadline);
      }
      if (status.key || connection) throw new Error("An existing MainWP connection or Dashboard record needs attention in MainWP before this site can be connected.");
      if (!status.admin || !validSnapshot(status.snapshot)) throw new Error("the site has no administrator available for MainWP");
      if (!record.snapshot) {
        record.snapshot = status.snapshot;
        record.ownedPlugin = !status.installed;
        record.token = randomBytes(32).toString("hex");
      }
      record.seen = true; record.phase = status.installed ? "connect" : "install";
      saveMainwpState(run.statePath, state);
      try {
        if (!status.installed) await runWp(run, site, ["plugin", "install", "mainwp-child"], options, deadline, {});
        record.phase = "connect"; saveMainwpState(run.statePath, state);
        await bridge(run, site, options, deadline, { op: "prepare", token: record.token, snapshot: record.snapshot });
        await bridge(run, dashboard!, options, deadline, { op: "dashboard-add", domain: site.domain, url: `https://${site.domain}`, admin: status.admin, token: record.token });
        const after = await child(run, site, options, deadline);
        const fresh = (await bridge<{ sites: Record<string, Connection | null> }>(run, dashboard!, options, deadline, { op: "dashboard-status", domains: [site.domain] })).sites[site.domain];
        if (fresh && !connectionValid(fresh)) throw new Error("MainWP returned an invalid Dashboard record");
        recoverOwnership(record, after, fresh);
        if (!record.ownedConnection) throw new Error("MainWP did not verify the new connection; Retry to check it again");
        record.status = "connected";
        result.connected++;
      } finally {
        await bridge(run, site, options, Date.now() + 10_000, { op: "restore-auth", snapshot: record.snapshot, deactivate: true });
        if (record.status === "connected") { delete record.phase; delete record.token; }
      }
    } catch (error) {
      record.status = "error";
      record.error = (error instanceof Error ? error.message : "MainWP failed").replace(/[\x00-\x1f\x7f-\x9f]+/g, " ").slice(0, 500);
      result.failed.push(`${site.domain}: ${record.error}`);
    } finally { result.checked++; saveMainwpState(run.statePath, state); }
  }
  for (const entry of [...state.retired]) {
    if (Date.now() > deadline - 1_000) { result.pending++; continue; }
    try {
      if (dashboardError) throw new Error(dashboardError);
      await bridge(run, dashboard!, options, deadline, { op: "dashboard-remove", url: `https://${entry.domain}`, id: entry.connection.id, key: entry.connection.key });
      state.retired = state.retired.filter((r) => r !== entry);
    } catch { result.failed.push(`${entry.domain}: Dashboard cleanup pending`); }
  }
  if (state.cleanup && !Object.values(state.sites).some((r) => r.snapshot) && !state.retired.length) state.cleanup = false;
  saveMainwpState(run.statePath, state);
  return result;
}

export function requireMainwpClean(path: string): void {
  if (!existsSync(path)) return;
  const state = readMainwpState(path);
  if (state.cleanup || state.retired.length || Object.values(state.sites).some((r) => r.snapshot)) {
    throw new Error("MainWP cleanup is required before removing WordPress Tools. Use Turn off and clean up, or clp-addons action wp-login mainwp-cleanup --confirm=mainwp, and retry until verified.");
  }
  state.enabled = false;
  saveMainwpState(path, state);
}
export async function mainwpAction(run: MainwpRun, argv: string[], options: WpOptions, validate: (domain: string) => string): Promise<unknown> {
  const [verb, ...rest] = argv;
  const allowed: Record<string, string[]> = {
    "mainwp-settings": ["enabled", "dashboard"], "mainwp-site": ["domain", "excluded"],
    "mainwp-sync": [], "mainwp-connect": ["domain", "confirm"], "mainwp-cleanup": ["confirm"],
  };
  if (!verb || !allowed[verb]) throw new Error("unknown MainWP action");
  const fields: Record<string, string> = {};
  for (const arg of rest) {
    const match = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (!match || !allowed[verb]!.includes(match[1]!) || fields[match[1]!] !== undefined) throw new Error("invalid MainWP arguments");
    fields[match[1]!] = match[2]!;
  }
  if (verb === "mainwp-settings") {
    if (!["true", "false"].includes(fields.enabled ?? "")) throw new Error("enabled must be true or false");
    return { mainwp: await configureMainwp(run, options, fields.enabled === "true", fields.dashboard === undefined ? undefined : validate(fields.dashboard)) };
  }
  if (verb === "mainwp-sync") return syncMainwp(run, options);
  if (verb === "mainwp-cleanup") {
    if (fields.confirm !== "mainwp") throw new Error("MainWP cleanup must be confirmed");
    return syncMainwp(run, options, true);
  }
  const domain = validate(fields.domain ?? "");
  if (verb === "mainwp-connect") {
    if (readMainwpState(run.statePath).cleanup) throw new Error("finish MainWP cleanup before connecting a site");
    if (fields.confirm !== domain) throw new Error("MainWP connection must be confirmed for this site");
    return syncMainwp({ ...run, domain }, options);
  }
  if (!["true", "false"].includes(fields.excluded ?? "")) throw new Error("excluded must be true or false");
  if (!run.sites.some((site) => site.domain === domain) || domain === readMainwpState(run.statePath).dashboard) throw new Error("that is not an eligible WordPress child");
  const state = readMainwpState(run.statePath);
  prune(state, run.domains);
  state.excluded = state.excluded.filter((entry) => entry !== domain);
  if (fields.excluded === "true") state.excluded.push(domain);
  saveMainwpState(run.statePath, state);
  return { mainwp: mainwpView(state) };
}

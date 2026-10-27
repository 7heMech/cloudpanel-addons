// MainWP Child enrollment: keep each WordPress site connected to one MainWP
// Dashboard on this server, or, for a Dashboard on another server, only install
// the Child; and withdraw only what that added.

import { existsSync, readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { writeFileAtomic } from "../../lib/atomic-write";
import { leastRecentlyChecked, pruneFleet } from "./fleet";
import { runWp, wpReply, type WpOptions, type WpSite } from "./wp-cli";
import PHP from "./mainwp.php" with { type: "text" };
import GUARD from "./mainwp-guard.php" with { type: "text" };

/** Where the guard lives in a site, which withdrawing the addon removes without WordPress. */
export const MAINWP_GUARD_FILE = "wp-content/mu-plugins/clp-addons-mainwp.php";
const GUARD_HASH = createHash("sha256").update(GUARD).digest("hex");

export type MainwpStatus = "missing" | "inactive" | "waiting-https" | "not-connected" | "connected" | "unsupported" | "error";
const STATUSES: MainwpStatus[] = ["missing", "inactive", "waiting-https", "not-connected", "connected", "unsupported", "error"];

/** A child's MainWP settings from before the addon changed them; cleanup puts them back. */
interface Snapshot {
  options: Record<string, string>;
  meta: Record<string, string | null>;
  admin: number;
  active: boolean;
  tables: string[];
  cron: Record<string, unknown>;
  uploads: boolean;
}

/** A Dashboard site record, and a fingerprint of the public key it shares with the child. */
interface Connection {
  id: number;
  key: string;
}

export interface MainwpRecord {
  status: MainwpStatus;
  /** Once a Child has been observed, automation never installs it again. */
  seen: boolean;
  checkedAt: string;
  error: string;
  ownedPlugin: boolean;
  ownedConnection: boolean;
  /** Kept while the addon owns anything on the site. */
  snapshot?: Snapshot;
  /** The Security ID of an enrollment that is not verified yet. */
  token?: string;
  connection?: Connection;
  /**
   * `restored` keeps connection recovery pending after authentication is safe;
   * `child` is a Child-only install, which changes no authentication.
   */
  phase?: "install" | "connect" | "restored" | "cleanup" | "child";
  /** The Dashboard record an enrollment is reconnecting, which stays the operator's. */
  reconnect?: number;
  /** The site has the guard, which a pass removes once nothing enforces the connection. */
  guard?: boolean;
}

export interface MainwpState {
  enabled: boolean;
  dashboard: string;
  /** The Dashboard is on another server: install the Child only, and connect from there. */
  remote?: boolean;
  cleanup: boolean;
  sites: Record<string, MainwpRecord>;
  /** Owned Dashboard records of sites the panel no longer has. */
  retired: { domain: string; connection: Connection }[];
}

export type MainwpSiteView = Pick<MainwpRecord, "status" | "seen" | "checkedAt" | "error" | "ownedConnection">;

/** What the page gets: no snapshots, Security IDs or keys. */
export interface MainwpView {
  enabled: boolean;
  dashboard: string;
  remote: boolean;
  cleanup: boolean;
  sites: Record<string, MainwpSiteView>;
  /** Sites and Dashboard records cleanup would withdraw. */
  owned: number;
  /** Dashboard records among them, which tie the addon to its Dashboard. */
  connections: number;
}

/** One pass: every site, only those automation can still act on, or the sites an operator chose. */
export interface MainwpRun {
  statePath: string;
  runuser: string;
  sites: WpSite[];
  /** Every domain the panel has; state for any other is dropped. */
  domains: Set<string>;
  domain?: string;
  /** Only these sites. */
  targets?: string[];
  /** The operator chose `targets` to connect, as `domain` is for one site. */
  connect?: boolean;
  dueOnly?: boolean;
  /** When the pass stops starting sites; a background job sets a long one. */
  deadline?: number;
}

export interface MainwpResult {
  checked: number;
  /** Child plugins installed or activated for a Dashboard on another server. */
  installed: number;
  connected: number;
  removed: number;
  pending: number;
  failed: string[];
}

interface ChildStatus {
  multisite: boolean;
  /** Listed by WordPress, as opposed to `files`, which is only the directory. */
  installed: boolean;
  files: boolean;
  active: boolean;
  key: string;
  securityId: string;
  admin: string;
  /** A digest of every MainWP setting, to tell whether a failed attempt changed any. */
  fingerprint: string;
  /** A digest of the guard file, or empty without one. */
  guard: string;
}

interface Pass {
  run: MainwpRun;
  options: WpOptions;
  /** When the pass stops starting sites; an enrollment it started gets ENROLL_MS. */
  deadline: number;
  state: MainwpState;
  result: MainwpResult;
  dashboard?: WpSite;
  /** The Dashboard's record for each selected domain, or null where it has none. */
  connections: Record<string, Connection | null>;
  dashboardError: string;
  recoveryFailed: Set<string>;
}

/** How many sites one pass asks the Dashboard about, which bounds its reply. */
const BATCH = 64;
/** Stopping part-way leaves a connection to Retry, so a started enrollment runs to the end. */
const ENROLL_MS = 60_000;
const HEX64 = /^[a-f0-9]{64}$/;
/** WordPress's own strict rule for logins; the Dashboard stores and sends this one. */
const LOGIN = /^[A-Za-z0-9 _.@-]{1,60}$/;
const MARKER = "CLP-ADDONS-MAINWP:";
const ADAPTER = PHP.replace(/^<\?php\s*/, "");

// The adapter answers with one of these codes. A site's own code can print a
// reply too, so its text is never repeated: an unknown code gets a fixed message.
const FAILURES: Record<string, string> = {
  "admin-changed": "the site's first administrator changed during the connection; check again",
  "already-connected": "MainWP Child is already connected to a Dashboard; disconnect it in MainWP first",
  "guard-failed": "the MainWP guard could not be written into the site's mu-plugins folder",
  "constant-id": "wp-config.php sets MAINWP_CHILD_UNIQUEID; connect this site from MainWP instead",
  "activation-failed": "MainWP Child could not be activated; check the site in WordPress",
  "auth-not-restored": "the temporary MainWP connection setting could not be restored; check again",
  "connection-changed": "the site's MainWP connection changed; check again",
  "cleanup-incomplete": "MainWP Child settings could not all be restored; check the site in WordPress",
  "delete-failed": "MainWP Child could not be deleted; check the site in WordPress",
  "dashboard-unavailable": "MainWP is not active on the Dashboard site, or it has no administrator",
  "record-exists": "the Dashboard already has a record for this site; remove or reconnect it in MainWP",
  "connect-failed": "the Dashboard could not connect; check the site's HTTPS, firewall and security plugins",
  "dashboard-cleanup-incomplete": "the Dashboard record could not be removed completely; check MainWP",
};

export const emptyMainwpState = (): MainwpState => ({
  enabled: false, dashboard: "", cleanup: false, sites: {}, retired: [],
});
const emptyResult = (): MainwpResult => ({ checked: 0, installed: 0, connected: 0, removed: 0, pending: 0, failed: [] });

function isConnection(value: unknown): value is Connection {
  const connection = value as Connection | null;
  return Boolean(connection) && Number.isSafeInteger(connection!.id) && connection!.id > 0
    && typeof connection!.key === "string" && HEX64.test(connection!.key);
}

function isStringMap(value: unknown, nullable = false): boolean {
  // PHP encodes an empty associative array as [].
  if (Array.isArray(value)) return value.length === 0;
  return Boolean(value) && typeof value === "object"
    && Object.values(value as object).every((entry) => typeof entry === "string" || (nullable && entry === null));
}

function isSnapshot(value: unknown): value is Snapshot {
  const snapshot = value as Snapshot | undefined;
  return Boolean(snapshot) && Number.isSafeInteger(snapshot!.admin) && snapshot!.admin > 0
    && typeof snapshot!.active === "boolean" && typeof snapshot!.uploads === "boolean"
    && isStringMap(snapshot!.options) && isStringMap(snapshot!.meta, true)
    && Array.isArray(snapshot!.tables) && snapshot!.tables.every((table) => typeof table === "string")
    && Boolean(snapshot!.cron) && typeof snapshot!.cron === "object";
}

function isRecord(value: unknown): value is MainwpRecord {
  const record = value as MainwpRecord | undefined;
  if (!record || !STATUSES.includes(record.status) || typeof record.seen !== "boolean"
    || typeof record.checkedAt !== "string" || typeof record.error !== "string"
    || typeof record.ownedPlugin !== "boolean" || typeof record.ownedConnection !== "boolean") return false;
  if (record.token !== undefined && !HEX64.test(record.token)) return false;
  if (record.connection !== undefined && !isConnection(record.connection)) return false;
  if (record.phase !== undefined && !["install", "connect", "restored", "cleanup", "child"].includes(record.phase)) return false;
  if (record.reconnect !== undefined && !(Number.isSafeInteger(record.reconnect) && record.reconnect > 0)) return false;
  if (record.guard !== undefined && typeof record.guard !== "boolean") return false;
  const owns = record.ownedPlugin || record.ownedConnection || record.phase !== undefined;
  return record.snapshot === undefined ? !owns : isSnapshot(record.snapshot);
}

export function readMainwpState(path: string): MainwpState {
  if (!existsSync(path)) return emptyMainwpState();
  const state = JSON.parse(readFileSync(path, "utf8")) as MainwpState & { excluded?: unknown };
  if (!state || typeof state.enabled !== "boolean" || typeof state.dashboard !== "string" || typeof state.cleanup !== "boolean"
    || (state.remote !== undefined && typeof state.remote !== "boolean")
    || !state.sites || typeof state.sites !== "object" || Array.isArray(state.sites) || !Array.isArray(state.retired)) {
    throw new Error("the MainWP settings are invalid");
  }
  if (!Object.values(state.sites).every(isRecord)) throw new Error("the MainWP site record is invalid");
  if (!state.retired.every((entry) => typeof entry?.domain === "string" && isConnection(entry.connection))) {
    throw new Error("the MainWP cleanup record is invalid");
  }
  // Automation works for a Dashboard, here or on another server, so without one it is off.
  if (!state.dashboard && !state.remote) state.enabled = false;
  // Sites can no longer be excluded; the next save drops an old list.
  delete state.excluded;
  return state;
}

export function saveMainwpState(path: string, state: MainwpState): void {
  writeFileAtomic(path, `${JSON.stringify(state)}\n`, { mode: 0o600, createParent: true });
}

function ownedCount(state: MainwpState): number {
  return Object.values(state.sites).filter((record) => record.snapshot).length + state.retired.length;
}

/**
 * Dashboard records the addon made, or may have made: an enrollment it never
 * confirmed keeps its Security ID until the Dashboard says either way. A Child
 * it only installed belongs to no Dashboard.
 */
function ownedConnections(state: MainwpState): number {
  return Object.values(state.sites).filter((record) => record.ownedConnection || record.token).length + state.retired.length;
}

/** Whether the repair timer has anything to do, so that it skips site discovery otherwise. */
export function mainwpNeedsRepair(state: MainwpState): boolean {
  return state.enabled || state.cleanup || state.retired.length > 0
    || Object.values(state.sites).some((record) => record.phase || record.guard);
}

/** Automation with a Dashboard on this server keeps every site connected to it. */
function enforcing(state: MainwpState): boolean {
  return state.enabled && !state.remote && !state.cleanup && Boolean(state.dashboard);
}

export function mainwpView(state: MainwpState): MainwpView {
  const sites = Object.fromEntries(Object.entries(state.sites).map(([domain, record]) => [domain, {
    status: record.status, seen: record.seen, checkedAt: record.checkedAt, error: record.error, ownedConnection: record.ownedConnection,
  }]));
  return {
    enabled: state.enabled, dashboard: state.dashboard, remote: state.remote === true, cleanup: state.cleanup, sites,
    owned: ownedCount(state), connections: ownedConnections(state),
  };
}

/** Deleted sites' owned Dashboard records are retired; a deleted Dashboard took its records with it. */
function prune(state: MainwpState, domains: Set<string>): void {
  for (const [domain, record] of Object.entries(pruneFleet(state, domains))) {
    if (record.ownedConnection && record.connection) state.retired.push({ domain, connection: record.connection });
  }
  if (state.dashboard && !domains.has(state.dashboard)) {
    state.dashboard = "";
    state.enabled = false;
    state.retired = [];
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function bridge<T>(
  pass: { run: MainwpRun; options: WpOptions; deadline: number },
  site: WpSite,
  input: { op: string } & Record<string, unknown>,
  deadline = pass.deadline,
): Promise<T> {
  const reply = wpReply<T & { error?: unknown }>(await runWp(pass.run, site, ["eval", ADAPTER], pass.options, deadline, input), MARKER);
  if (!reply || typeof reply !== "object") throw new Error("WP-CLI returned no status; check that the site loads in WordPress");
  if (reply.error !== undefined) throw new Error(FAILURES[String(reply.error)] ?? `MainWP ${input.op} failed; check the site in WordPress`);
  return reply;
}

async function childStatus(pass: Pass, site: WpSite): Promise<ChildStatus> {
  const status = await bridge<ChildStatus>(pass, site, { op: "status" });
  const flags = [status.multisite, status.installed, status.files, status.active];
  if (!flags.every((flag) => typeof flag === "boolean") || typeof status.key !== "string" || (status.key && !HEX64.test(status.key))
    || typeof status.securityId !== "string" || typeof status.admin !== "string" || typeof status.fingerprint !== "string"
    || typeof status.guard !== "string") {
    throw new Error("MainWP returned an invalid child status");
  }
  return status;
}

async function dashboardRecords(pass: Pass, domains: string[]): Promise<Record<string, Connection | null>> {
  const reply = await bridge<{ sites?: Record<string, unknown> }>(pass, pass.dashboard!, { op: "dashboard-status", domains });
  const records: Record<string, Connection | null> = {};
  for (const domain of domains) {
    const record = reply.sites?.[domain];
    if (record !== null && !isConnection(record)) throw new Error("MainWP returned an invalid Dashboard record");
    records[domain] = record;
  }
  return records;
}

/** The Dashboard fetches the child as registration will: HTTPS, a valid certificate, no redirects. */
async function httpsReady(pass: Pass, site: WpSite): Promise<boolean> {
  const deadline = Math.min(pass.deadline, Date.now() + 8_000);
  const reply = await bridge<{ ready?: unknown }>(pass, pass.dashboard!, { op: "dashboard-ready", url: `https://${site.domain}` }, deadline);
  if (typeof reply.ready !== "boolean") throw new Error("MainWP returned an invalid HTTPS check");
  return reply.ready;
}

/** Enrollment finalization gets its own deadline; recovery uses the pass's remainder. */
async function restoreAuth(pass: Pass, site: WpSite, record: MainwpRecord, deadline = Date.now() + 10_000): Promise<void> {
  await bridge(pass, site, { op: "restore-auth", snapshot: record.snapshot }, deadline);
}

function needsAuthRecovery(record: MainwpRecord | undefined): boolean {
  return record?.phase === "install" || record?.phase === "connect";
}

async function recoverAuthentication(pass: Pass, sites: WpSite[]): Promise<void> {
  for (const site of sites) {
    const record = pass.state.sites[site.domain];
    if (!record || !needsAuthRecovery(record)) continue;
    if (Date.now() > pass.deadline - 1_000) break;
    try {
      await restoreAuth(pass, site, record, Math.min(pass.deadline, Date.now() + 10_000));
      record.phase = "restored";
    } catch (error) {
      record.status = "error";
      record.error = message(error);
      record.checkedAt = new Date().toISOString();
      pass.result.failed.push(`${site.domain}: ${record.error}`);
      pass.result.checked++;
      pass.recoveryFailed.add(site.domain);
    }
    saveMainwpState(pass.run.statePath, pass.state);
  }
}

function paired(status: ChildStatus, connection: Connection | null): connection is Connection {
  return status.active && Boolean(status.key) && connection?.key === status.key;
}

/** Whether this is the connection the record's own Security ID created. */
function enrolledBy(record: MainwpRecord, status: ChildStatus, connection: Connection | null): connection is Connection {
  return Boolean(record.snapshot && record.token) && record.token === status.securityId && paired(status, connection);
}

function forget(record: MainwpRecord): void {
  for (const field of ["snapshot", "token", "connection", "phase", "reconnect"] as const) delete record[field];
  record.ownedPlugin = false;
  record.ownedConnection = false;
}

async function startPass(run: MainwpRun, options: WpOptions, state: MainwpState, selected: WpSite[]): Promise<Pass> {
  // Keep periodic passes short; Check now has time to refresh the whole fleet.
  const deadline = run.deadline ?? Date.now() + (run.dueOnly ? 25_000 : 90_000);
  const pass: Pass = { run, options, deadline, state, result: emptyResult(), connections: {}, dashboardError: "", recoveryFailed: new Set() };
  await recoverAuthentication(pass, selected);
  if (state.remote) return pass;
  if (!state.dashboard) {
    // A deleted Dashboard leaves nothing there to remove, so cleanup carries on.
    if (!state.cleanup) pass.dashboardError = "choose a MainWP Dashboard first";
    return pass;
  }
  pass.dashboard = run.sites.find((site) => site.domain === state.dashboard);
  try {
    if (!pass.dashboard) throw new Error(`the MainWP Dashboard ${state.dashboard} is not a WordPress site the addon can use`);
    pass.connections = await dashboardRecords(pass, selected.map((site) => site.domain));
  } catch (error) {
    pass.dashboardError = message(error);
  }
  return pass;
}

/** Whether an operator asked for these sites, which lets a pass connect them. */
function explicit(run: MainwpRun): boolean {
  return Boolean(run.domain || run.connect);
}

function dueSites(run: MainwpRun, state: MainwpState): WpSite[] {
  const wanted = run.targets ? new Set(run.targets) : run.domain ? new Set([run.domain]) : null;
  const sites = run.sites.filter((site) => site.domain !== state.dashboard && (!wanted || wanted.has(site.domain)));
  if (run.domain && sites.length !== 1) throw new Error("that is not a WordPress site MainWP can manage");
  return sites.filter((site) => {
    const record = state.sites[site.domain];
    if (state.cleanup) return Boolean(record?.snapshot || record?.guard);
    // Even with automation off, an interrupted change's setting is restored.
    if (record?.phase) return true;
    if (!run.dueOnly) return true;
    if (enforcing(state)) return record?.status !== "unsupported";
    return Boolean(record?.guard) || (state.enabled && !record?.seen && record?.status !== "unsupported");
  });
}

export async function syncMainwp(run: MainwpRun, options: WpOptions = {}, cleanup = false): Promise<MainwpResult> {
  const state = readMainwpState(run.statePath);
  prune(state, run.domains);
  if (cleanup) {
    state.enabled = false;
    state.cleanup = true;
  }
  saveMainwpState(run.statePath, state);
  const due = leastRecentlyChecked(dueSites(run, state), state.sites);
  let result = emptyResult();
  if (due.length || state.retired.length) {
    const interrupted = due.filter((site) => needsAuthRecovery(state.sites[site.domain]));
    const other = due.filter((site) => !needsAuthRecovery(state.sites[site.domain]));
    const selected = [...interrupted, ...other].slice(0, BATCH);
    const pass = await startPass(run, options, state, selected);
    result = pass.result;
    result.pending = due.length - selected.length;
    for (const [index, site] of selected.entries()) {
      options.onProgress?.({ completed: index, total: selected.length, site: site.domain });
      await visit(pass, site);
    }
    await retire(pass);
  }
  if (state.cleanup && ownedCount(state) === 0) state.cleanup = false;
  saveMainwpState(run.statePath, state);
  return result;
}

/**
 * A background job's run: every due site, least recently checked first, in
 * passes of one Dashboard query's worth each.
 */
export async function syncMainwpAll(run: MainwpRun, options: WpOptions = {}, cleanup = false): Promise<MainwpResult> {
  const state = readMainwpState(run.statePath);
  prune(state, run.domains);
  if (cleanup) state.cleanup = true;
  else if (run.connect && state.cleanup) throw new Error("finish MainWP cleanup before connecting a site");
  const due = leastRecentlyChecked(dueSites(run, state), state.sites).map((site) => site.domain);
  const result = emptyResult();
  const known = new Set(run.sites.map((site) => site.domain));
  for (const domain of run.targets ?? []) {
    if (!known.has(domain) || domain === state.dashboard) result.failed.push(`${domain}: that is not a WordPress site MainWP can manage`);
  }
  // One pass even with no site due, which still retires old Dashboard records.
  for (let start = 0; start === 0 || start < due.length; start += BATCH) {
    if (run.deadline !== undefined && Date.now() > run.deadline - 1_000) {
      result.pending += due.length - start;
      break;
    }
    const chunk = due.slice(start, start + BATCH);
    const pass = await syncMainwp({ ...run, targets: chunk }, {
      ...options,
      onProgress: (progress) => options.onProgress?.({ completed: start + progress.completed, total: due.length, site: progress.site }),
    }, cleanup);
    for (const field of ["checked", "installed", "connected", "removed", "pending"] as const) result[field] += pass[field];
    result.failed.push(...pass.failed);
  }
  return result;
}

async function visit(pass: Pass, site: WpSite): Promise<void> {
  if (pass.recoveryFailed.has(site.domain)) return;
  if (Date.now() > pass.deadline - 1_000) {
    pass.result.pending++;
    return;
  }
  const record: MainwpRecord = {
    status: "error", seen: false, ownedPlugin: false, ownedConnection: false,
    ...pass.state.sites[site.domain], checkedAt: new Date().toISOString(), error: "",
  };
  pass.state.sites[site.domain] = record;
  try {
    if (record.snapshot && record.phase === "cleanup") await restoreAuth(pass, site, record);
    // Cleanup restores the child without the Dashboard; only its record there waits.
    if (pass.dashboardError && !pass.state.cleanup) throw new Error(pass.dashboardError);
    const status = await childStatus(pass, site);
    if (!enforcing(pass.state)) {
      // Withdrawing the addon removes guards without WordPress, so one may be gone already.
      if (status.guard) await setGuard(pass, site, record, false);
      else delete record.guard;
    }
    if (pass.state.cleanup) await cleanupSite(pass, site, record, status);
    else if (status.multisite) record.status = "unsupported";
    else if (pass.state.remote) await checkChildOnly(pass, site, record, status);
    else await checkSite(pass, site, record, status);
    if (enforcing(pass.state) && record.status === "connected" && status.guard !== GUARD_HASH) await setGuard(pass, site, record, true);
  } catch (error) {
    record.status = "error";
    record.error = message(error);
    pass.result.failed.push(`${site.domain}: ${record.error}`);
  } finally {
    pass.result.checked++;
    saveMainwpState(pass.run.statePath, pass.state);
  }
}

/**
 * Records what the site has, then connects it if automation or an explicit
 * Connect asks for that. Automation keeps every site connected, so it also
 * resumes an interrupted enrollment and puts back a Child someone removed.
 */
async function checkSite(pass: Pass, site: WpSite, record: MainwpRecord, status: ChildStatus): Promise<void> {
  const connection = pass.connections[site.domain] ?? null;
  if (enrolledBy(record, status, connection)) {
    // An enrollment interrupted after registration.
    if (record.phase) pass.result.connected++;
    adopt(record, connection);
  }
  if (paired(status, connection)) {
    record.status = "connected";
    record.seen = true;
    delete record.token;
    delete record.phase;
    return;
  }
  record.status = status.installed ? "not-connected" : "missing";
  const asked = explicit(pass.run);
  if (record.phase && !asked && !pass.state.enabled) {
    delete record.phase;
    throw new Error("Enrollment was interrupted. Retry to continue.");
  }
  if (status.installed) record.seen = true;
  if (asked || pass.state.enabled) await enroll(pass, site, record, status, connection);
}

/**
 * A connection the addon registered is its own. One it reconnected was the
 * operator's record and stays theirs, with nothing for cleanup to withdraw.
 */
function adopt(record: MainwpRecord, connection: Connection): void {
  const operators = record.reconnect === connection.id && !(record.ownedConnection && record.connection?.id === connection.id);
  delete record.reconnect;
  if (operators) {
    forget(record);
    return;
  }
  record.ownedConnection = true;
  record.connection = connection;
}

/**
 * Connects the site to this Dashboard, taking it from any other Dashboard the
 * Child is connected to. A record this Dashboard already has is reconnected.
 */
async function enroll(pass: Pass, site: WpSite, record: MainwpRecord, status: ChildStatus, connection: Connection | null): Promise<void> {
  if (status.key && !connection && record.token && record.token === status.securityId) {
    // Its own registration that the Dashboard never recorded: undo it and start again.
    await bridge(pass, site, { op: "cleanup", snapshot: record.snapshot, key: status.key, removePlugin: false });
    status = await childStatus(pass, site);
  }
  if (!LOGIN.test(status.admin)) throw new Error("the site has no administrator whose login MainWP can use");
  if (!await httpsReady(pass, site)) {
    record.status = "waiting-https";
    return;
  }
  const enrollment: Pass = { ...pass, deadline: Math.max(pass.deadline, Date.now() + ENROLL_MS) };
  const before = structuredClone(record);
  await takeSnapshot(enrollment, site, record, status);
  record.token ??= randomBytes(32).toString("hex");
  record.seen = true;
  if (connection) record.reconnect = connection.id;
  else delete record.reconnect;
  record.phase = status.installed ? "connect" : "install";
  saveMainwpState(pass.run.statePath, pass.state);
  try {
    await connect(enrollment, site, record, status);
  } catch (error) {
    // Only an attempt that verifiably changed nothing gives up its claim, so
    // that a new site is tried again like a failed Varnish download.
    if (await untouched(enrollment, site, status)) {
      forget(record);
      Object.assign(record, before);
    }
    throw error;
  }
}

async function connect(pass: Pass, site: WpSite, record: MainwpRecord, status: ChildStatus): Promise<void> {
  let fresh: Connection;
  try {
    if (!status.installed) await downloadChild(pass, site, status);
    record.phase = "connect";
    saveMainwpState(pass.run.statePath, pass.state);
    await bridge(pass, site, { op: "prepare", token: record.token, admin: record.snapshot!.admin });
    const url = `https://${site.domain}`;
    await bridge(pass, pass.dashboard!, record.reconnect
      ? { op: "dashboard-reconnect", id: record.reconnect, url, admin: status.admin, token: record.token }
      : { op: "dashboard-add", url, name: site.domain, admin: status.admin, token: record.token });
    const after = await childStatus(pass, site);
    fresh = (await dashboardRecords(pass, [site.domain]))[site.domain]!;
    if (!enrolledBy(record, after, fresh)) throw new Error("MainWP did not confirm the new connection; Retry to check it again");
    // A registration is the addon's from here, even if restoring the setting fails.
    if (record.reconnect !== fresh.id) {
      record.ownedConnection = true;
      record.connection = fresh;
    }
    record.status = "connected";
    pass.result.connected++;
  } finally {
    await restoreAuth(pass, site, record);
    // Only a crash before this point leaves the phase for repair to find.
    delete record.phase;
    if (record.status === "connected") delete record.token;
  }
  // After the setting is restored: adopting a reconnected record forgets its snapshot.
  adopt(record, fresh);
}

/**
 * For a Dashboard on another server. Records what the site has; automation
 * installs an absent Child, and an explicit Install or Activate activates it.
 */
async function checkChildOnly(pass: Pass, site: WpSite, record: MainwpRecord, status: ChildStatus): Promise<void> {
  if (status.key) {
    record.status = "connected";
    record.seen = true;
    delete record.phase;
    return;
  }
  record.status = !status.installed ? "missing" : status.active ? "not-connected" : "inactive";
  const asked = explicit(pass.run);
  if (record.phase) {
    delete record.phase;
    if (!asked) throw new Error("Installation was interrupted. Retry to continue.");
  }
  const unseen = !record.seen;
  if (status.installed) record.seen = true;
  if (asked ? !status.active : pass.state.enabled && unseen && !status.installed) {
    await installChild(pass, site, record, status, asked);
  }
}

/**
 * Automation leaves the Child inactive: MainWP Child turns itself off when no
 * Dashboard connects soon after activation, so it is activated only on request,
 * just before the operator adds the site in that Dashboard.
 */
async function installChild(pass: Pass, site: WpSite, record: MainwpRecord, status: ChildStatus, activate: boolean): Promise<void> {
  const before = structuredClone(record);
  await takeSnapshot(pass, site, record, status);
  record.seen = true;
  record.phase = "child";
  saveMainwpState(pass.run.statePath, pass.state);
  try {
    if (!status.installed) await downloadChild(pass, site, status);
    if (activate) await bridge(pass, site, { op: "activate" });
    record.status = activate ? "not-connected" : "inactive";
    pass.result.installed++;
  } catch (error) {
    if (await untouched(pass, site, status)) {
      forget(record);
      Object.assign(record, before);
    }
    throw error;
  } finally {
    delete record.phase;
  }
}

/**
 * Records once what the addon may change: all of MainWP's settings before it
 * installs the Child, otherwise its connection, but never a connection it takes over.
 */
async function takeSnapshot(pass: Pass, site: WpSite, record: MainwpRecord, status: ChildStatus): Promise<void> {
  if (record.snapshot) return;
  const reply = await bridge<{ snapshot?: unknown }>(pass, site, { op: "snapshot", whole: !status.installed, release: Boolean(status.key) });
  if (!isSnapshot(reply.snapshot)) throw new Error("MainWP returned invalid settings");
  record.snapshot = reply.snapshot;
  record.ownedPlugin = !status.installed;
}

async function downloadChild(pass: Pass, site: WpSite, status: ChildStatus): Promise<void> {
  // A directory WordPress does not list is a broken earlier download.
  const force = status.files ? ["--force"] : [];
  await runWp(pass.run, site, ["plugin", "install", "mainwp-child", ...force], pass.options, pass.deadline);
}

async function setGuard(pass: Pass, site: WpSite, record: MainwpRecord, on: boolean): Promise<void> {
  await bridge(pass, site, { op: "guard", code: on ? GUARD : "" });
  if (on) record.guard = true;
  else delete record.guard;
}

/** Whether a failed attempt left the child as it was and a Dashboard on this server without a record. */
async function untouched(pass: Pass, site: WpSite, before: ChildStatus): Promise<boolean> {
  try {
    const after = await childStatus(pass, site);
    const fields = ["installed", "files", "active", "key", "securityId", "fingerprint"] as const;
    if (!fields.every((field) => after[field] === before[field])) return false;
    return pass.state.remote || (await dashboardRecords(pass, [site.domain]))[site.domain] === null;
  } catch {
    return false;
  }
}

/** Withdraws what the addon added to one site, and leaves a connection someone has made since. */
async function cleanupSite(pass: Pass, site: WpSite, record: MainwpRecord, status: ChildStatus): Promise<void> {
  if (!record.snapshot) return;
  // An unconfirmed enrollment may have left a Dashboard record only the
  // Dashboard can name; forgetting its Security ID would orphan that record.
  if (pass.dashboardError && record.token && !record.ownedConnection) throw new Error(pass.dashboardError);
  const connection = pass.connections[site.domain] ?? null;
  if (enrolledBy(record, status, connection)) {
    record.ownedConnection = true;
    record.connection = connection;
  }
  const ours = !status.key || status.key === record.connection?.key || record.token === status.securityId;
  record.phase = "cleanup";
  // Persist removal intent before the child disappears, including across retries.
  if (ours && record.ownedPlugin && status.installed) record.seen = false;
  saveMainwpState(pass.run.statePath, pass.state);
  if (ours) {
    await bridge(pass, site, { op: "cleanup", snapshot: record.snapshot, key: status.key, removePlugin: record.ownedPlugin });
  }
  if (record.ownedConnection && record.connection) {
    if (pass.dashboardError) pass.state.retired.push({ domain: site.domain, connection: record.connection });
    else if (pass.dashboard) await bridge(pass, pass.dashboard, { op: "dashboard-remove", id: record.connection.id, key: record.connection.key });
  }
  // For a Dashboard on another server any key is a connection, and cleanup put back an existing Child's activation.
  if (!ours) record.status = pass.state.remote || paired(status, connection) ? "connected" : "not-connected";
  else if (record.ownedPlugin) record.status = "missing";
  else record.status = pass.state.remote && !record.snapshot.active ? "inactive" : "not-connected";
  forget(record);
  pass.result.removed++;
}

async function retire(pass: Pass): Promise<void> {
  for (const entry of [...pass.state.retired]) {
    if (Date.now() > pass.deadline - 1_000) {
      pass.result.pending++;
      continue;
    }
    try {
      if (pass.dashboardError) throw new Error(pass.dashboardError);
      await bridge(pass, pass.dashboard!, { op: "dashboard-remove", id: entry.connection.id, key: entry.connection.key });
      pass.state.retired = pass.state.retired.filter((other) => other !== entry);
    } catch (error) {
      pass.result.failed.push(`${entry.domain}: ${message(error)}`);
    }
  }
}

export async function configureMainwp(
  run: MainwpRun, options: WpOptions, enabled: boolean, dashboard?: string, remote = false,
): Promise<MainwpView> {
  const state = readMainwpState(run.statePath);
  prune(state, run.domains);
  if (state.cleanup && enabled) throw new Error("finish MainWP cleanup before turning automation on");
  const moving = remote ? !state.remote : dashboard !== undefined && (state.remote || dashboard !== state.dashboard);
  if (moving && ownedConnections(state) > 0) {
    throw new Error("clean up the MainWP connections WordPress Tools made before changing Dashboard");
  }
  if (moving && remote) {
    state.remote = true;
    state.dashboard = "";
  } else if (moving) {
    const site = run.sites.find((entry) => entry.domain === dashboard);
    if (!site) throw new Error("choose a WordPress site on this server as the Dashboard");
    await bridge({ run, options, deadline: Date.now() + 30_000 }, site, { op: "dashboard-status", domains: [] });
    state.remote = false;
    state.dashboard = dashboard!;
    // Those connections were to the previous Dashboard; the next check finds this one's.
    for (const record of Object.values(state.sites)) if (record.status === "connected") record.status = "not-connected";
  }
  if (enabled && !state.remote && !run.sites.some((site) => site.domain === state.dashboard)) throw new Error("choose a MainWP Dashboard first");
  state.enabled = enabled;
  saveMainwpState(run.statePath, state);
  return mainwpView(state);
}

/**
 * Disabling or uninstalling WordPress Tools leaves MainWP connections in place,
 * but not an interrupted enrollment, whose temporary setting only repair restores.
 */
export function requireMainwpSettled(path: string): void {
  if (!existsSync(path)) return;
  let state: MainwpState;
  try {
    state = readMainwpState(path);
  } catch (error) {
    // It is the only record of a site whose temporary setting is still changed.
    throw new Error(`${path} cannot be read (${message(error)}); restore it from a backup and retry. Remove it only after checking each MainWP site's connection settings, since it is the only record of a setting an interrupted connection changed`);
  }
  const sites = Object.values(state.sites);
  if (sites.some(needsAuthRecovery)) {
    throw new Error("a MainWP enrollment was interrupted; run clp-addons repair wp-tools to restore its temporary setting, then retry");
  }
}

const ARGUMENTS: Record<string, string[]> = {
  "mainwp-settings": ["enabled", "dashboard", "remote"],
  "mainwp-sync": [],
  "mainwp-connect": ["domain", "confirm"],
  "mainwp-cleanup": ["confirm"],
};

function parseArguments(verb: string | undefined, argv: string[]): Record<string, string> {
  const allowed = verb ? ARGUMENTS[verb] : undefined;
  if (!allowed) throw new Error("unknown MainWP action");
  const fields: Record<string, string> = {};
  for (const arg of argv) {
    const match = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (!match || !allowed.includes(match[1]!) || fields[match[1]!] !== undefined) throw new Error("invalid MainWP arguments");
    fields[match[1]!] = match[2]!;
  }
  return fields;
}

function parseBoolean(value: string | undefined, name: string): boolean {
  if (value !== "true" && value !== "false") throw new Error(`${name} must be true or false`);
  return value === "true";
}

export async function mainwpAction(run: MainwpRun, argv: string[], options: WpOptions, validate: (domain: string) => string): Promise<unknown> {
  const [verb, ...rest] = argv;
  const fields = parseArguments(verb, rest);
  if (verb === "mainwp-settings") {
    const dashboard = fields.dashboard === undefined ? undefined : validate(fields.dashboard);
    const remote = fields.remote === undefined ? undefined : parseBoolean(fields.remote, "remote");
    if (remote === false || (remote && dashboard !== undefined)) throw new Error("choose either a Dashboard on this server or --remote=true");
    return { mainwp: await configureMainwp(run, options, parseBoolean(fields.enabled, "enabled"), dashboard, remote) };
  }
  if (verb === "mainwp-sync") return syncMainwp(run, options);
  if (verb === "mainwp-cleanup") {
    if (fields.confirm !== "mainwp") throw new Error("MainWP cleanup must be confirmed with --confirm=mainwp");
    return syncMainwp(run, options, true);
  }
  const domain = validate(fields.domain ?? "");
  if (fields.confirm !== domain) throw new Error("confirm the MainWP connection with --confirm=<domain>");
  if (readMainwpState(run.statePath).cleanup) throw new Error("finish MainWP cleanup before connecting a site");
  return syncMainwp({ ...run, domain }, options);
}

/**
 * Shared root-owned Cloudflare API connection store under
 * `/var/lib/clp-addons/cloudflare/`. Both DNS and Firewall read and manage the
 * same connections here so Firewall's Panel gate does not require enabling DNS,
 * and one token can serve both addons without duplicate copies on disk.
 */
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, readFileSync, rmSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { failAction } from "../action";
import { writeFileAtomic } from "../atomic-write";
import { connectionId, secretText } from "../dns-name";
import { errorMessage } from "../errors";
import { withFileLock } from "../file-lock";
import { log } from "../log";
import { addonStateDir, CLOUDFLARE_STATE_DIR, LOCK_DIR, ROOT_UID } from "../paths";
import { type ApiFetch, ProviderError, redact } from "../provider-http";
import { readState, writeState } from "../root-state";
import { isTrustedFile } from "../trusted-file";
import { oneLine } from "../validate";
import {
  accessView, grants, readAccess, selfReadPermission, targetFor, uncertain, type AccessView, type Reached, type TokenAccess,
} from "./access";
import { CloudflareApi, UnreadableToken, type CfAccount, type CfZone, type Verified } from "./api";
import { PERMISSIONS, type PermissionName, type PermissionScopeOptions, type ZoneProfileShape } from "./tokens";

export const MAX_CLOUDFLARE_CONNECTIONS = 12;
const LABEL_MAX = 40;
/**
 * Saving and checking wait this long for another change, then give Cloudflare
 * VERIFY_MS to answer, which together fit the manager's CLOUDFLARE_ACTION_MS.
 */
export const LOCK_WAIT_S = 30;
export const VERIFY_MS = 75_000;
export const CLOUDFLARE_ACTION_MS = 120_000;
const BUSY = "another Cloudflare connection change is running";
const INACTIVE_ZONES = new Set(["moved", "deleted", "deactivated"]);

export interface CloudflareConnection {
  id: string;
  label: string;
}

export interface CloudflareConnectionReport {
  id: string;
  label: string;
  active: boolean;
  status: string;
  accounts: CfAccount[];
  zones: number;
  zoneNames?: string[];
  error: string | null;
  token?: TokenAccess;
  refused?: string[];
}

export interface CloudflareConnectionView {
  id: string;
  label: string;
  active: boolean;
  status: string;
  accounts: CfAccount[];
  zones: number;
  error: string | null;
  hasToken: boolean;
  access: AccessView | null;
}

export interface CloudflareConnectionSecret {
  id: string;
  label: string;
  token: string;
}

export interface CloudflareStorePaths {
  stateDir: string;
  lockFile: string;
  rootUid: number;
}

export const DEFAULT_CLOUDFLARE_STORE_PATHS: CloudflareStorePaths = {
  stateDir: CLOUDFLARE_STATE_DIR,
  lockFile: `${LOCK_DIR}/cloudflare.lock`,
  rootUid: ROOT_UID,
};

interface ConnectionsFile {
  version: 1;
  connections: CloudflareConnection[];
}

interface SecretsFile {
  version: 1;
  tokens: Record<string, string>;
}

interface StatusFile {
  version: 1;
  connections: CloudflareConnectionReport[];
  backoffUntil: number;
}

export interface CloudflareStoreSnapshot {
  connections: CloudflareConnection[];
  tokens: Record<string, string>;
  reports: CloudflareConnectionReport[];
  backoffUntil: number;
}

export interface CloudflareStoreOptions {
  paths?: Partial<CloudflareStorePaths>;
  fetch?: ApiFetch;
  /** Tests only: how long Cloudflare is given to answer. */
  verifyMs?: number;
}

function resolvePaths(paths?: Partial<CloudflareStorePaths>): CloudflareStorePaths {
  return { ...DEFAULT_CLOUDFLARE_STORE_PATHS, ...paths };
}

function filePaths(paths: CloudflareStorePaths) {
  return {
    connections: join(paths.stateDir, "connections.json"),
    secrets: join(paths.stateDir, "secrets.json"),
    status: join(paths.stateDir, "status.json"),
  };
}

function parseConnectionsList(value: unknown): CloudflareConnection[] {
  if (!Array.isArray(value)) return [];
  const out: CloudflareConnection[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const raw = entry as Record<string, unknown>;
    try {
      const id = connectionId(raw.id);
      if (seen.has(id)) continue;
      seen.add(id);
      const label = oneLine(raw.label, "the connection name", LABEL_MAX, true);
      out.push({ id, label });
    } catch { /* skip malformed entry */ }
  }
  return out.slice(0, MAX_CLOUDFLARE_CONNECTIONS);
}

function parseTokensMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const tokens: Record<string, string> = {};
  for (const [id, token] of Object.entries(value as Record<string, unknown>)) {
    if (typeof token !== "string" || !token) continue;
    try { tokens[connectionId(id)] = token; } catch { /* skip malformed id */ }
  }
  return tokens;
}

/** Whether the shared Cloudflare store has been initialized on disk (even if all connections were later removed). */
export function hasSharedCloudflareStore(paths?: Partial<CloudflareStorePaths>): boolean {
  const files = filePaths(resolvePaths(paths));
  return existsSync(files.connections) || existsSync(files.secrets);
}

const DEFAULT_DNS_ZONE_PROFILE: ZoneProfileShape = {
  name: "Web",
  zone: { ssl: "strict", alwaysHttps: true, acmeFullSsl: true, webmailFullSsl: false, skipFirewallIps: [] },
};

/**
 * Reads DNS's zone-option profile shapes for building token templates without
 * importing `addons/dns`. Falls back to DNS's default Web profile when DNS has
 * no saved policy yet so combined "DNS + Panel gate" tokens include Zone
 * Settings and Config Rules edits.
 */
export function readDnsZoneProfiles(options: { dnsDir?: string; rootUid?: number } = {}): ZoneProfileShape[] {
  const dnsDir = options.dnsDir ?? addonStateDir("dns");
  const rootUid = options.rootUid ?? ROOT_UID;
  try {
    const raw = readState<{ profiles?: unknown } | null>(join(dnsDir, "policy.json"), rootUid, () => null);
    if (Array.isArray(raw?.profiles)) {
      const profiles: ZoneProfileShape[] = [];
      for (const entry of raw.profiles) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
        const item = entry as { name?: unknown; zone?: unknown };
        const zone = item.zone && typeof item.zone === "object" && !Array.isArray(item.zone) ? item.zone as Record<string, unknown> : {};
        profiles.push({
          name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : "Profile",
          zone: {
            ssl: zone.ssl ?? null,
            alwaysHttps: zone.alwaysHttps ?? null,
            acmeFullSsl: zone.acmeFullSsl === true,
            webmailFullSsl: zone.webmailFullSsl === true,
            skipFirewallIps: Array.isArray(zone.skipFirewallIps) ? zone.skipFirewallIps.filter((ip): ip is string => typeof ip === "string") : [],
          },
        });
      }
      return profiles;
    }
  } catch { /* fall back to default profile shape */ }
  return [DEFAULT_DNS_ZONE_PROFILE];
}

/** Reads only saved Cloudflare connections metadata (never touches secrets.json). */
export function readCloudflareConnections(paths?: Partial<CloudflareStorePaths>): CloudflareConnection[] {
  const resolved = resolvePaths(paths);
  const connRaw = readState<Partial<ConnectionsFile> | null>(filePaths(resolved).connections, resolved.rootUid, () => null);
  return parseConnectionsList(connRaw?.connections);
}

/** Reads only saved Cloudflare API tokens from secrets.json. */
export function readCloudflareSecrets(paths?: Partial<CloudflareStorePaths>): Record<string, string> {
  const resolved = resolvePaths(paths);
  const secRaw = readState<Partial<SecretsFile> | null>(filePaths(resolved).secrets, resolved.rootUid, () => null);
  return parseTokensMap(secRaw?.tokens);
}

/** Reads only cached Cloudflare check reports and backoff (never touches secrets.json). */
export function readCloudflareStatus(paths?: Partial<CloudflareStorePaths>): { reports: CloudflareConnectionReport[]; backoffUntil: number } {
  const resolved = resolvePaths(paths);
  const statusRaw = readState<Partial<StatusFile> | null>(filePaths(resolved).status, resolved.rootUid, () => null);
  const reports = Array.isArray(statusRaw?.connections)
    ? statusRaw.connections.filter((entry): entry is CloudflareConnectionReport =>
      Boolean(entry) && typeof entry === "object" && typeof entry.id === "string" && Array.isArray(entry.accounts))
    : [];
  const backoffUntil = typeof statusRaw?.backoffUntil === "number" && Number.isFinite(statusRaw.backoffUntil) ? statusRaw.backoffUntil : 0;
  return { reports, backoffUntil };
}

/** Reads the shared Cloudflare store. Never throws on missing files. */
export function readCloudflareStore(paths?: Partial<CloudflareStorePaths>): CloudflareStoreSnapshot {
  const resolved = resolvePaths(paths);
  const connections = readCloudflareConnections(resolved);
  const tokens = readCloudflareSecrets(resolved);
  const { reports, backoffUntil } = readCloudflareStatus(resolved);
  return { connections, tokens, reports, backoffUntil };
}

function writeConnections(paths: CloudflareStorePaths, connections: CloudflareConnection[]): void {
  writeState(filePaths(paths).connections, { version: 1, connections } satisfies ConnectionsFile, paths.rootUid);
}

function writeSecrets(paths: CloudflareStorePaths, tokens: Record<string, string>): void {
  writeState(filePaths(paths).secrets, { version: 1, tokens } satisfies SecretsFile, paths.rootUid);
}

function writeStatus(paths: CloudflareStorePaths, reports: CloudflareConnectionReport[], backoffUntil: number): void {
  writeState(filePaths(paths).status, { version: 1, connections: reports, backoffUntil } satisfies StatusFile, paths.rootUid);
}

/** Runs writes to the store's files, putting every file back as it was when one of them fails. */
function commit(paths: CloudflareStorePaths, write: () => void): void {
  const files = filePaths(paths);
  const before = [files.secrets, files.connections, files.status].map((path) => ({ path, saved: snapshotFile(path, paths.rootUid) }));
  try {
    write();
  } catch (error) {
    for (const { path, saved } of before.reverse()) {
      try {
        if (saved) restoreFile(saved); else rmSync(path, { force: true });
      } catch (restoreError) {
        log.warn(`${path} could not be put back: ${errorMessage(restoreError)}`);
      }
    }
    throw error;
  }
}

/** Cloudflare's answer, or a refusal once `ms` has passed, so a slow Cloudflare cannot outlast the request. */
function withinDeadline<T>(work: Promise<T>, ms: number, timedOut: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => {
      try { resolve(timedOut()); } catch (error) { reject(error); }
    }, ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/** Server-side list of saved Cloudflare connections with their bearer tokens. Never send to the browser. */
export function listCloudflareSecrets(paths?: Partial<CloudflareStorePaths>): CloudflareConnectionSecret[] {
  const { connections, tokens } = readCloudflareStore(paths);
  const list: CloudflareConnectionSecret[] = [];
  for (const connection of connections) {
    const token = tokens[connection.id];
    if (token) list.push({ id: connection.id, label: connection.label, token });
  }
  // Include any token present in secrets without a matching label entry so nothing is silently lost.
  const known = new Set(connections.map((c) => c.id));
  for (const [id, token] of Object.entries(tokens)) {
    if (!known.has(id) && token) list.push({ id, label: id, token });
  }
  return list;
}

/** Browser-safe view of saved Cloudflare connections, with permission evaluation for the calling addon. */
export function cloudflareConnectionViews(
  profiles: ZoneProfileShape[] = [],
  scopeOptions: PermissionScopeOptions = {},
  paths?: Partial<CloudflareStorePaths>,
): {
  connections: CloudflareConnectionView[];
  accounts: { connectionId: string; accountId: string; label: string }[];
  zones: string[];
  backoffUntil: number;
} {
  const store = readCloudflareStore(paths);
  const connections: CloudflareConnectionView[] = store.connections.map((connection) => {
    const stored = store.reports.find((entry) => entry.id === connection.id);
    const { token: _token, refused: _refused, zoneNames: _zoneNames, ...report } = stored ?? {
      id: connection.id, label: connection.label, active: false, status: "unchecked", accounts: [], zones: 0, error: null,
    };
    return {
      ...report,
      label: connection.label,
      hasToken: Boolean(store.tokens[connection.id]),
      access: stored?.active ? accessView(stored, profiles, scopeOptions) : null,
    };
  });
  const accounts = store.reports.flatMap((connection) => connection.accounts.map((account) => ({
    connectionId: connection.id,
    accountId: account.id,
    label: `${account.name || account.id} (${store.connections.find((c) => c.id === connection.id)?.label ?? connection.label})`,
  })));
  const zones = [...new Set(store.reports.flatMap((connection) => connection.zoneNames ?? []))].sort();
  return { connections, accounts, zones, backoffUntil: store.backoffUntil };
}

/** Reads a token's own policies and converts them to TokenAccess. */
export async function readTokenAccess(api: CloudflareApi, verified: Verified, reached: Reached): Promise<TokenAccess> {
  const owner = { owner: verified.owner, accountId: verified.accountId };
  if (!verified.id) return { ...owner, readable: false, reason: "Cloudflare did not say which token this is" };
  try {
    return readAccess(owner, await api.policies(owner, verified.id), reached);
  } catch (error) {
    if (error instanceof ProviderError && (error.status === 401 || error.status === 403)) {
      return { ...owner, readable: false, reason: `Add ${selfReadPermission(owner.owner)} to this token to see its permissions here` };
    }
    const transient = error instanceof ProviderError && !(error instanceof UnreadableToken) && (error.status === 0 || error.status === 429 || error.status >= 500);
    return { ...owner, readable: false, reason: `Its permissions could not be read: ${errorMessage(error)}`, ...(transient ? { transient: true as const } : {}) };
  }
}

/** Verifies one token against Cloudflare and reads its zones, accounts and permissions. */
export async function verifyCloudflareToken(
  id: string,
  label: string,
  token: string,
  options: { fetch?: ApiFetch; backoff?: { until: number }; readTokens?: boolean } = {},
): Promise<{ report: CloudflareConnectionReport; zones: CfZone[]; backoffUntil: number }> {
  const backoff = options.backoff ?? { until: 0 };
  const api = new CloudflareApi(token, options.fetch, backoff);
  const report: CloudflareConnectionReport = { id, label, active: false, status: "missing", accounts: [], zones: 0, error: null };
  try {
    const verified = await api.verify();
    report.status = verified.status;
    if (!verified.active) return { report: { ...report, error: `Cloudflare reports this token as ${verified.status}` }, zones: [], backoffUntil: backoff.until };
    const [zones, accounts] = await Promise.all([api.zones(), api.accounts()]);
    const known = new Map(accounts.map((account) => [account.id, account]));
    for (const zone of zones) if (!known.has(zone.account.id)) known.set(zone.account.id, zone.account);
    const tokenAccess = options.readTokens !== false
      ? await readTokenAccess(api, verified, { zones: zones.map((zone) => ({ id: zone.id, name: zone.name, accountId: zone.account.id })), accounts: [...known.values()] })
      : undefined;
    const zoneNames = [...new Set(zones.filter((zone) => !INACTIVE_ZONES.has(zone.status)).map((zone) => zone.name))].sort();
    return {
      report: { ...report, active: true, accounts: [...known.values()], zones: zones.length, zoneNames, ...(tokenAccess ? { token: tokenAccess } : {}) },
      zones,
      backoffUntil: backoff.until,
    };
  } catch (error) {
    return { report: { ...report, status: "error", error: redact(errorMessage(error), [token]) }, zones: [], backoffUntil: backoff.until };
  }
}

/**
 * Merges fresh connection reports (such as from a DNS pass) into the shared
 * status.json without losing reports from connections the pass did not touch.
 * `checked` holds the token each report was made with; a report for a
 * connection whose token was replaced since is dropped.
 */
export function recordCloudflareReports(
  fresh: CloudflareConnectionReport[],
  backoffUntil: number,
  fullPass: boolean,
  checked: Record<string, string>,
  paths?: Partial<CloudflareStorePaths>,
): Promise<void> {
  const resolved = resolvePaths(paths);
  return withFileLock(resolved.lockFile, LOCK_WAIT_S, BUSY, async () => {
    if (!hasSharedCloudflareStore(resolved)) return;
    const store = readCloudflareStore(resolved);
    const merged = store.connections.flatMap((connection): CloudflareConnectionReport[] => {
      const before = store.reports.find((entry) => entry.id === connection.id);
      const next = fresh.find((entry) => entry.id === connection.id);
      if (!next || checked[connection.id] !== store.tokens[connection.id]) return before ? [before] : [];
      const { token: freshToken, refused: seen, ...rest } = next;
      const stale = !freshToken || (!freshToken.readable && freshToken.transient);
      const token = !next.active ? undefined : stale && before?.token ? before.token : freshToken;
      const refused = [...new Set([...fullPass ? [] : before?.refused ?? [], ...seen ?? []])];
      return [{ ...rest, label: connection.label, ...(token ? { token } : {}), ...(refused.length ? { refused } : {}) }];
    });
    writeStatus(resolved, merged, Math.max(store.backoffUntil, backoffUntil));
  });
}

export async function saveCloudflareConnection(
  body: Record<string, unknown>,
  options: CloudflareStoreOptions = {},
): Promise<{ id: string; label: string; isNew: boolean; report: CloudflareConnectionReport; notice: string }> {
  const resolved = resolvePaths(options.paths);
  return withFileLock(resolved.lockFile, LOCK_WAIT_S, BUSY, async () => {
    const store = readCloudflareStore(resolved);
    const existing = body.id ? store.connections.find((connection) => connection.id === connectionId(body.id)) : undefined;
    if (body.id && !existing) failAction("That connection no longer exists");
    if (!existing && store.connections.length >= MAX_CLOUDFLARE_CONNECTIONS) {
      failAction(`At most ${MAX_CLOUDFLARE_CONNECTIONS} Cloudflare connections can be added`);
    }
    const token = body.token ? secretText(body.token, "The API token") : existing ? store.tokens[existing.id] : undefined;
    if (!token) failAction("Paste the API token Cloudflare showed you");
    if (Object.entries(store.tokens).some(([id, saved]) => saved === token && id !== existing?.id)) {
      failAction("That token is already saved as another connection");
    }

    const id = existing?.id ?? `cf-${randomBytes(4).toString("hex")}`;
    const { report, backoffUntil } = await withinDeadline(
      verifyCloudflareToken(id, "Checking", token, { fetch: options.fetch, backoff: { until: store.backoffUntil }, readTokens: true }),
      options.verifyMs ?? VERIFY_MS,
      () => failAction("Cloudflare did not answer in time; try again in a moment"),
    );
    if (backoffUntil > store.backoffUntil) {
      writeStatus(resolved, store.reports, backoffUntil);
    }
    if (!report.active) {
      failAction(redact(`Cloudflare did not accept this token: ${(report.error ?? report.status).replace(/^Cloudflare: /, "")}`, [token]));
    }
    const named = oneLine(body.label, "the connection name", LABEL_MAX, false);
    const label = named || report.accounts.map((account) => account.name).filter(Boolean).join(", ").slice(0, LABEL_MAX) || "Cloudflare";

    const nextConnections = existing
      ? store.connections.map((connection) => connection.id === id ? { id, label } : connection)
      : [...store.connections, { id, label }];
    const nextTokens = { ...store.tokens, [id]: token };
    const saved: CloudflareConnectionReport = { ...report, id, label };
    const nextReports = nextConnections.flatMap((connection) =>
      connection.id === id ? [saved] : store.reports.filter((entry) => entry.id === connection.id));

    commit(resolved, () => {
      writeSecrets(resolved, nextTokens);
      writeConnections(resolved, nextConnections);
      writeStatus(resolved, nextReports, Math.max(store.backoffUntil, backoffUntil));
    });

    const zones = `${report.zones} zone${report.zones === 1 ? "" : "s"}`;
    const notice = `${label} reaches ${report.accounts.length} account${report.accounts.length === 1 ? "" : "s"} and ${zones}.`;
    return { id, label, isNew: !existing, report: saved, notice };
  });
}

export async function removeCloudflareConnection(
  id: string,
  options: CloudflareStoreOptions = {},
): Promise<{ id: string; label: string; remaining: number; notice: string }> {
  const validId = connectionId(id);
  const resolved = resolvePaths(options.paths);
  return withFileLock(resolved.lockFile, LOCK_WAIT_S, BUSY, async () => {
    const store = readCloudflareStore(resolved);
    const existing = store.connections.find((connection) => connection.id === validId);
    if (!existing) failAction("That connection no longer exists");
    const nextConnections = store.connections.filter((connection) => connection.id !== validId);
    const nextTokens = { ...store.tokens };
    delete nextTokens[validId];
    const nextReports = store.reports.filter((report) => report.id !== validId);
    commit(resolved, () => {
      writeSecrets(resolved, nextTokens);
      writeConnections(resolved, nextConnections);
      writeStatus(resolved, nextReports, store.backoffUntil);
    });
    return {
      id: validId,
      label: existing.label,
      remaining: nextConnections.length,
      notice: "Connection removed. Its token stays valid in Cloudflare until you delete it there.",
    };
  });
}

export async function checkCloudflareConnections(options: CloudflareStoreOptions = {}): Promise<CloudflareConnectionReport[]> {
  const resolved = resolvePaths(options.paths);
  return withFileLock(resolved.lockFile, LOCK_WAIT_S, BUSY, async () => {
    const store = readCloudflareStore(resolved);
    const backoff = { until: store.backoffUntil };
    const reports = await Promise.all(store.connections.map(async (connection): Promise<CloudflareConnectionReport> => {
      const token = store.tokens[connection.id];
      if (!token) {
        return { id: connection.id, label: connection.label, active: false, status: "missing", accounts: [], zones: 0, error: "No token is saved for this connection" };
      }
      const { report } = await withinDeadline(
        verifyCloudflareToken(connection.id, connection.label, token, { fetch: options.fetch, backoff, readTokens: true }),
        options.verifyMs ?? VERIFY_MS,
        () => ({ report: { id: connection.id, label: connection.label, active: false, status: "error", accounts: [], zones: 0, error: "Cloudflare did not answer in time" }, zones: [], backoffUntil: backoff.until }),
      );
      const before = store.reports.find((entry) => entry.id === connection.id);
      const stale = !report.token || (!report.token.readable && report.token.transient);
      const tokenAccess = !report.active ? undefined : stale && before?.token ? before.token : report.token;
      return { ...report, ...(tokenAccess ? { token: tokenAccess } : {}) };
    }));
    writeStatus(resolved, reports, Math.max(store.backoffUntil, backoff.until));
    return reports;
  });
}

/**
 * Whether a Cloudflare connection's token holds a permission on a zone, from the
 * last check's read of it, without calling Cloudflare. Null when unknown.
 */
export function cloudflareTokenHolds(
  id: string,
  permission: PermissionName,
  zone: { id: string; accountId: string },
  paths?: Partial<CloudflareStorePaths>,
): boolean | null {
  const store = readCloudflareStore(paths);
  const connection = store.reports.find((entry) => entry.id === id);
  const token = connection?.active ? connection.token : undefined;
  if (!token?.readable) return null;
  const held = grants(token.grants, PERMISSIONS[permission], targetFor(PERMISSIONS[permission], zone, token));
  return uncertain(token.grants, PERMISSIONS[permission], held ? "yes" : "no") ? null : held;
}

// ---------------------------------------------------------------------------
// Migration from legacy addons/dns/ state into /var/lib/clp-addons/cloudflare/
// ---------------------------------------------------------------------------

interface SavedFile { path: string; text: string; mode: number; uid: number; gid: number }

function snapshotFile(path: string, expectedUid: number): SavedFile | null {
  if (!existsSync(path)) return null;
  const info = lstatSync(path);
  if (!isTrustedFile(info, expectedUid)) throw new Error(`refusing untrusted migration file ${path}`);
  return { path, text: readFileSync(path, "utf8"), mode: info.mode & 0o777, uid: info.uid, gid: info.gid };
}

function restoreFile(file: SavedFile): void {
  writeFileAtomic(file.path, file.text, { mode: file.mode, owner: { uid: file.uid, gid: file.gid }, createParent: true });
}

export function legacyDnsCloudflarePending(dnsDir = addonStateDir("dns")): boolean {
  try {
    const policyPath = join(dnsDir, "policy.json");
    if (existsSync(policyPath)) {
      const parsed = JSON.parse(readFileSync(policyPath, "utf8")) as { connections?: unknown };
      if (Array.isArray(parsed?.connections) && parsed.connections.length > 0) return true;
    }
  } catch { /* ignore unreadable */ }
  try {
    const secretsPath = join(dnsDir, "secrets.json");
    if (existsSync(secretsPath)) {
      const parsed = JSON.parse(readFileSync(secretsPath, "utf8")) as { cloudflare?: unknown };
      if (parsed?.cloudflare && typeof parsed.cloudflare === "object" && Object.keys(parsed.cloudflare).length > 0) return true;
    }
  } catch { /* ignore unreadable */ }
  return false;
}

/**
 * Moves Cloudflare connections, tokens and cached reports out of `dns/` into
 * the shared `/var/lib/clp-addons/cloudflare/` store. Returns an in-memory
 * rollback closure, or null when there was nothing to move. Throws, with
 * everything put back, when the move fails: Panel gate reads only the shared
 * store, so an update must not finish with tokens left behind.
 */
export function migrateCloudflareFromDns(
  dnsDir = addonStateDir("dns"),
  paths?: Partial<CloudflareStorePaths>,
): (() => void) | null {
  const resolved = resolvePaths(paths);
  const uid = resolved.rootUid;
  const dnsPolicyPath = join(dnsDir, "policy.json");
  const dnsSecretsPath = join(dnsDir, "secrets.json");
  const dnsStatusPath = join(dnsDir, "status.json");
  const cfFiles = filePaths(resolved);

  let policySnap: SavedFile | null;
  let secretsSnap: SavedFile | null;
  let statusSnap: SavedFile | null;
  try {
    policySnap = snapshotFile(dnsPolicyPath, uid);
    secretsSnap = snapshotFile(dnsSecretsPath, uid);
    statusSnap = snapshotFile(dnsStatusPath, uid);
  } catch (error) {
    throw new Error(`DNS's Cloudflare connections were not moved to shared state: ${errorMessage(error)}`);
  }

  let policyJson: Record<string, unknown> | null = null;
  let secretsJson: Record<string, unknown> | null = null;
  let statusJson: Record<string, unknown> | null = null;
  try { if (policySnap) policyJson = JSON.parse(policySnap.text) as Record<string, unknown>; } catch { policyJson = null; }
  try { if (secretsSnap) secretsJson = JSON.parse(secretsSnap.text) as Record<string, unknown>; } catch { secretsJson = null; }
  try { if (statusSnap) statusJson = JSON.parse(statusSnap.text) as Record<string, unknown>; } catch { statusJson = null; }

  const legacyConns = parseConnectionsList(policyJson?.connections);
  const legacyTokens = parseTokensMap(secretsJson?.cloudflare);
  const legacyReports = Array.isArray(statusJson?.connections) ? statusJson.connections as CloudflareConnectionReport[] : [];
  if (!legacyConns.length && !Object.keys(legacyTokens).length) return null;

  const targetDirExisted = existsSync(resolved.stateDir);
  const originals = new Map<string, SavedFile | null>();
  const keep = (path: string) => { if (!originals.has(path)) originals.set(path, snapshotFile(path, uid)); };
  const undo = () => {
    for (const [path, before] of [...originals].reverse()) {
      if (before) restoreFile(before); else rmSync(path, { force: true });
    }
    if (!targetDirExisted && existsSync(resolved.stateDir)) {
      try { rmdirSync(resolved.stateDir); } catch { /* non-empty */ }
    }
  };

  try {
    const existing = readCloudflareStore(resolved);
    const mergedConns = [...existing.connections];
    const seenIds = new Set(mergedConns.map((c) => c.id));
    for (const conn of legacyConns) {
      if (!seenIds.has(conn.id)) {
        seenIds.add(conn.id);
        mergedConns.push(conn);
      }
    }
    for (const id of Object.keys(legacyTokens)) {
      if (!seenIds.has(id)) {
        seenIds.add(id);
        mergedConns.push({ id, label: id });
      }
    }
    if (mergedConns.length > MAX_CLOUDFLARE_CONNECTIONS) {
      throw new Error(`more than ${MAX_CLOUDFLARE_CONNECTIONS} Cloudflare connections exist across shared and legacy DNS state`);
    }
    const mergedTokens: Record<string, string> = { ...legacyTokens, ...existing.tokens };
    const existingReportIds = new Set(existing.reports.map((r) => r.id));
    const mergedReports: CloudflareConnectionReport[] = [
      ...existing.reports,
      ...legacyReports.filter((r) => r && typeof r.id === "string" && seenIds.has(r.id) && !existingReportIds.has(r.id)
        && legacyTokens[r.id] === mergedTokens[r.id]),
    ];
    const legacyBackoff = typeof (statusJson?.backoff as { cloudflare?: unknown } | undefined)?.cloudflare === "number"
      ? (statusJson!.backoff as { cloudflare: number }).cloudflare : 0;

    keep(cfFiles.connections);
    keep(cfFiles.secrets);
    keep(cfFiles.status);
    writeConnections(resolved, mergedConns);
    writeSecrets(resolved, mergedTokens);
    writeStatus(resolved, mergedReports, Math.max(existing.backoffUntil, legacyBackoff));

    if (policySnap && policyJson && Array.isArray(policyJson.connections) && policyJson.connections.length > 0) {
      keep(dnsPolicyPath);
      restoreFile({ ...policySnap, text: `${JSON.stringify({ ...policyJson, connections: [] }, null, 2)}\n` });
    }
    if (secretsSnap && secretsJson && secretsJson.cloudflare && typeof secretsJson.cloudflare === "object" && Object.keys(secretsJson.cloudflare).length > 0) {
      keep(dnsSecretsPath);
      restoreFile({ ...secretsSnap, text: `${JSON.stringify({ ...secretsJson, cloudflare: {} }, null, 2)}\n` });
    }
    if (statusSnap && statusJson && Array.isArray(statusJson.connections) && statusJson.connections.length > 0) {
      const kept = statusJson.connections.filter((entry) =>
        Boolean(entry) && typeof entry === "object" && typeof (entry as { provider?: unknown }).provider === "string"
        && (entry as { provider: string }).provider !== "cloudflare");
      if (kept.length !== statusJson.connections.length) {
        keep(dnsStatusPath);
        restoreFile({ ...statusSnap, text: `${JSON.stringify({ ...statusJson, connections: kept }, null, 2)}\n` });
      }
    }
    return undo;
  } catch (error) {
    undo();
    throw new Error(`DNS's Cloudflare connections were not moved to shared state: ${errorMessage(error)}`);
  }
}

/**
 * Firewall's Cloudflare edge defaults: zone-wide SSL/TLS mode, Always Use
 * HTTPS, Full SSL rules for Let's Encrypt HTTP-01 and webmail hosts, and WAF
 * skip IPs, backed by the shared Cloudflare connection store.
 *
 * Uses an approve-once model: before approval Firewall only reads and previews
 * changes; once approved, new or newly discovered Cloudflare zones receive the
 * approved defaults automatically without per-site review holds. Destructive
 * changes (SSL downgrades, disabling Always Use HTTPS, removing rules or skip
 * IPs) and rule conflicts always hold for explicit confirmation review.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { failAction } from "../../lib/action";
import type { ActionNeeded, SetupCheck } from "../../lib/addon-definition";
import { connectionPermissions } from "../../lib/cloudflare/access";
import { CloudflareApi, type CfRuleset, type CfZone } from "../../lib/cloudflare/api";
import {
  CONFIG_PHASE, DEFAULT_EDGE_DEFAULTS, FIREWALL_PHASE, RULE_PHASES, describeEdgeDefaults, edgeDefaultsDigest, hasActiveEdgeDefaults,
  parseEdgeDefaults, planZoneEdge, type EdgeDefaults, type EdgeRuleKey, type LiveZoneEdgeState, type PlannedEdgeChange,
  type ZoneCurrentSummary,
} from "../../lib/cloudflare/edge";
import {
  listCloudflareSecrets, readCloudflareStore, recordCloudflareReports, verifyCloudflareToken,
  type CloudflareConnectionReport, type CloudflareConnectionSecret, type CloudflareStorePaths,
} from "../../lib/cloudflare/store";
import { connectionId, cloudflareId, dnsName } from "../../lib/dns-name";
import { errorMessage } from "../../lib/errors";
import { withFileLock } from "../../lib/file-lock";
import { addonStateDir, CLOUDFLARE_STATE_DIR, LOCK_DIR, ROOT_UID } from "../../lib/paths";
import { type ApiFetch, ProviderError, redact } from "../../lib/provider-http";
import { readState, writeState } from "../../lib/root-state";

const REVIEW_TTL_MS = 15 * 60_000;
const MAX_LOG_ENTRIES = 100;
const LOCK_WAIT_S = 60;
const LOCK_BUSY = "another Cloudflare edge check or update is running";
const INACTIVE_ZONES = new Set(["moved", "deleted", "deactivated"]);

export interface EdgePaths {
  stateDir: string;
  lockFile: string;
  cloudflareDir: string;
  cloudflareLockFile: string;
  rootUid: number;
}

export const DEFAULT_EDGE_PATHS: EdgePaths = {
  stateDir: addonStateDir("firewall"),
  lockFile: `${LOCK_DIR}/firewall-edge.lock`,
  cloudflareDir: CLOUDFLARE_STATE_DIR,
  cloudflareLockFile: `${LOCK_DIR}/cloudflare.lock`,
  rootUid: ROOT_UID,
};

export interface EdgeOptions {
  paths?: Partial<EdgePaths>;
  fetch?: ApiFetch;
  now?: () => number;
}

export interface EdgeZoneChoice {
  connectionId: string;
  zoneId: string;
}

export interface EdgeConfig {
  version: 1;
  defaults: EdgeDefaults;
  approved: boolean;
  approvedAt: string | null;
  approvedDigest: string | null;
  knownZones: string[];
  zoneChoices: Record<string, EdgeZoneChoice>;
  migrationNote: string | null;
}

export interface EdgeChangeView {
  action: "create" | "update" | "delete";
  subject: string;
  detail: string;
  before?: string;
  destructive?: true;
  conflict?: true;
  reason?: string;
}

export type EdgeZoneRunState = "synced" | "pending" | "needs_review" | "conflict" | "error";

export interface EdgeZoneStatus {
  zoneKey: string;
  zoneId: string;
  zoneName: string;
  zoneStatus: string;
  connectionId: string;
  connectionLabel: string;
  accountName: string;
  current: ZoneCurrentSummary;
  changes: EdgeChangeView[];
  conflicts: string[];
  error: string | null;
  status: EdgeZoneRunState;
  managedRules: EdgeRuleKey[];
  zoneChoices?: { connectionId: string; zoneId: string; label: string }[];
}

export interface EdgeLogEntry {
  at: string;
  cause: string;
  zone: string;
  action: "create" | "update" | "delete";
  subject: string;
  detail: string;
  before?: string;
}

interface EdgeStatusFile {
  version: 1;
  checkedAt: string | null;
  zones: EdgeZoneStatus[];
  /** Managed rules tracked by Cloudflare zone ID until a successful ruleset read confirms each rule is gone. */
  trackedManagedRules?: Record<string, EdgeRuleKey[]>;
  log: EdgeLogEntry[];
}

interface EdgePendingReview {
  version: 1;
  token: string;
  digest: string;
  configHash: string;
  kind: "approve" | "defaults" | "zone";
  nextDefaults: EdgeDefaults;
  approve: boolean;
  zoneKey?: string;
  expiresAt: number;
}

export interface EdgePageView {
  connected: boolean;
  defaults: EdgeDefaults;
  approved: boolean;
  approvedAt: string | null;
  needsApproval: boolean;
  migrationNote: string | null;
  checkedAt: string | null;
  zones: EdgeZoneStatus[];
  log: EdgeLogEntry[];
}

export interface EdgeReviewZone {
  zoneKey: string;
  zoneName: string;
  connectionLabel: string;
  accountName: string;
  changes: EdgeChangeView[];
  conflicts: string[];
  error: string | null;
}

export interface EdgeReview {
  token: string;
  kind: "approve" | "defaults" | "zone";
  title: string;
  text: string;
  confirmLabel: string;
  danger: boolean;
  blocked: boolean;
  warnings: string[];
  zones: EdgeReviewZone[];
}

export interface EdgeReply {
  notice?: string;
  review?: EdgeReview;
}

// ---------------------------------------------------------------------------
// Paths & persistence
// ---------------------------------------------------------------------------

function resolvePaths(options?: EdgeOptions): EdgePaths {
  return { ...DEFAULT_EDGE_PATHS, ...options?.paths };
}

function filesOf(paths: EdgePaths) {
  return {
    config: join(paths.stateDir, "cloudflare-edge.json"),
    status: join(paths.stateDir, "cloudflare-edge-status.json"),
    pending: join(paths.stateDir, "cloudflare-edge-pending.json"),
  };
}

function cfPathsOf(paths: EdgePaths): Partial<CloudflareStorePaths> {
  return { stateDir: paths.cloudflareDir, lockFile: paths.cloudflareLockFile, rootUid: paths.rootUid };
}

export function defaultEdgeConfig(): EdgeConfig {
  return {
    version: 1,
    defaults: { ...DEFAULT_EDGE_DEFAULTS, skipFirewallIps: [...DEFAULT_EDGE_DEFAULTS.skipFirewallIps] },
    approved: false,
    approvedAt: null,
    approvedDigest: null,
    knownZones: [],
    zoneChoices: {},
    migrationNote: null,
  };
}

function parseZoneChoices(raw: unknown): Record<string, EdgeZoneChoice> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, EdgeZoneChoice> = {};
  for (const [zone, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!dnsName(zone) || !entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    try {
      const obj = entry as Record<string, unknown>;
      out[zone.toLowerCase()] = {
        connectionId: connectionId(obj.connectionId),
        zoneId: cloudflareId(obj.zoneId, "the zone identifier"),
      };
    } catch { /* skip malformed choice */ }
  }
  return out;
}

export function readEdgeConfig(options?: EdgeOptions): EdgeConfig {
  const paths = resolvePaths(options);
  const raw = readState<Partial<EdgeConfig> | null>(filesOf(paths).config, paths.rootUid, () => null);
  if (!raw || typeof raw !== "object") return defaultEdgeConfig();
  const defaults = parseEdgeDefaults(raw.defaults ?? DEFAULT_EDGE_DEFAULTS);
  const approved = raw.approved === true;
  const approvedAt = typeof raw.approvedAt === "string" && raw.approvedAt ? raw.approvedAt : null;
  const approvedDigest = typeof raw.approvedDigest === "string" && raw.approvedDigest ? raw.approvedDigest : null;
  const knownZones = Array.isArray(raw.knownZones)
    ? [...new Set(raw.knownZones.filter((entry): entry is string => typeof entry === "string" && entry.includes(":")))].sort()
    : [];
  const migrationNote = typeof raw.migrationNote === "string" && raw.migrationNote.trim() ? raw.migrationNote.trim() : null;
  return {
    version: 1,
    defaults,
    approved,
    approvedAt: approved ? approvedAt : null,
    approvedDigest: approved ? (approvedDigest ?? edgeDefaultsDigest(defaults)) : null,
    knownZones,
    zoneChoices: parseZoneChoices(raw.zoneChoices),
    migrationNote,
  };
}

function writeEdgeConfig(paths: EdgePaths, config: EdgeConfig): void {
  writeState(filesOf(paths).config, config, paths.rootUid);
}

const VALID_RULE_KEYS = new Set<EdgeRuleKey>(["acme", "webmail", "skip"]);

function parseTrackedManagedRules(raw: unknown): Record<string, EdgeRuleKey[]> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, EdgeRuleKey[]> = {};
  for (const [zoneId, list] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof zoneId !== "string" || !zoneId || !Array.isArray(list)) continue;
    const keys = [...new Set(list.filter((key): key is EdgeRuleKey => typeof key === "string" && VALID_RULE_KEYS.has(key as EdgeRuleKey)))].sort();
    if (keys.length > 0) out[zoneId] = keys;
  }
  return out;
}

function trackedRulesMap(status: EdgeStatusFile): Map<string, Set<EdgeRuleKey>> {
  const map = new Map<string, Set<EdgeRuleKey>>();
  for (const [zoneId, keys] of Object.entries(status.trackedManagedRules ?? {})) {
    if (keys.length > 0) map.set(zoneId, new Set(keys));
  }
  for (const zone of status.zones) {
    if (!zone.zoneId || !zone.managedRules.length) continue;
    const set = map.get(zone.zoneId) ?? new Set<EdgeRuleKey>();
    for (const key of zone.managedRules) {
      if (VALID_RULE_KEYS.has(key)) set.add(key);
    }
    if (set.size > 0) map.set(zone.zoneId, set);
  }
  return map;
}

function prevManagedFor(status: EdgeStatusFile, zoneId: string): EdgeRuleKey[] {
  const set = trackedRulesMap(status).get(zoneId);
  return set ? [...set].sort() : [];
}

function turnedOffRuleKeys(prev: EdgeDefaults, next: EdgeDefaults): EdgeRuleKey[] {
  const removed: EdgeRuleKey[] = [];
  if (prev.acmeFullSsl && !next.acmeFullSsl) removed.push("acme");
  if (prev.webmailFullSsl && !next.webmailFullSsl) removed.push("webmail");
  if (prev.skipFirewallIps.length > 0 && next.skipFirewallIps.length === 0) removed.push("skip");
  return removed;
}

function updateTrackedManagedRules(
  status: EdgeStatusFile,
  evaluated: readonly EvaluatedZone[],
  removedKeys: readonly EdgeRuleKey[] = [],
  knownZones: readonly string[] = [],
): Record<string, EdgeRuleKey[]> {
  const map = trackedRulesMap(status);
  const evaluatedIds = new Set(evaluated.map((entry) => entry.discovered.zone.id));
  if (removedKeys.length > 0) {
    for (const zoneKey of knownZones) {
      const sep = zoneKey.indexOf(":");
      const zoneId = sep >= 0 ? zoneKey.slice(sep + 1) : "";
      if (!zoneId || evaluatedIds.has(zoneId)) continue;
      const set = map.get(zoneId) ?? new Set<EdgeRuleKey>();
      for (const key of removedKeys) set.add(key);
      map.set(zoneId, set);
    }
  }
  for (const entry of evaluated) {
    if (entry.error !== null) continue;
    const zoneId = entry.discovered.zone.id;
    const set = map.get(zoneId) ?? new Set<EdgeRuleKey>();
    for (const key of ["acme", "webmail", "skip"] as const) {
      if (!(RULE_PHASES[key] in entry.live.rulesets)) continue;
      if (entry.managedRules.includes(key)) set.add(key);
      else set.delete(key);
    }
    if (set.size > 0) map.set(zoneId, set);
    else map.delete(zoneId);
  }
  const out: Record<string, EdgeRuleKey[]> = {};
  for (const [zoneId, set] of [...map.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (set.size > 0) out[zoneId] = [...set].sort();
  }
  return out;
}

function readEdgeStatus(paths: EdgePaths): EdgeStatusFile {
  const raw = readState<Partial<EdgeStatusFile> | null>(filesOf(paths).status, paths.rootUid, () => null);
  if (!raw || typeof raw !== "object") return { version: 1, checkedAt: null, zones: [], trackedManagedRules: {}, log: [] };
  return {
    version: 1,
    checkedAt: typeof raw.checkedAt === "string" ? raw.checkedAt : null,
    zones: Array.isArray(raw.zones) ? raw.zones as EdgeZoneStatus[] : [],
    trackedManagedRules: parseTrackedManagedRules(raw.trackedManagedRules),
    log: Array.isArray(raw.log) ? (raw.log as EdgeLogEntry[]).slice(0, MAX_LOG_ENTRIES) : [],
  };
}

function writeEdgeStatus(paths: EdgePaths, status: EdgeStatusFile): void {
  writeState(filesOf(paths).status, {
    version: 1,
    checkedAt: status.checkedAt,
    zones: status.zones,
    trackedManagedRules: parseTrackedManagedRules(status.trackedManagedRules),
    log: status.log.slice(0, MAX_LOG_ENTRIES),
  }, paths.rootUid);
}

function readPending(paths: EdgePaths): EdgePendingReview | null {
  const raw = readState<EdgePendingReview | null>(filesOf(paths).pending, paths.rootUid, () => null);
  if (!raw || typeof raw !== "object" || raw.version !== 1 || typeof raw.token !== "string") return null;
  return raw;
}

function writePending(paths: EdgePaths, pending: EdgePendingReview): void {
  writeState(filesOf(paths).pending, pending, paths.rootUid);
}

function clearPending(paths: EdgePaths): void {
  rmSync(filesOf(paths).pending, { force: true });
}

function configHashOf(config: EdgeConfig): string {
  return createHash("sha256").update(JSON.stringify({
    defaults: config.defaults,
    approved: config.approved,
    approvedDigest: config.approvedDigest,
    zoneChoices: config.zoneChoices,
  })).digest("hex").slice(0, 32);
}

function withEdgeLock<T>(paths: EdgePaths, body: () => Promise<T>): Promise<T> {
  return withFileLock(paths.lockFile, LOCK_WAIT_S, LOCK_BUSY, body);
}

function zoneMapKey(connId: string, zoneId: string): string {
  return `${connId}:${zoneId}`;
}

function isApprovedActive(config: EdgeConfig): boolean {
  return config.approved && config.approvedDigest === edgeDefaultsDigest(config.defaults);
}

function toChangeView(change: PlannedEdgeChange): EdgeChangeView {
  return {
    action: change.action,
    subject: change.subject,
    detail: change.detail,
    ...(change.before !== undefined ? { before: change.before } : {}),
    ...(change.destructive ? { destructive: true as const } : {}),
    ...(change.conflict ? { conflict: true as const } : {}),
    ...(change.reason ? { reason: change.reason } : {}),
  };
}

// ---------------------------------------------------------------------------
// Live Cloudflare discovery, reading, planning, and applying
// ---------------------------------------------------------------------------

interface DiscoveredZone {
  zoneKey: string;
  zone: CfZone;
  connection: CloudflareConnectionSecret;
  api: CloudflareApi;
}

interface AmbiguousZone {
  zoneName: string;
  candidates: DiscoveredZone[];
  /** Set when an operator's saved zoneChoice is absent from the reachable candidates. */
  missingChoice?: EdgeZoneChoice;
}

interface DiscoveryResult {
  zones: DiscoveredZone[];
  ambiguous: AmbiguousZone[];
  connectionErrors: string[];
  reports: CloudflareConnectionReport[];
  checkedTokens: Record<string, string>;
  backoffUntil: number;
}

/**
 * Discovers all non-inactive zones across saved Cloudflare connections.
 * When two connections reach the exact same zone ID, prefers the first whose
 * token has no missing edge permissions; when two connections hold different
 * zone IDs with the same zone name, requires `zoneChoices` disambiguation.
 */
async function discoverZones(
  paths: EdgePaths,
  config: EdgeConfig,
  options: EdgeOptions,
  defaults: EdgeDefaults,
): Promise<DiscoveryResult> {
  const secrets = listCloudflareSecrets(cfPathsOf(paths));
  const store = readCloudflareStore(cfPathsOf(paths));
  const backoff = { until: store.backoffUntil };
  const checkedTokens: Record<string, string> = {};
  const reports: CloudflareConnectionReport[] = [];
  const connectionErrors: string[] = [];
  const candidatesByName = new Map<string, DiscoveredZone[]>();

  const verified = await Promise.all(secrets.map(async (connection) => {
    checkedTokens[connection.id] = connection.token;
    const { report, zones } = await verifyCloudflareToken(connection.id, connection.label, connection.token, {
      fetch: options.fetch,
      backoff,
      readTokens: false,
    });
    return { connection, report, zones };
  }));

  for (const { connection, report, zones } of verified) {
    reports.push(report);
    if (!report.active) {
      if (report.error) connectionErrors.push(`${connection.label}: ${report.error}`);
      continue;
    }
    const api = new CloudflareApi(connection.token, options.fetch, backoff);
    for (const zone of zones) {
      if (INACTIVE_ZONES.has(zone.status)) continue;
      const list = candidatesByName.get(zone.name) ?? [];
      list.push({ zoneKey: zoneMapKey(connection.id, zone.id), zone, connection, api });
      candidatesByName.set(zone.name, list);
    }
  }

  // Prefer a connection whose stored token report holds the required edge permissions.
  const connScore = (connId: string): number => {
    const stored = store.reports.find((entry) => entry.id === connId);
    if (!stored?.active || !stored.token?.readable) return 0;
    const { missing } = connectionPermissions(stored, defaults, { includeDns: false, includeEdge: true, requirePanelGate: false });
    return missing.length === 0 ? 1 : -missing.length;
  };

  const selected: DiscoveredZone[] = [];
  const ambiguous: AmbiguousZone[] = [];

  for (const [zoneName, list] of [...candidatesByName.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const choice = config.zoneChoices[zoneName];
    if (choice) {
      const matched = list.find((entry) => entry.connection.id === choice.connectionId && entry.zone.id === choice.zoneId);
      if (matched) {
        selected.push(matched);
      } else {
        ambiguous.push({ zoneName, candidates: list, missingChoice: choice });
      }
      continue;
    }
    const uniqueZoneIds = new Set(list.map((entry) => entry.zone.id));
    if (uniqueZoneIds.size === 1) {
      const best = [...list].sort((a, b) => connScore(b.connection.id) - connScore(a.connection.id))[0]!;
      selected.push(best);
      continue;
    }
    ambiguous.push({ zoneName, candidates: list });
  }

  return { zones: selected, ambiguous, connectionErrors, reports, checkedTokens, backoffUntil: backoff.until };
}

interface EvaluatedZone {
  discovered: DiscoveredZone;
  live: LiveZoneEdgeState;
  changes: PlannedEdgeChange[];
  conflicts: string[];
  managedRules: EdgeRuleKey[];
  current: ZoneCurrentSummary;
  error: string | null;
}

/**
 * Determines which settings and ruleset phases must be read for a zone so we
 * never query unused permissions (such as Zone WAF when no skip IPs exist)
 * while still detecting managed rules being disabled or removed.
 */
function neededReads(
  nextDefaults: EdgeDefaults,
  prevDefaults: EdgeDefaults | null,
  prevManaged: readonly EdgeRuleKey[],
): { settings: ("ssl" | "always_use_https")[]; phases: string[] } {
  const settings: ("ssl" | "always_use_https")[] = [];
  if (nextDefaults.ssl !== null || (prevDefaults?.ssl ?? null) !== null) settings.push("ssl");
  if (nextDefaults.alwaysHttps !== null || (prevDefaults?.alwaysHttps ?? null) !== null) settings.push("always_use_https");
  const phases: string[] = [];
  if (
    nextDefaults.acmeFullSsl || nextDefaults.webmailFullSsl
    || prevDefaults?.acmeFullSsl || prevDefaults?.webmailFullSsl
    || prevManaged.includes("acme") || prevManaged.includes("webmail")
  ) {
    phases.push(CONFIG_PHASE);
  }
  if (
    nextDefaults.skipFirewallIps.length > 0
    || (prevDefaults?.skipFirewallIps.length ?? 0) > 0
    || prevManaged.includes("skip")
  ) {
    phases.push(FIREWALL_PHASE);
  }
  return { settings, phases };
}

async function evaluateZone(
  discovered: DiscoveredZone,
  defaults: EdgeDefaults,
  prevDefaults: EdgeDefaults | null,
  prevManaged: readonly EdgeRuleKey[],
): Promise<EvaluatedZone> {
  const { api, zone, connection } = discovered;
  const { settings: readSettings, phases: readPhases } = neededReads(defaults, prevDefaults, prevManaged);
  const live: LiveZoneEdgeState = { settings: {}, rulesets: {} };
  try {
    const [settingValues, rulesetValues] = await Promise.all([
      Promise.all(readSettings.map((name) => api.setting(zone.id, name))),
      Promise.all(readPhases.map((phase) => api.entrypoint(zone.id, phase))),
    ]);
    readSettings.forEach((name, idx) => { live.settings[name] = settingValues[idx]!; });
    readPhases.forEach((phase, idx) => { live.rulesets[phase] = rulesetValues[idx]!; });
    const plan = planZoneEdge(defaults, live);
    return {
      discovered,
      live,
      changes: plan.changes,
      conflicts: plan.conflicts,
      managedRules: plan.managedRules,
      current: plan.current,
      error: null,
    };
  } catch (error) {
    return {
      discovered,
      live,
      changes: [],
      conflicts: [],
      managedRules: [...prevManaged],
      current: {},
      error: redact(errorMessage(error), [connection.token]),
    };
  }
}

function zoneStatusOf(evaluated: EvaluatedZone, approved: boolean): EdgeZoneStatus {
  const { discovered, changes, conflicts, managedRules, current, error } = evaluated;
  const hasGuarded = changes.some((change) => change.destructive || change.conflict);
  const status: EdgeZoneRunState = error
    ? "error"
    : conflicts.length > 0
      ? "conflict"
      : hasGuarded
        ? "needs_review"
        : changes.length > 0
          ? "pending"
          : "synced";
  // When unapproved, safe changes stay "pending" unless destructive/conflicting (still flagged "needs_review").
  const finalStatus = !approved && status === "pending" ? "pending" : status;
  return {
    zoneKey: discovered.zoneKey,
    zoneId: discovered.zone.id,
    zoneName: discovered.zone.name,
    zoneStatus: discovered.zone.status,
    connectionId: discovered.connection.id,
    connectionLabel: discovered.connection.label,
    accountName: discovered.zone.account.name || discovered.zone.account.id,
    current,
    changes: changes.map(toChangeView),
    conflicts,
    error,
    status: finalStatus,
    managedRules,
  };
}

function ambiguousStatusOf(ambiguous: AmbiguousZone): EdgeZoneStatus {
  return {
    zoneKey: `ambiguous:${ambiguous.zoneName}`,
    zoneId: "",
    zoneName: ambiguous.zoneName,
    zoneStatus: "ambiguous",
    connectionId: "",
    connectionLabel: ambiguous.missingChoice ? "Selected connection unavailable" : "Multiple connections",
    accountName: "",
    current: {},
    changes: [],
    conflicts: [
      ambiguous.missingChoice
        ? `${ambiguous.zoneName}'s selected Cloudflare zone is unavailable; waiting for its connection, or choose another connection.`
        : `${ambiguous.zoneName} exists in more than one Cloudflare account; choose which one Firewall should manage.`,
    ],
    error: null,
    status: "conflict",
    managedRules: [],
    zoneChoices: ambiguous.candidates.map((candidate) => ({
      connectionId: candidate.connection.id,
      zoneId: candidate.zone.id,
      label: `${candidate.connection.label} · ${candidate.zone.account.name || candidate.zone.account.id} (${candidate.zone.status})`,
    })),
  };
}

/**
 * Applies planned changes to one zone: rules first (so ACME Full SSL is in
 * place before SSL switches to Full (strict)), then zone settings.
 */
async function applyZoneChanges(
  evaluated: EvaluatedZone,
  defaults: EdgeDefaults,
  cause: string,
  nowIso: string,
): Promise<{ evaluated: EvaluatedZone; logged: EdgeLogEntry[]; error: string | null }> {
  const { discovered, live, changes } = evaluated;
  const { api, zone, connection } = discovered;
  const logged: EdgeLogEntry[] = [];
  const ordered = [
    ...changes.filter((change) => change.kind === "rule"),
    ...changes.filter((change) => change.kind === "setting"),
  ];
  try {
    for (const change of ordered) {
      if (change.kind === "rule") {
        const phase = change.phase!;
        const currentRuleset = live.rulesets[phase] ?? null;
        if (change.action === "delete") {
          if (!currentRuleset || !change.ruleId) continue;
          await api.deleteRule(zone.id, phase, currentRuleset.id, change.ruleId);
          live.rulesets[phase] = {
            ...currentRuleset,
            rules: currentRuleset.rules.filter((rule) => rule.id !== change.ruleId),
          };
        } else if (change.action === "create") {
          const updated = currentRuleset
            ? await api.addRule(zone.id, phase, currentRuleset.id, change.rule!)
            : await api.createEntrypoint(zone.id, phase, [change.rule!], "CloudPanel Firewall");
          live.rulesets[phase] = updated;
        } else {
          if (!currentRuleset || !change.ruleId) continue;
          let updated: CfRuleset;
          try {
            updated = await api.updateRule(zone.id, phase, currentRuleset.id, change.ruleId, change.rule!);
          } catch (error) {
            if (!(error instanceof ProviderError) || error.status !== 400 || !change.keepRef || change.keepRef === change.rule!.ref) {
              throw error;
            }
            updated = await api.updateRule(zone.id, phase, currentRuleset.id, change.ruleId, { ...change.rule!, ref: change.keepRef });
          }
          live.rulesets[phase] = updated;
        }
        logged.push({
          at: nowIso,
          cause,
          zone: zone.name,
          action: change.action,
          subject: change.subject,
          detail: change.detail,
          ...(change.before !== undefined ? { before: change.before } : {}),
        });
      } else if (change.kind === "setting") {
        await api.setSetting(zone.id, change.setting!, change.value!);
        live.settings[change.setting!] = change.value!;
        logged.push({
          at: nowIso,
          cause,
          zone: zone.name,
          action: "update",
          subject: change.subject,
          detail: change.detail,
          ...(change.before !== undefined ? { before: change.before } : {}),
        });
      }
    }
    const freshPlan = planZoneEdge(defaults, live);
    return {
      evaluated: {
        ...evaluated,
        live,
        changes: freshPlan.changes,
        conflicts: freshPlan.conflicts,
        managedRules: freshPlan.managedRules,
        current: freshPlan.current,
        error: null,
      },
      logged,
      error: null,
    };
  } catch (error) {
    const message = redact(errorMessage(error), [connection.token]);
    const freshPlan = planZoneEdge(defaults, live);
    return {
      evaluated: {
        ...evaluated,
        live,
        changes: freshPlan.changes,
        conflicts: freshPlan.conflicts,
        managedRules: freshPlan.managedRules,
        current: freshPlan.current,
        error: message,
      },
      logged,
      error: message,
    };
  }
}

async function mergeRefusedPermissions(
  paths: EdgePaths,
  discovery: DiscoveryResult,
  fullPass: boolean,
): Promise<void> {
  const refusedByConn = new Map<string, Set<string>>();
  for (const discovered of discovery.zones) {
    if (!discovered.api.refused.size) continue;
    const set = refusedByConn.get(discovered.connection.id) ?? new Set<string>();
    for (const perm of discovered.api.refused) set.add(perm);
    refusedByConn.set(discovered.connection.id, set);
  }
  const mergedReports = discovery.reports.map((report) => {
    const refused = refusedByConn.get(report.id);
    return refused?.size ? { ...report, refused: [...new Set([...(report.refused ?? []), ...refused])] } : report;
  });
  await recordCloudflareReports(mergedReports, discovery.backoffUntil, fullPass, discovery.checkedTokens, cfPathsOf(paths));
}

// ---------------------------------------------------------------------------
// Review construction
// ---------------------------------------------------------------------------

/** What each change will write to, so a review never confirms against a rule replaced or edited since. */
function changeTargets(evaluated: EvaluatedZone[]): unknown[] {
  return evaluated.filter((entry) => entry.changes.length > 0).map((entry) => ({
    zoneId: entry.discovered.zone.id,
    changes: entry.changes.map((change) => ({
      setting: change.setting ?? null,
      value: change.value ?? null,
      phase: change.phase ?? null,
      rulesetId: change.rulesetId ?? null,
      ruleId: change.ruleId ?? null,
      rule: change.rule ?? null,
      live: change.phase && change.ruleId
        ? entry.live.rulesets[change.phase]?.rules.find((rule) => rule.id === change.ruleId) ?? null
        : null,
    })),
  }));
}

function reviewDigest(
  kind: EdgePendingReview["kind"],
  approve: boolean,
  nextDefaults: EdgeDefaults,
  zones: EdgeReviewZone[],
  targets: unknown[],
  zoneKey?: string,
): string {
  return createHash("sha256").update(JSON.stringify({
    kind,
    approve,
    zoneKey: zoneKey ?? null,
    defaults: nextDefaults,
    zones: zones.map((zone) => ({
      zoneKey: zone.zoneKey,
      changes: zone.changes,
      conflicts: zone.conflicts,
      error: zone.error,
    })),
    targets,
  })).digest("hex").slice(0, 32);
}

function buildReview(
  kind: EdgePendingReview["kind"],
  nextDefaults: EdgeDefaults,
  evaluated: EvaluatedZone[],
  ambiguous: AmbiguousZone[],
  zoneKey?: string,
): { review: EdgeReview; digest: string } {
  const zones: EdgeReviewZone[] = [
    ...evaluated
      .filter((entry) => entry.changes.length > 0 || entry.conflicts.length > 0 || entry.error !== null)
      .map((entry) => ({
        zoneKey: entry.discovered.zoneKey,
        zoneName: entry.discovered.zone.name,
        connectionLabel: entry.discovered.connection.label,
        accountName: entry.discovered.zone.account.name || entry.discovered.zone.account.id,
        changes: entry.changes.map(toChangeView),
        conflicts: entry.conflicts,
        error: entry.error,
      })),
    ...(kind !== "zone" ? ambiguous.map((entry) => ({
      zoneKey: `ambiguous:${entry.zoneName}`,
      zoneName: entry.zoneName,
      connectionLabel: entry.missingChoice ? "Selected connection unavailable" : "Multiple connections",
      accountName: "",
      changes: [],
      conflicts: [
        entry.missingChoice
          ? `${entry.zoneName}'s selected Cloudflare zone is unavailable; skipped until its connection recovers or you choose another connection.`
          : `${entry.zoneName} exists in more than one Cloudflare account; skipped until you choose which connection manages it.`,
      ],
      error: null,
    })) : []),
  ];

  const allChanges = zones.flatMap((zone) => zone.changes);
  const destructiveCount = allChanges.filter((change) => change.destructive).length;
  const conflictChangeCount = allChanges.filter((change) => change.conflict).length;
  const blockingZones = zones.filter((zone) => zone.conflicts.length > 0 || zone.error !== null);
  const actionableZones = zones.filter((zone) => zone.changes.length > 0 && zone.conflicts.length === 0 && !zone.error);
  const warnings: string[] = [];
  if (destructiveCount > 0) {
    warnings.push(`${destructiveCount} destructive change${destructiveCount === 1 ? "" : "s"} (such as an SSL downgrade, turning Always Use HTTPS off, or removing a rule or skip IP) require your confirmation.`);
  }
  if (conflictChangeCount > 0) {
    warnings.push(`${conflictChangeCount} change${conflictChangeCount === 1 ? "" : "s"} update a conflicting or disabled Cloudflare rule in place.`);
  }
  if (blockingZones.length > 0) {
    warnings.push(`${blockingZones.length} zone${blockingZones.length === 1 ? "" : "s"} have blocking conflicts or read errors and will be skipped until resolved.`);
  }

  const danger = destructiveCount > 0 || conflictChangeCount > 0;
  const blocked = kind === "zone" ? actionableZones.length === 0 : (actionableZones.length === 0 && blockingZones.length > 0 && kind === "defaults" && !hasActiveEdgeDefaults(nextDefaults) ? false : false);
  const zoneBlocked = kind === "zone" && actionableZones.length === 0;

  let title: string;
  let text: string;
  let confirmLabel: string;
  if (kind === "approve") {
    title = "Approve Cloudflare edge defaults";
    text = actionableZones.length > 0
      ? `${allChanges.length} change${allChanges.length === 1 ? "" : "s"} will apply across ${actionableZones.length} zone${actionableZones.length === 1 ? "" : "s"} now. Once approved, new Cloudflare zones inherit these defaults automatically; destructive changes and rule conflicts will still ask first.`
      : "No existing zone needs changes right now. Once approved, new Cloudflare zones inherit these defaults automatically; destructive changes and rule conflicts will still ask first.";
    confirmLabel = danger ? "Confirm and approve defaults" : "Approve and apply defaults";
  } else if (kind === "defaults") {
    title = danger ? "Confirm Cloudflare edge default changes" : "Update Cloudflare edge defaults";
    text = actionableZones.length > 0
      ? `${allChanges.length} change${allChanges.length === 1 ? "" : "s"} will apply across ${actionableZones.length} zone${actionableZones.length === 1 ? "" : "s"}, and new Cloudflare zones will inherit the updated defaults automatically.`
      : "Save the updated Cloudflare edge defaults for new zones.";
    confirmLabel = danger ? "Confirm and apply changes" : "Save and apply";
  } else {
    const targetName = evaluated[0]?.discovered.zone.name ?? "this zone";
    title = `Confirm changes for ${targetName}`;
    text = zoneBlocked
      ? `${targetName} has a blocking conflict or read error that must be resolved in Cloudflare before Firewall can apply defaults.`
      : `Apply ${allChanges.length} change${allChanges.length === 1 ? "" : "s"} to ${targetName}.`;
    confirmLabel = danger ? "Confirm and apply" : "Apply changes";
  }

  const digest = reviewDigest(kind, kind !== "zone", nextDefaults, zones, changeTargets(evaluated), zoneKey);
  const token = randomBytes(16).toString("hex");
  return {
    digest,
    review: {
      token,
      kind,
      title,
      text,
      confirmLabel,
      danger,
      blocked: zoneBlocked || blocked,
      warnings,
      zones,
    },
  };
}

// ---------------------------------------------------------------------------
// Public API for Firewall action, repair, newSites, and Setup
// ---------------------------------------------------------------------------

/** Local-only read for Firewall's page load; makes zero Cloudflare calls. */
export function edgePageView(options?: EdgeOptions): EdgePageView {
  const paths = resolvePaths(options);
  const config = readEdgeConfig(options);
  const status = readEdgeStatus(paths);
  const connected = listCloudflareSecrets(cfPathsOf(paths)).length > 0;
  const approved = isApprovedActive(config);
  return {
    connected,
    defaults: config.defaults,
    approved,
    approvedAt: approved ? config.approvedAt : null,
    needsApproval: connected && !approved,
    migrationNote: config.migrationNote,
    checkedAt: status.checkedAt,
    zones: connected ? status.zones : [],
    log: status.log,
  };
}

/**
 * Checks all reachable Cloudflare zones against Firewall's edge defaults.
 * When approved, automatically applies safe (non-destructive, non-conflicting)
 * changes to new and drifted zones with no per-site review holds. Destructive
 * changes and conflicts are always held as `needs_review` or `conflict`.
 */
export async function checkCloudflareEdge(
  options: EdgeOptions = {},
  cause = "Manual check",
): Promise<{ notice: string; applied: number; held: number; conflicts: number; errors: number }> {
  const paths = resolvePaths(options);
  const now = options.now ?? Date.now;
  return withEdgeLock(paths, async () => {
    const config = readEdgeConfig(options);
    const status = readEdgeStatus(paths);
    const secrets = listCloudflareSecrets(cfPathsOf(paths));
    if (!secrets.length) {
      writeEdgeStatus(paths, {
        version: 1,
        checkedAt: null,
        zones: [],
        trackedManagedRules: status.trackedManagedRules,
        log: status.log,
      });
      return { notice: "Connect Cloudflare first to check zone edge defaults.", applied: 0, held: 0, conflicts: 0, errors: 0 };
    }
    const discovery = await discoverZones(paths, config, options, config.defaults);
    const evaluated = await Promise.all(discovery.zones.map((discovered) =>
      evaluateZone(discovered, config.defaults, null, prevManagedFor(status, discovered.zone.id)),
    ));

    const approved = isApprovedActive(config);
    const known = new Set(config.knownZones);
    const nowIso = new Date(now()).toISOString();
    const newLogs: EdgeLogEntry[] = [];
    let appliedZones = 0;
    const finalEvaluated: EvaluatedZone[] = [];

    for (const entry of evaluated) {
      const zoneKey = entry.discovered.zoneKey;
      const isNewZone = !known.has(zoneKey);
      const hasGuarded = entry.changes.some((change) => change.destructive || change.conflict);
      if (approved && !entry.error && entry.conflicts.length === 0 && entry.changes.length > 0 && !hasGuarded) {
        const applied = await applyZoneChanges(
          entry,
          config.defaults,
          isNewZone ? "New zone" : cause,
          nowIso,
        );
        newLogs.push(...applied.logged);
        if (!applied.error && applied.logged.length > 0) appliedZones++;
        if (!applied.error) known.add(zoneKey);
        finalEvaluated.push(applied.evaluated);
      } else {
        if (approved && !entry.error && entry.conflicts.length === 0 && entry.changes.length === 0) {
          known.add(zoneKey);
        }
        finalEvaluated.push(entry);
      }
    }

    await mergeRefusedPermissions(paths, discovery, true);

    const zoneStatuses = [
      ...finalEvaluated.map((entry) => zoneStatusOf(entry, approved)),
      ...discovery.ambiguous.map(ambiguousStatusOf),
    ].sort((a, b) => a.zoneName.localeCompare(b.zoneName));

    const nextKnown = [...known].sort();
    if (nextKnown.join(",") !== config.knownZones.join(",")) {
      writeEdgeConfig(paths, { ...config, knownZones: nextKnown });
    }
    writeEdgeStatus(paths, {
      version: 1,
      checkedAt: nowIso,
      zones: zoneStatuses,
      trackedManagedRules: updateTrackedManagedRules(status, finalEvaluated),
      log: [...newLogs.reverse(), ...status.log].slice(0, MAX_LOG_ENTRIES),
    });

    const held = zoneStatuses.filter((zone) => zone.status === "needs_review").length;
    const conflicts = zoneStatuses.filter((zone) => zone.status === "conflict").length;
    const errors = zoneStatuses.filter((zone) => zone.status === "error").length + discovery.connectionErrors.length;
    const synced = zoneStatuses.filter((zone) => zone.status === "synced").length;

    const parts: string[] = [];
    if (appliedZones > 0) parts.push(`applied approved defaults to ${appliedZones} zone${appliedZones === 1 ? "" : "s"}`);
    if (synced > 0 && appliedZones === 0) parts.push(`${synced} zone${synced === 1 ? "" : "s"} in sync`);
    if (!approved && zoneStatuses.some((zone) => zone.status === "pending")) {
      const pending = zoneStatuses.filter((zone) => zone.status === "pending").length;
      parts.push(`${pending} zone${pending === 1 ? "" : "s"} ready for approval`);
    }
    if (held > 0) parts.push(`${held} zone${held === 1 ? "" : "s"} need${held === 1 ? "s" : ""} confirmation review`);
    if (conflicts > 0) parts.push(`${conflicts} zone${conflicts === 1 ? "" : "s"} have rule conflicts`);
    if (errors > 0) parts.push(`${errors} error${errors === 1 ? "" : "s"}`);
    const summary = parts.length ? `${parts[0]![0]!.toUpperCase()}${parts[0]!.slice(1)}${parts.length > 1 ? `; ${parts.slice(1).join("; ")}` : ""}.` : "No Cloudflare zones found.";
    return { notice: summary, applied: appliedZones, held, conflicts, errors };
  });
}

/**
 * Background reconciliation run by Firewall's repair and new-site hooks.
 * Returns immediately with zero API calls when unapproved or no Cloudflare
 * connection exists.
 */
export async function reconcileCloudflareEdge(options: EdgeOptions = {}, cause = "Scheduled check"): Promise<string | null> {
  const paths = resolvePaths(options);
  if (!existsSync(filesOf(paths).config)) return null;
  const config = readEdgeConfig(options);
  if (!isApprovedActive(config)) return null;
  if (listCloudflareSecrets(cfPathsOf(paths)).length === 0) return null;
  const result = await checkCloudflareEdge(options, cause);
  if (result.applied > 0 || result.held > 0 || result.conflicts > 0) {
    return `Cloudflare edge: ${result.notice}`;
  }
  return null;
}

/** Saves draft defaults, pauses automatic defaults, or prepares an approve-once / update review. */
export async function saveCloudflareEdge(body: Record<string, unknown>, options: EdgeOptions = {}): Promise<EdgeReply> {
  const paths = resolvePaths(options);
  const now = options.now ?? Date.now;
  return withEdgeLock(paths, async () => {
    const config = readEdgeConfig(options);
    const status = readEdgeStatus(paths);

    if (body.pause === true) {
      clearPending(paths);
      writeEdgeConfig(paths, { ...config, approved: false, approvedAt: null, approvedDigest: null });
      const zones = status.zones.map((zone) => zone.status === "synced" ? zone : zone);
      writeEdgeStatus(paths, { ...status, zones });
      return { notice: "Automatic Cloudflare edge defaults paused. Existing zones are unchanged." };
    }

    const nextDefaults = parseEdgeDefaults(body.defaults ?? config.defaults);
    const approveRequested = body.approve === true;
    const currentlyApproved = isApprovedActive(config);

    if (!currentlyApproved && !approveRequested) {
      clearPending(paths);
      writeEdgeConfig(paths, { ...config, defaults: nextDefaults, approved: false, approvedAt: null, approvedDigest: null });
      return { notice: "Cloudflare edge draft saved. Review and approve defaults when ready." };
    }

    if (listCloudflareSecrets(cfPathsOf(paths)).length === 0) {
      failAction("Connect Cloudflare first before approving edge defaults");
    }

    const discovery = await discoverZones(paths, config, options, nextDefaults);
    if (discovery.connectionErrors.length > 0 && discovery.zones.length === 0) {
      failAction(`Cloudflare could not be read: ${discovery.connectionErrors.join("; ")}`);
    }
    const evaluated = await Promise.all(discovery.zones.map((discovered) =>
      evaluateZone(discovered, nextDefaults, config.defaults, prevManagedFor(status, discovered.zone.id)),
    ));
    await mergeRefusedPermissions(paths, discovery, true);

    const nowIso = new Date(now()).toISOString();
    const hasAnyChangeOrConflict = evaluated.some((entry) => entry.changes.length > 0 || entry.conflicts.length > 0 || entry.error !== null)
      || discovery.ambiguous.length > 0;

    // When approving or updating defaults with zero zone changes and zero conflicts, approve directly.
    if (!hasAnyChangeOrConflict) {
      clearPending(paths);
      const knownZones = [...new Set([...config.knownZones, ...evaluated.map((entry) => entry.discovered.zoneKey)])].sort();
      writeEdgeConfig(paths, {
        ...config,
        defaults: nextDefaults,
        approved: true,
        approvedAt: nowIso,
        approvedDigest: edgeDefaultsDigest(nextDefaults),
        knownZones,
        migrationNote: null,
      });
      writeEdgeStatus(paths, {
        version: 1,
        checkedAt: nowIso,
        zones: evaluated.map((entry) => zoneStatusOf(entry, true)).sort((a, b) => a.zoneName.localeCompare(b.zoneName)),
        trackedManagedRules: updateTrackedManagedRules(
          status,
          evaluated,
          turnedOffRuleKeys(config.defaults, nextDefaults),
          config.knownZones,
        ),
        log: status.log,
      });
      return {
        notice: !currentlyApproved
          ? "Cloudflare edge defaults approved. Every reachable zone already matches; new zones will inherit them automatically."
          : "Cloudflare edge defaults saved. Every reachable zone already matches.",
      };
    }

    const kind: EdgePendingReview["kind"] = !currentlyApproved ? "approve" : "defaults";
    const { review, digest } = buildReview(kind, nextDefaults, evaluated, discovery.ambiguous);
    writePending(paths, {
      version: 1,
      token: review.token,
      digest,
      configHash: configHashOf(config),
      kind,
      nextDefaults,
      approve: true,
      expiresAt: now() + REVIEW_TTL_MS,
    });
    return { review };
  });
}

/** Prepares an explicit confirmation review for one held or pending zone. */
export async function reviewCloudflareEdgeZone(zoneKey: string, options: EdgeOptions = {}): Promise<EdgeReply> {
  if (typeof zoneKey !== "string" || !zoneKey.includes(":")) failAction("zoneKey is required");
  const paths = resolvePaths(options);
  const now = options.now ?? Date.now;
  return withEdgeLock(paths, async () => {
    const config = readEdgeConfig(options);
    if (!isApprovedActive(config)) {
      failAction("Approve Cloudflare edge defaults first before reviewing a single zone");
    }
    const status = readEdgeStatus(paths);
    const discovery = await discoverZones(paths, config, options, config.defaults);
    const target = discovery.zones.find((entry) => entry.zoneKey === zoneKey);
    if (!target) failAction("That Cloudflare zone is no longer reachable through a saved connection");

    const prevManaged = prevManagedFor(status, target.zone.id);
    const evaluated = await evaluateZone(target, config.defaults, null, prevManaged);
    await mergeRefusedPermissions(paths, discovery, false);

    if (!evaluated.error && evaluated.conflicts.length === 0 && evaluated.changes.length === 0) {
      const updatedZones = status.zones.map((zone) => zone.zoneKey === zoneKey ? zoneStatusOf(evaluated, true) : zone);
      writeEdgeStatus(paths, {
        ...status,
        checkedAt: new Date(now()).toISOString(),
        zones: updatedZones,
        trackedManagedRules: updateTrackedManagedRules(status, [evaluated]),
      });
      return { notice: `${target.zone.name} is already in sync.` };
    }

    const { review, digest } = buildReview("zone", config.defaults, [evaluated], [], zoneKey);
    writePending(paths, {
      version: 1,
      token: review.token,
      digest,
      configHash: configHashOf(config),
      kind: "zone",
      nextDefaults: config.defaults,
      approve: true,
      zoneKey,
      expiresAt: now() + REVIEW_TTL_MS,
    });
    return { review };
  });
}

/** Confirms a pending review token after re-verifying live Cloudflare state and digest. */
export async function confirmCloudflareEdge(token: string, options: EdgeOptions = {}): Promise<EdgeReply> {
  if (typeof token !== "string" || !/^[a-f0-9]{32}$/.test(token)) failAction("the review token is invalid");
  const paths = resolvePaths(options);
  const now = options.now ?? Date.now;
  return withEdgeLock(paths, async () => {
    const pending = readPending(paths);
    if (!pending) failAction("No pending Cloudflare edge review was found; review again");
    const a = Buffer.from(pending.token, "utf8");
    const b = Buffer.from(token, "utf8");
    if (a.length !== b.length || !timingSafeEqual(a, b)) failAction("That review is no longer current; review again");
    if (now() > pending.expiresAt) {
      clearPending(paths);
      failAction("That review expired; review again to see fresh changes");
    }

    const config = readEdgeConfig(options);
    if (configHashOf(config) !== pending.configHash) {
      clearPending(paths);
      failAction("Cloudflare edge settings changed since this review was prepared; review again");
    }
    if (pending.kind === "zone" && !isApprovedActive(config)) {
      clearPending(paths);
      failAction("Approve Cloudflare edge defaults first before applying changes to a single zone");
    }

    const status = readEdgeStatus(paths);
    const discovery = await discoverZones(paths, config, options, pending.nextDefaults);
    const scopedZones = pending.kind === "zone"
      ? discovery.zones.filter((entry) => entry.zoneKey === pending.zoneKey)
      : discovery.zones;
    if (pending.kind === "zone" && scopedZones.length === 0) {
      clearPending(paths);
      failAction("That Cloudflare zone is no longer reachable");
    }

    const prevDefaults = pending.kind === "zone" ? null : config.defaults;
    const evaluated = await Promise.all(scopedZones.map((discovered) =>
      evaluateZone(discovered, pending.nextDefaults, prevDefaults, prevManagedFor(status, discovered.zone.id)),
    ));

    const fresh = buildReview(
      pending.kind,
      pending.nextDefaults,
      evaluated,
      pending.kind === "zone" ? [] : discovery.ambiguous,
      pending.zoneKey,
    );
    if (fresh.digest !== pending.digest) {
      writePending(paths, { ...pending, token: fresh.review.token, digest: fresh.digest, expiresAt: now() + REVIEW_TTL_MS });
      return { review: fresh.review };
    }
    if (fresh.review.blocked) {
      failAction("Resolve the conflicting rules in Cloudflare before applying");
    }

    const nowIso = new Date(now()).toISOString();
    const cause = pending.kind === "approve" ? "Approved defaults"
      : pending.kind === "defaults" ? "Updated defaults"
        : "Confirmed review";
    const newLogs: EdgeLogEntry[] = [];
    const known = new Set(config.knownZones);
    const afterEvaluated: EvaluatedZone[] = [];
    let appliedZones = 0;
    let failedZones = 0;

    for (const entry of evaluated) {
      if (entry.error || entry.conflicts.length > 0 || entry.changes.length === 0) {
        if (!entry.error && entry.conflicts.length === 0) known.add(entry.discovered.zoneKey);
        afterEvaluated.push(entry);
        continue;
      }
      const result = await applyZoneChanges(entry, pending.nextDefaults, cause, nowIso);
      newLogs.push(...result.logged);
      if (result.error) failedZones++;
      else {
        if (result.logged.length > 0) appliedZones++;
        known.add(entry.discovered.zoneKey);
      }
      afterEvaluated.push(result.evaluated);
    }

    await mergeRefusedPermissions(paths, discovery, pending.kind !== "zone");
    clearPending(paths);

    const approveNow = pending.kind === "zone" ? isApprovedActive(config) : true;
    const nextConfig: EdgeConfig = pending.kind === "zone"
      ? { ...config, knownZones: [...known].sort() }
      : {
        ...config,
        defaults: pending.nextDefaults,
        approved: true,
        approvedAt: nowIso,
        approvedDigest: edgeDefaultsDigest(pending.nextDefaults),
        knownZones: [...known].sort(),
        migrationNote: null,
      };
    writeEdgeConfig(paths, nextConfig);

    const updatedMap = new Map(afterEvaluated.map((entry) => [entry.discovered.zoneKey, zoneStatusOf(entry, approveNow)]));
    const nextZoneStatuses = pending.kind === "zone"
      ? status.zones.map((zone) => updatedMap.get(zone.zoneKey) ?? zone)
      : [
        ...afterEvaluated.map((entry) => zoneStatusOf(entry, true)),
        ...discovery.ambiguous.map(ambiguousStatusOf),
      ].sort((a, b) => a.zoneName.localeCompare(b.zoneName));
    if (pending.kind === "zone" && !status.zones.some((zone) => zone.zoneKey === pending.zoneKey)) {
      const added = updatedMap.get(pending.zoneKey!);
      if (added) nextZoneStatuses.push(added);
      nextZoneStatuses.sort((a, b) => a.zoneName.localeCompare(b.zoneName));
    }

    writeEdgeStatus(paths, {
      version: 1,
      checkedAt: nowIso,
      zones: nextZoneStatuses,
      trackedManagedRules: updateTrackedManagedRules(
        status,
        afterEvaluated,
        pending.kind === "zone" ? [] : turnedOffRuleKeys(config.defaults, pending.nextDefaults),
        config.knownZones,
      ),
      log: [...newLogs.reverse(), ...status.log].slice(0, MAX_LOG_ENTRIES),
    });

    if (pending.kind === "zone") {
      const name = afterEvaluated[0]!.discovered.zone.name;
      if (failedZones > 0) failAction(`Could not apply changes to ${name}: ${afterEvaluated[0]!.error}`);
      return { notice: `Applied ${newLogs.length} change${newLogs.length === 1 ? "" : "s"} to ${name}.` };
    }
    const suffix = failedZones > 0 ? ` ${failedZones} zone${failedZones === 1 ? "" : "s"} had errors.` : "";
    const lead = pending.kind === "approve"
      ? "Cloudflare edge defaults approved."
      : "Cloudflare edge defaults updated.";
    const appliedText = appliedZones > 0
      ? ` Applied changes to ${appliedZones} zone${appliedZones === 1 ? "" : "s"}; new zones will inherit these defaults automatically.`
      : " New zones will inherit these defaults automatically.";
    return { notice: `${lead}${appliedText}${suffix}` };
  });
}

/** Picks which Cloudflare connection/zone manages an ambiguous zone name. */
export async function chooseCloudflareEdgeZone(
  body: Record<string, unknown>,
  options: EdgeOptions = {},
): Promise<EdgeReply> {
  const zone = typeof body.zone === "string" ? body.zone.trim().toLowerCase() : "";
  if (!dnsName(zone)) failAction("zone must be a valid domain name");
  const connId = connectionId(body.connectionId);
  const zId = cloudflareId(body.zoneId, "the zone identifier");
  const paths = resolvePaths(options);
  await withEdgeLock(paths, async () => {
    const config = readEdgeConfig(options);
    writeEdgeConfig(paths, {
      ...config,
      zoneChoices: { ...config.zoneChoices, [zone]: { connectionId: connId, zoneId: zId } },
    });
  });
  const checked = await checkCloudflareEdge(options, "Manual check");
  return { notice: `Selected connection for ${zone}. ${checked.notice}` };
}

// ---------------------------------------------------------------------------
// Setup checklist & Action needed (strictly local reads, zero network calls)
// ---------------------------------------------------------------------------

export function edgeSetupCheck(options?: EdgeOptions): SetupCheck {
  const paths = resolvePaths(options);
  const connected = listCloudflareSecrets(cfPathsOf(paths)).length > 0;
  if (!connected) return { state: "na", reason: "No Cloudflare connection is saved" };
  const config = readEdgeConfig(options);
  if (isApprovedActive(config)) {
    return { state: "done", reason: describeEdgeDefaults(config.defaults) };
  }
  return { state: "todo", reason: "Review and approve Cloudflare edge defaults once so new zones inherit them automatically" };
}

export function edgeActionNeeded(options?: EdgeOptions): ActionNeeded[] {
  const paths = resolvePaths(options);
  const store = readCloudflareStore(cfPathsOf(paths));
  const secrets = listCloudflareSecrets(cfPathsOf(paths));
  if (!secrets.length) return [];
  const config = readEdgeConfig(options);
  const status = readEdgeStatus(paths);
  const items: ActionNeeded[] = [];

  if (isApprovedActive(config)) {
    for (const connection of store.connections) {
      if (!store.tokens[connection.id]) continue;
      const report = store.reports.find((entry) => entry.id === connection.id);
      if (!report?.active) continue;
      const { missing } = connectionPermissions(report, config.defaults, {
        includeDns: false,
        includeEdge: true,
        requirePanelGate: false,
      });
      if (!missing.length) continue;
      items.push({
        title: missing.length > 1 ? "Cloudflare token needs edge permissions" : "Cloudflare token needs an edge permission",
        reason: `${connection.label}'s token lacks ${missing.join(", ")}, which Firewall's Cloudflare edge defaults need; add ${missing.length > 1 ? "them" : "it"} to the token in Cloudflare`,
        href: "/addons/firewall/#fw-edge-card",
      });
    }
  }

  const guarded = status.zones.filter((zone) => zone.status === "needs_review" || zone.status === "conflict");
  if (guarded.length > 0) {
    const names = guarded.slice(0, 3).map((zone) => zone.zoneName).join(", ");
    const more = guarded.length > 3 ? ` and ${guarded.length - 3} more` : "";
    items.push({
      title: "Cloudflare edge changes need review",
      reason: `${names}${more} ${guarded.length === 1 ? "has" : "have"} destructive edge changes or rule conflicts waiting for confirmation`,
      href: "/addons/firewall/#fw-edge-card",
    });
  }

  return items;
}

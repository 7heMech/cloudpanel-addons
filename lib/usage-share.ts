// Opt-in usage sharing: once root says yes, the daily update check also
// carries a random install ID, the enabled addons, the CloudPanel version and
// how often each addon action ran since the last send. See
// docs/decisions/releases.md.
import { randomBytes } from "node:crypto";
import { accessSync, constants, rmSync } from "node:fs";
import { dirname } from "node:path";
import { panelVersion, upstreamVersion } from "./cloudpanel-version";
import { withFileLock, withFileLockSync } from "./file-lock";
import { addonStateDir, LOCK_DIR } from "./paths";
import { readState, writeState } from "./root-state";
import { checkRequest, type CheckRequest, type UsageReport } from "./update-check";
import { countedActions } from "./usage-actions";
import { CLI_VERSION } from "./version";

export const USAGE_SHARING_FILE = `${addonStateDir("manager")}/usage-sharing.json`;
export const USAGE_ACTIVITY_FILE = `${addonStateDir("manager")}/usage-activity.json`;
export const USAGE_SHARING_LOCK = `${LOCK_DIR}/usage-sharing.lock`;
export const FORGET_URL = "https://clp.7he.dev/forget";
/** The most one action counts between two sends; the Worker clamps to the same. */
export const MAX_ACTION_COUNT = 10_000;
const ID_RE = /^[0-9a-f]{32}$/;
const SEND_TIMEOUT_MS = 5000;
const LOCK_WAIT_S = 15;
const LOCK_BUSY = "another usage-sharing update is still running";
/** Shown in place of the ID until one exists. */
export const ID_PLACEHOLDER = "(a random ID, made when you turn this on)";

export interface UsagePaths {
  file?: string;
  activityFile?: string;
  lockFile?: string;
  uid?: number;
}

function paths(options: UsagePaths = {}) {
  const file = options.file ?? USAGE_SHARING_FILE;
  return {
    file,
    activityFile: options.activityFile ?? (file === USAGE_SHARING_FILE ? USAGE_ACTIVITY_FILE : `${file}.activity`),
    lockFile: options.lockFile ?? (file === USAGE_SHARING_FILE ? USAGE_SHARING_LOCK : `${file}.lock`),
    uid: options.uid ?? 0,
  };
}

export interface UsageSharingState {
  answered: boolean;
  enabled: boolean;
  /** Present only while enabled. */
  id: string | null;
  /** An ID whose data the Worker has not yet confirmed deleting. */
  forget: string | null;
  lastSentAt: string | null;
}

export type Activity = Record<string, Record<string, number>>;

const str = (value: unknown) => typeof value === "string" && value ? value : null;
const validId = (value: unknown) => typeof value === "string" && ID_RE.test(value) ? value : null;

export function readUsageSharing(options: UsagePaths = {}): UsageSharingState {
  const { file, uid } = paths(options);
  const raw = readState<Record<string, unknown> | null>(file, uid, () => null) ?? {};
  const enabled = raw.answered === true && raw.enabled === true && validId(raw.id) !== null;
  return {
    answered: raw.answered === true,
    enabled,
    id: enabled ? validId(raw.id) : null,
    forget: validId(raw.forget),
    lastSentAt: str(raw.lastSentAt),
  };
}

/** Saves root's answer. Saying no drops the ID and counts and queues the deletion of what was sent. */
export function saveUsageSharing(enabled: boolean, options: UsagePaths = {}): UsageSharingState {
  const { file, activityFile, lockFile, uid } = paths(options);
  return withFileLockSync(lockFile, LOCK_WAIT_S, LOCK_BUSY, () => {
    const current = readUsageSharing(options);
    const state: UsageSharingState = enabled
      ? { ...current, answered: true, enabled: true, id: current.id ?? randomBytes(16).toString("hex") }
      : { ...current, answered: true, enabled: false, id: null, forget: current.id ?? current.forget, lastSentAt: null };
    writeState(file, state, uid);
    if (!enabled) rmSync(activityFile, { force: true });
    return state;
  });
}

/** Asks the Worker to delete what an opted-out ID sent; true once it confirmed. */
export async function sendForget(options: UsagePaths & { fetch?: typeof fetch } = {}): Promise<boolean> {
  const { file, lockFile, uid } = paths(options);
  try {
    const { forget } = readUsageSharing(options);
    if (!forget) return true;
    const res = await (options.fetch ?? fetch)(FORGET_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": `clp-addons/${CLI_VERSION.replace(/^v/, "")}` },
      body: JSON.stringify({ id: forget }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (res.status !== 200) return false;
    await withFileLock(lockFile, LOCK_WAIT_S, LOCK_BUSY, async () => {
      const latest = readUsageSharing(options);
      if (latest.forget === forget) writeState(file, { ...latest, forget: null }, uid);
    });
    return true;
  } catch {
    return false;
  }
}

export function readActivity(options: UsagePaths = {}): Activity {
  const { activityFile, uid } = paths(options);
  const raw = readState<unknown>(activityFile, uid, () => null);
  const allowed = countedActions();
  const activity: Activity = {};
  if (!raw || typeof raw !== "object") return activity;
  for (const [addon, verbs] of Object.entries(raw as Record<string, unknown>)) {
    if (!Object.hasOwn(allowed, addon) || !verbs || typeof verbs !== "object") continue;
    for (const [verb, count] of Object.entries(verbs as Record<string, unknown>)) {
      if (!allowed[addon]!.includes(verb) || typeof count !== "number" || !Number.isInteger(count) || count <= 0) continue;
      (activity[addon] ??= {})[verb] = Math.min(count, MAX_ACTION_COUNT);
    }
  }
  return activity;
}

/**
 * One more run of an addon action, while sharing is on. Called by the root
 * gateway after it answered; anything that goes wrong is dropped.
 */
export async function countAction(addon: string, verb: string, options: UsagePaths = {}): Promise<void> {
  try {
    if (!countedActions()[addon]?.includes(verb)) return;
    const { activityFile, lockFile, uid } = paths(options);
    if (!readUsageSharing(options).enabled) return;
    await withFileLock(lockFile, 2, LOCK_BUSY, async () => {
      if (!readUsageSharing(options).enabled) return;
      const activity = readActivity(options);
      const verbs = activity[addon] ??= {};
      verbs[verb] = Math.min((verbs[verb] ?? 0) + 1, MAX_ACTION_COUNT);
      writeState(activityFile, activity, uid);
    });
  } catch {}
}

/** Takes what was sent off the counts, keeping what ran while it was sent. */
export function settleActivity(sent: Activity, now: Date = new Date(), options: UsagePaths = {}): void {
  const { file, activityFile, lockFile, uid } = paths(options);
  withFileLockSync(lockFile, LOCK_WAIT_S, LOCK_BUSY, () => {
    const state = readUsageSharing(options);
    if (!state.enabled) return;
    const activity = readActivity(options);
    for (const [addon, verbs] of Object.entries(sent)) {
      for (const [verb, count] of Object.entries(verbs)) {
        const left = (activity[addon]?.[verb] ?? 0) - count;
        if (left > 0) activity[addon]![verb] = left;
        else if (activity[addon]) delete activity[addon][verb];
      }
      if (activity[addon] && !Object.keys(activity[addon]).length) delete activity[addon];
    }
    writeState(activityFile, activity, uid);
    writeState(file, { ...state, lastSentAt: now.toISOString() }, uid);
  });
}

/** `addons` are the enabled addons' names; lib/ cannot read the catalog. */
export function usageReport(
  addons: string[],
  options: UsagePaths = {},
  cloudpanel: string | null = panelVersion(),
): UsageReport | null {
  const state = readUsageSharing(options);
  if (!state.enabled || !state.id) return null;
  return {
    id: state.id,
    cloudpanel: cloudpanel ? upstreamVersion(cloudpanel) || null : null,
    addons: [...addons].sort(),
    activity: readActivity(options),
  };
}

export interface UsageSharingStatus {
  answered: boolean;
  enabled: boolean;
  lastSentAt: string | null;
  /** The daily check's body as this server would send it today. */
  payload: CheckRequest;
}

export function usageSharingStatus(
  addons: string[],
  options: UsagePaths = {},
  cloudpanel: string | null = panelVersion(),
  version = CLI_VERSION,
  arch: string = process.arch,
): UsageSharingStatus {
  const state = readUsageSharing(options);
  const usage = usageReport(addons, options, cloudpanel) ?? {
    id: ID_PLACEHOLDER,
    cloudpanel: cloudpanel ? upstreamVersion(cloudpanel) || null : null,
    addons: [...addons].sort(),
    activity: {},
  };
  return { answered: state.answered, enabled: state.enabled, lastSentAt: state.lastSentAt, payload: checkRequest(version, arch, usage) };
}

function isPermissionDenied(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "EACCES" || code === "EPERM";
}

function unreadableReason(file: string): string | null {
  for (const [path, mode] of [[dirname(file), constants.X_OK], [file, constants.R_OK]] as const) {
    try {
      accessSync(path, mode);
    } catch (error) {
      if (isPermissionDenied(error)) return `run as root to read ${file}`;
      if (path !== file) return null;
    }
  }
  return null;
}

/** Human-readable output for `clp-addons share-usage status`. */
export function formatUsageSharingStatus(addons: string[], options: UsagePaths = {}): string {
  const { file } = paths(options);
  const blocked = unreadableReason(file);
  if (blocked) return `Usage sharing: unreadable (${blocked})`;
  const status = usageSharingStatus(addons, options);
  const lines = [`Usage sharing: ${!status.answered ? "off (not answered yet)" : status.enabled ? "on" : "off"}`];
  if (status.lastSentAt) lines.push(`Last sent: ${status.lastSentAt}`);
  const { usage, ...required } = status.payload;
  lines.push("Sent once a day by every server:", JSON.stringify(required, null, 2));
  lines.push(status.enabled ? "Also sent, since sharing is on:" : "Also sent if sharing is turned on:", JSON.stringify({ usage }, null, 2));
  return lines.join("\n");
}

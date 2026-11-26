// Opt-in addon usage sharing: once a week, which addons a server has enabled.
// Nothing is sent until root saves an answer that says yes.
import { createHash } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { dirname } from "node:path";
import { panelVersion, upstreamVersion } from "./cloudpanel-version";
import { addonStateDir } from "./paths";
import { readState, writeState } from "./root-state";
import { CLI_VERSION } from "./version";

export const USAGE_SHARING_FILE = `${addonStateDir("manager")}/usage-sharing.json`;
export const USAGE_URL = "https://clp.7he.dev/usage";
const SEND_TIMEOUT_MS = 3000;

export interface UsageSharingState {
  answered: boolean;
  enabled: boolean;
  lastSentAt: string | null;
  lastSentWeek: string | null;
  lastSentHash: string | null;
}

/** Everything that is sent, and nothing else. */
export interface UsagePayload {
  version: string;
  cloudpanel: string | null;
  arch: string;
  addons: string[];
}

export interface UsageSharingStatus {
  answered: boolean;
  enabled: boolean;
  lastSentAt: string | null;
  payload: UsagePayload;
}

const str = (value: unknown) => typeof value === "string" && value ? value : null;

export function readUsageSharing(file = USAGE_SHARING_FILE, uid = 0): UsageSharingState {
  const raw = readState<Record<string, unknown> | null>(file, uid, () => null) ?? {};
  return {
    answered: raw.answered === true,
    enabled: raw.answered === true && raw.enabled === true,
    lastSentAt: str(raw.lastSentAt),
    lastSentWeek: str(raw.lastSentWeek),
    lastSentHash: str(raw.lastSentHash),
  };
}

export function saveUsageSharing(enabled: boolean, file = USAGE_SHARING_FILE, uid = 0): UsageSharingState {
  const state = { ...readUsageSharing(file, uid), answered: true, enabled };
  writeState(file, state, uid);
  return state;
}

/** `addons` are the enabled addons' names; lib/ cannot read the catalog. */
export function usagePayload(
  addons: string[],
  version = CLI_VERSION,
  cloudpanel: string | null = panelVersion(),
  arch: string = process.arch,
): UsagePayload {
  return {
    version: version.replace(/^v/, ""),
    cloudpanel: cloudpanel ? upstreamVersion(cloudpanel) || null : null,
    arch,
    addons: [...addons].sort(),
  };
}

export function usageSharingStatus(payload: UsagePayload, file = USAGE_SHARING_FILE, uid = 0): UsageSharingStatus {
  const { answered, enabled, lastSentAt } = readUsageSharing(file, uid);
  return { answered, enabled, lastSentAt, payload };
}

function isPermissionDenied(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "EACCES" || code === "EPERM";
}

function unreadableReason(file: string): string | null {
  try {
    accessSync(dirname(file), constants.X_OK);
  } catch (error) {
    if (isPermissionDenied(error)) return `run as root to read ${file}`;
    return null;
  }
  try {
    accessSync(file, constants.R_OK);
  } catch (error) {
    if (isPermissionDenied(error)) return `run as root to read ${file}`;
  }
  return null;
}

/** Human-readable output for `clp-addons share-usage status`. */
export function formatUsageSharingStatus(payload: UsagePayload, file = USAGE_SHARING_FILE, uid = 0): string {
  const lines: string[] = [];
  const blocked = unreadableReason(file);
  if (blocked) {
    lines.push(`Usage sharing: unreadable (${blocked})`);
  } else {
    const status = usageSharingStatus(payload, file, uid);
    const label = !status.answered ? "off (not answered yet)" : status.enabled ? "on" : "off";
    lines.push(`Usage sharing: ${label}`);
    if (status.lastSentAt) lines.push(`Last sent: ${status.lastSentAt}`);
  }
  lines.push("Payload:");
  lines.push(JSON.stringify(payload, null, 2));
  return lines.join("\n");
}

/** `2026-W48`: the ISO 8601 week, whose year can differ from the calendar year's. */
export function isoWeek(date: Date): string {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  day.setUTCDate(day.getUTCDate() + 4 - (day.getUTCDay() || 7));
  const week = Math.ceil(((day.getTime() - Date.UTC(day.getUTCFullYear(), 0, 1)) / 86_400_000 + 1) / 7);
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** Kept locally to skip a repeat; never sent. */
export function payloadHash(payload: UsagePayload): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export interface ShareOptions {
  file?: string;
  uid?: number;
  now?: Date;
  fetch?: typeof fetch;
}

/**
 * Sends the payload when sharing is on and this week has not seen the same
 * one. Never throws: whether it was sent is the answer.
 */
export async function shareUsageIfDue(payloadOf: () => UsagePayload, options: ShareOptions = {}): Promise<boolean> {
  const file = options.file ?? USAGE_SHARING_FILE;
  const uid = options.uid ?? 0;
  try {
    const state = readUsageSharing(file, uid);
    if (!state.answered || !state.enabled) return false;
    const now = options.now ?? new Date();
    const payload = payloadOf();
    const week = isoWeek(now);
    const hash = payloadHash(payload);
    if (state.lastSentWeek === week && state.lastSentHash === hash) return false;
    const res = await (options.fetch ?? fetch)(USAGE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": `clp-addons/${payload.version}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const latest = readUsageSharing(file, uid);
    if (!latest.enabled) return true;
    writeState(file, { ...latest, lastSentAt: now.toISOString(), lastSentWeek: week, lastSentHash: hash }, uid);
    return true;
  } catch {
    return false;
  }
}

// One update check a day, run as root by the repair timer and right after an
// install or update. The answer is saved where the manager and the menu read
// it, so a page view never touches the network. See docs/decisions/releases.md.

import { DEV_VERSION, CLI_VERSION } from "./version";
import { compareSemver, isPrerelease, newestRelease, VERSION_TAG_RE } from "./semver";
import { trustedText } from "./trusted-file";
import { writeFileAtomic } from "./atomic-write";
import { withFileLock } from "./file-lock";
import { LOCK_DIR, REPO, STATE_DIR } from "./paths";

export interface CliUpdateInfo {
  current: string;
  latest: string;
  hasUpdate: boolean;
  /** The Worker marked a release between this one and `latest` as urgent, such as a security fix. */
  urgent?: boolean;
}

export const CHECK_URL = "https://clp.7he.dev/check";
/** Root writes it, mode 0644; the manager reads it through the state directory's group. */
export const UPDATE_ANSWER_FILE = `${STATE_DIR}/update-check.json`;
export const UPDATE_CHECK_LOCK = `${LOCK_DIR}/update-check.lock`;
const TIMEOUT_MS = 5000;
/** After a check that reached nothing, the next fifteen-minute run waits this long. */
const RETRY_MS = 60 * 60 * 1000;

/** The opt-in part of a check, present only once root said yes. */
export interface UsageReport {
  id: string;
  cloudpanel: string | null;
  addons: string[];
  activity: Record<string, Record<string, number>>;
}

/** The body POSTed to CHECK_URL; worker/index.ts parses the same shape. */
export interface CheckRequest {
  version: string;
  channel: "stable" | "prerelease";
  arch: string;
  usage?: UsageReport;
}

/** The Worker's answer. `latest` is the release this server should be on, which may trail the newest one. */
export interface CheckAnswer {
  latest: string;
  update: boolean;
  urgent: boolean;
  usage: "saved" | "refused" | "none";
}

export interface SavedAnswer {
  /** The UTC day of the last check that got an answer. */
  day: string | null;
  checkedAt: string | null;
  /** The version that asked. */
  version: string | null;
  latest: string | null;
  update: boolean;
  urgent: boolean;
  source: "worker" | "github" | null;
  failedAt: string | null;
}

const EMPTY: SavedAnswer = { day: null, checkedAt: null, version: null, latest: null, update: false, urgent: false, source: null, failedAt: null };

export function isNewerVersion(candidate: string, current: string): boolean {
  return compareSemver(candidate, current) > 0;
}

const bare = (version: string) => version.replace(/^v/, "");
const str = (value: unknown) => typeof value === "string" && value ? value : null;
export const utcDay = (date: Date) => date.toISOString().slice(0, 10);

export function checkRequest(version: string, arch: string = process.arch, usage?: UsageReport | null): CheckRequest {
  return {
    version: bare(version),
    channel: isPrerelease(version) ? "prerelease" : "stable",
    arch,
    ...(usage ? { usage } : {}),
  };
}

export function parseCheckAnswer(value: unknown): CheckAnswer | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (typeof body.latest !== "string" || !VERSION_TAG_RE.test(`v${body.latest}`)) return null;
  if (typeof body.update !== "boolean" || typeof body.urgent !== "boolean") return null;
  const usage = body.usage === "saved" || body.usage === "refused" ? body.usage : "none";
  return { latest: body.latest, update: body.update, urgent: body.urgent, usage };
}

export function readSavedAnswer(file = UPDATE_ANSWER_FILE, uid = 0): SavedAnswer {
  try {
    const raw = JSON.parse(trustedText(file, uid) ?? "null") as Record<string, unknown> | null;
    if (!raw || typeof raw !== "object") return { ...EMPTY };
    const latest = str(raw.latest);
    return {
      day: str(raw.day),
      checkedAt: str(raw.checkedAt),
      version: str(raw.version),
      latest: latest && VERSION_TAG_RE.test(`v${latest}`) ? latest : null,
      update: raw.update === true,
      urgent: raw.urgent === true,
      source: raw.source === "worker" || raw.source === "github" ? raw.source : null,
      failedAt: str(raw.failedAt),
    };
  } catch {
    return { ...EMPTY };
  }
}

/** What the manager's pages and the menu show; never touches the network. */
export function savedUpdate(currentVersion: string = CLI_VERSION, file = UPDATE_ANSWER_FILE, uid = 0): CliUpdateInfo | null {
  if (!currentVersion || currentVersion === DEV_VERSION) return null;
  const saved = readSavedAnswer(file, uid);
  if (!saved.latest) return null;
  const current = bare(currentVersion);
  // An answer for another version (a binary swapped by hand) still says which release is out.
  const hasUpdate = isNewerVersion(saved.latest, current) && (saved.update || saved.version !== current);
  return { current, latest: saved.latest, hasUpdate, ...(hasUpdate && saved.urgent ? { urgent: true } : {}) };
}

async function askWorker(body: CheckRequest, fetcher: typeof fetch): Promise<CheckAnswer | null> {
  try {
    const res = await fetcher(CHECK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": `clp-addons/${body.version}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status !== 200) return null;
    return parseCheckAnswer(await res.json());
  } catch {
    return null;
  }
}

async function askGithub(repo: string, currentVersion: string, fetcher: typeof fetch): Promise<string | null> {
  try {
    // "latest" is never a pre-release, so a box running one reads the list.
    const prerelease = isPrerelease(currentVersion);
    const res = await fetcher(`https://api.github.com/repos/${repo}/releases${prerelease ? "?per_page=100" : "/latest"}`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "clp-addons" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data: unknown = res.ok ? await res.json() : null;
    const tag = prerelease
      ? newestRelease(Array.isArray(data) ? data as { tag_name: string; draft: boolean }[] : [])?.tag_name
      : (data as { tag_name?: string } | null)?.tag_name;
    return tag && VERSION_TAG_RE.test(tag) ? bare(tag) : null;
  } catch {
    return null;
  }
}

export interface DailyCheckOptions {
  now?: Date;
  fetch?: typeof fetch;
  file?: string;
  /** Who must own `file`; root outside tests. */
  uid?: number;
  lockFile?: string;
  repo?: string;
  version?: string;
  arch?: string;
  /** The opt-in part, or null while root has not said yes. */
  usage?: () => UsageReport | null;
  /** Called once the Worker stored the opt-in part, with what was sent. */
  onUsageSaved?: (sent: UsageReport) => void;
}

/** A new version, as after an install or update, asks at once; otherwise once a UTC day. */
export function checkDue(saved: SavedAnswer, version: string, now: Date): boolean {
  if (saved.version !== bare(version)) return true;
  if (saved.day === utcDay(now)) return false;
  const failed = saved.failedAt ? Date.parse(saved.failedAt) : NaN;
  return !(now.getTime() - failed < RETRY_MS);
}

/**
 * Asks once per UTC day: the Worker for the default repository, GitHub when it
 * fails or for any other repository. Never throws; null when nothing was asked.
 */
export async function runDailyCheck(options: DailyCheckOptions = {}): Promise<SavedAnswer | null> {
  const version = options.version ?? CLI_VERSION;
  if (!version || version === DEV_VERSION) return null;
  const file = options.file ?? UPDATE_ANSWER_FILE;
  const fetcher = options.fetch ?? fetch;
  const repo = options.repo ?? REPO;
  try {
    return await withFileLock(options.lockFile ?? UPDATE_CHECK_LOCK, 0, "an update check is already running", async () => {
      const now = options.now ?? new Date();
      const saved = readSavedAnswer(file, options.uid ?? 0);
      if (!checkDue(saved, version, now)) return null;

      let usage: UsageReport | null = null;
      let answer: CheckAnswer | null = null;
      if (repo === REPO) {
        try { usage = options.usage?.() ?? null; } catch { usage = null; }
        answer = await askWorker(checkRequest(version, options.arch, usage), fetcher);
      }
      let next: SavedAnswer;
      if (answer) {
        if (usage && answer.usage === "saved") {
          try { options.onUsageSaved?.(usage); } catch {}
        }
        next = { day: utcDay(now), checkedAt: now.toISOString(), version: bare(version), latest: answer.latest, update: answer.update, urgent: answer.urgent, source: "worker", failedAt: null };
      } else {
        const latest = await askGithub(repo, version, fetcher);
        next = latest
          ? { day: utcDay(now), checkedAt: now.toISOString(), version: bare(version), latest, update: isNewerVersion(latest, version), urgent: false, source: "github", failedAt: null }
          : { ...saved, failedAt: now.toISOString() };
      }
      writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o644, createParent: true });
      return next;
    });
  } catch {
    return null;
  }
}

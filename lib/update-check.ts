// The manager asks on every request it serves, so the answer is cached for 15
// minutes and refreshed by one call at a time.

import { DEV_VERSION } from "./version";
import { compareSemver, isPrerelease, newestRelease } from "./semver";

export interface CliUpdateInfo {
  current: string;
  latest: string;
  hasUpdate: boolean;
}

const DEFAULT_REPO = "7heMech/cloudpanel-addons";
export const WORKER_RELEASES_URL = "https://clp.7he.dev/releases.json";
const CACHE_TTL_MS = 15 * 60 * 1000;

interface WorkerRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
}

let cachedUpdate: { at: number; info: CliUpdateInfo | null } | null = null;

let refreshing: Promise<CliUpdateInfo | null> | null = null;

let generation = 0;

export function isNewerVersion(candidate: string, current: string): boolean {
  return compareSemver(candidate, current) > 0;
}

function isWorkerRelease(value: unknown): value is WorkerRelease {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.tag_name === "string"
    && typeof entry.draft === "boolean"
    && typeof entry.prerelease === "boolean";
}

async function fetchWorkerTag(
  currentVersion: string,
  includePrereleases: boolean,
  timeoutMs: number,
): Promise<string | null> {
  try {
    const res = await fetch(WORKER_RELEASES_URL, {
      headers: {
        "User-Agent": `clp-addons/${currentVersion.replace(/^v/, "")}`,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status !== 200) return null;
    const data: unknown = await res.json();
    if (!Array.isArray(data)) return null;
    const releases = data.filter(isWorkerRelease);
    const eligible = includePrereleases
      ? releases
      : releases.filter((release) => !release.prerelease && !isPrerelease(release.tag_name));
    const tag = newestRelease(eligible)?.tag_name ?? "";
    return tag.replace(/^v/, "") || null;
  } catch {
    return null;
  }
}

async function fetchGithubTag(
  repo: string,
  prerelease: boolean,
  timeoutMs: number,
): Promise<string | null> {
  try {
    // "latest" is never a pre-release, so a box running one reads the list.
    const res = await fetch(`https://api.github.com/repos/${repo}/releases${prerelease ? "?per_page=100" : "/latest"}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "clp-addons",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data: unknown = res.ok ? await res.json() : null;
    const tag = prerelease
      ? newestRelease(Array.isArray(data) ? data as { tag_name: string; draft: boolean }[] : [])?.tag_name
      : (data as { tag_name?: string } | null)?.tag_name;
    return (tag ?? "").replace(/^v/, "") || null;
  } catch {
    return null;
  }
}

async function fetchLatestRelease(
  currentVersion: string,
  repo: string,
  timeoutMs: number,
): Promise<CliUpdateInfo | null> {
  const started = generation;
  let info: CliUpdateInfo | null = null;
  const prerelease = isPrerelease(currentVersion);
  const remoteTag = (repo === DEFAULT_REPO ? await fetchWorkerTag(currentVersion, prerelease, timeoutMs) : null)
    ?? await fetchGithubTag(repo, prerelease, timeoutMs);
  if (remoteTag) {
    info = {
      current: currentVersion.replace(/^v/, ""),
      latest: remoteTag,
      hasUpdate: isNewerVersion(remoteTag, currentVersion),
    };
  }
  if (started === generation) cachedUpdate = { at: Date.now(), info };
  return info;
}

export async function checkCliUpdate(
  currentVersion: string,
  repo: string = DEFAULT_REPO,
  timeoutMs = 2500
): Promise<CliUpdateInfo | null> {
  if (!currentVersion || currentVersion === DEV_VERSION) {
    return null;
  }

  const cached = cachedUpdate;
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.info;
  }

  let refresh = refreshing;
  if (!refresh) {
    refresh = fetchLatestRelease(currentVersion, repo, timeoutMs).finally(() => {
      if (refreshing === refresh) refreshing = null;
    });
    refreshing = refresh;
  }
  return cached ? cached.info : refresh;
}

export function resetUpdateCache(): void {
  generation++;
  cachedUpdate = null;
  refreshing = null;
}

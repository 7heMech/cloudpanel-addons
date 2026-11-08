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
const CACHE_TTL_MS = 15 * 60 * 1000;

let cachedUpdate: { at: number; info: CliUpdateInfo | null } | null = null;

let refreshing: Promise<CliUpdateInfo | null> | null = null;

let generation = 0;

export function isNewerVersion(candidate: string, current: string): boolean {
  return compareSemver(candidate, current) > 0;
}

async function fetchLatestRelease(
  currentVersion: string,
  repo: string,
  timeoutMs: number,
): Promise<CliUpdateInfo | null> {
  const started = generation;
  let info: CliUpdateInfo | null = null;
  try {
    // "latest" is never a pre-release, so a box running one reads the list.
    const prerelease = isPrerelease(currentVersion);
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
    const remoteTag = (tag ?? "").replace(/^v/, "");
    if (remoteTag) {
      info = {
        current: currentVersion.replace(/^v/, ""),
        latest: remoteTag,
        hasUpdate: isNewerVersion(remoteTag, currentVersion),
      };
    }
  } catch {
    info = null;
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

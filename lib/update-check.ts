// Check for newer clp-addons releases.
//
// Queried by the CLI overview and web UI to notify operators when a new
// release is available. The manager asks on every request it serves, so the
// answer is cached for 15 minutes and refreshed by one call at a time.

export interface CliUpdateInfo {
  current: string;
  latest: string;
  hasUpdate: boolean;
}

const DEFAULT_REPO = "7heMech/cloudpanel-addons";
const CACHE_TTL_MS = 15 * 60 * 1000;

let cachedUpdate: { at: number; info: CliUpdateInfo | null } | null = null;

/** The refresh currently talking to GitHub, so concurrent misses share one. */
let refreshing: Promise<CliUpdateInfo | null> | null = null;

/**
 * Compare two semver strings (e.g. "0.9.4" and "0.9.3", or "v0.9.4" and "v0.9.3").
 * Returns > 0 if a > b, < 0 if a < b, 0 if equal.
 */
export function compareSemver(a: string, b: string): number {
  const cleanA = a.replace(/^v/, "").split("-")[0] ?? "";
  const cleanB = b.replace(/^v/, "").split("-")[0] ?? "";
  const pa = cleanA.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = cleanB.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** True when `candidate` is a newer version than `current`. */
export function isNewerVersion(candidate: string, current: string): boolean {
  return compareSemver(candidate, current) > 0;
}

/** Ask GitHub once. Every outcome fills the cache, a failure included. */
async function fetchLatestRelease(
  currentVersion: string,
  repo: string,
  timeoutMs: number,
): Promise<CliUpdateInfo | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "clp-addons",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    const data = res.ok ? ((await res.json()) as { tag_name?: string }) : null;
    const remoteTag = (data?.tag_name ?? "").replace(/^v/, "");
    const info: CliUpdateInfo | null = remoteTag
      ? {
          current: currentVersion.replace(/^v/, ""),
          latest: remoteTag,
          hasUpdate: isNewerVersion(remoteTag, currentVersion),
        }
      : null;
    cachedUpdate = { at: Date.now(), info };
    return info;
  } catch {
    cachedUpdate = { at: Date.now(), info: null };
    return null;
  }
}

/**
 * Check if a newer version of clp-addons is available on GitHub.
 * Returns null if offline, timed out, or unresolvable.
 *
 * Only the first check waits for GitHub; after that an expired entry is served
 * as it stands while one refresh runs behind it.
 */
export async function checkCliUpdate(
  currentVersion: string,
  repo: string = DEFAULT_REPO,
  timeoutMs = 2500
): Promise<CliUpdateInfo | null> {
  // Development builds never check or trigger update warnings
  if (!currentVersion || currentVersion === "0.0.0-dev") {
    return null;
  }

  const cached = cachedUpdate;
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.info;
  }

  const refresh =
    refreshing ??
    (refreshing = fetchLatestRelease(currentVersion, repo, timeoutMs).finally(() => {
      refreshing = null;
    }));
  return cached ? cached.info : refresh;
}

/** Reset cache, primarily used in test suites. */
export function resetUpdateCache(): void {
  cachedUpdate = null;
  refreshing = null;
}

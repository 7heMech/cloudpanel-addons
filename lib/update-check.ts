// Check for newer clp-addons releases.
//
// Queried by the CLI overview and web UI to notify operators when a new
// release is available. The manager asks on every request it serves, so the
// answer is cached in memory for 15 minutes, refreshed by one call at a time,
// and served as it stands while that refresh runs: past the first check,
// nothing here waits on GitHub or spends another of its anonymous rate limit.

export interface CliUpdateInfo {
  current: string;
  latest: string;
  hasUpdate: boolean;
}

const DEFAULT_REPO = "7heMech/cloudpanel-addons";
const CACHE_TTL_MS = 15 * 60 * 1000;

let cachedUpdate: { at: number; info: CliUpdateInfo | null } | null = null;

/**
 * The refresh currently talking to GitHub, if any.
 *
 * Without it, every request that arrived while the cache was cold started its
 * own call: one page load is several requests, each waiting the full timeout on
 * a box that cannot reach GitHub, and each spending one of the 60 anonymous
 * calls an hour that address is allowed.
 */
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

/**
 * Ask GitHub once and record the answer, good or bad.
 *
 * Every outcome fills the cache, including a failure, so an unreachable GitHub
 * is asked again on the next TTL rather than on the next request.
 */
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
    // Network failure, timeout, or offline: report nothing rather than throw.
    cachedUpdate = { at: Date.now(), info: null };
    return null;
  }
}

/**
 * Check if a newer version of clp-addons is available on GitHub.
 * Returns null if offline, timed out, or unresolvable.
 *
 * Only the very first check waits for GitHub. Once an answer has been recorded,
 * an expired entry is served as it stands while a single refresh runs behind it,
 * so no request after the first ever pays the network timeout. The manager calls
 * this on every request it serves, which is what makes that worth doing.
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

// Check for newer clp-addons releases.
//
// Queried by the CLI overview and web UI to notify operators when a new
// release is available. Cached in-memory with a 15-minute TTL so it never slows
// down requests or spams the GitHub API.

export interface CliUpdateInfo {
  current: string;
  latest: string;
  hasUpdate: boolean;
}

const DEFAULT_REPO = "7heMech/cloudpanel-addons";
const CACHE_TTL_MS = 15 * 60 * 1000;

let cachedUpdate: { at: number; info: CliUpdateInfo | null } | null = null;

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
 * Check if a newer version of clp-addons is available on GitHub.
 * Returns null if offline, timed out, or unresolvable.
 */
export async function checkCliUpdate(
  currentVersion: string,
  repo: string = DEFAULT_REPO,
  timeoutMs = 2500
): Promise<CliUpdateInfo | null> {
  if (cachedUpdate && Date.now() - cachedUpdate.at < CACHE_TTL_MS) {
    return cachedUpdate.info;
  }

  // Development builds never check or trigger update warnings
  if (!currentVersion || currentVersion === "0.0.0-dev") {
    return null;
  }

  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "clp-addons",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      cachedUpdate = { at: Date.now(), info: null };
      return null;
    }

    const data = (await res.json()) as { tag_name?: string };
    const remoteTag = (data.tag_name ?? "").replace(/^v/, "");
    if (!remoteTag) {
      cachedUpdate = { at: Date.now(), info: null };
      return null;
    }

    const hasUpdate = isNewerVersion(remoteTag, currentVersion);
    const info: CliUpdateInfo = {
      current: currentVersion.replace(/^v/, ""),
      latest: remoteTag,
      hasUpdate,
    };

    cachedUpdate = { at: Date.now(), info };
    return info;
  } catch {
    // Network failure, timeout, or offline: return cached or null without error
    cachedUpdate = { at: Date.now(), info: null };
    return null;
  }
}

/** Reset cache, primarily used in test suites. */
export function resetUpdateCache(): void {
  cachedUpdate = null;
}

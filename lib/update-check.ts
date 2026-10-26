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

/** Bumped by a reset, so a refresh it interrupted cannot write its answer. */
let generation = 0;

function precedence(value: string): { core: number[]; pre: string[] } {
  const version = value.replace(/^v/, "").split("+")[0] ?? "";
  const hyphen = version.indexOf("-");
  const core = (hyphen < 0 ? version : version.slice(0, hyphen)).split(".").map((n) => parseInt(n, 10) || 0);
  return { core, pre: hyphen < 0 ? [] : version.slice(hyphen + 1).split(".") };
}

/**
 * Compare two semver strings (e.g. "0.9.4" and "0.9.3", or "v0.9.4" and "v0.9.3"),
 * pre-releases in semver's order: 2.0.0-rc.1 < 2.0.0-rc.2 < 2.0.0.
 * Returns > 0 if a > b, < 0 if a < b, 0 if equal.
 */
export function compareSemver(a: string, b: string): number {
  const pa = precedence(a);
  const pb = precedence(b);
  for (let i = 0; i < 3; i++) {
    const diff = (pa.core[i] ?? 0) - (pb.core[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (!pa.pre.length || !pb.pre.length) return pb.pre.length - pa.pre.length;
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const numeric = [/^\d+$/.test(x), /^\d+$/.test(y)];
    if (numeric[0] && numeric[1]) return Number(x) - Number(y);
    if (numeric[0] !== numeric[1]) return numeric[0] ? -1 : 1;
    return x < y ? -1 : 1;
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
  const started = generation;
  let info: CliUpdateInfo | null = null;
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

  let refresh = refreshing;
  if (!refresh) {
    // Cleared by identity: a reset between start and settle may already have
    // put a newer refresh here, and this one must not throw that away.
    refresh = fetchLatestRelease(currentVersion, repo, timeoutMs).finally(() => {
      if (refreshing === refresh) refreshing = null;
    });
    refreshing = refresh;
  }
  return cached ? cached.info : refresh;
}

/** Reset cache, primarily used in test suites. */
export function resetUpdateCache(): void {
  generation++;
  cachedUpdate = null;
  refreshing = null;
}

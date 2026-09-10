// Available Instatic versions.
//
// Resolved from the registry rather than hardcoded, because a baked-in list
// goes stale the moment upstream tags a release and then silently offers
// versions that no longer exist. The registry is the same one the action
// binary pins; only the tag ever crosses the privilege boundary.

const REGISTRY = "https://ghcr.io";
const REPOSITORY = "corebunch/instatic";
const TOKEN_URL = `${REGISTRY}/token?scope=repository:${REPOSITORY}:pull&service=ghcr.io`;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const CACHE_TTL_MS = 15 * 60 * 1000;

// Stop following pages long before a runaway Link chain can hold the dashboard
// open. Far more than Instatic will have for years.
const MAX_PAGES = 20;

// A last-resort list so the New Site page still renders when the box has no
// outbound network. Deliberately not the source of truth, and the UI says so
// when it falls back to this rather than presenting it as the real list.
const FALLBACK = ["0.0.18"];

/** Where the list came from, because "update available" must not be claimed on a guess. */
export type TagSource = "registry" | "cache" | "fallback";

export interface AvailableTags {
  tags: string[];
  source: TagSource;
  /** Newest version the registry knows about, or null when the list is a guess. */
  latest: string | null;
}

let cache: { at: number; tags: string[] } | null = null;

function byVersionDesc(a: string, b: string): number {
  return Bun.semver.order(b, a);
}

/** True when `candidate` is a newer version than `current`. */
export function isNewerThan(candidate: string, current: string): boolean {
  if (!VERSION_RE.test(candidate) || !VERSION_RE.test(current)) return false;
  return byVersionDesc(candidate, current) < 0;
}

/**
 * The next page of a paginated tag listing, from the Link header.
 *
 * This is load-bearing rather than a nicety. The registry returns tags in push
 * order, so page one holds the *oldest* tags: with 20 tags today ghcr.io answers
 * in one response, but the moment the repository crosses the page limit the
 * newest releases move to the last page. Ignoring Link would not produce an
 * obviously broken dropdown -- it would keep offering an old version labelled
 * "(latest)", which is worse.
 */
function nextPageUrl(res: Response): string | null {
  const link = res.headers.get("link");
  if (!link) return null;
  const m = link.match(/<([^>]+)>\s*;\s*rel="?next"?/i);
  if (!m) return null;
  try {
    return new URL(m[1]!, REGISTRY).toString();
  } catch {
    return null;
  }
}

async function fetchAllTags(token: string): Promise<string[]> {
  let url: string | null = `${REGISTRY}/v2/${REPOSITORY}/tags/list?n=100`;
  const all: string[] = [];

  for (let page = 0; url && page < MAX_PAGES; page++) {
    const res: Response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`tags endpoint returned ${res.status}`);

    const { tags } = (await res.json()) as { tags?: string[] };
    all.push(...(tags ?? []));
    url = nextPageUrl(res);
  }
  return all;
}

export async function listAvailableTags(): Promise<AvailableTags> {
  const fresh = cache && Date.now() - cache.at < CACHE_TTL_MS;
  if (fresh && cache) return { tags: cache.tags, source: "registry", latest: cache.tags[0] ?? null };

  try {
    const tokenRes = await fetch(TOKEN_URL, { signal: AbortSignal.timeout(8000) });
    if (!tokenRes.ok) throw new Error(`token endpoint returned ${tokenRes.status}`);
    const { token } = (await tokenRes.json()) as { token?: string };
    if (!token) throw new Error("token endpoint returned no token");

    const versions = (await fetchAllTags(token)).filter((t) => VERSION_RE.test(t)).sort(byVersionDesc);
    if (versions.length === 0) throw new Error("registry listed no version-shaped tags");

    cache = { at: Date.now(), tags: versions };
    return { tags: versions, source: "registry", latest: versions[0]! };
  } catch (err) {
    console.error("[tags] could not list registry tags:", err instanceof Error ? err.message : err);
    // A stale cache is still a real answer from the registry; FALLBACK is not,
    // so it never gets to claim a newest version.
    if (cache) return { tags: cache.tags, source: "cache", latest: cache.tags[0] ?? null };
    return { tags: FALLBACK, source: "fallback", latest: null };
  }
}

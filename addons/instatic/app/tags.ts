// Resolved from the registry because a baked-in list goes stale the moment
// upstream tags a release. The registry is the one the action pins; only the
// tag crosses the privilege boundary.

const REGISTRY = "https://ghcr.io";
const REPOSITORY = "corebunch/instatic";
const TOKEN_URL = `${REGISTRY}/token?scope=repository:${REPOSITORY}:pull&service=ghcr.io`;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const CACHE_TTL_MS = 15 * 60 * 1000;
// An unreachable registry costs every page an 8 s timeout, so a failure is
// believed for a minute before it is tried again.
const FAILURE_TTL_MS = 60 * 1000;

// Stop following pages long before a runaway Link chain can hold the dashboard
// open. Far more than Instatic will have for years.
const MAX_PAGES = 20;

// So the New Site page still renders with no outbound network; the UI says
// when it falls back to this.
const FALLBACK = ["0.0.18"];

/** "Update available" must not be claimed on a guess. */
type TagSource = "registry" | "cache" | "fallback";

export interface AvailableTags {
  tags: string[];
  source: TagSource;
  /** Null when the list is a guess. */
  latest: string | null;
}

let cache: { at: number; tags: string[] } | null = null;
let failedAt = 0;

function unreachable(): AvailableTags {
  if (cache) return { tags: cache.tags, source: "cache", latest: cache.tags[0] ?? null };
  return { tags: FALLBACK, source: "fallback", latest: null };
}

export function resetTagCache(): void {
  cache = null;
  failedAt = 0;
}

function byVersionDesc(a: string, b: string): number {
  return Bun.semver.order(b, a);
}

export function isNewerThan(candidate: string, current: string): boolean {
  if (!VERSION_RE.test(candidate) || !VERSION_RE.test(current)) return false;
  return byVersionDesc(candidate, current) < 0;
}

/**
 * The registry returns tags in push order, so once the repository crosses the
 * page limit the newest releases are on the last page. Ignoring Link would
 * keep offering an old version labelled "(latest)".
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
  if (Date.now() - failedAt < FAILURE_TTL_MS) return unreachable();

  try {
    const tokenRes = await fetch(TOKEN_URL, { signal: AbortSignal.timeout(8000) });
    if (!tokenRes.ok) throw new Error(`token endpoint returned ${tokenRes.status}`);
    const { token } = (await tokenRes.json()) as { token?: string };
    if (!token) throw new Error("token endpoint returned no token");

    const versions = (await fetchAllTags(token)).filter((t) => VERSION_RE.test(t)).sort(byVersionDesc);
    if (versions.length === 0) throw new Error("registry listed no version-shaped tags");

    cache = { at: Date.now(), tags: versions };
    failedAt = 0;
    return { tags: versions, source: "registry", latest: versions[0]! };
  } catch (err) {
    console.error("[tags] could not list registry tags:", err instanceof Error ? err.message : err);
    failedAt = Date.now();
    return unreachable();
  }
}

// Available Instatic versions.
//
// Resolved from the registry rather than hardcoded, because a baked-in list
// goes stale the moment upstream tags a release and then silently offers
// versions that no longer exist. The registry is the same one the wrapper
// pins; only the tag ever crosses the privilege boundary.

const TAGS_URL = "https://ghcr.io/v2/corebunch/instatic/tags/list";
const TOKEN_URL = "https://ghcr.io/token?scope=repository:corebunch/instatic:pull&service=ghcr.io";
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const CACHE_TTL_MS = 15 * 60 * 1000;

// A last-resort list so the New Site page still renders when the box has no
// outbound network. Deliberately not the source of truth.
const FALLBACK = ["0.0.18"];

let cache: { at: number; tags: string[] } | null = null;

function byVersionDesc(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export async function listAvailableTags(): Promise<string[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.tags;

  try {
    const tokenRes = await fetch(TOKEN_URL, { signal: AbortSignal.timeout(8000) });
    if (!tokenRes.ok) throw new Error(`token endpoint returned ${tokenRes.status}`);
    const { token } = (await tokenRes.json()) as { token?: string };
    if (!token) throw new Error("token endpoint returned no token");

    const res = await fetch(TAGS_URL, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`tags endpoint returned ${res.status}`);

    const { tags } = (await res.json()) as { tags?: string[] };
    const versions = (tags ?? []).filter((t) => VERSION_RE.test(t)).sort(byVersionDesc);
    if (versions.length === 0) throw new Error("registry listed no version-shaped tags");

    cache = { at: Date.now(), tags: versions };
    return versions;
  } catch (err) {
    console.error("[tags] could not list registry tags:", err instanceof Error ? err.message : err);
    return cache?.tags ?? FALLBACK;
  }
}

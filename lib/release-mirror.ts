// Releases are mirrored to Cloudflare R2, served at clp.7he.dev over IPv4 and
// IPv6; github.com and api.github.com have no IPv6. See docs/decisions/releases.md.
import { compareSemver, isPrerelease, VERSION_TAG_RE } from "./semver";

export const MIRROR_URL = "https://clp.7he.dev";
/** The mirrored releases, newest first, shaped like GitHub's release list. */
export const MIRROR_INDEX = "releases.json";
/** The newest stable tag, which install.sh reads. */
export const MIRROR_LATEST = "latest";
/** Releases kept besides the newest stable one. */
export const MIRROR_KEEP = 30;

export interface MirroredRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: { name: string; browser_download_url: string }[];
}

function isRelease(value: unknown): value is MirroredRelease {
  const release = value as MirroredRelease | null;
  return typeof release?.tag_name === "string" && release.prerelease === isPrerelease(release.tag_name) && Array.isArray(release.assets) &&
    release.assets.every((asset) => typeof asset?.name === "string" && typeof asset.browser_download_url === "string");
}

export function parseMirrorIndex(data: unknown): MirroredRelease[] | null {
  return Array.isArray(data) && data.every(isRelease) ? data : null;
}

/** The mirror's release list, or null when it cannot be read, so the caller asks GitHub. */
export async function fetchMirrorReleases(timeoutMs: number): Promise<MirroredRelease[] | null> {
  try {
    const response = await fetch(`${MIRROR_URL}/${MIRROR_INDEX}`, {
      headers: { "User-Agent": "clp-addons" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok ? parseMirrorIndex(await response.json()) : null;
  } catch {
    return null;
  }
}

export interface MirrorPlan {
  index: MirroredRelease[];
  /** Releases to delete from the bucket. */
  dropped: MirroredRelease[];
  /** Whether this release is now the newest stable one. */
  latest: boolean;
}

/** Adds `tag` to the index, keeping the newest MIRROR_KEEP releases and the newest stable one. */
export function planMirror(current: MirroredRelease[], tag: string, assetNames: string[], keep = MIRROR_KEEP): MirrorPlan {
  if (!VERSION_TAG_RE.test(tag)) throw new Error(`${tag} is not a release tag`);
  const release: MirroredRelease = {
    tag_name: tag,
    draft: false,
    prerelease: isPrerelease(tag),
    assets: assetNames.map((name) => ({ name, browser_download_url: `${MIRROR_URL}/releases/${tag}/${name}` })),
  };
  const all = [release, ...current.filter((entry) => entry.tag_name !== tag)]
    .sort((a, b) => compareSemver(b.tag_name, a.tag_name));
  const newestStable = all.find((entry) => !entry.prerelease);
  const index = all.filter((entry, at) => at < keep || entry === newestStable);
  return { index, dropped: all.filter((entry) => !index.includes(entry)), latest: newestStable === release };
}

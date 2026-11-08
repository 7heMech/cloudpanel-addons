// Which CloudPanel is installed, and which CloudPanel versions this release
// supports. The range is the one place a release states it: `install` and
// `status` read it from the binary, and the build publishes it as the
// `cloudpanel.json` release asset so `update` can read a release's range
// before downloading the release itself.
import { execFileSync } from "node:child_process";

/**
 * Upstream versions, compared without the Debian revision: the oldest and the
 * newest CloudPanel this release was checked against. Raise `max` once a
 * release is checked on a newer CloudPanel. Outside the range, install and
 * update only warn.
 */
export const CLOUDPANEL_RANGE: CloudPanelRange = { min: "2.5.4", max: "2.5.4" };

export const CLOUDPANEL_RANGE_ASSET = "cloudpanel.json";

export interface CloudPanelRange {
  min: string;
  max: string;
}

const UPSTREAM_RE = /^\d+(?:\.\d+)*$/;

/** `2.5.4-3+clp-bookworm` → `2.5.4`; an epoch is dropped. */
export function upstreamVersion(version: string): string {
  const withoutEpoch = version.includes(":") ? version.slice(version.indexOf(":") + 1) : version;
  return withoutEpoch.split(/[-+~]/)[0] ?? "";
}

export function compareUpstream(a: string, b: string): number {
  const pa = upstreamVersion(a).split(".").map((part) => parseInt(part, 10) || 0);
  const pb = upstreamVersion(b).split(".").map((part) => parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export type RangeFit = "within" | "below" | "above" | "unknown";

export function rangeFit(installed: string | null, range: CloudPanelRange = CLOUDPANEL_RANGE): RangeFit {
  if (!installed || !UPSTREAM_RE.test(upstreamVersion(installed))) return "unknown";
  if (compareUpstream(installed, range.min) < 0) return "below";
  if (compareUpstream(installed, range.max) > 0) return "above";
  return "within";
}

/** A range from a release asset; null for anything that is not one. */
export function parseRange(text: string): CloudPanelRange | null {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (typeof value !== "object" || value === null) return null;
  const { min, max } = value as { min?: unknown; max?: unknown };
  if (typeof min !== "string" || typeof max !== "string" || !UPSTREAM_RE.test(min) || !UPSTREAM_RE.test(max)) return null;
  return compareUpstream(min, max) <= 0 ? { min, max } : null;
}

export function describeRange(range: CloudPanelRange = CLOUDPANEL_RANGE): string {
  return range.min === range.max ? range.min : `${range.min} to ${range.max}`;
}

export type PackageQuery = (args: string[]) => string;

const dpkgQuery: PackageQuery = (args) =>
  execFileSync("dpkg-query", args, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 });

/**
 * dpkg's abbreviated status is the wanted state, the current state and an
 * error flag. Only the current state matters: `i` with no error is fully
 * installed, whether the package is wanted (`ii`) or held (`hi`).
 */
const SETTLED_STATUS = /^\Si $/;

/**
 * The installed version of a package, or null when dpkg cannot say or is
 * part-way through changing it: during an upgrade the package's files are
 * still being replaced, and nothing read then is what the upgrade leaves.
 */
export function packageVersion(pkg: string, query: PackageQuery = dpkgQuery): string | null {
  try {
    const [version, status] = query(["-W", "-f=${Version}\t${db:Status-Abbrev}", pkg]).split("\t");
    return version?.trim() && SETTLED_STATUS.test(status ?? "") ? version.trim() : null;
  } catch {
    return null;
  }
}

/**
 * The MD5 dpkg records for one of a package's conffiles, as the package ships
 * it; null when the file is not one of its conffiles or dpkg cannot say.
 */
export function conffileMd5(pkg: string, path: string, query: PackageQuery = dpkgQuery): string | null {
  try {
    for (const line of query(["-W", "-f=${Conffiles}\n", pkg]).split("\n")) {
      const [file, md5] = line.trim().split(/\s+/);
      if (file === path && md5 && /^[0-9a-f]{32}$/.test(md5)) return md5;
    }
  } catch { /* not installed, or no dpkg */ }
  return null;
}

/** The installed CloudPanel package's version, as `packageVersion` gives it. */
export function panelVersion(query?: PackageQuery): string | null {
  return packageVersion("cloudpanel", query);
}

/** The package that installed `path`, such as `nginx-common` for /etc/nginx/global_settings. */
export function owningPackage(path: string, query: PackageQuery = dpkgQuery): string | null {
  try {
    const line = query(["-S", path]).split("\n").find((entry) => entry.endsWith(`: ${path}`));
    return line?.slice(0, -`: ${path}`.length).split(",")[0]?.trim() || null;
  } catch {
    return null;
  }
}

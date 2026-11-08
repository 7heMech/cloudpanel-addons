// A file a package owns that this project adds a marked block to, checked
// against a record of the file as the package left it: the text without the
// block, its hash, the path it was read from, and the version of the package
// that installed it. A file that no longer matches its record is left alone,
// unless the package itself was upgraded since and the new text still takes the
// block exactly as before (`rebaselineVerdict`).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { writeFileAtomic } from "./atomic-write";
import { errorMessage } from "./errors";

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export class NginxReadError extends Error {}

/** Null only when the path does not exist; any other failure must not look like an absent file. */
export function readIfPresent(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw new NginxReadError(`${path} could not be read: ${errorMessage(error)}`);
  }
}

/** Where the record of one file is kept, as `<stateDir>/<stem>.{pristine,sha256,path,version}`. */
export interface BaselineFiles {
  pristine: string;
  hash: string;
  path: string;
  version: string;
}

export function baselineFiles(stateDir: string, stem: string): BaselineFiles {
  return {
    pristine: `${stateDir}/${stem}.pristine`,
    hash: `${stateDir}/${stem}.sha256`,
    path: `${stateDir}/${stem}.path`,
    version: `${stateDir}/${stem}.version`,
  };
}

export function readBaseline(files: BaselineFiles): { pristine: string; hash: string } | null {
  try {
    const pristine = readFileSync(files.pristine, "utf-8");
    const hash = readFileSync(files.hash, "utf-8").trim();
    if (!hash || hash !== sha256(pristine)) return null;
    return { pristine, hash };
  } catch {
    return null;
  }
}

/** The package version the record was taken under; null for a record from before versions were kept. */
export function readBaselineVersion(files: BaselineFiles): string | null {
  try {
    return readFileSync(files.version, "utf-8").trim() || null;
  } catch {
    return null;
  }
}

/** The file is trusted as it stands under a new package version, so later edits are measured from there. */
export function writeBaselineVersion(files: BaselineFiles, version: string): void {
  writeFileAtomic(files.version, `${version}\n`, { mode: 0o644, createParent: true });
}

export function hasBaseline(files: BaselineFiles): boolean {
  return existsSync(files.pristine) || existsSync(files.hash) || existsSync(files.path);
}

export function recordBaseline(files: BaselineFiles, pristine: string, hash: string, path: string, version: string | null): void {
  writeFileAtomic(files.pristine, pristine, { mode: 0o600, createParent: true });
  writeFileAtomic(files.hash, `${hash}\n`, { mode: 0o600, createParent: true });
  writeFileAtomic(files.path, `${path}\n`, { mode: 0o600, createParent: true });
  if (version) writeBaselineVersion(files, version);
  else rmSync(files.version, { force: true });
}

export function removeBaseline(files: BaselineFiles): void {
  rmSync(files.pristine, { force: true });
  rmSync(files.hash, { force: true });
  rmSync(files.path, { force: true });
  rmSync(files.version, { force: true });
}

/**
 * Why a changed file is left alone.
 *
 * - `busy`: the owning package is part-way through an install or upgrade.
 * - `edited`: the package version is the one recorded, or the file is a conffile
 *   whose text is not the package's, so someone else changed it.
 * - `unrecorded`: the record predates versions, so there is no telling who changed it.
 * - `stray-marker`: marker text is left over once the managed blocks are taken out.
 * - `anchor-missing` / `anchor-repeated`: a line a block attaches to is not in the new text exactly once.
 * - `conflict`: the new text already holds something the block would clash with.
 */
export type Refusal = "busy" | "edited" | "unrecorded" | "stray-marker" | "anchor-missing" | "anchor-repeated" | "conflict";

export interface UpstreamChange {
  /** The package version in the record, or null when it has none. */
  recorded: string | null;
  /** The installed package version, or null while dpkg is changing it or cannot say. */
  installed: string | null;
  strayMarker: boolean;
  /** Why the new text cannot take the blocks, or null when every one fits. */
  misfit: Refusal | null;
  /**
   * For a conffile, whether the new text is the package's own. dpkg keeps a
   * locally edited conffile through an upgrade that ships the same one, so a
   * moved version alone does not show the package wrote it. Left out for a
   * file every upgrade replaces.
   */
  packageText?: boolean;
  /** `repair --rebaseline`: the operator vouches for the change, so the version need not have moved. */
  accept?: boolean;
}

/**
 * Whether a file that no longer matches its record may be recorded afresh and
 * patched again. Only a package upgrade explains a change on its own; anything
 * else is left for the operator. Fit is required either way, so markup the
 * blocks were not built for is never written.
 */
export function rebaselineVerdict(change: UpstreamChange): Refusal | null {
  if (change.installed === null) return "busy";
  if (change.strayMarker) return "stray-marker";
  if (!change.accept) {
    if (change.recorded === null) return "unrecorded";
    if (change.recorded === change.installed) return "edited";
    if (change.packageText === false) return "edited";
  }
  return change.misfit;
}

/** How many times `needle` occurs in `text`, as the anchor check counts it. */
export function occurrences(text: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) count++;
  return count;
}

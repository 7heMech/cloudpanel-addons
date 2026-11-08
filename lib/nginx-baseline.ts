// A file CloudPanel owns that this project adds a marked block to, checked
// against a record of the file as CloudPanel left it: the text without the
// block, its hash, and the path it was read from. A file that no longer matches
// its record was changed by someone else, and is left alone.
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

/** Where the record of one file is kept, as `<stateDir>/<stem>.{pristine,sha256,path}`. */
interface BaselineFiles {
  pristine: string;
  hash: string;
  path: string;
}

export function baselineFiles(stateDir: string, stem: string): BaselineFiles {
  return {
    pristine: `${stateDir}/${stem}.pristine`,
    hash: `${stateDir}/${stem}.sha256`,
    path: `${stateDir}/${stem}.path`,
  };
}

/** The recorded text and its hash, or null when the record is missing or does not hash to itself. */
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

export function hasBaseline(files: BaselineFiles): boolean {
  return existsSync(files.pristine) || existsSync(files.hash) || existsSync(files.path);
}

export function recordBaseline(files: BaselineFiles, pristine: string, hash: string, path: string): void {
  writeFileAtomic(files.pristine, pristine, { mode: 0o600, createParent: true });
  writeFileAtomic(files.hash, `${hash}\n`, { mode: 0o600, createParent: true });
  writeFileAtomic(files.path, `${path}\n`, { mode: 0o600, createParent: true });
}

export function removeBaseline(files: BaselineFiles): void {
  rmSync(files.pristine, { force: true });
  rmSync(files.hash, { force: true });
  rmSync(files.path, { force: true });
}

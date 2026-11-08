// Files root reads and acts on. A file another account could have written is
// one that account controls, so root trusts only a regular file whose owner is
// the expected one and whose mode lets nobody else write it.
import { lstatSync, readFileSync, type Stats } from "node:fs";

const NO_OTHERS_WRITE = 0o022;
export const OWNER_ONLY = 0o077;

/** Given lstat's view, or fstat's of a descriptor opened with O_NOFOLLOW, a symlink never passes. */
export function isTrustedFile(info: Stats, uid: number, forbidden = NO_OTHERS_WRITE): boolean {
  return info.isFile() && info.uid === uid && (info.mode & forbidden) === 0;
}

export function isTrustedDirectory(info: Stats, uid: number, forbidden = NO_OTHERS_WRITE): boolean {
  return info.isDirectory() && info.uid === uid && (info.mode & forbidden) === 0;
}

export function trustedText(path: string, uid: number, forbidden = NO_OTHERS_WRITE): string | null {
  let info: Stats;
  try {
    info = lstatSync(path);
  } catch {
    return null;
  }
  return isTrustedFile(info, uid, forbidden) ? readFileSync(path, "utf8") : null;
}

/** A regular file's text whoever owns it; null for anything else or on any error. */
export function regularText(path: string): string | null {
  try {
    return lstatSync(path).isFile() ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

/** Whether anything is at `path`, a dangling symlink included. */
export function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

// Files root reads and acts on. A file another account could have written is
// one that account controls, so root trusts only a regular file whose owner is
// the expected one and whose mode lets nobody else write it. Each caller names
// its rule: the owner, and the mode bits that must be clear.
import { lstatSync, readFileSync, type Stats } from "node:fs";

/** Group and other may not write: the file is its owner's to change. */
export const NO_OTHERS_WRITE = 0o022;
/** Group and other may do nothing: the file is its owner's alone, to read too. */
export const OWNER_ONLY = 0o077;

/**
 * A regular file `uid` owns with none of `forbidden` set. Given lstat's view,
 * or fstat's of a descriptor opened with O_NOFOLLOW, a symlink never is one.
 */
export function isTrustedFile(info: Stats, uid: number, forbidden = NO_OTHERS_WRITE): boolean {
  return info.isFile() && info.uid === uid && (info.mode & forbidden) === 0;
}

/** A directory, not a link to one, that `uid` owns with none of `forbidden` set. */
export function isTrustedDirectory(info: Stats, uid: number, forbidden = NO_OTHERS_WRITE): boolean {
  return info.isDirectory() && info.uid === uid && (info.mode & forbidden) === 0;
}

/**
 * A trusted file's text; null when nothing can be looked up at `path` or what
 * is there is not trusted. A file that passes but cannot be read throws.
 */
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

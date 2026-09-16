import { randomBytes } from "node:crypto";
import { chmodSync, chownSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Replace a file's contents in one step, or leave the file as it was.
 *
 * Three copies of this existed: the generic one in `cli/util.ts`, the
 * owner-preserving one in the Cloudflare action, and Instatic's metadata
 * writer. They agreed on the shape -- write beside the target, then rename --
 * and disagreed on everything that makes the shape safe:
 *
 * - The generic one named its temporary file `<path>.tmp.<pid>` and created it
 *   without `O_EXCL`. A predictable name plus a create that will happily open
 *   whatever is already there is the pair that lets something else choose where
 *   the write lands.
 * - It also left the temporary file behind on a failed `chmod`, because only
 *   the write was inside the `try`.
 * - Only the Cloudflare one set ownership, and only it cleaned up on failure.
 *
 * What is deliberately *not* here: deciding who should own the result, or
 * whether the existing target is one this project is willing to replace. Both
 * are policy, both differ per caller, and a default for either would be a
 * default that is wrong somewhere. Ownership is passed explicitly or not at
 * all; the caller checks the target first if it cares.
 */
export interface AtomicWriteOptions {
  /** Mode of the finished file. Applied before it becomes visible. */
  mode: number;
  /** Ownership of the finished file, when the caller must not inherit its own. */
  owner?: { uid: number; gid: number };
  /** Create the parent directory if it is missing. */
  createParent?: boolean;
}

export function writeFileAtomic(
  path: string,
  content: string | Uint8Array,
  options: AtomicWriteOptions,
): void {
  if (options.createParent) mkdirSync(dirname(path), { recursive: true });
  // In the target's own directory, so the rename is on one filesystem and
  // therefore atomic; unpredictable, so nothing can wait at the name; and
  // exclusive, so a collision is an error rather than a file we did not create.
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, content, { mode: options.mode, flag: "wx" });
    // The mode passed to open() is masked by the process umask, and says
    // nothing at all when the file already exists. Setting it explicitly is
    // what makes the guarantee, and it happens before the rename so the
    // contents are never visible under the wrong mode.
    chmodSync(temporary, options.mode);
    if (options.owner) chownSync(temporary, options.owner.uid, options.owner.gid);
    renameSync(temporary, path);
  } catch (error) {
    // Nothing of ours is left behind, whichever step failed. The target is
    // untouched: it is only ever replaced by the rename, which is last.
    rmSync(temporary, { force: true });
    throw error;
  }
}

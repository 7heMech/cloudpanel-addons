import { randomBytes } from "node:crypto";
import { chmodSync, chownSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

interface AtomicWriteOptions {
  mode: number;
  owner?: { uid: number; gid: number };
  createParent?: boolean;
}

/**
 * Replace a file's contents in one step, or leave the file as it was.
 *
 * Who should own the result, and whether the existing target may be replaced,
 * differ per caller: ownership is passed explicitly or not at all, and the
 * caller checks the target first if it cares.
 */
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
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function writeOrRemove(path: string, content: string | null, options: AtomicWriteOptions): void {
  if (content === null) rmSync(path, { force: true });
  else writeFileAtomic(path, content, options);
}

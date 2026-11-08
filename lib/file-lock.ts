// Exclusive locks on files under /run/lock, shared by root's processes.
import { dlopen, FFIType } from "bun:ffi";
import { randomBytes } from "node:crypto";
import {
  closeSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeSync, constants as fsConstants,
  type Stats,
} from "node:fs";
import { dirname } from "node:path";
import { failAction } from "./action";

const libc = process.platform === "linux"
  ? dlopen("libc.so.6", {
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    })
  : null;

const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;

export interface FileLockHandle {
  release(): void;
}

/**
 * The refusal a waiter gets when the lock does not come free.
 *
 * A function is handed whatever the holder wrote into the lock file, so a
 * refusal can name the operation it waited for rather than only say "busy".
 */
type LockTimeoutMessage = string | ((holder: string | null) => string);

interface FileLockOptions {
  /** Kept in the lock file while the lock is held, for a waiter to read. */
  note?: string;
}

function lstatOrNull(path: string): Stats | null {
  try { return lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Makes `dir` a directory only this process's user can change. The lock
 * directory sits in /run/lock, which every user can write, so after a reboot
 * anyone could create it first and fill it with links for root to follow. One
 * this user does not own, or others can write, is moved aside and made again.
 */
export function ensureLockDir(dir: string): void {
  const uid = process.geteuid?.() ?? 0;
  const trusted = (stat: Stats | null) => stat && stat.isDirectory() && stat.uid === uid && !(stat.mode & 0o022);
  let stat = lstatOrNull(dir);
  if (trusted(stat)) return;
  if (stat) renameSync(dir, `${dir}.untrusted-${randomBytes(6).toString("hex")}`);
  try { mkdirSync(dir, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") mkdirSync(dir, { recursive: true, mode: 0o700 });
    else if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  stat = lstatOrNull(dir);
  if (!trusted(stat)) failAction(`refusing to use ${dir}: it is not a directory only this user can write`);
}

// O_RDWR|O_CREAT rather than "w": truncating on open would erase the note the
// holder wrote. O_NOFOLLOW, since root truncates and writes the file.
function openLockFile(path: string): number {
  ensureLockDir(dirname(path));
  return openSync(path, fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW, 0o600);
}

function lockHolder(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim() || null;
  } catch {
    return null;
  }
}

function lockTimeout(message: LockTimeoutMessage, path: string): never {
  failAction(typeof message === "string" ? message : message(lockHolder(path)));
}

function lockHandle(fd: number, state: { locked: boolean }): FileLockHandle {
  return {
    release: () => {
      if (!state.locked) return;
      ftruncateSync(fd, 0);
      libc!.symbols.flock(fd, LOCK_UN);
      state.locked = false;
      closeSync(fd);
    },
  };
}

function takeLock(fd: number, options: FileLockOptions): void {
  ftruncateSync(fd, 0);
  if (options.note) writeSync(fd, options.note, 0);
}

export async function acquireFileLock(
  path: string,
  timeoutSeconds: number,
  onTimeout: LockTimeoutMessage,
  options: FileLockOptions = {},
): Promise<FileLockHandle> {
  if (!libc) failAction("flock is unavailable; refusing to run a privileged action");
  const fd = openLockFile(path);
  const state = { locked: false };
  let handedOff = false;
  try {
    const deadline = Date.now() + timeoutSeconds * 1000;
    while (true) {
      if (libc.symbols.flock(fd, LOCK_EX | LOCK_NB) === 0) break;
      if (Date.now() >= deadline) lockTimeout(onTimeout, path);
      await Bun.sleep(100);
    }
    state.locked = true;
    takeLock(fd, options);
    handedOff = true;
    return lockHandle(fd, state);
  } finally {
    // A timeout or another failure before the handle is returned owns the fd.
    if (!handedOff) {
      if (state.locked) libc.symbols.flock(fd, LOCK_UN);
      closeSync(fd);
    }
  }
}

/**
 * The same lock for callers that cannot await: disable, self-uninstall and the
 * template reconcile are synchronous from end to end.
 */
export function acquireFileLockSync(
  path: string,
  timeoutSeconds: number,
  onTimeout: LockTimeoutMessage,
  options: FileLockOptions = {},
): FileLockHandle {
  if (!libc) failAction("flock is unavailable; refusing to run a privileged action");
  const fd = openLockFile(path);
  const state = { locked: false };
  let handedOff = false;
  try {
    const deadline = Date.now() + timeoutSeconds * 1000;
    while (true) {
      if (libc.symbols.flock(fd, LOCK_EX | LOCK_NB) === 0) break;
      if (Date.now() >= deadline) lockTimeout(onTimeout, path);
      Bun.sleepSync(100);
    }
    state.locked = true;
    takeLock(fd, options);
    handedOff = true;
    return lockHandle(fd, state);
  } finally {
    if (!handedOff) {
      if (state.locked) libc.symbols.flock(fd, LOCK_UN);
      closeSync(fd);
    }
  }
}

export async function withFileLock<T>(
  path: string,
  timeoutSeconds: number,
  onTimeout: LockTimeoutMessage,
  body: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const lock = await acquireFileLock(path, timeoutSeconds, onTimeout, options);
  try {
    return await body();
  } finally {
    lock.release();
  }
}

export function withFileLockSync<T>(
  path: string,
  timeoutSeconds: number,
  onTimeout: LockTimeoutMessage,
  body: () => T,
  options: FileLockOptions = {},
): T {
  const lock = acquireFileLockSync(path, timeoutSeconds, onTimeout, options);
  try {
    return body();
  } finally {
    lock.release();
  }
}

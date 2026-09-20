import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ActionFailure, acquireFileLock, acquireFileLockSync, type FileLockHandle } from "./action-common";
import { LOCK_DIR } from "./paths";
import { fatal } from "./util";

/**
 * The lock one clp-addons operation holds from beginning to end.
 *
 * Enabling, disabling, repairing, updating and uninstalling all rewrite the
 * same set of things -- the config files, the units, the Twig templates and
 * the Nginx fragments -- and none of it is atomic across the set, so two of
 * them at once leave the loser's work partly overwritten. The panel serialised
 * only its own jobs; a root shell, the anchor path unit and the reconcile
 * timer went straight in. This is the one lock all of them take.
 */

/** Generous: an enable that installs Docker runs for minutes. */
export const OPERATION_TIMEOUT_SECONDS = 900;

/**
 * Marks a re-exec as running inside its parent's lock.
 *
 * `clp-addons update` replaces the binary and then re-runs itself as the
 * installed copy. That child is the same operation, but it is a different
 * process, so flock would have it wait for its own parent.
 */
export const OPERATION_LOCK_ENV = "CLP_ADDONS_IN_OPERATION";

let held: string | null = process.env[OPERATION_LOCK_ENV] || null;

export interface OperationLockOptions {
  timeoutSeconds?: number;
  lockDir?: string;
}

/** The environment a child of the current operation inherits. */
export function operationLockEnv(): NodeJS.ProcessEnv {
  return { ...process.env, [OPERATION_LOCK_ENV]: held ?? "1" };
}

function lockPath(lockDir: string): string {
  mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  return join(lockDir, "operation.lock");
}

function note(operation: string): string {
  return `${operation}\n${new Date().toISOString()}\n`;
}

function busy(holder: string | null): string {
  const [operation, startedAt] = (holder ?? "").split("\n");
  if (!operation) return "another clp-addons operation is running; try again when it has finished";
  const since = startedAt ? `since ${startedAt}` : "already";
  return `clp-addons ${operation} has been running ${since}; try again when it has finished`;
}

function asFatal(error: unknown): never {
  if (error instanceof ActionFailure) fatal(error.message);
  throw error;
}

export async function withOperationLock<T>(
  operation: string,
  body: () => Promise<T>,
  options: OperationLockOptions = {},
): Promise<T> {
  if (held) return body();
  const path = lockPath(options.lockDir ?? LOCK_DIR);
  const timeout = options.timeoutSeconds ?? OPERATION_TIMEOUT_SECONDS;
  const lock = await acquireFileLock(path, timeout, busy, { note: note(operation) }).catch(asFatal);
  held = operation;
  try {
    return await body();
  } finally {
    held = null;
    lock.release();
  }
}

export function withOperationLockSync<T>(
  operation: string,
  body: () => T,
  options: OperationLockOptions = {},
): T {
  if (held) return body();
  const path = lockPath(options.lockDir ?? LOCK_DIR);
  const timeout = options.timeoutSeconds ?? OPERATION_TIMEOUT_SECONDS;
  let lock: FileLockHandle;
  try {
    lock = acquireFileLockSync(path, timeout, busy, { note: note(operation) });
  } catch (error) {
    asFatal(error);
  }
  held = operation;
  try {
    return body();
  } finally {
    held = null;
    lock.release();
  }
}

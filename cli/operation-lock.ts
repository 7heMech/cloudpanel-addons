import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ActionFailure } from "../lib/action";
import { acquireFileLock, acquireFileLockSync, type FileLockHandle } from "../lib/file-lock";
import { LOCK_DIR } from "../lib/paths";
import { fatal } from "../lib/log";

// Enabling, disabling, repairing, updating and uninstalling all rewrite the
// config files, the units, the Twig templates and the Nginx fragments, none of
// it atomically across the set, and the panel, a root shell, the anchor path
// unit and the reconcile timer all start them. Each takes this one lock from
// beginning to end.

/** Generous: an enable that installs Docker runs for minutes. */
const OPERATION_TIMEOUT_SECONDS = 900;

/**
 * Marks a re-exec as running inside its parent's lock.
 *
 * `clp-addons update` replaces the binary and then re-runs itself as the
 * installed copy. That child is the same operation, but it is a different
 * process, so flock would have it wait for its own parent.
 */
export const OPERATION_LOCK_ENV = "CLP_ADDONS_IN_OPERATION";

let held: string | null = process.env[OPERATION_LOCK_ENV] || null;

interface OperationLockOptions {
  timeoutSeconds?: number;
  lockDir?: string;
}

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

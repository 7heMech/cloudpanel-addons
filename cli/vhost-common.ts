/**
 * What an action needs to change a CloudPanel site's rendered Nginx vhost
 * safely: the panel database, the trust check on the file, the owned atomic
 * write and the recovery bookkeeping a failed change reports through.
 *
 * Cloudflare IP Access owned all of it while it was the only addon editing a
 * vhost. Redirects edits the same files under the same rules, and two copies of
 * "refuse a vhost that is not a trusted regular file" is how the two ends of
 * that rule drift apart.
 */
import { Database } from "bun:sqlite";
import { lstatSync, readFileSync } from "node:fs";
import { ActionFailure, failAction, type CommandResult } from "./action-common";
import { writeFileAtomic } from "../lib/atomic-write";

export interface VhostBackup {
  path: string;
  content: string;
  mode: number;
  uid: number;
  gid: number;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function openPanelDatabase(path: string): Database {
  try {
    const db = new Database(path, { create: false, readwrite: true });
    db.exec("PRAGMA busy_timeout = 5000;");
    return db;
  } catch (error) {
    failAction(`CloudPanel database could not be opened: ${errorMessage(error)}`);
  }
}

export function trustedVhost(path: string, expectedUid: number): VhostBackup {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== expectedUid || (stat.mode & 0o022) !== 0) {
    failAction(`refusing untrusted Nginx vhost ${path}`);
  }
  return {
    path,
    content: readFileSync(path, "utf8"),
    mode: stat.mode & 0o777,
    uid: stat.uid,
    gid: stat.gid,
  };
}

/**
 * The vhosts and the policy files belong to accounts this action is not: the
 * panel owns its Nginx tree, and inheriting root here would make a file the
 * panel can no longer rewrite. Ownership is passed, never defaulted.
 */
export function writeAtomicOwned(path: string, content: string, mode: number, uid: number, gid: number): void {
  writeFileAtomic(path, content, { mode, owner: { uid, gid }, createParent: true });
}

export function restoreVhosts(backups: VhostBackup[]): string[] {
  const failures: string[] = [];
  for (const backup of backups) {
    try {
      writeAtomicOwned(backup.path, backup.content, backup.mode, backup.uid, backup.gid);
    } catch (error) {
      failures.push(`vhost ${backup.path}: ${errorMessage(error)}`);
    }
  }
  return failures;
}

export function commandError(label: string, result: CommandResult): string {
  return `${label} failed: ${(result.stderr || result.stdout || `exit ${result.exitCode ?? "unknown"}`).trim()}`;
}

export function withRecoveryFailures(primary: unknown, label: string, failures: string[]): Error {
  const original = primary instanceof Error ? primary : new Error(String(primary));
  if (failures.length === 0) return original;
  const message = `${original.message}; ${label}: ${failures.join("; ")}`;
  if (original instanceof ActionFailure) return new ActionFailure(message, original.data);
  return new Error(message, { cause: original });
}

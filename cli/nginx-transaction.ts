import { Database } from "bun:sqlite";
import { lstatSync, readFileSync, rmSync } from "node:fs";
import { ActionFailure, failAction, type CommandResult } from "./action-common";
import { writeFileAtomic } from "../lib/atomic-write";

export interface NginxFileBackup {
  path: string;
  content: string | null;
  mode: number;
  uid: number;
  gid: number;
}

export function writeAtomicOwned(path: string, content: string, mode: number, uid: number, gid: number): void {
  // Preserve the panel's ownership so it can still rewrite its files.
  writeFileAtomic(path, content, { mode, owner: { uid, gid }, createParent: true });
}

export function openPanelDatabase(path: string, readOnly = false): Database {
  try {
    const db = new Database(path, { create: false, ...(readOnly ? { readonly: true } : { readwrite: true }) });
    db.exec("PRAGMA busy_timeout = 5000;");
    return db;
  } catch (error) {
    failAction(`CloudPanel database could not be opened: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function trustedVhost(path: string, expectedUid: number): NginxFileBackup & { content: string } {
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

function commandError(label: string, result: CommandResult): string {
  return `${label} failed: ${(result.stderr || result.stdout || `exit ${result.exitCode ?? "unknown"}`).trim()}`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function withRecoveryFailures(primary: unknown, label: string, failures: string[]): Error {
  const original = primary instanceof Error ? primary : new Error(String(primary));
  if (failures.length === 0) return original;
  const message = `${original.message}; ${label}: ${failures.join("; ")}`;
  if (original instanceof ActionFailure) return new ActionFailure(message, original.data);
  return new Error(message, { cause: original });
}

function restoreVhosts(backups: NginxFileBackup[]): string[] {
  const failures: string[] = [];
  for (const backup of backups) {
    try {
      if (backup.content === null) rmSync(backup.path, { force: true });
      else writeAtomicOwned(backup.path, backup.content, backup.mode, backup.uid, backup.gid);
    } catch (error) {
      failures.push(`vhost ${backup.path}: ${errorMessage(error)}`);
    }
  }
  return failures;
}

export interface NginxChange {
  backup: NginxFileBackup;
  content: string | null;
}

export function nginxFileChange(path: string, content: string | null, expectedUid: number): NginxChange {
  let backup: NginxFileBackup;
  try {
    backup = trustedVhost(path, expectedUid);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    backup = { path, content: null, mode: 0o644, uid: expectedUid, gid: process.getgid?.() ?? 0 };
  }
  return { backup, content };
}

/** Commits panel rows and Nginx files together, recovering both on failure. */
export function withNginxTransaction<T>(
  db: Database | null,
  paths: { nginx: string; systemctl: string },
  command: (command: string, args: string[]) => CommandResult,
  stage: (changes: NginxChange[]) => T,
  options: { reload?: boolean; alwaysValidate?: boolean } = {},
): { value: T; changed: boolean } {
  const changes: NginxChange[] = [];
  const written: NginxFileBackup[] = [];
  let attemptedReload = false;
  let began = false;
  try {
    if (db) { db.exec("BEGIN IMMEDIATE;"); began = true; }
    const before = db?.query<{ count: number }, []>("SELECT total_changes() AS count;").get()!.count;
    const value = stage(changes);
    const rowsChanged = before !== db?.query<{ count: number }, []>("SELECT total_changes() AS count;").get()!.count;
    for (const { backup, content } of changes) {
      if (content === backup.content) continue;
      written.push(backup);
      if (content === null) rmSync(backup.path, { force: true });
      else writeAtomicOwned(backup.path, content, backup.mode, backup.uid, backup.gid);
    }
    const changed = rowsChanged || written.length > 0;
    if (options.reload !== false && (changed || options.alwaysValidate)) {
      const checked = command(paths.nginx, ["-t"]);
      if (!checked.ok) throw new Error(commandError("Nginx validation", checked));
      attemptedReload = true;
      const reloaded = command(paths.systemctl, ["reload", "nginx"]);
      if (!reloaded.ok) throw new Error(commandError("Nginx reload", reloaded));
    }
    if (db) db.exec("COMMIT;");
    return { value, changed };
  } catch (error) {
    const failures: string[] = [];
    if (db && began) {
      try { db.exec("ROLLBACK;"); }
      catch (rollbackError) { failures.push(`database transaction: ${errorMessage(rollbackError)}`); }
    }
    if (written.length) {
      failures.push(...restoreVhosts(written));
      if (options.reload !== false) {
        try {
          const restored = command(paths.nginx, ["-t"]);
          if (!restored.ok) failures.push(commandError("Nginx rollback validation", restored));
          else if (attemptedReload) {
            const reloaded = command(paths.systemctl, ["reload", "nginx"]);
            if (!reloaded.ok) failures.push(commandError("Nginx rollback reload", reloaded));
          }
        } catch (recoveryError) { failures.push(`Nginx rollback validation/reload failed: ${errorMessage(recoveryError)}`); }
      }
    }
    throw withRecoveryFailures(error, "rollback failed", failures);
  }
}

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

export function openPanelDatabase(path: string, readOnly = false, busyTimeoutMs = 5000): Database {
  try {
    const db = new Database(path, { create: false, ...(readOnly ? { readonly: true } : { readwrite: true }) });
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs};`);
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

interface NginxTransactionOptions {
  reload?: boolean;
  alwaysValidate?: boolean;
}

class NginxTransaction {
  private written: NginxFileBackup[] = [];
  private attemptedReload = false;
  private began = false;
  needsReload = false;

  constructor(
    private db: Database | null,
    private paths: { nginx: string; systemctl: string },
    private command: (command: string, args: string[]) => CommandResult,
    private options: NginxTransactionOptions,
  ) {}

  prepare<T>(stage: (changes: NginxChange[]) => T): { value: T; changed: boolean } {
    const changes: NginxChange[] = [];
    if (this.db) {
      this.db.exec("BEGIN IMMEDIATE;");
      this.began = true;
    }
    const count = () => this.db?.query<{ count: number }, []>("SELECT total_changes() AS count;").get()!.count;
    const before = count();
    const value = stage(changes);
    const rowsChanged = before !== count();
    for (const { backup, content } of changes) {
      if (content === backup.content) continue;
      this.written.push(backup);
      if (content === null) rmSync(backup.path, { force: true });
      else writeAtomicOwned(backup.path, content, backup.mode, backup.uid, backup.gid);
    }
    const changed = rowsChanged || this.written.length > 0;
    this.needsReload = this.options.reload !== false && (changed || this.options.alwaysValidate === true);
    if (this.needsReload) {
      const checked = this.command(this.paths.nginx, ["-t"]);
      if (!checked.ok) throw new Error(commandError("Nginx validation", checked));
    }
    return { value, changed };
  }

  reload(label = "Nginx reload"): void {
    this.attemptedReload = true;
    const reloaded = this.command(this.paths.systemctl, ["reload", "nginx"]);
    if (!reloaded.ok) throw new Error(commandError(label, reloaded));
  }

  commit(): void {
    if (this.db) this.db.exec("COMMIT;");
  }

  restore(failures: string[]): boolean {
    failures.push(...restoreVhosts(this.written));
    if (this.db && this.began) {
      try { this.db.exec("ROLLBACK;"); }
      catch (error) { failures.push(`database transaction: ${errorMessage(error)}`); }
    }
    if (!this.written.length) return false;
    if (this.options.reload === false) return false;
    try {
      const restored = this.command(this.paths.nginx, ["-t"]);
      if (!restored.ok) failures.push(commandError("Nginx rollback validation", restored));
      else return this.attemptedReload;
    } catch (error) {
      failures.push(`Nginx rollback validation failed: ${errorMessage(error)}`);
    }
    return false;
  }
}

/** Commits panel rows and Nginx files together, recovering both on failure. */
export function withNginxTransaction<T>(
  db: Database | null,
  paths: { nginx: string; systemctl: string },
  command: (command: string, args: string[]) => CommandResult,
  stage: (changes: NginxChange[]) => T,
  options: NginxTransactionOptions = {},
): { value: T; changed: boolean } {
  const transaction = new NginxTransaction(db, paths, command, options);
  try {
    const result = transaction.prepare(stage);
    if (transaction.needsReload) transaction.reload();
    transaction.commit();
    return result;
  } catch (error) {
    const failures: string[] = [];
    if (transaction.restore(failures)) {
      try { transaction.reload("Nginx rollback reload"); }
      catch (error) { failures.push(errorMessage(error)); }
    }
    throw withRecoveryFailures(error, "rollback failed", failures);
  }
}

/** Waits for a caller's reload acknowledgement before committing or finishing recovery. */
export async function withNginxTransactionAsync<T>(
  db: Database | null,
  paths: { nginx: string; systemctl: string },
  command: (command: string, args: string[]) => CommandResult,
  stage: (changes: NginxChange[]) => T,
  reload: (signal: () => void) => Promise<void>,
): Promise<{ value: T; changed: boolean }> {
  const transaction = new NginxTransaction(db, paths, command, {});
  try {
    const result = transaction.prepare(stage);
    if (transaction.needsReload) await reload(() => transaction.reload());
    transaction.commit();
    return result;
  } catch (error) {
    const failures: string[] = [];
    if (transaction.restore(failures)) {
      try { await reload(() => transaction.reload()); }
      catch (error) { failures.push(`Nginx rollback reload failed: ${errorMessage(error)}`); }
    }
    throw withRecoveryFailures(error, "rollback failed", failures);
  }
}

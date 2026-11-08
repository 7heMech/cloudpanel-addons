import { Database } from "bun:sqlite";
import { lstatSync, readFileSync, rmSync } from "node:fs";
import { isIP } from "node:net";
import { ActionFailure, failAction } from "./action";
import { errorMessage } from "./errors";
import { type CommandResult } from "./command";
import { writeFileAtomic } from "./atomic-write";

interface NginxFileBackup {
  path: string;
  content: string | null;
  mode: number;
  uid: number;
  gid: number;
}

/** The `allow` entries of CloudPanel's Cloudflare list, each checked as an address or a prefix. */
export function cloudflareRanges(path: string): string[] {
  let content: string;
  try { content = readFileSync(path, "utf8"); } catch { return []; }
  return content.split(/\r?\n/).flatMap((line) => {
    const range = line.match(/^\s*allow\s+([0-9a-fA-F.:/]+)\s*;/)?.[1];
    if (!range) return [];
    const parts = range.split("/");
    if (parts.length > 2) return [];
    const [address = "", prefix] = parts;
    const family = isIP(address);
    const valid = family !== 0 && (prefix === undefined || (/^\d+$/.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128)));
    return valid ? [range] : [];
  });
}

/** Panel files may be owned by the panel account or root; site files require one exact owner. */
export type NginxFileOwner = number | readonly [number, ...number[]];
/** A group allowlist keeps group write limited to those accounts; true retains the caller's existing policy. */
export type NginxGroupWrite = boolean | readonly number[];

/** `groupWritable` accepts a file its owning account's group may write, as CloudPanel's panel files are. */
export function trustedVhost(path: string, expectedUid: NginxFileOwner, groupWritable: NginxGroupWrite = false): NginxFileBackup & { content: string } {
  const stat = lstatSync(path);
  const owners = typeof expectedUid === "number" ? [expectedUid] : expectedUid;
  const refuse = (reason: string, fix: string) => failAction(`refusing ${path}: ${reason}; ${fix}`);
  if (stat.isSymbolicLink()) refuse("it is a symlink", "replace it with a regular file");
  if (!stat.isFile()) refuse("it is not a regular file", "replace it with a regular file");
  if (!owners.includes(stat.uid)) {
    const owner = owners[0]!;
    refuse(
      `owned by uid ${stat.uid}, expected ${owners.map((uid) => uid === 0 ? "root (0)" : `uid ${uid}`).join(" or ")}`,
      owner === 0 ? `run chown root:root ${path}` : `run chown ${owner} ${path}`,
    );
  }
  if ((stat.mode & 0o020) !== 0 && typeof groupWritable !== "boolean" && !groupWritable.includes(stat.gid)) {
    refuse(`group-writable by untrusted gid ${stat.gid} (mode ${(stat.mode & 0o777).toString(8)})`, `run chmod g-w ${path}`);
  }
  if ((stat.mode & (groupWritable ? 0o002 : 0o022)) !== 0) {
    const who = [(stat.mode & 0o020) !== 0 ? "group" : "", (stat.mode & 0o002) !== 0 ? "world" : ""].filter(Boolean).join("- and ");
    refuse(`${who}-writable (mode ${(stat.mode & 0o777).toString(8)})`, `run chmod go-w ${path}`);
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
      else writeFileAtomic(backup.path, backup.content, { mode: backup.mode, owner: { uid: backup.uid, gid: backup.gid }, createParent: true });
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

export function nginxFileChange(path: string, content: string | null, expectedUid: NginxFileOwner, groupWritable: NginxGroupWrite = false): NginxChange {
  let backup: NginxFileBackup;
  try {
    backup = trustedVhost(path, expectedUid, groupWritable);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const uid = typeof expectedUid === "number" ? expectedUid : expectedUid[0];
    backup = { path, content: null, mode: 0o644, uid, gid: process.getgid?.() ?? 0 };
  }
  return { backup, content };
}

/** Which Nginx to validate and reload: the sites' by default, or one with its own config and unit. */
interface NginxInstance {
  nginx: string;
  systemctl: string;
  config?: string;
  service?: string;
}

function testArgs(paths: NginxInstance): string[] {
  return paths.config ? ["-t", "-c", paths.config] : ["-t"];
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
    private paths: NginxInstance,
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
      else writeFileAtomic(backup.path, content, { mode: backup.mode, owner: { uid: backup.uid, gid: backup.gid }, createParent: true });
    }
    const changed = rowsChanged || this.written.length > 0;
    this.needsReload = this.options.reload !== false && (changed || this.options.alwaysValidate === true);
    if (this.needsReload) {
      const checked = this.command(this.paths.nginx, testArgs(this.paths));
      if (!checked.ok) throw new Error(commandError("Nginx validation", checked));
    }
    return { value, changed };
  }

  reload(label = "Nginx reload"): void {
    this.attemptedReload = true;
    const reloaded = this.command(this.paths.systemctl, ["reload", this.paths.service ?? "nginx"]);
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
      const restored = this.command(this.paths.nginx, testArgs(this.paths));
      if (!restored.ok) failures.push(commandError("Nginx rollback validation", restored));
      else return this.attemptedReload;
    } catch (error) {
      failures.push(`Nginx rollback validation failed: ${errorMessage(error)}`);
    }
    return false;
  }
}

export function withNginxTransaction<T>(
  db: Database | null,
  paths: NginxInstance,
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
  paths: NginxInstance,
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

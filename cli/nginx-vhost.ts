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

export function trustedVhost(path: string, expectedUid: number): VhostBackup {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== expectedUid || (stat.mode & 0o022) !== 0) {
    failAction(`refusing untrusted Nginx vhost ${path}`);
  }
  return { path, content: readFileSync(path, "utf8"), mode: stat.mode & 0o777, uid: stat.uid, gid: stat.gid };
}

export function writeVhost(backup: VhostBackup, content: string): void {
  writeFileAtomic(backup.path, content, { mode: backup.mode, owner: backup, createParent: true });
}

export function commandError(label: string, result: CommandResult): string {
  return `${label} failed: ${(result.stderr || result.stdout || `exit ${result.exitCode ?? "unknown"}`).trim()}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function withRecoveryFailures(primary: unknown, label: string, failures: string[]): Error {
  const original = primary instanceof Error ? primary : new Error(String(primary));
  if (failures.length === 0) return original;
  const message = `${original.message}; ${label}: ${failures.join("; ")}`;
  if (original instanceof ActionFailure) return new ActionFailure(message, original.data);
  return new Error(message, { cause: original });
}

export async function restoreVhosts(
  backups: VhostBackup[],
  paths: { nginx: string; systemctl: string },
  command: (command: string, args: string[]) => CommandResult,
  attemptedReload: boolean,
  reload: (signal: () => void) => Promise<void> = async (signal) => signal(),
): Promise<string[]> {
  const failures: string[] = [];
  for (const backup of backups) {
    try {
      writeVhost(backup, backup.content);
    } catch (error) {
      failures.push(`vhost ${backup.path}: ${errorMessage(error)}`);
    }
  }
  let restoredConfigIsValid = false;
  try {
    const restored = command(paths.nginx, ["-t"]);
    restoredConfigIsValid = restored.ok;
    if (!restored.ok) failures.push(commandError("Nginx rollback validation", restored));
  } catch (error) {
    failures.push(`Nginx rollback validation failed: ${errorMessage(error)}`);
  }
  if (restoredConfigIsValid && attemptedReload) {
    try {
      await reload(() => {
        const reloaded = command(paths.systemctl, ["reload", "nginx"]);
        if (!reloaded.ok) throw new Error((reloaded.stderr || reloaded.stdout || `exit ${reloaded.exitCode ?? "unknown"}`).trim());
      });
    } catch (error) {
      failures.push(`Nginx rollback reload failed: ${errorMessage(error)}`);
    }
  }
  return failures;
}

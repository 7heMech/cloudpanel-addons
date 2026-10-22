/**
 * DNS keeps its state as root-only JSON files: the policy, the credentials,
 * the last check, the records it tracks, a pending review and auto-SSL
 * requests. Each is written atomically with mode 0600, and one that is not a
 * root-owned regular file of that mode is refused rather than read.
 */
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { failAction } from "../../cli/action-common";
import { writeFileAtomic } from "../../lib/atomic-write";

const MAX_BYTES = 16 * 1024 * 1024;

export function readState<T>(path: string, uid: number, fallback: () => T): T {
  if (!existsSync(path)) return fallback();
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o777) !== 0o600 || stat.size > MAX_BYTES) {
    failAction(`refusing untrusted DNS state: ${path}`);
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    failAction(`DNS state is not valid JSON: ${path}`);
  }
}

export function writeState(path: string, value: unknown, uid: number): void {
  if (existsSync(path)) readState(path, uid, () => null);
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, createParent: true });
}

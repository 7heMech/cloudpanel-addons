/**
 * Scratch files a killed PHP request leaves in /tmp.
 *
 * PHP removes its upload files, ImageMagick its pixel cache and WordPress its
 * downloads when a request ends. A request stopped by `max_execution_time` or
 * php-fpm's `request_terminate_timeout` ends without that, and nothing on a
 * CloudPanel box empties /tmp short of a reboot. A WordPress image job that keeps
 * timing out leaves close to a gigabyte behind on every try.
 */
import { lstatSync, readdirSync, readFileSync, readlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { readUnixAccounts, siteAccountProblem } from "../../lib/site-accounts";

export interface TmpCleanupPaths {
  tmpDir: string;
  procDir: string;
  passwd: string;
}

export const DEFAULT_TMP_CLEANUP_PATHS: TmpCleanupPaths = {
  tmpDir: "/tmp",
  procDir: "/proc",
  passwd: "/etc/passwd",
};

export interface TmpCleanupResult {
  removed: number;
  /** Disk space the removed files held. */
  bytes: number;
}

const HOUR_MS = 3_600_000;

/**
 * ImageMagick keeps its cache files open while it uses them, so two idle hours
 * is long past any request. PHP's and WordPress's files are closed between
 * being written and being read, so they wait a day.
 */
const RULES: { name: RegExp; idleMs: number }[] = [
  { name: /^magick-/, idleMs: 2 * HOUR_MS },
  // Uploads and tmpfile().
  { name: /^php[A-Za-z0-9]{6}$/, idleMs: 24 * HOUR_MS },
  // wp_tempnam(), which download_url() and media sideloads use.
  { name: /-[A-Za-z0-9]{6}(-\d+)?\.tmp$/, idleMs: 24 * HOUR_MS },
];

/** Every path under `dir` some process has open or mapped; incomplete scans throw. */
function openPaths(procDir: string, dir: string): Set<string> {
  const prefix = `${dir}/`;
  const open = new Set<string>();
  for (const pid of readdirSync(procDir)) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      for (const fd of readdirSync(join(procDir, pid, "fd"))) {
        try {
          const target = readlinkSync(join(procDir, pid, "fd", fd));
          if (target.startsWith(prefix)) open.add(target);
        } catch (error) {
          // A descriptor can close between listing it and reading its link.
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      for (const line of readFileSync(join(procDir, pid, "maps"), "utf8").split("\n")) {
        const at = line.indexOf(prefix);
        if (at >= 0) open.add(line.slice(at).replace(/ \(deleted\)$/, ""));
      }
    } catch (error) {
      // A process may exit during the scan. Only skip it once its directory
      // is gone; an unreadable live process makes deletion unsafe.
      try {
        lstatSync(join(procDir, pid));
      } catch (pidError) {
        if ((pidError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw pidError;
      }
      throw error;
    }
  }
  return open;
}

/**
 * Remove the scratch files above that a PHP site's user owns, that have sat
 * untouched for their rule's idle time, and that no process has open. Only the
 * top level of /tmp is read, and symlinks are never followed.
 */
export function removeAbandonedTmpFiles(
  siteUsers: string[],
  paths: TmpCleanupPaths = DEFAULT_TMP_CLEANUP_PATHS,
  now = Date.now(),
): TmpCleanupResult {
  const accounts = readUnixAccounts(paths.passwd);
  const uids = new Set<number>();
  for (const user of siteUsers) {
    const account = accounts.get(user);
    if (account && !siteAccountProblem({ user, ...account })) uids.add(account.uid);
  }
  const result: TmpCleanupResult = { removed: 0, bytes: 0 };
  if (uids.size === 0) return result;

  const candidates: { path: string; blocks: number }[] = [];
  for (const name of readdirSync(paths.tmpDir)) {
    const rule = RULES.find((entry) => entry.name.test(name));
    if (!rule) continue;
    const path = join(paths.tmpDir, name);
    try {
      const stat = lstatSync(path);
      if (stat.isFile() && uids.has(stat.uid) && now - stat.mtimeMs >= rule.idleMs) {
        candidates.push({ path, blocks: stat.blocks });
      }
    } catch {}
  }
  if (candidates.length === 0) return result;

  const open = openPaths(paths.procDir, paths.tmpDir);
  for (const { path, blocks } of candidates) {
    if (open.has(path)) continue;
    try {
      unlinkSync(path);
      result.removed++;
      result.bytes += blocks * 512;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return result;
}

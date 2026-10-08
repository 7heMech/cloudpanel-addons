import { constants, closeSync, fstatSync, lstatSync, openSync, opendirSync, readFileSync, readSync, statSync, unlinkSync, type Stats } from "node:fs";
import { join } from "node:path";
import { failAction } from "../../cli/action-common";

const MAGICK_NAME = /^magick-[A-Za-z0-9_-]+$/;
const MAX_FILES = 10_000;
type FileInfo = Stats;

export interface ScratchOwner { uid: number; user: string; files: number; bytes: number }
export interface ScratchInventory { files: number; bytes: number; owners: ScratchOwner[]; truncated: boolean }
export interface CleanupResult { removed: number; bytes: number; active: number; skipped: number; error: string | null }

function entries(path: string, limit: number): { names: string[]; truncated: boolean } {
  const dir = opendirSync(path);
  const names: string[] = [];
  try {
    for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
      if (names.length === limit) return { names, truncated: true };
      names.push(entry.name);
    }
    return { names, truncated: false };
  } finally { dir.closeSync(); }
}

function vanished(error: unknown): boolean {
  return ["ENOENT", "ESRCH"].includes(String((error as NodeJS.ErrnoException).code));
}

export function scratchFiles(path: string): { files: { path: string; info: FileInfo }[]; truncated: boolean } {
  const listing = entries(path, MAX_FILES);
  const files: { path: string; info: FileInfo }[] = [];
  for (const name of listing.names) {
    if (!MAGICK_NAME.test(name)) continue;
    const file = join(path, name);
    try {
      const info = lstatSync(file);
      if (info.isFile() && info.nlink === 1) files.push({ path: file, info });
    } catch (error) { if (!vanished(error)) throw error; }
  }
  return { files, truncated: listing.truncated };
}

export function scratchInventory(path: string, passwd = "/etc/passwd"): ScratchInventory {
  const names = new Map<number, string>();
  for (const line of readFileSync(passwd, "utf8").split("\n")) {
    const parts = line.split(":");
    if (/^\d+$/.test(parts[2] ?? "")) names.set(Number(parts[2]), parts[0]!);
  }
  const listing = scratchFiles(path);
  const owners = new Map<number, ScratchOwner>();
  let bytes = 0;
  for (const { info } of listing.files) {
    const used = info.blocks * 512; // Actual disk allocation, not sparse logical size.
    bytes += used;
    const owner = owners.get(info.uid) ?? { uid: info.uid, user: names.get(info.uid) ?? String(info.uid), files: 0, bytes: 0 };
    owner.files++;
    owner.bytes += used;
    owners.set(info.uid, owner);
  }
  return { files: listing.files.length, bytes, owners: [...owners.values()].sort((a, b) => b.bytes - a.bytes), truncated: listing.truncated };
}

function inodeKey(info: FileInfo): string {
  const dev = BigInt(info.dev);
  const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & 0xfffff000n);
  const minor = (dev & 0xffn) | ((dev >> 12n) & 0xffffff00n);
  return `${major}:${minor}:${info.ino}`;
}

/** A closed descriptor may still have an mmap: inspect both /proc fd and maps. */
export function activeFileReferences(procRoot = "/proc"): Set<string> {
  const references = new Set<string>();
  const processes = entries(procRoot, 65_536);
  if (processes.truncated) failAction("process scan exceeded its limit; cleanup was skipped");
  const deadline = Date.now() + 15_000;
  for (const pid of processes.names.filter((name) => /^\d+$/.test(name))) {
    if (Date.now() > deadline) failAction("process scan timed out; cleanup was skipped");
    try {
      const fds = entries(join(procRoot, pid, "fd"), 65_536);
      if (fds.truncated) failAction("descriptor scan exceeded its limit; cleanup was skipped");
      for (const fd of fds.names) {
        try { references.add(inodeKey(statSync(join(procRoot, pid, "fd", fd)))); }
        catch (error) { if (!vanished(error)) throw error; }
      }
      const file = openSync(join(procRoot, pid, "maps"), "r");
      let maps: string;
      try {
        const buffer = Buffer.alloc(4 * 1024 * 1024 + 1);
        let count = 0;
        while (count < buffer.length) {
          const read = readSync(file, buffer, count, buffer.length - count, null);
          if (!read) break;
          count += read;
        }
        if (count === buffer.length) failAction("mapping scan exceeded its limit; cleanup was skipped");
        maps = buffer.subarray(0, count).toString("utf8");
      } finally { closeSync(file); }
      for (const line of maps.split("\n")) {
        const match = /^\S+\s+\S+\s+\S+\s+([0-9a-f]+):([0-9a-f]+)\s+(\d+)/i.exec(line);
        if (match && match[3] !== "0") references.add(`${parseInt(match[1]!, 16)}:${parseInt(match[2]!, 16)}:${match[3]}`);
      }
    } catch (error) {
      if (!vanished(error)) throw new Error(`cannot inspect process ${pid}; cleanup was skipped: ${String(error)}`);
    }
  }
  return references;
}

export function cleanScratch(
  path: string, ageHours: number, references: Set<string>, now = Date.now(),
): CleanupResult {
  const result: CleanupResult = { removed: 0, bytes: 0, active: 0, skipped: 0, error: null };
  const cutoff = now - ageHours * 3_600_000;
  for (const candidate of scratchFiles(path).files) {
    const info = candidate.info;
    if (Math.max(info.atimeMs, info.mtimeMs, info.ctimeMs) > cutoff) { result.skipped++; continue; }
    if (references.has(inodeKey(info))) { result.active++; continue; }
    let fd: number | undefined;
    try {
      // O_NONBLOCK prevents a raced FIFO from hanging the root cleanup process.
      fd = openSync(candidate.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const opened = fstatSync(fd);
      const current = lstatSync(candidate.path);
      if (!current.isFile() || current.nlink !== 1 || current.dev !== info.dev || current.ino !== info.ino
        || opened.dev !== info.dev || opened.ino !== info.ino
        || current.size !== info.size || current.mtimeMs !== info.mtimeMs || current.ctimeMs !== info.ctimeMs) {
        result.skipped++;
        continue;
      }
      unlinkSync(candidate.path); // No recursion, no content writes, no symlink following.
      result.removed++;
      result.bytes += info.blocks * 512;
    } catch (error) {
      result.skipped++;
      if (!vanished(error)) result.error = String(error);
    } finally { if (fd !== undefined) closeSync(fd); }
  }
  return result;
}

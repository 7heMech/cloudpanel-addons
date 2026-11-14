/**
 * Root working in a tree a site user can change. A path there is looked up
 * again on every call, so a directory the user swaps for a link between a
 * check and its use sends root wherever the link points. These hold the
 * directory open instead and name things relative to it, like the `*at()`
 * calls, and follow no link.
 */
import {
  closeSync, constants, copyFileSync, fchmodSync, fstatSync, futimesSync, lstatSync, mkdirSync, openSync,
  readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, type Stats,
} from "node:fs";
import { basename, dirname } from "node:path";

const DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FILE = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** `name` in the directory `dirFd` has open, or what `dirFd` has open; it also reaches it from a child process. */
export function at(dirFd: number, name?: string): string {
  const path = `/proc/${process.pid}/fd/${dirFd}`;
  return name === undefined ? path : `${path}/${name}`;
}

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

/** Opens directory `path` with no link at any component, creating missing ones with `mode` when it is given. */
export function openDirNoFollow(path: string, mode?: number): number {
  let fd = openSync("/", DIRECTORY);
  try {
    for (const name of path.split("/").filter(Boolean)) {
      if (name === "." || name === "..") throw new Error(`refusing ${path}: it is not a plain path`);
      let next: number;
      try {
        next = openSync(at(fd, name), DIRECTORY);
      } catch (error) {
        if (code(error) === "ENOTDIR" || code(error) === "ELOOP") throw new Error(`refusing ${path}: a link or file stands where a directory belongs`);
        if (mode === undefined || code(error) !== "ENOENT") throw error;
        try { mkdirSync(at(fd, name), { mode }); } catch (made) { if (code(made) !== "EEXIST") throw made; }
        next = openSync(at(fd, name), DIRECTORY);
      }
      closeSync(fd);
      fd = next;
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

export function withDirNoFollow<T>(path: string, body: (dirFd: number) => T, mode?: number): T {
  const fd = openDirNoFollow(path, mode);
  try {
    return body(fd);
  } finally {
    closeSync(fd);
  }
}

/** Opens regular file `path` with no link anywhere in it; null when it does not exist. */
export function openFileNoFollow(path: string): number | null {
  let fd: number;
  try {
    fd = withDirNoFollow(dirname(path), (dir) => openSync(at(dir, basename(path)), FILE));
  } catch (error) {
    if (code(error) === "ENOENT") return null;
    if (code(error) === "ELOOP") throw new Error(`refusing ${path}: it is a link`);
    throw error;
  }
  if (fstatSync(fd).isFile()) return fd;
  closeSync(fd);
  throw new Error(`refusing ${path}: it is not a regular file`);
}

export function readFileNoFollow(path: string): string | null {
  const fd = openFileNoFollow(path);
  if (fd === null) return null;
  try {
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

/** rm -rf `path`, following no link on the way to it. */
export function removeNoFollow(path: string): void {
  let dir: number;
  try {
    dir = openDirNoFollow(dirname(path));
  } catch (error) {
    if (code(error) === "ENOENT") return;
    throw error;
  }
  try {
    rmSync(at(dir, basename(path)), { recursive: true, force: true });
  } finally {
    closeSync(dir);
  }
}

/**
 * Copies the regular file `fd` has open to `name` in `into`, which must not
 * exist, with its mode and times. The copy is made and finished through its
 * own descriptor: `into` may be a directory the site user can write, where the
 * name could be swapped for a link once it exists.
 */
function copyOpenFile(fd: number, info: Stats, into: number, name: string): void {
  const out = openSync(at(into, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    copyFileSync(at(fd), at(out));
    fchmodSync(out, info.mode & 0o777);
    futimesSync(out, info.atime, info.mtime);
  } finally {
    closeSync(out);
  }
}

function copyToPath(fd: number, destination: string): void {
  withDirNoFollow(dirname(destination), (into) => copyOpenFile(fd, fstatSync(fd), into, basename(destination)));
}

/** Copies regular file `path` to `destination`, which must not exist; false when there is no file. */
export function copyFileNoFollow(path: string, destination: string): boolean {
  const fd = openFileNoFollow(path);
  if (fd === null) return false;
  try {
    copyToPath(fd, destination);
    return true;
  } finally {
    closeSync(fd);
  }
}

/** Copies regular file `name` in directory `dirFd` to `destination`, which must not exist. */
export function copyFileAt(dirFd: number, name: string, destination: string): void {
  const fd = openSync(at(dirFd, name), FILE);
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`refusing ${name}: it is not a regular file`);
    copyToPath(fd, destination);
  } finally {
    closeSync(fd);
  }
}

/**
 * cp -a of the directory `from` has open into a new directory `name` in
 * `into`. A link is copied as a link; anything but files, directories and
 * links is left out.
 */
export function copyTreeNoFollow(from: number, into: number, name: string): void {
  const info = fstatSync(from);
  mkdirSync(at(into, name), { mode: 0o700 });
  const to = openSync(at(into, name), DIRECTORY);
  try {
    for (const entry of readdirSync(at(from))) {
      const source = at(from, entry);
      let stat: Stats;
      try { stat = lstatSync(source); } catch (error) { if (code(error) === "ENOENT") continue; throw error; }
      if (stat.isSymbolicLink()) {
        symlinkSync(readlinkSync(source), at(to, entry));
      } else if (stat.isDirectory() || stat.isFile()) {
        const fd = openSync(source, stat.isDirectory() ? DIRECTORY : FILE);
        try {
          const opened = fstatSync(fd);
          if (opened.isDirectory()) copyTreeNoFollow(fd, to, entry);
          else if (opened.isFile()) copyOpenFile(fd, opened, to, entry);
        } finally {
          closeSync(fd);
        }
      }
    }
    fchmodSync(to, info.mode & 0o777);
    futimesSync(to, info.atime, info.mtime);
  } finally {
    closeSync(to);
  }
}

/** Makes directory `path` and any missing parent with `mode`, following no link on the way. */
export function mkdirNoFollow(path: string, mode: number): void {
  closeSync(openDirNoFollow(path, mode));
}

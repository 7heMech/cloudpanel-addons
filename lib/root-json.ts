import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "./atomic-write";

export function readRootJson<T>(path: string, fallback: () => T, uid = 0): T {
  let stat;
  try { stat = lstatSync(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return fallback(); throw e; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o777) !== 0o600 || stat.size > 16 * 1024 * 1024) throw new Error("Root state must be a root-owned regular file with mode 0600 and bounded size");
  try { return JSON.parse(readFileSync(path, "utf8")) as T; }
  catch { throw new Error("Root state is not valid JSON"); }
}

export function writeRootJson(path: string, value: unknown, uid = 0): void {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const stat = lstatSync(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o022) !== 0) throw new Error("Root state directory is not trusted");
  readRootJson(path, () => null, uid);
  writeFileAtomic(path, `${JSON.stringify(value)}\n`, { mode: 0o600, owner: { uid, gid: process.getgid?.() ?? 0 } });
}

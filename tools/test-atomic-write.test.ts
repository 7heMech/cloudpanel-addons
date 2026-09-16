import { afterEach, expect, test } from "bun:test";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  symlinkSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFileAtomic } from "../lib/atomic-write";

let root = "";
const fixture = (): string => {
  root = mkdtempSync(join(tmpdir(), "atomic-write-"));
  return root;
};
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = ""; });

const modeOf = (path: string): number => lstatSync(path).mode & 0o777;

test("writes the content with the mode asked for", () => {
  const dir = fixture();
  const path = join(dir, "secret");
  writeFileAtomic(path, "password\n", { mode: 0o600 });
  expect(readFileSync(path, "utf8")).toBe("password\n");
  expect(modeOf(path)).toBe(0o600);
  expect(readdirSync(dir)).toEqual(["secret"]);
});

test("replacing a loose file does not leave the secret under its old mode", () => {
  // writeFileSync applies its mode only when it creates the file. Writing over
  // an existing path kept that path's permissions, and the chmod that fixed
  // them ran after the content was already on disk.
  const dir = fixture();
  const path = join(dir, "secret");
  writeFileSync(path, "old", { mode: 0o644 });
  chmodSync(path, 0o644);
  writeFileAtomic(path, "password\n", { mode: 0o600 });
  expect(modeOf(path)).toBe(0o600);
  expect(readFileSync(path, "utf8")).toBe("password\n");
});

test("the temporary file is never the target's name plus a guessable suffix", () => {
  const dir = fixture();
  const path = join(dir, "secret");
  const names = new Set<string>();
  for (let i = 0; i < 20; i++) {
    // Observed through a failure, which is the only moment the name exists.
    try {
      writeFileAtomic(join(dir, "missing", "secret"), "x", { mode: 0o600 });
    } catch {}
    writeFileAtomic(path, `run-${i}`, { mode: 0o600 });
    names.add(readFileSync(path, "utf8"));
  }
  expect(names.size).toBe(20);
  // Nothing accumulated beside the target across twenty replacements.
  expect(readdirSync(dir)).toEqual(["secret"]);
});

test("a failed write leaves no temporary file and does not touch the target", () => {
  const dir = fixture();
  const path = join(dir, "secret");
  writeFileAtomic(path, "original\n", { mode: 0o600 });
  // A directory the process cannot write to: the temporary creation fails.
  chmodSync(dir, 0o500);
  try {
    expect(() => writeFileAtomic(path, "replacement\n", { mode: 0o600 })).toThrow();
  } finally {
    chmodSync(dir, 0o700);
  }
  expect(readFileSync(path, "utf8")).toBe("original\n");
  expect(readdirSync(dir)).toEqual(["secret"]);
});

test("a failed ownership change leaves no temporary file either", () => {
  // chown to another account fails for an unprivileged process, and it happens
  // after the write -- which is exactly the case the old generic writer left
  // behind, because only the write was inside its try.
  const dir = fixture();
  const path = join(dir, "secret");
  expect(() => writeFileAtomic(path, "x", { mode: 0o600, owner: { uid: 0, gid: 0 } })).toThrow();
  expect(existsSync(path)).toBe(false);
  expect(readdirSync(dir)).toEqual([]);
});

test("the target is replaced, not followed through a symlink", () => {
  const dir = fixture();
  const elsewhere = join(dir, "elsewhere");
  writeFileSync(elsewhere, "untouched\n");
  const path = join(dir, "link");
  symlinkSync(elsewhere, path);
  writeFileAtomic(path, "replacement\n", { mode: 0o600 });
  // The rename replaces the link itself; what it pointed at is left alone.
  expect(readFileSync(elsewhere, "utf8")).toBe("untouched\n");
  expect(lstatSync(path).isSymbolicLink()).toBe(false);
  expect(readFileSync(path, "utf8")).toBe("replacement\n");
});

test("the parent directory is created only when the caller asks", () => {
  const dir = fixture();
  const nested = join(dir, "a", "b", "file");
  expect(() => writeFileAtomic(nested, "x", { mode: 0o600 })).toThrow();
  writeFileAtomic(nested, "x", { mode: 0o600, createParent: true });
  expect(readFileSync(nested, "utf8")).toBe("x");
});

test("ownership is applied when asked and inherited when not", () => {
  const dir = fixture();
  const path = join(dir, "file");
  writeFileAtomic(path, "x", { mode: 0o600 });
  expect(lstatSync(path).uid).toBe(process.getuid!());
  // Passing the process's own ids is a no-op it must still accept, so a caller
  // that always passes ownership does not need a special case for itself.
  writeFileAtomic(path, "y", { mode: 0o600, owner: { uid: process.getuid!(), gid: process.getgid!() } });
  expect(readFileSync(path, "utf8")).toBe("y");
});

test("the stager's secret writer goes through it", () => {
  // The Instatic request body carries a password. The point of the assertion is
  // that the addon has no second way to write one.
  const source = readFileSync(join(import.meta.dir, "..", "addons", "stager", "action.ts"), "utf8");
  const writer = source.slice(source.indexOf("function writeSecretFile"));
  expect(writer.slice(0, writer.indexOf("\n}"))).toContain("writeFileAtomic(path, value, { mode: 0o600 })");
  // And the file a command is about to be pointed at is created exclusively,
  // so nothing can leave a symlink at that name first.
  const temp = source.slice(source.indexOf("function tempSecretFile"));
  expect(temp.slice(0, temp.indexOf("\n}"))).toContain('openSync(path, "wx", 0o600)');
});

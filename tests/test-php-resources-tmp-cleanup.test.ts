import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { chownSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeAbandonedTmpFiles, type TmpCleanupPaths } from "../addons/php-resources/tmp-cleanup";

const HOUR = 3_600_000;
const NOW = Date.now();
const runnerUid = process.getuid?.() ?? 1000;
const uid = runnerUid || 1000;

function makeBox(passwdUser = "shop"): { paths: TmpCleanupPaths; root: string; file: (name: string, ageHours: number) => string } {
  const root = mkdtempSync(join(tmpdir(), "clp-tmp-cleanup-"));
  const paths = { tmpDir: join(root, "tmp"), procDir: join(root, "proc"), passwd: join(root, "passwd") };
  mkdirSync(paths.tmpDir);
  mkdirSync(paths.procDir);
  writeFileSync(paths.passwd, `root:x:0:0::/root:/bin/bash\n${passwdUser}:x:${uid}:${uid}::/home/shop:/bin/bash\n`);
  return {
    paths,
    root,
    file(name, ageHours) {
      const path = join(paths.tmpDir, name);
      writeFileSync(path, "x".repeat(4096));
      if (runnerUid === 0) chownSync(path, uid, uid);
      const at = (NOW - ageHours * HOUR) / 1000;
      utimesSync(path, at, at);
      return path;
    },
  };
}

test("abandoned PHP, ImageMagick and WordPress scratch files are removed once idle long enough", () => {
  const box = makeBox();
  try {
    const gone = [
      box.file("magick-Ab12Cd34Ef56Gh78", 3),
      box.file("phpA1b2C3", 25),
      box.file("plugin-download-aB3dE9.tmp", 25),
      box.file("image-Xy7Zq2-1.tmp", 25),
    ];
    const kept = [
      box.file("magick-recent", 1),
      box.file("phpRecent", 3),
      box.file("plugin-recent-aB3dE9.tmp", 3),
      box.file("notes.txt", 100),
      box.file("phpA1b2C3extra", 100),
    ];
    const result = removeAbandonedTmpFiles(["shop"], box.paths, NOW);
    expect(result.removed).toBe(4);
    expect(result.bytes).toBeGreaterThan(0);
    for (const path of gone) expect(existsSync(path)).toBe(false);
    for (const path of kept) expect(existsSync(path)).toBe(true);
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test("a file some process has open or mapped is kept", () => {
  const box = makeBox();
  try {
    const opened = box.file("magick-opened", 5);
    const mapped = box.file("magick-mapped", 5);
    mkdirSync(join(box.paths.procDir, "42/fd"), { recursive: true });
    symlinkSync(opened, join(box.paths.procDir, "42/fd/3"));
    writeFileSync(join(box.paths.procDir, "42/maps"), `7f00-7f01 rw-s 00000000 08:01 1234    ${mapped}\n`);
    mkdirSync(join(box.paths.procDir, "self"));

    expect(removeAbandonedTmpFiles(["shop"], box.paths, NOW).removed).toBe(0);
    expect(existsSync(opened)).toBe(true);
    expect(existsSync(mapped)).toBe(true);
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test("only files a PHP site's own user owns are removed, and symlinks never are", () => {
  const box = makeBox();
  try {
    const target = box.file("notes.txt", 100);
    const link = join(box.paths.tmpDir, "magick-link");
    symlinkSync(target, link);
    const file = box.file("magick-Ab12Cd34", 5);

    expect(removeAbandonedTmpFiles([], box.paths, NOW).removed).toBe(0);
    expect(removeAbandonedTmpFiles(["other"], box.paths, NOW).removed).toBe(0);
    expect(existsSync(file)).toBe(true);

    expect(removeAbandonedTmpFiles(["shop"], box.paths, NOW).removed).toBe(1);
    expect(existsSync(link)).toBe(true);
    expect(existsSync(target)).toBe(true);
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test("a site recorded under a system login is not trusted as a site user", () => {
  const box = makeBox("postfix");
  try {
    const file = box.file("magick-Ab12Cd34", 5);
    expect(removeAbandonedTmpFiles(["postfix"], box.paths, NOW).removed).toBe(0);
    expect(existsSync(file)).toBe(true);
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

for (const operation of ["readdirSync", "readlinkSync", "readFileSync"] as const) {
  test(`an inaccessible process ${operation} stops cleanup before any deletion`, () => {
    const box = makeBox();
    const original = fs[operation];
    const denied = Object.assign(new Error("process inspection denied"), { code: "EACCES" });
    const pidDir = join(box.paths.procDir, "42");
    let restore: (() => void) | undefined;
    try {
      const file = box.file("magick-abandoned", 5);
      mkdirSync(join(pidDir, "fd"), { recursive: true });
      symlinkSync(file, join(pidDir, "fd/3"));
      writeFileSync(join(pidDir, "maps"), "");
      const deniedPath = join(pidDir, operation === "readdirSync" ? "fd" : operation === "readlinkSync" ? "fd/3" : "maps");
      const spy = spyOn(fs, operation).mockImplementation(((...args: any[]) => {
        if (args[0] === deniedPath) throw denied;
        return (original as (...args: any[]) => any)(...args);
      }) as typeof original);
      restore = () => spy.mockRestore();

      expect(() => removeAbandonedTmpFiles(["shop"], box.paths, NOW)).toThrow(denied);
      expect(existsSync(file)).toBe(true);
    } finally {
      restore?.();
      rmSync(box.root, { recursive: true, force: true });
    }
  });
}

test("a missing maps file on a process that still exists stops cleanup", () => {
  const box = makeBox();
  try {
    const file = box.file("magick-abandoned", 5);
    mkdirSync(join(box.paths.procDir, "42/fd"), { recursive: true });
    expect(() => removeAbandonedTmpFiles(["shop"], box.paths, NOW)).toThrow();
    expect(existsSync(file)).toBe(true);
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test("exited processes and closed descriptors do not block cleanup", () => {
  const box = makeBox();
  const original = fs.readlinkSync;
  let restore: (() => void) | undefined;
  try {
    const file = box.file("magick-abandoned", 5);
    mkdirSync(join(box.paths.procDir, "42/fd"), { recursive: true });
    symlinkSync(file, join(box.paths.procDir, "42/fd/3"));
    mkdirSync(join(box.paths.procDir, "43"));
    writeFileSync(join(box.paths.procDir, "42/maps"), "");
    const spy = spyOn(fs, "readlinkSync").mockImplementation(((...args: Parameters<typeof original>) => {
      if (args[0] === join(box.paths.procDir, "42/fd/3")) {
        throw Object.assign(new Error("descriptor closed"), { code: "ENOENT" });
      }
      return original(...args);
    }) as typeof original);
    restore = () => spy.mockRestore();
    // Remove the process directory after it has appeared in the /proc listing.
    const readDir = fs.readdirSync;
    const dirSpy = spyOn(fs, "readdirSync").mockImplementation(((...args: Parameters<typeof readDir>) => {
      const entries = readDir(...args);
      if (args[0] === box.paths.procDir) rmSync(join(box.paths.procDir, "43"), { recursive: true });
      return entries;
    }) as typeof readDir);
    const restoreLink = restore;
    restore = () => { dirSpy.mockRestore(); restoreLink(); };

    expect(removeAbandonedTmpFiles(["shop"], box.paths, NOW).removed).toBe(1);
    expect(existsSync(file)).toBe(false);
  } finally {
    restore?.();
    rmSync(box.root, { recursive: true, force: true });
  }
});

for (const code of ["ENOENT", "EACCES", "EROFS"]) {
  test(`unlink ${code} ${code === "ENOENT" ? "is ignored" : "is reported"}`, () => {
    const box = makeBox();
    const error = Object.assign(new Error(`unlink failed: ${code}`), { code });
    let restore: (() => void) | undefined;
    try {
      const file = box.file("magick-abandoned", 5);
      const spy = spyOn(fs, "unlinkSync").mockImplementation(() => { throw error; });
      restore = () => spy.mockRestore();
      if (code === "ENOENT") {
        expect(removeAbandonedTmpFiles(["shop"], box.paths, NOW)).toEqual({ removed: 0, bytes: 0 });
      } else {
        expect(() => removeAbandonedTmpFiles(["shop"], box.paths, NOW)).toThrow(error);
      }
      expect(existsSync(file)).toBe(true);
    } finally {
      restore?.();
      rmSync(box.root, { recursive: true, force: true });
    }
  });
}

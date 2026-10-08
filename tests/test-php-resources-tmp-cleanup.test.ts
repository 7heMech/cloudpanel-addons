import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeAbandonedTmpFiles, type TmpCleanupPaths } from "../addons/php-resources/tmp-cleanup";

const HOUR = 3_600_000;
const NOW = Date.now();
const uid = process.getuid?.() ?? 1000;

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

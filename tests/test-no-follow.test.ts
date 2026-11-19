import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  copyFileNoFollow, copyTreeNoFollow, mkdirNoFollow, openFileNoFollow, removeNoFollow, withDirNoFollow,
} from "../lib/no-follow";

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "no-follow-"));
  mkdirSync(join(root, "secret"));
  writeFileSync(join(root, "secret", "key"), "root only");
  mkdirSync(join(root, "site"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("a link anywhere on the way is refused, not followed", () => {
  symlinkSync(join(root, "secret"), join(root, "site", "data"));
  expect(() => withDirNoFollow(join(root, "site", "data"), () => {})).toThrow("a link or file stands where a directory belongs");
  expect(() => mkdirNoFollow(join(root, "site", "data", "new"), 0o750)).toThrow("a link or file stands where a directory belongs");
  expect(existsSync(join(root, "secret", "new"))).toBe(false);
  expect(() => copyFileNoFollow(join(root, "site", "data", "key"), join(root, "copy"))).toThrow();
  symlinkSync(join(root, "secret", "key"), join(root, "site", "env"));
  expect(() => openFileNoFollow(join(root, "site", "env"))).toThrow("it is a link");
});

test("a missing directory is made with the mode asked for", () => {
  mkdirNoFollow(join(root, "site", "a", "b"), 0o750);
  expect(lstatSync(join(root, "site", "a", "b")).isDirectory()).toBe(true);
  expect(openFileNoFollow(join(root, "site", "a", "b", "missing"))).toBeNull();
});

test("removing through a linked parent removes nothing it points at", () => {
  symlinkSync(join(root, "secret"), join(root, "site", "data"));
  expect(() => removeNoFollow(join(root, "site", "data", "key"))).toThrow();
  removeNoFollow(join(root, "site", "data"));
  expect(existsSync(join(root, "site", "data"))).toBe(false);
  expect(readFileSync(join(root, "secret", "key"), "utf8")).toBe("root only");
});

test("a copied tree keeps its links as links", () => {
  mkdirSync(join(root, "site", "uploads", "inner"), { recursive: true });
  writeFileSync(join(root, "site", "uploads", "inner", "photo.txt"), "media");
  symlinkSync(join(root, "secret"), join(root, "site", "uploads", "leak"));
  mkdirSync(join(root, "stage"));
  withDirNoFollow(join(root, "site", "uploads"), (from) =>
    withDirNoFollow(join(root, "stage"), (into) => copyTreeNoFollow(from, into, "uploads")));
  expect(readFileSync(join(root, "stage", "uploads", "inner", "photo.txt"), "utf8")).toBe("media");
  expect(lstatSync(join(root, "stage", "uploads", "leak")).isSymbolicLink()).toBe(true);
  expect(readlinkSync(join(root, "stage", "uploads", "leak"))).toBe(join(root, "secret"));
});

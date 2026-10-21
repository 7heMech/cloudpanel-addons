import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectPhpGuard, reconcilePhpSessionGuard, type PhpGuardOptions } from "../cli/php-guard";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const INI = join("fpm", "conf.d", "99-clp-addons-upload-progress.ini");
const DISABLED = "session.upload_progress.enabled = Off";

interface Box { options: PhpGuardOptions; phpRoot: string; fpmBinDir: string; commands: string[]; dropIn: (version: string) => string }

/** `fpmVersions` get a conf.d plus a binary; `orphanVersions` get a conf.d but no binary. */
function box(fpmVersions: string[], orphanVersions: string[] = [], active = new Set<string>()): Box {
  const dir = mkdtempSync(join(tmpdir(), "clp-phpguard-"));
  dirs.push(dir);
  const phpRoot = join(dir, "php");
  const fpmBinDir = join(dir, "sbin");
  mkdirSync(fpmBinDir, { recursive: true });
  for (const version of [...fpmVersions, ...orphanVersions]) mkdirSync(join(phpRoot, version, "fpm", "conf.d"), { recursive: true });
  for (const version of fpmVersions) writeFileSync(join(fpmBinDir, `php-fpm${version}`), "");
  const commands: string[] = [];
  const run: NonNullable<PhpGuardOptions["run"]> = (cmd, args) => {
    commands.push(`${cmd} ${args.join(" ")}`);
    return { ok: true, out: "" };
  };
  return {
    phpRoot, fpmBinDir, commands,
    dropIn: (version) => join(phpRoot, version, INI),
    options: {
      run,
      isActive: (unit) => active.has(unit),
      paths: { phpRoot, fpmBinDir, panelFpmUnit: "clp-php-fpm.service", rootUid: process.getuid!() },
    },
  };
}

test("install writes the drop-in on every FPM, tests each, and reloads only active services", () => {
  const b = box(["8.1", "8.3"], [], new Set(["php8.3-fpm.service", "clp-php-fpm.service"]));
  const changed = reconcilePhpSessionGuard(true, b.options);
  expect(changed).toBe(2);
  expect(readFileSync(b.dropIn("8.1"), "utf8")).toContain(DISABLED);
  expect(readFileSync(b.dropIn("8.3"), "utf8")).toContain(DISABLED);
  // Both versions are config-tested; only the active FPM units reload, panel included.
  expect(b.commands.filter((c) => c.endsWith("php-fpm8.1 -t")).length).toBe(1);
  expect(b.commands).toContain("systemctl reload php8.3-fpm.service");
  expect(b.commands).not.toContain("systemctl reload php8.1-fpm.service");
  expect(b.commands).toContain("systemctl reload clp-php-fpm.service");
});

test("a second install is a no-op and reloads nothing", () => {
  const b = box(["8.1"], [], new Set(["php8.1-fpm.service"]));
  expect(reconcilePhpSessionGuard(true, b.options)).toBe(1);
  b.commands.length = 0;
  expect(reconcilePhpSessionGuard(true, b.options)).toBe(0);
  expect(b.commands).toEqual([]);
  expect(inspectPhpGuard(b.options)).toEqual({ guarded: ["8.1"], unguarded: [] });
});

test("an orphaned conf.d without its FPM binary is left untouched", () => {
  const b = box(["8.2"], ["7.4"]);
  reconcilePhpSessionGuard(true, b.options);
  expect(existsSync(b.dropIn("8.2"))).toBe(true);
  expect(existsSync(b.dropIn("7.4"))).toBe(false);
  expect(inspectPhpGuard(b.options).unguarded).toEqual([]);
});

test("a failed config test rolls the files back and rethrows", () => {
  const b = box(["8.1", "8.3"]);
  b.options.run = (cmd, args) => {
    b.commands.push(`${cmd} ${args.join(" ")}`);
    if (cmd.endsWith("php-fpm8.3") && args[0] === "-t") return { ok: false, out: "syntax error" };
    return { ok: true, out: "" };
  };
  expect(() => reconcilePhpSessionGuard(true, b.options)).toThrow("php-fpm8.3 rejected");
  expect(existsSync(b.dropIn("8.1"))).toBe(false);
  expect(existsSync(b.dropIn("8.3"))).toBe(false);
  expect(b.commands).not.toContain("systemctl reload php8.1-fpm.service");
});

test("uninstall removes the drop-in everywhere", () => {
  const b = box(["8.1", "8.3"], [], new Set(["clp-php-fpm.service"]));
  reconcilePhpSessionGuard(true, b.options);
  const removed = reconcilePhpSessionGuard(false, b.options);
  expect(removed).toBe(2);
  expect(existsSync(b.dropIn("8.1"))).toBe(false);
  expect(existsSync(b.dropIn("8.3"))).toBe(false);
  expect(inspectPhpGuard(b.options)).toEqual({ guarded: [], unguarded: ["8.1", "8.3"] });
});

test("a symlinked drop-in is distrusted and overwritten with a real file", () => {
  const b = box(["8.1"]);
  const target = b.dropIn("8.1");
  const decoy = join(b.phpRoot, "decoy");
  writeFileSync(decoy, "session.upload_progress.enabled = On\n");
  symlinkSync(decoy, target);
  const changed = reconcilePhpSessionGuard(true, b.options);
  expect(changed).toBe(1);
  expect(readFileSync(target, "utf8")).toContain(DISABLED);
  // The decoy the link pointed at is untouched; the real file replaced the link.
  expect(readFileSync(decoy, "utf8")).toContain("On");
});

test("a group-writable drop-in is distrusted and rewritten to 0644", () => {
  const b = box(["8.1"]);
  reconcilePhpSessionGuard(true, b.options);
  chmodSync(b.dropIn("8.1"), 0o664);
  expect(inspectPhpGuard(b.options).unguarded).toEqual(["8.1"]);
  // The same content under the wrong mode is still a change: reconcile restores 0644.
  expect(reconcilePhpSessionGuard(true, b.options)).toBe(1);
  expect(statSync(b.dropIn("8.1")).mode & 0o777).toBe(0o644);
  expect(inspectPhpGuard(b.options)).toEqual({ guarded: ["8.1"], unguarded: [] });
});

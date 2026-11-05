import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_BACKUP_COMPRESSION, backupCompressionBlock, backupCompressionStatus, reconcileBackupCompression, validBackupCompression,
  type BackupCompressionOptions,
} from "../addons/system-tweaks/backup-compression";
import { executeSystemTweaksAction, readSettings } from "../addons/system-tweaks/action";
import { handle } from "../addons/system-tweaks/app";

// The contract that the pinned CloudPanel command exposes. Actual CloudPanel
// source is exercised separately by integration-backup-compression.ts.
const ORIGINAL = `<?php
function backup($siteUser, $tarCreator, $sources, $excludes) {
  $destinationFile = sprintf('/home/%s/tmp/backup.tar', $siteUser);
  try {
    $tarCreator->create($sources, $destinationFile, $excludes);
    upload($destinationFile);
  } finally { cleanup($destinationFile); }
}
`;
const TAR = "fixture tar builder";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "clp-backup-test-"));
  dirs.push(dir);
  const remoteCommand = join(dir, "RemoteBackupCreateCommand.php");
  const tarCommand = join(dir, "TarCreateCommand.php");
  writeFileSync(remoteCommand, ORIGINAL, { mode: 0o750 });
  writeFileSync(tarCommand, TAR);
  const calls: string[][] = [];
  const options: BackupCompressionOptions = {
    paths: { remoteCommand, tarCommand }, version: "2.5.4-3",
    fingerprints: { remote: sha(ORIGINAL), tar: sha(TAR) },
    run: (command, args) => { calls.push([command, ...args]); return { ok: true, stdout: "", stderr: "" }; },
  };
  return { dir, remoteCommand, tarCommand, calls, options, read: () => readFileSync(remoteCommand, "utf8") };
}
const ON = { ...DEFAULT_BACKUP_COMPRESSION, enabled: true };

test("off is the default and leaves CloudPanel's code alone, including unfamiliar versions", () => {
  const f = fixture();
  expect(readSettings({ settingsFile: join(f.dir, "settings.json"), lockFile: "unused", rootUid: process.getuid!() }).backupCompression).toEqual(DEFAULT_BACKUP_COMPRESSION);
  writeFileSync(f.remoteCommand, "an upstream implementation we do not know");
  expect(reconcileBackupCompression(DEFAULT_BACKUP_COMPRESSION, f.options)).toBe(false);
  expect(f.calls).toEqual([]);
  expect(f.read()).toBe("an upstream implementation we do not know");
});

test("filename, tar compression and excludes move together; turning off restores every original byte and mode", () => {
  const f = fixture();
  expect(reconcileBackupCompression(ON, f.options)).toBe(true);
  const next = f.read();
  expect(next).toContain("$destinationFile .= '.zst';");
  expect(next).toContain("'/usr/bin/zstd -3 -T1 --long=27'");
  expect(next).toContain("$clpAddonsTar->setExcludes($excludes);");
  expect(next).toContain("upload($destinationFile);");
  expect(next).toContain("cleanup($destinationFile);");
  expect(lstatSync(f.remoteCommand).mode & 0o777).toBe(0o750);
  expect(backupCompressionStatus(ON, f.options)).toMatchObject({ active: true, supported: true, installed: true });
  expect(reconcileBackupCompression(ON, f.options)).toBe(false);
  const stronger = { enabled: true, level: 9, threads: 2 };
  expect(reconcileBackupCompression(stronger, f.options)).toBe(true);
  expect(f.read()).toContain("'/usr/bin/zstd -9 -T2 --long=27'");
  expect(f.read().split("$destinationFile .= '.zst';")).toHaveLength(2);
  expect(backupCompressionStatus(ON, f.options).active).toBe(false);
  // Restore does not depend on the current package or on zstd still being installed.
  expect(reconcileBackupCompression(DEFAULT_BACKUP_COMPRESSION, { ...f.options, version: "next", run: () => { throw new Error("must not execute"); } })).toBe(true);
  expect(f.read()).toBe(ORIGINAL);
  expect(lstatSync(f.remoteCommand).mode & 0o777).toBe(0o750);
});

test("repair re-applies a known original after a package replaces it", () => {
  const f = fixture();
  reconcileBackupCompression(ON, f.options);
  writeFileSync(f.remoteCommand, ORIGINAL);
  expect(backupCompressionStatus(ON, f.options).active).toBe(false);
  expect(reconcileBackupCompression(ON, f.options)).toBe(true);
  expect(backupCompressionStatus(ON, f.options).active).toBe(true);
});

test("a block from before long mode is upgraded by repair and restored by disable", () => {
  const f = fixture();
  writeFileSync(f.remoteCommand, ORIGINAL.replace("$tarCreator->create($sources, $destinationFile, $excludes);", backupCompressionBlock(ON, false)));
  // It already writes backup.tar.zst at the chosen level.
  expect(backupCompressionStatus(ON, f.options).active).toBe(true);
  expect(reconcileBackupCompression(ON, f.options)).toBe(true);
  expect(f.read()).toContain("'/usr/bin/zstd -3 -T1 --long=27'");
  expect(backupCompressionStatus(ON, f.options).active).toBe(true);
  writeFileSync(f.remoteCommand, ORIGINAL.replace("$tarCreator->create($sources, $destinationFile, $excludes);", backupCompressionBlock(ON, false)));
  expect(reconcileBackupCompression(DEFAULT_BACKUP_COMPRESSION, f.options)).toBe(true);
  expect(f.read()).toBe(ORIGINAL);
});

test("unknown versions, modified source and a changed tar builder are refused before writes", () => {
  const f = fixture();
  expect(() => reconcileBackupCompression(ON, { ...f.options, version: "2.6.0" })).toThrow("has not been checked");
  expect(f.read()).toBe(ORIGINAL);
  writeFileSync(f.tarCommand, "different tar semantics");
  expect(() => reconcileBackupCompression(ON, f.options)).toThrow("tar command has changed");
  expect(f.read()).toBe(ORIGINAL);
  writeFileSync(f.tarCommand, TAR);
  writeFileSync(f.remoteCommand, ORIGINAL + "// operator edit");
  expect(backupCompressionStatus(ON, f.options)).toMatchObject({ active: false, supported: false });
  expect(() => reconcileBackupCompression(ON, f.options)).toThrow("not a version this tweak supports");
  expect(f.read()).toBe(ORIGINAL + "// operator edit");
});

test("edited managed code and symlinks are never replaced on disable", () => {
  const f = fixture();
  reconcileBackupCompression(ON, f.options);
  writeFileSync(f.remoteCommand, f.read().replace("-T1", "-T0"));
  const edited = f.read();
  expect(() => reconcileBackupCompression(DEFAULT_BACKUP_COMPRESSION, f.options)).toThrow("block was edited");
  expect(f.read()).toBe(edited);
  rmSync(f.remoteCommand);
  symlinkSync(f.tarCommand, f.remoteCommand);
  expect(() => reconcileBackupCompression(ON, f.options)).toThrow("not a regular");
  expect(readFileSync(f.tarCommand, "utf8")).toBe(TAR);
});

test("repair withdraws a recognized patch if its runtime or package is no longer supported", () => {
  for (const failure of ["package", "zstd", "tar"]) {
    const f = fixture();
    reconcileBackupCompression(ON, f.options);
    if (failure === "package") f.options.version = "2.6.0";
    if (failure === "tar") writeFileSync(f.tarCommand, "an upstream change");
    if (failure === "zstd") f.options.run = () => ({ ok: false, stdout: "", stderr: "missing" });
    expect(() => reconcileBackupCompression(ON, f.options)).toThrow();
    expect(f.read()).toBe(ORIGINAL);
  }
});

test("missing zstd and a failed PHP syntax check leave the original runnable", () => {
  for (const failed of ["/usr/bin/zstd", "/usr/bin/php8.1"]) {
    const f = fixture();
    f.options.run = (command) => ({ ok: command !== failed, stdout: "", stderr: "failed" });
    expect(() => reconcileBackupCompression(ON, f.options)).toThrow(failed.endsWith("zstd") ? "Install zstd" : "syntax check");
    expect(f.read()).toBe(ORIGINAL);
  }
});

test("an upstream edit during validation wins over the pending tweak", () => {
  const f = fixture();
  f.options.run = (command) => {
    if (command.endsWith("php8.1")) writeFileSync(f.remoteCommand, "replacement by package manager");
    return { ok: true, stdout: "", stderr: "" };
  };
  expect(() => reconcileBackupCompression(ON, f.options)).toThrow("changed while checking");
  expect(f.read()).toBe("replacement by package manager");
});

test("only bounded integers reach the command, at both the root action and HTTP boundary", async () => {
  const bad = [null, [], {}, { ...ON, level: "3; touch /tmp/no" }, { ...ON, level: 0 }, { ...ON, level: 13 },
    { ...ON, threads: 0 }, { ...ON, threads: 9 }, { ...ON, threads: 1.5 }, { ...ON, enabled: "yes" }, { ...ON, command: "zstd" }];
  for (const body of bad) {
    expect(validBackupCompression(body)).toBe(false);
    await expect(executeSystemTweaksAction(["set-backup-compression"], { input: JSON.stringify(body), processUid: 0 })).rejects.toThrow();
    const csrf = "a".repeat(64);
    const req = new Request("https://panel.example.com/addons/system-tweaks/api/backup-compression", {
      method: "POST", headers: { Host: "panel.example.com", Origin: "https://panel.example.com", "Content-Type": "application/json",
        Cookie: `clp_addons_csrf=${csrf}`, "X-CLP-Addons-CSRF": csrf }, body: JSON.stringify(body),
    });
    expect((await handle(req, "/api/backup-compression")).status).toBe(400);
  }
  const req = new Request("https://panel.example.com/addons/system-tweaks/api/backup-compression", { method: "POST", body: JSON.stringify(ON) });
  expect((await handle(req, "/api/backup-compression")).status).toBe(403);
});

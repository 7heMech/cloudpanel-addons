import { afterEach, expect, test } from "bun:test";
import {
  chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  rmSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  DEFAULT_GUARD_SETTINGS, diskState, executeResourceGuardAction, parseGuardSettings, resourceGuardUnits,
  type GuardOptions,
} from "../addons/resource-guard/action";
import { activeFileReferences, cleanScratch, scratchInventory } from "../addons/resource-guard/cleanup";
import { ensureScratch, mountedScratch, renderImagePolicy, type GuardCommand, type StoragePaths } from "../addons/resource-guard/storage";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const ORIGINAL = '<policymap>\n  <policy domain="resource" name="disk" value="1GiB"/>\n  <policy domain="coder" rights="none" pattern="PDF"/>\n</policymap>\n';
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "resource-guard-test-"));
  roots.push(root);
  for (const name of ["state", "systemd", "cache", "php", "legacy", "proc"]) { mkdirSync(join(root, name)); chmodSync(join(root, name), 0o755); }
  chmodSync(join(root, "legacy"), 0o1777);
  const policy = join(root, "image-policy.xml");
  writeFileSync(policy, ORIGINAL);
  chmodSync(policy, 0o644);
  writeFileSync(join(root, "php", "php8.3"), "fixture");
  writeFileSync(join(root, "passwd"), `site:x:${process.getuid?.()}:1000::/:/bin/sh\n`);
  const paths = {
    stateDir: join(root, "state"), runtimeDir: join(root, "runtime"), lockFile: join(root, "guard.lock"),
    scratch: join(root, "cache", "scratch"), mountUnit: join(root, "systemd", "scratch.mount"),
    policyFiles: [policy], phpBinDir: join(root, "php"), rootUid: process.getuid?.() ?? 0,
    legacyTmp: join(root, "legacy"), passwd: join(root, "passwd"), procRoot: join(root, "proc"), monitorPaths: [root],
  };
  const calls: string[][] = [];
  let mounted = false;
  let busy = false;
  let probeFailure = false;
  let reloadFailure = false;
  const run: GuardCommand = (command, args) => {
    calls.push([command, ...args]);
    const good = (stdout = "") => ({ ok: true, exitCode: 0, stdout, stderr: "" });
    const bad = (stderr: string, exitCode = 1) => ({ ok: false, exitCode, stdout: "", stderr });
    if (command === "findmnt") return mounted ? good(JSON.stringify({ filesystems: [{ source: "/dev/loop9", fstype: "ext4", options: "rw,nodev,nosuid,noexec" }] })) : bad("");
    if (command === "losetup") return good(join(paths.stateDir, "scratch.img"));
    if (command === "fallocate") { execFileSync("fallocate", args); return good(); }
    if (command === "systemctl") {
      if (args[0] === "enable" && args[1] === "--now") mounted = true;
      if (args[0] === "stop") { if (busy) return bad("target is busy"); mounted = false; }
      if (args[0] === "list-units") return good("php8.3-fpm.service loaded active running PHP\n");
      if (args[0] === "reload" && reloadFailure) { reloadFailure = false; return bad("reload failed"); }
    }
    if (command === "runuser") return probeFailure ? bad("ImageMagick cache probe failed")
      : good(JSON.stringify({ imagick: true, scratch: true, diskLimit: 1024 ** 3, version: { versionString: "ImageMagick fixture" } }));
    return good();
  };
  const options: GuardOptions = { paths, run, processUid: 0, references: () => new Set(), now: Date.now() + 48 * 3_600_000 };
  const settings = { ...DEFAULT_GUARD_SETTINGS, scratchMiB: 256, protection: true };
  return { root, paths, policy, calls, run, options, settings,
    busy: () => { busy = true; }, badProbe: () => { probeFailure = true; }, badReload: () => { reloadFailure = true; } };
}

test("ImageMagick policy preserves disk and coder rules, is idempotent, and restores exact bytes", () => {
  const first = renderImagePolicy(ORIGINAL, "/var/cache/clpaddons/imagemagick");
  expect(first).toContain('name="disk" value="1GiB"');
  expect(first).toContain('rights="none" pattern="PDF"');
  expect(first).toContain('name="synchronize" value="true"');
  expect(renderImagePolicy(first, "/var/cache/clpaddons/imagemagick")).toBe(first);
  expect(renderImagePolicy(first, null)).toBe(ORIGINAL);
  expect(() => renderImagePolicy("<policymap>\n  <!-- clp-addons resource-guard start -->\n</policymap>", null)).toThrow();
  expect(() => renderImagePolicy(ORIGINAL, '/tmp/"/>')).toThrow();
});
test("settings refuse unbounded scratch storage and overly aggressive cleanup", () => {
  expect(() => parseGuardSettings({ ...DEFAULT_GUARD_SETTINGS, scratchMiB: 0 })).toThrow();
  expect(() => parseGuardSettings({ ...DEFAULT_GUARD_SETTINGS, retentionHours: 1 })).toThrow();
  expect(() => parseGuardSettings({ ...DEFAULT_GUARD_SETTINGS, protection: "yes" })).toThrow();
});
test("installing / reading status makes no policy or scratch changes", async () => {
  const f = fixture();
  const result = await executeResourceGuardAction(["status"], f.options);
  expect(result.protected).toBe(false);
  expect(readFileSync(f.policy, "utf8")).toBe(ORIGINAL);
  expect(existsSync(join(f.paths.stateDir, "policy.json"))).toBe(false);
  expect(f.calls.map((call) => call[0])).toEqual(["findmnt"]);
});
test("protection preallocates storage without mkfs discard, validates PHP and reloads FPM", async () => {
  const f = fixture();
  const result = await executeResourceGuardAction(["configure"], { ...f.options, input: JSON.stringify(f.settings) });
  expect(result.protected).toBe(true);
  expect(result.verifiedPhp[0]?.php).toBe("8.3");
  expect(f.calls.find((call) => call[0] === "mkfs.ext4")?.join(" ")).toContain("nodiscard");
  expect(f.calls).toContainEqual(["systemctl", "reload", "php8.3-fpm.service"]);
  expect(lstatSync(join(f.paths.stateDir, "policy.json")).mode & 0o777).toBe(0o600);
  expect(lstatSync(f.paths.scratch).mode & 0o1777).toBe(0o1777);
});
test("failed verification restores ImageMagick policies and leaves saved settings unchanged", async () => {
  const f = fixture(); f.badProbe();
  await expect(executeResourceGuardAction(["configure"], { ...f.options, input: JSON.stringify(f.settings) })).rejects.toThrow("probe failed");
  expect(readFileSync(f.policy, "utf8")).toBe(ORIGINAL);
  expect(existsSync(join(f.paths.stateDir, "policy.json"))).toBe(false);
  expect(f.calls.filter((call) => call[0] === "systemctl" && call[1] === "reload")).toHaveLength(2);
});
test("failed FPM reload restores policies before retrying the reload", async () => {
  const f = fixture(); f.badReload();
  await expect(executeResourceGuardAction(["configure"], { ...f.options, input: JSON.stringify(f.settings) })).rejects.toThrow("reload failed");
  expect(readFileSync(f.policy, "utf8")).toBe(ORIGINAL);
  expect(existsSync(join(f.paths.stateDir, "policy.json"))).toBe(false);
});
test("busy unmount blocks disabling and restores the protected policy", async () => {
  const f = fixture();
  await executeResourceGuardAction(["configure"], { ...f.options, input: JSON.stringify(f.settings) });
  const protectedPolicy = readFileSync(f.policy, "utf8"); f.busy();
  await expect(executeResourceGuardAction(["deactivate"], f.options)).rejects.toThrow("busy");
  expect(readFileSync(f.policy, "utf8")).toBe(protectedPolicy);
  expect(existsSync(f.paths.mountUnit)).toBe(true);
  expect(existsSync(join(f.paths.stateDir, "scratch.img"))).toBe(true);
});
test("ordinary deactivation restores policies, unmounts, and keeps the saved policy for re-enable", async () => {
  const f = fixture();
  await executeResourceGuardAction(["configure"], { ...f.options, input: JSON.stringify(f.settings) });
  await executeResourceGuardAction(["deactivate"], f.options);
  expect(readFileSync(f.policy, "utf8")).toBe(ORIGINAL);
  expect(existsSync(f.paths.mountUnit)).toBe(false);
  expect(JSON.parse(readFileSync(join(f.paths.stateDir, "policy.json"), "utf8")).settings.protection).toBe(true);
});
test("a symlink or writable ImageMagick policy cannot be replaced by the root action", async () => {
  const f = fixture();
  const victim = join(f.root, "victim"); writeFileSync(victim, ORIGINAL);
  rmSync(f.policy); symlinkSync(victim, f.policy);
  await expect(executeResourceGuardAction(["configure"], { ...f.options, input: JSON.stringify({ ...f.settings, protection: false }) })).rejects.toThrow("untrusted");
  expect(readFileSync(victim, "utf8")).toBe(ORIGINAL);
  rmSync(f.policy); writeFileSync(f.policy, ORIGINAL); chmodSync(f.policy, 0o666);
  await expect(executeResourceGuardAction(["configure"], { ...f.options, input: JSON.stringify({ ...f.settings, protection: false }) })).rejects.toThrow("untrusted");
});
test("sparse backing images and unexpected mounts are refused", () => {
  const f = fixture();
  writeFileSync(join(f.paths.stateDir, "scratch.img"), ""); truncateSync(join(f.paths.stateDir, "scratch.img"), 256 * 1024 ** 2);
  chmodSync(join(f.paths.stateDir, "scratch.img"), 0o600);
  expect(() => ensureScratch(f.paths as StoragePaths, 256, f.run)).toThrow("fully allocated");
  expect(() => mountedScratch(f.paths as StoragePaths, () => ({ ok: true, exitCode: 0, stderr: "", stdout: JSON.stringify({ filesystems: [{ source: "/dev/sda1", fstype: "ext4", options: "rw" }] }) }))).toThrow("unexpected");
});
test("a matching mount unit still has to be a trusted file", async () => {
  const f = fixture();
  await executeResourceGuardAction(["configure"], { ...f.options, input: JSON.stringify(f.settings) });
  const body = readFileSync(f.paths.mountUnit, "utf8");
  chmodSync(f.paths.mountUnit, 0o666);
  await expect(executeResourceGuardAction(["reconcile"], f.options)).rejects.toThrow("untrusted");
  expect(readFileSync(f.paths.mountUnit, "utf8")).toBe(body);
});
test("policy drift is reported and repaired without changing the existing disk limit", async () => {
  const f = fixture();
  await executeResourceGuardAction(["configure"], { ...f.options, input: JSON.stringify(f.settings) });
  writeFileSync(f.policy, ORIGINAL);
  expect((await executeResourceGuardAction(["status"], f.options)).protected).toBe(false);
  expect((await executeResourceGuardAction(["reconcile"], f.options)).protected).toBe(true);
  expect(readFileSync(f.policy, "utf8")).toContain('name="disk" value="1GiB"');
});
test("cleanup retains open / mapped files, links, directories, recent files and sessions", () => {
  const f = fixture();
  const root = f.paths.legacyTmp;
  for (const name of ["magick-orphan", "magick-open", "magick-mapped", "magick-recent", "sess-login", "upload-data"]) writeFileSync(join(root, name), "cache");
  symlinkSync(join(root, "sess-login"), join(root, "magick-symlink"));
  linkSync(join(root, "upload-data"), join(root, "magick-hardlink"));
  mkdirSync(join(root, "magick-directory"));
  const proc = join(f.paths.procRoot, "42"); mkdirSync(proc); mkdirSync(join(proc, "fd"));
  symlinkSync(join(root, "magick-open"), join(proc, "fd", "3"));
  const info = lstatSync(join(root, "magick-mapped"));
  const dev = BigInt(info.dev);
  const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & 0xfffff000n);
  const minor = (dev & 0xffn) | ((dev >> 12n) & 0xffffff00n);
  writeFileSync(join(proc, "maps"), `1000-2000 rw-s 00000000 ${major.toString(16)}:${minor.toString(16)} ${info.ino} /tmp/magick-mapped\n`);
  const now = Date.now() + 48 * 3_600_000;
  utimesSync(join(root, "magick-recent"), new Date(now), new Date(now));
  const result = cleanScratch(root, 24, activeFileReferences(f.paths.procRoot), now);
  expect(result.removed).toBe(1); expect(result.active).toBe(2);
  expect(existsSync(join(root, "magick-orphan"))).toBe(false);
  for (const name of ["magick-open", "magick-mapped", "magick-recent", "sess-login", "upload-data", "magick-symlink", "magick-hardlink", "magick-directory"]) expect(existsSync(join(root, name))).toBe(true);
});
test("cleanup fails closed when process reference inspection fails", async () => {
  const f = fixture(); writeFileSync(join(f.paths.legacyTmp, "magick-old"), "cache");
  await executeResourceGuardAction(["configure"], { ...f.options, input: JSON.stringify({ ...f.settings, protection: false, cleanLegacyTmp: true }) });
  const result = await executeResourceGuardAction(["check"], { ...f.options, references: () => { throw new Error("permission denied"); } });
  expect(existsSync(join(f.paths.legacyTmp, "magick-old"))).toBe(true);
  expect(result.lastCheck?.cleanup?.error).toContain("permission denied");
  expect(result.warnings.join(" ")).toContain("permission denied");
});
test("inventory counts allocated blocks, attributes ownership, and excludes symlinks", () => {
  const f = fixture();
  writeFileSync(join(f.paths.legacyTmp, "magick-sparse"), ""); truncateSync(join(f.paths.legacyTmp, "magick-sparse"), 100 * 1024 ** 2);
  symlinkSync(join(f.paths.legacyTmp, "magick-sparse"), join(f.paths.legacyTmp, "magick-link"));
  const result = scratchInventory(f.paths.legacyTmp, f.paths.passwd);
  expect(result.files).toBe(1); expect(result.bytes).toBe(0); expect(result.owners[0]?.user).toBe("site");
});
test("disk pressure uses both free bytes and inode thresholds", () => {
  const f = fixture();
  expect(diskState(f.root, { ...DEFAULT_GUARD_SETTINGS, minFreeMiB: 1048576 }).level).not.toBe("ok");
});
test("monitoring follows data-directory symlinks when grouping filesystems", async () => {
  const f = fixture();
  const other = "/dev/shm";
  if (!existsSync(other) || statSync(other).dev === statSync(f.root).dev) return;
  const data = join(f.root, "database-data");
  symlinkSync(other, data);
  const result = await executeResourceGuardAction(["status"], {
    ...f.options, paths: { ...f.paths, monitorPaths: [f.root, data, other] },
  });
  expect(result.disks.map((disk) => disk.paths)).toEqual([[f.root], [data, other]]);
  expect(result.disks[1]?.total).toBe(diskState(other, DEFAULT_GUARD_SETTINGS).total);
});
test("independent timer does not need panel auth and runs despite a previous failed check", () => {
  const units = resourceGuardUnits();
  expect(units.service).toContain("action resource-guard check");
  expect(units.service).not.toContain("Requires=clp-addons");
  expect(units.timer).toContain("OnUnitInactiveSec=5min");
});
test("root actions reject paths, unsupported verbs and non-root identities", async () => {
  const f = fixture();
  await expect(executeResourceGuardAction(["clean", "--path=/"], f.options)).rejects.toThrow("no paths");
  await expect(executeResourceGuardAction(["shell"], f.options)).rejects.toThrow("unknown");
  await expect(executeResourceGuardAction(["status"], { ...f.options, processUid: 1000 })).rejects.toThrow("root");
});

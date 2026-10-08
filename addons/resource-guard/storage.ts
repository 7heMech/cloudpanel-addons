import {
  chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, rmSync, statfsSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { failAction, runCommand, type CommandResult } from "../../cli/action-common";
import { writeFileAtomic } from "../../lib/atomic-write";

export const SCRATCH_PATH = "/var/cache/clpaddons/imagemagick";
export const SCRATCH_MOUNT = "var-cache-clpaddons-imagemagick.mount";
const START = "  <!-- clp-addons resource-guard start -->";
const END = "  <!-- clp-addons resource-guard end -->";
const UNIT_MARKER = "# Managed by clp-addons resource-guard\n";
export type GuardCommand = (command: string, args: string[]) => CommandResult;

export interface StoragePaths {
  stateDir: string;
  scratch: string;
  mountUnit: string;
  policyFiles: string[];
  phpBinDir: string;
  rootUid: number;
}

export function trustedPath(path: string, uid: number, directory = false): void {
  const info = lstatSync(path);
  if (info.uid !== uid || (directory ? !info.isDirectory() : !info.isFile()) || (info.mode & 0o022) !== 0
    || (!directory && info.nlink !== 1)) failAction(`untrusted ${directory ? "directory" : "file"}: ${path}`);
  // No ancestor may redirect a privileged write or be replaced by a site user.
  for (let parent = dirname(path); parent !== dirname(parent); parent = dirname(parent)) {
    const stat = lstatSync(parent);
    const stickyRoot = stat.uid === 0 && (stat.mode & 0o1777) === 0o1777;
    if (!stat.isDirectory() || (stat.uid !== uid && stat.uid !== 0) || ((stat.mode & 0o022) !== 0 && !stickyRoot)) failAction(`untrusted parent: ${parent}`);
  }
}

export function checked(run: GuardCommand, command: string, args: string[]): string {
  const result = run(command, args);
  if (!result.ok) failAction(`${command} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

export function policyBlock(scratch: string): string {
  if (!/^\/[A-Za-z0-9/_-]+$/.test(scratch)) failAction("invalid managed scratch path");
  return `${START}\n  <policy domain="resource" name="temporary-path" value="${scratch}"/>\n  <policy domain="cache" name="synchronize" value="true"/>\n${END}\n`;
}

/** Removing just our block preserves all operator rules, including existing disk limits. */
export function renderImagePolicy(content: string, scratch: string | null): string {
  let plain = content;
  const starts = content.split(START).length - 1;
  const ends = content.split(END).length - 1;
  if (starts !== ends || starts > 1) failAction("ImageMagick policy has inconsistent Resource Guard markers");
  if (starts) {
    const from = content.indexOf(START);
    const to = content.indexOf(END);
    if (to < from) failAction("ImageMagick policy has reversed Resource Guard markers");
    plain = content.slice(0, from) + content.slice(to + END.length).replace(/^\n/, "");
  }
  const uncommented = plain.replace(/<!--[\s\S]*?-->/g, "");
  if ((uncommented.match(/<policymap\s*>/g) ?? []).length !== 1
    || (uncommented.match(/<\/policymap\s*>/g) ?? []).length !== 1) failAction("unsupported ImageMagick policy XML");
  if (scratch === null) return plain;
  const closing = plain.lastIndexOf("</policymap>");
  if (closing < 0 || plain.slice(0, closing).endsWith("\n") === false) failAction("ImageMagick policy closing tag must start a line");
  return plain.slice(0, closing) + policyBlock(scratch) + plain.slice(closing);
}

export function scratchMountUnit(paths: StoragePaths): string {
  return `${UNIT_MARKER}[Unit]\nDescription=Bounded ImageMagick scratch disk\n\n[Mount]\nWhat=${paths.stateDir}/scratch.img\nWhere=${paths.scratch}\nType=ext4\nOptions=loop,nodev,nosuid,noexec\nTimeoutSec=30\n\n[Install]\nWantedBy=local-fs.target\n`;
}

export function mountedScratch(paths: StoragePaths, run: GuardCommand = runCommand): boolean {
  const result = run("findmnt", ["--json", "--mountpoint", paths.scratch, "--output", "SOURCE,FSTYPE,OPTIONS"]);
  if (result.exitCode === 1) return false;
  if (!result.ok) failAction(`could not inspect scratch mount: ${result.stderr}`);
  const row = JSON.parse(result.stdout).filesystems?.[0];
  if (!row || row.fstype !== "ext4" || !/^\/dev\/loop\d+$/.test(row.source)
    || !["nodev", "nosuid", "noexec", "rw"].every((option) => String(row.options).split(",").includes(option))) {
    failAction("scratch path has an unexpected filesystem or unsafe mount options");
  }
  const backing = checked(run, "losetup", ["--noheadings", "--raw", "--output", "BACK-FILE", row.source]);
  if (backing !== join(paths.stateDir, "scratch.img")) failAction("scratch mount uses an unexpected backing file");
  trustedPath(backing, paths.rootUid);
  return true;
}

function writeTrusted(path: string, body: string, uid: number, mode = 0o644): void {
  let owner: { uid: number; gid: number } | undefined;
  if (existsSync(path)) {
    trustedPath(path, uid);
    const info = lstatSync(path);
    owner = { uid: info.uid, gid: info.gid };
  }
  else trustedPath(dirname(path), uid, true);
  writeFileAtomic(path, body, { mode, owner });
}

export function ensureScratch(paths: StoragePaths, sizeMiB: number, run: GuardCommand): void {
  trustedPath(paths.stateDir, paths.rootUid, true);
  const image = join(paths.stateDir, "scratch.img");
  const size = sizeMiB * 1024 * 1024;
  if (!existsSync(image)) {
    const fs = statfsSync(paths.stateDir);
    const available = fs.bavail * fs.bsize;
    const reserve = Math.max(2 * 1024 ** 3, fs.blocks * fs.bsize * 0.1);
    if (available - size < reserve) failAction("not enough free disk to allocate scratch space and retain 2 GiB / 10% headroom");
    closeSync(openSync(image, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600));
    try {
      checked(run, "fallocate", ["--length", String(size), image]);
      // Default mkfs discard punches holes in the image, defeating preallocation.
      checked(run, "mkfs.ext4", ["-F", "-q", "-m", "0", "-E", "nodiscard,lazy_itable_init=0,lazy_journal_init=0", image]);
    } catch (error) {
      rmSync(image);
      throw error;
    }
  }
  trustedPath(image, paths.rootUid);
  const info = lstatSync(image);
  if (info.size !== size) failAction("scratch disk already has a different size; remove protection and purge the addon before resizing");
  if (info.blocks * 512 < size) failAction("scratch image is not fully allocated; refusing to route image jobs to it");
  mkdirSync(dirname(paths.scratch), { recursive: true, mode: 0o755 });
  trustedPath(dirname(paths.scratch), paths.rootUid, true);
  if (!existsSync(paths.scratch)) mkdirSync(paths.scratch, { mode: 0o700 });
  if (!mountedScratch(paths, run)) {
    trustedPath(paths.scratch, paths.rootUid, true);
    if (readdirSync(paths.scratch).length !== 0) failAction("unmounted scratch directory is not empty");
    chmodSync(paths.scratch, 0o700);
  }
  const body = scratchMountUnit(paths);
  if (existsSync(paths.mountUnit)) {
    trustedPath(paths.mountUnit, paths.rootUid);
    if (!readFileSync(paths.mountUnit, "utf8").startsWith(UNIT_MARKER)) failAction("scratch mount unit belongs to another administrator");
  }
  if (!existsSync(paths.mountUnit) || readFileSync(paths.mountUnit, "utf8") !== body) {
    writeTrusted(paths.mountUnit, body, paths.rootUid);
    checked(run, "systemctl", ["daemon-reload"]);
  }
  checked(run, "systemctl", ["enable", "--now", SCRATCH_MOUNT]);
  if (!mountedScratch(paths, run)) failAction("scratch mount did not become ready");
  const mounted = lstatSync(paths.scratch);
  if (!mounted.isDirectory() || mounted.uid !== paths.rootUid) failAction("scratch filesystem root is untrusted");
  chmodSync(paths.scratch, 0o1777);
}

export function reloadSitePhp(run: GuardCommand): void {
  const units = checked(run, "systemctl", ["list-units", "--type=service", "--state=active", "--no-legend", "--plain", "php*-fpm.service"]);
  for (const line of units.split("\n")) {
    const unit = line.trim().split(/\s+/)[0] ?? "";
    if (/^php\d+\.\d+-fpm\.service$/.test(unit)) checked(run, "systemctl", ["reload", unit]);
  }
}

const PROBE = `
if (!class_exists('Imagick')) { echo json_encode(array('imagick'=>false)); exit; }
Imagick::setResourceLimit(Imagick::RESOURCETYPE_MEMORY, 0);
Imagick::setResourceLimit(Imagick::RESOURCETYPE_MAP, 0);
$image = new Imagick(); $image->newImage(128, 128, 'white');
$references = file_get_contents('/proc/self/maps');
foreach (glob('/proc/self/fd/*') as $fd) { $link = @readlink($fd); if ($link !== false) $references .= "\\n".$link; }
echo json_encode(array('imagick'=>true, 'scratch'=>strpos($references, $argv[1].'/magick-') !== false,
  'diskLimit'=>Imagick::getResourceLimit(Imagick::RESOURCETYPE_DISK), 'version'=>Imagick::getVersion()));
$image->clear();
`;

export interface PhpProbe { php: string; diskLimit: number; version: string }
export function verifyPhpScratch(paths: StoragePaths, run: GuardCommand): PhpProbe[] {
  const probes: PhpProbe[] = [];
  const binaries = readdirSync(paths.phpBinDir).filter((name) => /^php\d+\.\d+$/.test(name));
  for (const name of binaries.sort()) {
    const result = run("runuser", ["--user", "nobody", "--", join(paths.phpBinDir, name), "-r", PROBE, "--", paths.scratch]);
    if (!result.ok) failAction(`${name} could not verify ImageMagick scratch protection: ${result.stderr}`);
    const data = JSON.parse(result.stdout);
    if (!data.imagick) continue;
    if (!data.scratch) failAction(`${name} ImageMagick did not use the bounded scratch filesystem`);
    probes.push({ php: name.slice(3), diskLimit: Number(data.diskLimit), version: String(data.version?.versionString ?? "") });
  }
  if (probes.length === 0) failAction("no versioned PHP CLI with Imagick is available to verify protection");
  return probes;
}

/** Apply policy as a transaction, including rollback when PHP verification/reload fails. */
export function applyImagePolicies<T>(paths: StoragePaths, scratch: string | null, run: GuardCommand, after: () => T): T {
  const originals = new Map<string, { body: string; mode: number }>();
  try {
    for (const file of paths.policyFiles.filter(existsSync)) {
      trustedPath(file, paths.rootUid);
      const body = readFileSync(file, "utf8");
      const next = renderImagePolicy(body, scratch);
      if (next === body) continue;
      const mode = lstatSync(file).mode & 0o777;
      originals.set(file, { body, mode });
      writeTrusted(file, next, paths.rootUid, mode);
    }
    if (scratch && paths.policyFiles.filter(existsSync).length === 0) failAction("no supported ImageMagick 6/7 policy file exists");
    if (originals.size) reloadSitePhp(run);
    return after();
  } catch (error) {
    for (const [file, original] of originals) writeTrusted(file, original.body, paths.rootUid, original.mode);
    if (originals.size) {
      try { reloadSitePhp(run); } catch (rollback) {
        failAction(`policy restored but PHP reload failed: ${String(rollback)}; original failure: ${String(error)}`);
      }
    }
    throw error;
  }
}

export function releaseScratch(paths: StoragePaths, run: GuardCommand): void {
  if (mountedScratch(paths, run)) {
    // Never use lazy/forced unmount: it could leave writes reaching a soon-purged image.
    checked(run, "systemctl", ["stop", SCRATCH_MOUNT]);
    if (mountedScratch(paths, run)) failAction("scratch disk is still mounted; wait for image jobs to finish and retry");
  }
  if (existsSync(paths.mountUnit)) {
    trustedPath(paths.mountUnit, paths.rootUid);
    if (!readFileSync(paths.mountUnit, "utf8").startsWith(UNIT_MARKER)) failAction("unmanaged scratch mount unit");
    checked(run, "systemctl", ["disable", SCRATCH_MOUNT]);
    rmSync(paths.mountUnit);
    checked(run, "systemctl", ["daemon-reload"]);
  }
}

import {
  existsSync, lstatSync, mkdirSync, readFileSync, statSync, statfsSync,
} from "node:fs";
import { join } from "node:path";
import {
  ActionFailure, emitActionError, emitActionOk, failAction, runCommand, withFileLock,
} from "../../cli/action-common";
import { CLI_BIN, CONFIG_DIR, SESSION_DIR, STATE_DIR, SYSTEMD_DIR } from "../../cli/paths";
import { writeFileAtomic } from "../../lib/atomic-write";
import {
  activeFileReferences, cleanScratch, scratchInventory, type CleanupResult, type ScratchInventory,
} from "./cleanup";
import {
  applyImagePolicies, ensureScratch, mountedScratch, renderImagePolicy, releaseScratch, SCRATCH_MOUNT,
  SCRATCH_PATH, trustedPath, verifyPhpScratch, type GuardCommand, type PhpProbe, type StoragePaths,
} from "./storage";

export type ResourceGuardVerb = "status" | "configure" | "clean" | "check" | "reconcile" | "deactivate";
export const RESOURCE_GUARD_SERVICE = "clp-addons-resource-guard.service";
export const RESOURCE_GUARD_TIMER = "clp-addons-resource-guard.timer";

export interface GuardSettings {
  protection: boolean;
  scratchMiB: number;
  retentionHours: number;
  cleanLegacyTmp: boolean;
  minFreeMiB: number;
  minFreePercent: number;
  minInodePercent: number;
}
export const DEFAULT_GUARD_SETTINGS: GuardSettings = {
  protection: false, scratchMiB: 2048, retentionHours: 24, cleanLegacyTmp: false,
  minFreeMiB: 2048, minFreePercent: 10, minInodePercent: 10,
};
interface GuardPolicy { version: 1; settings: GuardSettings; verifiedPhp: PhpProbe[] }
interface GuardPaths extends StoragePaths {
  runtimeDir: string;
  lockFile: string;
  legacyTmp: string;
  passwd: string;
  procRoot: string;
  monitorPaths: string[];
}
export const DEFAULT_GUARD_PATHS: GuardPaths = {
  stateDir: `${STATE_DIR}/resource-guard`, runtimeDir: "/run/clp-addons-resource-guard",
  lockFile: "/run/lock/clp-addons/resource-guard.lock", scratch: SCRATCH_PATH,
  mountUnit: `${SYSTEMD_DIR}/${SCRATCH_MOUNT}`, policyFiles: ["/etc/ImageMagick-6/policy.xml", "/etc/ImageMagick-7/policy.xml"],
  phpBinDir: "/usr/bin", rootUid: 0, legacyTmp: "/tmp", passwd: "/etc/passwd", procRoot: "/proc",
  monitorPaths: ["/", "/tmp", "/var/tmp", STATE_DIR, SESSION_DIR, "/var/lib/mysql", "/var/lib/redis"],
};
export interface GuardOptions {
  paths?: Partial<GuardPaths>;
  run?: GuardCommand;
  input?: string;
  processUid?: number;
  references?: () => Set<string>;
  now?: number;
}
export interface DiskState {
  paths: string[]; total: number; available: number; usedPercent: number;
  inodes: number; freeInodes: number; level: "ok" | "warning" | "critical";
}
export interface GuardState {
  settings: GuardSettings; protected: boolean; allocatedMiB: number | null;
  scratch: DiskState | null; files: ScratchInventory | null; legacy: ScratchInventory | null;
  disks: DiskState[]; warnings: string[]; verifiedPhp: PhpProbe[];
  lastCheck: { at: string; cleanup: CleanupResult | null } | null;
}

function whole(raw: unknown, label: string, min: number, max: number): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < min || raw > max) failAction(`${label} must be a whole number from ${min} to ${max}`);
  return raw;
}
export function parseGuardSettings(raw: unknown): GuardSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) failAction("settings must be an object");
  const value = raw as Record<string, unknown>;
  for (const key of ["protection", "cleanLegacyTmp"]) if (typeof value[key] !== "boolean") failAction(`${key} must be true or false`);
  return {
    protection: value.protection as boolean, cleanLegacyTmp: value.cleanLegacyTmp as boolean,
    scratchMiB: whole(value.scratchMiB, "scratch disk MiB", 256, 16384),
    retentionHours: whole(value.retentionHours, "retention hours", 24, 720),
    minFreeMiB: whole(value.minFreeMiB, "minimum free MiB", 256, 1048576),
    minFreePercent: whole(value.minFreePercent, "minimum free percent", 1, 50),
    minInodePercent: whole(value.minInodePercent, "minimum free inode percent", 1, 50),
  };
}
function readPolicy(paths: GuardPaths): GuardPolicy {
  const file = join(paths.stateDir, "policy.json");
  if (!existsSync(file)) return { version: 1, settings: { ...DEFAULT_GUARD_SETTINGS }, verifiedPhp: [] };
  trustedPath(file, paths.rootUid);
  if (lstatSync(file).size > 64 * 1024) failAction("Resource Guard policy is too large");
  const value = JSON.parse(readFileSync(file, "utf8"));
  if (value.version !== 1 || !Array.isArray(value.verifiedPhp)) failAction("unsupported Resource Guard policy");
  return { version: 1, settings: parseGuardSettings(value.settings), verifiedPhp: value.verifiedPhp };
}
function writePolicy(paths: GuardPaths, policy: GuardPolicy): void {
  trustedPath(paths.stateDir, paths.rootUid, true);
  const file = join(paths.stateDir, "policy.json");
  if (existsSync(file)) trustedPath(file, paths.rootUid);
  writeFileAtomic(file, JSON.stringify(policy, null, 2) + "\n", { mode: 0o600 });
}

export function diskState(path: string, settings: GuardSettings, scratch = false): DiskState {
  const fs = statfsSync(path);
  const total = fs.blocks * fs.bsize;
  const available = fs.bavail * fs.bsize;
  const freePercent = total ? 100 * available / total : 100;
  const inodePercent = fs.files ? 100 * fs.ffree / fs.files : 100;
  const minBytes = scratch ? 0 : settings.minFreeMiB * 1024 ** 2;
  const critical = available === 0 || (fs.files > 0 && fs.ffree === 0) || freePercent <= 2 || inodePercent <= 2;
  const warning = available < minBytes || freePercent < settings.minFreePercent || inodePercent < settings.minInodePercent;
  return {
    paths: [path], total, available, usedPercent: total ? 100 * (fs.blocks - fs.bfree) / fs.blocks : 0,
    inodes: fs.files, freeInodes: fs.ffree, level: critical ? "critical" : warning ? "warning" : "ok",
  };
}
function runtimeCheck(paths: GuardPaths): GuardState["lastCheck"] {
  const file = join(paths.runtimeDir, "status.json");
  if (!existsSync(file)) return null;
  trustedPath(file, paths.rootUid);
  if (lstatSync(file).size > 64 * 1024) failAction("Resource Guard runtime status is too large");
  return JSON.parse(readFileSync(file, "utf8"));
}
function state(paths: GuardPaths, policy: GuardPolicy, run: GuardCommand): GuardState {
  const warnings: string[] = [];
  const disks = new Map<number, DiskState>();
  for (const path of paths.monitorPaths) {
    try {
      const dev = statSync(path).dev;
      const previous = disks.get(dev);
      if (previous) previous.paths.push(path);
      else disks.set(dev, diskState(path, policy.settings));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") warnings.push(`Cannot inspect ${path}: ${String(error)}`);
    }
  }
  let mounted = false;
  try { mounted = mountedScratch(paths, run); }
  catch (error) { warnings.push(String(error)); }
  const policiesReady = paths.policyFiles.filter(existsSync).length > 0 && paths.policyFiles.filter(existsSync).every((file) => {
    try { trustedPath(file, paths.rootUid); const body = readFileSync(file, "utf8"); return renderImagePolicy(body, paths.scratch) === body; }
    catch (error) { warnings.push(String(error)); return false; }
  });
  const protectedNow = policy.settings.protection && mounted && policiesReady;
  if (policy.settings.protection && !protectedNow) warnings.push("Image scratch protection needs repair; a filesystem or ImageMagick policy is missing.");
  const image = join(paths.stateDir, "scratch.img");
  let files: ScratchInventory | null = null;
  let legacy: ScratchInventory | null = null;
  if (mounted) files = scratchInventory(paths.scratch, paths.passwd);
  try { legacy = scratchInventory(paths.legacyTmp, paths.passwd); }
  catch (error) { warnings.push(`Cannot inspect legacy ImageMagick files: ${String(error)}`); }
  if (files?.truncated || legacy?.truncated) warnings.push("File inventory reached 10,000 entries; displayed usage is a partial count.");
  for (const disk of disks.values()) if (disk.level !== "ok") warnings.push(`${disk.level.toUpperCase()}: low disk space or inodes on ${disk.paths.join(", ")}`);
  const scratch = mounted ? diskState(paths.scratch, policy.settings, true) : null;
  if (scratch && scratch.level !== "ok") warnings.push("Image scratch disk is nearly full; image processing may fail while other disks remain available.");
  return {
    settings: policy.settings, protected: protectedNow,
    allocatedMiB: existsSync(image) ? lstatSync(image).size / 1024 ** 2 : null,
    scratch, files, legacy, disks: [...disks.values()], warnings, verifiedPhp: policy.verifiedPhp,
    lastCheck: runtimeCheck(paths),
  };
}

function cleanup(paths: GuardPaths, settings: GuardSettings, run: GuardCommand, options: GuardOptions): CleanupResult {
  const result: CleanupResult = { removed: 0, bytes: 0, active: 0, skipped: 0, error: null };
  const roots: string[] = [];
  if (settings.protection && mountedScratch(paths, run)) roots.push(paths.scratch);
  if (settings.cleanLegacyTmp) {
    const tmp = lstatSync(paths.legacyTmp);
    if (!tmp.isDirectory() || tmp.uid !== paths.rootUid || (tmp.mode & 0o1777) !== 0o1777) failAction("legacy /tmp is not a trusted sticky directory");
    roots.push(paths.legacyTmp);
  }
  if (!roots.length) return result;
  try {
    const references = options.references?.() ?? activeFileReferences(paths.procRoot);
    for (const root of roots) {
      const cleaned = cleanScratch(root, settings.retentionHours, references, options.now);
      result.removed += cleaned.removed; result.bytes += cleaned.bytes;
      result.active += cleaned.active; result.skipped += cleaned.skipped;
      if (cleaned.error) result.error = cleaned.error;
    }
  } catch (error) { result.error = String(error); }
  return result;
}

export async function executeResourceGuardAction(argv: string[], options: GuardOptions = {}): Promise<GuardState> {
  if ((options.processUid ?? process.getuid?.()) !== 0) failAction("Resource Guard actions require root");
  if (argv.length !== 1) failAction("Resource Guard accepts one verb and settings on stdin; no paths or flags");
  const paths = { ...DEFAULT_GUARD_PATHS, ...options.paths };
  const run = options.run ?? runCommand;
  const verb = argv[0];
  if (!["status", "configure", "clean", "check", "reconcile", "deactivate"].includes(verb ?? "")) failAction("unknown Resource Guard verb");
  return withFileLock(paths.lockFile, 10, "Resource Guard is busy; retry shortly", async () => {
    let policy = readPolicy(paths);
    if (verb === "configure") {
      const settings = parseGuardSettings(JSON.parse(options.input ?? "null"));
      if (settings.protection) ensureScratch(paths, settings.scratchMiB, run);
      policy = applyImagePolicies(paths, settings.protection ? paths.scratch : null, run, () => {
        const verifiedPhp = settings.protection ? verifyPhpScratch(paths, run) : [];
        if (!settings.protection) releaseScratch(paths, run);
        const next: GuardPolicy = { version: 1, settings, verifiedPhp };
        writePolicy(paths, next);
        return next;
      });
    } else if (verb === "deactivate") {
      applyImagePolicies(paths, null, run, () => releaseScratch(paths, run));
    } else if (verb === "reconcile" && policy.settings.protection) {
      ensureScratch(paths, policy.settings.scratchMiB, run);
      applyImagePolicies(paths, paths.scratch, run, () => verifyPhpScratch(paths, run));
    }
    if (verb === "clean" || verb === "check") {
      const cleaned = cleanup(paths, policy.settings, run, options);
      if (!existsSync(paths.runtimeDir)) mkdirSync(paths.runtimeDir, { mode: 0o700 });
      trustedPath(paths.runtimeDir, paths.rootUid, true);
      writeFileAtomic(join(paths.runtimeDir, "status.json"), JSON.stringify({ at: new Date(options.now ?? Date.now()).toISOString(), cleanup: cleaned }), { mode: 0o600 });
    }
    const result = state(paths, policy, run);
    if (result.lastCheck?.cleanup?.error) result.warnings.push(result.lastCheck.cleanup.error);
    return result;
  });
}

export async function runResourceGuardAction(argv: string[], options: GuardOptions = {}): Promise<number> {
  try {
    const input = options.input ?? (argv[0] === "configure" ? await Bun.stdin.text() : undefined);
    if (input && input.length > 16 * 1024) failAction("Resource Guard settings are too large");
    const result = await executeResourceGuardAction(argv, { ...options, input });
    emitActionOk(result);
    if (argv[0] === "check") for (const warning of result.warnings) process.stderr.write(`[resource-guard] ${warning}\n`);
    return 0;
  } catch (error) {
    emitActionError(error instanceof Error ? error.message : String(error), error instanceof ActionFailure ? error.data : undefined, "resource-guard");
    return 1;
  }
}

export function resourceGuardUnits(): { service: string; timer: string } {
  return {
    service: `[Unit]\nDescription=Check disk pressure and clean orphaned ImageMagick scratch files\nConditionPathExists=${CONFIG_DIR}/resource-guard.conf\n\n[Service]\nType=oneshot\nExecStart=${CLI_BIN} action resource-guard check\nTimeoutStartSec=60\nNice=10\nIOSchedulingClass=idle\n`,
    timer: `[Unit]\nDescription=CloudPanel Resource Guard disk checks\n\n[Timer]\nOnBootSec=1min\nOnUnitInactiveSec=5min\nAccuracySec=15s\n\n[Install]\nWantedBy=timers.target\n`,
  };
}

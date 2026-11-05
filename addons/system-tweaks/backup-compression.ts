/**
 * CloudPanel's Remote Backup command makes an uncompressed tar, uploads it,
 * then deletes it. Change that one call so its filename and compressor move
 * together in the same PHP class. An already running backup keeps its class;
 * the next invocation sees the change. Database dumps and other tar users
 * keep CloudPanel's implementation.
 *
 * Only the source and command builder checked on staging are accepted. The
 * replacement is reversible without a saved copy: removing our exact block
 * must reproduce the pinned original hash before we write anything.
 */
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand, type CommandResult } from "../../cli/action-common";
import { writeFileAtomic } from "../../lib/atomic-write";

export interface BackupCompressionSettings { enabled: boolean; level: number; threads: number }
export const DEFAULT_BACKUP_COMPRESSION: BackupCompressionSettings = { enabled: false, level: 3, threads: 1 };
/** Past this, one thread is slow enough for a large site to meet CloudPanel's six-hour limit. */
export const MAX_BACKUP_LEVEL = 12;
export const BACKUP_COMPRESSION_ERROR = `enabled must be true or false, level an integer from 1 to ${MAX_BACKUP_LEVEL}, and threads an integer from 1 to 8`;

export function validBackupCompression(value: unknown): value is BackupCompressionSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const setting = value as BackupCompressionSettings;
  return Object.keys(value).every((key) => ["enabled", "level", "threads"].includes(key))
    && typeof setting.enabled === "boolean"
    && Number.isInteger(setting.level) && setting.level >= 1 && setting.level <= MAX_BACKUP_LEVEL
    && Number.isInteger(setting.threads) && setting.threads >= 1 && setting.threads <= 8;
}

export const DEFAULT_BACKUP_COMPRESSION_PATHS = {
  remoteCommand: "/home/clp/htdocs/app/files/src/Command/RemoteBackupCreateCommand.php",
  tarCommand: "/home/clp/htdocs/app/files/src/System/Command/TarCreateCommand.php",
};

// cloudpanel 2.5.4-3+clp-bookworm. The tar builder is shared, and never edited.
const REMOTE_SHA256 = "85c77872f48e4232430e1f0045410f4fdb2ed4474efefe90739f3b1ccaccf9f0";
const TAR_SHA256 = "4f7595b87027846e444272e8fdf675f63fc151e32229922639f70f38b73b6e8c";
const ORIGINAL_CALL = "$tarCreator->create($sources, $destinationFile, $excludes);";
const MARKER = "/* clp-addons:backup-zstd:";

export interface BackupCompressionOptions {
  paths?: Partial<typeof DEFAULT_BACKUP_COMPRESSION_PATHS>;
  run?: (command: string, args: string[]) => CommandResult;
  /** Fixture fingerprints; production uses the pinned CloudPanel files. */
  fingerprints?: { remote: string; tar: string };
  /** Package version without its distro suffix; detected otherwise. */
  version?: string | null;
}

export interface BackupCompressionStatus extends BackupCompressionSettings {
  active: boolean;
  supported: boolean;
  installed: boolean;
  problem: string;
}

function context(options: BackupCompressionOptions) {
  return {
    paths: { ...DEFAULT_BACKUP_COMPRESSION_PATHS, ...options.paths },
    run: options.run ?? ((command: string, args: string[]) => runCommand(command, args, 5_000)),
    hashes: options.fingerprints ?? { remote: REMOTE_SHA256, tar: TAR_SHA256 },
  };
}

const hash = (source: string) => createHash("sha256").update(source).digest("hex");

/**
 * Fixed PHP and bounded integers only; no user-supplied shell options. A
 * 128 MiB window finds files repeated across the site; plain `zstd -d` reads
 * it. `long: false` is the block 2.0.0-rc.8 wrote, recognized so it upgrades.
 */
export function backupCompressionBlock(settings: BackupCompressionSettings, long = true): string {
  if (!validBackupCompression(settings)) throw new Error(BACKUP_COMPRESSION_ERROR);
  return `${MARKER}${settings.level}:${settings.threads} */
$destinationFile .= '.zst';
$clpAddonsTar = new \\App\\System\\Command\\TarCreateCommand();
$clpAddonsTar->setSources($sources);
$clpAddonsTar->setDestinationFile($destinationFile);
$clpAddonsTar->setExcludes($excludes);
$clpAddonsTar->addFlag('--use-compress-program', '/usr/bin/zstd -${settings.level} -T${settings.threads}${long ? " --long=27" : ""}');
(new \\App\\System\\CommandExecutor())->execute($clpAddonsTar, 21600);
/* clp-addons:backup-zstd:end */`;
}

function readSource(path: string) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > 1_000_000) throw new Error(`${path} is not a regular CloudPanel source file`);
  return { text: readFileSync(path, "utf8"), stat };
}

function inspect(options: BackupCompressionOptions) {
  const ctx = context(options);
  const source = readSource(ctx.paths.remoteCommand);
  let original = source.text;
  let applied: (BackupCompressionSettings & { current: boolean }) | null = null;
  if (original.includes(MARKER)) {
    const edited = new Error("the remote backup compression block was edited; the file is left in place");
    const found = /\/\* clp-addons:backup-zstd:(\d+):(\d+) \*\//.exec(original);
    const settings = { enabled: true, level: Number(found?.[1]), threads: Number(found?.[2]) };
    if (!validBackupCompression(settings)) throw edited;
    const current = [true, false].find((long) => original.split(backupCompressionBlock(settings, long)).length === 2);
    if (current === undefined) throw edited;
    applied = { ...settings, current };
    original = original.replace(backupCompressionBlock(settings, current), ORIGINAL_CALL);
  }
  if (hash(original) !== ctx.hashes.remote || original.split(ORIGINAL_CALL).length !== 2) {
    throw new Error("CloudPanel's remote backup code is not a version this tweak supports; the file is left in place");
  }
  return { ...ctx, source, original, applied };
}

function supportProblem(ctx: ReturnType<typeof inspect>, options: BackupCompressionOptions): string {
  const version = options.version !== undefined ? options.version
    : ctx.run("dpkg-query", ["-W", "-f=${Version}", "cloudpanel"]).stdout.trim().split("+")[0];
  if (version !== "2.5.4-3") return `CloudPanel ${version || "version unknown"} has not been checked for this tweak`;
  if (hash(readSource(ctx.paths.tarCommand).text) !== ctx.hashes.tar) return "CloudPanel's tar command has changed; compression is paused";
  return "";
}

function replaceSource(ctx: ReturnType<typeof inspect>, next: string): void {
  // Do not replace a panel update or an operator's edit made during the check.
  if (readSource(ctx.paths.remoteCommand).text !== ctx.source.text) throw new Error("CloudPanel's backup command changed while checking it; retry after the panel update finishes");
  const { uid, gid, mode } = ctx.source.stat;
  writeFileAtomic(ctx.paths.remoteCommand, next, { mode: mode & 0o777, owner: { uid, gid } });
}

export function backupCompressionStatus(settings: BackupCompressionSettings, options: BackupCompressionOptions = {}): BackupCompressionStatus {
  const installed = context(options).run("/usr/bin/zstd", ["--version"]).ok;
  try {
    const ctx = inspect(options);
    const problem = supportProblem(ctx, options);
    return {
      ...settings, installed, supported: !problem,
      active: !!ctx.applied?.current && !problem && installed && ctx.applied.level === settings.level && ctx.applied.threads === settings.threads,
      problem: problem || (installed ? "" : "Install zstd on the server to enable compression"),
    };
  } catch (error) {
    return { ...settings, installed, active: false, supported: false, problem: error instanceof Error ? error.message : String(error) };
  }
}

/** Returns whether the source changed. Off is a no-op on an untouched or absent panel. */
export function reconcileBackupCompression(settings: BackupCompressionSettings, options: BackupCompressionOptions = {}): boolean {
  if (!validBackupCompression(settings)) throw new Error(BACKUP_COMPRESSION_ERROR);
  const paths = context(options).paths;
  if (!settings.enabled) {
    let source: string;
    try { source = readSource(paths.remoteCommand).text; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
    if (!source.includes(MARKER)) return false;
  }
  const ctx = inspect(options);
  let next = ctx.original;
  if (settings.enabled) {
    let problem: string;
    try {
      problem = supportProblem(ctx, options) || (ctx.run("/usr/bin/zstd", ["--version"]).ok ? "" : "Install zstd on the server to enable compression");
    } catch (error) { problem = error instanceof Error ? error.message : String(error); }
    if (problem) {
      // A dependency changed while our known block was still installed. Give
      // backups their original command back, retaining the saved preference.
      if (ctx.applied) replaceSource(ctx, ctx.original);
      throw new Error(problem);
    }
    next = ctx.original.replace(ORIGINAL_CALL, backupCompressionBlock(settings));
  }
  if (next === ctx.source.text) return false;
  if (settings.enabled) {
    const dir = mkdtempSync(join(tmpdir(), "clp-backup-php-"));
    try {
      const file = join(dir, "RemoteBackupCreateCommand.php");
      writeFileSync(file, next, { mode: 0o600 });
      if (!ctx.run("/usr/bin/php8.1", ["-n", "-l", file]).ok) throw new Error("the compressed backup command failed PHP's syntax check; the file is left in place");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  replaceSource(ctx, next);
  return true;
}

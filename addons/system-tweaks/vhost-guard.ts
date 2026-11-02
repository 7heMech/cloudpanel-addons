/**
 * CloudPanel writes several site settings into nginx vhosts unchecked, and
 * nginx runs as root. `vhost-guard.php` refuses such input before CloudPanel
 * sees it, as the panel pool's `auto_prepend_file`, set by a pool file that
 * reopens CloudPanel's `[clp]` section. CloudPanel's updates replace only its
 * app, so both files stay; deleting them is the whole undo.
 */
import { lstatSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { failAction, runCommand, withFileLock, withFileLockSync, type CommandResult } from "../../cli/action-common";
import { PANEL_FPM_UNIT, RECONCILE_SERVICE, ROOT_UID } from "../../cli/paths";
import { writeFileAtomic } from "../../lib/atomic-write";
import { fastCgiRequest, type FastCgiResponse } from "../../lib/fastcgi";
import { DEFAULT_PANEL_PHP_PATHS, panelPageParams } from "./panel-php";
import GUARD_SCRIPT from "./vhost-guard.php" with { type: "text" };

const FPM_DIR = "/home/clp/services/php-fpm/fpm";

export const DEFAULT_VHOST_GUARD_PATHS = {
  script: `${FPM_DIR}/clp-addons-vhost-guard.php`,
  pool: `${FPM_DIR}/pool.d/zz-clp-addons-vhost-guard.conf`,
  unit: PANEL_FPM_UNIT,
  panelRoot: DEFAULT_PANEL_PHP_PATHS.panelRoot,
  panelSocket: DEFAULT_PANEL_PHP_PATHS.panelSocket,
  /** Held while the panel's FPM is reloaded, so a Panel PHP switch cannot run beside it. */
  lockFile: DEFAULT_PANEL_PHP_PATHS.lockFile,
  rootUid: ROOT_UID,
};

export interface VhostGuardOptions {
  paths?: Partial<typeof DEFAULT_VHOST_GUARD_PATHS>;
  run?: (command: string, args: string[]) => CommandResult;
  request?: (socket: string, params: Record<string, string>) => Promise<FastCgiResponse>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  healthTimeoutMs?: number;
  /** How long an install waits for a Panel PHP change to finish. */
  lockWaitSeconds?: number;
}

export interface VhostGuardStatus {
  /** Both files are in place as this release writes them, and the running pool refuses as they say. */
  active: boolean;
}

interface Context {
  paths: typeof DEFAULT_VHOST_GUARD_PATHS;
  run: (command: string, args: string[]) => CommandResult;
  request: (socket: string, params: Record<string, string>) => Promise<FastCgiResponse>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  healthTimeoutMs: number;
}

function contextOf(options: VhostGuardOptions): Context {
  return {
    paths: { ...DEFAULT_VHOST_GUARD_PATHS, ...options.paths },
    run: options.run ?? ((command, args) => runCommand(command, args, 30_000)),
    request: options.request ?? ((socket, params) => fastCgiRequest(socket, params)),
    sleep: options.sleep ?? ((ms) => Bun.sleep(ms)),
    now: options.now ?? Date.now,
    healthTimeoutMs: options.healthTimeoutMs ?? 20_000,
  };
}

export function vhostGuardPool(script: string): string {
  return [
    "; Managed by clp-addons System Tweaks: checks panel input before CloudPanel writes it into a vhost.",
    "[clp]",
    `php_admin_value[auto_prepend_file] = ${script}`,
    "",
  ].join("\n");
}

/** The file's text when it is root's and only root can write it, else null. */
function trusted(path: string, rootUid: number): string | null {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.uid !== rootUid || (info.mode & 0o022) !== 0) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** A regular file's text, whoever owns it, or null. */
function regularText(path: string): string | null {
  try {
    return lstatSync(path).isFile() ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function inPlace(ctx: Context): { script: boolean; pool: boolean } {
  return {
    script: trusted(ctx.paths.script, ctx.paths.rootUid) === GUARD_SCRIPT,
    pool: trusted(ctx.paths.pool, ctx.paths.rootUid) === vhostGuardPool(ctx.paths.script),
  };
}

export async function vhostGuardStatus(options: VhostGuardOptions = {}): Promise<VhostGuardStatus> {
  const ctx = contextOf(options);
  const now = inPlace(ctx);
  return { active: now.script && now.pool && await refusing(ctx).catch(() => false) };
}

function check(result: CommandResult, what: string): void {
  if (!result.ok) failAction(`${what}: ${(result.stderr || result.stdout).trim() || `exit ${result.exitCode ?? "unknown"}`}`);
}

/** The binary and arguments the panel's FPM runs with, from systemd's merged view of its unit. */
function fpmCommand(ctx: Context): string[] {
  const shown = ctx.run("systemctl", ["show", "-p", "ExecStart", "--value", ctx.paths.unit]);
  const argv = /argv\[\]=([^;]+);/.exec(shown.stdout)?.[1]?.trim().split(/\s+/);
  if (!shown.ok || !argv?.[0] || !/\/php-fpm[0-9]+\.[0-9]+$/.test(argv[0])) {
    failAction(`${ctx.paths.unit} is not the CloudPanel PHP-FPM unit this addon knows`);
  }
  return argv;
}

function testAndReload(ctx: Context): void {
  const [binary, ...args] = fpmCommand(ctx);
  check(ctx.run(binary!, ["-t", ...args]), "the panel's PHP-FPM rejected its config");
  check(ctx.run("systemctl", ["reload", ctx.paths.unit]), `reloading ${ctx.paths.unit} failed`);
}

/** Why the panel is not serving with the guard yet, or null once it is. */
async function unhealthy(ctx: Context): Promise<string | null> {
  try {
    const login = await ctx.request(ctx.paths.panelSocket, panelPageParams(ctx.paths.panelRoot, "/index.php", "/login"));
    if (login.status !== 200) return `the login page answered ${login.status}`;
    return await refusing(ctx) ? null : "the panel's PHP-FPM is not running the guard";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Whether the running pool applies the guard: a Vhost editor parameter without
 * a session is refused by it, and is only the login page to CloudPanel.
 */
async function refusing(ctx: Context): Promise<boolean> {
  const params = panelPageParams(ctx.paths.panelRoot, "/index.php", "/login?vhost-template=");
  const reply = await ctx.request(ctx.paths.panelSocket, { ...params, QUERY_STRING: "vhost-template=" });
  return reply.status === 403;
}

async function waitHealthy(ctx: Context): Promise<string | null> {
  const deadline = ctx.now() + ctx.healthTimeoutMs;
  let problem = await unhealthy(ctx);
  while (problem && ctx.now() < deadline) {
    await ctx.sleep(500);
    problem = await unhealthy(ctx);
  }
  return problem;
}

/** Put `text` at `path`, or remove it when null. */
function restore(path: string, text: string | null): void {
  if (text === null) rmSync(path, { force: true });
  else writeFileAtomic(path, text, { mode: 0o644 });
}

/**
 * Put both files in place, reload the panel's FPM and require the login page
 * to answer and the guard to refuse; a failure puts the previous files back.
 * Files already in place are left alone only while the running pool enforces
 * them, so an install that was interrupted before its reload, or a script
 * OPcache still holds an older copy of, is reloaded. Returns whether it changed anything.
 */
export async function installVhostGuard(options: VhostGuardOptions = {}): Promise<boolean> {
  const ctx = contextOf(options);
  return withFileLock(ctx.paths.lockFile, options.lockWaitSeconds ?? 90, "a panel PHP change is still running", async () => {
    const now = inPlace(ctx);
    if (now.script && now.pool && await refusing(ctx).catch(() => false)) return false;
    if (!present(dirname(ctx.paths.pool))) failAction(`${dirname(ctx.paths.pool)} is missing, so CloudPanel's PHP-FPM is not the one this addon knows`);
    // A pool file of ours that CloudPanel's update chowned may be what the
    // running FPM loaded, so a failure puts it back; anything else is not ours to keep.
    const pool = vhostGuardPool(ctx.paths.script);
    const beforePool = regularText(ctx.paths.pool) === pool ? pool : null;
    const beforeScript = beforePool === null ? null : regularText(ctx.paths.script);
    try {
      writeFileAtomic(ctx.paths.script, GUARD_SCRIPT, { mode: 0o644 });
      writeFileAtomic(ctx.paths.pool, pool, { mode: 0o644 });
      testAndReload(ctx);
      const problem = await waitHealthy(ctx);
      if (problem) failAction(`the panel did not come back with the vhost guard: ${problem}`);
    } catch (error) {
      restore(ctx.paths.pool, beforePool);
      restore(ctx.paths.script, beforeScript);
      const undone = beforePool === null ? "it was removed again" : "the previous files were put back";
      const restored = ctx.run("systemctl", ["reload", ctx.paths.unit]).ok ? undone : `${undone}, but ${ctx.paths.unit} did not reload`;
      failAction(`${error instanceof Error ? error.message : String(error)}; ${restored}`);
    }
    return true;
  });
}

/** Enabling is synchronous and cannot wait for the panel to answer, so repair installs it. */
export function queueVhostGuard(options: VhostGuardOptions = {}): void {
  contextOf(options).run("systemctl", ["start", "--no-block", RECONCILE_SERVICE]);
}

/**
 * Remove the pool file and reload, then the script. Synchronous, for disabling
 * the addon; taking the guard away cannot stop the panel answering. The script
 * stays until the reload succeeds, since the running FPM still prepends it.
 */
export function removeVhostGuard(options: VhostGuardOptions = {}): boolean {
  const ctx = contextOf(options);
  if (!present(ctx.paths.pool) && !present(ctx.paths.script)) return false;
  return withFileLockSync(ctx.paths.lockFile, 90, "a panel PHP change is still running", () => {
    // The running FPM may still prepend the script after its pool file has
    // gone, so it reloads before the script goes, whichever file was left.
    const pool = regularText(ctx.paths.pool);
    rmSync(ctx.paths.pool, { force: true });
    try {
      testAndReload(ctx);
    } catch (error) {
      if (pool !== null) writeFileAtomic(ctx.paths.pool, pool, { mode: 0o644 });
      throw error;
    }
    rmSync(ctx.paths.script, { force: true });
    return true;
  });
}

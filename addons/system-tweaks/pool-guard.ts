/**
 * A PHP script CloudPanel's PHP-FPM prepends to one of its pools, as the
 * pool's `auto_prepend_file`, set by a pool file that reopens the pool's
 * section. CloudPanel's updates replace only its app, so both files stay;
 * deleting them is the whole undo. The vhost guard and the File Manager guard
 * are two of these.
 */
import { lstatSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { failAction, runCommand, withFileLock, withFileLockSync, type CommandResult } from "../../cli/action-common";
import { PANEL_FPM_UNIT, RECONCILE_SERVICE, ROOT_UID } from "../../cli/paths";
import { writeFileAtomic } from "../../lib/atomic-write";
import { fastCgiRequest, type FastCgiResponse } from "../../lib/fastcgi";
import { DEFAULT_PANEL_PHP_PATHS } from "./panel-php";
import PANEL_SESSION from "./panel-session.php" with { type: "text" };

export const FPM_DIR = "/home/clp/services/php-fpm/fpm";

export interface PoolGuardPaths {
  script: string;
  pool: string;
  unit: string;
  panelRoot: string;
  /** The pool's own socket, which the probes ask. */
  socket: string;
  /** Held while the panel's FPM is reloaded, so a Panel PHP switch cannot run beside it. */
  lockFile: string;
  rootUid: number;
}

export const POOL_GUARD_PATH_DEFAULTS = {
  unit: PANEL_FPM_UNIT,
  panelRoot: DEFAULT_PANEL_PHP_PATHS.panelRoot,
  lockFile: DEFAULT_PANEL_PHP_PATHS.lockFile,
  rootUid: ROOT_UID,
};

export interface PoolGuardOptions<P extends PoolGuardPaths = PoolGuardPaths> {
  paths?: Partial<P>;
  run?: (command: string, args: string[]) => CommandResult;
  request?: (socket: string, params: Record<string, string>) => Promise<FastCgiResponse>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  healthTimeoutMs?: number;
  /** How long an install waits for a Panel PHP change to finish. */
  lockWaitSeconds?: number;
}

export interface PoolGuardContext<P extends PoolGuardPaths = PoolGuardPaths> {
  paths: P;
  run: (command: string, args: string[]) => CommandResult;
  request: (socket: string, params: Record<string, string>) => Promise<FastCgiResponse>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  healthTimeoutMs: number;
}

export interface PoolGuardSpec<P extends PoolGuardPaths> {
  /** As failures name it: "the vhost guard". */
  name: string;
  defaults: P;
  script: string;
  pool: (paths: P) => string;
  /** Why the pool does not answer as it should with the guard, or null. */
  answering: (ctx: PoolGuardContext<P>) => Promise<string | null>;
  /** Whether the running pool refuses what only the guard refuses. */
  refusing: (ctx: PoolGuardContext<P>) => Promise<boolean>;
  /** Pool settings a reload does not apply to a socket FPM keeps: whether they hold, and putting them in place or back. */
  socket?: {
    held: (ctx: PoolGuardContext<P>) => boolean;
    apply: (ctx: PoolGuardContext<P>) => void;
    undo: (ctx: PoolGuardContext<P>) => void;
  };
}

const SESSION_INCLUDE = "require __DIR__ . '/panel-session.php'";

/** The guard as installed: the shared session reader in place of its include, so it is one file. */
export function withPanelSession(script: string): string {
  if (!script.includes(SESSION_INCLUDE)) throw new Error("a guard script does not include panel-session.php");
  return script.replace(SESSION_INCLUDE, `(static function () {\n${PANEL_SESSION.replace(/^<\?php\n/, "").trimEnd()}\n})()`);
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

function check(result: CommandResult, what: string): void {
  if (!result.ok) failAction(`${what}: ${(result.stderr || result.stdout).trim() || `exit ${result.exitCode ?? "unknown"}`}`);
}

/** Put `text` at `path`, or remove it when null. */
function restore(path: string, text: string | null): void {
  if (text === null) rmSync(path, { force: true });
  else writeFileAtomic(path, text, { mode: 0o644 });
}

export function poolGuard<P extends PoolGuardPaths>(spec: PoolGuardSpec<P>) {
  const script = withPanelSession(spec.script);

  function contextOf(options: PoolGuardOptions<P>): PoolGuardContext<P> {
    return {
      paths: { ...spec.defaults, ...options.paths },
      run: options.run ?? ((command, args) => runCommand(command, args, 30_000)),
      request: options.request ?? ((socket, params) => fastCgiRequest(socket, params)),
      sleep: options.sleep ?? ((ms) => Bun.sleep(ms)),
      now: options.now ?? Date.now,
      healthTimeoutMs: options.healthTimeoutMs ?? 20_000,
    };
  }

  function inPlace(ctx: PoolGuardContext<P>): { script: boolean; pool: boolean } {
    return {
      script: trusted(ctx.paths.script, ctx.paths.rootUid) === script,
      pool: trusted(ctx.paths.pool, ctx.paths.rootUid) === spec.pool(ctx.paths),
    };
  }

  async function enforced(ctx: PoolGuardContext<P>): Promise<boolean> {
    const now = inPlace(ctx);
    return now.script && now.pool && (spec.socket?.held(ctx) ?? true) && await spec.refusing(ctx).catch(() => false);
  }

  /** The binary and arguments the panel's FPM runs with, from systemd's merged view of its unit. */
  function fpmCommand(ctx: PoolGuardContext<P>): string[] {
    const shown = ctx.run("systemctl", ["show", "-p", "ExecStart", "--value", ctx.paths.unit]);
    const argv = /argv\[\]=([^;]+);/.exec(shown.stdout)?.[1]?.trim().split(/\s+/);
    if (!shown.ok || !argv?.[0] || !/\/php-fpm[0-9]+\.[0-9]+$/.test(argv[0])) {
      failAction(`${ctx.paths.unit} is not the CloudPanel PHP-FPM unit this addon knows`);
    }
    return argv;
  }

  function testAndReload(ctx: PoolGuardContext<P>): void {
    const [binary, ...args] = fpmCommand(ctx);
    check(ctx.run(binary!, ["-t", ...args]), "the panel's PHP-FPM rejected its config");
    check(ctx.run("systemctl", ["reload", ctx.paths.unit]), `reloading ${ctx.paths.unit} failed`);
  }

  /** Why the pool is not serving with the guard yet, or null once it is. */
  async function unhealthy(ctx: PoolGuardContext<P>): Promise<string | null> {
    try {
      const problem = await spec.answering(ctx);
      if (problem) return problem;
      return await spec.refusing(ctx) ? null : "the panel's PHP-FPM is not running the guard";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  async function waitHealthy(ctx: PoolGuardContext<P>): Promise<string | null> {
    const deadline = ctx.now() + ctx.healthTimeoutMs;
    let problem = await unhealthy(ctx);
    while (problem && ctx.now() < deadline) {
      await ctx.sleep(500);
      problem = await unhealthy(ctx);
    }
    return problem;
  }

  return {
    script,

    /** Both files are in place as this release writes them, and the running pool refuses as they say. */
    async status(options: PoolGuardOptions<P> = {}): Promise<{ active: boolean }> {
      return { active: await enforced(contextOf(options)) };
    },

    /**
     * Put both files in place, reload the panel's FPM and require the pool to
     * answer and the guard to refuse; a failure puts the previous files back.
     * Files already in place are left alone only while the running pool
     * enforces them, so an install that was interrupted before its reload, or
     * a script OPcache still holds an older copy of, is reloaded. Returns
     * whether it changed anything.
     */
    async install(options: PoolGuardOptions<P> = {}): Promise<boolean> {
      const ctx = contextOf(options);
      return withFileLock(ctx.paths.lockFile, options.lockWaitSeconds ?? 90, "a panel PHP change is still running", async () => {
        if (await enforced(ctx)) return false;
        if (!present(dirname(ctx.paths.pool))) failAction(`${dirname(ctx.paths.pool)} is missing, so CloudPanel's PHP-FPM is not the one this addon knows`);
        // A pool file of ours that CloudPanel's update chowned may be what the
        // running FPM loaded, so a failure puts it back; anything else is not ours to keep.
        const pool = spec.pool(ctx.paths);
        const beforePool = regularText(ctx.paths.pool) === pool ? pool : null;
        const beforeScript = beforePool === null ? null : regularText(ctx.paths.script);
        try {
          writeFileAtomic(ctx.paths.script, script, { mode: 0o644 });
          writeFileAtomic(ctx.paths.pool, pool, { mode: 0o644 });
          testAndReload(ctx);
          spec.socket?.apply(ctx);
          const problem = await waitHealthy(ctx);
          if (problem) failAction(`the panel did not come back with ${spec.name}: ${problem}`);
        } catch (error) {
          restore(ctx.paths.pool, beforePool);
          restore(ctx.paths.script, beforeScript);
          const undone = beforePool === null ? "it was removed again" : "the previous files were put back";
          const reloaded = ctx.run("systemctl", ["reload", ctx.paths.unit]).ok;
          if (beforePool === null) {
            try { spec.socket?.undo(ctx); } catch { /* the socket goes back to CloudPanel's at FPM's next restart */ }
          }
          failAction(`${error instanceof Error ? error.message : String(error)}; ${reloaded ? undone : `${undone}, but ${ctx.paths.unit} did not reload`}`);
        }
        return true;
      });
    },

    /** Enabling is synchronous and cannot wait for the panel to answer, so repair installs it. */
    queue(options: PoolGuardOptions<P> = {}): void {
      contextOf(options).run("systemctl", ["start", "--no-block", RECONCILE_SERVICE]);
    },

    /**
     * Remove the pool file and reload, then the script. Synchronous, for
     * disabling the addon; taking the guard away cannot stop the panel
     * answering. The script stays until the reload succeeds, since the running
     * FPM still prepends it.
     */
    remove(options: PoolGuardOptions<P> = {}): boolean {
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
        spec.socket?.undo(ctx);
        return true;
      });
    },
  };
}

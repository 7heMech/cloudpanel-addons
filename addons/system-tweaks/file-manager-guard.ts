/**
 * CloudPanel's File Manager runs as root and follows `..` and symbolic links
 * out of the site's home. `file-manager-guard.php` refuses such requests
 * before CloudPanel sees them, prepended to the `[clp-file-manager]` pool (see
 * `pool-guard.ts`). The same pool file leaves its socket to `clp`, whose Nginx
 * is the only client, rather than to everyone in group `clp`.
 */
import { chmodSync, chownSync, lstatSync } from "node:fs";
import { failAction } from "../../lib/action";
import { PANEL_USER } from "../../lib/paths";
import { DEFAULT_PANEL_PHP_PATHS, panelPageParams } from "./panel-php";
import {
  FPM_DIR, POOL_GUARD_PATH_DEFAULTS, poolGuard, type PoolGuardContext, type PoolGuardOptions, type PoolGuardPaths,
} from "./pool-guard";
import GUARD_SCRIPT from "./file-manager-guard.php" with { type: "text" };

export interface FileManagerGuardPaths extends PoolGuardPaths {
  /** `clp`'s uid and gid, looked up when null. */
  panelUid: number | null;
  panelGid: number | null;
}

export const DEFAULT_FILE_MANAGER_GUARD_PATHS: FileManagerGuardPaths = {
  ...POOL_GUARD_PATH_DEFAULTS,
  script: `${FPM_DIR}/clp-addons-file-manager-guard.php`,
  pool: `${FPM_DIR}/pool.d/zz-clp-addons-file-manager-guard.conf`,
  socket: DEFAULT_PANEL_PHP_PATHS.fileManagerSocket,
  panelUid: null,
  panelGid: null,
};

export type FileManagerGuardOptions = PoolGuardOptions<FileManagerGuardPaths>;
type Context = PoolGuardContext<FileManagerGuardPaths>;

export function fileManagerGuardPool(script: string): string {
  return [
    "; Managed by clp-addons System Tweaks: keeps the File Manager in the site's home, and its socket to clp.",
    "[clp-file-manager]",
    `php_admin_value[auto_prepend_file] = ${script}`,
    `listen.owner = ${PANEL_USER}`,
    "listen.mode = 0600",
    "",
  ].join("\n");
}

function panelIds(ctx: Context): { uid: number; gid: number } {
  if (ctx.paths.panelUid !== null && ctx.paths.panelGid !== null) return { uid: ctx.paths.panelUid, gid: ctx.paths.panelGid };
  const fields = ctx.run("getent", ["passwd", PANEL_USER]).stdout.trim().split(":");
  const uid = Number.parseInt(fields[2] ?? "", 10);
  const gid = Number.parseInt(fields[3] ?? "", 10);
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) failAction(`could not look up the ${PANEL_USER} user`);
  return { uid, gid };
}

function socketInfo(ctx: Context) {
  try {
    const info = lstatSync(ctx.paths.socket);
    return info.isSocket() ? info : null;
  } catch {
    return null;
  }
}

/** FPM sets a socket's owner and mode when it creates it; a reload keeps the one it has. */
function setSocket(ctx: Context, uid: number, gid: number, mode: number): void {
  const info = socketInfo(ctx);
  if (!info) failAction(`${ctx.paths.socket} is not the File Manager's socket`);
  if (info.uid !== uid || info.gid !== gid) chownSync(ctx.paths.socket, uid, gid);
  if ((info.mode & 0o777) !== mode) chmodSync(ctx.paths.socket, mode);
}

const guard = poolGuard<FileManagerGuardPaths>({
  name: "the File Manager guard",
  defaults: DEFAULT_FILE_MANAGER_GUARD_PATHS,
  script: GUARD_SCRIPT,
  pool: (paths) => fileManagerGuardPool(paths.script),
  async answering(ctx) {
    const page = await ctx.request(ctx.paths.socket, panelPageParams(ctx.paths.panelRoot, "/file-manager/index.php", "/file-manager/index.php"));
    return page.status < 400 ? null : `the File Manager answered ${page.status}`;
  },
  // CloudPanel alone answers a session id that climbs out of its folder with an empty page.
  async refusing(ctx) {
    const params = panelPageParams(ctx.paths.panelRoot, "/file-manager/backend.php", "/file-manager/backend/files?id=/");
    return (await ctx.request(ctx.paths.socket, { ...params, QUERY_STRING: "id=/", HTTP_COOKIE: "cloudpanel=../x" })).status === 403;
  },
  socket: {
    held(ctx) {
      const info = socketInfo(ctx);
      return info !== null && info.uid === panelIds(ctx).uid && (info.mode & 0o777) === 0o600;
    },
    apply(ctx) {
      const { uid, gid } = panelIds(ctx);
      setSocket(ctx, uid, gid, 0o600);
    },
    // CloudPanel's own: root's, readable and writable by group clp.
    undo(ctx) {
      if (socketInfo(ctx)) setSocket(ctx, ctx.paths.rootUid, panelIds(ctx).gid, 0o660);
    },
  },
});

export const FILE_MANAGER_GUARD_SCRIPT = guard.script;
export const fileManagerGuardStatus = guard.status;
export const installFileManagerGuard = guard.install;
export const queueFileManagerGuard = guard.queue;
export const removeFileManagerGuard = guard.remove;

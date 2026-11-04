/**
 * CloudPanel writes several site settings into nginx vhosts unchecked, and
 * nginx runs as root. `vhost-guard.php` refuses such input before CloudPanel
 * sees it, prepended to CloudPanel's `[clp]` pool (see `pool-guard.ts`).
 */
import { DEFAULT_PANEL_PHP_PATHS, panelPageParams } from "./panel-php";
import { FPM_DIR, POOL_GUARD_PATH_DEFAULTS, poolGuard, type PoolGuardContext, type PoolGuardOptions, type PoolGuardPaths } from "./pool-guard";
import GUARD_SCRIPT from "./vhost-guard.php" with { type: "text" };

export const DEFAULT_VHOST_GUARD_PATHS: PoolGuardPaths = {
  ...POOL_GUARD_PATH_DEFAULTS,
  script: `${FPM_DIR}/clp-addons-vhost-guard.php`,
  pool: `${FPM_DIR}/pool.d/zz-clp-addons-vhost-guard.conf`,
  socket: DEFAULT_PANEL_PHP_PATHS.panelSocket,
};

export type VhostGuardOptions = PoolGuardOptions;

export function vhostGuardPool(script: string): string {
  return [
    "; Managed by clp-addons System Tweaks: checks panel input before CloudPanel writes it into a vhost.",
    "[clp]",
    `php_admin_value[auto_prepend_file] = ${script}`,
    "",
  ].join("\n");
}

const guard = poolGuard({
  name: "the vhost guard",
  defaults: DEFAULT_VHOST_GUARD_PATHS,
  script: GUARD_SCRIPT,
  pool: (paths) => vhostGuardPool(paths.script),
  async answering(ctx) {
    const login = await ctx.request(ctx.paths.socket, panelPageParams(ctx.paths.panelRoot, "/index.php", "/login"));
    return login.status === 200 ? null : `the login page answered ${login.status}`;
  },
  // A Vhost editor parameter without a session is refused by the guard, and is
  // only the login page to CloudPanel.
  async refusing(ctx: PoolGuardContext) {
    const params = panelPageParams(ctx.paths.panelRoot, "/index.php", "/login?vhost-template=");
    return (await ctx.request(ctx.paths.socket, { ...params, QUERY_STRING: "vhost-template=" })).status === 403;
  },
});

export const VHOST_GUARD_SCRIPT = guard.script;
export const vhostGuardStatus = guard.status;
export const installVhostGuard = guard.install;
export const queueVhostGuard = guard.queue;
export const removeVhostGuard = guard.remove;

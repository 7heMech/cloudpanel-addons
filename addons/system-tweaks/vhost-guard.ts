/**
 * CloudPanel writes several site settings into nginx vhosts unchecked, and
 * nginx runs as root. `vhost-guard.php` refuses such input before CloudPanel
 * sees it, prepended to CloudPanel's `[clp]` pool (see `pool-guard.ts`).
 */
import { DEFAULT_PANEL_PHP_PATHS, panelPageParams } from "./panel-php";
import { FPM_DIR, POOL_GUARD_PATH_DEFAULTS, poolGuard, type PoolGuardContext, type PoolGuardOptions, type PoolGuardPaths } from "./pool-guard";
import GUARD_SCRIPT from "./vhost-guard.php" with { type: "text" };
import {
  installVarnishBackends, removeVarnishBackends, sitesWithHomeLogs, sitesWithOwnLogrotate, varnishBackendsActive, type VarnishBackendOptions,
} from "./varnish-backend";
import { storedVhostValues, type StoredVhostValue, type VhostValuesOptions } from "./vhost-values";
import { POOL_GUARD_GATEWAY_TIMEOUT_MS } from "./limits";
import { tweak } from "./tweak";
import { badge, statusLine, switchRow, warning } from "./app/rows";
import { esc } from "../../lib/app-http";
import { errorMessage } from "../../lib/errors";

const DEFAULT_VHOST_GUARD_PATHS: PoolGuardPaths = {
  ...POOL_GUARD_PATH_DEFAULTS,
  script: `${FPM_DIR}/clp-addons-vhost-guard.php`,
  pool: `${FPM_DIR}/pool.d/zz-clp-addons-vhost-guard.conf`,
  socket: DEFAULT_PANEL_PHP_PATHS.panelSocket,
};

export type VhostGuardOptions = PoolGuardOptions;

function vhostGuardPool(script: string): string {
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

interface VhostGuardState {
  enabled: boolean;
  active: boolean;
  stored: StoredVhostValue[] | { error: string };
  homeLogs: string[];
  ownLogrotate: string[];
}

interface Options {
  vhostGuard?: VhostGuardOptions;
  varnishBackend?: VarnishBackendOptions;
  vhostValues?: VhostValuesOptions;
}

function storedOrError(options?: VhostValuesOptions): StoredVhostValue[] | { error: string } {
  try { return storedVhostValues(options); }
  catch (error) { return { error: errorMessage(error) }; }
}

function vhostGuardLine(state: VhostGuardState): string {
  if (state.active) return `${badge("On", "ok")} <span>Panel input is checked before CloudPanel writes it into a vhost.</span>`;
  if (state.enabled) return `${badge("Not applied", "warn")} <span>Run clp-addons repair.</span>`;
  return `${badge("Off", "plain")} <span>Any panel account with a site can write nginx config, and nginx runs as root.</span>`;
}

/** Site settings saved before the guard, or by a site's own user, that it would refuse now. */
function storedValuesWarning(stored: VhostGuardState["stored"]): string {
  if ("error" in stored) return `<p class="st-status hint">Stored site settings could not be checked: ${esc(stored.error)}</p>`;
  if (!stored.length) return "";
  const listed = stored.slice(0, 10).map((value) => `${esc(value.domain)}: ${esc(value.field)}`).join("; ");
  return warning(`These saved site settings would be refused now, so they may hold nginx directives: ${listed}${
    stored.length > 10 ? `; and ${stored.length - 10} more` : ""}. Check each one and the site's vhost.`);
}

/** Sites whose vhost the sync leaves alone, so nginx still opens their logs in the user's home. */
function homeLogsWarning(domains: string[]): string {
  if (!domains.length) return "";
  const listed = domains.slice(0, 10).map(esc).join(", ");
  return warning(`These sites' vhosts still write nginx logs in the site user's home, where that user can point them at any file: ${listed}${
    domains.length > 10 ? ` and ${domains.length - 10} more` : ""}. clp-addons rewrites a vhost only when root alone can write it: make each one in /etc/nginx/sites-enabled owned by root with mode 644, then run clp-addons repair.`);
}

/** Sites whose logrotate file was edited by hand, so the sync left it as it is. */
function ownLogrotateWarning(domains: string[]): string {
  if (!domains.length) return "";
  const listed = domains.slice(0, 10).map(esc).join(", ");
  return warning(`These sites' files in /etc/logrotate.d were edited by hand, so clp-addons left them as they are: ${listed}${
    domains.length > 10 ? ` and ${domains.length - 10} more` : ""}. A file that rotates the site's home as root lets its user have root rotate files it links there. Rotate the home with su set to the site's user.`);
}

/** Refuse panel input CloudPanel would write into a vhost unchecked, and render Varnish backends from a checked include. */
export const VHOST_GUARD_TWEAK = tweak<{ blockVhostInjection: boolean }, Options, { vhostGuard: VhostGuardState }>()({
  defaults: { blockVhostInjection: true },
  state: async ({ options, settings }) => ({
    vhostGuard: {
      enabled: settings.blockVhostInjection,
      active: (await vhostGuardStatus(options.vhostGuard)).active && varnishBackendsActive(options.varnishBackend),
      stored: storedOrError(options.vhostValues),
      homeLogs: settings.blockVhostInjection ? sitesWithHomeLogs(options.varnishBackend) : [],
      ownLogrotate: settings.blockVhostInjection ? sitesWithOwnLogrotate(options.varnishBackend) : [],
    },
  }),
  switch: {
    verb: "set-vhost-guard",
    key: "blockVhostInjection",
    timeout: POOL_GUARD_GATEWAY_TIMEOUT_MS,
    async set({ options, save }, on) {
      if (on) {
        await installVhostGuard(options.vhostGuard);
        // On once the guard is, so repair finishes the includes if they fail here.
        save({ blockVhostInjection: true });
        installVarnishBackends(options.varnishBackend);
      } else {
        removeVhostGuard(options.vhostGuard);
        try {
          removeVarnishBackends(options.varnishBackend);
        } catch (error) {
          // Still on, so the guard comes back now rather than at the next repair.
          await installVhostGuard(options.vhostGuard).catch(() => queueVhostGuard(options.vhostGuard));
          throw error;
        }
        save({ blockVhostInjection: false });
      }
    },
  },
  repair: {
    guard: {
      label: "vhost guard",
      locked: true,
      // A short wait for Panel PHP's lock, so this does not hold the page's switches behind one.
      run: async ({ options, settings }) =>
        settings.blockVhostInjection && await installVhostGuard({ lockWaitSeconds: 5, ...options.vhostGuard }) && "vhost guard put back",
    },
    // Also the new-site watcher's: every site's Varnish backend comes from its checked include.
    varnish: {
      label: "Varnish backends",
      locked: true,
      run: ({ options, settings }) => settings.blockVhostInjection && installVarnishBackends(options.varnishBackend)
        ? "Varnish backends and site nginx logs moved to root-owned paths" : null,
    },
    stored: {
      label: "stored site settings",
      locked: false,
      run: ({ options }) => {
        const stored = storedVhostValues(options.vhostValues);
        return stored.length ? `stored site settings the vhost guard would refuse: ${stored.map((value) => `${value.domain} ${value.field}`).join(", ")}` : null;
      },
    },
  },
  withdraw: {
    run: ({ options }) => {
      removeVhostGuard(options.vhostGuard);
      removeVarnishBackends(options.varnishBackend);
    },
  },
  restore: { run: ({ options, settings }) => { if (settings.blockVhostInjection) queueVhostGuard(options.vhostGuard); } },
  row: ({ vhostGuard }, locked) => switchRow("set-vhost-guard", {
    key: "blockVhostInjection",
    title: "Block nginx config injection",
    description: [
      "Refuses site settings CloudPanel would write into a vhost unchecked, such as a Root Directory or Varnish server holding nginx directives.",
      "Only administrators can save the Vhost editor and PageSpeed settings, and site nginx logs move where only root can write.",
    ],
    checked: vhostGuard.enabled,
    extra: `${statusLine(vhostGuardLine(vhostGuard))}${storedValuesWarning(vhostGuard.stored)}${homeLogsWarning(vhostGuard.homeLogs)}${ownLogrotateWarning(vhostGuard.ownLogrotate)}`,
  }, locked),
});

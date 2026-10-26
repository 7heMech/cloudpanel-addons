import { existsSync } from "node:fs";

// Read by cli/action-common.ts, which cannot own it: that module opens FFI at
// import time, and every consumer of this leaf would then pay for it.
export const PANEL_IDENTITY_PATH = "/etc/clp-addons/panel-identity.conf";

export { mountPath } from "../lib/mount";

export const REPO = "7heMech/cloudpanel-addons";
export const CLI_ARTIFACT = "clp-addons-linux-x64";
export const CLI_BIN = "/usr/local/bin/clp-addons";
export const LIBEXEC_DIR = "/usr/local/libexec/clp-addons";
/** Sigstore's trusted keys, cached where only root can write. */
export const SIGSTORE_DIR = `${LIBEXEC_DIR}/sigstore`;
/** The GitHub CLI that verified updates before the binary did it itself. */
export const LEGACY_GH = `${LIBEXEC_DIR}/gh`;

export const SERVICE_USER = "clp-addons";
export const SERVICE_GROUP = "clp-addons";
export const PANEL_USER = "clp";
export const PANEL_GROUP = "clp";
export const SHARED_GROUP = SERVICE_GROUP;

export const SOCKET_DIR = "/run/clp-addons";
export const SOCKET_PATH = `${SOCKET_DIR}/manager.sock`;
export const SESSION_DIR = "/home/clp/htdocs/app/files/var/sessions";
/** The php.ini the panel's own FPM pool runs with, per clp-php-fpm.service. */
export const PANEL_PHP_INI = "/home/clp/services/php-fpm/fpm/php.ini";
/** Per-version PHP config root; each `<X.Y>/fpm/conf.d` is scanned by that FPM. */
export const PHP_ROOT = "/etc/php";
/** Where the `php-fpm<X.Y>` binaries live, used to test a config before reload. */
export const PHP_FPM_BIN_DIR = "/usr/sbin";
/** The panel's own PHP-FPM service. It scans the installed 8.1 `conf.d`, so a
 *  drop-in written there reaches the panel and the root File Manager pool. */
export const PANEL_FPM_UNIT = "clp-php-fpm.service";
/** The platform's upload-progress guard, written into every `<X.Y>/fpm/conf.d`. */
export const PHP_GUARD_INI_NAME = "99-clp-addons-upload-progress.ini";

export const MANAGER_UNIT = "clp-addons.service";
export const AUTH_SOCKET_UNIT = "clp-addons-auth.socket";
export const AUTH_SERVICE_UNIT = "clp-addons-auth.service";
export const AUTH_SOCKET_PATH = `${SOCKET_DIR}/auth.sock`;
export const PANEL_DB = "/home/clp/htdocs/app/data/db.sq3";
/** Site vhosts, which stay with the distro Nginx in both panel layouts. */
export const DISTRO_NGINX_SITES_DIR = "/etc/nginx/sites-enabled";
const PANEL_NGINX_DIR = "/home/clp/services/nginx";

export interface NginxLayout {
  /** Directory holding the panel vhost. */
  sitesDir: string;
  /** Config root to hand `nginx -t -c`, when the instance has its own. */
  configFile: string | null;
  /** systemd unit that owns the resolved tree. */
  service: string;
  /** The resolved tree is owned by the panel user rather than by root. */
  panelOwned: boolean;
}

/**
 * CloudPanel 6 moved the panel onto its own Nginx instance under
 * /home/clp/services/nginx, run by clp-nginx.service, and left the site vhosts
 * with the distro instance. Detect on the tree and unit rather than a panel
 * version string: both layouts are in the field, and the version does not say
 * which one an install has.
 */
export function nginxLayout(panelDir = PANEL_NGINX_DIR): NginxLayout {
  if (existsSync(`${panelDir}/nginx.conf`) && existsSync(`${panelDir}/sites-enabled`)) {
    return {
      sitesDir: `${panelDir}/sites-enabled`,
      configFile: `${panelDir}/nginx.conf`,
      service: "clp-nginx",
      panelOwned: true,
    };
  }
  return { sitesDir: DISTRO_NGINX_SITES_DIR, configFile: null, service: "nginx", panelOwned: false };
}
export const NGINX_PROXY_STATE_DIR = "/var/lib/clp-addons/nginx";
export const NGINX_GLOBAL_SETTINGS = "/etc/nginx/global_settings";
export const CLOUDFLARE_IPS_PATH = "/etc/nginx/cloudflare/ips";
export const NGINX_MAINTENANCE_STATE_DIR = "/var/lib/clp-addons/nginx-maintenance";

const PANEL_APP = "/home/clp/htdocs/app/files";
export const TEMPLATES_DIR = `${PANEL_APP}/templates`;
/** Where the panel keeps its sessions, cache and one-time sign-in tokens. */
export const PANEL_VAR_DIR = `${PANEL_APP}/var`;
export const TWIG_CACHE_DIR = `${PANEL_APP}/var/cache`;
/** Where Symfony's filesystem cache pool keeps the panel's own cached values. */
export const PANEL_CACHE_POOL_DIR = `${PANEL_APP}/var/cache/prod/pools/app`;

/** Who must own a file this project wrote as root for it to be trusted. */
export const ROOT_UID = 0;
export const CONFIG_DIR = "/etc/clp-addons";
export const STATE_DIR = "/var/lib/clp-addons";
export const ARTIFACT_MANIFEST_PATH = `${STATE_DIR}/artifacts.json`;
export const TEMPLATE_STATE_DIR = `${STATE_DIR}/templates`;
export const LOCK_DIR = "/run/lock/clp-addons";
export const SYSTEMD_DIR = "/etc/systemd/system";
/** Runs `clp-addons apt-hook` around unattended-upgrades' daily run. */
export const APT_UPGRADE_DROPIN = "apt-daily-upgrade.service.d/50-clp-addons.conf";
/** Present while edits to package conffiles are given back for an upgrade run. */
/** Root-only: the manager owns /run/clp-addons, and root writes this flag. */
export const CONFFILES_RELEASED_FLAG = `${LOCK_DIR}/conffiles-released`;
/** Operator-editable schedule for Instatic's recovery snapshots. */
export const INSTATIC_BACKUP_CRON = "/etc/cron.d/clp-addons-instatic-backup";

export const RECONCILE_SERVICE = "clp-addons-reconcile.service";
export const RECONCILE_TIMER = "clp-addons-reconcile.timer";
export const RECONCILE_PATH = "clp-addons-anchor.path";
export const ANCHOR_SERVICE = "clp-addons-anchor.service";
export const NEW_SITES_SERVICE = "clp-addons-new-sites.service";
export const NEW_SITES_PATH = "clp-addons-new-sites.path";


export const LEGACY_UNITS = [
  // SMTP Relay's own new-site watcher, before the shared one.
  "clp-addons-smtp-reconcile.path",
  "clp-addons-smtp-reconcile.service",
  // Cloudflare IP Access's one-minute check for new sites, before the shared watcher.
  "clp-addons-cloudflare-ips-reconcile.timer",
  "clp-addons-cloudflare-ips-reconcile.service",
];


// Maintenance Mode's check in Nginx: a marked block in CloudPanel's
// global_settings, the client-address map it reads, and the include each site's
// vhost needs, kept against a record of global_settings as CloudPanel left it.
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "../../lib/atomic-write";
import { runCommand, type CommandResult } from "../../lib/command";
import { errorMessage } from "../../lib/errors";
import {
  NginxReadError, baselineFiles, hasBaseline, readBaseline, readIfPresent, recordBaseline, removeBaseline, sha256,
} from "../../lib/nginx-baseline";
import { cloudflareRanges, nginxFileChange, trustedVhost, withNginxTransaction } from "../../lib/nginx-transaction";
import { openPanelDatabase } from "../../lib/panel-db";
import {
  DISTRO_NGINX_SITES_DIR, NGINX_GLOBAL_SETTINGS, NGINX_MAINTENANCE_STATE_DIR, PANEL_DB, MAINTENANCE_INCLUDE_PATH,
} from "../../lib/paths";
import { sitesWithoutMaintenance, stageMaintenanceVhosts } from "./vhosts";

// A sentinel response code keeps an application's own 503 page intact. The
// internal redirect changes only maintenance-generated 418 responses to 503.
// ACME is exempted explicitly because rewrite directives in server context run
// before Nginx selects the site's /.well-known location.
export const NGINX_MAINTENANCE_BLOCK = `# clp-addons:maintenance:start
set $clp_maintenance 0;
if (-f /var/lib/clp-addons/maintenance/_global/on) {
    set $clp_maintenance 1;
}
if (-f /var/lib/clp-addons/maintenance/$server_name/on) {
    set $clp_maintenance 1;
}
if (-f /var/lib/clp-addons/maintenance/_global/bypass_$clp_maintenance_ip) {
    set $clp_maintenance 0;
}
if (-f /var/lib/clp-addons/maintenance/$server_name/bypass_$clp_maintenance_ip) {
    set $clp_maintenance 0;
}
if ($uri ~ ^/\\.well-known/acme-challenge/) {
    set $clp_maintenance 0;
}
if ($uri = /__clp_addons_maintenance) {
    set $clp_maintenance 0;
}
if ($clp_maintenance = 1) {
    return 418;
}
error_page 418 =503 /__clp_addons_maintenance;
location = /__clp_addons_maintenance {
    internal;
    root /var/lib/clp-addons/maintenance;
    add_header Retry-After 300 always;
    add_header Cache-Control "no-store" always;
    add_header Content-Security-Policy "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" always;
    add_header X-Content-Type-Options "nosniff" always;
    try_files /$server_name/maintenance.html /default.html =503;
}
# clp-addons:maintenance:end`;

const NGINX_MAINTENANCE_BLOCK_RE = /\r?\n?[ \t]*# clp-addons:maintenance:start[\s\S]*?[ \t]*# clp-addons:maintenance:end\r?\n?/g;

const MAINTENANCE_GEO_MARKER = "# clp-addons:maintenance-client-ip";

/** CloudPanel keeps these ranges for its own Cloudflare-only vhost setting. */
function maintenanceGeoContent(ranges: string[]): string {
  return `${MAINTENANCE_GEO_MARKER}
# Preserve the connection peer even if CloudPanel's broad real_ip settings
# replaced $remote_addr using a request header.
map $realip_remote_addr $clp_maintenance_peer {
    "" $remote_addr;
    default $realip_remote_addr;
}
# A loopback peer is CloudPanel's own front server for a site it proxies to a
# local backend, such as WordPress; it passes its client in X-Real-IP.
geo $clp_maintenance_peer $clp_local_peer {
    default 0;
    127.0.0.0/8 1;
    ::1/128 1;
}
map $http_x_real_ip $clp_real_ip_header {
    default "";
    ~^[0-9A-Fa-f:.]+$ $http_x_real_ip;
}
map "$clp_local_peer:$clp_real_ip_header" $clp_maintenance_client {
    default $clp_maintenance_peer;
    ~^1:.+$ $clp_real_ip_header;
}
geo $clp_maintenance_client $clp_cf_peer {
    default 0;
${ranges.map((range) => `    ${range} 1;`).join("\n")}
}
map $http_cf_connecting_ip $clp_cf_header_ip {
    default "";
    ~^[0-9A-Fa-f:.]+$ $http_cf_connecting_ip;
}
map "$clp_cf_peer:$clp_cf_header_ip" $clp_maintenance_ip {
    default $clp_maintenance_client;
    ~^1:.+$ $clp_cf_header_ip;
}
`;
}

export interface MaintenanceNginxPaths {
  settingsPath?: string;
  stateDir?: string;
  geoPath?: string;
  cloudflareIpsPath?: string;
  panelDb?: string | null;
  nginxVhostDir?: string;
  includePath?: string;
  vhostUid?: number;
}

export type MaintenanceNginxState =
  | "ok"
  | "missing"
  | "stale-content"
  | "upstream-changed"
  | "conflict"
  | "validation-failed"
  | "uncovered-sites";

export interface MaintenanceNginxStatus {
  state: MaintenanceNginxState;
  settingsPath: string;
  uncoveredSites?: string[];
  detail?: string;
}

export interface MaintenanceNginxResult extends MaintenanceNginxStatus {
  changed: boolean;
}

function stripMaintenanceNginx(content: string): string {
  return content.replace(NGINX_MAINTENANCE_BLOCK_RE, "");
}

function maintenancePath(options: MaintenanceNginxPaths) {
  const settingsPath = options.settingsPath ?? NGINX_GLOBAL_SETTINGS;
  return {
    settingsPath,
    panelDb: options.panelDb === undefined ? PANEL_DB : options.panelDb,
    nginxVhostDir: options.nginxVhostDir ?? DISTRO_NGINX_SITES_DIR,
    includePath: options.includePath ?? MAINTENANCE_INCLUDE_PATH,
    vhostUid: options.vhostUid ?? 0,
    stateDir: options.stateDir ?? NGINX_MAINTENANCE_STATE_DIR,
    geoPath: options.geoPath ?? join(dirname(settingsPath), "sites-enabled", "00-clp-addons-maintenance-client-ip.conf"),
    cloudflareIpsPath: options.cloudflareIpsPath ?? join(dirname(settingsPath), "cloudflare", "ips"),
  };
}

export function inspectNginxMaintenance(options: MaintenanceNginxPaths = {}): MaintenanceNginxStatus {
  try { return inspectMaintenance(options); }
  catch (error) {
    if (!(error instanceof NginxReadError)) throw error;
    return { state: "validation-failed", settingsPath: options.settingsPath ?? NGINX_GLOBAL_SETTINGS, detail: error.message };
  }
}

function inspectMaintenance(options: MaintenanceNginxPaths): MaintenanceNginxStatus {
  const paths = maintenancePath(options);
  const { settingsPath, stateDir, geoPath, cloudflareIpsPath, includePath, panelDb } = paths;
  const content = readIfPresent(settingsPath);
  if (content !== null) {
    const files = baselineFiles(stateDir, "global-settings");
    const hasState = hasBaseline(files);
    const baseline = readBaseline(files);
    const hasMarker = content.includes("# clp-addons:maintenance:start") || content.includes("# clp-addons:maintenance:end");
    if (!baseline && hasMarker) {
      return { state: "conflict", settingsPath, detail: "an unverified maintenance marker exists" };
    }
    if (hasState && !baseline) {
      return { state: "upstream-changed", settingsPath, detail: "managed global-settings baseline is missing or invalid" };
    }
    if (baseline) {
      const found = sha256(stripMaintenanceNginx(content));
      if (found !== baseline.hash) {
        return {
          state: "upstream-changed",
          settingsPath,
          detail: `Nginx global settings changed (recorded ${baseline.hash.slice(0, 12)}, current ${found.slice(0, 12)})`,
        };
      }
    }
    try { trustedVhost(settingsPath, statSync(settingsPath).uid); }
    catch (error) { return { state: "validation-failed", settingsPath, detail: errorMessage(error) }; }
    if (!content.includes("# clp-addons:maintenance:start")) {
      return { state: "missing", settingsPath, detail: "maintenance block is not installed" };
    }
    if (!content.includes(NGINX_MAINTENANCE_BLOCK)) {
      return { state: "stale-content", settingsPath, detail: "maintenance block differs from the managed definition" };
    }
  }
  if (readIfPresent(geoPath) !== maintenanceGeoContent(cloudflareRanges(cloudflareIpsPath))) {
    return { state: "stale-content", settingsPath, detail: "maintenance client IP map is missing or outdated" };
  }
  if (panelDb !== null) {
    try {
      const db = openPanelDatabase(panelDb, true);
      try {
        const uncoveredSites = sitesWithoutMaintenance(db, { ...paths, settingsMissing: content === null });
        if (uncoveredSites.length) return {
          state: "uncovered-sites", settingsPath, uncoveredSites,
          detail: uncoveredDetail(uncoveredSites, content === null, settingsPath),
        };
      } finally { db.close(); }
    } catch (error) {
      return { state: "uncovered-sites", settingsPath, detail: `Site maintenance checks could not be verified: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  if (readIfPresent(includePath) !== `${NGINX_MAINTENANCE_BLOCK}\n`) {
    return { state: "stale-content", settingsPath, detail: "maintenance server include is missing or outdated" };
  }
  return { state: "ok", settingsPath };
}

function uncoveredDetail(sites: string[], settingsMissing: boolean, settingsPath: string): string {
  const listed = `${sites.length} sites without the check: ${sites.join(", ")}`;
  return settingsMissing ? `${settingsPath} does not exist, ${listed}` : `Injected, ${listed}`;
}

/**
 * Gives global_settings, a dpkg conffile, back the package text it was recorded
 * from, without a reload, and forgets that record so the next reconcile takes
 * whatever an upgrade installed as the new baseline. A file that differs from
 * the record in other ways is left alone: the operator changed it too.
 */
export function releaseMaintenanceSettings(options: MaintenanceNginxPaths = {}): boolean {
  const { settingsPath, stateDir } = maintenancePath(options);
  const read = readIfPresent(settingsPath);
  if (read === null || !read.includes("# clp-addons:maintenance:start")) return false;
  const files = baselineFiles(stateDir, "global-settings");
  const baseline = readBaseline(files);
  const upstream = stripMaintenanceNginx(read);
  if (!baseline || baseline.hash !== sha256(upstream)) return false;
  const current = trustedVhost(settingsPath, statSync(settingsPath).uid);
  writeFileAtomic(settingsPath, upstream, { mode: current.mode, owner: { uid: current.uid, gid: current.gid }, createParent: true });
  removeBaseline(files);
  return true;
}

type ReconcileOptions = MaintenanceNginxPaths & { enabled?: boolean; reload?: boolean; run?: (command: string, args: string[]) => CommandResult };

export function reconcileNginxMaintenance(options: ReconcileOptions = {}): MaintenanceNginxResult {
  try { return reconcileMaintenance(options); }
  catch (error) {
    if (!(error instanceof NginxReadError)) throw error;
    return { state: "validation-failed", changed: false, settingsPath: options.settingsPath ?? NGINX_GLOBAL_SETTINGS, detail: error.message };
  }
}

function reconcileMaintenance(options: ReconcileOptions): MaintenanceNginxResult {
  const { enabled = true, reload = true, run = runCommand, ...pathOptions } = options;
  const paths = maintenancePath(pathOptions);
  const { settingsPath: selectedPath, stateDir, geoPath, cloudflareIpsPath, includePath, panelDb } = paths;
  const read = readIfPresent(selectedPath);
  const settingsPath = (() => {
    try { return realpathSync(selectedPath); } catch { return selectedPath; }
  })();
  const files = baselineFiles(stateDir, "global-settings");
  const baseline = read === null ? null : readBaseline(files);
  let upstream = "";
  let found = "";
  if (read !== null) {
    const hasState = hasBaseline(files);
    const hasMarker = read.includes("# clp-addons:maintenance:start") || read.includes("# clp-addons:maintenance:end");
    if (!baseline && hasMarker) {
      return { state: "conflict", changed: false, settingsPath: selectedPath, detail: "an unverified maintenance marker exists; no changes were made" };
    }
    if (hasState && !baseline) {
      return { state: "upstream-changed", changed: false, settingsPath: selectedPath, detail: "managed global-settings baseline is missing or invalid; no changes were made" };
    }
    upstream = stripMaintenanceNginx(read);
    found = sha256(upstream);
    if (baseline && baseline.hash !== found) {
      return {
        state: "upstream-changed",
        changed: false,
        settingsPath: selectedPath,
        detail: `Nginx global settings changed; no changes were made (recorded ${baseline.hash.slice(0, 12)}, current ${found.slice(0, 12)})`,
      };
    }
    if (enabled && /(?:location\s+(?:@clp_maintenance|=\s*\/__clp_addons_maintenance)|\$clp_maintenance\b|error_page\s+[^;]*\b418\b)/m.test(upstream)) {
      return { state: "conflict", changed: false, settingsPath: selectedPath, detail: "an unmanaged maintenance variable or location already exists" };
    }
  }
  const oldGeo = readIfPresent(geoPath);
  if (oldGeo !== null && !oldGeo.startsWith(`${MAINTENANCE_GEO_MARKER}\n`)) {
    return { state: "conflict", changed: false, settingsPath: selectedPath, detail: "an unowned maintenance client IP map exists" };
  }
  const oldInclude = readIfPresent(includePath);
  if (oldInclude !== null && !oldInclude.startsWith("# clp-addons:maintenance:start\n")) {
    return { state: "conflict", changed: false, settingsPath: selectedPath, detail: "an unowned maintenance server include exists" };
  }
  if (read !== null && !baseline && (enabled || read.includes("# clp-addons:maintenance:start"))) {
    mkdirSync(stateDir, { recursive: true });
    recordBaseline(files, upstream, found, settingsPath);
  }
  const rendered = enabled
    ? `${upstream}\n${NGINX_MAINTENANCE_BLOCK}\n`
    : upstream;
  const newGeo = enabled ? maintenanceGeoContent(cloudflareRanges(cloudflareIpsPath)) : null;
  try {
    // Removing the check from a box with neither global_settings nor a panel has nothing to undo.
    const db = panelDb === null || (!enabled && read === null && !existsSync(panelDb)) ? null : openPanelDatabase(panelDb);
    try {
      const result = withNginxTransaction(db, { nginx: "nginx", systemctl: "systemctl" }, run, (changes) => {
        if (db) stageMaintenanceVhosts(db, changes, paths, enabled);
        if (read !== null) changes.push(nginxFileChange(settingsPath, rendered, statSync(settingsPath).uid));
        changes.push(
          nginxFileChange(geoPath, newGeo, paths.vhostUid),
          nginxFileChange(includePath, enabled ? `${NGINX_MAINTENANCE_BLOCK}\n` : null, paths.vhostUid),
        );
      }, { reload });
      if (!enabled || read === null) removeBaseline(files);
      if (enabled && read === null && db) {
        const uncoveredSites = sitesWithoutMaintenance(db, { ...paths, settingsMissing: true });
        if (uncoveredSites.length) return {
          state: "uncovered-sites", changed: result.changed, settingsPath: selectedPath, uncoveredSites,
          detail: uncoveredDetail(uncoveredSites, true, selectedPath),
        };
      }
      return { state: enabled ? "ok" : "missing", changed: result.changed, settingsPath: selectedPath };
    } finally { db?.close(); }
  } catch (error) {
    return { state: "validation-failed", changed: false, settingsPath: selectedPath, detail: error instanceof Error ? error.message : String(error) };
  }
}

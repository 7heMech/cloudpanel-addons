// Maintenance Mode's check in Nginx: a marked block in CloudPanel's
// global_settings, the client-address map it reads, and the include each site's
// vhost needs, kept against a record of global_settings as CloudPanel left it.
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "../../lib/atomic-write";
import { runCommand, type CommandResult } from "../../lib/command";
import { errorMessage } from "../../lib/errors";
import {
  type Refusal, NginxReadError, baselineFiles, hasBaseline, readBaseline, readBaselineVersion, readIfPresent,
  rebaselineVerdict, recordBaseline, removeBaseline, sha256, writeBaselineVersion,
} from "../../lib/baseline";
import { createHash } from "node:crypto";
import { conffileMd5, owningPackage, packageBusy, packageVersion } from "../../lib/cloudpanel-version";
import { cloudflareRanges, nginxFileChange, trustedVhost, withNginxTransaction } from "../../lib/nginx-transaction";
import { openPanelDatabase } from "../../lib/panel-db";
import { cloudflareVisitorMaps } from "../../lib/visitor-ip";
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

/**
 * CloudPanel keeps these ranges for its own Cloudflare-only vhost setting. The
 * fallback is the connection peer, even when CloudPanel's broad real_ip
 * settings replaced $remote_addr from a header.
 */
function maintenanceGeoContent(ranges: string[]): string {
  return `${MAINTENANCE_GEO_MARKER}\n${cloudflareVisitorMaps("clp_maintenance", ranges, "$clp_maintenance_peer")}`;
}

interface MaintenanceNginxPaths {
  settingsPath?: string;
  stateDir?: string;
  geoPath?: string;
  cloudflareIpsPath?: string;
  panelDb?: string | null;
  nginxVhostDir?: string;
  includePath?: string;
  vhostUid?: number;
  /**
   * The installed version of the package global_settings belongs to; read
   * from dpkg when left out. A function is asked each time, as dpkg is.
   */
  packageVersion?: string | null | (() => string | null);
  /** The MD5 that package records for global_settings as a conffile; read from dpkg when left out. */
  conffileMd5?: string | null;
  /** Whether dpkg is part-way through changing the file's package; asked of dpkg when left out. */
  packageBusy?: () => boolean;
  /** `repair --rebaseline`: take a changed global_settings even though its package was not upgraded. */
  accept?: boolean;
}

type MaintenanceNginxState =
  | "ok"
  | "missing"
  | "stale-content"
  | "upstream-changed"
  | "panel-updated"
  | "conflict"
  | "validation-failed"
  | "uncovered-sites";

interface MaintenanceNginxStatus {
  state: MaintenanceNginxState;
  settingsPath: string;
  uncoveredSites?: string[];
  detail?: string;
  /** Set with `upstream-changed`: why the changed file is left alone, and the versions that decided it. */
  refusal?: MaintenanceRefusal;
}

export interface MaintenanceRefusal {
  reason: Refusal;
  /** The package global_settings belongs to, such as nginx-common. */
  package: string | null;
  recorded: string | null;
  installed: string | null;
}

interface MaintenanceNginxResult extends MaintenanceNginxStatus {
  changed: boolean;
  /** global_settings was recorded afresh because its package's upgrade replaced it. */
  rebaselined?: { from: string | null; to: string };
}

/** A maintenance variable, location or 418 page of someone else's, which the block would clash with. */
const UNMANAGED_MAINTENANCE_RE = /(?:location\s+(?:@clp_maintenance|=\s*\/__clp_addons_maintenance)|\$clp_maintenance\b|error_page\s+[^;]*\b418\b)/m;
const STRAY_MAINTENANCE_MARKER = /# clp-addons:maintenance:(?:start|end)/;

type SettingsCheck =
  | { kind: "unrecorded" }
  | { kind: "match"; recorded: string | null }
  | { kind: "rebaseline"; recorded: string | null; installed: string }
  | { kind: "refuse"; refusal: MaintenanceRefusal };

/** The package global_settings belongs to, asked of dpkg only when a decision needs it. */
interface SettingsPackage {
  name: () => string | null;
  version: () => string | null;
  /** The MD5 of the file as the package ships it, when it is one of the package's conffiles. */
  md5: () => string | null;
  busy: () => boolean;
}

function settingsPackage(settingsPath: string, options: MaintenanceNginxPaths): SettingsPackage {
  let owner: string | null | undefined;
  const name = () => owner === undefined ? (owner = owningPackage(settingsPath)) : owner;
  return {
    name,
    version: () => {
      const given = options.packageVersion;
      if (typeof given === "function") return given();
      if (given !== undefined) return given;
      const pkg = name();
      return pkg ? packageVersion(pkg) : null;
    },
    md5: () => {
      if (options.conffileMd5 !== undefined) return options.conffileMd5;
      const pkg = name();
      return pkg ? conffileMd5(pkg, settingsPath) : null;
    },
    busy: () => {
      if (options.packageBusy) return options.packageBusy();
      const pkg = name();
      return pkg ? packageBusy(pkg) : false;
    },
  };
}

/**
 * global_settings against its record, by the rule CloudPanel's templates
 * follow, keyed on the version of the package the file belongs to. The block
 * is appended rather than anchored, so the new text fits unless it already
 * holds a maintenance construct of its own.
 *
 * `before` is the version read before the file was: a package that changed
 * between the two reads may have been mid-write. And global_settings is a
 * conffile, which dpkg leaves as the operator edited it through an upgrade
 * that ships the same one, so the new text must also be the package's own.
 */
function checkSettings(
  upstream: string, files: ReturnType<typeof baselineFiles>, enabled: boolean, options: MaintenanceNginxPaths,
  pkg: SettingsPackage, before: string | null,
): SettingsCheck {
  if (!hasBaseline(files)) {
    // Recorded mid-upgrade, a half-written file would be the record, with no
    // version to tell the finished one apart by.
    return before === null && pkg.busy()
      ? { kind: "refuse", refusal: { reason: "busy", package: pkg.name(), recorded: null, installed: null } }
      : { kind: "unrecorded" };
  }
  const baseline = readBaseline(files);
  const recorded = readBaselineVersion(files);
  if (baseline?.hash === sha256(upstream)) return { kind: "match", recorded };
  const after = pkg.version();
  const installed = before === after ? after : null;
  const shipped = pkg.md5();
  const reason = rebaselineVerdict({
    recorded, installed, strayMarker: STRAY_MAINTENANCE_MARKER.test(upstream),
    misfit: enabled && UNMANAGED_MAINTENANCE_RE.test(upstream) ? "conflict" : null, accept: options.accept,
    packageText: shipped === null ? undefined : createHash("md5").update(upstream).digest("hex") === shipped,
  });
  return reason || installed === null
    ? { kind: "refuse", refusal: { reason: reason ?? "busy", package: pkg.name(), recorded, installed } }
    : { kind: "rebaseline", recorded, installed };
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
  const pkg = settingsPackage(settingsPath, options);
  const before = pkg.version();
  const content = readIfPresent(settingsPath);
  if (content !== null) {
    const files = baselineFiles(stateDir, "global-settings");
    const hasMarker = content.includes("# clp-addons:maintenance:start") || content.includes("# clp-addons:maintenance:end");
    if (!hasBaseline(files) && hasMarker) {
      return { state: "conflict", settingsPath, detail: "an unverified maintenance marker exists" };
    }
    const check = checkSettings(stripMaintenanceNginx(content), files, true, options, pkg, before);
    if (check.kind === "refuse") {
      return { state: "upstream-changed", settingsPath, detail: "Nginx global settings changed", refusal: check.refusal };
    }
    if (check.kind === "rebaseline") {
      return { state: "panel-updated", settingsPath, detail: `an Nginx upgrade replaced ${settingsPath}; repair adds the check again` };
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
      return { state: "uncovered-sites", settingsPath, detail: `Site maintenance checks could not be verified: ${errorMessage(error)}` };
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
  const pkg = settingsPackage(selectedPath, pathOptions);
  const before = pkg.version();
  const read = readIfPresent(selectedPath);
  const settingsPath = (() => {
    try { return realpathSync(selectedPath); } catch { return selectedPath; }
  })();
  const files = baselineFiles(stateDir, "global-settings");
  let upstream = "";
  let check: SettingsCheck = { kind: "unrecorded" };
  if (read !== null) {
    const hasMarker = read.includes("# clp-addons:maintenance:start") || read.includes("# clp-addons:maintenance:end");
    if (!hasBaseline(files) && hasMarker) {
      return { state: "conflict", changed: false, settingsPath: selectedPath, detail: "an unverified maintenance marker exists; no changes were made" };
    }
    upstream = stripMaintenanceNginx(read);
    check = checkSettings(upstream, files, enabled, pathOptions, pkg, before);
    if (check.kind === "refuse") {
      return {
        state: "upstream-changed", changed: false, settingsPath: selectedPath,
        detail: "Nginx global settings changed; no changes were made", refusal: check.refusal,
      };
    }
    if (enabled && UNMANAGED_MAINTENANCE_RE.test(upstream)) {
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
  let rebaselined: MaintenanceNginxResult["rebaselined"];
  // Kept only once Nginx took the file it vouches for.
  const record = () => {
    if (check.kind === "match") {
      if (before !== null && before !== check.recorded) writeBaselineVersion(files, before);
    } else if (read !== null && (check.kind === "rebaseline" || enabled || read.includes("# clp-addons:maintenance:start"))) {
      mkdirSync(stateDir, { recursive: true });
      const installed = check.kind === "rebaseline" ? check.installed : before;
      recordBaseline(files, upstream, sha256(upstream), settingsPath, installed);
      if (check.kind === "rebaseline") rebaselined = { from: check.recorded, to: check.installed };
    }
  };
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
      record();
      if (!enabled || read === null) removeBaseline(files);
      if (enabled && read === null && db) {
        const uncoveredSites = sitesWithoutMaintenance(db, { ...paths, settingsMissing: true });
        if (uncoveredSites.length) return {
          state: "uncovered-sites", changed: result.changed, settingsPath: selectedPath, uncoveredSites,
          detail: uncoveredDetail(uncoveredSites, true, selectedPath),
        };
      }
      return { state: enabled ? "ok" : "missing", changed: result.changed, settingsPath: selectedPath, rebaselined };
    } finally { db?.close(); }
  } catch (error) {
    return { state: "validation-failed", changed: false, settingsPath: selectedPath, detail: errorMessage(error) };
  }
}

/**
 * The privileged half of WordPress Tools (stable identifier: wp-tools).
 *
 * This is the only addon that puts its own code inside a site, which is why it is
 * an addon rather than a switch on Panel Tweaks: an operator who wants a
 * filterable site list should not have to install the code that can put a file
 * inside a customer's WordPress. Installing this is the decision, and
 * uninstalling it takes the file back out of every site. Installing CLP Varnish
 * Cache is a separate opt-in; that plugin is WordPress's to manage and stays.
 *
 * Everything it writes or deletes in a site it does as the site's own user,
 * through `runuser`, into paths built from the account's home directory, and
 * WP-CLI runs the same way. Root never writes there itself: the site's user
 * controls every name under its root, so a symlink there would aim a root write
 * or `rm -rf` anywhere on the box. Requests carry a domain, fixed booleans and,
 * for a sign-in, the checked panel user and browser address -- no paths. The one
 * file content is a plugin zip chosen for a new site, which is staged in root's
 * own storage under an id root picks and handed to the site's user on stdin.
 */
import { openPanelDatabase } from "../../cli/panel-db";
import { PANEL_USER_NAME_RE, panelUserOwnsSite, panelUserRole } from "../../lib/panel-users";
import { createHash, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { normalizeMappedIpv4 } from "../../lib/ip-address";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  REPLIED, replyToAction, emitActionOk, errorMessage, failAction, validateDomain, withFileLock, withFileLockSync, type CommandResult,
} from "../../cli/action-common";
import { CLI_BIN, CONFIG_DIR, NGINX_CERTIFICATES_DIR, PANEL_DB, STATE_DIR } from "../../cli/paths";
import {
  jobDir, jobGet, jobIdArgument, jobSet, pruneJobs, readJobLog, validateJobId, watchJobRecord, type startJobUnit,
} from "../../cli/job-store";
import { readUnixAccounts, siteAccountProblem, splitSharedUids, type UnixAccount } from "../../lib/site-accounts";
import {
  DEFAULT_MAINTENANCE_ACTION_PATHS, addBypass, maintenanceBlocks, type MaintenanceActionPaths,
} from "../maintenance/action";
import {
  pruneVarnishState, readVarnishState, saveVarnishState, syncVarnish,
  type VarnishRun, type VarnishSiteRecord, type VarnishOptions, type VarnishSyncResult, type WpVarnishState,
} from "./varnish";
import { DEFAULT_DOMAIN_LINK, readDomainLink, saveDomainLink, type WpDomainLink } from "./domain-link";
import {
  MAINWP_GUARD_FILE, emptyMainwpState, mainwpAction, mainwpNeedsRepair, mainwpOwesSite, mainwpView, readMainwpState, syncMainwp, syncMainwpAll,
  type MainwpResult, type MainwpRun, type MainwpState,
} from "./mainwp";
import {
  JOB_BUDGET_MS, MAX_JOB_DOMAINS, WP_START_TASKS, activeWpJobs, newSiteJobs, policyOf, runWpJob, startWpJob, waitingNewSiteJobs, wpJobView,
  type WpJobs, type WpJobView,
} from "./jobs";
import {
  MAX_NEW_SITE_PLUGINS, UPLOAD_ID_RE, claimUploads, discardUpload, parsePluginList, pruneUploads, releaseUploads, removeUploads,
  runNewSitePlugins, stageUploadPart, type NewSiteLookup, type NewSiteOptions, type NewSitePlugin,
} from "./new-site-plugins";
import { DIRECTORY_SLUG_RE } from "./plugin-zip";
import { DEFAULT_NEW_SITE_ACCESS, readNewSiteAccess, saveNewSiteAccess, type WpNewSiteAccess } from "./new-site-access";
import {
  NEW_SITE_PENDING_MS, certificateStamp, noteSites, readNewSitesState, saveNewSitesState, wordpressInstalled,
  type NewSite, type NewSiteCheck, type NewSitesState,
} from "./new-sites";

import { basicAuthBlocks, basicAuthRewritable, withBasicAuthBypass, type reloadNginx } from "./basic-auth";

export type WpToolsVerb =
  "sites" | "sign-in" | "site-kind" | "remove" | "sync" | "varnish-settings" | "varnish-install" | "varnish-sync" | "domain-link-settings";
export type { WpJobs, WpJobView } from "./jobs";

/** How long a job's runner waits for a pass the timer started to finish. */
const JOB_LOCK_WAIT_SECONDS = 240;
const JOB_RETENTION_DAYS = 7;

/** Where the loader and its one-time secret live inside a WordPress site. */
const MU_PLUGINS = "wp-content/mu-plugins";
const LOADER_FILE = `${MU_PLUGINS}/clp-addons-login.php`;
const SECRET_DIR = `${MU_PLUGINS}/clp-addons`;
const SECRET_FILE = `${SECRET_DIR}/token.php`;

/** The POST field the loader reads the secret from. */
export const WP_LOGIN_FIELD = "clp_addons_login";
/** How long a minted sign-in is good for. One use, and a minute to make it. */
export const WP_LOGIN_TTL_SECONDS = 60;

/**
 * The applications CloudPanel records for a WordPress-family site.
 *
 * For a PHP site the column holds the vhost template it was created from, so
 * this is a list of template names rather than a type. It decides only which
 * rows get a link on CloudPanel's own Sites page, where the answer has to come
 * out of Twig; what the addon will actually sign in to is decided by the files
 * on disk. A WordPress installed under the Generic template is missing from
 * that list and present on this addon's own page, which is the list that is
 * complete.
 */
export const WORDPRESS_APPLICATIONS = ["WordPress", "WooCommerce"];

/** What one WordPress site contributes to the addon's page. */
export interface WpSiteView {
  domain: string;
  user: string;
  /** Whether the sign-in helper is in the site right now. */
  helper: boolean;
  varnishCache: boolean;
  varnishPlugin: VarnishSiteRecord | null;
}

export interface WpLoginResult {
  domain: string;
  url: string;
  /** The single-use secret, only ever returned to the operator's own browser. */
  token: string;
  field: string;
  /** Seconds the token is good for, so the page can say so. */
  expiresIn: number;
}

/**
 * What a sign-in answers instead when the site would show this browser its
 * maintenance page. No secret is minted; `canBypass` says whether this caller
 * may add `ip` to the site's bypasses and ask again. The wording is made here so
 * both pages that sign in say the same thing.
 */
export interface WpMaintenanceReply {
  maintenance: { ip: string; canBypass: boolean; message: string };
}

function maintenanceReply(domain: string, ip: string, admin: boolean): WpMaintenanceReply {
  const blocked = `${domain} is in maintenance mode, so WordPress would only show its maintenance page.`;
  if (!admin) return { maintenance: { ip, canBypass: false, message: `${blocked} An administrator can add your IP to its bypasses.` } };
  if (!ip) return { maintenance: { ip, canBypass: false, message: `${blocked} The panel could not tell your IP, so add a bypass in Maintenance Mode.` } };
  return { maintenance: { ip, canBypass: true, message: `${blocked} Add your IP ${ip} to its bypasses and sign in?` } };
}

export interface WpBasicAuthReply {
  basicAuth: { ip: string; canBypass: boolean; message: string };
}

function basicAuthReply(domain: string, ip: string, admin: boolean, rewritable: () => boolean): WpBasicAuthReply {
  const blocked = `${domain} is protected by CloudPanel basic authentication.`;
  if (!admin) return { basicAuth: { ip, canBypass: false, message: `${blocked} An administrator can allow your IP in Security → Basic Authentication.` } };
  if (!ip) return { basicAuth: { ip, canBypass: false, message: `${blocked} The panel could not tell your IP, so manage its allowlist in Security → Basic Authentication.` } };
  if (!rewritable()) return { basicAuth: { ip, canBypass: false, message: `${blocked} Its Nginx configuration has been customized, so allow your IP ${ip} in Security → Basic Authentication.` } };
  return { basicAuth: { ip, canBypass: true, message: `${blocked} Allow your IP ${ip} for the whole site and everyone sharing that IP, until removed in Security → Basic Authentication? CloudPanel accepts forged X-Real-IP, so anyone who knows an allowed IP can bypass it. Behind Cloudflare, your IP may not match.` } };
}

export interface WpRemoveResult {
  removed: number;
  /** `domain: reason` for each site whose loader could not be deleted. */
  failed: string[];
}

export interface WpToolsActionPaths {
  configFile: string;
  panelDb: string;
  passwd: string;
  lockFile: string;
  runuser: string;
  /** Present while the Maintenance Mode addon is installed. */
  maintenanceConfig: string;
  maintenance: MaintenanceActionPaths;
  nginxVhostDir: string;
  nginx: string;
  systemctl: string;
  vhostUid: number;
  varnishState: string;
  varnishLockFile: string;
  domainLinkState: string;
  /** Whether site managers may choose plugins on the new-site form. */
  newSiteAccessState: string;
  mainwpState: string;
  mainwpLockFile: string;
  jobsDir: string;
  /** Held while a job is recorded, so one policy never gets two. */
  jobsLockFile: string;
  /** The domains last seen and the new sites automation may still owe a check. */
  newSitesState: string;
  newSitesLockFile: string;
  /** Where CloudPanel writes each site's certificate as `<domain>.crt`. */
  certificatesDir: string;
  /** What systemd runs for a job. */
  actionBinary: string;
  /** Plugin zips waiting for the new-site form they were chosen on. */
  uploadsDir: string;
  /** Held while an upload is staged or a new site's plan is recorded. */
  pluginsLockFile: string;
}

export interface WpToolsActionOptions extends VarnishOptions, Pick<NewSiteOptions, "fetch" | "waits" | "sleep"> {
  paths?: Partial<WpToolsActionPaths>;
  emitReply?: boolean;
  processUid?: number;
  now?: () => Date;
  run?: (command: string, args: string[]) => CommandResult;
  reloadNginx?: typeof reloadNginx;
  /** Test-only; production always guards against the panel's own hostname. */
  domainValidator?: (value: string) => string;
  /** Test-only; production hands a job to systemd. */
  startJob?: typeof startJobUnit;
  /** Test-only; production reads an upload part from stdin. */
  input?: string;
  /** Test-only; production reads the file's owner from disk. */
  fileOwner?: (path: string) => number;
}

export const DEFAULT_WP_TOOLS_PATHS: WpToolsActionPaths = {
  configFile: `${CONFIG_DIR}/wp-tools.conf`,
  panelDb: PANEL_DB,
  passwd: "/etc/passwd",
  lockFile: "/run/lock/clp-addons/wp-tools.lock",
  runuser: "/usr/sbin/runuser",
  maintenanceConfig: `${CONFIG_DIR}/maintenance.conf`,
  maintenance: DEFAULT_MAINTENANCE_ACTION_PATHS,
  nginxVhostDir: "/etc/nginx/sites-enabled",
  nginx: "nginx",
  systemctl: "systemctl",
  vhostUid: 0,
  varnishState: `${STATE_DIR}/wp-tools/varnish.json`,
  varnishLockFile: "/run/lock/clp-addons/wp-varnish.lock",
  domainLinkState: `${STATE_DIR}/wp-tools/domain-link.json`,
  newSiteAccessState: `${STATE_DIR}/wp-tools/new-site-access.json`,
  mainwpState: `${STATE_DIR}/wp-tools/mainwp.json`,
  mainwpLockFile: "/run/lock/clp-addons/wp-mainwp.lock",
  jobsDir: `${STATE_DIR}/wp-tools/jobs`,
  jobsLockFile: "/run/lock/clp-addons/wp-jobs.lock",
  newSitesState: `${STATE_DIR}/wp-tools/new-sites.json`,
  newSitesLockFile: "/run/lock/clp-addons/wp-new-sites.lock",
  certificatesDir: NGINX_CERTIFICATES_DIR,
  actionBinary: CLI_BIN,
  uploadsDir: `${STATE_DIR}/wp-tools/uploads`,
  pluginsLockFile: "/run/lock/clp-addons/wp-plugins.lock",
};

function pathsFor(options: WpToolsActionOptions): WpToolsActionPaths {
  return { ...DEFAULT_WP_TOOLS_PATHS, ...options.paths };
}

// --- panel database -------------------------------------------------------

interface PanelSiteRow {
  domain_name: string;
  user: string;
  application: string | null;
  root_directory: string | null;
  type: string;
  varnish_cache: number | string | null;
  php_version: string | null;
  created_at: string | null;
}


/**
 * Whether a panel user may sign in to this site's WordPress.
 *
 * Asked here, as root, rather than in the manager: the manager cannot open
 * CloudPanel's database, and the answer has to be the same one the panel's own
 * Sites page is built from.
 */
function mayManageSite(paths: WpToolsActionPaths, userName: string, domain: string): boolean {
  const db = openPanelDatabase(paths.panelDb, true, 1000);
  try {
    return panelUserOwnsSite(db, userName, domain);
  } catch (error) {
    failAction(`CloudPanel could not say whose site that is: ${errorMessage(error)}`);
  } finally {
    db.close();
  }
}

/**
 * Holds a site manager's request for plugins on a new site to what an
 * administrator allowed: the switch on, and the account an active site
 * manager in CloudPanel's own database now, whatever its session said.
 * Administrators' requests carry no name and are not asked.
 */
function siteManagerMayChoose(paths: WpToolsActionPaths, userName: string): void {
  let access: WpNewSiteAccess;
  try { access = readNewSiteAccess(paths.newSiteAccessState); }
  catch { failAction("the new-site plugins setting cannot be read; an administrator can save it again"); }
  if (!access.siteManagers) failAction("an administrator has not let site managers choose plugins for new sites");
  const db = openPanelDatabase(paths.panelDb, true, 1000);
  let role: string | null;
  try { role = panelUserRole(db, userName); }
  catch (error) { failAction(`CloudPanel could not say who you are: ${errorMessage(error)}`); }
  finally { db.close(); }
  if (role !== "ROLE_SITE_MANAGER") failAction("only administrators and site managers choose plugins for new sites");
}

/** The newest entry in CloudPanel's event log, which a site manager's job reads past; -1 without a log. */
function latestEventId(paths: WpToolsActionPaths): number {
  const db = openPanelDatabase(paths.panelDb, true, 1000);
  try {
    const table = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'event';").get();
    if (!table) return -1;
    return Number(db.query<{ id: number | null }, []>("SELECT MAX(id) AS id FROM event;").get()?.id ?? 0);
  } catch (error) {
    failAction(`CloudPanel's event log could not be read: ${errorMessage(error)}`);
  } finally {
    db.close();
  }
}

function asUserArgument(value: string | undefined): string {
  if (value === undefined) return "";
  if (!PANEL_USER_NAME_RE.test(value)) failAction("that is not a valid panel user name");
  return value;
}

function panelSites(paths: WpToolsActionPaths): PanelSiteRow[] {
  const db = openPanelDatabase(paths.panelDb, true, 1000);
  try {
    // Older panels have no Varnish column. Their sign-in behavior is unchanged,
    // and they contribute no eligible sites to plugin installation.
    const columns = db.query<{ name: string }, []>("PRAGMA table_info(site);").all();
    const varnish = columns.some((column) => column.name === "varnish_cache") ? "varnish_cache" : "0 AS varnish_cache";
    const phpSettings = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'php_settings';").get();
    const php = phpSettings ? "(SELECT p.php_version FROM php_settings p WHERE p.site_id = site.id LIMIT 1)" : "NULL";
    const created = columns.some((column) => column.name === "created_at") ? "created_at" : "NULL AS created_at";
    return db.query<PanelSiteRow, []>(
      `SELECT domain_name, user, application, root_directory, type, ${varnish}, ${php} AS php_version, ${created} FROM site ORDER BY domain_name;`,
    ).all();
  } catch (error) {
    failAction(`CloudPanel site list could not be read: ${errorMessage(error)}`);
  } finally {
    db.close();
  }
}

// --- the accounts sites run as -------------------------------------------

interface SiteAccount {
  name: string;
  home: string;
}

function readAccounts(passwd: string): Map<string, UnixAccount> {
  try {
    return readUnixAccounts(passwd);
  } catch (error) {
    failAction(`the account database could not be read: ${errorMessage(error)}`);
  }
}

function siteRoot(account: SiteAccount, row: PanelSiteRow): string {
  // CloudPanel stores the root as a name under the account's htdocs, and falls
  // back to the domain when the column is empty.
  const directory = (row.root_directory ?? "").trim() || row.domain_name;
  if (directory.includes("/") || directory.includes("..")) {
    failAction(`the site root recorded for ${row.domain_name} is not a plain directory name`);
  }
  return join(account.home, "htdocs", directory);
}

/**
 * Whether a site root holds a WordPress this addon can sign in to.
 *
 * The files decide, not the application CloudPanel recorded: a WordPress
 * installed under the Generic template is still a WordPress, and a site whose
 * template says WordPress but whose files have been replaced is not.
 */
function isWordPress(root: string): boolean {
  return existsSync(join(root, "wp-includes")) && existsSync(join(root, "wp-content"));
}

/**
 * Every site, with the root the addon would act on, skipping what it cannot:
 * an account that is missing, belongs to the box, or shares its uid with
 * another site, the same refusals SMTP and Terminal make.
 */
function resolvedSites(paths: WpToolsActionPaths): { row: PanelSiteRow; account: SiteAccount; root: string; uid: number }[] {
  const accounts = readAccounts(paths.passwd);
  const rows = panelSites(paths).flatMap((row) => {
    const account = accounts.get(row.user);
    return account ? [{ row, ...account }] : [];
  });
  const resolved: { row: PanelSiteRow; account: SiteAccount; root: string; uid: number }[] = [];
  for (const { row, uid, gid, home } of splitSharedUids(rows).unique) {
    if (siteAccountProblem({ user: row.user, uid, gid }) || !home.startsWith("/")) continue;
    const account = { name: row.user, home };
    try {
      resolved.push({ row, account, root: siteRoot(account, row), uid });
    } catch {
      // A site whose recorded root is not a plain directory name is left alone.
    }
  }
  return resolved;
}

/** Shared discovery and eligibility for the page and plugin installation. */
function resolvedWordPressSites(paths: WpToolsActionPaths) {
  return resolvedSites(paths)
    .filter((site) => isWordPress(site.root))
    .map((site) => ({
      ...site,
      varnishCache: site.row.type === "php" && Boolean(Number(site.row.varnish_cache)),
    }));
}

function wordpressSites(paths: WpToolsActionPaths, state: WpVarnishState): WpSiteView[] {
  return resolvedWordPressSites(paths)
    .map((site) => ({
      domain: site.row.domain_name,
      user: site.row.user,
      helper: existsSync(join(site.root, LOADER_FILE)),
      varnishCache: site.varnishCache,
      varnishPlugin: state.sites[site.row.domain_name] ?? null,
    }));
}

/** The sites and the panel's domains a Varnish pass works from. */
function varnishRun(
  paths: WpToolsActionPaths,
  request: { domain?: string; targets?: string[]; dueOnly?: boolean; deadline?: number } = {},
): VarnishRun {
  return {
    statePath: paths.varnishState,
    runuser: paths.runuser,
    sites: resolvedWordPressSites(paths).map((site) => ({
      domain: site.row.domain_name, user: site.row.user, root: site.root, home: site.account.home,
      phpVersion: String(site.row.php_version ?? ""),
      eligible: site.varnishCache,
    })),
    domains: new Set(panelSites(paths).map((row) => row.domain_name)),
    ...request,
  };
}

/**
 * The page's pass, and the queued timer's with `dueOnly`, which checks only
 * sites automation can still act on and does not wait for a page's pass.
 */
export async function reconcileWpVarnish(
  options: WpToolsActionOptions = {},
  request: { dueOnly?: boolean } = {},
): Promise<VarnishSyncResult> {
  const paths = pathsFor(options);
  const wait = request.dueOnly ? 1 : 15;
  return withFileLock(paths.varnishLockFile, wait, "a WordPress Varnish change is still running", async () => {
    if (!existsSync(paths.configFile) || !readVarnishState(paths.varnishState).enabled) {
      return { installed: 0, checked: 0, pending: 0, failed: [] };
    }
    return syncVarnish(varnishRun(paths, request), options);
  });
}

/** MainWP works from the same sites; Varnish eligibility does not apply. */
function mainwpRun(paths: WpToolsActionPaths, request: { dueOnly?: boolean; deadline?: number; targets?: string[] } = {}): MainwpRun {
  const { targets, ...pass } = request;
  return { ...varnishRun(paths, pass), statePath: paths.mainwpState, ...(targets ? { targets } : {}) };
}

/** Whether the timer has anything to queue: automation is on, or MainWP still owes a site work. */
export function wpPoliciesActive(options: WpToolsActionOptions = {}): boolean {
  const paths = pathsFor(options);
  // Each on its own: a damaged Varnish record must not keep MainWP's repair from being queued.
  const safely = (read: () => boolean): boolean => {
    try { return read(); } catch { return false; }
  };
  return safely(() => readVarnishState(paths.varnishState).enabled)
    || safely(() => mainwpNeedsRepair(readMainwpState(paths.mainwpState)));
}

/** The queued timer's MainWP pass does not wait for a page's pass. */
export async function reconcileWpMainwp(options: WpToolsActionOptions = {}): Promise<MainwpResult> {
  const paths = pathsFor(options);
  return withFileLock(paths.mainwpLockFile, 1, "a MainWP change is still running", async () => {
    if (!existsSync(paths.configFile) || !mainwpNeedsRepair(readMainwpState(paths.mainwpState))) {
      return { checked: 0, installed: 0, connected: 0, removed: 0, pending: 0, failed: [] };
    }
    return syncMainwp(mainwpRun(paths, { dueOnly: true }), options);
  });
}

/** Run both policies even when one fails; systemd bounds the whole pass. */
async function syncPolicies(options: WpToolsActionOptions): Promise<unknown> {
  const failed: string[] = [];
  let varnish: VarnishSyncResult | undefined;
  let mainwp: MainwpResult | undefined;
  try {
    varnish = await reconcileWpVarnish(options, { dueOnly: true });
    failed.push(...varnish.failed);
  } catch (error) {
    failed.push(errorMessage(error));
  }
  try {
    mainwp = await reconcileWpMainwp(options);
    failed.push(...mainwp.failed);
  } catch (error) {
    failed.push(errorMessage(error));
  }
  if (failed.length) failAction(failed.join("; "));
  return { varnish, mainwp };
}

// --- new sites ------------------------------------------------------------

/**
 * What woke the new-site check: the sites changing (`sites`), the new-site
 * watcher waking again while a site waits for its WordPress (`wake`), a
 * certificate written (`certificates`), a WordPress Tools job ending (`job`),
 * or repair making sure there is a baseline (`seed`).
 */
export type WpNewSiteEvent = "sites" | "wake" | "certificates" | "job" | "seed";

export interface WpNewSitesResult {
  /** Domains the panel did not have last time. */
  added: string[];
  /** The checks queued now, with the sites each covers. */
  queued: Partial<Record<NewSiteCheck, string[]>>;
  /** New sites automation may still owe a check. */
  pending: string[];
  /** Pending sites whose WordPress CloudPanel is still installing. */
  waiting: string[];
  failed: string[];
}

/**
 * Queues the checks that pending sites are newly ready for, and drops the
 * sites automation owes nothing. A check is ready once CloudPanel has finished
 * installing the site's WordPress; MainWP's is ready again whenever the site's
 * certificate changes, since connecting needs the HTTPS the Dashboard will see.
 * A check already queued at the same readiness is not queued again, so a wake
 * that changes nothing for a site does nothing, and one that finds the
 * policy's job running leaves the site for that job's end.
 */
async function queueReadyChecks(paths: WpToolsActionPaths, state: NewSitesState, options: WpToolsActionOptions, result: WpNewSitesResult): Promise<void> {
  const safely = <T>(read: () => T): T | null => {
    try { return read(); } catch { return null; }
  };
  const varnish = safely(() => readVarnishState(paths.varnishState));
  const mainwp: MainwpState | null = safely(() => readMainwpState(paths.mainwpState));
  if (!varnish?.enabled && !mainwp?.enabled) {
    state.pending = [];
    return;
  }
  const sites = new Map(resolvedSites(paths).map((site) => [site.row.domain_name, site]));
  const wanted = new Map<NewSiteCheck, { site: NewSite; ready: string }[]>();
  state.pending = state.pending.filter((pending) => {
    const site = sites.get(pending.domain);
    // An account not readable yet may still come.
    if (!site) {
      result.waiting.push(pending.domain);
      return true;
    }
    if (site.row.type !== "php" || site.row.application?.toLowerCase() !== "wordpress") return false;
    if (!pending.wordpress) {
      if (!wordpressInstalled(site.root, site.uid, options.fileOwner)) {
        result.waiting.push(pending.domain);
        return true;
      }
      pending.wordpress = true;
    }
    // CloudPanel removes a site's vhost and certificate before its row: without them it is being deleted.
    const certificate = certificateStamp(paths.certificatesDir, pending.domain);
    if (certificate === "none" || !existsSync(join(paths.nginxVhostDir, `${pending.domain}.conf`))) return true;
    const owed: NewSiteCheck[] = [];
    if (varnish?.enabled && Boolean(Number(site.row.varnish_cache)) && !varnish.sites[pending.domain]?.seen) owed.push("varnish-check");
    if (mainwp && mainwpOwesSite(mainwp, pending.domain)) owed.push("mainwp-check");
    if (!owed.length) return false;
    for (const task of owed) {
      const ready = task === "mainwp-check" ? certificate : "wordpress";
      if (pending.tried[task] !== ready) wanted.set(task, [...wanted.get(task) ?? [], { site: pending, ready }]);
    }
    return true;
  });
  if (!wanted.size) return;
  try {
    await withFileLock(paths.jobsLockFile, 5, "another WordPress Tools job is being started", async () => {
      const running = activeWpJobs(paths.jobsDir);
      for (const [task, ready] of wanted) {
        // Its end checks the pending sites again.
        if (running[task === "varnish-check" ? "varnish" : "mainwp"]) continue;
        const domains = ready.map(({ site }) => site.domain);
        try {
          startWpJob({ jobsDir: paths.jobsDir, task, domains, actionBinary: paths.actionBinary, start: options.startJob });
          for (const { site, ready: at } of ready) site.tried[task] = at;
          result.queued[task] = domains;
        } catch (error) {
          result.failed.push(errorMessage(error));
        }
      }
    });
  } catch (error) {
    result.failed.push(errorMessage(error));
  }
}

/**
 * Checks new sites as they become ready rather than at the next 15-minute
 * pass. When the panel's sites change, the domains it did not have before are
 * added to the pending list; every wake then re-checks that list and queues
 * the existing per-site checks as background jobs for the sites now ready.
 * Nothing here runs WordPress, so no caller is held up. When nothing waits on
 * it, a wake costs one read of the state file.
 */
export async function reconcileWpNewSites(options: WpToolsActionOptions = {}, event: WpNewSiteEvent = "sites"): Promise<WpNewSitesResult> {
  const paths = pathsFor(options);
  const result: WpNewSitesResult = { added: [], queued: {}, pending: [], waiting: [], failed: [] };
  if (event !== "sites" && event !== "seed") {
    const pending = readNewSitesState(paths.newSitesState)?.pending ?? [];
    // The watcher's wakes concern only sites still being installed; the others, any site still pending.
    if (!(event === "wake" ? pending.some((site) => !site.wordpress) : pending.length)) return result;
  }
  return withFileLock(paths.newSitesLockFile, 15, "new WordPress sites are still being checked", async () => {
    if (!existsSync(paths.configFile)) return result;
    const state = readNewSitesState(paths.newSitesState);
    if (event === "seed" && state) return result;
    const domains = panelSites(paths).map((row) => row.domain_name);
    // A panel that lists no site at all is far likelier a bad read than every site deleted.
    if (!domains.length) return result;
    if (!state) {
      // The first look only learns what is there; the sites after it are new.
      saveNewSitesState(paths.newSitesState, { known: domains, pending: [] });
      return result;
    }
    const now = (options.now?.() ?? new Date()).getTime();
    const before = JSON.stringify(state);
    result.added = noteSites(state, domains, now);
    state.pending = state.pending.filter((site) => now - site.since < NEW_SITE_PENDING_MS);
    if (state.pending.length) await queueReadyChecks(paths, state, options, result);
    if (JSON.stringify(state) !== before) saveNewSitesState(paths.newSitesState, state);
    result.pending = state.pending.map((site) => site.domain);
    return result;
  });
}

// --- the must-use plugin --------------------------------------------------

/**
 * Must-use rather than a normal plugin because it has to be there when the
 * request arrives and must not be something a site owner can deactivate by
 * accident, and because WordPress loads it before the plugins that would
 * otherwise redirect an anonymous request away.
 *
 * It is inert on every request but the one. Without a secret file on disk it
 * returns immediately, and the secret file only exists between an operator
 * pressing the button and the browser arriving -- at most a minute, and it is
 * removed before it is even checked, so a second attempt with the same value
 * has nothing to compare against.
 *
 * The secret lives in a subdirectory: WordPress auto-loads every PHP file
 * directly inside mu-plugins, and a data file that is also a plugin would be
 * executed on every request. It is a `.php` file rather than plain data so that
 * a request for it over HTTP runs it and prints nothing, instead of serving the
 * hash to whoever asked.
 */
const LOADER_PHP = `<?php
/*
 * Plugin Name: CloudPanel Addons sign-in
 * Description: Accepts one single-use administrator sign-in minted by CloudPanel. Installed and removed by the WordPress Tools addon.
 */
add_action('init', function () {
    if (empty($_POST['${WP_LOGIN_FIELD}']) || !is_string($_POST['${WP_LOGIN_FIELD}'])) {
        return;
    }
    $file = __DIR__ . '/clp-addons/token.php';
    if (!is_readable($file)) {
        return;
    }
    $secret = include $file;
    // Removed before it is checked, so a failed attempt spends it too.
    @unlink($file);
    if (!is_array($secret) || empty($secret['hash']) || empty($secret['expires'])) {
        return;
    }
    if (time() > (int) $secret['expires']) {
        return;
    }
    $given = hash('sha256', (string) $_POST['${WP_LOGIN_FIELD}']);
    if (!hash_equals((string) $secret['hash'], $given)) {
        return;
    }
    $administrators = get_users(array(
        'role' => 'administrator',
        'number' => 1,
        'orderby' => 'ID',
        'order' => 'ASC',
        'fields' => 'ID',
    ));
    if (empty($administrators)) {
        return;
    }
    $user = (int) $administrators[0];
    wp_set_current_user($user);
    wp_set_auth_cookie($user, false);
    wp_safe_redirect(admin_url());
    exit;
}, 1);
`;

/**
 * Creates the secret's directory `$1`, writes the loader `$4` to `$2` and the
 * secret from stdin to `$3`, in one `runuser` call. A loader already holding
 * exactly that is left alone, so its mtime holds and nothing reindexes it.
 */
const INSTALL_SCRIPT = `set -eu
umask 022
mkdir -p -- "$1"
trap 'rm -f "\${t:-}"' EXIT
t=$(mktemp "$2.XXXXXX")
printf %s "$4" >"$t"
chmod 644 "$t"
if cmp -s "$t" "$2"; then rm -f "$t"; else mv -f "$t" "$2"; fi
t=$(mktemp "$3.XXXXXX")
cat >"$t"
mv -f "$t" "$3"`;

/** Only `PATH`: whatever else root's environment holds is not the site's to read. */
const SITE_ENV = { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" };

function runAsSite(paths: WpToolsActionPaths, account: SiteAccount, command: string[], input?: string, timeoutMs = 30_000): void {
  const result = Bun.spawnSync([paths.runuser, "-u", account.name, "--", ...command], {
    cwd: "/",
    stdin: input === undefined ? "ignore" : new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
    env: SITE_ENV,
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  if (!result.success) {
    const detail = result.stderr.toString().trim() || `exit ${result.exitCode}`;
    throw new Error(`${command[0]} as ${account.name} failed: ${detail}`);
  }
}

type ResolvedSite = ReturnType<typeof resolvedSites>[number];

function wordpressSite(paths: WpToolsActionPaths, domain: string): ResolvedSite {
  const site = resolvedSites(paths).find((candidate) => candidate.row.domain_name === domain);
  if (!site) failAction(`CloudPanel has no site called ${domain} with an account this addon can act as`);
  if (!isWordPress(site.root)) failAction(`${domain} does not look like a WordPress installation`);
  return site;
}

function mintWpLogin(
  paths: WpToolsActionPaths,
  site: ResolvedSite,
  options: WpToolsActionOptions,
): WpLoginResult {
  const domain = site.row.domain_name;

  const token = randomBytes(32).toString("hex");
  const hash = createHash("sha256").update(token).digest("hex");
  const expires = Math.floor((options.now?.() ?? new Date()).getTime() / 1000) + WP_LOGIN_TTL_SECONDS;
  try {
    runAsSite(
      paths,
      site.account,
      [
        "/bin/sh", "-c", INSTALL_SCRIPT, "sh",
        join(site.root, SECRET_DIR), join(site.root, LOADER_FILE), join(site.root, SECRET_FILE), LOADER_PHP,
      ],
      `<?php return array('hash' => '${hash}', 'expires' => ${expires});\n`,
      10_000,
    );
  } catch (error) {
    failAction(`the sign-in could not be written into ${domain}: ${errorMessage(error)}`);
  }

  return {
    domain,
    url: `https://${domain}/wp-login.php`,
    token,
    field: WP_LOGIN_FIELD,
    expiresIn: WP_LOGIN_TTL_SECONDS,
  };
}

/**
 * Take the sign-in back out of every site that has it.
 *
 * Disabling or uninstalling the addon runs this: leaving a loader behind in
 * somebody else's site because the addon went away would make it something an
 * operator cannot fully withdraw.
 */
export function removeWpLogin(paths: WpToolsActionPaths = DEFAULT_WP_TOOLS_PATHS): WpRemoveResult {
  let removed = 0;
  const failed: string[] = [];
  for (const site of resolvedSites(paths)) {
    const loader = join(site.root, LOADER_FILE);
    if (!existsSync(loader)) continue;
    // A site that cannot be cleaned must not stop the sites after it.
    try {
      runAsSite(paths, site.account, ["rm", "-rf", "--", loader, join(site.root, SECRET_DIR)]);
      removed++;
    } catch (error) {
      failed.push(`${site.row.domain_name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { removed, failed };
}

/**
 * Take the MainWP guard out of every site that has it. Withdrawing the addon
 * runs this: nothing would enforce the connection any more, and a Child no one
 * can deactivate or see would be left behind.
 */
export function removeMainwpGuards(paths: WpToolsActionPaths = DEFAULT_WP_TOOLS_PATHS): WpRemoveResult {
  let removed = 0;
  const failed: string[] = [];
  for (const site of resolvedSites(paths)) {
    const guard = join(site.root, MAINWP_GUARD_FILE);
    if (!existsSync(guard)) continue;
    try {
      runAsSite(paths, site.account, ["rm", "-f", "--", guard]);
      removed++;
    } catch (error) {
      failed.push(`${site.row.domain_name}: ${errorMessage(error)}`);
    }
  }
  return { removed, failed };
}

// --- request parsing ------------------------------------------------------

interface ParsedAction {
  verb: WpToolsVerb;
  domain: string;
  /** The panel user the request is on behalf of, when it is not an admin's. */
  asUser: string;
  /** The browser's address as the panel saw it; empty when it could not tell. */
  clientIp: string;
  /** Add `clientIp` to the site's maintenance bypasses before signing in. */
  addBypass: boolean;
  allowBasicAuth: boolean;
  enabled?: boolean;
}

function parseAction(argv: string[], options: WpToolsActionOptions): ParsedAction {
  const [rawVerb, ...rest] = argv;
  const verbs: WpToolsVerb[] = [
    "sites", "sign-in", "site-kind", "remove", "sync", "varnish-settings", "varnish-install", "varnish-sync", "domain-link-settings",
  ];
  const verb = verbs.find((known) => known === rawVerb);
  if (!verb) failAction(`unknown WordPress Tools verb '${rawVerb ?? ""}'`);

  let domain = "";
  let asUser = "";
  let clientIp = "";
  let addBypass = false;
  let allowBasicAuth = false;
  let enabled: boolean | undefined;
  const seen = new Set<string>();
  for (const argument of rest) {
    const key = argument.split("=")[0]!;
    if (seen.has(key)) failAction(`duplicate argument '${key}'`);
    seen.add(key);
    if (argument.startsWith("--client-ip=")) {
      clientIp = argument.slice("--client-ip=".length);
      if (!isIP(clientIp)) failAction("that is not an IP address");
      clientIp = normalizeMappedIpv4(clientIp);
      continue;
    }
    if (argument === "--allow-basic-auth") {
      allowBasicAuth = true;
      continue;
    }
    if (argument === "--add-bypass") {
      addBypass = true;
      continue;
    }
    if (argument.startsWith("--domain=")) {
      domain = argument.slice("--domain=".length);
      continue;
    }
    if (argument.startsWith("--as-user=")) {
      asUser = argument.slice("--as-user=".length);
      continue;
    }
    if (/^--enabled=(true|false)$/.test(argument)) { enabled = argument.endsWith("=true"); continue; }
    failAction(`unexpected argument '${argument}'`);
  }
  if (verb === "site-kind" && (clientIp || addBypass || allowBasicAuth)) failAction("'site-kind' takes no --client-ip, --add-bypass or --allow-basic-auth");
  if (verb !== "sign-in" && verb !== "site-kind" && (asUser || clientIp || addBypass || allowBasicAuth)) {
    failAction(`'${verb}' takes no --as-user, --client-ip, --add-bypass or --allow-basic-auth`);
  }
  // Only an administrator may lift either Nginx gate for their request address.
  if ((addBypass || allowBasicAuth) && (asUser || !clientIp)) failAction("only an administrator's sign-in can add its address as a bypass");
  if (asUser && !PANEL_USER_NAME_RE.test(asUser)) failAction("that is not a valid panel user name");
  if (verb === "varnish-settings" || verb === "domain-link-settings" ? enabled === undefined : enabled !== undefined) failAction(`'${verb}' has invalid --enabled`);
  if (verb === "sign-in" || verb === "site-kind" || verb === "varnish-install") {
    // The panel's own hostname is refused here as it is everywhere else: the
    // panel is not a site, and nothing of ours writes into it.
    domain = (options.domainValidator ?? ((value: string) => validateDomain(value)))(domain);
  } else if (domain) {
    failAction(`'${verb}' takes no --domain`);
  }
  return { verb, domain, asUser, clientIp, addBypass, allowBasicAuth, enabled };
}

// --- background jobs ------------------------------------------------------

const JOB_CONFIRMATION: Partial<Record<(typeof WP_START_TASKS)[number], string>> = { "mainwp-connect": "connect", "mainwp-cleanup": "mainwp" };

/** `start --task=<task> [--domains=a,b] [--confirm=...]`, validated before anything is recorded. */
function parseJobStart(rest: string[], options: WpToolsActionOptions): { task: (typeof WP_START_TASKS)[number]; domains: string[] } {
  const fields: Record<string, string> = {};
  for (const argument of rest) {
    const match = /^--(task|domains|confirm)=(.*)$/.exec(argument);
    if (!match || fields[match[1]!] !== undefined) failAction(`unexpected argument '${argument}'`);
    fields[match[1]!] = match[2]!;
  }
  const task = WP_START_TASKS.find((known) => known === fields.task);
  if (!task) failAction("choose a job with --task");
  const validate = options.domainValidator ?? ((value: string) => validateDomain(value));
  const domains = fields.domains === undefined ? [] : [...new Set(fields.domains.split(",").map((domain) => validate(domain)))];
  // A check covers every site, or only the ones given: a new site's.
  const wanted = task === "varnish-install" ? "one" : task === "mainwp-connect" ? "some" : task.endsWith("-check") ? "any" : "none";
  if (wanted === "one" ? domains.length !== 1 : wanted === "some" ? domains.length === 0
    : wanted === "any" ? fields.domains !== undefined && domains.length === 0 : fields.domains !== undefined) {
    failAction(wanted === "none" ? `'${task}' takes no --domains` : wanted === "one" ? `'${task}' takes one domain` : `'${task}' needs --domains`);
  }
  if (domains.length > MAX_JOB_DOMAINS) failAction(`a job takes at most ${MAX_JOB_DOMAINS} sites`);
  const confirmation = JOB_CONFIRMATION[task];
  if (fields.confirm !== confirmation) {
    failAction(confirmation ? `confirm '${task}' with --confirm=${confirmation}` : `'${task}' takes no --confirm`);
  }
  return { task, domains };
}

async function startJob(paths: WpToolsActionPaths, rest: string[], options: WpToolsActionOptions): Promise<{ job: WpJobView }> {
  const { task, domains } = parseJobStart(rest, options);
  if (!existsSync(paths.configFile)) failAction("WordPress Tools must be enabled first");
  if (policyOf(task) === "mainwp" && task !== "mainwp-cleanup" && readMainwpState(paths.mainwpState).cleanup) {
    failAction("finish MainWP cleanup first");
  }
  return withFileLock(paths.jobsLockFile, 15, "another WordPress Tools job is being started", async () => ({
    job: startWpJob({ jobsDir: paths.jobsDir, task, domains, actionBinary: paths.actionBinary, start: options.startJob }),
  }));
}

// --- plugins for a new site ----------------------------------------------

/** The new site as CloudPanel has it so far, or null before it exists or while its database is busy. */
function newSiteLookup(paths: WpToolsActionPaths, domain: string, eventsAfter: number): NewSiteLookup | null {
  try {
    const row = panelSites(paths).find((candidate) => candidate.domain_name.toLowerCase() === domain);
    if (!row) return null;
    const site = resolvedSites(paths).find((candidate) => candidate.row.domain_name === row.domain_name);
    return {
      createdAt: String(row.created_at ?? ""),
      site: site ? {
        domain: row.domain_name, user: row.user, root: site.root, home: site.account.home, phpVersion: String(row.php_version ?? ""),
      } : null,
      creator: wordpressCreator(paths, domain, eventsAfter),
    };
  } catch {
    return null;
  }
}

/**
 * Who CloudPanel's event log says created this WordPress site after the entry
 * `eventsAfter`, the newest when the choice was saved; null when it records no
 * such creation yet. CloudPanel keeps no creator on the site itself; the log
 * is what its Events page shows, and its ids are AUTOINCREMENT, so a later
 * entry always has a greater one where whole-second times could not tell.
 */
function wordpressCreator(paths: WpToolsActionPaths, domain: string, eventsAfter: number): string | null {
  if (!Number.isSafeInteger(eventsAfter) || eventsAfter < 0) return null;
  const db = openPanelDatabase(paths.panelDb, true, 1000);
  try {
    const table = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'event';").get();
    if (!table) return null;
    const rows = db.query<{ user_name: string; event_data: string | null }, [number]>(
      "SELECT user_name, event_data FROM event WHERE event_name = 'SITE_WORDPRESS_CREATE' AND id > ? ORDER BY id DESC;",
    ).all(eventsAfter);
    for (const row of rows) {
      let site: unknown;
      try { site = (JSON.parse(row.event_data ?? "") as { site?: unknown }).site; } catch { continue; }
      if (typeof site === "string" && site.toLowerCase() === domain) return row.user_name;
    }
    return null;
  } finally {
    db.close();
  }
}

/** `plugin-upload [--upload=<id>] --part=<n> [--last]`, one base64 part on stdin. */
async function uploadPart(paths: WpToolsActionPaths, rest: string[], input: string): Promise<unknown> {
  let id: string | undefined;
  let part = -1;
  let last = false;
  for (const argument of rest) {
    const upload = /^--upload=(.*)$/.exec(argument);
    const index = /^--part=(\d{1,3})$/.exec(argument);
    if (upload && id === undefined && UPLOAD_ID_RE.test(upload[1]!)) id = upload[1]!;
    else if (index && part < 0) part = Number(index[1]);
    else if (argument === "--last" && !last) last = true;
    else failAction(`unexpected argument '${argument}'`);
  }
  if (part < 0) failAction("an upload part needs --part");
  if (!existsSync(paths.configFile)) failAction("WordPress Tools must be enabled before uploading a plugin");
  return withFileLock(paths.pluginsLockFile, 15, "another plugin upload is being saved", async () => {
    try {
      return stageUploadPart(paths.uploadsDir, { id, part, last }, input);
    } catch (error) {
      failAction(errorMessage(error));
    }
  });
}

function discard(paths: WpToolsActionPaths, rest: string[]): unknown {
  const id = rest.length === 1 ? /^--upload=([a-f0-9]{32})$/.exec(rest[0]!)?.[1] : undefined;
  if (!id) failAction("'plugin-discard' takes exactly --upload=<id>");
  return { discarded: discardUpload(paths.uploadsDir, id) };
}

/**
 * `new-site --domain=<d> [--plugins=slug:1,...] [--uploads=id:0,...] [--as-user=<u>]`:
 * the plugins chosen on CloudPanel's new-site form, recorded as a job that
 * waits for that site. Directory plugins go first, so an uploaded add-on finds
 * the plugin it extends already active. `--as-user` names a site manager, held
 * to the switch, to directory plugins and to their own earlier choices.
 *
 * Any earlier choice still waiting for the same domain is replaced, and one
 * with no plugins only clears it: CloudPanel sent the form back, and it was
 * submitted again with a different choice, or none.
 */
async function recordNewSite(paths: WpToolsActionPaths, rest: string[], options: WpToolsActionOptions): Promise<{ job: WpJobView | null }> {
  const fields: Record<string, string> = {};
  for (const argument of rest) {
    const match = /^--(domain|plugins|uploads|as-user)=(.*)$/.exec(argument);
    if (!match || fields[match[1]!] !== undefined) failAction(`unexpected argument '${argument}'`);
    fields[match[1]!] = match[2]!;
  }
  const domain = (options.domainValidator ?? ((value: string) => validateDomain(value)))(fields.domain ?? "").toLowerCase();
  let directory: { key: string; activate: boolean }[];
  let uploads: { key: string; activate: boolean }[];
  try {
    directory = parsePluginList(fields.plugins, DIRECTORY_SLUG_RE, "WordPress.org plugin slug");
    uploads = parsePluginList(fields.uploads, UPLOAD_ID_RE, "upload id");
  } catch (error) {
    failAction(errorMessage(error));
  }
  const asUser = asUserArgument(fields["as-user"]);
  // A zip is code nobody has reviewed: only an administrator hands one to a site.
  if (asUser && uploads.length) failAction("only an administrator can upload plugins");
  const total = directory.length + uploads.length;
  if (total > MAX_NEW_SITE_PLUGINS) failAction(`a new site takes at most ${MAX_NEW_SITE_PLUGINS} plugins`);
  if (!existsSync(paths.configFile)) failAction("WordPress Tools must be enabled first");
  if (asUser) siteManagerMayChoose(paths, asUser);
  return withFileLock(paths.pluginsLockFile, 15, "another plugin choice is being saved", async () => {
    // Only a site that does not exist yet: this is no way into an existing one.
    if (total && panelSites(paths).some((row) => row.domain_name.toLowerCase() === domain)) {
      failAction(`CloudPanel already has a site called ${domain}; plugins are chosen here only for a new one`);
    }
    // The later choice is the one that counts, and it may name the same uploads.
    // A site manager replaces only their own; an administrator, anyone's.
    const replaced = waitingNewSiteJobs(paths.jobsDir, (view) => view.domains[0] === domain && (!asUser || view.chosenBy === asUser));
    const released = replaced.flatMap((view) => view.plugins.flatMap((plugin) => plugin.upload ? [plugin.upload] : []));
    for (const view of replaced) jobSet(jobDir(paths.jobsDir, view.id), "superseded", "1");
    releaseUploads(paths.uploadsDir, released);
    if (!total) {
      removeUploads(paths.uploadsDir, released);
      return { job: null };
    }
    let claimed;
    try { claimed = claimUploads(paths.uploadsDir, uploads.map((upload) => upload.key)); }
    catch (error) { failAction(errorMessage(error)); }
    const plan: NewSitePlugin[] = [
      ...directory.map(({ key, activate }) => ({ source: "wordpress.org" as const, slug: key, name: key, activate })),
      ...claimed.map((upload, index) => ({
        source: "upload" as const, slug: upload.slug, name: upload.name, activate: uploads[index]!.activate, upload: upload.id,
      })),
    ];
    const slugs = plan.map((plugin) => plugin.slug.toLowerCase());
    try {
      if (new Set(slugs).size !== slugs.length) failAction("the same plugin is chosen twice");
      return {
        job: startWpJob({
          jobsDir: paths.jobsDir, task: "new-site-plugins", domains: [domain], plugins: plan, chosenBy: asUser,
          // Under the lock, so a creation logged after this is the one this job waits for.
          ...(asUser ? { eventsAfter: String(latestEventId(paths)) } : {}),
          actionBinary: paths.actionBinary, start: options.startJob,
        }),
      };
    } catch (error) {
      releaseUploads(paths.uploadsDir, claimed.map((upload) => upload.id));
      throw error;
    }
  });
}

/** What the page a new site lands on is told about its job: no upload ids, no log. */
export interface NewSiteStatus {
  id: string;
  domain: string;
  state: string;
  step: string;
  error: string;
  completed: number;
  total: number;
  site: string;
  result: WpJobView["result"];
}

/**
 * `new-site-status --job=<id> [--as-user=<u>]`. A site manager is told only
 * about a job they recorded themselves, which is the site they just created;
 * any other id reads as one that does not exist.
 */
function newSiteStatus(paths: WpToolsActionPaths, rest: string[]): { job: NewSiteStatus } {
  let id = "";
  let asUser = "";
  for (const argument of rest) {
    if (argument.startsWith("--job=") && !id) id = validateJobId(argument.slice("--job=".length)) ?? "";
    else if (argument.startsWith("--as-user=") && !asUser) asUser = asUserArgument(argument.slice("--as-user=".length));
    else failAction(`unexpected argument '${argument}'`);
  }
  if (!id) failAction("'new-site-status' takes --job=<id>");
  if (asUser) {
    const db = openPanelDatabase(paths.panelDb, true, 1000);
    try { if (panelUserRole(db, asUser) !== "ROLE_SITE_MANAGER") failAction("no such job"); }
    finally { db.close(); }
  }
  const view = wpJobView(paths.jobsDir, id);
  if (!view || view.task !== "new-site-plugins" || (asUser && view.chosenBy !== asUser)) failAction("no such job");
  const { state, step, error, completed, total, site, result } = view;
  return { job: { id, domain: view.domains[0] ?? "", state, step, error, completed, total, site, result } };
}

/**
 * `new-site-access [--as-user=<u>]`: whether this caller may use the form's
 * Plugins row, and upload to it. The manager asks before searching
 * WordPress.org for a site manager, since only root can read the switch.
 */
function newSiteAccess(paths: WpToolsActionPaths, rest: string[]): { uploads: boolean } {
  const asUser = rest.length === 1 && rest[0]!.startsWith("--as-user=") ? asUserArgument(rest[0]!.slice("--as-user=".length))
    : rest.length ? failAction("'new-site-access' takes only --as-user") : "";
  if (!existsSync(paths.configFile)) failAction("WordPress Tools is not enabled");
  if (asUser) siteManagerMayChoose(paths, asUser);
  return { uploads: !asUser };
}

function runNewSiteJob(
  paths: WpToolsActionPaths, view: WpJobView, options: WpToolsActionOptions,
  onProgress: (progress: { completed: number; total: number; site: string }) => void, step: (text: string) => void,
) {
  const dir = jobDir(paths.jobsDir, view.id);
  const superseded = () => jobGet(dir, "superseded") === "1";
  return runNewSitePlugins({
    runuser: paths.runuser,
    uploadsDir: paths.uploadsDir,
    domain: view.domains[0]!,
    plugins: view.plugins,
    chosenAt: view.createdAt,
    chosenBy: view.chosenBy,
    lookup: () => newSiteLookup(paths, view.domains[0]!, Number.parseInt(jobGet(dir, "eventsAfter") || "-1", 10)),
    superseded,
    // Under the lock a later submission takes to supersede this one, so either
    // it sees this job installing, or this job sees it was replaced.
    begin: () => withFileLockSync(paths.pluginsLockFile, 30, "a plugin choice is still being saved", () => {
      if (superseded()) return false;
      jobSet(dir, "phase", "installing");
      return true;
    }),
    enabled: () => existsSync(paths.configFile),
    deadline: Date.now() + JOB_BUDGET_MS,
  }, options, onProgress, step);
}

/** systemd's half: wait for the policy's lock, which a timer pass may hold, then do the work. */
async function runJob(paths: WpToolsActionPaths, id: string, options: WpToolsActionOptions): Promise<WpJobView | null> {
  await runWpJob(paths.jobsDir, id, async (view, onProgress, step) => {
    const { task, domains } = view;
    if (task === "new-site-plugins") {
      if (!existsSync(paths.configFile)) failAction("WordPress Tools is not enabled");
      return runNewSiteJob(paths, view, options, onProgress, step);
    }
    const varnish = policyOf(task) === "varnish";
    const lock = varnish ? paths.varnishLockFile : paths.mainwpLockFile;
    const busy = varnish ? "a WordPress Varnish change is still running" : "a MainWP change is still running";
    return withFileLock(lock, JOB_LOCK_WAIT_SECONDS, busy, async () => {
      if (!existsSync(paths.configFile)) failAction("WordPress Tools is not enabled");
      const deadline = Date.now() + JOB_BUDGET_MS;
      const progressed = { ...options, onProgress };
      const targets = domains.length ? { targets: domains } : {};
      if (task === "varnish-check") return syncVarnish(varnishRun(paths, { deadline, ...targets }), progressed);
      if (task === "varnish-install") return syncVarnish(varnishRun(paths, { deadline, domain: domains[0] }), progressed);
      if (task === "mainwp-check") return syncMainwpAll(mainwpRun(paths, { deadline, ...targets }), progressed);
      if (task === "mainwp-connect") return syncMainwpAll({ ...mainwpRun(paths, { deadline, targets: domains }), connect: true }, progressed);
      return syncMainwpAll(mainwpRun(paths, { deadline }), progressed, true);
    });
  });
  // A new site this policy's job kept waiting, or one whose check this was, is checked again now.
  try {
    const { failed } = await reconcileWpNewSites(options, "job");
    for (const failure of failed) process.stderr.write(`[wp-tools] WARN: ${failure}\n`);
  } catch (error) {
    process.stderr.write(`[wp-tools] WARN: new sites were not checked again: ${errorMessage(error)}\n`);
  }
  return wpJobView(paths.jobsDir, id);
}

/** Expired job records and plugin uploads go, and a job whose runner died is marked failed. */
export function pruneWpJobs(options: WpToolsActionOptions = {}): void {
  pruneUploads(pathsFor(options).uploadsDir);
  pruneJobs({
    addon: "wp-tools",
    jobsDir: pathsFor(options).jobsDir,
    retentionDays: JOB_RETENTION_DAYS,
    stuckMessage: "the job stopped without recording a result",
  });
}

export async function executeWpToolsAction(
  argv: string[],
  options: WpToolsActionOptions = {},
): Promise<unknown> {
  if ((options.processUid ?? process.getuid?.()) !== 0) failAction("WordPress Tools actions must run as root");
  const paths = pathsFor(options);
  if (argv[0] === "start") return startJob(paths, argv.slice(1), options);
  if (argv[0] === "new-site") return recordNewSite(paths, argv.slice(1), options);
  if (argv[0] === "new-site-status") return newSiteStatus(paths, argv.slice(1));
  if (argv[0] === "new-site-access") return newSiteAccess(paths, argv.slice(1));
  // An administrator's; the manager renders the templates again once it is saved.
  if (argv[0] === "new-site-settings") {
    const enabled = argv.length === 2 ? /^--site-managers=(true|false)$/.exec(argv[1]!)?.[1] : undefined;
    if (!enabled) failAction("'new-site-settings' takes --site-managers=true|false");
    if (!existsSync(paths.configFile)) failAction("WordPress Tools must be enabled before changing who chooses plugins");
    const newSiteAccess = { siteManagers: enabled === "true" };
    saveNewSiteAccess(paths.newSiteAccessState, newSiteAccess);
    return { newSiteAccess };
  }
  if (argv[0] === "plugin-upload") return uploadPart(paths, argv.slice(1), options.input ?? await Bun.stdin.text());
  if (argv[0] === "plugin-discard") return discard(paths, argv.slice(1));
  if (argv[0] === "run") return runJob(paths, jobIdArgument(argv.slice(1)), options);
  if (argv[0] === "job") {
    const id = jobIdArgument(argv.slice(1));
    const view = wpJobView(paths.jobsDir, id);
    if (!view) failAction(`no such job: ${id}`);
    return { job: view, log: readJobLog(jobDir(paths.jobsDir, id)) };
  }
  if (argv[0]?.startsWith("mainwp-")) {
    return withFileLock(paths.mainwpLockFile, 15, "a MainWP change is still running", () => {
      if (!existsSync(paths.configFile)) failAction("WordPress Tools must be enabled before a MainWP action");
      return mainwpAction(mainwpRun(paths), argv, options, options.domainValidator ?? ((value) => validateDomain(value)));
    });
  }
  const { verb, domain, asUser, clientIp, addBypass: bypass, allowBasicAuth, enabled } = parseAction(argv, options);
  if (verb === "sync") return syncPolicies(options);

  if (verb === "sites") {
    // The optional feature's state must not take sign-in down with it.
    let varnish: WpVarnishState = { enabled: false, sites: {} };
    let varnishError = "";
    try {
      varnish = readVarnishState(paths.varnishState);
    } catch (error) {
      varnishError = `${paths.varnishState} cannot be read: ${errorMessage(error)}`;
    }
    let mainwp = mainwpView(emptyMainwpState());
    let mainwpError = "";
    try {
      mainwp = mainwpView(readMainwpState(paths.mainwpState));
    } catch (error) {
      mainwpError = `${paths.mainwpState} cannot be read: ${errorMessage(error)}`;
    }
    let jobs: WpJobs = { varnish: null, mainwp: null };
    let newSites: WpJobView[] = [];
    try {
      jobs = activeWpJobs(paths.jobsDir);
      newSites = newSiteJobs(paths.jobsDir);
    } catch {
      // A job the page cannot see still finishes; the page only loses its progress.
    }
    let domainLink: WpDomainLink = { ...DEFAULT_DOMAIN_LINK };
    let domainLinkError = "";
    try {
      domainLink = readDomainLink(paths.domainLinkState);
    } catch (error) {
      domainLinkError = `${paths.domainLinkState} cannot be read: ${errorMessage(error)}`;
    }
    let newSiteAccess: WpNewSiteAccess = { ...DEFAULT_NEW_SITE_ACCESS };
    let newSiteAccessError = "";
    try {
      newSiteAccess = readNewSiteAccess(paths.newSiteAccessState);
    } catch (error) {
      newSiteAccessError = `${paths.newSiteAccessState} cannot be read: ${errorMessage(error)}`;
    }
    return {
      sites: wordpressSites(paths, varnish), varnish, varnishError, mainwp, mainwpError, domainLink, domainLinkError, jobs, newSites,
      newSiteAccess, newSiteAccessError,
    };
  }
  // The manager renders the templates again once this is saved; nothing here
  // touches them.
  if (verb === "domain-link-settings") {
    if (!existsSync(paths.configFile)) failAction("WordPress Tools must be enabled before changing the domain link");
    const domainLink = { signIn: enabled! };
    saveDomainLink(paths.domainLinkState, domainLink);
    return { domainLink };
  }
  if (verb === "varnish-sync") return reconcileWpVarnish(options);
  if (verb === "varnish-settings" || verb === "varnish-install") {
    return withFileLock(paths.varnishLockFile, 15, "a WordPress Varnish change is still running", async () => {
      if (!existsSync(paths.configFile)) failAction("WordPress Tools must be enabled before a Varnish action");
      if (verb === "varnish-install") return syncVarnish(varnishRun(paths, { domain }), options);
      const state = readVarnishState(paths.varnishState);
      pruneVarnishState(state, varnishRun(paths).domains);
      state.enabled = enabled!;
      saveVarnishState(paths.varnishState, state);
      return { varnish: state };
    });
  }
  // Whether a site's pages should offer the sign-in. CloudPanel's site pages
  // have no application to go on, so they ask; the answer is the same disk
  // check a sign-in makes, for a site the caller could sign in to.
  if (verb === "site-kind") {
    if (!existsSync(paths.configFile)) failAction("WordPress Tools is not enabled");
    if (asUser && !mayManageSite(paths, asUser, domain)) failAction("that site is not yours to sign in to");
    const site = resolvedSites(paths).find((candidate) => candidate.row.domain_name === domain);
    return { wordpress: Boolean(site && isWordPress(site.root)) };
  }
  // Both writing paths take the lock: a sign-in that ran while the addon was
  // being withdrawn would put a loader back into a site it had just left.
  if (verb === "remove") {
    return withFileLock(paths.lockFile, 30, "a WordPress sign-in change is still running", async () =>
      removeWpLogin(paths));
  }
  // An administrator's request arrives without a name and is not narrowed;
  // every other session names itself and is held to the sites CloudPanel shows
  // it. The check is here rather than at the manager because only this side can
  // read the panel's database.
  if (asUser && !mayManageSite(paths, asUser, domain)) {
    failAction("that site is not yours to sign in to");
  }
  return withFileLock(paths.lockFile, 5, "a WordPress sign-in change is still running", async () => {
    if (!existsSync(paths.configFile)) failAction("WordPress Tools is not enabled");
    // Maintenance answers in Nginx, before WordPress could read the secret, so
    // a secret minted for a browser it turns away is one nobody can use.
    const site = wordpressSite(paths, domain);
    const maintenance = existsSync(paths.maintenanceConfig) && maintenanceBlocks(paths.maintenance, domain, clientIp);
    if (maintenance && !bypass) return maintenanceReply(domain, clientIp, !asUser);
    const basicAuth = basicAuthBlocks(paths, domain, clientIp);
    if (basicAuth && !allowBasicAuth) return basicAuthReply(domain, clientIp, !asUser, () => basicAuthRewritable(paths, domain));
    // Mint before taking CloudPanel's write lock; an unused token expires on its own.
    const login = mintWpLogin(paths, site, options);
    if (basicAuth) await withBasicAuthBypass(paths, domain, clientIp, options.run, options.reloadNginx);
    if (maintenance) await addBypass(paths.maintenance, domain, clientIp);
    return login;
  });
}

export async function runWpToolsAction(
  argv: string[],
  options: WpToolsActionOptions = {},
): Promise<number> {
  const emit = options.emitReply !== false;
  return replyToAction("wp-tools", emit, async () => {
    if (argv[0] !== "watch-job") return executeWpToolsAction(argv, options);
    if ((options.processUid ?? process.getuid?.()) !== 0) failAction("WordPress Tools actions must run as root");
    const paths = pathsFor(options);
    const id = jobIdArgument(argv.slice(1));
    const dir = jobDir(paths.jobsDir, id);
    if (!wpJobView(paths.jobsDir, id)) failAction(`no such job: ${id}`);
    await watchJobRecord({
      dir,
      read: () => ({ job: wpJobView(paths.jobsDir, id), log: readJobLog(dir) }),
      emit: (data) => { if (emit) emitActionOk(data); },
    });
    return REPLIED;
  });
}

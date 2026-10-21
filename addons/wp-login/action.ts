/**
 * The privileged half of the WordPress sign-in.
 *
 * This is the only addon that puts its own code inside a site, which is why it is
 * an addon rather than a switch on Panel Tweaks: an operator who wants a
 * filterable site list should not have to install the code that can put a file
 * inside a customer's WordPress. Installing this is the decision, and
 * uninstalling it takes the file back out of every site.
 *
 * Everything it writes or deletes in a site it does as the site's own user,
 * through `runuser`, into paths built from the account's home directory. Root
 * never writes there itself: the site's user controls every name under its
 * root, so a symlink there would aim a root write or `rm -rf` anywhere on the
 * box. It accepts a domain and nothing else -- no paths, no user names, no file
 * contents.
 */
import { Database } from "bun:sqlite";
import { PANEL_USER_NAME_RE, panelUserOwnsSite } from "../../lib/panel-users";
import { createHash, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { normalizeMappedIpv4 } from "../../lib/ip-address";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  ActionFailure, emitActionError, emitActionOk, failAction, validateDomain, withFileLock, type CommandResult,
} from "../../cli/action-common";
import { CONFIG_DIR, PANEL_DB } from "../../cli/paths";
import { readUnixAccounts, siteAccountProblem, splitSharedUids, type UnixAccount } from "../../lib/site-accounts";
import {
  DEFAULT_MAINTENANCE_ACTION_PATHS, addBypass, maintenanceBlocks, type MaintenanceActionPaths,
} from "../maintenance/action";

import { basicAuthBlocks, withBasicAuthBypass, type reloadNginx } from "./basic-auth";

export type WpLoginVerb = "sites" | "sign-in" | "remove";

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
  /** The application CloudPanel recorded, such as WordPress. May be empty. */
  application: string;
  /** Whether the sign-in helper is in the site right now. */
  helper: boolean;
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

function basicAuthReply(domain: string, ip: string, admin: boolean): WpBasicAuthReply {
  const blocked = `${domain} is protected by CloudPanel basic authentication.`;
  if (!admin) return { basicAuth: { ip, canBypass: false, message: `${blocked} An administrator can allow your IP in Security → Basic Authentication.` } };
  if (!ip) return { basicAuth: { ip, canBypass: false, message: `${blocked} The panel could not tell your IP, so manage its allowlist in Security → Basic Authentication.` } };
  return { basicAuth: { ip, canBypass: true, message: `${blocked} Allow your IP ${ip} and sign in? This bypasses basic authentication for the whole site, for everyone sharing that IP, until removed in Security → Basic Authentication.` } };
}

export interface WpRemoveResult {
  removed: number;
  /** `domain: reason` for each site whose loader could not be deleted. */
  failed: string[];
}

export interface WpLoginActionPaths {
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
}

export interface WpLoginActionOptions {
  paths?: Partial<WpLoginActionPaths>;
  emitReply?: boolean;
  processUid?: number;
  now?: () => Date;
  run?: (command: string, args: string[]) => CommandResult;
  reloadNginx?: typeof reloadNginx;
  /** Test-only; production always guards against the panel's own hostname. */
  domainValidator?: (value: string) => string;
}

export const DEFAULT_WP_LOGIN_PATHS: WpLoginActionPaths = {
  panelDb: PANEL_DB,
  passwd: "/etc/passwd",
  lockFile: "/run/lock/clp-addons/wp-login.lock",
  runuser: "/usr/sbin/runuser",
  maintenanceConfig: `${CONFIG_DIR}/maintenance.conf`,
  maintenance: DEFAULT_MAINTENANCE_ACTION_PATHS,
  nginxVhostDir: "/etc/nginx/sites-enabled",
  nginx: "nginx",
  systemctl: "systemctl",
  vhostUid: 0,
};

function pathsFor(options: WpLoginActionOptions): WpLoginActionPaths {
  return { ...DEFAULT_WP_LOGIN_PATHS, ...options.paths };
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// --- panel database -------------------------------------------------------

interface PanelSiteRow {
  domain_name: string;
  user: string;
  application: string | null;
  root_directory: string | null;
}

function openPanelDatabase(path: string): Database {
  try {
    const db = new Database(path, { readonly: true });
    db.exec("PRAGMA busy_timeout = 1000;");
    return db;
  } catch (error) {
    failAction(`CloudPanel database could not be opened: ${reason(error)}`);
  }
}

/**
 * Whether a panel user may sign in to this site's WordPress.
 *
 * Asked here, as root, rather than in the manager: the manager cannot open
 * CloudPanel's database, and the answer has to be the same one the panel's own
 * Sites page is built from.
 */
function mayManageSite(paths: WpLoginActionPaths, userName: string, domain: string): boolean {
  const db = openPanelDatabase(paths.panelDb);
  try {
    return panelUserOwnsSite(db, userName, domain);
  } catch (error) {
    failAction(`CloudPanel could not say whose site that is: ${reason(error)}`);
  } finally {
    db.close();
  }
}

function panelSites(paths: WpLoginActionPaths): PanelSiteRow[] {
  const db = openPanelDatabase(paths.panelDb);
  try {
    return db.query<PanelSiteRow, []>(
      `SELECT domain_name, user, application, root_directory FROM site ORDER BY domain_name;`,
    ).all();
  } catch (error) {
    failAction(`CloudPanel site list could not be read: ${reason(error)}`);
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
    failAction(`the account database could not be read: ${reason(error)}`);
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
function resolvedSites(paths: WpLoginActionPaths): { row: PanelSiteRow; account: SiteAccount; root: string }[] {
  const accounts = readAccounts(paths.passwd);
  const rows = panelSites(paths).flatMap((row) => {
    const account = accounts.get(row.user);
    return account ? [{ row, ...account }] : [];
  });
  const resolved: { row: PanelSiteRow; account: SiteAccount; root: string }[] = [];
  for (const { row, uid, gid, home } of splitSharedUids(rows).unique) {
    if (siteAccountProblem({ user: row.user, uid, gid }) || !home.startsWith("/")) continue;
    const account = { name: row.user, home };
    try {
      resolved.push({ row, account, root: siteRoot(account, row) });
    } catch {
      // A site whose recorded root is not a plain directory name is left alone.
    }
  }
  return resolved;
}

function wordpressSites(paths: WpLoginActionPaths): WpSiteView[] {
  return resolvedSites(paths)
    .filter((site) => isWordPress(site.root))
    .map((site) => ({
      domain: site.row.domain_name,
      user: site.row.user,
      application: site.row.application ?? "",
      helper: existsSync(join(site.root, LOADER_FILE)),
    }));
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
 * Description: Accepts one single-use administrator sign-in minted by CloudPanel. Installed and removed by the WordPress Sign-In addon.
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

function runAsSite(paths: WpLoginActionPaths, account: SiteAccount, command: string[], input?: string, timeoutMs = 30_000): void {
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

function wordpressSite(paths: WpLoginActionPaths, domain: string): ResolvedSite {
  const site = resolvedSites(paths).find((candidate) => candidate.row.domain_name === domain);
  if (!site) failAction(`CloudPanel has no site called ${domain} with an account this addon can act as`);
  if (!isWordPress(site.root)) failAction(`${domain} does not look like a WordPress installation`);
  return site;
}

function mintWpLogin(
  paths: WpLoginActionPaths,
  site: ResolvedSite,
  options: WpLoginActionOptions,
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
    failAction(`the sign-in could not be written into ${domain}: ${reason(error)}`);
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
export function removeWpLogin(paths: WpLoginActionPaths = DEFAULT_WP_LOGIN_PATHS): WpRemoveResult {
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

// --- request parsing ------------------------------------------------------

interface ParsedAction {
  verb: WpLoginVerb;
  domain: string;
  /** The panel user the request is on behalf of, when it is not an admin's. */
  asUser: string;
  /** The browser's address as the panel saw it; empty when it could not tell. */
  clientIp: string;
  /** Add `clientIp` to the site's maintenance bypasses before signing in. */
  addBypass: boolean;
  allowBasicAuth: boolean;
}

function parseAction(argv: string[], options: WpLoginActionOptions): ParsedAction {
  const [rawVerb, ...rest] = argv;
  const verbs: WpLoginVerb[] = ["sites", "sign-in", "remove"];
  const verb = verbs.find((known) => known === rawVerb);
  if (!verb) failAction(`unknown WordPress sign-in verb '${rawVerb ?? ""}'`);

  let domain = "";
  let asUser = "";
  let clientIp = "";
  let addBypass = false;
  let allowBasicAuth = false;
  for (const argument of rest) {
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
    failAction(`unexpected argument '${argument}'`);
  }
  if (verb !== "sign-in" && (asUser || clientIp || addBypass || allowBasicAuth)) failAction(`'${verb}' takes no --as-user, --client-ip, --add-bypass or --allow-basic-auth`);
  // Only an administrator may lift either Nginx gate for their request address.
  if ((addBypass || allowBasicAuth) && (asUser || !clientIp)) failAction("only an administrator's sign-in can add its address as a bypass");
  if (asUser && !PANEL_USER_NAME_RE.test(asUser)) failAction("that is not a valid panel user name");
  if (verb === "sign-in") {
    // The panel's own hostname is refused here as it is everywhere else: the
    // panel is not a site, and nothing of ours writes into it.
    domain = (options.domainValidator ?? ((value: string) => validateDomain(value)))(domain);
  } else if (domain) {
    failAction(`'${verb}' takes no --domain`);
  }
  return { verb, domain, asUser, clientIp, addBypass, allowBasicAuth };
}

export async function executeWpLoginAction(
  argv: string[],
  options: WpLoginActionOptions = {},
): Promise<unknown> {
  if ((options.processUid ?? process.getuid?.()) !== 0) failAction("WordPress sign-in actions must run as root");
  const paths = pathsFor(options);
  const { verb, domain, asUser, clientIp, addBypass: bypass, allowBasicAuth } = parseAction(argv, options);

  if (verb === "sites") return { sites: wordpressSites(paths) };
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
    // Maintenance answers in Nginx, before WordPress could read the secret, so
    // a secret minted for a browser it turns away is one nobody can use.
    const site = wordpressSite(paths, domain);
    const maintenance = existsSync(paths.maintenanceConfig) && maintenanceBlocks(paths.maintenance, domain, clientIp);
    if (maintenance && !bypass) return maintenanceReply(domain, clientIp, !asUser);
    const basicAuth = basicAuthBlocks(paths, domain, clientIp);
    if (basicAuth && !allowBasicAuth) return basicAuthReply(domain, clientIp, !asUser);
    // Mint before taking CloudPanel's write lock; an unused token expires on its own.
    const login = mintWpLogin(paths, site, options);
    if (basicAuth) await withBasicAuthBypass(paths, domain, clientIp, options.run, options.reloadNginx);
    if (maintenance) await addBypass(paths.maintenance, domain, clientIp);
    return login;
  });
}

export async function runWpLoginAction(
  argv: string[],
  options: WpLoginActionOptions = {},
): Promise<number> {
  const emit = options.emitReply !== false;
  try {
    const data = await executeWpLoginAction(argv, options);
    if (emit) emitActionOk(data);
    return 0;
  } catch (error) {
    const message = reason(error);
    if (emit) emitActionError(message, error instanceof ActionFailure ? error.data : undefined, "wp-login");
    else process.stderr.write(`[wp-login] ERROR: ${message}\n`);
    return 1;
  }
}

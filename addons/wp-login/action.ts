/**
 * The privileged half of the WordPress sign-in.
 *
 * This is the only addon that writes into a site's own tree, which is why it is
 * an addon rather than a switch on Panel Tweaks: an operator who wants a
 * filterable site list should not have to install the code that can put a file
 * inside a customer's WordPress. Installing this is the decision, and
 * uninstalling it takes the file back out of every site.
 *
 * Everything it writes it writes as the site's own user, into paths built from
 * the account's home directory. It accepts a domain and nothing else -- no
 * paths, no user names, no file contents.
 */
import { Database } from "bun:sqlite";
import { PANEL_USER_NAME_RE, panelUserOwnsSite } from "../../lib/panel-users";
import { createHash, randomBytes } from "node:crypto";
import { chownSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  ActionFailure, emitActionError, emitActionOk, failAction, validateDomain, withFileLock,
} from "../../cli/action-common";
import { PANEL_DB } from "../../cli/paths";
import { writeFileAtomic } from "../../lib/atomic-write";

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

export interface WpRemoveResult {
  removed: number;
}

export interface WpLoginActionPaths {
  panelDb: string;
  passwd: string;
  lockFile: string;
}

export interface WpLoginActionOptions {
  paths?: Partial<WpLoginActionPaths>;
  emitReply?: boolean;
  processUid?: number;
  now?: () => Date;
  /** Test-only; production always guards against the panel's own hostname. */
  domainValidator?: (value: string) => string;
}

export const DEFAULT_WP_LOGIN_PATHS: WpLoginActionPaths = {
  panelDb: PANEL_DB,
  passwd: "/etc/passwd",
  lockFile: "/run/lock/clp-addons/wp-login.lock",
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
    db.exec("PRAGMA busy_timeout = 5000;");
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
  uid: number;
  gid: number;
  home: string;
}

/**
 * A site's Unix account, read from /etc/passwd rather than resolved by name at
 * the point of use. Every path this action touches is built from the home
 * directory recorded there, so a site user whose account has gone contributes
 * nothing instead of a guessed `/home/<name>`.
 */
function siteAccounts(passwd: string): Map<string, SiteAccount> {
  const accounts = new Map<string, SiteAccount>();
  let content: string;
  try {
    content = readFileSync(passwd, "utf8");
  } catch (error) {
    failAction(`the account database could not be read: ${reason(error)}`);
  }
  for (const line of content.split("\n")) {
    const fields = line.split(":");
    if (fields.length < 6) continue;
    const uid = Number.parseInt(fields[2] ?? "", 10);
    const gid = Number.parseInt(fields[3] ?? "", 10);
    const home = fields[5] ?? "";
    if (!fields[0] || !Number.isInteger(uid) || !Number.isInteger(gid) || !home.startsWith("/")) continue;
    accounts.set(fields[0], { uid, gid, home });
  }
  return accounts;
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

/** Every site, with the root the addon would act on, skipping what it cannot. */
function resolvedSites(paths: WpLoginActionPaths): { row: PanelSiteRow; account: SiteAccount; root: string }[] {
  const accounts = siteAccounts(paths.passwd);
  const resolved: { row: PanelSiteRow; account: SiteAccount; root: string }[] = [];
  for (const row of panelSites(paths)) {
    const account = accounts.get(row.user);
    if (!account) continue;
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

function writeAsSite(path: string, content: string, account: SiteAccount, mode: number): void {
  writeFileAtomic(path, content, { mode, owner: { uid: account.uid, gid: account.gid } });
}

/**
 * One directory, owned by the site.
 *
 * Deliberately not recursive: mkdir runs as root, and a recursive create left
 * the site with a root-owned `wp-content` it could no longer write to. Each
 * level this creates is handed straight over, and a missing parent is a
 * refusal rather than something to invent.
 */
function ensureOwnedDirectory(path: string, account: SiteAccount): void {
  if (existsSync(path)) return;
  try {
    mkdirSync(path, { mode: 0o755 });
    chownSync(path, account.uid, account.gid);
  } catch (error) {
    failAction(`the site directory ${path} could not be created: ${reason(error)}`);
  }
}

function mintWpLogin(
  paths: WpLoginActionPaths,
  domain: string,
  options: WpLoginActionOptions,
): WpLoginResult {
  const site = resolvedSites(paths).find((candidate) => candidate.row.domain_name === domain);
  if (!site) failAction(`CloudPanel has no site called ${domain} with an account on this host`);
  if (!isWordPress(site.root)) failAction(`${domain} does not look like a WordPress installation`);

  ensureOwnedDirectory(join(site.root, MU_PLUGINS), site.account);
  ensureOwnedDirectory(join(site.root, SECRET_DIR), site.account);

  const loader = join(site.root, LOADER_FILE);
  // Rewritten only when it differs, so an untouched site keeps its file's mtime
  // and nothing reindexes it.
  let current = "";
  try {
    current = readFileSync(loader, "utf8");
  } catch {
    current = "";
  }
  if (current !== LOADER_PHP) writeAsSite(loader, LOADER_PHP, site.account, 0o644);

  const token = randomBytes(32).toString("hex");
  const hash = createHash("sha256").update(token).digest("hex");
  const expires = Math.floor((options.now?.() ?? new Date()).getTime() / 1000) + WP_LOGIN_TTL_SECONDS;
  writeAsSite(
    join(site.root, SECRET_FILE),
    `<?php return array('hash' => '${hash}', 'expires' => ${expires});\n`,
    site.account,
    0o600,
  );

  return {
    domain,
    url: `https://${domain}/`,
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
  for (const site of resolvedSites(paths)) {
    const loader = join(site.root, LOADER_FILE);
    if (!existsSync(loader)) continue;
    rmSync(loader, { force: true });
    rmSync(join(site.root, SECRET_DIR), { recursive: true, force: true });
    removed++;
  }
  return { removed };
}

// --- request parsing ------------------------------------------------------

interface ParsedAction {
  verb: WpLoginVerb;
  domain: string;
  /** The panel user the request is on behalf of, when it is not an admin's. */
  asUser: string;
}



function parseAction(argv: string[], options: WpLoginActionOptions): ParsedAction {
  const [rawVerb, ...rest] = argv;
  const verbs: WpLoginVerb[] = ["sites", "sign-in", "remove"];
  const verb = verbs.find((known) => known === rawVerb);
  if (!verb) failAction(`unknown WordPress sign-in verb '${rawVerb ?? ""}'`);

  let domain = "";
  let asUser = "";
  for (const argument of rest) {
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
  if (asUser && verb !== "sign-in") failAction(`'${verb}' takes no --as-user`);
  if (asUser && !PANEL_USER_NAME_RE.test(asUser)) failAction("that is not a valid panel user name");
  if (verb === "sign-in") {
    // The panel's own hostname is refused here as it is everywhere else: the
    // panel is not a site, and nothing of ours writes into it.
    domain = (options.domainValidator ?? ((value: string) => validateDomain(value)))(domain);
  } else if (domain) {
    failAction(`'${verb}' takes no --domain`);
  }
  return { verb, domain, asUser };
}

export async function executeWpLoginAction(
  argv: string[],
  options: WpLoginActionOptions = {},
): Promise<unknown> {
  if ((options.processUid ?? process.getuid?.()) !== 0) failAction("WordPress sign-in actions must run as root");
  const paths = pathsFor(options);
  const { verb, domain, asUser } = parseAction(argv, options);

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
  return withFileLock(paths.lockFile, 15, "a WordPress sign-in change is still running", async () =>
    mintWpLogin(paths, domain, options));
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

import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  ActionFailure, emitActionError, emitActionOk, failAction, runCommand, siteUserFor, validateDomain,
  withFileLock, type CommandResult,
} from "../../cli/action-common";
import { PANEL_IDENTITY_PATH } from "../../cli/action-constants";
import { PANEL_DB, STATE_DIR } from "../../cli/paths";
import {
  commandError, errorMessage, openPanelDatabase, restoreVhosts, trustedVhost, withRecoveryFailures,
  writeAtomicOwned, type VhostBackup,
} from "../../cli/vhost-common";

const STATE_VERSION = 1;

/**
 * The redirect is one marked block, so `clear` removes exactly what `set`
 * added and reconcile can compare the rendered file against the column.
 */
const BLOCK_START = "# clp-addons:redirects:start";
const BLOCK_END = "# clp-addons:redirects:end";

/**
 * Nginx tries regex locations in the order they are written and takes the
 * first match, so a block placed directly after CloudPanel's own
 * `location ~ /.well-known` catches every other URI while leaving ACME to the
 * panel's block -- which is what renews the redirect site's own certificate.
 * A prefix `location /` would not: the stock static vhost ends with a regex
 * location for assets, and that would still serve (and 404) `/style.css`.
 */
const WELL_KNOWN_RE = /^[ \t]*location[ \t]*~[ \t]*\/\.well-known[ \t]*\{[^{}]*\}[ \t]*(?:\r?\n)/m;
/** The blank line the block is written after is part of the block's own text. */
const BLOCK_PATTERN = `(?:\\r?\\n)?[ \\t]*${BLOCK_START}[\\s\\S]*?${BLOCK_END}[ \\t]*(?:\\r?\\n|$)`;
const BLOCK_RE = new RegExp(BLOCK_PATTERN);
/** Removal is global: a vhost somebody added a second block to loses both. */
const BLOCK_RE_ALL = new RegExp(BLOCK_PATTERN, "g");
const RETURN_RE = /^[ \t]*return[ \t]+(301|302)[ \t]+(\S+);[ \t]*$/m;

/** Nginx reads `$` as a variable and `;` as the end of the directive. */
const TARGET_RE = /^https?:\/\/[A-Za-z0-9\-._~%:/?#[\]@!()*+,=&]+$/;
const MAX_TARGET_LENGTH = 512;

export type RedirectsVerb = "list" | "create" | "set" | "clear" | "reconcile";

export interface RedirectsActionPaths {
  panelDb: string;
  nginxVhostDir: string;
  stateFile: string;
  lockFile: string;
  panelIdentityFile: string;
  clpctl: string;
  nginx: string;
  systemctl: string;
  vhostUid: number;
  stateUid: number;
}

export interface RedirectsActionOptions {
  paths?: Partial<RedirectsActionPaths>;
  input?: string;
  emitReply?: boolean;
  run?: (command: string, args: string[]) => CommandResult;
  /** Test-only override; production validates against the panel identity. */
  domainValidator?: (value: string) => string;
}

/** What the operator chose: where a site sends visitors, and how. */
export interface Redirect {
  domain: string;
  target: string;
  code: 301 | 302;
  preservePath: boolean;
}

export interface RedirectView extends Redirect {
  /** CloudPanel's site type, or "" when the site is gone from the panel. */
  type: string;
  /** Whether the stored template and the rendered vhost both carry the block. */
  applied: boolean;
}

export interface RedirectsState {
  redirects: RedirectView[];
}

export interface ReconcileResult {
  repaired: string[];
}

interface SiteRow {
  domain_name: string;
  type: string;
  vhost_template: string;
}

interface StateFile {
  version: 1;
  redirects: Redirect[];
}

export const DEFAULT_REDIRECTS_ACTION_PATHS: RedirectsActionPaths = {
  panelDb: PANEL_DB,
  nginxVhostDir: "/etc/nginx/sites-enabled",
  stateFile: `${STATE_DIR}/redirects/redirects.json`,
  lockFile: "/run/lock/clp-addons/redirects.lock",
  panelIdentityFile: PANEL_IDENTITY_PATH,
  clpctl: "/usr/bin/clpctl",
  nginx: "nginx",
  systemctl: "systemctl",
  vhostUid: 0,
  stateUid: 0,
};

function pathsFor(options: RedirectsActionOptions): RedirectsActionPaths {
  return { ...DEFAULT_REDIRECTS_ACTION_PATHS, ...options.paths };
}

/* ------------------------------------------------------------------ input */

function validateCode(value: unknown): 301 | 302 {
  if (value === 301 || value === 302) return value;
  failAction("code must be 301 or 302");
}

/**
 * An absolute http(s) URL only. A relative target would make the redirect
 * point back into a site that serves nothing, and anything nginx could read as
 * a variable or a second directive is refused rather than escaped.
 */
function validateTarget(value: unknown, domain: string, preservePath: boolean): string {
  if (typeof value !== "string" || value.trim() === "") failAction("missing target");
  const raw = value.trim();
  if (raw.length > MAX_TARGET_LENGTH) failAction("the target URL is too long");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    failAction(`the target must be an absolute http:// or https:// URL, got: '${raw}'`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") failAction("the target must use http:// or https://");
  if (url.username || url.password) failAction("the target must not carry credentials");
  if (url.hash) failAction("the target must not carry a fragment; a browser never sends one to the server");
  if (preservePath && url.search) {
    failAction("a target with a query string cannot also preserve the request path; turn the path off or drop the query");
  }
  let target = url.toString();
  // `https://example.com/` reads as a bare host once it is in an Nginx
  // directive; keeping the slash would double it when the path is preserved.
  if (url.pathname === "/" && !url.search) target = target.slice(0, -1);
  if (!TARGET_RE.test(target)) failAction(`the target URL contains characters Nginx cannot be given: '${raw}'`);
  // `example.test.` and `example.test` are the same host to DNS and to Nginx,
  // so the trailing dot is dropped before the comparison rather than making
  // the loop check miss.
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host === domain) failAction(`the target points back at ${domain}, which would redirect forever`);
  return target;
}

function requestedRedirect(domain: string, input: string | undefined): Redirect {
  let raw: unknown;
  try {
    raw = JSON.parse(input ?? readFileSync(0, "utf8"));
  } catch {
    failAction("input must be JSON");
  }
  if (typeof raw !== "object" || raw === null) failAction("input must be a JSON object");
  const body = raw as { target?: unknown; code?: unknown; preservePath?: unknown };
  if (body.preservePath !== undefined && typeof body.preservePath !== "boolean") {
    failAction("preservePath must be true or false");
  }
  const preservePath = body.preservePath !== false;
  return {
    domain,
    code: validateCode(body.code),
    preservePath,
    target: validateTarget(body.target, domain, preservePath),
  };
}

function parseDomainFlag(argv: string[], verb: string, validate: (value: string) => string): string {
  const flag = argv[1] ?? "";
  if (argv.length !== 2 || !flag.startsWith("--domain=")) failAction(`${verb} takes only --domain=<domain>`);
  return validate(flag.slice("--domain=".length));
}

/* ------------------------------------------------------------------ vhost */

/** The managed block for one redirect, indented the way the panel indents. */
export function redirectBlock(redirect: Redirect): string {
  const target = redirect.preservePath ? `${redirect.target}$request_uri` : redirect.target;
  return `  ${BLOCK_START}\n  location ~ ^/ {\n    return ${redirect.code} ${target};\n  }\n  ${BLOCK_END}\n`;
}

/** The redirect a vhost or stored template already carries, if any. */
export function readRedirectBlock(content: string): { target: string; code: 301 | 302; preservePath: boolean } | null {
  const block = content.match(BLOCK_RE)?.[0];
  const parsed = block?.match(RETURN_RE);
  if (!parsed) return null;
  const preservePath = parsed[2]!.endsWith("$request_uri");
  return {
    code: Number(parsed[1]) as 301 | 302,
    preservePath,
    target: preservePath ? parsed[2]!.slice(0, -"$request_uri".length) : parsed[2]!,
  };
}

export function withoutRedirectBlock(content: string): string {
  return content.replace(BLOCK_RE_ALL, "");
}

/**
 * Puts the block back where it belongs, whatever was there before. Refuses a
 * vhost without CloudPanel's `.well-known` block rather than patch against
 * markup this addon does not recognise -- which is also the block that keeps
 * the redirect site's certificate renewable.
 */
export function withRedirectBlock(content: string, redirect: Redirect): string {
  const stripped = withoutRedirectBlock(content);
  const anchor = stripped.match(WELL_KNOWN_RE);
  if (!anchor || anchor.index === undefined) {
    failAction("the site's Nginx vhost has no CloudPanel .well-known block to place the redirect after");
  }
  const cut = anchor.index + anchor[0].length;
  return `${stripped.slice(0, cut)}\n${redirectBlock(redirect)}${stripped.slice(cut)}`;
}

/* ------------------------------------------------------------------ state */

function emptyState(): StateFile {
  return { version: STATE_VERSION, redirects: [] };
}

function validRedirect(value: unknown): value is Redirect {
  const item = value as Partial<Redirect> | null;
  return typeof item === "object" && item !== null && typeof item.domain === "string" &&
    typeof item.target === "string" && (item.code === 301 || item.code === 302) &&
    typeof item.preservePath === "boolean";
}

function readState(path: string, expectedUid: number): StateFile {
  if (!existsSync(path)) return emptyState();
  let raw: unknown;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== expectedUid || (stat.mode & 0o022) !== 0) {
      failAction("the redirects state file is not a trusted regular file");
    }
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    failAction(`the redirects state could not be read: ${errorMessage(error)}`);
  }
  const state = raw as Partial<StateFile> | null;
  if (typeof state !== "object" || state === null || state.version !== STATE_VERSION ||
    !Array.isArray(state.redirects) || !state.redirects.every(validRedirect)) {
    failAction("the redirects state is malformed");
  }
  return { version: STATE_VERSION, redirects: [...state.redirects].sort((a, b) => a.domain.localeCompare(b.domain)) };
}

function writeState(path: string, state: StateFile, expectedUid: number): void {
  let uid = expectedUid;
  let gid = process.getgid?.() ?? 0;
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== expectedUid || (stat.mode & 0o022) !== 0) {
      failAction("the redirects state file is not a trusted regular file");
    }
    uid = stat.uid;
    gid = stat.gid;
  }
  const sorted = { version: STATE_VERSION, redirects: [...state.redirects].sort((a, b) => a.domain.localeCompare(b.domain)) };
  writeAtomicOwned(path, `${JSON.stringify(sorted, null, 2)}\n`, 0o600, uid, gid);
}

/* ------------------------------------------------------------------ panel */

function siteRows(db: Database): SiteRow[] {
  try {
    return db.query<SiteRow, []>("SELECT domain_name, type, vhost_template FROM site ORDER BY domain_name;")
      .all()
      .map((row) => ({
        domain_name: String(row.domain_name),
        type: String(row.type),
        vhost_template: String(row.vhost_template),
      }));
  } catch (error) {
    failAction(`CloudPanel's site table could not be read: ${errorMessage(error)}`);
  }
}

async function withRedirectsLock<T>(paths: RedirectsActionPaths, body: () => Promise<T>): Promise<T> {
  mkdirSync(dirname(paths.lockFile), { recursive: true });
  chmodSync(dirname(paths.lockFile), 0o700);
  return withFileLock(paths.lockFile, 30, "another redirect operation is running", body);
}

function vhostPath(paths: RedirectsActionPaths, domain: string): string {
  return join(paths.nginxVhostDir, `${domain}.conf`);
}

/**
 * Writes the stored template and the rendered vhost together, then validates
 * and reloads once.
 *
 * Both, because they are two different losses: the panel regenerates the file
 * from `site.vhost_template` whenever it touches the site, so a file-only
 * change disappears at the next certificate install, and a column-only change
 * leaves Nginx serving the old text until something else regenerates it.
 */
async function applyToSite(
  paths: RedirectsActionPaths,
  domain: string,
  transform: (content: string) => string,
  command: (command: string, args: string[]) => CommandResult,
): Promise<void> {
  const db = openPanelDatabase(paths.panelDb);
  const backups: VhostBackup[] = [];
  let wroteVhost = false;
  let attemptedReload = false;
  try {
    db.exec("BEGIN IMMEDIATE;");
    const site = siteRows(db).find((row) => row.domain_name === domain);
    if (!site) failAction(`no CloudPanel site found for ${domain}`);
    if (site.type !== "static") {
      failAction(`${domain} is a ${site.type} site; a redirect replaces what a site serves, so only static sites take one`);
    }

    const backup = trustedVhost(vhostPath(paths, domain), paths.vhostUid);
    backups.push(backup);
    const vhost = transform(backup.content);
    const template = transform(site.vhost_template);

    db.query("UPDATE site SET vhost_template = ?, updated_at = CURRENT_TIMESTAMP WHERE domain_name = ?;")
      .run(template, domain);
    if (vhost !== backup.content) {
      writeAtomicOwned(backup.path, vhost, backup.mode, backup.uid, backup.gid);
      wroteVhost = true;
    }

    const checked = command(paths.nginx, ["-t"]);
    if (!checked.ok) throw new Error(commandError("Nginx validation", checked));
    const reloaded = command(paths.systemctl, ["reload", "nginx"]);
    attemptedReload = true;
    if (!reloaded.ok) throw new Error(commandError("Nginx reload", reloaded));
    db.exec("COMMIT;");
  } catch (error) {
    const failures: string[] = [];
    try {
      db.exec("ROLLBACK;");
    } catch (rollbackError) {
      failures.push(`database transaction: ${errorMessage(rollbackError)}`);
    }
    if (wroteVhost) {
      failures.push(...restoreVhosts(backups));
      let valid = false;
      try {
        const restored = command(paths.nginx, ["-t"]);
        valid = restored.ok;
        if (!restored.ok) failures.push(commandError("Nginx rollback validation", restored));
      } catch (validationError) {
        failures.push(`Nginx rollback validation failed: ${errorMessage(validationError)}`);
      }
      if (valid && attemptedReload) {
        try {
          const reloaded = command(paths.systemctl, ["reload", "nginx"]);
          if (!reloaded.ok) failures.push(commandError("Nginx rollback reload", reloaded));
        } catch (reloadError) {
          failures.push(`Nginx rollback reload failed: ${errorMessage(reloadError)}`);
        }
      }
    }
    throw withRecoveryFailures(error, "rollback failed", failures);
  } finally {
    db.close();
  }
}

/* ------------------------------------------------------------------ verbs */

function listState(paths: RedirectsActionPaths): RedirectsState {
  const state = readState(paths.stateFile, paths.stateUid);
  const db = openPanelDatabase(paths.panelDb);
  let sites: SiteRow[];
  try {
    sites = siteRows(db);
  } finally {
    db.close();
  }
  const bySite = new Map(sites.map((row) => [row.domain_name, row]));
  return {
    redirects: state.redirects.map((redirect) => {
      const site = bySite.get(redirect.domain);
      const wanted = redirectBlock(redirect).trim();
      let applied = false;
      if (site) {
        const file = existsSync(vhostPath(paths, redirect.domain))
          ? readFileSync(vhostPath(paths, redirect.domain), "utf8")
          : "";
        applied = site.vhost_template.includes(wanted) && file.includes(wanted);
      }
      return { ...redirect, type: site?.type ?? "", applied };
    }),
  };
}

/**
 * Changes what one site redirects to, and records it.
 *
 * The record is written after the site, so a site is never promised a redirect
 * it did not get. That leaves one window: a record that cannot be written once
 * the site already carries the redirect. The site is put back to what the
 * record still says rather than left redirecting somewhere nothing knows
 * about -- `list` would not show it, `clear` would refuse it, and repair would
 * not keep it.
 *
 * The caller holds the lock. `create` needs the same lock across site creation
 * as well, and this lock is not reentrant.
 */
async function writeRedirect(
  paths: RedirectsActionPaths,
  domain: string,
  redirect: Redirect | null,
  command: (command: string, args: string[]) => CommandResult,
): Promise<void> {
  const state = readState(paths.stateFile, paths.stateUid);
  const previous = state.redirects.find((item) => item.domain === domain) ?? null;
  const transform = (value: Redirect | null) =>
    value ? (content: string) => withRedirectBlock(content, value) : withoutRedirectBlock;

  await applyToSite(paths, domain, transform(redirect), command);
  try {
    state.redirects = redirect
      ? [...state.redirects.filter((item) => item.domain !== domain), redirect]
      : state.redirects.filter((item) => item.domain !== domain);
    writeState(paths.stateFile, state, paths.stateUid);
  } catch (error) {
    const failures: string[] = [];
    try {
      await applyToSite(paths, domain, transform(previous), command);
    } catch (rollbackError) {
      failures.push(errorMessage(rollbackError));
    }
    throw withRecoveryFailures(error, "site rollback failed", failures);
  }
}

async function saveRedirect(
  paths: RedirectsActionPaths,
  redirect: Redirect,
  command: (command: string, args: string[]) => CommandResult,
): Promise<RedirectsState> {
  return withRedirectsLock(paths, async () => {
    await writeRedirect(paths, redirect.domain, redirect, command);
    return listState(paths);
  });
}

async function clearRedirect(
  paths: RedirectsActionPaths,
  domain: string,
  command: (command: string, args: string[]) => CommandResult,
): Promise<RedirectsState> {
  return withRedirectsLock(paths, async () => {
    if (!readState(paths.stateFile, paths.stateUid).redirects.some((item) => item.domain === domain)) {
      failAction(`${domain} has no redirect`);
    }
    await writeRedirect(paths, domain, null, command);
    return listState(paths);
  });
}

/**
 * Creates the CloudPanel site the redirect lives in, then applies the
 * redirect. The site user is derived from the domain the way every other addon
 * derives one, and its password is random and never reported: nothing signs in
 * to a site that only redirects.
 *
 * The lock covers the whole lifecycle, not just the write. Taking it only for
 * the write left the check, the creation and the rollback outside it, so a
 * `set` arriving in between could configure the new site and then have it
 * deleted underneath by this rollback.
 */
async function createRedirect(
  paths: RedirectsActionPaths,
  redirect: Redirect,
  command: (command: string, args: string[]) => CommandResult,
): Promise<RedirectsState> {
  return withRedirectsLock(paths, async () => {
    const db = openPanelDatabase(paths.panelDb);
    try {
      if (siteRows(db).some((row) => row.domain_name === redirect.domain)) {
        failAction(`${redirect.domain} already exists in CloudPanel; set its redirect instead of creating it`);
      }
    } finally {
      db.close();
    }

    const created = command(paths.clpctl, [
      "site:add:static",
      `--domainName=${redirect.domain}`,
      `--siteUser=${siteUserFor(redirect.domain)}`,
      `--siteUserPassword=${randomBytes(24).toString("base64url")}`,
    ]);
    if (!created.ok) failAction(commandError(`creating the CloudPanel site for ${redirect.domain}`, created));

    try {
      await writeRedirect(paths, redirect.domain, redirect, command);
    } catch (error) {
      // The site is this action's own half-finished work, so it goes away again
      // rather than being left behind serving an empty directory. Only up to
      // here: past this point the redirect is recorded, and deleting the site
      // would leave the record pointing at nothing.
      const failures: string[] = [];
      const removed = command(paths.clpctl, ["site:delete", `--domainName=${redirect.domain}`, "--force"]);
      if (!removed.ok) failures.push(commandError(`removing the CloudPanel site for ${redirect.domain}`, removed));
      throw withRecoveryFailures(error, "site rollback failed", failures);
    }
    return listState(paths);
  });
}

/**
 * Puts back a redirect whose vhost CloudPanel regenerated.
 *
 * The panel rewrites a site's vhost whenever it touches the site -- installing
 * a certificate is the common one -- and a rewrite that does not come from the
 * stored template takes the redirect with it. Nothing else would notice, so
 * repair does, and it reports only the sites it actually put back.
 */
export async function reconcileRedirects(
  paths: RedirectsActionPaths = DEFAULT_REDIRECTS_ACTION_PATHS,
  command: (command: string, args: string[]) => CommandResult = runCommand,
): Promise<ReconcileResult> {
  return withRedirectsLock(paths, async () => {
    const state = readState(paths.stateFile, paths.stateUid);
    if (state.redirects.length === 0) return { repaired: [] };
    const current = listState(paths);
    const repaired: string[] = [];
    for (const view of current.redirects) {
      if (view.applied || view.type === "") continue;
      const redirect: Redirect = {
        domain: view.domain, target: view.target, code: view.code, preservePath: view.preservePath,
      };
      await applyToSite(paths, view.domain, (content) => withRedirectBlock(content, redirect), command);
      repaired.push(view.domain);
    }
    return { repaired };
  });
}

function parseVerb(argv: string[]): RedirectsVerb {
  const verb = argv[0] as RedirectsVerb | undefined;
  if (!verb || !["list", "create", "set", "clear", "reconcile"].includes(verb)) {
    failAction(`unknown redirects action '${verb ?? ""}'`);
  }
  return verb;
}

function requireRoot(): void {
  if (process.getuid?.() !== 0) failAction("redirect actions must run as root");
}

export async function executeRedirectsAction(
  argv: string[],
  options: RedirectsActionOptions = {},
): Promise<unknown> {
  requireRoot();
  const paths = pathsFor(options);
  const command = options.run ?? runCommand;
  const verb = parseVerb(argv);
  if (verb === "list") {
    if (argv.length !== 1) failAction("list takes no arguments");
    return listState(paths);
  }
  if (verb === "reconcile") {
    if (argv.length !== 1) failAction("reconcile takes no arguments");
    return reconcileRedirects(paths, command);
  }
  const domain = parseDomainFlag(
    argv,
    verb,
    options.domainValidator ?? ((value) => validateDomain(value, paths.panelIdentityFile)),
  );
  if (verb === "clear") return clearRedirect(paths, domain, command);
  const redirect = requestedRedirect(domain, options.input);
  return verb === "create"
    ? createRedirect(paths, redirect, command)
    : saveRedirect(paths, redirect, command);
}

export async function runRedirectsAction(argv: string[], options: RedirectsActionOptions = {}): Promise<number> {
  const emit = options.emitReply !== false;
  try {
    const data = await executeRedirectsAction(argv, options);
    if (emit) emitActionOk(data);
    return 0;
  } catch (error) {
    const message = errorMessage(error);
    if (emit) emitActionError(message, error instanceof ActionFailure ? error.data : undefined, "redirects");
    else process.stderr.write(`[redirects] ERROR: ${message}\n`);
    return 1;
  }
}

/**
 * The root half of a terminal: decide whether a shell may be opened, record
 * that it was, and hand the gateway's pipes to `runuser`.
 *
 * Nothing typed in the browser reaches this process. Its stdin and stdout are
 * inherited by `runuser`, which passes them to the helper it starts as the
 * site's user, so the only bytes this side ever writes are its own refusal.
 * The panel user arrives from the gateway, which took it from the CloudPanel
 * session it checked itself; the manager never names it.
 */
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
  ActionFailure, emitActionError, failAction, validateDomain,
} from "../../cli/action-common";
import { CLI_BIN, PANEL_DB } from "../../cli/paths";
import { DUPLEX_WORKER_MARKER } from "../../lib/gateway-protocol";
import { PANEL_USER_NAME_RE, panelUserOwnsSite } from "../../lib/panel-users";
import { readUnixAccounts, siteAccountProblem, splitSharedUids } from "../../lib/site-accounts";

export const PTY_COMMAND = "terminal-pty";
/** The only variables `runuser --login` keeps; the helper reads the last two. */
export const PTY_ENV_NAMES = ["TERM", "CLP_SITE_DIR", "CLP_PTY_SIZE"];
export const MAX_TERMINAL_SIZE = 1000;
/** Below this a uid is a system account, never a site's. */
const MIN_SITE_UID = 1000;
/** How much of what `runuser` and the login wrote to stderr reaches the journal. */
const MAX_LOGGED_STDERR = 4 * 1024;

export interface TerminalActionPaths {
  panelDb: string;
  passwd: string;
  runuser: string;
  /** Where every site's home must be. */
  homes: string;
}

export interface TerminalActionOptions {
  paths?: Partial<TerminalActionPaths>;
  processUid?: number;
  /** Test-only; production always guards against the panel's own hostname. */
  domainValidator?: (value: string) => string;
  /** Test-only child-process override; production uses Bun.spawn. */
  spawn?: typeof Bun.spawn;
  /** Test-only; production reads the gateway's marker from its own environment. */
  env?: Record<string, string | undefined>;
  /** Test-only audit sink; production writes to the gateway's journal. */
  audit?: (line: string) => void;
  now?: () => number;
}

export const DEFAULT_TERMINAL_PATHS: TerminalActionPaths = {
  panelDb: PANEL_DB,
  passwd: "/etc/passwd",
  runuser: "/usr/sbin/runuser",
  homes: "/home",
};

export interface TerminalRequest {
  domain: string;
  panelUser: string;
  cols: number;
  rows: number;
}

export interface TerminalTarget {
  user: string;
  /** Where the shell starts: the site's root, or the home when that is gone. */
  dir: string;
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What reaches the journal: a refusal may quote an argument, and an argument is not ours. */
function printable(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?").slice(0, 300);
}

function dimension(value: string, name: string): number {
  if (!/^\d{1,4}$/.test(value)) failAction(`--${name} must be a whole number`);
  const parsed = Number(value);
  if (parsed < 1 || parsed > MAX_TERMINAL_SIZE) failAction(`--${name} must be between 1 and ${MAX_TERMINAL_SIZE}`);
  return parsed;
}

export function parseTerminalRequest(argv: string[], options: TerminalActionOptions = {}): TerminalRequest {
  const [verb, ...rest] = argv;
  if (verb !== "session") failAction(`unknown terminal verb '${verb ?? ""}'`);
  const values = new Map<string, string>();
  for (const argument of rest) {
    const match = argument.match(/^--(domain|panel-user|cols|rows)=(.*)$/);
    if (!match || values.has(match[1]!)) failAction(`unexpected argument '${argument}'`);
    values.set(match[1]!, match[2]!);
  }
  const panelUser = values.get("panel-user") ?? "";
  if (!PANEL_USER_NAME_RE.test(panelUser)) failAction("missing or invalid --panel-user");
  const domain = (options.domainValidator ?? ((value: string) => validateDomain(value)))(values.get("domain") ?? "");
  return {
    domain,
    panelUser,
    cols: dimension(values.get("cols") ?? "", "cols"),
    rows: dimension(values.get("rows") ?? "", "rows"),
  };
}

interface SiteRow {
  domain_name: string;
  user: string;
  root_directory: string | null;
}

/** Whether a login shell is one that refuses logins. An empty field is /bin/sh. */
function refusesLogin(shell: string): boolean {
  return shell !== "" && (!shell.startsWith("/") || /\/(nologin|false)$/.test(shell));
}

function insideHome(path: string, home: string): boolean {
  return path === home || path.startsWith(`${home}/`);
}

/**
 * The account and directory a shell for this site would run as and in, or a
 * refusal. Every rule is checked here, as root, before anything is started.
 */
export function resolveTerminalTarget(request: TerminalRequest, paths: TerminalActionPaths): TerminalTarget {
  let db: Database;
  try {
    db = new Database(paths.panelDb, { readonly: true });
    db.exec("PRAGMA busy_timeout = 5000;");
  } catch (error) {
    failAction(`CloudPanel database could not be opened: ${reason(error)}`);
  }
  let rows: SiteRow[];
  try {
    if (!panelUserOwnsSite(db, request.panelUser, request.domain)) failAction("that site is not yours to open");
    rows = db.query<SiteRow, []>("SELECT domain_name, user, root_directory FROM site").all();
  } catch (error) {
    if (error instanceof ActionFailure) throw error;
    failAction(`CloudPanel site list could not be read: ${reason(error)}`);
  } finally {
    db.close();
  }

  const row = rows.find((candidate) => candidate.domain_name === request.domain);
  if (!row) failAction(`CloudPanel has no site ${request.domain}`);

  let accounts: ReturnType<typeof readUnixAccounts>;
  try {
    accounts = readUnixAccounts(paths.passwd);
  } catch (error) {
    failAction(`the account database could not be read: ${reason(error)}`);
  }
  const account = accounts.get(row.user);
  if (!account) failAction(`the site user ${row.user} has no Unix account`);
  const problem = siteAccountProblem({ user: row.user, uid: account.uid, gid: account.gid });
  if (problem) failAction(`${request.domain} cannot be opened: ${problem}`);
  if (account.uid < MIN_SITE_UID || account.gid < MIN_SITE_UID) {
    failAction(`${request.domain} cannot be opened: its Unix account is a system account`);
  }
  if (refusesLogin(account.shell)) failAction(`${request.domain} cannot be opened: its Unix user has no login shell`);
  const siteUids = rows.flatMap((site) => {
    const owner = accounts.get(site.user);
    return owner ? [{ uid: owner.uid }] : [];
  });
  if (splitSharedUids(siteUids).shared.some((site) => site.uid === account.uid)) {
    failAction(`${request.domain} cannot be opened: it shares Unix UID ${account.uid} with another site`);
  }

  let home: string;
  try {
    home = realpathSync(account.home);
  } catch {
    failAction(`${request.domain} cannot be opened: its home directory is missing`);
  }
  if (!home.startsWith(`${paths.homes}/`)) failAction(`${request.domain} cannot be opened: its home directory is not under ${paths.homes}`);
  const directory = (row.root_directory ?? "").trim() || row.domain_name;
  if (directory.startsWith("/") || directory.split("/").includes("..")) {
    failAction(`the site root recorded for ${request.domain} is not inside its htdocs`);
  }
  const root = join(home, "htdocs", directory);
  if (!existsSync(root)) return { user: row.user, dir: home };
  const resolved = realpathSync(root);
  if (!insideHome(resolved, home)) failAction(`the site root of ${request.domain} resolves outside its home`);
  return { user: row.user, dir: resolved };
}

/** The one command a terminal runs as root. Fixed; only the user varies. */
export function runuserCommand(paths: TerminalActionPaths, user: string): string[] {
  return [
    paths.runuser,
    "--login",
    `--whitelist-environment=${PTY_ENV_NAMES.join(",")}`,
    `--command=exec ${CLI_BIN} ${PTY_COMMAND}`,
    "--",
    user,
  ];
}

/** Reads a child's stderr as it comes, keeping the first few KiB for when it exits. */
function keepStderr(stream: unknown): () => Promise<string> {
  if (!(stream instanceof ReadableStream)) return async () => "";
  const reader = (stream as ReadableStream<Uint8Array>).getReader();
  const kept: Uint8Array[] = [];
  let size = 0;
  const drained = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (size < MAX_LOGGED_STDERR) kept.push(value.subarray(0, MAX_LOGGED_STDERR - size));
      size += value.byteLength;
    }
  })().catch(() => {});
  return async () => {
    // Something the site started can hold stderr open after runuser has gone.
    await Promise.race([drained, Bun.sleep(200)]);
    void reader.cancel().catch(() => {});
    return Buffer.concat(kept).toString("utf8");
  };
}

function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m${seconds % 60}s` : `${seconds}s`;
}

/**
 * Validate, audit, start the shell and wait for it.
 *
 * SIGTERM from the gateway is passed on to `runuser`, which passes it to the
 * helper, which hangs the shell up. The exit status is the shell's.
 */
export async function runTerminalAction(argv: string[], options: TerminalActionOptions = {}): Promise<number> {
  const audit = options.audit ?? ((line: string) => process.stderr.write(`[terminal] ${line}\n`));
  const now = options.now ?? Date.now;
  let request: TerminalRequest;
  let target: TerminalTarget;
  const paths = { ...DEFAULT_TERMINAL_PATHS, ...options.paths };
  try {
    if ((options.processUid ?? process.getuid?.()) !== 0) failAction("terminal actions must run as root");
    // Only the gateway's duplex stream, which checked the panel session
    // itself, starts a worker with this set.
    if ((options.env ?? process.env)[DUPLEX_WORKER_MARKER] !== "1") failAction("terminal sessions start only through the gateway's stream");
    request = parseTerminalRequest(argv, options);
    target = resolveTerminalTarget(request, paths);
  } catch (error) {
    emitActionError(printable(reason(error)), undefined, "terminal");
    return 1;
  }

  // Listening before the child exists, so a stop that arrives while it starts
  // is passed on rather than ending this process and orphaning the shell.
  let child: ReturnType<typeof Bun.spawn> | null = null;
  let stopped = false;
  const forward = () => {
    stopped = true;
    try { child?.kill("SIGTERM"); } catch {}
  };
  process.on("SIGTERM", forward);
  process.on("SIGHUP", forward);
  process.on("SIGINT", forward);

  const started = now();
  audit(`${request.panelUser} opened ${request.domain} as ${target.user}`);
  child = (options.spawn ?? Bun.spawn)(runuserCommand(paths, target.user), {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "pipe",
    env: {
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      TERM: "xterm-256color",
      CLP_SITE_DIR: target.dir,
      CLP_PTY_SIZE: `${request.cols}x${request.rows}`,
    },
  });
  if (stopped) forward();
  const stderr = keepStderr(child.stderr);
  try {
    const code = await child.exited;
    // Why a shell failed to start is in what runuser or the login wrote. The
    // site wrote some of it, so it is bounded and every line made printable
    // and labelled: it cannot pass for another journal line.
    for (const line of (await stderr()).split("\n")) {
      if (line.trim()) audit(`${request.domain} stderr: ${printable(line)}`);
    }
    const how = child.signalCode ? `signal ${child.signalCode}` : `exit ${code}`;
    audit(`${request.panelUser} closed ${request.domain} as ${target.user} after ${duration(now() - started)}, ${how}`);
    return typeof code === "number" ? code : 1;
  } finally {
    process.off("SIGTERM", forward);
    process.off("SIGHUP", forward);
    process.off("SIGINT", forward);
  }
}

/**
 * Stop every terminal's root worker, which hangs up its shell. Run when the
 * addon is disabled or uninstalled, so taking it away also takes away the
 * shells it opened.
 */
export function endAllTerminals(proc = "/proc"): number {
  let ended = 0;
  for (const pid of readdirSync(proc)) {
    if (!/^\d+$/.test(pid)) continue;
    let argv: string[];
    try {
      argv = readFileSync(`${proc}/${pid}/cmdline`, "utf8").split("\0");
    } catch {
      continue;
    }
    if (argv[0] !== CLI_BIN || argv[1] !== "action" || argv[2] !== "terminal" || argv[3] !== "session") continue;
    try {
      process.kill(Number(pid), "SIGTERM");
      ended++;
    } catch {}
  }
  return ended;
}

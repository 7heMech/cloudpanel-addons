/**
 * The root half of a terminal: decide whether a shell may be opened, record
 * that it was, and hand the gateway's pipes to `runuser`.
 *
 * Nothing typed in the browser reaches this process. Its stdin and stdout are
 * inherited by `runuser`, which passes them to the helper it starts as the
 * site's user, so the only bytes this side ever writes are its own refusal.
 * The panel user arrives from the gateway, which took it from the CloudPanel
 * session it checked itself; the manager never names it.
 *
 * A root shell (`--root`) runs the same way as root, for an administrator root
 * allowed from a shell; see root-access.ts.
 */
import { openPanelDatabase } from "../../lib/panel-db";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { ActionFailure, emitActionError, emitActionOk, failAction } from "../../lib/action";
import { errorMessage } from "../../lib/errors";
import { validateDomain } from "../../lib/panel-identity";
import { CLI_BIN, PANEL_DB } from "../../lib/paths";
import { DUPLEX_WORKER_MARKER, SESSION_2FA_ENV } from "../../lib/gateway-protocol";
import { PANEL_USER_NAME_RE, panelUserOwnsSite } from "../../lib/panel-users";
import { readUnixAccounts, siteAccountProblem, splitSharedUids } from "../../lib/site-accounts";
import { DEFAULT_ROOT_ACCESS_PATHS, rootAccess, type RootAccessPaths } from "./root-access";

export const PTY_COMMAND = "terminal-pty";
/** The only variables `runuser --login` keeps; the helper reads the last two. */
export const PTY_ENV_NAMES = ["TERM", "CLP_SITE_DIR", "CLP_PTY_SIZE", "CLP_ROOT_SHELL"];
export const MAX_TERMINAL_SIZE = 1000;
/** Below this a uid is a system account, never a site's. */
const MIN_SITE_UID = 1000;
/** How much of what `runuser` and the login wrote to stderr reaches the journal. */
const MAX_LOGGED_STDERR = 4 * 1024;
/** How often an open root shell's grant is checked again. */
const ROOT_RECHECK_MS = 15_000;
/** Checks in a row that may fail to read before a root shell ends anyway. */
const ROOT_UNREADABLE_CHECKS = 3;
/** How long a stopped shell has to hang up before it is killed. */
const KILL_AFTER_MS = 5_000;

export interface TerminalActionPaths {
  panelDb: string;
  passwd: string;
  runuser: string;
  /** Where every site's home must be. */
  homes: string;
  /** Who may open a root shell. */
  rootAccess: RootAccessPaths;
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
  /** Test-only; production checks a root shell's grant every 15 seconds. */
  rootRecheckMs?: number;
  /** Test-only; production kills a stopped shell after 5 seconds. */
  killAfterMs?: number;
}

export const DEFAULT_TERMINAL_PATHS: TerminalActionPaths = {
  panelDb: PANEL_DB,
  passwd: "/etc/passwd",
  runuser: "/usr/sbin/runuser",
  homes: "/home",
  rootAccess: DEFAULT_ROOT_ACCESS_PATHS,
};

export interface TerminalRequest {
  /** Null for a root shell on the server itself. */
  domain: string | null;
  panelUser: string;
  cols: number;
  rows: number;
}

export interface TerminalTarget {
  user: string;
  /** Where the shell starts: the site's root, or the home when that is gone. */
  dir: string;
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
    const match = argument === "--root" ? ["", "root", ""] : argument.match(/^--(domain|panel-user|cols|rows)=(.*)$/);
    if (!match || values.has(match[1]!)) failAction(`unexpected argument '${argument}'`);
    values.set(match[1]!, match[2]!);
  }
  const panelUser = values.get("panel-user") ?? "";
  if (!PANEL_USER_NAME_RE.test(panelUser)) failAction("missing or invalid --panel-user");
  if (values.has("root") && values.has("domain")) failAction("--root takes no --domain");
  const domain = values.has("root") ? null : (options.domainValidator ?? ((value: string) => validateDomain(value)))(values.get("domain") ?? "");
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
export function resolveTerminalTarget(request: TerminalRequest, paths: TerminalActionPaths, session = "0"): TerminalTarget {
  if (request.domain === null) return rootTarget(request.panelUser, paths, session);
  const db = openPanelDatabase(paths.panelDb, true);
  let rows: SiteRow[];
  try {
    if (!panelUserOwnsSite(db, request.panelUser, request.domain)) failAction("that site is not yours to open");
    rows = db.query<SiteRow, []>("SELECT domain_name, user, root_directory FROM site").all();
  } catch (error) {
    if (error instanceof ActionFailure) throw error;
    failAction(`CloudPanel site list could not be read: ${errorMessage(error)}`);
  } finally {
    db.close();
  }

  const row = rows.find((candidate) => candidate.domain_name === request.domain);
  if (!row) failAction(`CloudPanel has no site ${request.domain}`);

  let accounts: ReturnType<typeof readUnixAccounts>;
  try {
    accounts = readUnixAccounts(paths.passwd);
  } catch (error) {
    failAction(`the account database could not be read: ${errorMessage(error)}`);
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

/** A root shell, in root's home, for an administrator root allowed. */
function rootTarget(panelUser: string, paths: TerminalActionPaths, session: string): TerminalTarget {
  const access = rootAccess(panelUser, paths.rootAccess, session);
  if (!access.granted) failAction("root has not allowed you a root shell");
  if (access.problem) failAction(access.problem);
  let home = "/root";
  try {
    home = readUnixAccounts(paths.passwd).get("root")?.home || home;
  } catch {}
  return { user: "root", dir: home };
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
  // Set by the gateway from the panel session the request came with.
  const session = (options.env ?? process.env)[SESSION_2FA_ENV] ?? "0";
  try {
    if ((options.processUid ?? process.getuid?.()) !== 0) failAction("terminal actions must run as root");
    if (argv[0] === "root-access") return answerRootAccess(argv.slice(1), paths, session);
    // Only the gateway's duplex stream, which checked the panel session
    // itself, starts a worker with this set.
    if ((options.env ?? process.env)[DUPLEX_WORKER_MARKER] !== "1") failAction("terminal sessions start only through the gateway's stream");
    request = parseTerminalRequest(argv, options);
    target = resolveTerminalTarget(request, paths, session);
  } catch (error) {
    emitActionError("terminal", printable(errorMessage(error)));
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
  const what = request.domain ?? "a root shell";
  audit(`${request.panelUser} opened ${what} as ${target.user}`);
  child = (options.spawn ?? Bun.spawn)(runuserCommand(paths, target.user), {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "pipe",
    env: {
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      TERM: "xterm-256color",
      CLP_SITE_DIR: target.dir,
      CLP_PTY_SIZE: `${request.cols}x${request.rows}`,
      // The helper refuses to run as root without it, so only a root shell does.
      ...(request.domain === null ? { CLP_ROOT_SHELL: "1" } : {}),
    },
  });
  if (stopped) forward();
  // The gateway already ends the stream when the panel session goes; a root
  // shell also ends when its grant does. A read that fails, such as while
  // CloudPanel holds its database, is given a few more checks first.
  let unreadable = 0;
  let killer: ReturnType<typeof setTimeout> | null = null;
  const recheck = request.domain !== null ? null : setInterval(() => {
    const access = rootAccess(request.panelUser, paths.rootAccess, session);
    if (access.granted && !access.problem) {
      unreadable = 0;
      return;
    }
    if (access.unreadable && ++unreadable < ROOT_UNREADABLE_CHECKS) return;
    clearInterval(recheck!);
    audit(`${request.panelUser}'s root shell ended: ${printable(access.problem ?? "root no longer allows it")}`);
    forward();
    // A shell that does not hang up is killed; closing the stream then ends the helper.
    killer = setTimeout(() => { try { child?.kill("SIGKILL"); } catch {} }, options.killAfterMs ?? KILL_AFTER_MS);
  }, options.rootRecheckMs ?? ROOT_RECHECK_MS);
  const stderr = keepStderr(child.stderr);
  try {
    const code = await child.exited;
    // Why a shell failed to start is in what runuser or the login wrote. The
    // site wrote some of it, so it is bounded and every line made printable
    // and labelled: it cannot pass for another journal line.
    for (const line of (await stderr()).split("\n")) {
      if (line.trim()) audit(`${request.domain ?? "root shell"} stderr: ${printable(line)}`);
    }
    const how = child.signalCode ? `signal ${child.signalCode}` : `exit ${code}`;
    audit(`${request.panelUser} closed ${what} as ${target.user} after ${duration(now() - started)}, ${how}`);
    return typeof code === "number" ? code : 1;
  } finally {
    if (recheck) clearInterval(recheck);
    if (killer) clearTimeout(killer);
    process.off("SIGTERM", forward);
    process.off("SIGHUP", forward);
    process.off("SIGINT", forward);
  }
}

/** Whether the signed-in administrator may open a root shell, for the Terminal page. */
function answerRootAccess(argv: string[], paths: TerminalActionPaths, session: string): number {
  const panelUser = argv.length === 1 && argv[0]!.startsWith("--panel-user=") ? argv[0]!.slice("--panel-user=".length) : "";
  if (!PANEL_USER_NAME_RE.test(panelUser)) {
    emitActionError("terminal", "missing or invalid --panel-user");
    return 1;
  }
  emitActionOk(rootAccess(panelUser, paths.rootAccess, session));
  return 0;
}

/**
 * Stop every terminal's root worker, which hangs up its shell. Run when the
 * addon is disabled, so taking it away also takes away the
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

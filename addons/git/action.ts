// The privileged half of the Git addon: per-site configuration, the site's
// deploy key, and the deployment itself.
//
// Everything that touches a site's files runs as that site's user through
// `runuser`. Root reads the panel database to learn which user that is and
// writes this addon's own records; it never runs git, ssh-keygen or an
// operator's post-deploy command itself, so a repository cannot arrive with
// root's privileges attached to it.

import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import {
  existsSync, lstatSync, mkdirSync, openSync, closeSync, fstatSync, readFileSync, readdirSync,
  rmSync, statSync, chmodSync, writeSync, constants as fsConstants,
} from "node:fs";
import { join } from "node:path";
import { CLI_BIN } from "../../cli/paths";
import { writeFileAtomic } from "../../lib/atomic-write";
import { secretEquals } from "../../lib/secret-equals";
import {
  createJobDir, createJobLog, jobCommonFields, jobDir as storeJobDir, jobGet, jobSet, jobTimestamp,
  listJobIds, newJobId, pruneJobs, readJobLog, startJobUnit, watchJobRecord,
} from "../../cli/job-store";
import {
  ActionCommandFailure, ActionFailure, acquireFileLock, emitActionError, emitActionOk, failAction,
  PANEL_IDENTITY_PATH, readable, runCommand, validateDomain, validateJob,
  type FileLockHandle,
} from "../../cli/action-common";

const JOB_RETENTION_DAYS = 14;

/** Bounds on the stored configuration; every one of these reaches a command line. */
export const MAX_REMOTE_LENGTH = 512;
export const MAX_BRANCH_LENGTH = 255;
export const MAX_DIRECTORY_LENGTH = 255;
export const MAX_POST_DEPLOY_LENGTH = 512;

/** How long a fetch or a post-deploy command may run before it is killed. */
const GIT_TIMEOUT_MS = 10 * 60 * 1000;

/** The deploy key's name under the site user's `.ssh`, and its bound when read back. */
const KEY_NAME = "clp-addons-deploy";
const MAX_PUBLIC_KEY_BYTES = 4096;

/** The shape of a push-to-deploy token: 32 random bytes, base64url. */
export const WEBHOOK_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
/**
 * The largest delivery this addon reads. A push payload is a few kilobytes and
 * GitHub caps its own at 25 MB, so this is generous; the manager holds the same
 * bound and this is the outer one, since the body arrives JSON-escaped inside
 * the payload the manager sends.
 */
export const MAX_HOOK_BODY_BYTES = 128 * 1024;
const MAX_HOOK_INPUT_BYTES = 4 * MAX_HOOK_BODY_BYTES;

export type GitVerb =
  | "sites" | "domains" | "status" | "configure" | "forget" | "keygen"
  | "webhook-enable" | "webhook-disable" | "hook"
  | "deploy" | "run" | "job" | "jobs" | "watch-job" | "prune";

export interface GitActionPaths {
  dataDir: string;
  sitesDir: string;
  jobsDir: string;
  lockDir: string;
  panelDb: string;
  panelIdentityFile: string;
  actionBinary: string;
  /** Where site users' home directories live; overridden by the tests. */
  homeDir: string;
  /** How a command is run as the site user; overridden by the tests. */
  runuser: string;
  emitReply?: boolean;
}

export const DEFAULT_GIT_ACTION_PATHS: GitActionPaths = {
  dataDir: "/var/lib/clp-addons/git",
  sitesDir: "/var/lib/clp-addons/git/sites",
  jobsDir: "/var/lib/clp-addons/git/jobs",
  lockDir: "/run/lock/clp-addons",
  panelDb: "/home/clp/htdocs/app/data/db.sq3",
  panelIdentityFile: PANEL_IDENTITY_PATH,
  actionBinary: CLI_BIN,
  homeDir: "/home",
  runuser: "runuser",
};

export interface GitActionOptions {
  paths?: Partial<GitActionPaths>;
  emitReply?: boolean;
  /** Test-only process identity override; CLI and gateway callers omit it. */
  rootUid?: number;
  /** Test-only validator override for fixtures that cannot own a root-owned identity file. */
  domainValidator?: (value: string) => string;
  /** The settings `configure` takes; read from stdin when the caller passes none. */
  input?: string;
  /**
   * Test-only remote validator. Production always uses `validateRemote`, which
   * accepts nothing a fixture can serve from a temporary directory.
   */
  remoteValidator?: (value: unknown) => string;
}

/**
 * Push-to-deploy for one site: the token that stands in its URL, and what the
 * last delivery did, so the page can say whether the repository is reaching us.
 */
export interface GitWebhook {
  token: string;
  lastDeliveryAt: string;
  lastDelivery: string;
  /** The deployment the last delivery started, when it started one. */
  lastDeliveryJob: string;
}

/** What an operator saves for one site. */
export interface GitSiteConfig {
  domain: string;
  remote: string;
  branch: string;
  /** Subdirectory of the site's own directory, "" for the site directory itself. */
  directory: string;
  postDeploy: string;
  updatedAt: string;
  /** null when push-to-deploy is off, which is how a site starts. */
  webhook: GitWebhook | null;
}

/**
 * What one webhook delivery asks of this action.
 *
 * The manager is transport: it hands over the bytes the repository sent and the
 * one header that qualifies them, and reads nothing out of the body itself.
 * Which ref was pushed is decided here, where the token has just been checked,
 * so what is acted on is what was authenticated.
 */
export interface GitHookPayload {
  token: string;
  /** GitHub's `X-GitHub-Event`, so a ping is answered rather than deployed. */
  event: string;
  /** The raw payload, "" when there was none or it was over the bound. */
  body: string;
}

export interface GitHookResult {
  deployed: boolean;
  job: string;
  outcome: string;
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  author: string;
  committedAt: string;
  subject: string;
}

export interface GitDeployResult {
  branch: string;
  directory: string;
  commit: GitCommit | null;
  postDeploy: string;
  postDeployRan: boolean;
}

export interface GitJobView {
  id: string;
  kind: string;
  domain: string;
  /** "push" for a deployment a webhook delivery started, "operator" otherwise. */
  startedBy: string;
  state: string;
  step: string;
  error: string;
  createdAt: string;
  startedAt: string;
  finishedAt: string;
  result: GitDeployResult | null;
}

/** One site's whole state: what is configured, what is checked out, what ran last. */
export interface GitSiteStatus {
  domain: string;
  siteUser: string;
  siteType: string;
  /** The absolute path the repository is checked out into. */
  path: string;
  configured: boolean;
  config: GitSiteConfig | null;
  publicKey: string;
  commit: GitCommit | null;
  lastJob: GitJobView | null;
}

interface ParsedGitAction {
  verb: GitVerb;
  domain: string;
  job: string;
  replace: boolean;
}

interface SiteRow {
  user: string;
  type: string;
}

function pathsFor(options?: GitActionOptions): GitActionPaths {
  const base = { ...DEFAULT_GIT_ACTION_PATHS, ...options?.paths };
  // sites/ and jobs/ live under the state directory, so a test that moves the
  // state directory alone must not leave them pointing at the installed one.
  if (options?.paths?.dataDir && !options.paths.sitesDir) base.sitesDir = join(base.dataDir, "sites");
  if (options?.paths?.dataDir && !options.paths.jobsDir) base.jobsDir = join(base.dataDir, "jobs");
  return { ...base, emitReply: options?.emitReply !== false };
}

function emitOk(paths: GitActionPaths, data: unknown): void {
  if (paths.emitReply !== false) emitActionOk(data);
}

function requireRoot(options: GitActionOptions): void {
  if ((options.rootUid ?? process.getuid?.()) !== 0) failAction("git actions must run as root");
}

function parseAction(argv: string[], paths: GitActionPaths, options: GitActionOptions): ParsedGitAction {
  const flat = argv.flatMap((arg) => {
    const separator = arg.indexOf("=");
    return arg.startsWith("--") && separator !== -1
      ? [arg.slice(0, separator), arg.slice(separator + 1)]
      : [arg];
  });
  const verb = flat[0] as GitVerb | undefined;
  if (!verb) {
    failAction("usage: clp-addons action git {sites|domains|status|configure|forget|keygen|webhook-enable|webhook-disable|hook|deploy|run|job|jobs|watch-job|prune} [options]");
  }

  let domain = "";
  let job = "";
  let replace = false;
  for (let i = 1; i < flat.length; i++) {
    const flag = flat[i]!;
    if (flag === "--replace") {
      replace = true;
      continue;
    }
    if (flag !== "--domain" && flag !== "--job") failAction(`unknown argument: '${flag}'`);
    const value = flat[i + 1];
    if (value === undefined) failAction(`${flag} needs a value`);
    i++;
    if (flag === "--domain") domain = value;
    else job = value;
  }

  const needsDomain: GitVerb[] = [
    "status", "configure", "forget", "keygen", "webhook-enable", "webhook-disable", "hook", "deploy",
  ];
  const needsJob: GitVerb[] = ["run", "job", "watch-job"];
  const takesNothing: GitVerb[] = ["sites", "domains", "jobs", "prune"];

  if (needsDomain.includes(verb)) {
    if (job) failAction(`${verb} takes only --domain`);
    if (replace && verb !== "keygen" && verb !== "webhook-enable") {
      failAction("--replace applies only to keygen and webhook-enable");
    }
    domain = options.domainValidator
      ? options.domainValidator(domain)
      : validateDomain(domain, paths.panelIdentityFile);
  } else if (needsJob.includes(verb)) {
    if (domain || replace) failAction(`${verb} takes only --job`);
    job = validateJob(job);
  } else if (takesNothing.includes(verb)) {
    if (domain || job || replace) failAction(`${verb} takes no arguments`);
  } else {
    failAction(`unknown verb: '${verb}'`);
  }

  return { verb, domain, job, replace };
}

/* ------------------------------------------------------------------ values */

/**
 * What this addon will hand to `git remote add`.
 *
 * HTTPS and SSH only: a `file://`, `ext::` or bare local path remote would make
 * a site's deployment read whatever the site user can reach on this host, and
 * plain HTTP would carry the fetch in the clear. Userinfo is refused in an
 * HTTPS URL too -- a token pasted into the form would be stored in this addon's
 * config file and printed back into the page; the site's own deploy key is what
 * a private repository is meant to use.
 */
export function validateRemote(value: unknown): string {
  if (typeof value !== "string") failAction("the repository URL must be a string");
  const remote = value.trim();
  if (!remote) failAction("enter the repository URL");
  if (remote.length > MAX_REMOTE_LENGTH) failAction(`the repository URL may be at most ${MAX_REMOTE_LENGTH} characters`);
  if (remote.startsWith("-")) failAction("the repository URL may not start with '-'");
  if (!/^[A-Za-z0-9._~:/@%+-]+$/.test(remote)) failAction("the repository URL contains a character this addon will not put on a command line");
  if (remote.includes("..")) failAction("the repository URL may not contain '..'");

  const scheme = /^([a-z][a-z0-9+.-]*):\/\//.exec(remote)?.[1];
  if (scheme === "https" || scheme === "ssh") {
    const rest = remote.slice(scheme.length + 3);
    const slash = rest.indexOf("/");
    if (slash <= 0) failAction("the repository URL needs a path, such as https://host/owner/repo.git");
    const authority = rest.slice(0, slash);
    const host = authority.includes("@") ? authority.slice(authority.indexOf("@") + 1) : authority;
    if (scheme === "https" && authority.includes("@")) {
      failAction("a username or token in the URL is not accepted; use an SSH remote with this site's deploy key");
    }
    if (!/^[A-Za-z0-9._-]+(:[0-9]{1,5})?$/.test(host)) failAction("the repository URL has no usable hostname");
    return remote;
  }
  if (scheme) failAction(`this addon fetches over https and ssh only, not '${scheme}'`);
  // scp-like: user@host:path, which is what a provider's SSH URL looks like.
  if (!/^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[A-Za-z0-9._~/+-]+$/.test(remote)) {
    failAction("that is not a repository URL this addon recognises; use https://host/owner/repo.git or git@host:owner/repo.git");
  }
  return remote;
}

export function validateBranch(value: unknown): string {
  if (typeof value !== "string") failAction("the branch must be a string");
  const branch = value.trim();
  if (!branch) failAction("enter the branch to deploy");
  if (branch.length > MAX_BRANCH_LENGTH) failAction(`the branch name may be at most ${MAX_BRANCH_LENGTH} characters`);
  if (!/^[A-Za-z0-9._/-]+$/.test(branch)) failAction("that is not a valid branch name");
  // git's own refname rules, for the subset this accepts at all.
  if (branch.startsWith("-") || branch.startsWith("/") || branch.endsWith("/") || branch.endsWith(".")
    || branch.includes("..") || branch.includes("//") || branch.endsWith(".lock")) {
    failAction("that is not a valid branch name");
  }
  return branch;
}

/** A subdirectory of the site's own directory, or "" for the directory itself. */
export function validateDirectory(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") failAction("the target directory must be a string");
  const directory = value.trim().replace(/^\/+|\/+$/g, "");
  if (!directory) return "";
  if (directory.length > MAX_DIRECTORY_LENGTH) failAction(`the target directory may be at most ${MAX_DIRECTORY_LENGTH} characters`);
  const segments = directory.split("/");
  for (const segment of segments) {
    if (!segment || segment === "." || segment === ".." || !/^[A-Za-z0-9._-]+$/.test(segment)) {
      failAction("the target directory must be a plain subdirectory of the site directory");
    }
  }
  return segments.join("/");
}

export function validatePostDeploy(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") failAction("the post-deploy command must be a string");
  const command = value.trim();
  if (!command) return "";
  if (command.length > MAX_POST_DEPLOY_LENGTH) failAction(`the post-deploy command may be at most ${MAX_POST_DEPLOY_LENGTH} characters`);
  // Newlines and control characters: the command is stored in a JSON record and
  // written into the job log, and neither is improved by a carriage return.
  if (/[ -]/.test(command)) failAction("the post-deploy command may not contain a newline or a control character");
  return command;
}

/* ------------------------------------------------------------------- state */

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function ensureState(paths: GitActionPaths): void {
  for (const directory of [paths.dataDir, paths.sitesDir, paths.jobsDir]) {
    if (existsSync(directory)) {
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) failAction(`unsafe git state path: ${directory}`);
    } else {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    chmodSync(directory, 0o700);
  }
}

function configPath(paths: GitActionPaths, domain: string): string {
  return join(paths.sitesDir, `${domain}.json`);
}

function readConfig(paths: GitActionPaths, domain: string): GitSiteConfig | null {
  const path = configPath(paths, domain);
  let raw: string;
  try {
    if (!lstatSync(path).isFile()) return null;
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const remote = stringField(record, "remote");
  const branch = stringField(record, "branch");
  if (!remote || !branch) return null;
  return {
    domain,
    remote,
    branch,
    directory: stringField(record, "directory"),
    postDeploy: stringField(record, "postDeploy"),
    updatedAt: stringField(record, "updatedAt"),
    webhook: readWebhook(record.webhook),
  };
}

function stringField(record: Record<string, unknown>, field: string): string {
  return typeof record[field] === "string" ? (record[field] as string) : "";
}

/** A stored webhook, or null for anything that is not one this addon minted. */
function readWebhook(value: unknown): GitWebhook | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const token = stringField(record, "token");
  if (!WEBHOOK_TOKEN_RE.test(token)) return null;
  return {
    token,
    lastDeliveryAt: stringField(record, "lastDeliveryAt"),
    lastDelivery: stringField(record, "lastDelivery"),
    lastDeliveryJob: stringField(record, "lastDeliveryJob"),
  };
}

function writeConfig(paths: GitActionPaths, config: GitSiteConfig): void {
  writeFileAtomic(configPath(paths, config.domain), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function configuredDomains(paths: GitActionPaths): string[] {
  try {
    return readdirSync(paths.sitesDir)
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => entry.slice(0, -".json".length))
      .sort();
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------- panel */

function siteRow(paths: GitActionPaths, domain: string): SiteRow | null {
  if (!readable(paths.panelDb)) failAction("CloudPanel's site database is unavailable");
  const db = new Database(paths.panelDb, { readonly: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000;");
    const row = db.query("SELECT user, type FROM site WHERE lower(domain_name) = ? LIMIT 1;").get(domain) as
      { user?: unknown; type?: unknown } | null;
    if (!row) return null;
    return {
      user: typeof row.user === "string" ? row.user : "",
      type: typeof row.type === "string" ? row.type : "",
    };
  } catch {
    failAction("CloudPanel's site database could not be read");
  } finally {
    db.close();
  }
}

function requireSite(paths: GitActionPaths, domain: string): SiteRow {
  const row = siteRow(paths, domain);
  if (!row) failAction(`CloudPanel site not found: '${domain}'`);
  if (!row.user) failAction(`${domain} has no site user recorded`);
  // The site user's name comes out of the panel database and then reaches a
  // `runuser -u` argument, so it is checked rather than trusted.
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(row.user)) failAction(`${domain} records a site user this addon will not run as`);
  return row;
}

/** The site's own directory: where CloudPanel puts a site's files. */
function siteRoot(paths: GitActionPaths, user: string, domain: string): string {
  return join(paths.homeDir, user, "htdocs", domain);
}

function deployPath(paths: GitActionPaths, user: string, domain: string, directory: string): string {
  const root = siteRoot(paths, user, domain);
  return directory ? join(root, directory) : root;
}

/* ---------------------------------------------------------------- commands */

let activeTranscript: JobTranscript | null = null;

function diagnostic(value: string): void {
  if (activeTranscript) activeTranscript.write(value);
  else process.stderr.write(value);
}

function logLine(value: string): void {
  diagnostic(`[git] ${value}\n`);
}

class JobTranscript {
  private fd: number;

  constructor(readonly path: string) {
    this.fd = openSync(path, "a", 0o600);
    chmodSync(path, 0o600);
  }

  write(value: string): void {
    try {
      writeSync(this.fd, Buffer.from(value));
    } catch {
      // A transcript write must never put the job's output on the journal.
    }
  }

  close(): void {
    closeSync(this.fd);
  }
}

/**
 * The argv that runs `command` as the site user.
 *
 * `env HOME=` because git reads its user configuration from it and `runuser`
 * without `-l` keeps root's, and `GIT_TERMINAL_PROMPT=0` because a remote that
 * wants a password must fail rather than wait for one nobody will type.
 */
function asSiteUser(paths: GitActionPaths, user: string, command: string, args: string[], keyPath?: string): string[] {
  const environment = [
    `HOME=${join(paths.homeDir, user)}`,
    "GIT_TERMINAL_PROMPT=0",
    "GIT_CONFIG_NOSYSTEM=1",
  ];
  if (keyPath) {
    // IdentitiesOnly so an agent or another key in the user's .ssh is not tried
    // instead, and accept-new so the first fetch does not stop on a host key
    // nobody is at a terminal to confirm.
    environment.push(
      `GIT_SSH_COMMAND=ssh -i ${keyPath} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o BatchMode=yes`,
    );
  }
  return ["-u", user, "--", "env", ...environment, command, ...args];
}

function runAsSiteUser(
  paths: GitActionPaths, user: string, command: string, args: string[], keyPath?: string,
): { ok: boolean; stdout: string; stderr: string } {
  return runCommand(paths.runuser, asSiteUser(paths, user, command, args, keyPath));
}

/**
 * Run a command as the site user with its output going into the job log as it
 * arrives, rather than in one piece when it exits.
 *
 * A fetch of a large repository says nothing for a minute or two otherwise, and
 * a log that appears only at the end cannot be watched.
 */
async function streamAsSiteUser(
  paths: GitActionPaths, user: string, command: string, args: string[],
  options: { keyPath?: string; cwd?: string } = {},
): Promise<boolean> {
  const child = Bun.spawn([paths.runuser, ...asSiteUser(paths, user, command, args, options.keyPath)], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    ...(options.cwd ? { cwd: options.cwd } : {}),
    env: process.env,
    timeout: GIT_TIMEOUT_MS,
  });
  const pump = async (stream: ReadableStream<Uint8Array> | null): Promise<void> => {
    if (!stream) return;
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      diagnostic(Buffer.from(value).toString("utf8"));
    }
  };
  const [, , exitCode] = await Promise.all([
    pump(child.stdout as ReadableStream<Uint8Array> | null),
    pump(child.stderr as ReadableStream<Uint8Array> | null),
    child.exited,
  ]);
  return exitCode === 0;
}

/* --------------------------------------------------------------- deploy key */

/** Whether this remote is fetched with the site's deploy key rather than HTTPS. */
export function usesDeployKey(remote: string): boolean {
  return !remote.startsWith("https://");
}

function keyPathFor(paths: GitActionPaths, user: string): string {
  return join(paths.homeDir, user, ".ssh", KEY_NAME);
}

/**
 * Read back the public half of a key the site user owns.
 *
 * Root is reading a file inside a home directory the site user controls, so it
 * is opened without following a symlink, checked to be that user's own regular
 * file, bounded, and required to look like the ed25519 public key it claims to
 * be. Anything else reads as "no key" rather than as a line printed into the
 * panel.
 */
function readPublicKey(paths: GitActionPaths, user: string): string {
  const path = `${keyPathFor(paths, user)}.pub`;
  const expected = userUid(user);
  if (expected === null) return "";
  let fd: number | undefined;
  try {
    // O_NOFOLLOW, and every check made on the descriptor that was opened: a
    // symlink or a file swapped in between a stat and a read would otherwise
    // decide what this prints into the panel.
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== expected || stat.size > MAX_PUBLIC_KEY_BYTES) return "";
    const text = readFileSync(fd, "utf8").trim();
    return /^ssh-ed25519 [A-Za-z0-9+/=]+(\s\S.*)?$/.test(text) ? text : "";
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
  }
}

function userUid(user: string): number | null {
  const result = runCommand("id", ["-u", user]);
  if (!result.ok) return null;
  const uid = Number.parseInt(result.stdout.trim(), 10);
  return Number.isInteger(uid) ? uid : null;
}

function generateKey(paths: GitActionPaths, user: string, domain: string, replace: boolean): string {
  const path = keyPathFor(paths, user);
  const existing = readPublicKey(paths, user);
  if (existing && !replace) return existing;

  const sshDir = join(paths.homeDir, user, ".ssh");
  const made = runAsSiteUser(paths, user, "mkdir", ["-p", "-m", "700", sshDir]);
  if (!made.ok) failAction(`could not prepare ${sshDir}: ${made.stderr.trim() || "mkdir failed"}`);
  if (replace) {
    const removed = runAsSiteUser(paths, user, "rm", ["-f", path, `${path}.pub`]);
    if (!removed.ok) failAction("could not remove the existing deploy key");
  }
  const generated = runAsSiteUser(paths, user, "ssh-keygen", [
    "-q", "-t", "ed25519", "-N", "", "-C", `clp-addons deploy key for ${domain}`, "-f", path,
  ]);
  if (!generated.ok) failAction(`ssh-keygen failed: ${generated.stderr.trim() || "no output"}`);
  const created = readPublicKey(paths, user);
  if (!created) failAction("the deploy key was generated but its public half could not be read back");
  return created;
}

/* ------------------------------------------------------------------ commits */

const COMMIT_FORMAT = "%H%x1f%h%x1f%an%x1f%aI%x1f%s";

function readCommit(paths: GitActionPaths, user: string, path: string): GitCommit | null {
  if (!isDirectory(join(path, ".git"))) return null;
  const result = runAsSiteUser(paths, user, "git", ["-C", path, "log", "-1", `--pretty=format:${COMMIT_FORMAT}`]);
  if (!result.ok) return null;
  const [hash, shortHash, author, committedAt, ...subject] = result.stdout.split("");
  if (!hash || !shortHash) return null;
  return {
    hash: hash.trim(),
    shortHash: shortHash.trim(),
    author: (author ?? "").trim(),
    committedAt: (committedAt ?? "").trim(),
    subject: subject.join("").split("\n")[0]!.trim(),
  };
}

/* --------------------------------------------------------------------- jobs */

function jobDir(paths: GitActionPaths, id: string): string {
  return storeJobDir(paths.jobsDir, id);
}

function readJobResult(dir: string): GitDeployResult | null {
  try {
    const raw = readFileSync(join(dir, "result.json"), "utf8").trim();
    return raw ? (JSON.parse(raw) as GitDeployResult) : null;
  } catch {
    // A killed runner can leave a partial result; the record's state and log
    // still say what happened.
    return null;
  }
}

function jobJson(dir: string, id: string): GitJobView {
  return {
    id,
    kind: jobGet(dir, "kind") || "deploy",
    domain: jobGet(dir, "domain"),
    startedBy: jobGet(dir, "startedBy") || "operator",
    ...jobCommonFields(dir),
    result: readJobResult(dir),
  };
}

function jobViews(paths: GitActionPaths): GitJobView[] {
  return listJobIds(paths.jobsDir).map((id) => jobJson(jobDir(paths, id), id));
}

/**
 * The newest job for each site, which is all any page draws.
 *
 * Ids are newest first, and a record is ten small files, so every field of
 * every retained job is read only when `jobs` is asked for the whole list. Here
 * the one field that decides is read, and the rest only for the job that wins.
 */
function latestJobs(paths: GitActionPaths): Map<string, GitJobView> {
  const latest = new Map<string, GitJobView>();
  for (const id of listJobIds(paths.jobsDir)) {
    const dir = jobDir(paths, id);
    const domain = jobGet(dir, "domain");
    if (!domain || latest.has(domain)) continue;
    latest.set(domain, jobJson(dir, id));
  }
  return latest;
}

/* ------------------------------------------------------------------- verbs */

/**
 * One site's whole state. The caller passes the panel row it has already read,
 * because every path here has just looked the site up to decide what to do.
 */
function siteStatus(
  paths: GitActionPaths, domain: string, site: SiteRow, jobs: Map<string, GitJobView>,
): GitSiteStatus {
  const config = readConfig(paths, domain);
  const path = deployPath(paths, site.user, domain, config?.directory ?? "");
  return {
    domain,
    siteUser: site.user,
    siteType: site.type,
    path,
    configured: config !== null,
    config,
    publicKey: readPublicKey(paths, site.user),
    commit: readCommit(paths, site.user, path),
    lastJob: jobs.get(domain) ?? null,
  };
}

function cmdStatus(paths: GitActionPaths, domain: string): void {
  emitOk(paths, { site: siteStatus(paths, domain, requireSite(paths, domain), latestJobs(paths)) });
}

/**
 * Every configured site in one reply.
 *
 * One action call rather than one per site: the fleet page asks this question
 * about the whole list at once, and the gateway starts a process per call.
 */
function cmdSites(paths: GitActionPaths): void {
  const jobs = latestJobs(paths);
  const sites: GitSiteStatus[] = [];
  for (const domain of configuredDomains(paths)) {
    const row = siteRow(paths, domain);
    const status = row?.user
      ? siteStatus(paths, domain, row, jobs)
      // A site deleted from CloudPanel: listed as configured-but-unreadable
      // rather than left out of the page.
      : {
        domain, siteUser: "", siteType: row?.type ?? "", path: "", configured: false,
        config: null, publicKey: "", commit: null, lastJob: jobs.get(domain) ?? null,
      };
    // The fleet page draws no webhook URL, so it is not given the tokens: only
    // the site's own page asks for a record it is going to print.
    sites.push({ ...status, config: withoutToken(status.config) });
  }
  emitOk(paths, { sites });
}

function withoutToken(config: GitSiteConfig | null): GitSiteConfig | null {
  if (!config?.webhook) return config;
  return { ...config, webhook: { ...config.webhook, token: "" } };
}

/**
 * Which sites this addon deploys, and nothing else about them.
 *
 * `sites` answers the fleet page and costs a panel-database read and two
 * subprocesses per site. CloudPanel's own site list asks a much smaller
 * question -- which of these rows should offer the link -- and asks it on a
 * page the panel serves constantly, so it gets the directory listing behind
 * the fleet view rather than the fleet view.
 */
function cmdDomains(paths: GitActionPaths): void {
  emitOk(paths, { domains: configuredDomains(paths).filter((domain) => readConfig(paths, domain) !== null) });
}

async function readSettings(options: GitActionOptions, maxBytes = 8192): Promise<Record<string, unknown>> {
  const raw = options.input !== undefined ? options.input : await Bun.stdin.text();
  if (raw.length > maxBytes) failAction("that configuration is too large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    failAction("configure expects the settings as JSON on stdin");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    failAction("configure expects a JSON object");
  }
  return parsed as Record<string, unknown>;
}

async function cmdConfigure(paths: GitActionPaths, domain: string, options: GitActionOptions): Promise<void> {
  const site = requireSite(paths, domain);
  const body = await readSettings(options);
  const config: GitSiteConfig = {
    domain,
    remote: (options.remoteValidator ?? validateRemote)(body.remote),
    branch: validateBranch(body.branch),
    directory: validateDirectory(body.directory),
    postDeploy: validatePostDeploy(body.postDeploy),
    updatedAt: jobTimestamp(),
    // Editing the repository settings does not revoke a URL already pasted
    // into one; only the switch and Rotate do that.
    webhook: readConfig(paths, domain)?.webhook ?? null,
  };
  // The deploy directory is derived from the site user and a validated
  // subdirectory, so it cannot leave the site's own tree; this checks that the
  // tree itself is there before an operator is told the site is configured.
  const root = siteRoot(paths, site.user, domain);
  if (!isDirectory(root)) failAction(`the site directory ${root} does not exist`);
  writeConfig(paths, config);
  // An SSH remote cannot be fetched without a key, so saving one makes it
  // rather than leaving a button the operator has to find. The settings are
  // already saved, so a box where ssh-keygen fails keeps them and offers the
  // key again on the page.
  if (usesDeployKey(config.remote)) {
    try {
      generateKey(paths, site.user, domain, false);
    } catch (error) {
      if (!(error instanceof ActionFailure)) throw error;
    }
  }
  emitOk(paths, { site: siteStatus(paths, domain, site, latestJobs(paths)) });
}

function cmdForget(paths: GitActionPaths, domain: string): void {
  // The key stays with the site user: this forgets the configuration, and a
  // key removed from here would still be on the provider's repository.
  rmSync(configPath(paths, domain), { force: true });
  emitOk(paths, { domain, configured: false });
}

function cmdKeygen(paths: GitActionPaths, domain: string, replace: boolean): void {
  const site = requireSite(paths, domain);
  const publicKey = generateKey(paths, site.user, domain, replace);
  emitOk(paths, { domain, siteUser: site.user, publicKey });
}

function startDeployment(
  paths: GitActionPaths, domain: string, releaseLock: () => void, startedBy: "operator" | "push",
): string {
  requireSite(paths, domain);
  const config = readConfig(paths, domain);
  if (!config) failAction(`${domain} has no repository configured yet`);

  for (const id of listJobIds(paths.jobsDir)) {
    const dir = jobDir(paths, id);
    if (jobGet(dir, "domain") !== domain) continue;
    const state = jobGet(dir, "state");
    if (state === "queued" || state === "running") failAction(`a deployment of ${domain} is already ${state}`);
  }

  const id = newJobId();
  const dir = createJobDir(paths.jobsDir, id);
  jobSet(dir, "kind", "deploy");
  jobSet(dir, "domain", domain);
  jobSet(dir, "startedBy", startedBy);
  jobSet(dir, "createdAt", jobTimestamp());
  jobSet(dir, "step", "queued");
  jobSet(dir, "state", "queued");
  createJobLog(dir);

  // run takes the same per-site lock; releasing it before the unit starts is
  // what keeps the child from waiting on the process that started it.
  releaseLock();
  const started = startJobUnit({
    addon: "git",
    id,
    description: `clp-addons: deploying ${domain} from git`,
    actionBinary: paths.actionBinary,
  });
  if (started.stdout) diagnostic(started.stdout);
  if (started.stderr) diagnostic(started.stderr);
  if (!started.ok) {
    jobSet(dir, "error", "could not start the deployment job");
    jobSet(dir, "state", "failed");
    failAction("systemd-run refused to start the deployment job");
  }
  return id;
}

function cmdDeploy(paths: GitActionPaths, domain: string, releaseLock: () => void): void {
  emitOk(paths, { job: startDeployment(paths, domain, releaseLock, "operator"), domain });
}

/* ---------------------------------------------------------------- webhooks */

function newWebhookToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Turn push-to-deploy on or off for one site.
 *
 * `--replace` mints a new token for a site that already has one, which is what
 * rotation is; without it an enable is idempotent, the way `keygen` is.
 */
function cmdWebhook(paths: GitActionPaths, domain: string, enable: boolean, replace: boolean): void {
  requireSite(paths, domain);
  const config = readConfig(paths, domain);
  if (!config) failAction(`${domain} has no repository configured yet`);

  // Enabling a site that already has a URL keeps it, the way keygen keeps a key;
  // only --replace, which is what Rotate sends, mints a second one.
  const keep = enable && config.webhook !== null && !replace;
  const webhook = keep ? config.webhook
    : enable ? { token: newWebhookToken(), lastDeliveryAt: "", lastDelivery: "", lastDeliveryJob: "" }
    : null;
  if (!keep && webhook !== config.webhook) writeConfig(paths, { ...config, webhook });
  emitOk(paths, { domain, webhook });
}

/** The ref a push names, for the branch filter. A plain `curl -X POST` has none. */
function pushedRef(body: string): string {
  if (!body.startsWith("{")) return "";
  try {
    const ref = (JSON.parse(body) as { ref?: unknown }).ref;
    return typeof ref === "string" && ref.length <= MAX_BRANCH_LENGTH ? ref : "";
  } catch {
    return "";
  }
}

/** Record what a delivery did, on a record re-read so a concurrent save stands. */
function recordDelivery(paths: GitActionPaths, domain: string, outcome: string, job: string): void {
  const config = readConfig(paths, domain);
  if (!config?.webhook) return;
  writeConfig(paths, {
    ...config,
    webhook: { ...config.webhook, lastDeliveryAt: jobTimestamp(), lastDelivery: outcome, lastDeliveryJob: job },
  });
}

/**
 * One webhook delivery.
 *
 * The token in the URL is the whole authentication for this route, and the
 * manager cannot read the `0600` record that holds it, so checking the token
 * and queueing the deployment are one round trip. Anything that fails before
 * the token matches is an error the manager turns into the gate's own login
 * redirect; everything after it is recorded on the site and answered, because
 * a refusal an operator cannot see is a webhook they cannot fix.
 */
async function cmdHook(
  paths: GitActionPaths, domain: string, options: GitActionOptions, releaseLock: () => void,
): Promise<void> {
  const config = readConfig(paths, domain);
  const payload = await readSettings(options, MAX_HOOK_INPUT_BYTES) as GitHookPayload & Record<string, unknown>;
  const token = typeof payload.token === "string" ? payload.token : "";
  const webhook = config?.webhook;
  if (!config || !webhook || !secretEquals(token, webhook.token)) failAction("no delivery for this site");

  const text = (field: "event" | "body"): string =>
    typeof payload[field] === "string" ? payload[field] : "";
  const ref = pushedRef(text("body"));

  let job = "";
  let outcome: string;
  if (text("event") === "ping") {
    outcome = "the repository's ping arrived; the URL works";
  } else if (ref && ref !== config.branch && ref !== `refs/heads/${config.branch}`) {
    outcome = `ignored: the push was for ${ref}, not ${config.branch}`;
  } else {
    try {
      job = startDeployment(paths, domain, releaseLock, "push");
      outcome = "started a deployment";
    } catch (error) {
      // A delivery that arrives while the last one is still deploying, and a
      // site whose settings stopped being usable, are both reported rather
      // than retried: the repository has already been told the push landed.
      if (!(error instanceof ActionFailure)) throw error;
      outcome = `ignored: ${error.message}`;
    }
  }

  recordDelivery(paths, domain, outcome, job);
  emitOk(paths, { deployed: job !== "", job, outcome } satisfies GitHookResult);
}

class JobFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobFailure";
  }
}

function failJob(dir: string, message: string): never {
  diagnostic(`[git] ERROR: ${message}\n`);
  try {
    jobSet(dir, "error", message);
    jobSet(dir, "state", "failed");
    jobSet(dir, "finishedAt", jobTimestamp());
  } catch {
    // Keep the original failure; a record that cannot be written is already
    // the larger problem.
  }
  throw new JobFailure(message);
}

function setStep(dir: string, value: string): void {
  jobSet(dir, "step", value);
  logLine(value);
}

/**
 * The deployment itself: fetch the configured branch, move the working tree
 * onto it, then run the post-deploy command. Every step runs as the site user.
 *
 * `reset --hard` rather than a clean checkout, and no `git clean`: what is in
 * the repository is replaced, and what the site wrote for itself -- uploads, a
 * `.env`, a cache directory -- is left where it is. A deployment that swept
 * untracked files would take the site's own data with it.
 */
async function cmdRun(paths: GitActionPaths, id: string, options: GitActionOptions): Promise<void> {
  const dir = jobDir(paths, id);
  if (!isDirectory(dir)) failAction(`no such job: ${id}`);
  const transcript = new JobTranscript(join(dir, "log"));
  activeTranscript = transcript;
  try {
    const domain = jobGet(dir, "domain");
    if (!domain) failJob(dir, "the job record names no site");
    const state = jobGet(dir, "state");
    if (state !== "queued") failJob(dir, `job ${id} is ${state}, not queued`);

    let site: SiteRow;
    try {
      site = requireSite(paths, domain);
    } catch (error) {
      failJob(dir, error instanceof Error ? error.message : `CloudPanel site not found: ${domain}`);
    }
    const config = readConfig(paths, domain);
    if (!config) failJob(dir, `${domain} has no repository configured`);
    // The record was validated when it was saved; a record that stopped being
    // valid since -- an older release's, or a file restored from a backup --
    // must fail the job rather than reach a command line unchecked.
    try {
      (options.remoteValidator ?? validateRemote)(config.remote);
      validateBranch(config.branch);
      validateDirectory(config.directory);
      validatePostDeploy(config.postDeploy);
    } catch (error) {
      failJob(dir, error instanceof Error ? error.message : "the saved settings are no longer valid");
    }

    jobSet(dir, "state", "running");
    jobSet(dir, "startedAt", jobTimestamp());

    // The public half is read rather than stat'ed: what decides is whether this
    // account owns a key of the shape this addon generated, which is the same
    // question the panel's key block answers.
    const hasDeployKey = readPublicKey(paths, site.user) !== "";
    const useKey = hasDeployKey ? keyPathFor(paths, site.user) : undefined;
    const target = deployPath(paths, site.user, domain, config.directory);
    const root = siteRoot(paths, site.user, domain);
    if (!isDirectory(root)) failJob(dir, `the site directory ${root} does not exist`);

    logLine(`deploying ${config.remote} (${config.branch}) into ${target} as ${site.user}`);

    if (config.directory && !isDirectory(target)) {
      setStep(dir, "creating the target directory");
      if (!await streamAsSiteUser(paths, site.user, "mkdir", ["-p", target])) {
        failJob(dir, `could not create ${target}`);
      }
    }

    if (!isDirectory(join(target, ".git"))) {
      setStep(dir, "preparing the repository");
      if (!await streamAsSiteUser(paths, site.user, "git", ["-C", target, "init", "-q"])) {
        failJob(dir, `git init failed in ${target}`);
      }
    }

    setStep(dir, "pointing the repository at the remote");
    // set-url on an existing origin, add when there is none: either way the
    // remote is whatever the saved configuration says, not what a previous
    // deployment left behind.
    const existingRemote = runAsSiteUser(paths, site.user, "git", ["-C", target, "remote"]);
    const hasOrigin = existingRemote.ok && existingRemote.stdout.split("\n").some((line) => line.trim() === "origin");
    const pointed = await streamAsSiteUser(paths, site.user, "git",
      ["-C", target, "remote", hasOrigin ? "set-url" : "add", "origin", config.remote]);
    if (!pointed) failJob(dir, "could not set the repository's remote");

    setStep(dir, `fetching ${config.branch}`);
    if (!await streamAsSiteUser(paths, site.user, "git",
      ["-C", target, "fetch", "--prune", "--no-tags", "origin", config.branch], { keyPath: useKey })) {
      failJob(dir, `could not fetch ${config.branch} from the remote; check the URL, the branch and the deploy key`);
    }

    setStep(dir, "updating the working tree");
    if (!await streamAsSiteUser(paths, site.user, "git", ["-C", target, "reset", "--hard", "FETCH_HEAD"])) {
      failJob(dir, "could not move the working tree onto the fetched commit");
    }
    if (!await streamAsSiteUser(paths, site.user, "git",
      ["-C", target, "submodule", "update", "--init", "--recursive"], { keyPath: useKey })) {
      logLine("submodules could not be updated; the rest of the deployment continued");
    }

    const commit = readCommit(paths, site.user, target);
    if (commit) logLine(`now at ${commit.shortHash} ${commit.subject}`);

    let postDeployRan = false;
    if (config.postDeploy) {
      setStep(dir, "running the post-deploy command");
      logLine(`$ ${config.postDeploy}`);
      if (!await streamAsSiteUser(paths, site.user, "bash", ["-c", config.postDeploy], { cwd: target })) {
        failJob(dir, "the post-deploy command failed; the files are deployed and the command did not finish");
      }
      postDeployRan = true;
    }

    const result: GitDeployResult = {
      branch: config.branch,
      directory: config.directory,
      commit,
      postDeploy: config.postDeploy,
      postDeployRan,
    };
    writeFileAtomic(join(dir, "result.json"), `${JSON.stringify(result)}\n`, { mode: 0o600 });
    setStep(dir, "deployed");
    jobSet(dir, "finishedAt", jobTimestamp());
    jobSet(dir, "state", "done");
    logLine("deployment finished");
  } finally {
    activeTranscript = null;
    transcript.close();
  }
}

function cmdJob(paths: GitActionPaths, id: string): void {
  const dir = jobDir(paths, id);
  if (!isDirectory(dir)) failAction(`no such job: ${id}`);
  emitOk(paths, { job: jobJson(dir, id), log: readJobLog(dir) });
}

async function cmdWatchJob(paths: GitActionPaths, id: string): Promise<void> {
  const dir = jobDir(paths, id);
  if (!isDirectory(dir)) failAction(`no such job: ${id}`);
  await watchJobRecord({
    dir,
    read: () => ({ job: jobJson(dir, id), log: readJobLog(dir) }),
    emit: (data) => emitOk(paths, data),
  });
}

function cmdJobs(paths: GitActionPaths): void {
  emitOk(paths, { jobs: jobViews(paths) });
}

function cmdPrune(paths: GitActionPaths): void {
  const { removed, stuck } = pruneJobs({
    addon: "git",
    jobsDir: paths.jobsDir,
    retentionDays: JOB_RETENTION_DAYS,
    stuckMessage: "the deployment stopped without recording a result",
    onStuck: (id, state) =>
      diagnostic(`[git] WARN: job ${id} is recorded as ${state} but nothing is running it; marking it failed\n`),
  });
  emitOk(paths, { removed, stuck });
}

/* ---------------------------------------------------------------- dispatch */

async function dispatch(
  action: ParsedGitAction, paths: GitActionPaths, options: GitActionOptions, releaseLock: () => void,
): Promise<void> {
  switch (action.verb) {
    case "sites": cmdSites(paths); return;
    case "domains": cmdDomains(paths); return;
    case "status": cmdStatus(paths, action.domain); return;
    case "configure": await cmdConfigure(paths, action.domain, options); return;
    case "forget": cmdForget(paths, action.domain); return;
    case "keygen": cmdKeygen(paths, action.domain, action.replace); return;
    case "webhook-enable": cmdWebhook(paths, action.domain, true, action.replace); return;
    case "webhook-disable": cmdWebhook(paths, action.domain, false, false); return;
    case "hook": await cmdHook(paths, action.domain, options, releaseLock); return;
    case "deploy": cmdDeploy(paths, action.domain, releaseLock); return;
    case "run": await cmdRun(paths, action.job, options); return;
    case "job": cmdJob(paths, action.job); return;
    case "jobs": cmdJobs(paths); return;
    case "watch-job": await cmdWatchJob(paths, action.job); return;
    case "prune": cmdPrune(paths); return;
  }
}

export async function runGitAction(argv: string[], options?: GitActionOptions): Promise<number> {
  const emitReply = options?.emitReply !== false;
  const opts = options ?? {};
  try {
    requireRoot(opts);
    const paths = pathsFor(opts);
    const action = parseAction(argv, paths, opts);
    ensureState(paths);
    mkdirSync(paths.lockDir, { recursive: true, mode: 0o700 });

    let lock: FileLockHandle | null = null;
    const releaseLock = () => {
      lock?.release();
      lock = null;
    };
    try {
      // A deployment and the record it reads must not overlap for one site.
      const locked = action.verb === "deploy" || action.verb === "hook" ? action.domain
        : action.verb === "run" ? jobGet(jobDir(paths, action.job), "domain")
        : "";
      if (locked) {
        lock = await acquireFileLock(
          join(paths.lockDir, `git-${locked}.lock`),
          30,
          `another deployment is already running for ${locked}`,
        );
      }
      await dispatch(action, paths, opts, releaseLock);
      return 0;
    } finally {
      releaseLock();
    }
  } catch (error) {
    if (error instanceof JobFailure) return 1;
    if (error instanceof ActionFailure) {
      if (emitReply) emitActionError(error.message, error.data, "git");
      else process.stderr.write(`[git] ERROR: ${error.message}\n`);
      return 1;
    }
    const message = error instanceof ActionCommandFailure
      ? error.message
      : error instanceof Error ? error.message : "git action failed";
    if (emitReply) emitActionError(message, undefined, "git");
    else process.stderr.write(`[git] ERROR: ${message}\n`);
    return 1;
  }
}

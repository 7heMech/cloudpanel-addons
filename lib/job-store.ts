// The on-disk job record, shared by every addon that runs work in the
// background.
//
// A job is a directory of single-value files: `state`, `step`, `error`,
// `createdAt` and whatever else the addon needs to hand its runner. Files
// rather than one JSON document because a runner writes a field while the UI
// reads another one a second later, and a rename per field is the cheapest way
// to make that safe without a database.
//
// Everything about running a job that is not what the job means lives here:
// the record, queueing it to systemd, the runner's log, its step and failure,
// the `job`/`watch-job`/`jobs` verbs and pruning. The addons keep only the
// meaning of their own fields.
import { errorMessage } from "./errors";
import { randomBytes } from "node:crypto";
import {
  closeSync, fchmodSync, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, rmSync,
  statSync, writeFileSync, writeSync,
} from "node:fs";
import { writeFileAtomic } from "./atomic-write";
import { join } from "node:path";
import { emitActionOk, failAction } from "./action";
import { runCommand } from "./command";
import { CLI_BIN } from "./paths";

/** A job id is a UTC stamp plus six hex characters: 20260911T160031Z-35e759. */
// Re-exported from its neutral home so the app services can check an id
// without importing this module's job orchestration. See lib/job-id.ts.
export { isActiveJobState, JOB_ID_RE, validateJobId } from "./job-id";
import { isActiveJobState, isTerminalJobState, JOB_ID_RE, validateJobId } from "./job-id";

/**
 * The longest field value that will ever be read back.
 *
 * A field is a hostname, a state word or an error message. Anything longer is
 * either corruption or something that has no business being in the record, and
 * the readers of these values render them into a page.
 */
const MAX_FIELD_BYTES = 4096;

/** How many trailing lines of a job log the UI is given. */
export const JOB_LOG_TAIL_LINES = 400;
const JOB_LOG_CHUNK_BYTES = 64 * 1024;
const MAX_JOB_LOG_READ_BYTES = 1024 * 1024; // Bounds memory used for a rendered log tail.

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** A UTC stamp in the form the job id and the job's timestamps both use. */
export function jobTimestamp(compact = false): string {
  const d = new Date();
  const date = `${d.getUTCFullYear()}${compact ? "" : "-"}${pad(d.getUTCMonth() + 1)}${compact ? "" : "-"}${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}${compact ? "" : ":"}${pad(d.getUTCMinutes())}${compact ? "" : ":"}${pad(d.getUTCSeconds())}`;
  return `${date}T${time}Z`;
}

export function newJobId(): string {
  return `${jobTimestamp(true)}-${randomBytes(3).toString("hex")}`;
}

export function jobDir(jobsDir: string, id: string): string {
  return join(jobsDir, id);
}

/** Create the job's directory, owner-only, and return it. */
export function createJobDir(jobsDir: string, id: string): string {
  mkdirSync(jobsDir, { recursive: true, mode: 0o700 });
  const dir = jobDir(jobsDir, id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function jobGet(dir: string, field: string, maxBytes = MAX_FIELD_BYTES): string {
  try {
    return readFileSync(join(dir, field)).subarray(0, maxBytes).toString("utf8").replaceAll("\n", "");
  } catch {
    return "";
  }
}

/**
 * Write one field.
 *
 * Through a temporary file and a rename, because the progress stream reads
 * these once a second while the runner writes them: a plain write is visible
 * as an empty file for as long as it takes to fill, and a reader that lands
 * there sees a job with no state.
 */
export function jobSet(dir: string, field: string, value: string): void {
  writeFileAtomic(join(dir, field), `${value}\n`, { mode: 0o600 });
}

/** Start the job's log, owner-only, and return its path. */
export function createJobLog(dir: string): string {
  const path = join(dir, "log");
  writeFileSync(path, "", { mode: 0o600 });
  return path;
}

// --- what a runner writes -------------------------------------------------
//
// An action's diagnostics go to stderr, which is the system journal. While a
// runner works through a job they go into the job's log instead, which is what
// the job page shows, and a write there that fails is dropped rather than sent
// to the journal: a job's output can carry a secret or whatever a site's own
// commands print.

let activeTranscript: number | null = null;

export interface JobTranscript {
  /** Close the log and send diagnostics back where they went before. */
  stop(): void;
}

/**
 * Send `diagnostic` into the log at `path` until `stop`. The log is made
 * owner-only unless `ownerOnly` is false, for a log whose mode its caller set.
 */
export function startJobTranscript(path: string, options: { ownerOnly?: boolean } = {}): JobTranscript {
  const fd = openSync(path, "a", 0o600);
  if (options.ownerOnly !== false) {
    try {
      fchmodSync(fd, 0o600);
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }
  const previous = activeTranscript;
  activeTranscript = fd;
  let stopped = false;
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      if (activeTranscript === fd) activeTranscript = previous;
      try { closeSync(fd); } catch {}
    },
  };
}

function writeTranscript(fd: number, text: string): void {
  const bytes = Buffer.from(text);
  let offset = 0;
  while (offset < bytes.length) {
    try {
      const written = writeSync(fd, bytes, offset, bytes.length - offset, null);
      if (written <= 0) return;
      offset += written;
    } catch {
      return;
    }
  }
}

/** Diagnostic output: into the running job's log, or onto stderr outside one. */
export function diagnostic(text: string): void {
  if (activeTranscript !== null) writeTranscript(activeTranscript, text);
  else process.stderr.write(text);
}

/** A finished command's output, as diagnostics. */
export function forwardCommandOutput(result: { stdout: string; stderr: string }): void {
  if (result.stdout) diagnostic(result.stdout);
  if (result.stderr) diagnostic(result.stderr);
}

/** Run a command, keeping its stdout as a diagnostic and dropping its stderr. */
export function runStdoutAsDiagnostic(command: string, args: string[]): boolean {
  const result = runCommand(command, args);
  if (result.stdout) diagnostic(result.stdout);
  return result.ok;
}

/** Record the step the runner is on, and log it as `[addon] step`. */
export function setJobStep(addon: string, dir: string, step: string): void {
  jobSet(dir, "step", step);
  diagnostic(`[${addon}] ${step}\n`);
}

/** The runner has taken the job. */
export function markJobRunning(dir: string): void {
  jobSet(dir, "startedAt", jobTimestamp());
  jobSet(dir, "state", "running");
}

/** What a job leaves for its page, owner-only: it can hold generated credentials. */
export function writeJobResult(dir: string, result: unknown): void {
  writeFileAtomic(join(dir, "result.json"), `${JSON.stringify(result)}\n`, { mode: 0o600 });
}

/** What a finished job recorded, or null before it has. */
export function readJobResult<T>(dir: string): T | null {
  try {
    return JSON.parse(readFileSync(join(dir, "result.json"), "utf8")) as T;
  } catch {
    return null;
  }
}

/** The job ended well. Last, because a watcher stops at the state. */
export function markJobDone(dir: string): void {
  jobSet(dir, "finishedAt", jobTimestamp());
  jobSet(dir, "state", "done");
}

/**
 * A job failure that is already in the record and the log. The action exits 1
 * without a reply: the runner was started by systemd, and nobody reads one.
 */
export class JobFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobFailure";
  }
}

/**
 * Record the job as failed and log `[addon] ERROR: message`. It never throws:
 * a record that cannot be written is already the larger problem, and the
 * caller's failure is the one to report. `finishedAt` stamps the failure.
 */
export function recordJobFailure(addon: string, dir: string, message: string, options: { finishedAt: boolean }): void {
  const write = (field: string, value: string) => {
    try {
      jobSet(dir, field, value);
    } catch {}
  };
  if (options.finishedAt) write("finishedAt", jobTimestamp());
  write("error", message);
  diagnostic(`[${addon}] ERROR: ${message}\n`);
  // Last, because a watcher stops at the state.
  write("state", "failed");
}

/** Record the failure and end the run with a `JobFailure`. */
export function failJob(addon: string, dir: string, message: string, options: { finishedAt: boolean }): never {
  recordJobFailure(addon, dir, message, options);
  throw new JobFailure(message);
}

/** The tail of a job's log, with trailing blank lines removed. */
export function readJobLog(dir: string, lines = JOB_LOG_TAIL_LINES): string {
  if (lines <= 0) return "";

  const path = join(dir, "log");
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const chunks: Buffer[] = [];
    let position = size;
    let consumed = 0;
    let newlines = 0;

    while (position > 0 && consumed < MAX_JOB_LOG_READ_BYTES && newlines < lines + 1) {
      const length = Math.min(JOB_LOG_CHUNK_BYTES, position, MAX_JOB_LOG_READ_BYTES - consumed);
      const start = Math.max(0, size - consumed - length);
      const chunk = Buffer.allocUnsafe(length);
      const bytesRead = readSync(fd, chunk, 0, length, start);
      if (bytesRead <= 0) break;
      const readChunk = chunk.subarray(0, bytesRead);
      chunks.unshift(readChunk);
      consumed += bytesRead;
      position = start;
      for (const byte of readChunk) if (byte === 10) newlines++;
    }

    const text = Buffer.concat(chunks).toString("utf8");
    const entries = text.split("\n");
    if (text.endsWith("\n")) entries.pop();
    if (position > 0) entries.shift();
    return entries.slice(-lines).join("\n").replace(/\n+$/g, "");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
  }
}

export async function watchJobRecord(options: {
  dir: string;
  read: () => unknown;
  emit: (snapshot: unknown) => void;
  signal?: AbortSignal;
  intervalMs?: number;
}): Promise<void> {
  const intervalMs = options.intervalMs ?? 150;
  let previousState = jobGet(options.dir, "state");
  let previousStep = jobGet(options.dir, "step");
  let previousEvent = jobGet(options.dir, "event");
  let previousSize = statSync(join(options.dir, "log"), { throwIfNoEntry: false })?.size ?? 0;

  const first = options.read();
  options.emit(first);

  if (isTerminalJobState(previousState)) return;

  // Bun.sleep is not abortable; an aborted watch stops within one interval.
  while (!options.signal?.aborted) {
    await Bun.sleep(intervalMs);
    if (options.signal?.aborted) return;

    const directory = statSync(options.dir, { throwIfNoEntry: false });
    if (!directory?.isDirectory()) return;

    const state = jobGet(options.dir, "state");
    const step = jobGet(options.dir, "step");
    const event = jobGet(options.dir, "event");
    const size = statSync(join(options.dir, "log"), { throwIfNoEntry: false })?.size ?? 0;
    const changed = state !== previousState || step !== previousStep || event !== previousEvent || size !== previousSize;

    previousState = state;
    previousStep = step;
    previousEvent = event;
    previousSize = size;

    if (!changed) continue;
    options.emit(options.read());
    if (isTerminalJobState(state)) return;
  }
}

/** Every job id under `jobsDir`, newest first. */
export function listJobIds(jobsDir: string): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(jobsDir).sort().reverse();
  } catch {
    return [];
  }
  return entries.filter((entry) => JOB_ID_RE.test(entry) && isDirectory(jobDir(jobsDir, entry)));
}

/** The fields every job carries, whatever the addon does with it. */
export interface JobCommonFields {
  state: string;
  step: string;
  error: string;
  createdAt: string;
  startedAt: string;
  finishedAt: string;
}

export function jobCommonFields(dir: string): JobCommonFields {
  return {
    state: jobGet(dir, "state"),
    step: jobGet(dir, "step"),
    error: jobGet(dir, "error"),
    createdAt: jobGet(dir, "createdAt"),
    startedAt: jobGet(dir, "startedAt"),
    finishedAt: jobGet(dir, "finishedAt"),
  };
}

// --- the job verbs --------------------------------------------------------

/** The directory of job `id`, or the action's "no such job" failure. */
export function requireJobDir(jobsDir: string, id: string): string {
  const dir = jobDir(jobsDir, id);
  if (!isDirectory(dir)) failAction(`no such job: ${id}`);
  return dir;
}

/** `job`: one record, as the addon views it, and the tail of its log. */
export function emitJob(
  jobsDir: string, id: string, view: (dir: string, id: string) => unknown, emit: (data: unknown) => void = emitActionOk,
): void {
  const dir = requireJobDir(jobsDir, id);
  emit({ job: view(dir, id), log: readJobLog(dir) });
}

/** `watch-job`: the same reply, again each time the record changes, until the job ends. */
export async function watchJob(
  jobsDir: string, id: string, view: (dir: string, id: string) => unknown, emit: (data: unknown) => void = emitActionOk,
): Promise<void> {
  const dir = requireJobDir(jobsDir, id);
  await watchJobRecord({ dir, read: () => ({ job: view(dir, id), log: readJobLog(dir) }), emit });
}

/** Every record, as the addon views it, newest first. */
export function jobViews<T>(jobsDir: string, view: (dir: string, id: string) => T): T[] {
  return listJobIds(jobsDir).map((id) => view(jobDir(jobsDir, id), id));
}

export function jobUnitName(addon: string, id: string): string {
  return `clp-addon-${addon}-job-${id}`;
}

/**
 * Hand the job to systemd and return.
 *
 * The action binary is spawned per request by the gateway and exits as soon as
 * it has answered, so a child of this process would lose its supervisor the
 * moment the reply is written. A transient unit is owned by systemd instead:
 * it survives the caller, it is killed as a unit rather than as a stray pid,
 * and `--collect` takes the unit away once it has exited.
 *
 * The caller must release any lock the runner will want before calling this,
 * or the job it just started will sit waiting for the process that started it.
 *
 * `properties` are extra systemd unit properties. A runner that writes its own
 * transcript needs none; one whose progress is whatever it prints needs
 * StandardOutput= pointed at the job's log.
 */
export const BACKGROUND_JOB_PROPERTIES = [
  "Type=exec",
  // 1. CPU: Let the job run fast when idle, but yield immediately to web traffic
  "CPUWeight=20",
  "Nice=19",
  // 2. Disk I/O: Prevent disk saturation from blocking MySQL/Nginx without starvation
  "IOWeight=20",
  "IOSchedulingClass=best-effort",
  "IOSchedulingPriority=7",
  // 3. Memory: Never kill with hard caps, but sacrifice first if host RAM exhausts
  "OOMScoreAdjust=500",
];

export function startJobUnit(options: {
  addon: string;
  id: string;
  description: string;
  actionBinary: string;
  properties?: string[];
}): { ok: boolean; stdout: string; stderr: string } {
  const { addon, id, description, actionBinary, properties = [] } = options;
  return runCommand("systemd-run", [
    `--unit=${jobUnitName(addon, id)}`,
    `--description=${description}`,
    "--collect",
    ...BACKGROUND_JOB_PROPERTIES.map((property) => `--property=${property}`),
    ...properties.map((property) => `--property=${property}`),
    "--",
    actionBinary, "action", addon, "run", "--job", id,
  ]);
}

export function jobUnitIsActive(addon: string, id: string): boolean {
  return runCommand("systemctl", ["is-active", "--quiet", jobUnitName(addon, id)]).ok;
}

/**
 * Write a queued job's record, log included, and return it. `fields` are the
 * addon's own, written before the state, so a reader never sees a queued job
 * without them.
 */
export function recordQueuedJob(jobsDir: string, fields: Record<string, string>, step: string): { id: string; dir: string } {
  const id = newJobId();
  const dir = createJobDir(jobsDir, id);
  for (const [field, value] of Object.entries(fields)) jobSet(dir, field, value);
  jobSet(dir, "createdAt", jobTimestamp());
  jobSet(dir, "step", step);
  jobSet(dir, "state", "queued");
  createJobLog(dir);
  return { id, dir };
}

export interface QueueJobOptions {
  addon: string;
  jobsDir: string;
  fields: Record<string, string>;
  description: string;
  actionBinary: string;
  /** The unit's RuntimeMaxSec=; without one it runs until its work ends. */
  runtimeSeconds?: number;
  /** What the step says until the runner starts. "Waiting to start" by default. */
  step?: string;
  /**
   * Checked against every queued or running job before anything is written:
   * the action's refusal when `dir` is one this job must not run beside, or
   * null.
   */
  conflict?: (dir: string, state: string) => string | null;
  /**
   * Called with the record complete, just before the unit starts. A lock the
   * runner will take is released here, or the job would wait for the process
   * that started it.
   */
  beforeStart?: () => void;
  /**
   * An action's own name for the job, such as "clone". A unit systemd refuses
   * then records "could not start the clone job" and fails the action with
   * "systemd-run refused to start the clone job"; without it the record says
   * "the background job could not be started" and the thrown error carries
   * systemd-run's own words.
   */
  name?: string;
  /** Record fields removed again when systemd refuses the unit: credentials meant only for the runner. */
  secrets?: string[];
  /** Pass systemd-run's own output on as a diagnostic. */
  forwardOutput?: boolean;
  start?: typeof startJobUnit;
}

/** Record a queued job, hand it to systemd and return its id. */
export function queueJob(options: QueueJobOptions): string {
  if (options.conflict) {
    for (const existing of listJobIds(options.jobsDir)) {
      const dir = jobDir(options.jobsDir, existing);
      const state = jobGet(dir, "state");
      if (!isActiveJobState(state)) continue;
      const refusal = options.conflict(dir, state);
      if (refusal) failAction(refusal);
    }
  }
  const { id, dir } = recordQueuedJob(options.jobsDir, options.fields, options.step ?? "Waiting to start");
  options.beforeStart?.();
  const started = (options.start ?? startJobUnit)({
    addon: options.addon,
    id,
    description: options.description,
    actionBinary: options.actionBinary,
    properties: options.runtimeSeconds === undefined ? [] : [`RuntimeMaxSec=${options.runtimeSeconds}`],
  });
  if (options.forwardOutput) forwardCommandOutput(started);
  if (!started.ok) {
    jobSet(dir, "error", options.name ? `could not start the ${options.name} job` : "the background job could not be started");
    jobSet(dir, "state", "failed");
    for (const field of options.secrets ?? []) rmSync(join(dir, field), { force: true });
    if (options.name) failAction(`systemd-run refused to start the ${options.name} job`);
    throw new Error(`systemd-run refused to start the job${started.stderr.trim() ? `: ${started.stderr.trim()}` : ""}`);
  }
  return id;
}

/**
 * Start an addon's periodic pass in a transient unit and return, so work that
 * waits on the network or on a site's own code never holds repair's operation
 * lock. A pass still running from last time is left to finish rather than
 * started twice. `runtime` bounds it in seconds.
 */
export function queueAddonPass(options: {
  addon: string;
  verb: string;
  description: string;
  runtime: number;
  actionBinary?: string;
}): boolean {
  const unit = `clp-addon-${options.addon}-${options.verb}`;
  const running = () => runCommand("systemctl", ["is-active", "--quiet", unit]).ok;
  if (running()) return false;
  const started = runCommand("systemd-run", [
    `--unit=${unit}`,
    `--description=${options.description}`,
    "--collect",
    "--no-block",
    ...BACKGROUND_JOB_PROPERTIES.map((property) => `--property=${property}`),
    `--property=RuntimeMaxSec=${options.runtime}`,
    "--",
    options.actionBinary ?? CLI_BIN, "action", options.addon, options.verb,
  ]);
  if (started.ok) return true;
  if (running()) return false;
  throw new Error(`could not queue ${unit}: ${started.stderr.trim() || "systemd-run failed"}`);
}

/**
 * Match GNU find's `-mmin +N`/`-mtime +N`: the age is truncated to whole units
 * before the strict comparison, so `-mtime +14` retains a record until fifteen
 * complete 24-hour periods have elapsed.
 */
export function findOlderThan(path: string, unitMilliseconds: number, count: number): boolean {
  try {
    return Math.floor((Date.now() - statSync(path).mtimeMs) / unitMilliseconds) > count;
  } catch {
    return false;
  }
}

export interface PruneJobsResult {
  removed: number;
  stuck: number;
}

/**
 * Whether a queued or running job may still have a runner: its unit is
 * active, or the record is under five minutes old with no progress since.
 * `systemd-run` returns before the unit is necessarily visible to
 * `systemctl is-active`, and a record marked failed while its runner is still
 * working is worse than one that takes a few minutes to give up.
 */
function runnerMayBeAlive(addon: string, dir: string, id: string): boolean {
  return jobUnitIsActive(addon, id) || !findOlderThan(dir, 60 * 1000, 5);
}

/** A job that is queued or running and may still have a runner. */
export function jobIsLive(addon: string, jobsDir: string, id: string): boolean {
  const dir = jobDir(jobsDir, id);
  return isActiveJobState(jobGet(dir, "state")) && runnerMayBeAlive(addon, dir, id);
}

/**
 * Drop expired job records and fail the ones whose runner died (see
 * `jobIsLive`). `warnStuck` logs each one it fails as an `[addon] WARN:` line.
 */
export function pruneJobs(options: {
  addon: string;
  jobsDir: string;
  retentionDays: number;
  stuckMessage: string;
  warnStuck?: boolean;
  onStuck?: (id: string, state: string) => void;
}): PruneJobsResult {
  const { addon, jobsDir, retentionDays, stuckMessage, warnStuck, onStuck } = options;
  let removed = 0;
  let stuck = 0;
  // listJobIds, so that nothing else that has found its way into the directory
  // is ever a candidate for removal.
  for (const entry of listJobIds(jobsDir)) {
    const dir = jobDir(jobsDir, entry);
    const state = jobGet(dir, "state");
    if (isActiveJobState(state)) {
      if (runnerMayBeAlive(addon, dir, entry)) continue;
      if (warnStuck) diagnostic(`[${addon}] WARN: job ${entry} is recorded as ${state} but nothing is running it; marking it failed\n`);
      onStuck?.(entry, state);
      jobSet(dir, "error", stuckMessage);
      jobSet(dir, "state", "failed");
      stuck++;
    }
    if (findOlderThan(dir, 24 * 60 * 60 * 1000, retentionDays)) {
      rmSync(dir, { recursive: true, force: true });
      removed++;
    }
  }
  return { removed, stuck };
}

// --- jobs that work through sites ------------------------------------------
//
// WordPress Tools' checks and Panel Tweaks' size measurement each visit one
// site after another, and the page draws the same "12 of 40: site" bar for
// both. The record fields and the step's wording are decided here, so the two
// cannot drift apart.

/** `--job=<id>` from the page, or `--job <id>` as systemd and the stream pass it. */
export function jobIdArgument(rest: string[]): string {
  const value = rest.length === 1 && rest[0]!.startsWith("--job=") ? rest[0]!.slice("--job=".length)
    : rest.length === 2 && rest[0] === "--job" ? rest[1]! : "";
  const id = validateJobId(value);
  if (!id) failAction("a job takes exactly --job=<id>");
  return id;
}

/** Where a job that works through sites is: `completed` of `total` done, and the one it is on. */
export interface JobSiteProgress {
  completed: number;
  total: number;
  /** The site being worked on, or "" between sites. */
  site: string;
}

function jobCount(dir: string, field: string): number {
  const value = Number.parseInt(jobGet(dir, field), 10);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function jobSiteProgress(dir: string): JobSiteProgress {
  return { completed: jobCount(dir, "completed"), total: jobCount(dir, "total"), site: jobGet(dir, "site") };
}

/** "Measuring 12 of 40: site", or "Measuring site" when there is only the one. */
export function siteProgressStep(verb: string, progress: JobSiteProgress): string {
  return progress.total > 1
    ? `${verb} ${Math.min(progress.completed + 1, progress.total)} of ${progress.total}: ${progress.site}`
    : `${verb} ${progress.site}`;
}

/**
 * Run a queued job to its end, writing its progress as it goes: `work` calls
 * `onProgress` before each site, and what it returns is the job's result.
 * `verb` words the step, and `wait` is what the step says until the first site.
 */
export async function runSiteJob<T>(
  dir: string,
  verb: string,
  work: (onProgress: (progress: JobSiteProgress) => void, wait: (step: string) => void) => Promise<T>,
): Promise<void> {
  const state = jobGet(dir, "state");
  if (state !== "queued") throw new Error(`the job is already ${state || "gone"}`);
  markJobRunning(dir);
  const onProgress = (progress: JobSiteProgress) => {
    jobSet(dir, "completed", String(progress.completed));
    jobSet(dir, "total", String(progress.total));
    jobSet(dir, "site", progress.site);
    // Last, because the stream sends an update when the step changes.
    jobSet(dir, "step", siteProgressStep(verb, progress));
  };
  try {
    const result = await work(onProgress, (step) => jobSet(dir, "step", step));
    writeJobResult(dir, result);
    jobSet(dir, "completed", jobGet(dir, "total") || "0");
    jobSet(dir, "site", "");
    jobSet(dir, "step", "Finished");
    markJobDone(dir);
  } catch (error) {
    jobSet(dir, "error", errorMessage(error));
    jobSet(dir, "site", "");
    jobSet(dir, "step", "Failed");
    jobSet(dir, "finishedAt", jobTimestamp());
    jobSet(dir, "state", "failed");
  }
}

// The on-disk job record, shared by every addon that runs work in the
// background.
//
// A job is a directory of single-value files: `state`, `step`, `error`,
// `createdAt` and whatever else the addon needs to hand its runner. Files
// rather than one JSON document because a runner writes a field while the UI
// reads another one a second later, and a rename per field is the cheapest way
// to make that safe without a database.
//
// Stager and Instatic each grew their own copy of this. The copies drifted:
// one shelled out to `date` and `openssl` for an id the other built natively,
// one replaced files in place while the other renamed over them, and only one
// ever pruned anything. Those are the kinds of differences nobody chooses on
// purpose, so the decisions live here now and the addons keep only the meaning
// of their own fields.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCommand } from "./action-common";

/** A job id is a UTC stamp plus six hex characters: 20260911T160031Z-35e759. */
export const JOB_ID_RE = /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{6}$/;

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

export function jobGet(dir: string, field: string): string {
  try {
    return readFileSync(join(dir, field)).subarray(0, MAX_FIELD_BYTES).toString("utf8").replaceAll("\n", "");
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
  const file = join(dir, field);
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, `${value}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

/** Start the job's log, owner-only, and return its path. */
export function createJobLog(dir: string): string {
  const path = join(dir, "log");
  writeFileSync(path, "", { mode: 0o600 });
  return path;
}

/** The tail of a job's log, with trailing blank lines removed. */
export function readJobLog(dir: string, lines = JOB_LOG_TAIL_LINES): string {
  const result = runCommand("tail", ["-n", String(lines), join(dir, "log")]);
  return result.ok ? result.stdout.replace(/\n+$/g, "") : "";
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
    "--property=Type=exec",
    ...properties.map((property) => `--property=${property}`),
    "--",
    actionBinary, "action", addon, "run", "--job", id,
  ]);
}

export function jobUnitIsActive(addon: string, id: string): boolean {
  return runCommand("systemctl", ["is-active", "--quiet", jobUnitName(addon, id)]).ok;
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
 * Drop expired job records and fail the ones whose runner died.
 *
 * A job is only declared stuck after five minutes of no unit and no progress:
 * `systemd-run` returns before the unit is necessarily visible to
 * `systemctl is-active`, and a record marked failed while its runner is still
 * working is worse than one that takes a few minutes to give up.
 */
export function pruneJobs(options: {
  addon: string;
  jobsDir: string;
  retentionDays: number;
  stuckMessage: string;
  onStuck?: (id: string, state: string) => void;
}): PruneJobsResult {
  const { addon, jobsDir, retentionDays, stuckMessage, onStuck } = options;
  let removed = 0;
  let stuck = 0;
  // listJobIds, so that nothing else that has found its way into the directory
  // is ever a candidate for removal.
  for (const entry of listJobIds(jobsDir)) {
    const dir = jobDir(jobsDir, entry);
    const state = jobGet(dir, "state");
    if (state === "queued" || state === "running") {
      if (jobUnitIsActive(addon, entry)) continue;
      if (!findOlderThan(dir, 60 * 1000, 5)) continue;
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

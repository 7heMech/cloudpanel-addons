// The manager's own privileged verbs, run as root and reached from the
// unprivileged web process through the gateway.
//
// Every addon already ships inside this binary: `ADDONS` is a compile-time
// record and each addon's injection targets are imported TypeScript values.
// "Enabling" one therefore fetches no code. It writes the addon's config file,
// injects its Twig anchors and reinstalls the units -- which is why it is root
// work, and why the web UI cannot do it directly.
//
// Updating is the one verb that does fetch: it is `clp-addons update` with the
// operator pressing the button instead of typing the command. Nothing here ever
// runs unattended. A release is only ever installed because a logged-in
// administrator asked for it, which is the whole reason this project notifies
// about new releases rather than applying them.
//
// All three verbs end by restarting the manager, which is the process that
// asked for them. So none of them answers the request that started it: the
// create path writes a job record, hands the work to a transient systemd unit
// that outlives the restart, and returns a job id. The browser follows that id
// and reconnects once the manager is back.

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { withFileLock } from "./action-common";
import {
  createJobDir, createJobLog, findOlderThan, jobCommonFields, jobDir, jobGet, jobSet,
  jobTimestamp, jobUnitIsActive, listJobIds, newJobId, pruneJobs, readJobLog, startJobUnit,
  type PruneJobsResult,
} from "./job-store";
import { ADDONS, ADDON_NAMES, CLI_BIN, LOCK_DIR, STATE_DIR } from "./paths";
import { Fatal, requireRoot } from "./util";

/** Where the manager's own job records live, beside each addon's state. */
export const MANAGER_STATE_DIR = `${STATE_DIR}/manager`;
export const MANAGER_JOBS_DIR = `${MANAGER_STATE_DIR}/jobs`;

/** Long enough to look at the failure in the UI, short enough not to pile up. */
const JOB_RETENTION_DAYS = 7;

export type ManagerJobKind = "enable" | "disable" | "update";

/**
 * The privileged work itself, injected rather than imported.
 *
 * Enabling reinstalls units and reconciles Nginx and the Twig anchors, and
 * updating downloads and verifies a release: all of that lives in cli/index.ts
 * beside `cmdInstall` and `cmdUpdate`, which imports this module. Taking the
 * three operations as an argument keeps the dependency pointing one way and
 * lets the job plumbing be tested without provisioning anything.
 */
export interface ManagerOps {
  enable(addon: string): Promise<void> | void;
  disable(addon: string): Promise<void> | void;
  update(): Promise<void>;
}

export interface ManagerJobView {
  id: string;
  kind: string;
  addon: string;
  state: string;
  step: string;
  error: string;
  createdAt: string;
  startedAt: string;
  finishedAt: string;
}

/**
 * Accept both flag spellings this action is reached by.
 *
 * The manager builds `--addon=stager` the way the CLI's own `parseFlags` reads
 * it; the transient unit that runs a job is built by the shared `startJobUnit`,
 * which spells it `--job <id>` the way every other action's parser reads it.
 * This is the one entry point both forms arrive at, so it understands both
 * rather than either side being made to spell it the other's way.
 */
export function parseManagerFlags(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) continue;
    const equals = arg.indexOf("=");
    if (equals !== -1) {
      flags[arg.slice(2, equals)] = arg.slice(equals + 1);
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[arg.slice(2)] = next;
      index++;
    }
  }
  return flags;
}

function reply(body: unknown, emit = true): number {
  if (emit) process.stdout.write(`${JSON.stringify(body)}\n`);
  return 0;
}

function failReply(error: string, data?: unknown, emit = true): number {
  if (emit) process.stdout.write(`${JSON.stringify({ ok: false, error, ...(data !== undefined ? { data } : {}) })}\n`);
  return 1;
}

function message(error: unknown): string {
  if (error instanceof Fatal || error instanceof Error) return error.message;
  return String(error);
}

/**
 * The job that is still going, if there is one.
 *
 * This is what makes the buttons idempotent: a second click finds the first
 * click's job and follows it rather than starting a second enable. The
 * "recently created" arm matches pruneJobs' stuck rule -- `systemd-run` returns
 * before the unit is necessarily visible to `systemctl is-active`, so a job
 * seconds old is treated as live even when its unit cannot be seen yet.
 */
export function activeManagerJob(jobsDir = MANAGER_JOBS_DIR): string | null {
  for (const id of listJobIds(jobsDir)) {
    const dir = jobDir(jobsDir, id);
    const state = jobGet(dir, "state");
    if (state !== "queued" && state !== "running") continue;
    if (jobUnitIsActive("manager", id) || !findOlderThan(dir, 60 * 1000, 5)) return id;
  }
  return null;
}

/** The newest job record, whatever its state. */
export function latestManagerJob(jobsDir = MANAGER_JOBS_DIR): string | null {
  return listJobIds(jobsDir)[0] ?? null;
}

export function readManagerJob(id: string, jobsDir = MANAGER_JOBS_DIR): { job: ManagerJobView; log: string } | null {
  const dir = jobDir(jobsDir, id);
  if (!existsSync(dir)) return null;
  return {
    job: { id, kind: jobGet(dir, "kind"), addon: jobGet(dir, "addon"), ...jobCommonFields(dir) },
    log: readJobLog(dir),
  };
}

/** Expire old records and fail the ones whose runner died. Called by repair. */
export function pruneManagerJobs(jobsDir = MANAGER_JOBS_DIR): PruneJobsResult {
  return pruneJobs({
    addon: "manager",
    jobsDir,
    retentionDays: JOB_RETENTION_DAYS,
    stuckMessage: "the job's runner is gone; it may have completed or failed part-way",
  });
}

function enabled(name: string): boolean {
  return existsSync(ADDONS[name]!.configFile);
}

/**
 * Reject what the runner would only discover after it had started.
 *
 * Disabling the last addon is not on this list. `serve` keeps running with none
 * enabled, because every addon is compiled in and a manager with none of them
 * on is still the page that offers them back; the panel's Addons entry is kept
 * by `installedInjections` for the same reason. Taking the installation away
 * altogether is still `clp-addons uninstall`.
 */
function rejectImpossible(kind: ManagerJobKind, addon: string): string | null {
  if (kind === "update") return null;
  if (!ADDON_NAMES.includes(addon)) return `unknown addon '${addon}'`;
  const isEnabled = enabled(addon);
  if (kind === "enable" && isEnabled) return `${addon} is already enabled`;
  if (kind === "disable" && !isEnabled) return `${addon} is already disabled`;
  return null;
}

function describe(kind: ManagerJobKind, addon: string): string {
  return kind === "update" ? "clp-addons update" : `clp-addons ${kind} ${addon}`;
}

/**
 * Record the request, hand it to systemd and answer with the job id.
 *
 * The record is written before the unit is started so that a runner that begins
 * immediately finds a complete record, and the log file is created here for the
 * same reason the unit's StandardOutput= points at it: the runner's progress is
 * whatever `clp-addons` prints, and systemd is what puts that in a file the
 * unprivileged manager can be shown through this action.
 */
export interface CreateJobOptions {
  jobsDir?: string;
  stateDir?: string;
  lockDir?: string;
  startUnit?: typeof startJobUnit;
  emitReply?: boolean;
  onReply?: (res: any) => void;
}

export async function createJob(
  kind: ManagerJobKind,
  addon: string,
  options: CreateJobOptions = {},
): Promise<number> {
  const jobsDir = options.jobsDir ?? MANAGER_JOBS_DIR;
  const stateDir = options.stateDir ?? (options.jobsDir ? jobsDir : MANAGER_STATE_DIR);
  const lockDir = options.lockDir ?? LOCK_DIR;
  const startUnit = options.startUnit ?? startJobUnit;
  const emit = options.emitReply !== false;

  const emitOk = (data: unknown) => {
    options.onReply?.(data);
    return reply(data, emit);
  };
  const emitFail = (error: string, data?: unknown) => {
    options.onReply?.({ ok: false, error, ...(data !== undefined ? { data } : {}) });
    return failReply(error, data, emit);
  };

  const refusal = rejectImpossible(kind, addon);
  if (refusal) return emitFail(refusal);

  const running = activeManagerJob(jobsDir);
  if (running) {
    const existing = readManagerJob(running, jobsDir);
    return emitOk({ ok: true, data: { jobId: running, existing: true, job: existing?.job } });
  }

  mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  const lockPath = join(lockDir, "manager.lock");

  try {
    return await withFileLock(lockPath, 30, "another manager operation is already starting", async () => {
      const lockedRunning = activeManagerJob(jobsDir);
      if (lockedRunning) {
        const existing = readManagerJob(lockedRunning, jobsDir);
        return emitOk({ ok: true, data: { jobId: lockedRunning, existing: true, job: existing?.job } });
      }

      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      const id = newJobId();
      const dir = createJobDir(jobsDir, id);
      const logPath = createJobLog(dir);
      jobSet(dir, "kind", kind);
      jobSet(dir, "addon", kind === "update" ? "" : addon);
      jobSet(dir, "createdAt", jobTimestamp());
      jobSet(dir, "state", "queued");
      jobSet(dir, "step", kind === "update" ? "queued" : `queued: ${kind} ${addon}`);

      const started = startUnit({
        addon: "manager",
        id,
        description: describe(kind, addon),
        actionBinary: CLI_BIN,
        properties: [`StandardOutput=append:${logPath}`, `StandardError=append:${logPath}`],
      });
      if (!started.ok) {
        rmSync(dir, { recursive: true, force: true });
        return emitFail(started.stderr.trim() || started.stdout.trim() || "could not start the job");
      }
      return emitOk({ ok: true, data: { jobId: id, existing: false } });
    });
  } catch (error) {
    return emitFail(message(error));
  }
}

/**
 * The runner, started by systemd and by nothing else.
 *
 * It finishes by restarting the manager, so it cannot report back over the
 * connection that asked for the work. The record is the report: whatever
 * happens here, the state, the step and the error are on disk before this
 * process exits, and the page that comes back after the restart reads them.
 *
 * `jobsDir` is a test-only override; production always uses MANAGER_JOBS_DIR.
 */
export async function runManagerJob(id: string, ops: ManagerOps, jobsDir = MANAGER_JOBS_DIR): Promise<number> {
  const dir = jobDir(jobsDir, id);
  if (!existsSync(dir)) return failReply(`no such job '${id}'`);
  const kind = jobGet(dir, "kind");
  const addon = jobGet(dir, "addon");

  jobSet(dir, "startedAt", jobTimestamp());
  jobSet(dir, "state", "running");
  try {
    if (kind === "enable") {
      jobSet(dir, "step", `enabling ${addon}`);
      await ops.enable(addon);
    } else if (kind === "disable") {
      jobSet(dir, "step", `disabling ${addon}`);
      await ops.disable(addon);
    } else if (kind === "update") {
      jobSet(dir, "step", "installing the latest release");
      await ops.update();
    } else {
      throw new Fatal(`job '${id}' has no kind this binary knows how to run`);
    }
  } catch (error) {
    jobSet(dir, "error", message(error));
    jobSet(dir, "finishedAt", jobTimestamp());
    jobSet(dir, "state", "failed");
    return 1;
  }
  jobSet(dir, "step", kind === "update" ? "updated" : `${kind}d ${addon}`);
  jobSet(dir, "finishedAt", jobTimestamp());
  jobSet(dir, "state", "done");
  return 0;
}

/**
 * `clp-addons action manager <verb>`.
 *
 * Every verb answers with one JSON object on stdout, because the gateway reads
 * exactly that. The runner is the exception in spirit -- its output is the job
 * log -- but it still ends with a JSON line so a hand-run `run` behaves.
 */
export async function runManagerAction(
  argv: string[],
  ops: ManagerOps,
  options: CreateJobOptions = {},
): Promise<number> {
  requireRoot("manager");
  const [verb, ...rest] = argv;
  const flags = parseManagerFlags(rest);
  const addon = flags.addon ?? "";
  const id = flags.job ?? flags.id ?? "";

  try {
    switch (verb) {
      case "enable":
      case "disable":
        if (!addon) return failReply(`'${verb}' needs --addon`, undefined, options.emitReply !== false);
        return await createJob(verb, addon, options);
      case "update":
        return await createJob("update", "", options);
      case "job": {
        // Without --id, the newest record. The page that draws a job is the
        // one the manager restart reloads, and after that reload the browser
        // has no id to ask about -- but the record it was following is still
        // the newest one.
        const jobsDir = options.jobsDir ?? MANAGER_JOBS_DIR;
        const wanted = id || latestManagerJob(jobsDir);
        if (!wanted) return reply({ ok: true, data: null }, options.emitReply !== false);
        const found = readManagerJob(wanted, jobsDir);
        return found
          ? reply({ ok: true, data: found }, options.emitReply !== false)
          : failReply(`no such job '${wanted}'`, undefined, options.emitReply !== false);
      }
      case "run": {
        if (!id) return failReply("'run' needs --job", undefined, options.emitReply !== false);
        const jobsDir = options.jobsDir ?? MANAGER_JOBS_DIR;
        const code = await runManagerJob(id, ops, jobsDir);
        return code === 0 ? reply({ ok: true, data: { jobId: id } }, options.emitReply !== false) : code;
      }
      default:
        return failReply(`unknown manager verb '${verb ?? ""}'`, undefined, options.emitReply !== false);
    }
  } catch (error) {
    return failReply(message(error), undefined, options.emitReply !== false);
  }
}

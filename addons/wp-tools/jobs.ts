// Checks, installations and connections an operator starts from the page run as
// background jobs: a check of every site can take minutes, longer than a
// request should be held open, and a page reloaded meanwhile finds the job
// again and keeps following it. The record is the shared job store's.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../../lib/atomic-write";
import {
  createJobDir, createJobLog, jobCommonFields, jobDir, jobGet, jobSet, jobTimestamp, listJobIds, newJobId, startJobUnit,
} from "../../cli/job-store";
import type { MainwpResult } from "./mainwp";
import type { VarnishSyncResult } from "./varnish";
import type { WpProgress } from "./wp-cli";

export const WP_JOB_TASKS = ["varnish-check", "varnish-install", "mainwp-check", "mainwp-connect", "mainwp-cleanup"] as const;
export type WpJobTask = (typeof WP_JOB_TASKS)[number];
export type WpJobPolicy = "varnish" | "mainwp";

/** More than any box has WordPress sites, and still a short argument. */
export const MAX_JOB_DOMAINS = 2000;

/** A job's runner unit is stopped after this long; the pass inside stops starting sites a little earlier. */
export const JOB_RUNTIME_SECONDS = 3600;
export const JOB_BUDGET_MS = (JOB_RUNTIME_SECONDS - 300) * 1000;

export interface WpJobView {
  id: string;
  task: WpJobTask;
  policy: WpJobPolicy;
  domains: string[];
  state: string;
  step: string;
  error: string;
  createdAt: string;
  startedAt: string;
  finishedAt: string;
  completed: number;
  total: number;
  /** The site being worked on, or "" between sites. */
  site: string;
  result: VarnishSyncResult | MainwpResult | null;
}

/** The job each policy is running, if any; one at a time per policy. */
export interface WpJobs {
  varnish: WpJobView | null;
  mainwp: WpJobView | null;
}

export function policyOf(task: WpJobTask): WpJobPolicy {
  return task.startsWith("varnish-") ? "varnish" : "mainwp";
}

function active(state: string): boolean {
  return state === "queued" || state === "running";
}

function count(dir: string, field: string): number {
  const value = Number.parseInt(jobGet(dir, field), 10);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function readResult(dir: string): WpJobView["result"] {
  const path = join(dir, "result.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as WpJobView["result"];
  } catch {
    return null;
  }
}

export function wpJobView(jobsDir: string, id: string): WpJobView | null {
  const dir = jobDir(jobsDir, id);
  const task = WP_JOB_TASKS.find((known) => known === jobGet(dir, "task"));
  if (!task) return null;
  return {
    id,
    task,
    policy: policyOf(task),
    domains: jobGet(dir, "domains").split(",").filter(Boolean),
    ...jobCommonFields(dir),
    completed: count(dir, "completed"),
    total: count(dir, "total"),
    site: jobGet(dir, "site"),
    result: readResult(dir),
  };
}

export function activeWpJobs(jobsDir: string): WpJobs {
  const jobs: WpJobs = { varnish: null, mainwp: null };
  for (const id of listJobIds(jobsDir)) {
    const view = wpJobView(jobsDir, id);
    if (view && active(view.state) && !jobs[view.policy]) jobs[view.policy] = view;
  }
  return jobs;
}

/**
 * Record a job and hand it to systemd. A second job for a policy that has one
 * queued or running is refused; the caller holds a lock across this check.
 */
export function startWpJob(options: {
  jobsDir: string;
  task: WpJobTask;
  domains: string[];
  actionBinary: string;
  start?: typeof startJobUnit;
}): WpJobView {
  const { jobsDir, task, domains } = options;
  const policy = policyOf(task);
  const running = activeWpJobs(jobsDir)[policy];
  if (running) {
    throw new Error(policy === "varnish" ? "a CLP Varnish Cache job is already running" : "a MainWP job is already running");
  }
  const id = newJobId();
  const dir = createJobDir(jobsDir, id);
  jobSet(dir, "task", task);
  jobSet(dir, "domains", domains.join(","));
  jobSet(dir, "createdAt", jobTimestamp());
  jobSet(dir, "step", "Waiting to start");
  jobSet(dir, "state", "queued");
  createJobLog(dir);
  const started = (options.start ?? startJobUnit)({
    addon: "wp-tools",
    id,
    description: `clp-addons: WordPress Tools ${task}`,
    actionBinary: options.actionBinary,
    properties: [`RuntimeMaxSec=${JOB_RUNTIME_SECONDS}`],
  });
  if (!started.ok) {
    jobSet(dir, "error", "the background job could not be started");
    jobSet(dir, "state", "failed");
    throw new Error(`systemd-run refused to start the job${started.stderr.trim() ? `: ${started.stderr.trim()}` : ""}`);
  }
  return wpJobView(jobsDir, id)!;
}

const VERBS: Record<WpJobTask, string> = {
  "varnish-check": "Checking",
  "varnish-install": "Installing on",
  "mainwp-check": "Checking",
  "mainwp-connect": "Connecting",
  "mainwp-cleanup": "Cleaning up",
};

/** Run a recorded job to its end, writing its progress as it goes. */
export async function runWpJob(
  jobsDir: string,
  id: string,
  work: (task: WpJobTask, domains: string[], onProgress: (progress: WpProgress) => void) => Promise<VarnishSyncResult | MainwpResult>,
): Promise<void> {
  const view = wpJobView(jobsDir, id);
  if (!view) throw new Error(`no such job: ${id}`);
  if (view.state !== "queued") throw new Error(`job ${id} is already ${view.state}`);
  const dir = jobDir(jobsDir, id);
  jobSet(dir, "startedAt", jobTimestamp());
  jobSet(dir, "state", "running");
  const onProgress = (progress: WpProgress) => {
    jobSet(dir, "completed", String(progress.completed));
    jobSet(dir, "total", String(progress.total));
    jobSet(dir, "site", progress.site);
    // Last, because the stream sends an update when the step changes.
    jobSet(dir, "step", progress.total > 1
      ? `${VERBS[view.task]} ${progress.completed + 1} of ${progress.total}: ${progress.site}`
      : `${VERBS[view.task]} ${progress.site}`);
  };
  try {
    const result = await work(view.task, view.domains, onProgress);
    writeFileAtomic(join(dir, "result.json"), `${JSON.stringify(result)}\n`, { mode: 0o600 });
    jobSet(dir, "completed", jobGet(dir, "total") || "0");
    jobSet(dir, "site", "");
    jobSet(dir, "step", "Finished");
    jobSet(dir, "finishedAt", jobTimestamp());
    jobSet(dir, "state", "done");
  } catch (error) {
    jobSet(dir, "error", error instanceof Error ? error.message : String(error));
    jobSet(dir, "site", "");
    jobSet(dir, "step", "Failed");
    jobSet(dir, "finishedAt", jobTimestamp());
    jobSet(dir, "state", "failed");
  }
}

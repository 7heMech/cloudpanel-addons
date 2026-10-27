// Checks, installations and connections an operator starts from the page run as
// background jobs: a check of every site can take minutes, longer than a
// request should be held open, and a page reloaded meanwhile finds the job
// again and keeps following it. The record is the shared job store's.

import {
  jobCommonFields, jobDir, jobGet, jobSiteProgress, listJobIds, queueJob, readJobResult, runSiteJob, type startJobUnit,
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

export function wpJobView(jobsDir: string, id: string): WpJobView | null {
  const dir = jobDir(jobsDir, id);
  const task = WP_JOB_TASKS.find((known) => known === jobGet(dir, "task"));
  if (!task) return null;
  return {
    id,
    task,
    policy: policyOf(task),
    // Up to MAX_JOB_DOMAINS names, well past jobGet's usual cap.
    domains: jobGet(dir, "domains", MAX_JOB_DOMAINS * 256).split(",").filter(Boolean),
    ...jobCommonFields(dir),
    ...jobSiteProgress(dir),
    result: readJobResult<WpJobView["result"]>(dir),
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
  const id = queueJob({
    addon: "wp-tools",
    jobsDir,
    fields: { task, domains: domains.join(",") },
    description: `clp-addons: WordPress Tools ${task}`,
    actionBinary: options.actionBinary,
    runtimeSeconds: JOB_RUNTIME_SECONDS,
    start: options.start,
  });
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
  await runSiteJob(jobDir(jobsDir, id), VERBS[view.task], (onProgress) => work(view.task, view.domains, onProgress));
}

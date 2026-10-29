// Checks, installations and connections an operator starts from the page run as
// background jobs: a check of every site can take minutes, longer than a
// request should be held open, and a page reloaded meanwhile finds the job
// again and keeps following it. The record is the shared job store's.

import {
  jobCommonFields, jobDir, jobGet, jobSiteProgress, listJobIds, queueJob, readJobResult, runSiteJob, type startJobUnit,
} from "../../cli/job-store";
import type { MainwpResult } from "./mainwp";
import type { NewSitePlugin, NewSiteResult } from "./new-site-plugins";
import type { VarnishSyncResult } from "./varnish";
import type { WpProgress } from "./wp-cli";

/**
 * The tasks `start` takes. `new-site-plugins` is not one: only the `new-site`
 * verb records it, with the plan it validated and the uploads it claimed.
 */
export const WP_START_TASKS = ["varnish-check", "varnish-install", "mainwp-check", "mainwp-connect", "mainwp-cleanup"] as const;
export const WP_JOB_TASKS = [...WP_START_TASKS, "new-site-plugins"] as const;
export type WpJobTask = (typeof WP_JOB_TASKS)[number];
export type WpJobPolicy = "varnish" | "mainwp" | "plugins";

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
  /** What a new site's job was asked to install; empty for every other task. */
  plugins: NewSitePlugin[];
  /** The site manager who chose them, or "" for an administrator and every other task. */
  chosenBy: string;
  result: VarnishSyncResult | MainwpResult | NewSiteResult | null;
}

/** The job each policy is running, if any; one at a time per policy. */
export interface WpJobs {
  varnish: WpJobView | null;
  mainwp: WpJobView | null;
}

export function policyOf(task: WpJobTask): WpJobPolicy {
  return task === "new-site-plugins" ? "plugins" : task.startsWith("varnish-") ? "varnish" : "mainwp";
}

/** A plan is a few hundred bytes a plugin, and a job takes at most twenty. */
const MAX_PLAN_BYTES = 64 * 1024;

function planOf(dir: string): NewSitePlugin[] {
  try {
    const plan = JSON.parse(jobGet(dir, "plugins", MAX_PLAN_BYTES) || "[]") as unknown;
    return Array.isArray(plan) ? plan as NewSitePlugin[] : [];
  } catch {
    return [];
  }
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
    plugins: task === "new-site-plugins" ? planOf(dir) : [],
    chosenBy: jobGet(dir, "chosenBy"),
    result: readJobResult<WpJobView["result"]>(dir),
  };
}

export function activeWpJobs(jobsDir: string): WpJobs {
  const jobs: WpJobs = { varnish: null, mainwp: null };
  for (const id of listJobIds(jobsDir)) {
    const view = wpJobView(jobsDir, id);
    if (view && view.policy !== "plugins" && active(view.state) && !jobs[view.policy]) jobs[view.policy] = view;
  }
  return jobs;
}

/** New sites' plugin jobs, newest first: every running one, and what the `limit` most recent finished ones did. */
export function newSiteJobs(jobsDir: string, limit = 10): WpJobView[] {
  const jobs: WpJobView[] = [];
  let finished = 0;
  for (const id of listJobIds(jobsDir)) {
    const view = wpJobView(jobsDir, id);
    if (view?.task !== "new-site-plugins") continue;
    if (active(view.state)) { jobs.push(view); continue; }
    const result = view.result as NewSiteResult | null;
    // A form CloudPanel rejected, or one submitted again, installed nothing and is no news.
    if ((result && result.outcome !== "done") || finished >= limit) continue;
    jobs.push(view);
    finished++;
  }
  return jobs;
}

/**
 * The new-site jobs still waiting for their site that `replaced` picks out:
 * what a later submission of the same form takes over.
 */
export function waitingNewSiteJobs(jobsDir: string, replaced: (view: WpJobView) => boolean): WpJobView[] {
  return listJobIds(jobsDir).flatMap((id) => {
    const view = wpJobView(jobsDir, id);
    return view?.task === "new-site-plugins" && active(view.state) && replaced(view)
      && jobGet(jobDir(jobsDir, id), "phase") !== "installing" ? [view] : [];
  });
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
  /** A new site's plan; new sites are not one at a time, since each waits for its own. */
  plugins?: NewSitePlugin[];
  /** The site manager a new site's plan is for. */
  chosenBy?: string;
}): WpJobView {
  const { jobsDir, task, domains } = options;
  const policy = policyOf(task);
  const running = policy === "plugins" ? null : activeWpJobs(jobsDir)[policy];
  if (running) {
    throw new Error(policy === "varnish" ? "a CLP Varnish Cache job is already running" : "a MainWP job is already running");
  }
  const id = queueJob({
    addon: "wp-tools",
    jobsDir,
    fields: {
      task, domains: domains.join(","),
      ...(options.plugins ? { plugins: JSON.stringify(options.plugins) } : {}),
      ...(options.chosenBy ? { chosenBy: options.chosenBy } : {}),
    },
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
  "new-site-plugins": "Installing",
};

/** Run a recorded job to its end, writing its progress as it goes. */
export async function runWpJob(
  jobsDir: string,
  id: string,
  work: (view: WpJobView, onProgress: (progress: WpProgress) => void, step: (text: string) => void) => Promise<NonNullable<WpJobView["result"]>>,
): Promise<void> {
  const view = wpJobView(jobsDir, id);
  if (!view) throw new Error(`no such job: ${id}`);
  await runSiteJob(jobDir(jobsDir, id), VERBS[view.task], (onProgress, step) => work(view, onProgress, step));
}

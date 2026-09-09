import { readSnapshot, snapshotAgeSeconds, type PanelSnapshot } from "../../../lib/snapshot-reader";
// Every privileged action goes through the wrapper. The app has no clpctl
// access, no database access and no write access to any site's files: it can
// only ask for one of a closed set of verbs, with arguments the wrapper
// re-validates before acting.

import { execFile } from "node:child_process";
import type { ExecFileOptions } from "node:child_process";

/**
 * execFile, awaited, with an optional stdin.
 *
 * Written out rather than `promisify(execFile)` because the one credential this
 * addon passes to the wrapper travels on stdin, and the promisified form gives
 * no handle to write to. `execFile` returns the ChildProcess synchronously, so
 * the write happens before anything is awaited.
 */
function runCommand(
  cmd: string,
  args: string[],
  options: ExecFileOptions,
  input?: string
): Promise<{ error: (Error & { code?: number }) | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, options, (error, stdout, stderr) => {
      resolve({
        error: error as (Error & { code?: number }) | null,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
      });
    });
    // Every wrapper verb validates its arguments before it reads stdin, so the
    // ordinary rejection path exits with the pipe still unread. Anything larger
    // than the 64 KiB pipe buffer then fails the write with EPIPE -- and that
    // fires on a stream tick outside this promise, where `Bun.serve` cannot turn
    // it into a 500. Without a listener Node's default for an 'error' event is
    // to throw, so one oversized field killed the process that serves every
    // addon. The wrapper's own reply is the answer either way; a write that
    // could not be delivered adds nothing but a line in the journal.
    child.stdin?.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code !== "EPIPE") console.error("[wrapper] stdin could not be written:", err.code ?? err.message);
    });
    // Always closed, even with nothing to send: a wrapper verb that read stdin
    // would otherwise wait on a pipe nobody is going to write to.
    child.stdin?.end(input ?? "");
  });
}

const WRAPPER_BIN = process.env.STAGER_WRAPPER || "/usr/local/lib/clp-addons/clp-action-stager";
const SUDO_BIN = "/usr/bin/sudo";

// `clone` only writes a job record and hands the work to systemd, so it
// answers immediately -- the long operation is the job itself, which nothing
// here waits on. `describe` runs du over a whole site, which is the one read
// that can genuinely take a while.
const TIMEOUTS: Record<string, number> = {
  describe: 120_000,
  clone: 60_000,
};
const DEFAULT_TIMEOUT = 30_000;

export interface WrapperResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

async function callWrapper<T = unknown>(
  verb: string,
  args: string[],
  // On stdin rather than in argv, because the only value that ever needs this
  // is a password and argv is world-readable through /proc.
  input?: string
): Promise<WrapperResult<T>> {
  const argv = [verb, ...args];
  const runningAsRoot = process.getuid?.() === 0;
  const cmd = runningAsRoot ? WRAPPER_BIN : SUDO_BIN;
  const cmdArgs = runningAsRoot ? argv : ["-n", WRAPPER_BIN, ...argv];

  const { error, stdout, stderr } = await runCommand(
    cmd,
    cmdArgs,
    { timeout: TIMEOUTS[verb] ?? DEFAULT_TIMEOUT, maxBuffer: 8 * 1024 * 1024 },
    input
  );
  if (error && !stdout.trim()) {
    // Never `error.message`. execFile builds it as "Command failed: <full
    // argv>", so logging it put every argument this addon passes -- including
    // --email, the address of another site's administrator -- into the journal,
    // which is the same mistake as passing a credential in argv with an extra
    // step. The wrapper's own stderr is the useful half and carries nothing that
    // was not meant to be read.
    const why = stderr.trim() || `wrapper ${verb} exited ${error.code ?? "abnormally"}`;
    console.error(`[wrapper] ${verb} failed without a JSON reply:`, why);
    return { ok: false, error: why };
  }

  if (stderr.trim()) console.error(`[wrapper:${verb}]`, stderr.trim());

  // stdout is a contract: exactly one JSON object. Never scrape the prose on
  // stderr for meaning.
  try {
    return JSON.parse(stdout.trim()) as WrapperResult<T>;
  } catch {
    console.error(`[wrapper] ${verb} produced unparseable stdout:`, stdout.slice(0, 500));
    return { ok: false, error: "wrapper returned a malformed reply" };
  }
}

// Mirrors the wrapper's own validation. Not a substitute for it: the wrapper is
// the boundary and re-checks everything. This exists so the UI can reject bad
// input with a useful message instead of a generic wrapper error.
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const JOB_RE = /^\d{8}T\d{6}Z-[0-9a-f]{6}$/;

export function validateDomain(d: unknown): string | null {
  return typeof d === "string" && d.length <= 253 && DOMAIN_RE.test(d) ? d : null;
}

export function validateJobId(j: unknown): string | null {
  return typeof j === "string" && JOB_RE.test(j) ? j : null;
}

/**
 * Expand the shorthand the original script accepted: a bare label becomes a
 * subdomain of the site being cloned.
 *
 * Here rather than in the wrapper because it is a convenience, and the wrapper
 * must not rewrite its input -- a boundary that silently corrects a value is
 * one that eventually corrects it wrong. What crosses the boundary is always a
 * complete hostname.
 */
export function expandTarget(input: string, source: string): string {
  const t = input.trim().toLowerCase().replace(/\.$/, "");
  if (!t) return "";
  return t.includes(".") ? t : `${t}.${source}`;
}

/** The `site.type` values the wrapper will clone. Kept in step with CLONABLE_TYPES. */
export type SiteType = "php" | "static" | "reverse-proxy";

export interface SiteSummary {
  domain: string;
  siteType: SiteType | string;
  siteUser: string;
  /** Empty for anything but a PHP site: the others have no php_settings row. */
  phpVersion: string;
  application: string;
  databases: number;
}

export interface SiteDetail extends Omit<SiteSummary, "databases"> {
  /** True when a reverse-proxy source's backend is an Instatic instance of ours. */
  instatic: boolean;
  rootDirectory: string;
  database: string;
  sizeMb: number;
}

export interface JobResult {
  siteType: SiteType | string;
  siteUser: string;
  phpVersion: string;
  vhostTemplate: string;
  /** Whether the source site's own vhost was reproduced for the clone. */
  vhostCarried: boolean;
  /**
   * How it was reproduced. `template` is CloudPanel's own vhost-template route,
   * available only for PHP; `rendered` is the panel-record write plus a rendered
   * file, which is the only route for every other type; `stock` means it was not
   * carried and the notes say why.
   */
  vhostCarriedBy: "template" | "rendered" | "stock" | string;
  database: { source: string; name: string; user: string; password: string } | null;
  /** The clone's own Instatic instance, when the source was one. */
  instatic: { port: number; tag: string; email: string; password: string } | null;
  notes: string[];
}

export interface JobView {
  id: string;
  source: string;
  target: string;
  /** The Instatic port this clone reserved, or 0 for a clone that needed none. */
  port: number;
  state: "queued" | "running" | "done" | "failed" | string;
  step: string;
  error: string;
  createdAt: string;
  startedAt: string;
  finishedAt: string;
  result: JobResult | null;
  panelSite?: boolean | null;
}

/**
 * `describe` is the one read that costs real work: the wrapper runs `du -sm`
 * over the source's whole document root as root, with a 120-second timeout.
 * Measured on this box, one pass over ~18 GB took 22 seconds of wall time and 9
 * of system time. Nothing bounded how many could run at once, so a handful of
 * requests could keep root walking the disk indefinitely.
 *
 * Requests are authenticated now, which takes the anonymous version of that
 * away. It does not take away the browser version: a page on another origin can
 * point an `<img>` at this route, and the browser attaches the operator's Basic
 * Auth credentials on its own. So the work itself is bounded rather than the
 * caller.
 *
 * One at a time, and a short queue -- past that the answer is an error, because
 * a caller waiting behind fifty disk walks would rather be told than timed out.
 * Repeating the same domain joins the in-flight call instead of starting a
 * second identical walk, which is the shape a refreshed page actually makes.
 */
const DESCRIBE_QUEUE_MAX = 4;
let describeRunning = 0;
let describeQueued = 0;
let describeChain: Promise<unknown> = Promise.resolve();
const describeInFlight = new Map<string, Promise<WrapperResult<SiteDetail>>>();

async function withDescribeSlot(
  domain: string,
  work: () => Promise<WrapperResult<SiteDetail>>,
): Promise<WrapperResult<SiteDetail>> {
  const shared = describeInFlight.get(domain);
  if (shared) return shared;

  if (describeRunning > 0 && describeQueued >= DESCRIBE_QUEUE_MAX) {
    return { ok: false, error: "too many size scans are already running; try again in a moment" };
  }

  describeQueued++;
  const run = describeChain.then(async () => {
    describeQueued--;
    describeRunning++;
    try {
      return await work();
    } finally {
      describeRunning--;
      describeInFlight.delete(domain);
    }
  });
  // The chain must not break on a rejection, or every later caller inherits it.
  describeChain = run.catch(() => undefined);
  describeInFlight.set(domain, run);
  return run;
}

export const stagerService = {
  async listSites(): Promise<SiteSummary[]> {
    const res = await callWrapper<{ sites: SiteSummary[] }>("sites", []);
    if (!res.ok) {
      console.error("[stager] could not list sites:", res.error);
      return [];
    }
    return res.data?.sites ?? [];
  },

  async describe(domain: string): Promise<WrapperResult<SiteDetail>> {
    return withDescribeSlot(domain, () => callWrapper<SiteDetail>("describe", ["--domain", domain]));
  },

  /**
   * Start a clone.
   *
   * `instatic` is supplied only when the source is an Instatic site. Its port
   * is allocated here rather than guessed by the wrapper: `getNextAvailablePort`
   * reads the panel snapshot both addons share, so the number that crosses the
   * boundary is one the wrapper only has to re-validate.
   *
   * Both secrets travel on stdin, one per line, and neither is ever an argument.
   * argv is readable out of `ps` by every account on the box, and worse than
   * that: `sudo` journals this wrapper's whole COMMAND line, so an argument
   * outlives the process entirely. The authentication code was in argv until
   * that was measured against this box's own journal -- and the wrapper
   * deliberately accepts a *recovery* code there, which does not expire.
   */
  async startClone(
    source: string,
    target: string,
    tls: boolean,
    instatic?: { port: number; email: string; password: string; mfaCode?: string }
  ): Promise<WrapperResult<{ job: string }>> {
    const args = ["--source", source, "--target", target, "--tls", tls ? "yes" : "no"];
    if (instatic) args.push("--port", String(instatic.port), "--email", instatic.email);
    const input = instatic
      // Always two lines, even with no code. A channel whose field count
      // varies cannot tell a password containing a newline from a password
      // followed by a code; a fixed count lets the wrapper refuse the first.
      ? `${instatic.password}\n${instatic.mfaCode ?? ""}\n`
      : undefined;
    return callWrapper<{ job: string }>("clone", args, input);
  },

  async getJob(id: string): Promise<WrapperResult<{ job: JobView; log: string }>> {
    return callWrapper<{ job: JobView; log: string }>("job", ["--job", id]);
  },

  async listJobs(): Promise<JobView[]> {
    const res = await callWrapper<{ jobs: JobView[] }>("jobs", []);
    if (!res.ok) {
      console.error("[stager] could not list jobs:", res.error);
      return [];
    }
    return res.data?.jobs ?? [];
  },

  /**
   * The same list, but a wrapper failure is an error rather than an empty one.
   *
   * The dashboard can render "no clones yet" and be read by someone who knows
   * the difference. The port allocator cannot: an empty list means every
   * in-flight clone's reserved port silently disappears from the calculation,
   * and the next clone is handed one that is already spoken for. So the two
   * readers ask different questions.
   */
  async listJobsOrThrow(): Promise<JobView[]> {
    const res = await callWrapper<{ jobs: JobView[] }>("jobs", []);
    if (!res.ok) throw new Error(res.error ?? "the stager wrapper could not list jobs");
    return res.data?.jobs ?? [];
  },

  snapshot(): { snap: PanelSnapshot; ageSeconds: number } {
    const snap = readSnapshot();
    return { snap, ageSeconds: snapshotAgeSeconds(snap) };
  },
};

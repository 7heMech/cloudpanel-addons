import { fetchPanelInfo, snapshotAgeSeconds, type PanelSnapshot } from "../../../lib/snapshot-reader";
import { callGatewayAction, type ActionResult } from "../../../lib/gateway-client";
export { type ActionResult };

// clone only writes a job record and hands the work to systemd, so it
// answers immediately -- the long operation is the job itself, which nothing
// here waits on. describe runs du over a whole site, which is the one read
// that can genuinely take a while.
const TIMEOUTS: Record<string, number> = {
  describe: 120_000,
  clone: 60_000,
};
const DEFAULT_TIMEOUT = 30_000;

export interface ActionCallOptions {
  timeout?: number;
  maxBuffer?: number;
}

export async function callAction<T = unknown>(
  verb: string,
  args: string[],
  // On stdin rather than in argv, because the only value that ever needs this
  // is a password and argv is world-readable through /proc.
  input?: string,
  options: ActionCallOptions = {},
): Promise<ActionResult<T>> {
  return callGatewayAction<T>("stager", verb, args, input, {
    timeout: options.timeout ?? TIMEOUTS[verb] ?? DEFAULT_TIMEOUT,
    maxBuffer: options.maxBuffer,
  });
}

// Mirrors the action binary's own validation. Not a substitute for it: the
// action binary is the boundary and re-checks everything. This exists so the
// UI can reject bad input with a useful message instead of a generic error
// from the action binary.
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const JOB_RE = /^\d{8}T\d{6}Z-[0-9a-f]{6}$/;

export function validateDomain(d: unknown): string | null {
  return typeof d === "string" && d.length <= 253 && DOMAIN_RE.test(d) ? d : null;
}

export function validateJobId(j: unknown): string | null {
  return typeof j === "string" && JOB_RE.test(j) ? j : null;
}

/**
 * Expand the shorthand the original wrapper script accepted: a bare label
 * becomes a subdomain of the site being cloned.
 *
 * Here rather than in the action binary because it is a convenience, and the
 * action binary must not rewrite its input -- a boundary that silently
 * corrects a value is one that eventually corrects it wrong. What crosses the
 * boundary is always a complete hostname.
 */
export function expandTarget(input: string, source: string): string {
  const t = input.trim().toLowerCase().replace(/\.$/, "");
  if (!t) return "";
  return t.includes(".") ? t : `${t}.${source}`;
}

/** The `site.type` values the action binary will clone (CLONABLE_TYPES in
 * addons/stager/action.ts). Kept in step with it. */
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
 * `describe` is the one read that costs real work: the action
 * binary runs `du -sm` over the source's whole document root as root, with a
 * 120-second timeout.
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
const describeInFlight = new Map<string, Promise<ActionResult<SiteDetail>>>();

async function withDescribeSlot(
  domain: string,
  work: () => Promise<ActionResult<SiteDetail>>,
): Promise<ActionResult<SiteDetail>> {
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
    const res = await callAction<{ sites: SiteSummary[] }>("sites", []);
    if (!res.ok) {
      console.error("[stager] could not list sites:", res.error);
      return [];
    }
    return res.data?.sites ?? [];
  },

  async describe(domain: string): Promise<ActionResult<SiteDetail>> {
    return withDescribeSlot(domain, () => callAction<SiteDetail>("describe", ["--domain", domain]));
  },

  /**
   * Start a clone.
   *
   * `instatic` is supplied only when the source is an Instatic site. Its port
   * is allocated here rather than guessed by the action binary: `getNextAvailablePort`
   * reads the panel snapshot both addons share, so the number that crosses the
   * boundary is one the action binary only has to re-validate.
   *
   * Both secrets travel on stdin, one per line, and neither is ever an argument.
   * argv is readable out of `ps` by every account on the box, and worse than
   * that: `sudo` journals this action binary's whole COMMAND line, so an argument
   * outlives the process entirely. The authentication code was in argv until
   * that was measured against this box's own journal -- and the action binary
   * deliberately accepts a *recovery* code there, which does not expire.
   */
  async startClone(
    source: string,
    target: string,
    tls: boolean,
    instatic?: { port: number; email: string; password: string; mfaCode?: string }
  ): Promise<ActionResult<{ job: string }>> {
    const args = ["--source", source, "--target", target, "--tls", tls ? "yes" : "no"];
    if (instatic) args.push("--port", String(instatic.port), "--email", instatic.email);
    const input = instatic
      // Always two lines, even with no code. A channel whose field count
      // varies cannot tell a password containing a newline from a password
      // followed by a code; a fixed count lets the action binary refuse the first.
      ? `${instatic.password}\n${instatic.mfaCode ?? ""}\n`
      : undefined;
    return callAction<{ job: string }>("clone", args, input);
  },

  async getJob(id: string): Promise<ActionResult<{ job: JobView; log: string }>> {
    return callAction<{ job: JobView; log: string }>("job", ["--job", id]);
  },

  async listJobs(): Promise<JobView[]> {
    const res = await callAction<{ jobs: JobView[] }>("jobs", []);
    if (!res.ok) {
      console.error("[stager] could not list jobs:", res.error);
      return [];
    }
    return res.data?.jobs ?? [];
  },

  /**
   * The same list, but a call failure is an error rather than an empty one.
   *
   * The dashboard can render "no clones yet" and be read by someone who knows
   * the difference. The port allocator cannot: an empty list means every
   * in-flight clone's reserved port silently disappears from the calculation,
   * and the next clone is handed one that is already spoken for. So the two
   * readers ask different questions.
   */
  async listJobsOrThrow(): Promise<JobView[]> {
    const res = await callAction<{ jobs: JobView[] }>("jobs", []);
    if (!res.ok) throw new Error(res.error ?? "the stager action could not list jobs");
    return res.data?.jobs ?? [];
  },

  /** Fetch current panel state and report how many seconds ago it was collected. */
  async snapshot(): Promise<{ snap: PanelSnapshot; ageSeconds: number }> {
    const snap = await fetchPanelInfo();
    return { snap, ageSeconds: snapshotAgeSeconds(snap) };
  },
};

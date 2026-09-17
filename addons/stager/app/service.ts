import type { SiteContext } from "../../../lib/site-context";
import { fetchPanelInfo, readPanelSnapshot, type PanelSnapshot } from "../../../lib/snapshot-reader";
import { callGatewayAction, streamGatewayAction, type ActionResult, type GatewayStream } from "../../../lib/gateway-client";
import type { JobWatcher } from "../../../lib/job-stream";
export { type ActionResult };

// clone only writes a job record and hands the work to systemd, so it
// answers immediately -- the long operation is the job itself, which nothing
// here waits on. describe runs du over a whole site, which is the one read
// that can genuinely take a while.
const TIMEOUTS: Record<string, number> = {
  describe: 120_000,
  clone: 60_000,
  promote: 60_000,
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


export function validateDomain(d: unknown): string | null {
  return typeof d === "string" && d.length <= 253 && DOMAIN_RE.test(d) ? d : null;
}

export { validateJobId } from "../../../lib/job-id";

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

/**
 * What a promote records.
 *
 * Deliberately not a superset of a clone's result: a promote creates no site,
 * no database and no account, so it has no credentials to hand back. What it
 * has instead is where the replaced document root went and what was kept from
 * the live site.
 */
export interface PromoteResult {
  siteType: SiteType | string;
  siteUser: string;
  /** The live document root as it was before the switch, kept for the job's retention. */
  previousRoot: string;
  /** Paths taken from the live site rather than from the staging copy. */
  preserved: string[];
  /** Where the pre-switch dump of the live database was written, if it had one. */
  databaseBackup: string | null;
  /** Where the live Instatic instance's own content export was written. */
  contentBackup: string | null;
  notes: string[];
}

export function isPromoteResult(job: JobView): job is JobView & { result: PromoteResult | null } {
  return job.kind === "promote";
}

export interface JobView {
  id: string;
  /** `clone` creates a staging site; `promote` moves one back onto its live site. */
  kind: "clone" | "promote" | string;
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
  /** Optional one-shot event emitted by the job runner. */
  event?: string;
  result: JobResult | PromoteResult | null;
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
   * is allocated here rather than guessed by the action binary:
   * `getNextAvailablePort` combines current panel and addon data, so the number
   * that crosses the boundary is one the action binary only has to re-validate.
   *
   * Both secrets travel on stdin, one per line, and neither is ever an
   * argument. Process arguments are visible to other accounts while the action
   * runs, and the authentication field may contain a recovery code that does
   * not expire.
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

  /**
   * Start a promote: put the staging copy's files or content onto the live site.
   *
   * `source` is the staging copy and `target` is the live site, which is the
   * reverse of startClone and the reason neither is called "staging". The live
   * database is never sent anywhere; see docs/decisions/stager.md for why.
   *
   * An Instatic promote signs in to both instances, so the channel carries two
   * passwords. Four lines, always, for the same reason the clone channel has
   * exactly two.
   */
  async startPromote(
    source: string,
    target: string,
    instatic?: {
      email: string; password: string; mfaCode?: string;
      targetEmail: string; targetPassword: string; targetMfaCode?: string;
    }
  ): Promise<ActionResult<{ job: string }>> {
    const args = ["--source", source, "--target", target];
    if (instatic) args.push("--email", instatic.email, "--target-email", instatic.targetEmail);
    const input = instatic
      ? `${instatic.password}\n${instatic.mfaCode ?? ""}\n${instatic.targetPassword}\n${instatic.targetMfaCode ?? ""}\n`
      : undefined;
    return callAction<{ job: string }>("promote", args, input);
  },

  async getJob(id: string): Promise<ActionResult<{ job: JobView; log: string }>> {
    return callAction<{ job: JobView; log: string }>("job", ["--job", id]);
  },

  watchJob(id: string, handlers: Parameters<JobWatcher<JobView>>[1]): GatewayStream {
    let ended = false;
    const close = (error?: string) => {
      if (ended) return;
      ended = true;
      handlers.onClose(error);
    };
    return streamGatewayAction<{ job: JobView; log: string }>({
      addon: "stager",
      verb: "watch-job",
      args: ["--job", id],
      onReply(reply) {
        if (reply.ok && reply.data) {
          handlers.onSnapshot(reply.data);
        } else if (!reply.ok) {
          close(reply.error);
        } else {
          close("gateway returned an empty job snapshot");
        }
      },
      onClose: close,
    });
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

  /** Fetches current panel information and reports its age at receipt. */
  async snapshot(): Promise<{ snap: PanelSnapshot; ageSeconds: number }> {
    return readPanelSnapshot();
  },

  /**
   * What the shell needs to keep drawing the panel's site information and tab
   * strip around this addon's site-scoped page, with the jobs that page shows.
   *
   * The panel snapshot is the authority on whether the site exists at all, so
   * a tab clicked on a site the panel no longer has says so rather than
   * rendering an empty Staging page for nothing.
   */
  async sitePage(domain: string): Promise<{ context: SiteContext; jobs: JobView[]; clonable: boolean }> {
    const [panel, jobs] = await Promise.all([fetchPanelInfo(), this.listJobs()]);
    const site = panel.sites.find((candidate) => candidate.domain.toLowerCase() === domain.toLowerCase());
    if (!site) throw new Error(`CloudPanel site not found: ${domain}`);
    return {
      context: {
        domain: site.domain,
        user: site.user,
        type: site.type,
        varnishCache: site.varnishCache,
        ...(panel.publicIp ? { publicIp: panel.publicIp } : {}),
      },
      jobs,
      // Mirrors CLONABLE in the injected Twig and CLONABLE_TYPES in the action.
      // A reverse proxy is only really clonable when its backend is an Instatic
      // instance, which the action decides by name; offering it and explaining
      // the refusal beats hiding it on a guess.
      clonable: ["php", "static", "reverse-proxy"].includes(site.type),
    };
  },
};

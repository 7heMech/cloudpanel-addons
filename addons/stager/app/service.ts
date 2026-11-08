import type { SiteContext } from "../../../lib/site-context";
import { fetchPanelInfo, readPanelSnapshot, type PanelSnapshot } from "../../../lib/snapshot-reader";
import { callGatewayAction, type ActionResult, type GatewayStream } from "../../../lib/gateway-client";
import type { WebVerb } from "../../../lib/gateway-protocol";
import { watchGatewayJob, type JobWatcher } from "../../../lib/job-stream";
export { type ActionResult };

const TIMEOUTS: Partial<Record<WebVerb<"stager">, number>> = {
  clone: 60_000,
  promote: 60_000,
};
const DEFAULT_TIMEOUT = 30_000;

interface ActionCallOptions {
  timeout?: number;
  maxBuffer?: number;
}

export async function callAction<T = unknown>(
  verb: WebVerb<"stager">,
  args: string[],
  // Passwords go on stdin: argv is world-readable through /proc.
  input?: string,
  options: ActionCallOptions = {},
): Promise<ActionResult<T>> {
  return callGatewayAction("stager", verb, args, input, {
    timeout: options.timeout ?? TIMEOUTS[verb] ?? DEFAULT_TIMEOUT,
    maxBuffer: options.maxBuffer,
  });
}

/**
 * A bare label becomes a subdomain of the site being cloned, of `example.com`
 * rather than `www.example.com`.
 *
 * Not in the action, which must not rewrite its input: what crosses the
 * boundary is always a complete hostname. The page sends what was typed; its
 * preview label runs a copy, expand-target.client.js.
 */
export function expandTarget(input: string, source: string): string {
  const t = String(input || "").trim().toLowerCase().replace(/\.$/, "");
  if (!t) return "";
  return t.indexOf(".") === -1 ? t + "." + source.replace(/^www\./, "") : t;
}

/** Kept in step with CLONABLE_TYPES in addons/stager/action.ts. */
type SiteType = "php" | "static" | "reverse-proxy";

export interface SiteSummary {
  domain: string;
  siteType: SiteType | string;
  siteUser: string;
  /** Empty for anything but a PHP site: the others have no php_settings row. */
  phpVersion: string;
  application: string;
  databases: number;
}

interface SiteDetail extends Omit<SiteSummary, "databases"> {
  /** True when a reverse-proxy source's backend is an Instatic instance of ours. */
  instatic: boolean;
  rootDirectory: string;
  database: string;
}

export interface JobResult {
  siteType: SiteType | string;
  siteUser: string;
  phpVersion: string;
  vhostTemplate: string;
  vhostCarried: boolean;
  /**
   * `template` is CloudPanel's own vhost-template route, available only for
   * PHP; `rendered` is the panel-record write plus a rendered file, the only
   * route for every other type; `stock` means it was not carried and the notes
   * say why.
   */
  vhostCarriedBy: "template" | "rendered" | "stock" | string;
  database: { source: string; name: string; user: string; password: string } | null;
  /** The clone's own Instatic instance, when the source was one. */
  instatic: { port: number; tag: string; email: string; password: string } | null;
  notes: string[];
}

export interface PromoteResult {
  siteType: SiteType | string;
  siteUser: string;
  /** Kept for the job's retention. */
  previousRoot: string;
  preserved: string[];
  databaseBackup: string | null;
  contentBackup: string | null;
  notes: string[];
}

export interface JobView {
  id: string;
  kind: "clone" | "promote" | string;
  source: string;
  target: string;
  /** 0 for a clone that reserved no Instatic port. */
  port: number;
  state: "queued" | "running" | "done" | "failed" | string;
  step: string;
  error: string;
  createdAt: string;
  startedAt: string;
  finishedAt: string;
  event?: string;
  result: JobResult | PromoteResult | null;
  /** Null when unknown. */
  panelSite?: boolean | null;
  sourcePanelSite?: boolean | null;
}

/** "" when the clone can be promoted. */
export function promoteBlocked(job: JobView): string {
  if (job.kind === "promote") return "That job is itself a promote; promote from the clone that created the staging site.";
  if (job.state !== "done") return `That clone is ${job.state}. Only a finished clone can be promoted.`;
  if (!job.result) return "That clone recorded no result, so there is nothing to say what it produced.";
  if (!job.source || !job.target) return "That clone record is incomplete.";
  if (job.panelSite === false) return `${job.target} has been deleted from CloudPanel, so there is nothing to promote.`;
  if (job.sourcePanelSite === false) return `${job.source} has been deleted from CloudPanel, so there is no live site to promote onto.`;
  // Unknown is not present: the action would refuse it after the confirmation.
  if (job.panelSite !== true || job.sourcePanelSite !== true) return "CloudPanel's site list could not be read, so neither site can be confirmed. Try again in a moment.";
  return "";
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
    return callAction<SiteDetail>("describe", ["--domain", domain]);
  },

  /**
   * Both secrets travel on stdin, never as arguments: process arguments are
   * visible to other accounts while the action runs, and the authentication
   * field may hold a recovery code that does not expire.
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
      // Always two lines, even with no code, so the action can tell a password
      // containing a newline from a password followed by a code, and refuse it.
      ? `${instatic.password}\n${instatic.mfaCode ?? ""}\n`
      : undefined;
    return callAction<{ job: string }>("clone", args, input);
  },

  /**
   * `source` is the staging copy and `target` is the live site, the reverse of
   * startClone. An Instatic promote signs in to both instances: four lines,
   * always, for the same reason the clone channel has exactly two.
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
    return watchGatewayJob<JobView>("stager", id, handlers);
  },

  async listJobs(): Promise<JobView[]> {
    const res = await callAction<{ jobs: JobView[] }>("jobs", []);
    if (!res.ok) {
      console.error("[stager] could not list jobs:", res.error);
      return [];
    }
    return res.data?.jobs ?? [];
  },

  /** For the port allocator, where an empty list would hand out a port an in-flight clone reserved. */
  async listJobsOrThrow(): Promise<JobView[]> {
    const res = await callAction<{ jobs: JobView[] }>("jobs", []);
    if (!res.ok) throw new Error(res.error ?? "the stager action could not list jobs");
    return res.data?.jobs ?? [];
  },

  async snapshot(): Promise<{ snap: PanelSnapshot; ageSeconds: number }> {
    return readPanelSnapshot();
  },

  /** A tab clicked on a site the panel no longer has says so rather than rendering an empty page. */
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
      // Mirrors CLONABLE in the injected Twig and CLONABLE_TYPES in the action,
      // which refuses a reverse proxy not backed by an Instatic instance.
      clonable: ["php", "static", "reverse-proxy"].includes(site.type),
    };
  },
};

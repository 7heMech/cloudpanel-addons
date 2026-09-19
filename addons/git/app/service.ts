// What the Git addon's pages ask of the root gateway.
//
// Every privileged answer comes from one action verb, and the validation here
// mirrors the action's own so a form can say what is wrong without a round
// trip. The action remains the boundary and re-checks everything.

import { callGatewayAction, type ActionResult, type GatewayStream } from "../../../lib/gateway-client";
import { watchGatewayJob, type JobWatcher } from "../../../lib/job-stream";
import { fetchPanelInfo } from "../../../lib/snapshot-reader";
import type { SiteContext } from "../../../lib/site-context";
import type { GitHookPayload, GitHookResult, GitJobView, GitSiteStatus, GitWebhook } from "../action";

export type {
  GitCommit, GitDeployResult, GitHookPayload, GitHookResult, GitJobView, GitSiteConfig, GitSiteStatus, GitWebhook,
} from "../action";
export { validateJobId } from "../../../lib/job-id";

// keygen shells out to ssh-keygen and deploy only writes a record and hands the
// work to systemd; neither is slow, and the deployment itself is the job.
const TIMEOUTS: Record<string, number> = { sites: 60_000, keygen: 30_000 };
const DEFAULT_TIMEOUT = 20_000;

function action<T>(verb: string, args: string[] = [], input?: string): Promise<ActionResult<T>> {
  return callGatewayAction<T>("git", verb, args, input, {
    timeout: TIMEOUTS[verb] ?? DEFAULT_TIMEOUT,
    maxBuffer: 1024 * 1024,
  });
}

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function validateDomain(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const domain = value.trim().toLowerCase().replace(/\.$/, "");
  return domain.length <= 253 && DOMAIN_RE.test(domain) ? domain : null;
}

/** One site's status together with the panel context its page is drawn in. */
export interface GitSitePage {
  site: GitSiteStatus;
  context: SiteContext;
}

export interface GitSettings {
  remote: string;
  branch: string;
  directory: string;
  postDeploy: string;
}

export const gitService = {
  async listSites(): Promise<GitSiteStatus[]> {
    const res = await action<{ sites: GitSiteStatus[] }>("sites");
    if (!res.ok || !res.data) throw new Error(res.error ?? "the configured sites could not be read");
    return res.data.sites;
  },

  /** Just the names, for the link CloudPanel's own site list draws per row. */
  async configuredDomains(): Promise<string[]> {
    const res = await action<{ domains: string[] }>("domains");
    if (!res.ok || !res.data) throw new Error(res.error ?? "the configured sites could not be read");
    return res.data.domains.filter((domain): domain is string => validateDomain(domain) !== null);
  },

  async site(domain: string): Promise<GitSitePage> {
    const [panel, res] = await Promise.all([
      fetchPanelInfo(),
      action<{ site: GitSiteStatus }>("status", [`--domain=${domain}`]),
    ]);
    if (!res.ok || !res.data) throw new Error(res.error ?? `${domain} could not be read`);
    const panelSite = panel.sites.find((candidate) => candidate.domain.toLowerCase() === domain);
    if (!panelSite) throw new Error(`CloudPanel site not found: ${domain}`);
    return {
      site: res.data.site,
      context: {
        domain: panelSite.domain,
        user: panelSite.user,
        type: panelSite.type,
        varnishCache: panelSite.varnishCache,
        ...(panel.publicIp ? { publicIp: panel.publicIp } : {}),
      },
    };
  },

  configure(domain: string, settings: GitSettings): Promise<ActionResult<{ site: GitSiteStatus }>> {
    return action<{ site: GitSiteStatus }>("configure", [`--domain=${domain}`], JSON.stringify(settings));
  },

  forget(domain: string): Promise<ActionResult<{ domain: string }>> {
    return action<{ domain: string }>("forget", [`--domain=${domain}`]);
  },

  generateKey(domain: string, replace: boolean): Promise<ActionResult<{ publicKey: string }>> {
    return action<{ publicKey: string }>("keygen", [`--domain=${domain}`, ...(replace ? ["--replace"] : [])]);
  },

  /** Mint the push-to-deploy URL, rotate it with `replace`, or invalidate it. */
  setWebhook(domain: string, enabled: boolean, replace = false): Promise<ActionResult<{ webhook: GitWebhook | null }>> {
    // Only an enable takes --replace; the action refuses it on a disable.
    return enabled
      ? action<{ webhook: GitWebhook }>("webhook-enable", [`--domain=${domain}`, ...(replace ? ["--replace"] : [])])
      : action<{ webhook: null }>("webhook-disable", [`--domain=${domain}`]);
  },

  /**
   * One delivery. The token is checked where the record can be read, which is
   * root, so this call both authenticates the delivery and queues its work.
   */
  hook(domain: string, payload: GitHookPayload): Promise<ActionResult<GitHookResult>> {
    return action<GitHookResult>("hook", [`--domain=${domain}`], JSON.stringify(payload));
  },

  deploy(domain: string): Promise<ActionResult<{ job: string }>> {
    return action<{ job: string }>("deploy", [`--domain=${domain}`]);
  },

  getJob(id: string): Promise<ActionResult<{ job: GitJobView; log: string }>> {
    return action<{ job: GitJobView; log: string }>("job", [`--job=${id}`]);
  },

  watchJob(id: string, handlers: Parameters<JobWatcher<GitJobView>>[1]): GatewayStream {
    return watchGatewayJob<GitJobView>("git", id, handlers);
  },
};

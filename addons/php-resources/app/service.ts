import { callGatewayAction, type ActionResult } from "../../../lib/gateway-client";
import { fetchPanelInfo } from "../../../lib/snapshot-reader";
import type { SiteContext } from "../../../lib/site-context";
import type { PhpResourcesState, PoolProfile, PoolSiteState } from "../action";

const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function validateDomain(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const domain = value.trim().toLowerCase().replace(/\.$/, "");
  return domain.length <= 253 && DOMAIN_RE.test(domain) ? domain : null;
}

/** One site's pool state with the panel context its page is drawn in. */
export interface PhpResourcesSitePage {
  site: PoolSiteState;
  context: SiteContext;
}

function call<T>(verb: string, args: string[] = [], input?: string): Promise<ActionResult<T>> {
  // A save writes one file and reloads one php-fpm service, which is quick
  // unless the box is loaded; the default 60s is more than enough and the
  // shorter budget the read paths could use is not worth two timeouts.
  return callGatewayAction<T>("php-resources", verb, args, input);
}

async function requireData<T>(result: ActionResult<T>, fallback: string): Promise<T> {
  if (!result.ok || result.data === undefined) throw new Error(result.error ?? fallback);
  return result.data;
}

export const phpResourcesService = {
  state(): Promise<ActionResult<PhpResourcesState>> {
    return call<PhpResourcesState>("list");
  },

  get(domain: string): Promise<ActionResult<PoolSiteState>> {
    return call<PoolSiteState>("get", [`--domain=${domain}`]);
  },

  setSite(domain: string, profile: PoolProfile): Promise<ActionResult<PoolSiteState>> {
    return call<PoolSiteState>("set", [`--domain=${domain}`], JSON.stringify({ profile }));
  },

  resetSite(domain: string): Promise<ActionResult<PoolSiteState>> {
    return call<PoolSiteState>("reset", [`--domain=${domain}`]);
  },

  setDefault(profile: PoolProfile | null): Promise<ActionResult<{ default: PoolProfile | null }>> {
    return call<{ default: PoolProfile | null }>("default", [], JSON.stringify({ profile }));
  },

  /**
   * The site's pool state, together with what the shell needs to keep drawing
   * CloudPanel's site information and tab strip around it.
   */
  async site(domain: string): Promise<PhpResourcesSitePage> {
    const panel = await fetchPanelInfo();
    const site = panel.sites.find((candidate) => candidate.domain.toLowerCase() === domain);
    if (!site) throw new Error(`CloudPanel site not found: ${domain}`);
    const state = await requireData(await this.get(domain), "PHP pool settings are unavailable");
    return {
      site: state,
      context: {
        domain: site.domain,
        user: site.user,
        type: site.type,
        varnishCache: site.varnishCache,
        ...(panel.publicIp ? { publicIp: panel.publicIp } : {}),
      },
    };
  },
};

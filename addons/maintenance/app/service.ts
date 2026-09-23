import { callGatewayAction, type ActionResult } from "../../../lib/gateway-client";
import { fetchPanelInfo, type SanitizedSite } from "../../../lib/snapshot-reader";
import type { SiteContext } from "../../../lib/site-context";
import type { GlobalMaintenanceStatus, MaintenanceStatus } from "../action";

const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function validateDomain(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const domain = value.trim().toLowerCase().replace(/\.$/, "");
  return domain.length <= 253 && DOMAIN_RE.test(domain) ? domain : null;
}

export interface MaintenanceSiteView extends MaintenanceStatus {
  type: string;
  user: string;
  error?: string;
}

/** A site's status together with the panel context its page is drawn in. */
export interface MaintenanceSitePage {
  site: MaintenanceSiteView;
  context: SiteContext;
}

export interface MaintenanceTemplateView {
  domain: string;
  custom: boolean;
  html: string;
}

export interface BulkToggleResult {
  ok: boolean;
  data: {
    enabled: boolean;
    updated: string[];
    failed: { domain: string; error: string }[];
  };
}

function action<T>(verb: string, domain: string, input?: string): Promise<ActionResult<T>> {
  return callGatewayAction<T>("maintenance", verb, [`--domain=${domain}`], input, {
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
}

function globalAction<T>(verb: string, input?: string): Promise<ActionResult<T>> {
  return callGatewayAction<T>("maintenance", verb, [], input, {
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
}

async function requireResult<T>(result: ActionResult<T>, fallback: string): Promise<T> {
  if (!result.ok || result.data === undefined) throw new Error(result.error ?? fallback);
  return result.data;
}

export const maintenanceService = {
  async panelSites(): Promise<SanitizedSite[]> {
    return (await fetchPanelInfo()).sites;
  },

  async listSites(): Promise<MaintenanceSiteView[]> {
    const sites = await this.panelSites();
    const statuses: MaintenanceSiteView[] = [];
    // Bound root action fan-out on panels with a large fleet.
    for (let offset = 0; offset < sites.length; offset += 8) {
      statuses.push(...await Promise.all(sites.slice(offset, offset + 8).map(async (site): Promise<MaintenanceSiteView> => {
        const result = await action<MaintenanceStatus>("status", site.domain);
        if (!result.ok || !result.data) {
          return {
            domain: site.domain, type: site.type, user: site.user,
            enabled: false, customTemplate: false, bypasses: [],
            error: result.error ?? "status unavailable",
          };
        }
        return { ...result.data, type: site.type, user: site.user };
      })));
    }
    return statuses.sort((a, b) => a.domain.localeCompare(b.domain));
  },

  /**
   * One site's maintenance status, with what the shell needs to keep drawing
   * the panel's own site information and tab strip around it.
   */
  async site(domain: string): Promise<MaintenanceSitePage> {
    const panel = await fetchPanelInfo();
    const site = panel.sites.find((candidate) => candidate.domain.toLowerCase() === domain);
    if (!site) throw new Error(`CloudPanel site not found: ${domain}`);
    const status = await requireResult(await action<MaintenanceStatus>("status", domain), "maintenance status unavailable");
    return {
      site: { ...status, type: site.type, user: site.user },
      context: {
        domain: site.domain,
        user: site.user,
        type: site.type,
        varnishCache: site.varnishCache,
        ...(panel.publicIp ? { publicIp: panel.publicIp } : {}),
      },
    };
  },

  status(domain: string): Promise<ActionResult<MaintenanceStatus>> {
    return action("status", domain);
  },

  setEnabled(domain: string, enabled: boolean): Promise<ActionResult<MaintenanceStatus>> {
    return action(enabled ? "enable" : "disable", domain);
  },

  async globalStatus(): Promise<GlobalMaintenanceStatus> {
    const res = await globalAction<GlobalMaintenanceStatus>("global-status");
    const data = await requireResult(res, "global maintenance status unavailable");
    return data;
  },

  setGlobalBypasses(ips: string[]): Promise<ActionResult<GlobalMaintenanceStatus>> {
    return globalAction("global-set-bypass", JSON.stringify({ ips }));
  },

  async setGlobalEnabled(enabled: boolean): Promise<ActionResult<{ global: boolean }>> {
    return globalAction<{ global: boolean }>(enabled ? "global-enable" : "global-disable");
  },

  async setAllEnabled(enabled: boolean, domains?: string[]): Promise<BulkToggleResult> {
    const targetDomains = domains !== undefined
      ? domains
      : (await this.panelSites()).map((s) => s.domain);
    const updated: string[] = [];
    const failed: { domain: string; error: string }[] = [];

    for (let offset = 0; offset < targetDomains.length; offset += 8) {
      const batch = targetDomains.slice(offset, offset + 8);
      await Promise.all(batch.map(async (domain) => {
        try {
          const res = await this.setEnabled(domain, enabled);
          if (res.ok) {
            updated.push(domain);
          } else {
            failed.push({ domain, error: res.error ?? "failed to toggle" });
          }
        } catch (err) {
          failed.push({ domain, error: err instanceof Error ? err.message : String(err) });
        }
      }));
    }

    return {
      ok: true,
      data: {
        enabled,
        updated: updated.sort((a, b) => a.localeCompare(b)),
        failed: failed.sort((a, b) => a.domain.localeCompare(b.domain)),
      },
    };
  },

  template(domain: string): Promise<ActionResult<MaintenanceTemplateView>> {
    return action("get-template", domain);
  },

  setTemplate(domain: string, html: string): Promise<ActionResult<MaintenanceTemplateView>> {
    return action("set-template", domain, html);
  },

  resetTemplate(domain: string): Promise<ActionResult<MaintenanceTemplateView>> {
    return action("reset-template", domain);
  },

  setBypasses(domain: string, ips: string[]): Promise<ActionResult<MaintenanceStatus>> {
    return action("set-bypass", domain, JSON.stringify({ ips }));
  },
};

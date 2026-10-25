import { callGatewayAction, type ActionResult } from "../../../lib/gateway-client";
import { fetchPanelInfo } from "../../../lib/snapshot-reader";
import type { SiteContext } from "../../../lib/site-context";
import type { GlobalMaintenanceStatus, MaintenanceSiteStatus, MaintenanceStatus } from "../action";
import { validateDomain } from "../../../lib/app-http";

export { validateDomain };

export type MaintenanceSiteView = MaintenanceSiteStatus;

/** What the fleet page draws: every site and the global override. */
export interface MaintenanceFleet {
  global: GlobalMaintenanceStatus;
  sites: MaintenanceSiteView[];
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
  /** Set by a save whose HTML the sanitizer had to change. */
  removed?: boolean;
}

export interface BulkToggleResult {
  enabled: boolean;
  updated: string[];
  failed: { domain: string; error: string }[];
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
  async fleet(): Promise<MaintenanceFleet> {
    return requireResult(await globalAction<MaintenanceFleet>("sites"), "the sites could not be read");
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

  async setManyEnabled(domains: string[], enabled: boolean): Promise<BulkToggleResult> {
    const updated: string[] = [];
    const failed: { domain: string; error: string }[] = [];

    for (let offset = 0; offset < domains.length; offset += 8) {
      const batch = domains.slice(offset, offset + 8);
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
      enabled,
      updated: updated.sort((a, b) => a.localeCompare(b)),
      failed: failed.sort((a, b) => a.domain.localeCompare(b.domain)),
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

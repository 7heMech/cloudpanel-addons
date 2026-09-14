import { callGatewayAction, type ActionResult } from "../../../lib/gateway-client";
import { fetchPanelInfo, type SanitizedSite } from "../../../lib/snapshot-reader";
import type { MaintenanceStatus } from "../action";

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

export interface MaintenanceTemplateView {
  domain: string;
  custom: boolean;
  html: string;
}

function action<T>(verb: string, domain: string, input?: string): Promise<ActionResult<T>> {
  return callGatewayAction<T>("maintenance", verb, [`--domain=${domain}`], input, {
    timeout: 10_000,
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

  async site(domain: string): Promise<MaintenanceSiteView> {
    const site = (await this.panelSites()).find((candidate) => candidate.domain.toLowerCase() === domain);
    if (!site) throw new Error(`CloudPanel site not found: ${domain}`);
    const status = await requireResult(await action<MaintenanceStatus>("status", domain), "maintenance status unavailable");
    return { ...status, type: site.type, user: site.user };
  },

  status(domain: string): Promise<ActionResult<MaintenanceStatus>> {
    return action("status", domain);
  },

  setEnabled(domain: string, enabled: boolean): Promise<ActionResult<MaintenanceStatus>> {
    return action(enabled ? "enable" : "disable", domain);
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

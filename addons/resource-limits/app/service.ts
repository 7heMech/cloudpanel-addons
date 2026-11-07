import { MEMORY_GATEWAY_TIMEOUT_MS } from "../limits";
import type { MemorySettings } from "../memory";
import { callGatewayAction, type ActionResult } from "../../../lib/gateway-client";
import type { WebVerb } from "../../../lib/gateway-protocol";
import type { ResourceLimitsResult, ResourceLimitsState, PoolSiteState } from "../action";
import { validateDomain } from "../../../lib/app-http";

export { validateDomain };

function call<T>(verb: WebVerb<"resource-limits">, args: string[] = [], input?: string): Promise<ActionResult<T>> {
  // Assigning a fleet writes one file per site and reloads each PHP version
  // once, which is quick unless the box is loaded; the default 60s covers it,
  // and the shorter budget the read paths could use is not worth two timeouts.
  return callGatewayAction("resource-limits", verb, args, input);
}

export const resourceLimitsService = {
  setMemory(change: Partial<MemorySettings>): Promise<ActionResult<{ memory: MemorySettings }>> {
    return callGatewayAction("resource-limits", "set-memory", [], JSON.stringify(change), { timeout: MEMORY_GATEWAY_TIMEOUT_MS });
  },
  state(): Promise<ActionResult<ResourceLimitsState>> {
    return call<ResourceLimitsState>("list");
  },

  site(domain: string): Promise<ActionResult<PoolSiteState>> {
    return call<PoolSiteState>("site", [`--domain=${domain}`]);
  },

  saveCategory(body: unknown): Promise<ActionResult<ResourceLimitsResult>> {
    return call<ResourceLimitsResult>("save-category", [], JSON.stringify(body));
  },

  deleteCategory(id: unknown): Promise<ActionResult<ResourceLimitsResult>> {
    return call<ResourceLimitsResult>("delete-category", [], JSON.stringify({ id }));
  },

  assign(domains: unknown, categoryId: unknown): Promise<ActionResult<ResourceLimitsResult>> {
    return call<ResourceLimitsResult>("assign", [], JSON.stringify({ domains, categoryId }));
  },

  setDefault(categoryId: unknown): Promise<ActionResult<ResourceLimitsResult>> {
    return call<ResourceLimitsResult>("set-default", [], JSON.stringify({ categoryId }));
  },
};

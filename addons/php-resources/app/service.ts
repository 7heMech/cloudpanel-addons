import { callGatewayAction, type ActionResult } from "../../../lib/gateway-client";
import type { WebVerb } from "../../../lib/gateway-protocol";
import type { PhpResourcesResult, PhpResourcesState, PoolSiteState } from "../action";
import { validateDomain } from "../../../lib/app-http";

export { validateDomain };

function call<T>(verb: WebVerb<"php-resources">, args: string[] = [], input?: string): Promise<ActionResult<T>> {
  // Assigning a fleet writes one file per site and reloads each PHP version
  // once, which is quick unless the box is loaded; the default 60s covers it,
  // and the shorter budget the read paths could use is not worth two timeouts.
  return callGatewayAction("php-resources", verb, args, input);
}

export const phpResourcesService = {
  state(): Promise<ActionResult<PhpResourcesState>> {
    return call<PhpResourcesState>("list");
  },

  site(domain: string): Promise<ActionResult<PoolSiteState>> {
    return call<PoolSiteState>("site", [`--domain=${domain}`]);
  },

  saveCategory(body: unknown): Promise<ActionResult<PhpResourcesResult>> {
    return call<PhpResourcesResult>("save-category", [], JSON.stringify(body));
  },

  deleteCategory(id: unknown): Promise<ActionResult<PhpResourcesResult>> {
    return call<PhpResourcesResult>("delete-category", [], JSON.stringify({ id }));
  },

  assign(domains: unknown, categoryId: unknown): Promise<ActionResult<PhpResourcesResult>> {
    return call<PhpResourcesResult>("assign", [], JSON.stringify({ domains, categoryId }));
  },

  setDefault(categoryId: unknown): Promise<ActionResult<PhpResourcesResult>> {
    return call<PhpResourcesResult>("set-default", [], JSON.stringify({ categoryId }));
  },
};

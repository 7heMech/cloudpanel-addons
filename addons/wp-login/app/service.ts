import { callGatewayAction, type ActionResult } from "../../../lib/gateway-client";
import type { WpLoginResult, WpMaintenanceReply, WpBasicAuthReply, WpRemoveResult, WpSiteView } from "../action";
import { validateDomain } from "../../../lib/app-http";

export { validateDomain };

function call<T>(verb: string, args: string[] = [], timeout?: number): Promise<ActionResult<T>> {
  return callGatewayAction<T>("wp-login", verb, args, undefined, timeout ? { timeout } : undefined);
}

/** Finding the WordPress sites means a stat of every site root on the box. */
const LIST_TIMEOUT_MS = 60_000;

export const wpLoginService = {
  sites(): Promise<ActionResult<{ sites: WpSiteView[] }>> {
    return call<{ sites: WpSiteView[] }>("sites", [], LIST_TIMEOUT_MS);
  },

  // `asUser` is the panel user a non-administrator's request is on behalf of.
  // The root action is what checks it against CloudPanel's own user-to-site
  // mapping; this side only says whose request it is.
  signIn(
    domain: string,
    request: { asUser?: string; clientIp: string; addBypass: boolean; allowBasicAuth?: boolean },
  ): Promise<ActionResult<WpLoginResult | WpMaintenanceReply | WpBasicAuthReply>> {
    const args = [`--domain=${domain}`];
    if (request.asUser) args.push(`--as-user=${request.asUser}`);
    if (request.clientIp) args.push(`--client-ip=${request.clientIp}`);
    if (request.addBypass) args.push("--add-bypass");
    if (request.allowBasicAuth) args.push("--allow-basic-auth");
    return call<WpLoginResult | WpMaintenanceReply | WpBasicAuthReply>("sign-in", args);
  },

  remove(): Promise<ActionResult<WpRemoveResult>> {
    return call<WpRemoveResult>("remove", [], LIST_TIMEOUT_MS);
  },
};

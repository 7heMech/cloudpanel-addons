import { callGatewayAction, type ActionResult } from "../../../lib/gateway-client";
import type { WpLoginResult, WpMaintenanceReply, WpRemoveResult, WpSiteView } from "../action";
import { validateDomain } from "../../../lib/app-http";
import type { WpVarnishState, VarnishSyncResult } from "../varnish";

export { validateDomain };

function call<T>(verb: string, args: string[] = [], timeout?: number): Promise<ActionResult<T>> {
  return callGatewayAction<T>("wp-login", verb, args, undefined, timeout ? { timeout } : undefined);
}

/** Finding the WordPress sites means a stat of every site root on the box. */
const LIST_TIMEOUT_MS = 60_000;

export const wpLoginService = {
  sites(): Promise<ActionResult<{ sites: WpSiteView[]; varnish: WpVarnishState }>> {
    return call<{ sites: WpSiteView[]; varnish: WpVarnishState }>("sites", [], LIST_TIMEOUT_MS);
  },

  // `asUser` is the panel user a non-administrator's request is on behalf of.
  // The root action is what checks it against CloudPanel's own user-to-site
  // mapping; this side only says whose request it is.
  signIn(
    domain: string,
    request: { asUser?: string; clientIp: string; addBypass: boolean },
  ): Promise<ActionResult<WpLoginResult | WpMaintenanceReply>> {
    const args = [`--domain=${domain}`];
    if (request.asUser) args.push(`--as-user=${request.asUser}`);
    if (request.clientIp) args.push(`--client-ip=${request.clientIp}`);
    if (request.addBypass) args.push("--add-bypass");
    return call<WpLoginResult | WpMaintenanceReply>("sign-in", args);
  },

  remove(): Promise<ActionResult<WpRemoveResult>> {
    return call<WpRemoveResult>("remove", [], LIST_TIMEOUT_MS);
  },
  varnishSettings(enabled: boolean): Promise<ActionResult<{ varnish: WpVarnishState }>> {
    return call("varnish-settings", [`--enabled=${enabled}`]);
  },
  varnishSite(domain: string, excluded: boolean): Promise<ActionResult<{ varnish: WpVarnishState }>> {
    return call("varnish-site", [`--domain=${domain}`, `--excluded=${excluded}`]);
  },
  varnishInstall(domain: string): Promise<ActionResult<VarnishSyncResult>> {
    return call("varnish-install", [`--domain=${domain}`], 120_000);
  },
  varnishSync(): Promise<ActionResult<VarnishSyncResult>> {
    return call("varnish-sync", [], 120_000);
  },
};

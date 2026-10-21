import { callGatewayAction, type ActionResult } from "../../../lib/gateway-client";
import type { WpLoginResult, WpMaintenanceReply, WpBasicAuthReply, WpRemoveResult, WpSiteView } from "../action";
import { validateDomain } from "../../../lib/app-http";
import type { MainwpView, MainwpResult } from "../mainwp";
import type { WpVarnishState, VarnishSyncResult } from "../varnish";

export { validateDomain };

/** `varnishError` is set when the Varnish settings cannot be read; sign-in still works. */
export interface WpDashboard {
  sites: WpSiteView[];
  varnish: WpVarnishState;
  varnishError: string;
  mainwp: MainwpView;
  mainwpError: string;
}

function call<T>(verb: string, args: string[] = [], timeout?: number): Promise<ActionResult<T>> {
  return callGatewayAction<T>("wp-login", verb, args, undefined, timeout ? { timeout } : undefined);
}

/** Finding the WordPress sites means a stat of every site root on the box. */
const LIST_TIMEOUT_MS = 60_000;
/** A pass has a 90-second budget, after the lock and site discovery. */
const PASS_TIMEOUT_MS = 120_000;
/** A MainWP pass can end in an enrollment's own minute and the restore after it. */
const MAINWP_TIMEOUT_MS = 210_000;

export const wpLoginService = {
  sites(): Promise<ActionResult<WpDashboard>> {
    return call<WpDashboard>("sites", [], LIST_TIMEOUT_MS);
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

  mainwpSettings(enabled: boolean, dashboard?: string): Promise<ActionResult<{ mainwp: MainwpView }>> {
    const choice = dashboard === undefined ? [] : [`--dashboard=${dashboard}`];
    return call("mainwp-settings", [`--enabled=${enabled}`, ...choice], PASS_TIMEOUT_MS);
  },
  mainwpSite(domain: string, excluded: boolean): Promise<ActionResult<{ mainwp: MainwpView }>> {
    return call("mainwp-site", [`--domain=${domain}`, `--excluded=${excluded}`]);
  },
  mainwpConnect(domain: string): Promise<ActionResult<MainwpResult>> {
    return call("mainwp-connect", [`--domain=${domain}`, `--confirm=${domain}`], MAINWP_TIMEOUT_MS);
  },
  mainwpSync(): Promise<ActionResult<MainwpResult>> {
    return call("mainwp-sync", [], MAINWP_TIMEOUT_MS);
  },
  mainwpCleanup(): Promise<ActionResult<MainwpResult>> {
    return call("mainwp-cleanup", ["--confirm=mainwp"], MAINWP_TIMEOUT_MS);
  },
  varnishSettings(enabled: boolean): Promise<ActionResult<{ varnish: WpVarnishState }>> {
    return call("varnish-settings", [`--enabled=${enabled}`]);
  },
  varnishSite(domain: string, excluded: boolean): Promise<ActionResult<{ varnish: WpVarnishState }>> {
    return call("varnish-site", [`--domain=${domain}`, `--excluded=${excluded}`]);
  },
  varnishInstall(domain: string): Promise<ActionResult<VarnishSyncResult>> {
    return call("varnish-install", [`--domain=${domain}`], PASS_TIMEOUT_MS);
  },
  varnishSync(): Promise<ActionResult<VarnishSyncResult>> {
    return call("varnish-sync", [], PASS_TIMEOUT_MS);
  },
};

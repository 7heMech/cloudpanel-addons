import { callGatewayAction, type ActionResult, type GatewayStream } from "../../../lib/gateway-client";
import { watchGatewayJob, type JobWatcher } from "../../../lib/job-stream";
import type { WpLoginResult, WpMaintenanceReply, WpBasicAuthReply, WpRemoveResult, WpSiteView } from "../action";
import type { WpJobs, WpJobTask, WpJobView } from "../jobs";
import { validateDomain } from "../../../lib/app-http";
import type { MainwpView } from "../mainwp";
import type { WpVarnishState } from "../varnish";

export { validateDomain };
export { validateJobId } from "../../../lib/job-id";

/** `varnishError` is set when the Varnish settings cannot be read; sign-in still works. */
export interface WpDashboard {
  sites: WpSiteView[];
  varnish: WpVarnishState;
  varnishError: string;
  mainwp: MainwpView;
  mainwpError: string;
  /** The background job each policy is running, which the page follows. */
  jobs: WpJobs;
}

function call<T>(verb: string, args: string[] = [], timeout?: number): Promise<ActionResult<T>> {
  return callGatewayAction<T>("wp-tools", verb, args, undefined, timeout ? { timeout } : undefined);
}

/** Finding the WordPress sites means a stat of every site root on the box. */
const LIST_TIMEOUT_MS = 60_000;
/** Choosing a Dashboard on this server asks it once, for up to 30 seconds. */
const SETTINGS_TIMEOUT_MS = 60_000;

export const wpToolsService = {
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

  mainwpSettings(enabled: boolean, dashboard?: string, remote?: boolean): Promise<ActionResult<{ mainwp: MainwpView }>> {
    const choice = [...(dashboard === undefined ? [] : [`--dashboard=${dashboard}`]), ...(remote ? ["--remote=true"] : [])];
    return call("mainwp-settings", [`--enabled=${enabled}`, ...choice], SETTINGS_TIMEOUT_MS);
  },
  varnishSettings(enabled: boolean): Promise<ActionResult<{ varnish: WpVarnishState }>> {
    return call("varnish-settings", [`--enabled=${enabled}`]);
  },

  // Checks, installations, connections and cleanup are background jobs; the
  // reply is the recorded job, which the page then follows.
  startJob(task: WpJobTask, domains: string[] = [], confirm?: string): Promise<ActionResult<{ job: WpJobView }>> {
    return call("start", [
      `--task=${task}`, ...(domains.length ? [`--domains=${domains.join(",")}`] : []), ...(confirm ? [`--confirm=${confirm}`] : []),
    ]);
  },
  getJob(id: string): Promise<ActionResult<{ job: WpJobView; log: string }>> {
    return call("job", [`--job=${id}`]);
  },
  watchJob(id: string, handlers: Parameters<JobWatcher<WpJobView>>[1]): GatewayStream {
    return watchGatewayJob<WpJobView>("wp-tools", id, handlers);
  },
};

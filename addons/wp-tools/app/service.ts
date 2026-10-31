import { callGatewayAction, type ActionResult, type GatewayStream } from "../../../lib/gateway-client";
import { watchGatewayJob, type JobWatcher } from "../../../lib/job-stream";
import type { WpLoginResult, WpMaintenanceReply, WpBasicAuthReply, WpRemoveResult, WpSiteView } from "../action";
import type { WpJobs, WpJobTask, WpJobView } from "../jobs";
import { validateDomain } from "../../../lib/app-http";
import type { MainwpView } from "../mainwp";
import type { WpVarnishState } from "../varnish";
import type { WpDomainLink } from "../domain-link";
import { UPLOAD_PART_BYTES, type StagedUpload } from "../new-site-plugins";
import type { WpNewSiteAccess } from "../new-site-access";
import type { NewSiteStatus } from "../action";

export { validateDomain };
export { validateJobId } from "../../../lib/job-id";

/** `varnishError` is set when the Varnish settings cannot be read; sign-in still works. */
export interface WpDashboard {
  sites: WpSiteView[];
  varnish: WpVarnishState;
  varnishError: string;
  mainwp: MainwpView;
  mainwpError: string;
  domainLink: WpDomainLink;
  /** Set when the domain link setting cannot be read; the default is shown. */
  domainLinkError: string;
  /** The background job each policy is running, which the page follows. */
  jobs: WpJobs;
  /** Recent new sites' plugin jobs, newest first; absent on a page drawn without them. */
  newSites?: WpJobView[];
  /** Whether site managers may choose plugins; absent on a page drawn without it. */
  newSiteAccess?: WpNewSiteAccess;
  /** Set when that setting cannot be read; it reads as off. */
  newSiteAccessError?: string;
}

/** One plugin as the new-site form chose it. */
export interface NewSiteChoice {
  domain: string;
  plugins: { slug: string; activate: boolean }[];
  uploads: { id: string; activate: boolean }[];
  /** The site manager the choice is for; root holds them to what an administrator allowed. */
  asUser?: string;
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

  /** Whether a site's pages offer the sign-in; `asUser` as for `signIn`. */
  siteKind(domain: string, asUser?: string): Promise<ActionResult<{ wordpress: boolean }>> {
    return call("site-kind", [`--domain=${domain}`, ...(asUser ? [`--as-user=${asUser}`] : [])]);
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
  domainLinkSettings(signIn: boolean): Promise<ActionResult<{ domainLink: WpDomainLink }>> {
    return call("domain-link-settings", [`--enabled=${signIn}`]);
  },
  // The domain link is markup in CloudPanel's own template, and rendering the
  // templates is the manager's work: one pass from the pristine copies.
  renderPanelTemplates(): Promise<ActionResult<unknown>> {
    return callGatewayAction("manager", "reconcile", [], undefined, { timeout: 60_000 });
  },

  // Checks, installations, connections and cleanup are background jobs; the
  // reply is the recorded job, which the page then follows.
  startJob(task: WpJobTask, domains: string[] = [], confirm?: string): Promise<ActionResult<{ job: WpJobView }>> {
    return call("start", [
      `--task=${task}`, ...(domains.length ? [`--domains=${domains.join(",")}`] : []), ...(confirm ? [`--confirm=${confirm}`] : []),
    ]);
  },
  /**
   * A zip goes to root in parts, each one gateway request, whose input is
   * bounded at 1 MiB; root picks the id with the first and inspects the zip
   * with the last.
   */
  async uploadPlugin(zip: Uint8Array): Promise<ActionResult<{ upload: StagedUpload }>> {
    let id = "";
    const parts = Math.max(1, Math.ceil(zip.byteLength / UPLOAD_PART_BYTES));
    for (let part = 0; part < parts; part++) {
      const chunk = zip.subarray(part * UPLOAD_PART_BYTES, (part + 1) * UPLOAD_PART_BYTES);
      const args = [...(id ? [`--upload=${id}`] : []), `--part=${part}`, ...(part === parts - 1 ? ["--last"] : [])];
      const result = await callGatewayAction<{ id: string; upload?: StagedUpload }>(
        "wp-tools", "plugin-upload", args, Buffer.from(chunk).toString("base64"),
      );
      if (!result.ok || !result.data) {
        if (id) await wpToolsService.discardUpload(id);
        return { ok: false, error: result.error ?? "the upload was refused" };
      }
      id = result.data.id;
      if (result.data.upload) return { ok: true, data: { upload: result.data.upload } };
    }
    return { ok: false, error: "the upload did not finish" };
  },
  discardUpload(id: string): Promise<ActionResult<{ discarded: boolean }>> {
    return call("plugin-discard", [`--upload=${id}`]);
  },
  /**
   * Recorded before CloudPanel creates the site; the job waits for it. It
   * replaces any choice still waiting for the same domain, and an empty one
   * only clears that.
   */
  newSite(choice: NewSiteChoice): Promise<ActionResult<{ job: WpJobView | null }>> {
    const list = (items: { key: string; activate: boolean }[]) => items.map((item) => `${item.key}:${item.activate ? 1 : 0}`).join(",");
    return call("new-site", [
      `--domain=${choice.domain}`,
      ...(choice.plugins.length ? [`--plugins=${list(choice.plugins.map((plugin) => ({ key: plugin.slug, activate: plugin.activate })))}`] : []),
      ...(choice.uploads.length ? [`--uploads=${list(choice.uploads.map((upload) => ({ key: upload.id, activate: upload.activate })))}`] : []),
      ...(choice.asUser ? [`--as-user=${choice.asUser}`] : []),
    ]);
  },
  /** One new site's job, for the page it lands on; a site manager only sees their own. */
  newSiteStatus(id: string, asUser?: string): Promise<ActionResult<{ job: NewSiteStatus }>> {
    return call("new-site-status", [`--job=${id}`, ...(asUser ? [`--as-user=${asUser}`] : [])]);
  },
  /** Whether this caller may use the form's Plugins row, and upload to it. */
  newSiteAccess(asUser?: string): Promise<ActionResult<{ uploads: boolean }>> {
    return call("new-site-access", asUser ? [`--as-user=${asUser}`] : []);
  },
  newSiteSettings(siteManagers: boolean): Promise<ActionResult<{ newSiteAccess: WpNewSiteAccess }>> {
    return call("new-site-settings", [`--site-managers=${siteManagers}`]);
  },

  getJob(id: string): Promise<ActionResult<{ job: WpJobView; log: string }>> {
    return call("job", [`--job=${id}`]);
  },
  watchJob(id: string, handlers: Parameters<JobWatcher<WpJobView>>[1]): GatewayStream {
    return watchGatewayJob<WpJobView>("wp-tools", id, handlers);
  },
};

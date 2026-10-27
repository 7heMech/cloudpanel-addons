import { callGatewayAction, type ActionResult, type GatewayStream } from "../../../lib/gateway-client";
import { watchGatewayJob, type JobWatcher } from "../../../lib/job-stream";
import type { MeasureJobView, MeasureStarted, PanelTweaks, PanelTweaksState, SetTweaksResult } from "../action";

function call<T>(verb: string, args: string[] = [], input?: string, timeout?: number): Promise<ActionResult<T>> {
  return callGatewayAction<T>("panel-tweaks", verb, args, input, timeout ? { timeout } : undefined);
}

export const panelTweaksService = {
  // `asUser` narrows the site list to that panel user's own sites; an
  // administrator's request names nobody and is not narrowed.
  state(asUser?: string): Promise<ActionResult<PanelTweaksState>> {
    return call<PanelTweaksState>("state", asUser ? [`--as-user=${asUser}`] : []);
  },

  setTweaks(wanted: Partial<PanelTweaks>): Promise<ActionResult<SetTweaksResult>> {
    return call<SetTweaksResult>("set-tweaks", [], JSON.stringify(wanted));
  },

  // A measurement is a background job; the reply is the recorded job, or the
  // one already running, which the page then follows.
  measure(): Promise<ActionResult<MeasureStarted>> {
    return call<MeasureStarted>("measure");
  },
  getJob(id: string): Promise<ActionResult<{ job: MeasureJobView; log: string }>> {
    return call("job", [`--job=${id}`]);
  },
  watchJob(id: string, handlers: Parameters<JobWatcher<MeasureJobView>>[1]): GatewayStream {
    return watchGatewayJob<MeasureJobView>("panel-tweaks", id, handlers);
  },
};

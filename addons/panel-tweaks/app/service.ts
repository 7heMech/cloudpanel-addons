import { callGatewayAction, type ActionResult, type GatewayStream } from "../../../lib/gateway-client";
import type { WebVerb } from "../../../lib/gateway-protocol";
import { watchGatewayJob, type JobWatcher } from "../../../lib/job-stream";
import { forgetPanelLogos } from "../../../lib/panel-logos";
import type {
  MeasureJobView, MeasureStarted, PanelTweaks, PanelTweaksState, SetBrandingResult, SetTweaksResult,
} from "../action";
import type { Branding } from "../branding";

function call<T>(verb: WebVerb<"panel-tweaks">, args: string[] = [], input?: string, timeout?: number): Promise<ActionResult<T>> {
  return callGatewayAction("panel-tweaks", verb, args, input, timeout ? { timeout } : undefined);
}

export const panelTweaksService = {
  state(asUser?: string): Promise<ActionResult<PanelTweaksState>> {
    return call<PanelTweaksState>("state", asUser ? [`--as-user=${asUser}`] : []);
  },

  // Either can change the logos the addon pages draw.
  setTweaks(wanted: Partial<PanelTweaks>): Promise<ActionResult<SetTweaksResult>> {
    return call<SetTweaksResult>("set-tweaks", [], JSON.stringify(wanted)).finally(forgetPanelLogos);
  },

  branding(): Promise<ActionResult<Branding>> {
    return call<Branding>("branding");
  },

  setBranding(wanted: Record<string, unknown>): Promise<ActionResult<SetBrandingResult>> {
    return call<SetBrandingResult>("set-branding", [], JSON.stringify(wanted)).finally(forgetPanelLogos);
  },

  brandingAsset(name: string): Promise<ActionResult<{ type: string; data: string }>> {
    return call("branding-asset", [`--name=${name}`]);
  },

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

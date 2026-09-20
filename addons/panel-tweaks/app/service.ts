import { callGatewayAction, streamGatewayAction, type ActionResult, type GatewayStream } from "../../../lib/gateway-client";
import type { PanelTweaks, PanelTweaksState, ScanResult, ScanStreamEvent, SetTweaksResult } from "../action";

function call<T>(verb: string, args: string[] = [], input?: string, timeout?: number): Promise<ActionResult<T>> {
  return callGatewayAction<T>("panel-tweaks", verb, args, input, timeout ? { timeout } : undefined);
}

/**
 * A sweep is `du` over every site's home directory, so how long it takes is a
 * property of the operator's disk rather than of this code. The unattended one
 * has no deadline at all; the one an operator pressed gets four minutes, after
 * which the fifteen-minute sweep is what fills the column instead.
 */
const SCAN_TIMEOUT_MS = 240_000;

export const panelTweaksService = {
  // `asUser` narrows the site list to that panel user's own sites; an
  // administrator's request names nobody and is not narrowed.
  state(asUser?: string): Promise<ActionResult<PanelTweaksState>> {
    return call<PanelTweaksState>("state", asUser ? [`--as-user=${asUser}`] : []);
  },

  setTweaks(wanted: Partial<PanelTweaks>): Promise<ActionResult<SetTweaksResult>> {
    return call<SetTweaksResult>("set-tweaks", [], JSON.stringify(wanted));
  },

  scan(): Promise<ActionResult<ScanResult>> {
    return call<ScanResult>("scan", [], undefined, SCAN_TIMEOUT_MS);
  },

  scanStream(handlers: {
    onEvent: (event: ScanStreamEvent) => void;
    onClose: (error?: string) => void;
  }): GatewayStream {
    let ended = false;
    const close = (error?: string) => {
      if (ended) return;
      ended = true;
      handlers.onClose(error);
    };
    return streamGatewayAction<ScanStreamEvent>({
      addon: "panel-tweaks",
      verb: "scan-stream",
      timeoutMs: SCAN_TIMEOUT_MS,
      onReply(reply) {
        if (reply.ok && reply.data) handlers.onEvent(reply.data);
        else close(reply.error ?? "the scan returned an empty progress update");
      },
      onClose: close,
    });
  },
};

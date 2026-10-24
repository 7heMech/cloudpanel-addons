import { callGatewayAction, type ActionResult } from "../../../lib/gateway-client";
import type { SystemTweaksState } from "../action";
import { INSTALL_GATEWAY_TIMEOUT_MS, REAL_IP_GATEWAY_TIMEOUT_MS } from "../limits";

function call(verb: string, input?: string, timeout?: number): Promise<ActionResult<SystemTweaksState>> {
  return callGatewayAction<SystemTweaksState>("system-tweaks", verb, [], input, timeout ? { timeout } : undefined);
}

export const systemTweaksService = {
  state(): Promise<ActionResult<SystemTweaksState>> {
    return call("state");
  },

  setUpdates(wanted: Record<string, boolean | string | null>): Promise<ActionResult<SystemTweaksState>> {
    return call("set-updates", JSON.stringify(wanted));
  },

  installUpdates(): Promise<ActionResult<SystemTweaksState>> {
    return call("install-updates", undefined, INSTALL_GATEWAY_TIMEOUT_MS);
  },

  setUploadGuard(enabled: boolean): Promise<ActionResult<SystemTweaksState>> {
    return call("set-upload-guard", JSON.stringify({ enabled }));
  },

  setRealIp(enabled: boolean): Promise<ActionResult<SystemTweaksState>> {
    return call("set-real-ip", JSON.stringify({ enabled }), REAL_IP_GATEWAY_TIMEOUT_MS);
  },

};

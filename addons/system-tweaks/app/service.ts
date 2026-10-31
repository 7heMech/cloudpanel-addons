import { callGatewayAction, type ActionResult } from "../../../lib/gateway-client";
import type { WebVerb } from "../../../lib/gateway-protocol";
import type { SystemTweaksState } from "../action";
import { INSTALL_GATEWAY_TIMEOUT_MS, PANEL_PHP_GATEWAY_TIMEOUT_MS, REAL_IP_GATEWAY_TIMEOUT_MS } from "../limits";

function call(verb: WebVerb<"system-tweaks">, input?: string, timeout?: number): Promise<ActionResult<SystemTweaksState>> {
  return callGatewayAction<SystemTweaksState>("system-tweaks", verb, [], input, timeout ? { timeout } : undefined);
}

export const systemTweaksService = {
  state(): Promise<ActionResult<SystemTweaksState>> {
    return call("state");
  },

  setUpdates(wanted: Record<string, boolean | string>): Promise<ActionResult<SystemTweaksState>> {
    return call("set-updates", JSON.stringify(wanted));
  },

  installUpdates(): Promise<ActionResult<SystemTweaksState>> {
    return call("install-updates", undefined, INSTALL_GATEWAY_TIMEOUT_MS);
  },

  setUploadGuard(enabled: boolean): Promise<ActionResult<SystemTweaksState>> {
    return call("set-upload-guard", JSON.stringify({ enabled }));
  },

  setPanelPhp(php: string): Promise<ActionResult<SystemTweaksState>> {
    return call("set-panel-php", JSON.stringify({ php }), PANEL_PHP_GATEWAY_TIMEOUT_MS);
  },

  setRealIp(enabled: boolean): Promise<ActionResult<SystemTweaksState>> {
    return call("set-real-ip", JSON.stringify({ enabled }), REAL_IP_GATEWAY_TIMEOUT_MS);
  },

};

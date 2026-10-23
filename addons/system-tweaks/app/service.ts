import { callGatewayAction, type ActionResult } from "../../../lib/gateway-client";
import type { SystemTweaksState } from "../action";

function call(verb: string, input?: string, timeout?: number): Promise<ActionResult<SystemTweaksState>> {
  return callGatewayAction<SystemTweaksState>("system-tweaks", verb, [], input, timeout ? { timeout } : undefined);
}

/** apt-get waits up to two minutes for dpkg's lock, then downloads and installs. */
const INSTALL_TIMEOUT_MS = 300_000;

export const systemTweaksService = {
  state(): Promise<ActionResult<SystemTweaksState>> {
    return call("state");
  },

  setUpdates(wanted: Record<string, boolean>): Promise<ActionResult<SystemTweaksState>> {
    return call("set-updates", JSON.stringify(wanted));
  },

  installUpdates(): Promise<ActionResult<SystemTweaksState>> {
    return call("install-updates", undefined, INSTALL_TIMEOUT_MS);
  },

  setUploadGuard(enabled: boolean): Promise<ActionResult<SystemTweaksState>> {
    return call("set-upload-guard", JSON.stringify({ enabled }));
  },
};

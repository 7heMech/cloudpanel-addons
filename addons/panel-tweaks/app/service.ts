import { callGatewayAction, type ActionResult } from "../../../lib/gateway-client";
import type { PanelTweaks, PanelTweaksState, ScanResult, SetTweaksResult, WpLoginResult } from "../action";

const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function validateDomain(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const domain = value.trim().toLowerCase().replace(/\.$/, "");
  return domain.length <= 253 && DOMAIN_RE.test(domain) ? domain : null;
}

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
  state(): Promise<ActionResult<PanelTweaksState>> {
    return call<PanelTweaksState>("state");
  },

  setTweaks(wanted: Partial<PanelTweaks>): Promise<ActionResult<SetTweaksResult>> {
    return call<SetTweaksResult>("set-tweaks", [], JSON.stringify(wanted));
  },

  scan(): Promise<ActionResult<ScanResult>> {
    return call<ScanResult>("scan", [], undefined, SCAN_TIMEOUT_MS);
  },

  wpLogin(domain: string): Promise<ActionResult<WpLoginResult>> {
    return call<WpLoginResult>("wp-login", [`--domain=${domain}`]);
  },
};

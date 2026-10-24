import { callGatewayAction, type ActionResult } from "../../../lib/gateway-client";
import type { CloudflarePeerStatus } from "../cloudflare-peer";
import { PROTECTION_GATEWAY_TIMEOUT_MS } from "../limits";

export interface CloudflareSiteView {
  domain: string;
  type: string;
  enabled: boolean;
  excludedFromAutomatic: boolean;
}

export interface CloudflareState {
  sites: CloudflareSiteView[];
  autoEnableNewSites: boolean;
  protection: CloudflarePeerStatus;
}

async function call<T>(verb: string, args: string[] = [], input?: string): Promise<ActionResult<T>> {
  return callGatewayAction<T>("cloudflare-ips", verb, args, input);
}

export const cloudflareService = {
  async state(): Promise<ActionResult<CloudflareState>> {
    return call<CloudflareState>("list");
  },

  async setSites(domains: string[], enabled: boolean): Promise<ActionResult<{ changed: number }>> {
    return call<{ changed: number }>(
      "set",
      ["--enabled", enabled ? "yes" : "no"],
      JSON.stringify({ domains }),
    );
  },

  async setAutomatic(enabled: boolean): Promise<ActionResult<{ autoEnableNewSites: boolean }>> {
    return call<{ autoEnableNewSites: boolean }>("policy", ["--enabled", enabled ? "yes" : "no"]);
  },
  async setProtection(enabled: boolean): Promise<ActionResult<{ protection: CloudflarePeerStatus }>> {
    return callGatewayAction<{ protection: CloudflarePeerStatus }>("cloudflare-ips", "protection", ["--enabled", enabled ? "yes" : "no"], undefined,
      { timeout: PROTECTION_GATEWAY_TIMEOUT_MS });
  },
};

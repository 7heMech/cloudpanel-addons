import { callGatewayAction, type ActionResult } from "../../../lib/gateway-client";
import type { WebVerb } from "../../../lib/gateway-protocol";

export interface CloudflareSiteView {
  domain: string;
  enabled: boolean;
}

export interface CloudflareState {
  sites: CloudflareSiteView[];
  autoEnableNewSites: boolean;
}

async function call<T>(verb: WebVerb<"cloudflare-ips">, args: string[] = [], input?: string): Promise<ActionResult<T>> {
  return callGatewayAction("cloudflare-ips", verb, args, input);
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
};

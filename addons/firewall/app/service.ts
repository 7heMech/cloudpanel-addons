import { callGatewayAction, type ActionResult } from "../../../lib/gateway-client";
import type { WebVerb } from "../../../lib/gateway-protocol";
import type { FirewallStatus } from "../protocols";

export interface CloudflareSiteView {
  domain: string;
  enabled: boolean;
}

export interface FirewallPageState {
  sites: CloudflareSiteView[];
  autoEnableNewSites: boolean;
  protocols: FirewallStatus | { error: string };
}

async function call<T>(verb: WebVerb<"firewall">, args: string[] = [], input?: string): Promise<ActionResult<T>> {
  return callGatewayAction("firewall", verb, args, input);
}

export const firewallService = {
  async state(): Promise<ActionResult<FirewallPageState>> {
    return call<FirewallPageState>("list");
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

  protocols(): Promise<ActionResult<FirewallStatus>> {
    return call<FirewallStatus>("protocols");
  },

  setProtocol(rule: { portRange: string; source: string; protocol: string; id?: number }): Promise<ActionResult<FirewallStatus>> {
    return call<FirewallStatus>("set-protocol", [], JSON.stringify(rule));
  },

  setProtocols(enabled: boolean): Promise<ActionResult<FirewallStatus>> {
    return call<FirewallStatus>("set-protocols", ["--enabled", enabled ? "yes" : "no"]);
  },
};

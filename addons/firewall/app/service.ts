import { callGatewayAction, type ActionResult } from "../../../lib/gateway-client";
import type { WebVerb } from "../../../lib/gateway-protocol";
import type { FirewallStatus } from "../protocols";
import type { FirewallCloudflareView } from "../action";
import type { HetznerReview, HetznerRole, HetznerView } from "../hetzner";
import type { NetcupSignIn, NetcupView } from "../netcup";
import type { GateReply, PanelGateView } from "../panel-gate";
import type { VisitorIpState } from "../visitor-ip";

export interface CloudflareSiteView {
  domain: string;
  enabled: boolean;
}

export interface FirewallPageState {
  sites: CloudflareSiteView[];
  autoEnableNewSites: boolean;
  visitorIp: VisitorIpState;
  protocols: FirewallStatus | { error: string };
  hetzner: HetznerView;
  netcup: NetcupView;
  panelGate: PanelGateView | { error: string };
  cloudflare: FirewallCloudflareView;
}

export type HetznerReply = { review: HetznerReview } | { notice: string };
export type NetcupPoll = { pending: true; interval: number } | { notice: string };

// Hetzner's and netcup's changes wait for their tasks to finish and for each site's DNS lookup.
// The gate waits for Cloudflare to deploy its certificate.
const SLOW = new Set<WebVerb<"firewall">>([
  "hetzner-connect", "hetzner-disconnect", "hetzner-switch", "netcup-poll", "netcup-disconnect", "netcup-switch", "panel-gate", "panel-gate-switch",
]);

async function call<T>(verb: WebVerb<"firewall">, args: string[] = [], input?: string): Promise<ActionResult<T>> {
  return callGatewayAction("firewall", verb, args, input, SLOW.has(verb) ? { timeout: 240_000 } : undefined);
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

  setVisitorIp(enabled: boolean): Promise<ActionResult<VisitorIpState>> {
    return call<VisitorIpState>("set-visitor-ip", [], JSON.stringify({ enabled }));
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

  /** The token reaches root on stdin only. */
  connectHetzner(token: string): Promise<ActionResult<HetznerReply>> {
    return call<HetznerReply>("hetzner-connect", [], JSON.stringify({ token }));
  },

  disconnectHetzner(): Promise<ActionResult<HetznerReply>> {
    return call<HetznerReply>("hetzner-disconnect");
  },

  connectNetcup(): Promise<ActionResult<NetcupSignIn>> {
    return call<NetcupSignIn>("netcup-connect");
  },

  pollNetcup(): Promise<ActionResult<NetcupPoll>> {
    return call<NetcupPoll>("netcup-poll");
  },

  disconnectNetcup(): Promise<ActionResult<HetznerReply>> {
    return call<HetznerReply>("netcup-disconnect");
  },

  setNetcup(role: HetznerRole, enabled: boolean, confirm?: string, typed?: string): Promise<ActionResult<HetznerReply>> {
    return call<HetznerReply>("netcup-switch", ["--role", role, "--enabled", enabled ? "yes" : "no"], JSON.stringify({ confirm, typed }));
  },

  panelGate(): Promise<ActionResult<PanelGateView>> {
    return call<PanelGateView>("panel-gate");
  },

  setPanelGate(enabled: boolean, confirm?: string): Promise<ActionResult<GateReply>> {
    return call<GateReply>("panel-gate-switch", ["--enabled", enabled ? "yes" : "no"], JSON.stringify({ confirm }));
  },

  setHetzner(role: HetznerRole, enabled: boolean, confirm?: string, typed?: string): Promise<ActionResult<HetznerReply>> {
    return call<HetznerReply>("hetzner-switch", ["--role", role, "--enabled", enabled ? "yes" : "no"], JSON.stringify({ confirm, typed }));
  },
};

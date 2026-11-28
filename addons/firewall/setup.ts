import type { ActionNeeded, ActionNeededCheck, SetupCheck, SetupStep } from "../../lib/addon-definition";
import { listCloudflareSecrets } from "../../lib/cloudflare/store";
import type { CloudSetupState } from "./cloud-firewall";
import { hetznerSetupState } from "./hetzner";
import { netcupSetupState } from "./netcup";
import { edgeActionNeeded, edgeSetupCheck, type EdgeOptions } from "./edge";
import { panelGateActionNeeded, panelGateSummary, type GateOptions, type PanelGateView } from "./panel-gate";

const CARD = "/addons/firewall/#hetzner-card";
const NETCUP_CARD = "/addons/firewall/#netcup-card";
const GATE_CARD = "/addons/firewall/#panel-gate-card";
const EDGE_CARD = "/addons/firewall/#fw-edge-card";
/** Repair reads the provider every 15 minutes and records when; this many missed in a row is a credential it refuses, or a provider that does not answer. */
export const HETZNER_QUIET_MS = 60 * 60_000;

interface ProviderText { absent: string; noCredential: string; provider: string }

function providerCheck(state: CloudSetupState, text: ProviderText): SetupCheck {
  if (!state.cloud) return { state: "na", reason: text.absent };
  if (!state.token) return { state: "todo", reason: text.noCredential };
  if (state.seen.web === undefined && state.seen.panel === undefined) return { state: "todo", reason: `Open Firewall to read ${text.provider}'s switches` };
  const off = [!state.seen.web && "the sites", !state.seen.panel && "the panel"].filter(Boolean);
  if (!off.length) return { state: "done", reason: "Only Cloudflare reaches the sites and the panel" };
  return { state: "todo", reason: `Anyone can reach ${off.join(" and ")} without Cloudflare` };
}

/** Hours since the provider was last read, once that is an hour or more while a credential is saved. */
function quietHours(state: CloudSetupState, now: number): number | null {
  if (!state.token || state.seenAt === null || now - state.seenAt < HETZNER_QUIET_MS) return null;
  return Math.floor((now - state.seenAt) / (60 * 60_000));
}

const hours = (n: number) => `${n} hour${n === 1 ? "" : "s"}`;

export function hetznerCheck(state: CloudSetupState): SetupCheck {
  return providerCheck(state, { absent: "This server is not on Hetzner Cloud", noCredential: "No Hetzner token is saved", provider: "Hetzner" });
}

export function hetznerActions(state: CloudSetupState, now = Date.now()): ActionNeeded[] {
  const quiet = quietHours(state, now);
  if (quiet === null) return [];
  return [{
    title: "Hetzner does not answer the saved token",
    reason: `Firewall last read Hetzner ${hours(quiet)} ago, so its firewalls stop following Cloudflare's list; connect a new token if Hetzner no longer accepts this one`,
    href: CARD,
  }];
}

export function netcupCheck(state: CloudSetupState): SetupCheck {
  return providerCheck(state, { absent: "This server is not at netcup", noCredential: "netcup is not connected", provider: "netcup" });
}

export function netcupActions(state: CloudSetupState, now = Date.now()): ActionNeeded[] {
  const quiet = quietHours(state, now);
  if (quiet === null) return [];
  return [{
    title: "netcup does not answer the saved sign-in",
    reason: `Firewall last read netcup ${hours(quiet)} ago, so its policies stop following Cloudflare's list; connect netcup again if it no longer accepts the sign-in`,
    href: NETCUP_CARD,
  }];
}

export function panelGateCheck(summary: Pick<PanelGateView, "on" | "hostname">, cloudflareConnected = true): SetupCheck {
  if (summary.on) return { state: "done", reason: summary.hostname ? `Cloudflare Access sits in front of ${summary.hostname}` : "Cloudflare Access sits in front of CloudPanel" };
  if (!cloudflareConnected) return { state: "todo", reason: "Connect Cloudflare on the Firewall page to turn on Panel gate" };
  return { state: "todo", reason: "CloudPanel's login page is directly reachable" };
}

export const FIREWALL_SETUP: SetupStep[] = [
  {
    id: "hetzner-firewall", level: "secure", title: "Hetzner Cloud Firewall", href: CARD, hostSpecific: true,
    why: "Drops direct traffic to ports 80, 443 and 8443 at Hetzner before packets reach this server.",
    check: () => hetznerCheck(hetznerSetupState()),
  },
  {
    id: "netcup-firewall", level: "secure", title: "netcup firewall", href: NETCUP_CARD, hostSpecific: true,
    why: "Drops direct traffic to ports 80, 443 and 8443 at netcup before packets reach this server.",
    check: () => netcupCheck(netcupSetupState()),
  },
  {
    id: "cloudflare-edge", level: "sites", title: "Cloudflare edge defaults", href: EDGE_CARD,
    why: "Sets zone-wide SSL/TLS mode, Always Use HTTPS, Full SSL rules and WAF skip IPs once so new Cloudflare zones inherit them automatically.",
    check: (options) => edgeSetupCheck(options?.edge as EdgeOptions | undefined),
  },
  {
    id: "panel-gate", level: "domain", title: "Panel gate", href: GATE_CARD, requires: ["panel-hostname"],
    why: "Requires a Cloudflare Access email sign-in before anyone reaches CloudPanel's login screen and closes direct port 8443.",
    check: (options) => {
      const gate = options?.gate as GateOptions | undefined;
      const connected = listCloudflareSecrets(gate?.paths?.cloudflareDir ? { stateDir: gate.paths.cloudflareDir, rootUid: gate.paths.rootUid } : undefined).length > 0;
      return panelGateCheck(panelGateSummary(gate), connected);
    },
  },
];

export const FIREWALL_ACTIONS: ActionNeededCheck[] = [
  { id: "hetzner-token", check: () => hetznerActions(hetznerSetupState()) },
  { id: "netcup-sign-in", check: () => netcupActions(netcupSetupState()) },
  { id: "cloudflare-edge", check: (options) => edgeActionNeeded(options?.edge as EdgeOptions | undefined) },
  // Local files and the drift repair recorded; it never calls Cloudflare.
  { id: "panel-gate", title: "Panel gate needs attention", href: GATE_CARD, check: (options) => panelGateActionNeeded(options?.gate as GateOptions | undefined) },
];

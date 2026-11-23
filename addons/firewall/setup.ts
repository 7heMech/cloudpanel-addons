import type { ActionNeeded, ActionNeededCheck, SetupCheck, SetupStep } from "../../lib/addon-definition";
import type { CloudSetupState } from "./cloud-firewall";
import { hetznerSetupState } from "./hetzner";
import { netcupSetupState } from "./netcup";
import { panelGateActionNeeded, type GateOptions } from "./panel-gate";

const CARD = "/addons/firewall/#hetzner-card";
const NETCUP_CARD = "/addons/firewall/#netcup-card";
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

export const FIREWALL_SETUP: SetupStep[] = [
  { id: "hetzner-firewall", level: "secure", title: "Hetzner Cloud Firewall", href: CARD, check: () => hetznerCheck(hetznerSetupState()) },
  { id: "netcup-firewall", level: "secure", title: "netcup firewall", href: NETCUP_CARD, check: () => netcupCheck(netcupSetupState()) },
];

export const FIREWALL_ACTIONS: ActionNeededCheck[] = [
  { id: "hetzner-token", check: () => hetznerActions(hetznerSetupState()) },
  { id: "netcup-sign-in", check: () => netcupActions(netcupSetupState()) },
  // Local files and the drift repair recorded; it never calls Cloudflare.
  { id: "panel-gate", title: "Panel gate needs attention", href: "/addons/firewall/#panel-gate-card", check: (options) => panelGateActionNeeded(options?.gate as GateOptions | undefined) },
];

import type { ActionNeeded, ActionNeededCheck, SetupCheck, SetupStep } from "../../lib/addon-definition";
import { hetznerSetupState } from "./hetzner";

const CARD = "/addons/firewall/#hetzner-card";
/** Repair reads Hetzner every 15 minutes and records when; this many missed in a row is a token Hetzner refuses, or a Hetzner that does not answer. */
export const HETZNER_QUIET_MS = 60 * 60_000;

type HetznerSetupState = ReturnType<typeof hetznerSetupState>;

export function hetznerCheck(state: HetznerSetupState): SetupCheck {
  if (!state.cloud) return { state: "na", reason: "This server is not on Hetzner Cloud" };
  if (!state.token) return { state: "todo", reason: "No Hetzner token is saved" };
  if (state.seen.web === undefined && state.seen.panel === undefined) return { state: "todo", reason: "Open Firewall to read Hetzner's switches" };
  const off = [!state.seen.web && "the sites", !state.seen.panel && "the panel"].filter(Boolean);
  if (!off.length) return { state: "done", reason: "Only Cloudflare reaches the sites and the panel" };
  return { state: "todo", reason: `Anyone can reach ${off.join(" and ")} without Cloudflare` };
}

export function hetznerActions(state: HetznerSetupState, now = Date.now()): ActionNeeded[] {
  if (!state.token || state.seenAt === null || now - state.seenAt < HETZNER_QUIET_MS) return [];
  const hours = Math.floor((now - state.seenAt) / (60 * 60_000));
  return [{
    title: "Hetzner does not answer the saved token",
    reason: `Firewall last read Hetzner ${hours} hour${hours === 1 ? "" : "s"} ago, so its firewalls stop following Cloudflare's list; connect a new token if Hetzner no longer accepts this one`,
    href: CARD,
  }];
}

export const FIREWALL_SETUP: SetupStep[] = [
  { id: "hetzner-firewall", level: "secure", title: "Hetzner Cloud Firewall", href: CARD, check: () => hetznerCheck(hetznerSetupState()) },
];

export const FIREWALL_ACTIONS: ActionNeededCheck[] = [
  { id: "hetzner-token", check: () => hetznerActions(hetznerSetupState()) },
];

import type { SetupCheck, SetupStep } from "../../lib/addon-definition";
import { hetznerSetupState } from "./hetzner";

export function hetznerCheck(state: ReturnType<typeof hetznerSetupState>): SetupCheck {
  if (!state.cloud) return { state: "na", reason: "This server is not on Hetzner Cloud" };
  if (!state.token) return { state: "todo", reason: "No Hetzner token is saved" };
  if (state.seen.web === undefined && state.seen.panel === undefined) return { state: "todo", reason: "Open Firewall to read Hetzner's switches" };
  const off = [!state.seen.web && "sites", !state.seen.panel && "the panel"].filter(Boolean);
  if (!off.length) return { state: "done", reason: "Only Cloudflare reaches the sites and the panel" };
  return { state: "todo", reason: `Anyone can reach ${off.join(" and ")} without Cloudflare` };
}

export const FIREWALL_SETUP: SetupStep[] = [
  { id: "hetzner-firewall", level: "secure", title: "Hetzner Cloud Firewall", href: "/addons/firewall/#hetzner-card", check: () => hetznerCheck(hetznerSetupState()) },
];

import type { ActionNeeded, ActionNeededCheck, SetupCheck, SetupStep } from "../../lib/addon-definition";
import { panelCustomDomainCertificate } from "../../lib/panel-custom-domain";
import { addonStateDir } from "../../lib/paths";
import { readState } from "../../lib/root-state";
import { panelUserUid } from "../../lib/sso-auth";
import { connectionPermissions, type StoredAccess } from "./access";
import { tokenProfiles } from "./engine";
import { parsePolicy, parseSecrets, type Policy } from "./model";
import { seededPolicy } from "./presets";

const PAGE = "/addons/dns/";

interface DnsSetupState {
  policy: Policy;
  tokens: Set<string>;
  /** Each connection's last check, with what its token holds. */
  reports: ({ id: string; active: boolean; error: string | null } & StoredAccess)[];
}

function dnsState(stateDir = addonStateDir("dns"), rootUid = 0): DnsSetupState {
  const raw = readState<unknown>(`${stateDir}/policy.json`, rootUid, () => null);
  const secrets = parseSecrets(readState(`${stateDir}/secrets.json`, rootUid, () => ({})));
  const status = readState<{ connections?: DnsSetupState["reports"] }>(`${stateDir}/status.json`, rootUid, () => ({}));
  return {
    policy: raw === null ? seededPolicy() : parsePolicy(raw),
    tokens: new Set(Object.entries(secrets.cloudflare).filter(([, token]) => token).map(([id]) => id)),
    reports: Array.isArray(status.connections) ? status.connections : [],
  };
}

export function connectionCheck(state: DnsSetupState): SetupCheck {
  const saved = state.policy.connections.filter((connection) => state.tokens.has(connection.id));
  if (!saved.length) return { state: "todo", reason: "No Cloudflare connection yet" };
  const failing = saved.map((connection) => state.reports.find((report) => report.id === connection.id))
    .find((report) => report && !report.active && report.error);
  if (failing && saved.length === 1) return { state: "todo", reason: failing.error! };
  return { state: "done", reason: `Cloudflare: ${saved.map((connection) => connection.label).join(", ")}` };
}

export function panelHostCheck(custom: { name: string; issued: boolean } | undefined, panelHost: string | null): SetupCheck {
  if (custom?.issued) return { state: "done", reason: `CloudPanel answers at ${custom.name}` };
  if (custom) return { state: "todo", reason: `${custom.name} is still on a self-signed certificate` };
  if (panelHost) return { state: "todo", reason: `Enter ${panelHost} under Admin → Settings → Custom Domain in CloudPanel` };
  return { state: "todo", reason: "CloudPanel has no custom domain" };
}

export function automaticCheck(state: DnsSetupState): SetupCheck {
  if (!state.policy.connections.some((connection) => state.tokens.has(connection.id))) return { state: "todo", reason: "Connect DNS first" };
  if (!state.policy.automatic) return { state: "todo", reason: "DNS asks before it changes records" };
  const profile = state.policy.profiles.find((candidate) => candidate.id === state.policy.defaultProfileId);
  return profile
    ? { state: "done", reason: `New sites get ${profile.name}'s records` }
    : { state: "todo", reason: "New sites get no profile" };
}

/** One item per connection whose token lacks a permission DNS requires; optional ones never count. */
export function permissionActions(state: DnsSetupState): ActionNeeded[] {
  return state.policy.connections.flatMap((connection) => {
    const report = state.reports.find((entry) => entry.id === connection.id);
    if (!report?.active || !state.tokens.has(connection.id)) return [];
    const { missing } = connectionPermissions(report, tokenProfiles(state.policy));
    if (!missing.length) return [];
    return [{
      title: missing.length > 1 ? "Cloudflare token needs permissions" : "Cloudflare token needs a permission",
      reason: `${connection.label}'s token lacks ${missing.join(", ")}, which DNS needs; add ${missing.length > 1 ? "them" : "it"} to the token in Cloudflare`,
      href: `${PAGE}#dns-connection`,
    }];
  });
}

export const DNS_ACTIONS: ActionNeededCheck[] = [
  { id: "dns-permissions", check: () => permissionActions(dnsState()) },
];

function panelHost(): string | null {
  try { return dnsState().policy.panelHost; } catch { return null; }
}

export const DNS_SETUP: SetupStep[] = [
  { id: "dns-connection", level: "domain", title: "Connect DNS", href: `${PAGE}#dns-connection`, check: () => connectionCheck(dnsState()) },
  {
    id: "panel-hostname", level: "domain", title: "Panel hostname", href: `${PAGE}#dns-panel-host`, whileOff: true,
    check: () => panelHostCheck(panelCustomDomainCertificate([0, panelUserUid() ?? 0]), panelHost()),
  },
  { id: "dns-automatic", level: "provision", title: "Automatic DNS records", href: `${PAGE}#dns-mode`, check: () => automaticCheck(dnsState()) },
];

import type { ActionNeeded, ActionNeededCheck, SetupCheck, SetupStep } from "../../lib/addon-definition";
import { connectionPermissions, type StoredAccess } from "../../lib/cloudflare/access";
import { hasSharedCloudflareStore, readCloudflareStore } from "../../lib/cloudflare/store";
import { panelCustomDomainCertificate } from "../../lib/panel-custom-domain";
import { addonStateDir, CLOUDFLARE_STATE_DIR } from "../../lib/paths";
import { readState } from "../../lib/root-state";
import { panelUserUid } from "../../lib/sso-auth";
import { parsePolicy, parseSecrets, type Policy } from "./model";
import { seededPolicy } from "./presets";

const PAGE = "/addons/dns/";

interface DnsSetupState {
  policy: Policy;
  tokens: Set<string>;
  /** Each connection's last check, with what its token holds. */
  reports: ({ id: string; active: boolean; error: string | null } & StoredAccess)[];
}

function dnsState(stateDir = addonStateDir("dns"), rootUid = 0, cloudflareDir = CLOUDFLARE_STATE_DIR): DnsSetupState {
  const raw = readState<unknown>(`${stateDir}/policy.json`, rootUid, () => null);
  const policy = raw === null ? seededPolicy() : parsePolicy(raw);
  const cfPaths = { stateDir: cloudflareDir, rootUid };
  const hasSharedCf = hasSharedCloudflareStore(cfPaths);
  const cf = hasSharedCf ? readCloudflareStore(cfPaths) : null;
  const secrets = parseSecrets(readState(`${stateDir}/secrets.json`, rootUid, () => ({})));
  const status = readState<{ connections?: DnsSetupState["reports"] }>(`${stateDir}/status.json`, rootUid, () => ({}));
  const statusReports = Array.isArray(status.connections) ? status.connections : [];
  const cfConnections = cf ? cf.connections : policy.connections;
  const cfTokens = cf ? cf.tokens : secrets.cloudflare;
  const cfReports = cf ? cf.reports : statusReports.filter((entry) => !entry.id.startsWith("pdns-"));
  const pdnsIds = new Set((policy.powerdns ?? []).map((connection) => connection.id));
  const pdnsReports = statusReports.filter((entry) => pdnsIds.has(entry.id));
  const tokens = new Set([
    ...Object.entries(cfTokens).filter(([, token]) => token).map(([id]) => id),
    ...Object.entries(secrets.powerdns ?? {}).filter(([, key]) => key).map(([id]) => id),
  ]);
  return {
    policy: { ...policy, connections: cfConnections },
    tokens,
    reports: [...cfReports, ...pdnsReports],
  };
}

export function connectionCheck(state: DnsSetupState): SetupCheck {
  const savedCf = state.policy.connections.filter((connection) => state.tokens.has(connection.id));
  const savedPdns = (state.policy.powerdns ?? []).filter((connection) => state.tokens.has(connection.id));
  const saved = [...savedCf, ...savedPdns];
  if (!saved.length) return { state: "todo", reason: "No DNS connection yet" };
  const failing = saved.map((connection) => state.reports.find((report) => report.id === connection.id))
    .find((report) => report && !report.active && report.error);
  if (failing && saved.length === 1) return { state: "todo", reason: failing.error! };
  const parts = [
    savedCf.length ? `Cloudflare: ${savedCf.map((connection) => connection.label).join(", ")}` : "",
    savedPdns.length ? `PowerDNS: ${savedPdns.map((connection) => connection.label).join(", ")}` : "",
  ].filter(Boolean);
  return { state: "done", reason: parts.join("; ") };
}

export function panelHostCheck(custom: { name: string; issued: boolean } | undefined, panelHost: string | null, connected = true): SetupCheck {
  if (custom?.issued) return { state: "done", reason: `CloudPanel answers at ${custom.name}` };
  if (custom) {
    return {
      state: "todo",
      reason: `${custom.name} is still on a self-signed certificate`,
      ...(connected ? {} : { href: "/admin/settings" }),
    };
  }
  if (panelHost && connected) return { state: "todo", reason: `Enter ${panelHost} under Admin → Settings → Custom Domain in CloudPanel` };
  if (!connected) {
    return {
      state: "todo",
      reason: "Point a hostname at this server in DNS, then set Custom Domain in CloudPanel",
      href: "/admin/settings",
    };
  }
  return { state: "todo", reason: "CloudPanel has no custom domain" };
}

export function automaticCheck(state: DnsSetupState): SetupCheck {
  const hasConnection = state.policy.connections.some((connection) => state.tokens.has(connection.id))
    || (state.policy.powerdns ?? []).some((connection) => state.tokens.has(connection.id));
  if (!hasConnection) return { state: "todo", reason: "Connect DNS first" };
  if (!state.policy.automatic) return { state: "todo", reason: "DNS asks before it changes records" };
  const profile = state.policy.profiles.find((candidate) => candidate.id === state.policy.defaultProfileId);
  return profile
    ? { state: "done", reason: `New sites get ${profile.name}'s records` }
    : { state: "todo", reason: "New sites get no profile" };
}

/** One item per Cloudflare connection whose token lacks a permission DNS requires; optional ones never count. */
export function permissionActions(state: DnsSetupState): ActionNeeded[] {
  return state.policy.connections.flatMap((connection) => {
    const report = state.reports.find((entry) => entry.id === connection.id);
    if (!report?.active || !state.tokens.has(connection.id)) return [];
    const { missing } = connectionPermissions(report, undefined, { includeDns: true, includeEdge: false, requirePanelGate: false });
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

function panelHostContext(): { panelHost: string | null; connected: boolean } {
  try {
    const state = dnsState();
    return {
      panelHost: state.policy.panelHost,
      connected: state.policy.connections.some((connection) => state.tokens.has(connection.id))
        || (state.policy.powerdns ?? []).some((connection) => state.tokens.has(connection.id)),
    };
  } catch {
    return { panelHost: null, connected: false };
  }
}

export const DNS_SETUP: SetupStep[] = [
  {
    id: "dns-connection", level: "domain", title: "Connect DNS", href: `${PAGE}#dns-connection`,
    why: "Connect Cloudflare or PowerDNS once so DNS can manage site records, wildcards and the panel hostname automatically.",
    check: () => connectionCheck(dnsState()),
  },
  {
    id: "panel-hostname", level: "domain", title: "Panel hostname", href: `${PAGE}#dns-panel-host`, whileOff: true,
    why: "Gives CloudPanel its own HTTPS hostname on port 443, unlocking passkeys and Cloudflare Access.",
    check: () => {
      const { panelHost, connected } = panelHostContext();
      return panelHostCheck(panelCustomDomainCertificate([0, panelUserUid() ?? 0]), panelHost, connected);
    },
  },
  {
    id: "dns-automatic", level: "sites", title: "Automatic DNS records", href: `${PAGE}#dns-mode`,
    requires: ["dns-connection"],
    why: "Writes new sites' records and corrects drift automatically instead of stopping at Ask first.",
    check: () => automaticCheck(dnsState()),
  },
];

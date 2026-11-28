import type { ActionNeeded, ActionNeededCheck } from "../../lib/addon-definition";
import { connectionPermissions, type StoredAccess } from "../../lib/cloudflare/access";
import { readCloudflareStore } from "../../lib/cloudflare/store";
import { addonStateDir, CLOUDFLARE_STATE_DIR } from "../../lib/paths";
import { readState } from "../../lib/root-state";
import { emptyPolicy, parsePolicy, type Policy } from "./model";

const PAGE = "/addons/redirects/";

interface RedirectsSetupState {
  policy: Policy;
  connections: { id: string; label: string }[];
  tokens: Set<string>;
  reports: ({ id: string; active: boolean; zoneNames?: string[]; error: string | null } & StoredAccess)[];
}

function redirectsState(stateDir = addonStateDir("redirects"), rootUid = 0, cloudflareDir = CLOUDFLARE_STATE_DIR): RedirectsSetupState {
  const raw = readState<unknown>(`${stateDir}/policy.json`, rootUid, () => null);
  const policy = raw === null ? emptyPolicy() : parsePolicy(raw);
  const cf = readCloudflareStore({ stateDir: cloudflareDir, rootUid });
  const tokens = new Set(Object.entries(cf.tokens).filter(([, token]) => token).map(([id]) => id));
  return { policy, connections: cf.connections, tokens, reports: cf.reports };
}

/**
 * One item per Cloudflare connection whose token lacks a permission Redirects
 * requires (`DNS: Edit` or `Single Redirect: Edit`), when Redirects actually
 * has an auto-mode redirect under that connection's zones or Cloudflare already
 * refused one of those permissions.
 */
export function permissionActions(state: RedirectsSetupState): ActionNeeded[] {
  const autoRedirects = state.policy.redirects.filter((redirect) => redirect.mode !== "local");
  return state.connections.flatMap((connection) => {
    const report = state.reports.find((entry) => entry.id === connection.id);
    if (!report?.active || !state.tokens.has(connection.id)) return [];
    const zoneNames = report.zoneNames ?? [];
    const relevant = autoRedirects.some((redirect) =>
      zoneNames.some((zone) => redirect.source === zone || redirect.source.endsWith(`.${zone}`)))
      || (report.refused ?? []).some((label) => label === "Single Redirect: Edit" || label === "DNS: Edit");
    if (!relevant) return [];
    const { missing } = connectionPermissions(report, [], { includeDns: false, requireRedirects: true });
    if (!missing.length) return [];
    return [{
      title: missing.length > 1 ? "Cloudflare token needs permissions" : "Cloudflare token needs a permission",
      reason: `${connection.label}'s token lacks ${missing.join(", ")}, which Redirects needs; add ${missing.length > 1 ? "them" : "it"} to the token in Cloudflare`,
      href: `${PAGE}#redir-connection`,
    }];
  });
}

export const REDIRECTS_ACTIONS: ActionNeededCheck[] = [
  { id: "redirects-permissions", check: () => permissionActions(redirectsState()) },
];

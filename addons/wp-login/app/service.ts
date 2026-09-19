import { callGatewayAction, type ActionResult } from "../../../lib/gateway-client";
import type { WpLoginResult, WpRemoveResult, WpSiteView } from "../action";

const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function validateDomain(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const domain = value.trim().toLowerCase().replace(/\.$/, "");
  return domain.length <= 253 && DOMAIN_RE.test(domain) ? domain : null;
}

function call<T>(verb: string, args: string[] = [], timeout?: number): Promise<ActionResult<T>> {
  return callGatewayAction<T>("wp-login", verb, args, undefined, timeout ? { timeout } : undefined);
}

/** Finding the WordPress sites means a stat of every site root on the box. */
const LIST_TIMEOUT_MS = 60_000;

export const wpLoginService = {
  sites(): Promise<ActionResult<{ sites: WpSiteView[] }>> {
    return call<{ sites: WpSiteView[] }>("sites", [], LIST_TIMEOUT_MS);
  },

  // `asUser` is the panel user a non-administrator's request is on behalf of.
  // The root action is what checks it against CloudPanel's own user-to-site
  // mapping; this side only says whose request it is.
  signIn(domain: string, asUser?: string): Promise<ActionResult<WpLoginResult>> {
    const args = [`--domain=${domain}`];
    if (asUser) args.push(`--as-user=${asUser}`);
    return call<WpLoginResult>("sign-in", args);
  },

  remove(): Promise<ActionResult<WpRemoveResult>> {
    return call<WpRemoveResult>("remove", [], LIST_TIMEOUT_MS);
  },
};

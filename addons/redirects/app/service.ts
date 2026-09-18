import { callGatewayAction, type ActionResult } from "../../../lib/gateway-client";
import type { RedirectsState } from "../action";

const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function validateDomain(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const domain = value.trim().toLowerCase().replace(/\.$/, "");
  return domain.length <= 253 && DOMAIN_RE.test(domain) ? domain : null;
}

/** What the page sends for a redirect; the action validates all of it again. */
export interface RedirectRequest {
  target: unknown;
  code: unknown;
  preservePath: unknown;
}

function call<T>(verb: string, args: string[] = [], input?: string): Promise<ActionResult<T>> {
  return callGatewayAction<T>("redirects", verb, args, input);
}

function redirectInput(body: RedirectRequest): string {
  return JSON.stringify({ target: body.target, code: body.code, preservePath: body.preservePath });
}

export const redirectsService = {
  state(): Promise<ActionResult<RedirectsState>> {
    return call<RedirectsState>("list");
  },

  // Creating the CloudPanel site takes a few seconds, which the gateway's
  // default budget covers; a job record would only add a page to watch it on.
  create(domain: string, body: RedirectRequest): Promise<ActionResult<RedirectsState>> {
    return call<RedirectsState>("create", [`--domain=${domain}`], redirectInput(body));
  },

  set(domain: string, body: RedirectRequest): Promise<ActionResult<RedirectsState>> {
    return call<RedirectsState>("set", [`--domain=${domain}`], redirectInput(body));
  },

  clear(domain: string): Promise<ActionResult<RedirectsState>> {
    return call<RedirectsState>("clear", [`--domain=${domain}`]);
  },
};

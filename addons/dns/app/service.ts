import { callGatewayAction, type ActionResult } from "../../../lib/gateway-client";
import type { WebVerb } from "../../../lib/gateway-protocol";
import type { DnsReply, ProvisionReply, SiteDnsStatus } from "../action";

/** Verbs that read Cloudflare and Mailcow wait for them; everything else is a file write. */
const SLOW = new Set(["check", "confirm", "save-connection", "remove-connection", "save-mailcow", "remove-mailcow", "save-server", "remove-records",
  "save-redirect", "delete-redirect", "find-redirects", "take-over"]);

export const dnsService = {
  state: (): Promise<ActionResult<DnsReply>> => callGatewayAction<DnsReply>("dns", "list"),
  change: (verb: WebVerb<"dns">, body: unknown): Promise<ActionResult<DnsReply>> =>
    callGatewayAction<DnsReply>("dns", verb, [], JSON.stringify(body), { timeout: SLOW.has(verb) ? 300_000 : 120_000 }),
  siteStatus: (domain: string, asUser?: string): Promise<ActionResult<SiteDnsStatus>> =>
    callGatewayAction<SiteDnsStatus>("dns", "site-status", [`--domain=${domain}`, ...(asUser ? [`--as-user=${asUser}`] : [])]),
  provision: (domain: string, options: { asUser?: string; ssl?: boolean }): Promise<ActionResult<ProvisionReply>> =>
    callGatewayAction<ProvisionReply>(
      "dns", "provision",
      [`--domain=${domain}`, ...(options.asUser ? [`--as-user=${options.asUser}`] : []), ...(options.ssl ? ["--ssl"] : [])],
      undefined, { timeout: 280_000 },
    ),
};

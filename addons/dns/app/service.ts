import { callGatewayAction, type ActionResult } from "../../../lib/gateway-client";
import type { DnsReply, ProvisionReply } from "../action";

/** Verbs that read Cloudflare and Mailcow wait for them; everything else is a file write. */
const SLOW = new Set(["check", "confirm", "save-connection", "remove-connection", "save-mailcow", "remove-mailcow", "save-server", "remove-records"]);

export const dnsService = {
  state: (): Promise<ActionResult<DnsReply>> => callGatewayAction<DnsReply>("dns", "list"),
  change: (verb: string, body: unknown): Promise<ActionResult<DnsReply>> =>
    callGatewayAction<DnsReply>("dns", verb, [], JSON.stringify(body), { timeout: SLOW.has(verb) ? 300_000 : 120_000 }),
  provision: (domain: string, options: { asUser?: string; ssl?: boolean }): Promise<ActionResult<ProvisionReply>> =>
    callGatewayAction<ProvisionReply>(
      "dns", "provision",
      [`--domain=${domain}`, ...(options.asUser ? [`--as-user=${options.asUser}`] : []), ...(options.ssl ? ["--ssl"] : [])],
      undefined, { timeout: 280_000 },
    ),
};

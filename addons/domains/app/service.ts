import { callGatewayAction } from "../../../lib/gateway-client";
import type { Reply } from "../model";

export const domainsService = {
  state: () => callGatewayAction<Reply>("domains", "list"),
  change: (verb: string, body: unknown) => callGatewayAction<Reply>("domains", verb, [], JSON.stringify(body), { timeout: 300_000 }),
  provision: (domain: string, asUser?: string) => callGatewayAction<{ ready: boolean; reason: string; certificateDomains?: string[] }>("domains", "provision", [`--domain=${domain}`, ...(asUser ? [`--as-user=${asUser}`] : [])], undefined, { timeout: 120_000 }),
};

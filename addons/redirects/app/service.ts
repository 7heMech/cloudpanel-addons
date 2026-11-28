import { callGatewayAction, type ActionResult } from "../../../lib/gateway-client";
import type { WebVerb } from "../../../lib/gateway-protocol";
import type { CreateSiteHelper, RedirectsReply } from "../action";

const SLOW = new Set<WebVerb<"redirects">>([
  "check", "confirm", "save-redirect", "delete-redirect", "review-redirect",
  "find-redirects", "take-over", "save-connection", "remove-connection",
]);

export const redirectsService = {
  state: (): Promise<ActionResult<RedirectsReply>> => callGatewayAction("redirects", "list"),
  createSiteHelper: (): Promise<ActionResult<CreateSiteHelper>> => callGatewayAction("redirects", "create-site-helper"),
  change: (verb: WebVerb<"redirects">, body: unknown): Promise<ActionResult<RedirectsReply>> =>
    callGatewayAction("redirects", verb, [], JSON.stringify(body), { timeout: SLOW.has(verb) ? 300_000 : 120_000 }),
};

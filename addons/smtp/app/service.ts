import { callGatewayAction, type ActionResult } from "../../../lib/gateway-client";
import type { WebVerb } from "../../../lib/gateway-protocol";
import type { SmtpState, SmtpTestResult } from "../action";

export const smtpService = {
  state: (): Promise<ActionResult<SmtpState>> => callGatewayAction("smtp", "list"),
  change: (verb: WebVerb<"smtp">, body: unknown): Promise<ActionResult<SmtpState>> =>
    callGatewayAction("smtp", verb, [], JSON.stringify(body)),
  test: (body: unknown): Promise<ActionResult<SmtpTestResult>> =>
    callGatewayAction("smtp", "test", [], JSON.stringify(body)),
};

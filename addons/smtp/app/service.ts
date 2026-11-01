import { callGatewayAction, type ActionResult } from "../../../lib/gateway-client";
import type { WebVerb } from "../../../lib/gateway-protocol";
import type { SmtpState, SmtpTestResult } from "../action";

const call = (verb: WebVerb<"smtp">, body?: unknown): Promise<ActionResult<SmtpState>> =>
  callGatewayAction("smtp", verb, [], body === undefined ? undefined : JSON.stringify(body));

export const smtpService = {
  state: () => call("list"),
  saveProfile: (body: unknown) => call("save-profile", body),
  deleteProfile: (body: unknown) => call("delete-profile", body),
  assign: (body: unknown) => call("assign", body),
  setDefault: (body: unknown) => call("set-default", body),
  saveGrants: (body: unknown) => call("save-grants", body),
  test: (body: unknown): Promise<ActionResult<SmtpTestResult>> =>
    callGatewayAction("smtp", "test", [], JSON.stringify(body)),
};

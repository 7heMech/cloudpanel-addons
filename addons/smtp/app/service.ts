import { callGatewayAction, type ActionResult } from "../../../lib/gateway-client";
import type { SmtpState } from "../action";

const call = (verb: string, body?: unknown): Promise<ActionResult<SmtpState>> =>
  callGatewayAction<SmtpState>("smtp", verb, [], body === undefined ? undefined : JSON.stringify(body));

export const smtpService = {
  state: () => call("list"),
  saveSetup: (body: unknown) => call("save-setup", body),
  saveRelay: (body: unknown) => call("save-relay", body),
  saveDefault: (body: unknown) => call("save-default", body),
  saveSite: (body: unknown) => call("save-site", body),
  clearSite: (body: unknown) => call("clear-site", body),
  saveDomainRelay: (body: unknown) => call("save-domain-relay", body),
  clearDomainRelay: (body: unknown) => call("clear-domain-relay", body),
  test: (body: unknown): Promise<ActionResult<{ queued: boolean; sender: string; recipient: string }>> =>
    callGatewayAction("smtp", "test", [], JSON.stringify(body)),
};

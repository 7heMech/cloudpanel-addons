import { callGatewayAction, type ActionResult } from "../../../lib/gateway-client";
import type { WebVerb } from "../../../lib/gateway-protocol";
import type { KeyView, Settings, UserKeysView } from "../action";

export type { KeyView, Settings, UserKeysView };

type Fleet = { users: UserKeysView[]; settings: Settings };
/** What one account sees on its own card, and may do there. */
type OwnKeys = { keys: KeyView[]; canAdd: boolean; syncedPasskeys: boolean };

async function call<T>(verb: WebVerb<"security-keys">, input?: unknown, sessionId?: string): Promise<ActionResult<T>> {
  return callGatewayAction(
    "security-keys", verb, [], input === undefined ? undefined : JSON.stringify(input),
    sessionId === undefined ? {} : { sessionId },
  );
}

export const securityKeysService = {
  loginOptions: () => call<{ challengeId: string; challenge: string }>("login-options"),
  signIn: (assertion: Record<string, unknown>) => call<{ token: string; user: string }>("sign-in", assertion),

  keys: (sessionId: string) => call<OwnKeys>("keys", undefined, sessionId),
  registerOptions: (sessionId: string) => call<{
    challengeId: string; challenge: string; user: { id: string; name: string }; exclude: string[]; syncedPasskeys: boolean;
  }>("register-options", undefined, sessionId),
  register: (sessionId: string, input: Record<string, unknown>) => call<OwnKeys>("register", input, sessionId),
  remove: (sessionId: string, id: string) => call<OwnKeys>("remove", { id }, sessionId),

  users: () => call<Fleet>("users"),
  revoke: (user: string, id: string) => call<Fleet>("revoke", { user, id }),
  settings: (settings: Settings) => call<Fleet>("settings", settings),
};

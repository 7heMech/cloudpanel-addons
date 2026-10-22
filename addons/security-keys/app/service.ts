import { callGatewayAction, type ActionResult } from "../../../lib/gateway-client";
import type { KeyView, UserKeysView } from "../action";

export type { KeyView, UserKeysView };

async function call<T>(verb: string, input?: unknown, sessionId?: string): Promise<ActionResult<T>> {
  return callGatewayAction<T>(
    "security-keys", verb, [], input === undefined ? undefined : JSON.stringify(input),
    sessionId === undefined ? {} : { sessionId },
  );
}

export const securityKeysService = {
  loginOptions: () => call<{ challengeId: string; challenge: string }>("login-options"),
  signIn: (assertion: Record<string, unknown>) => call<{ token: string; user: string }>("sign-in", assertion),

  keys: (sessionId: string) => call<{ keys: KeyView[] }>("keys", undefined, sessionId),
  registerOptions: (sessionId: string) => call<{
    challengeId: string; challenge: string; user: { id: string; name: string }; exclude: string[];
  }>("register-options", undefined, sessionId),
  register: (sessionId: string, input: Record<string, unknown>) => call<{ keys: KeyView[] }>("register", input, sessionId),
  remove: (sessionId: string, id: string) => call<{ keys: KeyView[] }>("remove", { id }, sessionId),

  users: () => call<{ users: UserKeysView[] }>("users"),
  revoke: (user: string, id: string) => call<{ users: UserKeysView[] }>("revoke", { user, id }),
};

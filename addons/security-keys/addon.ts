import { handle } from "./app/index";
import { SIGN_IN_PREFIX, handleSignIn } from "./app/sign-in";
import { runSecurityKeysAction } from "./action";
import { SECURITY_KEYS_TARGETS } from "./inject/targets";
import type { AddonDefinition } from "../../cli/addon-catalog";

export const SECURITY_KEYS_ADDON: AddonDefinition = {
  name: "security-keys",
  title: "Security Keys",
  description: "Sign in to CloudPanel with a passkey or a hardware key such as a YubiKey, instead of a password.",
  added: "2.0.0-rc.1",
  preselected: true,
  targets: SECURITY_KEYS_TARGETS,
  handler: handle,
  action: runSecurityKeysAction,
  // The login page's passkey sign-in: there is no session yet, and the key's
  // signature, checked as root, is the credential.
  preGate: { prefix: SIGN_IN_PREFIX, handle: handleSignIn },
  // Each user's own keys, from CloudPanel's Security page; the gateway reads
  // whose they are from the session itself.
  selfScopedRoutes: ["GET /api/keys", "POST /api/register-options", "POST /api/register", "POST /api/remove"],
};

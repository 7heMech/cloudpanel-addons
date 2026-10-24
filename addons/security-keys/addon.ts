import { handle } from "./app/index";
import { runSecurityKeysAction } from "./action";
import { SECURITY_KEYS_TARGETS } from "./inject/targets";
import type { AddonDefinition } from "../../cli/addon-catalog";

export const SECURITY_KEYS_ADDON: AddonDefinition = {
  name: "security-keys",
  title: "Security Keys",
  description: "Sign in to CloudPanel with a passkey or a hardware key such as a YubiKey, instead of a password.",
  preselected: true,
  targets: SECURITY_KEYS_TARGETS,
  handler: handle,
  action: runSecurityKeysAction,
};

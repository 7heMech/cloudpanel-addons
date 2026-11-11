import type { SetupCheck, SetupStep } from "../../lib/addon-definition";
import { administratorKeys } from "./action";

/** One administrator with a key is enough: it is the operator's own account. */
export function passkeysCheck(found: { admins: string[]; keyed: string[]; allowed: boolean }): SetupCheck {
  if (!found.allowed) return { state: "todo", reason: "Administrators may not use security keys under Settings" };
  if (!found.keyed.length) return { state: "todo", reason: "No administrator has a security key yet" };
  return { state: "done", reason: `${found.keyed.join(", ")} ${found.keyed.length > 1 ? "have" : "has"} a security key` };
}

export const SECURITY_KEYS_SETUP: SetupStep[] = [
  { id: "passkeys", level: "secure", title: "Passkeys for administrators", href: "/security", check: () => passkeysCheck(administratorKeys()) },
];

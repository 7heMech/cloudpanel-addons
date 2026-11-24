import type { SetupCheck, SetupStep } from "../../lib/addon-definition";
import { panelCustomDomainCertificate } from "../../lib/panel-custom-domain";
import { panelUserUid } from "../../lib/sso-auth";
import { administratorKeys } from "./action";

/** One administrator with a key is enough: it is the operator's own account. */
export function passkeysCheck(
  found: { admins: string[]; keyed: string[]; allowed: boolean },
  customDomain?: { name: string; issued: boolean } | null,
): SetupCheck {
  if (!found.allowed) return { state: "todo", reason: "Administrators may not use security keys under Settings" };
  if (found.keyed.length) return { state: "done", reason: `${found.keyed.join(", ")} ${found.keyed.length > 1 ? "have" : "has"} a security key` };
  if (customDomain === null || (customDomain && !customDomain.issued)) {
    return { state: "todo", reason: "Set a panel hostname with a trusted certificate first" };
  }
  return { state: "todo", reason: "No administrator has a security key yet" };
}

export const SECURITY_KEYS_SETUP: SetupStep[] = [
  {
    id: "passkeys", level: "domain", title: "Passkeys for administrators", href: "/security",
    requires: ["panel-hostname"],
    why: "Sign in with a hardware key or passkey instead of a password. Keys bind to the exact hostname and require a trusted certificate.",
    check: () => passkeysCheck(administratorKeys(), panelCustomDomainCertificate([0, panelUserUid() ?? 0]) ?? null),
  },
];

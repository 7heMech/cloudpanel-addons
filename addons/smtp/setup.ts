import type { SetupCheck, SetupStep } from "../../lib/addon-definition";
import { smtpSetupState } from "./action";

type SmtpSetupState = ReturnType<typeof smtpSetupState>;

export function relayCheck(state: SmtpSetupState): SetupCheck {
  return state.relays.length
    ? { state: "done", reason: `Relay: ${state.relays.join(", ")}` }
    : { state: "todo", reason: "Sites send mail straight from this server" };
}

export function newSiteMailCheck(state: SmtpSetupState): SetupCheck {
  if (!state.relays.length) return { state: "na", reason: "Needs a relay first" };
  if (state.defaultProfile?.relays) return { state: "done", reason: `New sites send through ${state.defaultProfile.name}` };
  return { state: "todo", reason: state.defaultProfile ? `New sites join ${state.defaultProfile.name}, which does not relay` : "New sites join no profile" };
}

export const SMTP_SETUP: SetupStep[] = [
  {
    id: "smtp-relay", level: "sites", title: "Outgoing mail relay", href: "/addons/smtp/",
    why: "Routes transactional mail through a real SMTP relay instead of sending directly from the server IP.",
    check: () => relayCheck(smtpSetupState()),
  },
  {
    id: "smtp-new-sites", level: "sites", title: "Mail for new sites", href: "/addons/smtp/#smtp-profiles",
    requires: ["smtp-relay"],
    why: "Enrolls newly created sites into a default mail relay profile automatically.",
    check: () => newSiteMailCheck(smtpSetupState()),
  },
];

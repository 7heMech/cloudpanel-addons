import { handle } from "./app/index";
import { endAllTerminals, runTerminalAction } from "./action";
import { TERMINAL_TARGETS } from "./inject/targets";
import { runTerminalPty } from "./pty";
import { runTerminalRootCommand } from "./root-access";
import type { AddonDefinition } from "../../lib/addon-definition";

export const TERMINAL_ADDON: AddonDefinition = {
  name: "terminal",
  title: "Terminal",
  description: "A shell as any site's own user, in a window opened from the panel's Sites page, the site page, or Addons; and a root shell for administrators root allows.",
  changed: [{ in: "2.1.0-rc.4", note: "On a phone, Root terminal is now >_ Root at the end of the row under the logo, rather than in the account menu." }, { in: "2.1.0-rc.4", note: "A root terminal takes the code your app shows at once. Only in the minute and a half after signing in does it ask for the next one, since the one showing could be your sign-in code." }, { in: "2.1.0-rc.3", note: "Opening a new root terminal now requires a fresh authenticator code, the next one your app shows after the prompt opens, or a passkey trusted by root." }, { in: "2.1.0-rc.1", note: "Root can let chosen administrators open a root terminal from the panel with clp-addons terminal root allow <user>. It needs their 2FA." }],
  targets: TERMINAL_TARGETS,
  handler: handle,
  action: runTerminalAction,
  commands: {
    terminal: { usage: "terminal root [allow|deny <user>]", run: runTerminalRootCommand },
    // What a terminal worker runs as the shell's own user.
    "terminal-pty": { run: runTerminalPty },
  },
  // After the config is gone: a worker started before then is found here, and
  // none can start after.
  withdrawn: () => { endAllTerminals(); },
};

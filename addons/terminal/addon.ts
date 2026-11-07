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
  changed: [{ in: "2.1.0-rc.1", note: "Root can let chosen administrators open a root terminal from the panel with clp-addons terminal root allow <user>. It needs their 2FA." }],
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

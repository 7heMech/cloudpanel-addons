import { handle } from "./app/index";
import { endAllTerminals, runTerminalAction } from "./action";
import { TERMINAL_TARGETS } from "./inject/targets";
import type { AddonDefinition } from "../../cli/addon-catalog";

export const TERMINAL_ADDON: AddonDefinition = {
  name: "terminal",
  title: "Terminal",
  description: "A shell as any site's own user, in a window opened from the panel's Sites page, the site page, or Addons.",
  targets: TERMINAL_TARGETS,
  handler: handle,
  action: runTerminalAction,
  // After the config is gone: a worker started before then is found here, and
  // none can start after.
  withdrawn: () => { endAllTerminals(); },
};

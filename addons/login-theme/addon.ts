import { handle } from "./app/index";
import { LOGIN_THEME_TARGETS } from "./inject/targets";
import type { AddonDefinition } from "../../cli/addon-catalog";

export const LOGIN_THEME_ADDON: AddonDefinition = {
  name: "login-theme",
  title: "Device theme on first visit",
  description: "Follow the device's light or dark preference on the first visit.",
  targets: LOGIN_THEME_TARGETS,
  handler: handle,
  // No privileged action: the addon is markup injected into the panel's login
  // page and has nothing to do as root.
};

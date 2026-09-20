import { handle } from "./app/index";
import { runWpLoginAction } from "./action";
import { WP_LOGIN_TARGETS } from "./inject/targets";
import type { AddonDefinition } from "../../cli/addon-catalog";

export const WP_LOGIN_ADDON: AddonDefinition = {
  name: "wp-login",
  title: "WordPress Sign-In",
  description: "A one-click sign-in to any WordPress on this server, as its first administrator, from the panel's Sites page.",
  targets: WP_LOGIN_TARGETS,
  handler: handle,
  action: runWpLoginAction,
};

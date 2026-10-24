import { handle } from "./app/index";
import { runCloudflareAction } from "./action";
import type { AddonDefinition } from "../../cli/addon-catalog";

export const CLOUDFLARE_IPS_ADDON: AddonDefinition = {
  name: "cloudflare-ips",
  title: "Cloudflare IP Access",
  description: "Manage CloudPanel's Cloudflare-only traffic setting across every site.",
  targets: [],
  handler: handle,
  action: runCloudflareAction,
};

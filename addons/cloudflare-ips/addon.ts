import { handle } from "./app/index";
import { cloudflareProtectionUpkeep, runCloudflareAction, withdrawCloudflareProtection, type CloudflareActionOptions } from "./action";
import type { AddonDefinition } from "../../cli/addon-catalog";

export const CLOUDFLARE_IPS_ADDON: AddonDefinition = {
  name: "cloudflare-ips",
  title: "Cloudflare IP Access",
  description: "Manage Cloudflare-only access across sites and mitigate bypasses using forged IP headers.",
  targets: [],
  handler: handle,
  action: runCloudflareAction,
  activate: () => { cloudflareProtectionUpkeep(); },
  deactivate: () => withdrawCloudflareProtection(),
  maintenance: { label: "Cloudflare bypass protection", run: (options) => cloudflareProtectionUpkeep((options ?? {}) as CloudflareActionOptions) },
};

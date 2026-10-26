import { handle } from "./app/index";
import { DEFAULT_CLOUDFLARE_ACTION_PATHS, reconcileNewSites, runCloudflareAction, type CloudflareActionPaths } from "./action";
import type { AddonDefinition } from "../../cli/addon-catalog";
import { log } from "../../cli/util";

async function protectNewSites(options?: Record<string, unknown>): Promise<string | null> {
  const paths = { ...DEFAULT_CLOUDFLARE_ACTION_PATHS, ...(options?.paths as Partial<CloudflareActionPaths> | undefined) };
  const result = await reconcileNewSites(paths);
  for (const failure of result.failed) log.warn(`Cloudflare IP Access: ${failure.error}`);
  return result.enabled ? `${result.enabled} new site${result.enabled === 1 ? "" : "s"} allow Cloudflare only` : null;
}

export const CLOUDFLARE_IPS_ADDON: AddonDefinition = {
  name: "cloudflare-ips",
  title: "Cloudflare IP Access",
  description: "Manage CloudPanel's Cloudflare-only traffic setting across every site.",
  changed: { in: "2.0", note: "Sites come first, and new sites are picked up within seconds." },
  targets: [],
  handler: handle,
  action: runCloudflareAction,
  newSites: { label: "Cloudflare IP Access", run: protectNewSites },
  // A site whose vhost was not ready when it was created is tried again here.
  maintenance: { label: "Cloudflare IP Access", run: protectNewSites },
};

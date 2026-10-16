import type { AddonSpec } from "./addon-catalog";
import { log } from "./util";

export async function runNewSiteReconciliation(addons: AddonSpec[], options?: Record<string, unknown>): Promise<void> {
  for (const addon of addons.filter((a) => a.newSites)) {
    try {
      const line = await addon.newSites!.run(options);
      if (line) log.ok(`${addon.newSites!.label}: ${line}`);
    } catch (e) { log.warn(`${addon.newSites!.label}: ${e instanceof Error ? e.message : "reconciliation failed"}`); }
  }
}

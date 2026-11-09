import { handle } from "./app/index";
import {
  DEFAULT_CLOUDFLARE_ACTION_PATHS, reconcileNewSites, runFirewallAction, type CloudflareActionPaths,
} from "./action";
import { FIREWALL_TARGETS } from "./inject/targets";
import { syncFirewall } from "./protocols";
import type { AddonDefinition } from "../../lib/addon-definition";
import { errorMessage } from "../../lib/errors";
import { log } from "../../lib/log";

async function protectNewSites(options?: Record<string, unknown>): Promise<string | null> {
  const paths = { ...DEFAULT_CLOUDFLARE_ACTION_PATHS, ...(options?.paths as Partial<CloudflareActionPaths> | undefined) };
  const result = await reconcileNewSites(paths);
  for (const failure of result.failed) log.warn(`Firewall: ${failure.error}`);
  return result.enabled ? `${result.enabled} new site${result.enabled === 1 ? "" : "s"} allow Cloudflare only` : null;
}

/** Repair: new sites first, then the protocols, each whatever the other does. */
async function repair(options?: Record<string, unknown>): Promise<string | null> {
  const lines: string[] = [];
  const failures: string[] = [];
  try {
    const line = await protectNewSites(options);
    if (line) lines.push(line);
  } catch (error) { failures.push(`Cloudflare-only sites: ${errorMessage(error)}`); }
  try {
    const changed = syncFirewall("apply");
    if (changed) lines.push(`protocols: ${changed}`);
  } catch (error) { failures.push(`protocols: ${errorMessage(error)}`); }
  if (failures.length) throw new Error([...failures, ...lines].join("; "));
  return lines.join("; ") || null;
}

export const FIREWALL_ADDON: AddonDefinition = {
  name: "firewall",
  title: "Firewall",
  description: "Cloudflare-only access for every site, and TCP, UDP or both for each rule on CloudPanel's Firewall page.",
  changed: [
    { in: "2.2.0-rc.1", note: "Cloudflare IP Access is now Firewall, which also sets each firewall rule's protocol: TCP, UDP or both." },
  ],
  targets: FIREWALL_TARGETS,
  handler: handle,
  action: runFirewallAction,
  newSites: { label: "Cloudflare-only sites", run: protectNewSites },
  // A site whose vhost was not ready when it was created is tried again here.
  repair: { label: "firewall", run: repair },
  firewall: { label: "firewall protocols", run: () => syncFirewall("apply") },
  // CloudPanel's next change on its Firewall page rebuilds ufw without these rules anyway.
  deactivate: () => {
    try { syncFirewall("withdraw"); }
    catch (error) { log.warn(`ufw still has UDP rules from Firewall: ${errorMessage(error)}`); }
  },
  activate: () => {
    try { syncFirewall("restore"); }
    catch (error) { log.warn(`firewall protocols wait for the next repair: ${errorMessage(error)}`); }
  },
};

// The manager's own privileged verbs. They go over the same gateway the
// addons use, so there is no second path to root.
import { callGatewayAction, type ActionResult } from "../lib/gateway-client";
import type { WebVerb } from "../lib/gateway-protocol";
import type { ManagerJobView } from "../cli/manager-action";

/** The manager's own privileged verbs go over the same gateway the addons use. */
export async function managerAction<T>(verb: WebVerb<"manager">, args: string[] = []): Promise<ActionResult<T>> {
  // The create verbs hand the work to systemd and return; nothing here waits
  // for an enable or an update to finish.
  return callGatewayAction("manager", verb, args, undefined, { timeout: 30_000 });
}

export async function latestManagerJobView(): Promise<ManagerJobView | null> {
  const result = await managerAction<{ job: ManagerJobView; log: string } | null>("job");
  return result.ok && result.data ? result.data.job : null;
}

/**
 * The release badges start after and the ones an administrator has opened.
 * When the gateway cannot say, every notice shows rather than hides.
 */
export async function seenNews(): Promise<{ since: string; seen: string[] }> {
  const result = await managerAction<{ since: string; seen: string[] }>("news-seen");
  const data = result.ok ? result.data : null;
  return typeof data?.since === "string" && Array.isArray(data.seen) ? data : { since: "0.0.0", seen: [] };
}

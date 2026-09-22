// The manager's own privileged verbs. They go over the same gateway the
// addons use, so there is no second path to root.
import { callGatewayAction, type ActionResult } from "../lib/gateway-client";
import type { ManagerJobView } from "../cli/manager-action";

/** The manager's own privileged verbs go over the same gateway the addons use. */
export async function managerAction<T>(verb: string, args: string[] = []): Promise<ActionResult<T>> {
  // The create verbs hand the work to systemd and return; nothing here waits
  // for an enable or an update to finish.
  return callGatewayAction<T>("manager", verb, args, undefined, { timeout: 30_000 });
}

export async function latestManagerJobView(): Promise<ManagerJobView | null> {
  const result = await managerAction<{ job: ManagerJobView; log: string } | null>("job");
  return result.ok && result.data ? result.data.job : null;
}

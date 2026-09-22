// The upkeep `repair` and the reconcile timer run, per addon and for the manager's own job records.

import { type AddonSpec, addonMaintenance } from "./addon-catalog";
import { pruneManagerJobs } from "./manager-action";
import { log } from "./util";
/**
 * Run each installed addon's own upkeep, in catalog order.
 *
 * Stager's prune and Instatic's were called by name from `cmdRepair`, which
 * meant repair knew which addons had upkeep and what it was called. An addon
 * now declares its own, and none of it is allowed to fail the rest of repair:
 * this is self-healing, not a precondition for anything.
 */
export async function runAddonMaintenance(
  installed: AddonSpec[],
  options?: Record<string, unknown>,
): Promise<void> {
  for (const spec of addonMaintenance(installed)) {
    const task = spec.maintenance!;
    try {
      const line = await task.run(options);
      if (line) log.ok(`${task.label}: ${line}`);
    } catch (error) {
      log.warn(`${task.label} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/**
 * The manager's own job records need the same upkeep the addons' do: a runner
 * killed part-way (a reboot during an update) otherwise leaves a record that
 * says "running" forever, and the index page would keep following it.
 */
export function runManagerMaintenance(): void {
  try {
    const { removed, stuck } = pruneManagerJobs();
    if (removed || stuck) log.ok(`manager job records: ${removed} expired, ${stuck} marked failed`);
  } catch (error) {
    log.warn(`manager maintenance (prune) failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

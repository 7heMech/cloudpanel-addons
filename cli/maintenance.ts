// The upkeep `repair` and the reconcile timer run, per addon and for the manager's own job records.

import { type AddonSpec, addonCertificates, addonMaintenance, addonNewSites } from "./addon-catalog";
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

/** How long one addon's new-site work runs before the next starts beside it. */
export const NEW_SITE_HEAD_START_MS = 15_000;

/**
 * What the new-site watcher runs: each installed addon's work for sites
 * CloudPanel has just created, in catalog order. Each gets a head start rather
 * than the whole of the one before it, so DNS normally writes first, but DNS
 * waiting on its lock behind a long fleet check does not keep SMTP Relay from
 * binding the site's mail login for minutes. One addon failing does not keep
 * the next from its turn.
 */
export async function runNewSiteWork(installed: AddonSpec[], headStartMs = NEW_SITE_HEAD_START_MS): Promise<void> {
  const running: Promise<void>[] = [];
  for (const spec of addonNewSites(installed)) {
    const task = spec.newSites!;
    const done = (async () => {
      try {
        const line = await task.run();
        if (line) log.ok(`${task.label}: ${line}`);
      } catch (error) {
        log.warn(`${task.label} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
    running.push(done);
    await Promise.race([done, Bun.sleep(headStartMs)]);
  }
  await Promise.all(running);
}

/**
 * Whether any installed addon still waits for a new site, asking each that
 * waits at all. One that fails is taken to be waiting, so it is asked again.
 */
export async function newSitesWaiting(installed: AddonSpec[]): Promise<boolean> {
  let waiting = false;
  for (const spec of addonNewSites(installed)) {
    const task = spec.newSites!;
    if (!task.waiting) continue;
    try {
      const result = await task.waiting();
      if (result.line) log.ok(`${task.label}: ${result.line}`);
      waiting ||= result.waiting;
    } catch (error) {
      log.warn(`${task.label} failed: ${error instanceof Error ? error.message : String(error)}`);
      waiting = true;
    }
  }
  return waiting;
}

/**
 * What the certificate watcher runs: each installed addon's work for a site
 * whose certificate CloudPanel has just written, in catalog order, one after
 * another. It is for work that waits on a site's HTTPS, and is cheap when there
 * is none, since every renewal wakes it too.
 */
export async function runCertificateWork(installed: AddonSpec[]): Promise<void> {
  for (const spec of addonCertificates(installed)) {
    const task = spec.certificates!;
    try {
      const line = await task.run();
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

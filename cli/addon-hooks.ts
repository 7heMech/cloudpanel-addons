// What the platform runs of the addons' declared work, at repair and when its watchers wake.

import { errorMessage } from "../lib/errors";
import { type AddonHook, type AddonSpec } from "../lib/addon-definition";
import { log } from "../lib/log";
/**
 * Run each installed addon's own upkeep, in catalog order. None of it may fail
 * the rest of repair: this is self-healing, not a precondition for anything.
 */
export async function runAddonRepairs(installed: AddonSpec[], options?: Record<string, unknown>): Promise<void> {
  await runHooks(installed.flatMap((spec) => spec.repair ? [spec.repair] : []), options);
}

/** How long one addon's new-site work runs before the next starts beside it. */
const NEW_SITE_HEAD_START_MS = 15_000;

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
  for (const task of installed.flatMap((spec) => spec.newSites ? [spec.newSites] : [])) {
    const done = (async () => {
      try {
        const line = await task.run();
        if (line) log.ok(`${task.label}: ${line}`);
      } catch (error) {
        log.warn(`${task.label} failed: ${errorMessage(error)}`);
      }
    })();
    running.push(done);
    await Promise.race([done, Bun.sleep(headStartMs)]);
  }
  await Promise.all(running);
}

/**
 * Run each installed addon's `resumePending`, and say whether any still waits
 * for a new site. One that fails is taken to be waiting, so it runs again.
 */
export async function resumePendingNewSites(installed: AddonSpec[]): Promise<boolean> {
  let waiting = false;
  for (const task of installed.flatMap((spec) => spec.newSites ? [spec.newSites] : [])) {
    if (!task.resumePending) continue;
    try {
      const result = await task.resumePending();
      if (result.line) log.ok(`${task.label}: ${result.line}`);
      waiting ||= result.waiting;
    } catch (error) {
      log.warn(`${task.label} failed: ${errorMessage(error)}`);
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
  await runHooks(installed.flatMap((spec) => spec.certificates ? [spec.certificates] : []));
}

/** What the firewall watcher runs: each installed addon's work for ufw's rules, in catalog order. */
export async function runFirewallWork(installed: AddonSpec[]): Promise<void> {
  await runHooks(installed.flatMap((spec) => spec.firewall ? [spec.firewall] : []));
}

async function runHooks(tasks: AddonHook[], options?: Record<string, unknown>): Promise<void> {
  for (const task of tasks) {
    try {
      const line = await task.run(options);
      if (line) log.ok(`${task.label}: ${line}`);
    } catch (error) {
      log.warn(`${task.label} failed: ${errorMessage(error)}`);
    }
  }
}

// Putting the CloudPanel side back the way the installed addons need it: the
// Twig anchors, the Nginx proxy and the maintenance check. Install, update,
// repair, uninstall and the manager's own reconcile verb all come through here.

import {
  purgeTwigCache as purgeInjectCache, type Injection, KNOWN_GOOD_PANEL_VERSIONS, type TargetStatus,
  panelVersion, reconcile, reconcileNginxMaintenance, reconcileNginxProxy,
} from "./inject";
import { ensureMaintenanceData } from "../addons/maintenance/action";
import {
  systemTweaksBackupCompression, systemTweaksMotd, systemTweaksPhpMyAdmin,
} from "../addons/system-tweaks/action";
import { TEMPLATES } from "../lib/panel-anchors";
import { adminHeaderTarget, headerTarget, siteLayoutTarget } from "../lib/panel-nav";
import { ADDONS, ADDON_NAMES } from "../addons/catalog";
import { mountPath } from "../lib/paths";
import { log } from "../lib/log";
import { existsSync } from "node:fs";
/**
 * `managerNav` is whether the panel keeps its "Addons" entry.
 *
 * It belongs to the manager, not to any addon, and it used to be derived from
 * "at least one addon is enabled". That was the same thing right up until an
 * addon could be disabled from the page the entry leads to: disabling the last
 * one took the link away, and the only way back to the page that would offer
 * the addons again was to know the URL. The entry now goes when the
 * installation goes, which is `self-uninstall`'s call to make, not this one's.
 */
export function installedInjections(exclude?: string, managerNav = true): Injection[] {
  const injections: Injection[] = [];
  const installed = ADDON_NAMES.filter((name) => name !== exclude && existsSync(ADDONS[name]!.configFile));

  // Kept outside the addon target lists so installing a second addon cannot
  // emit a second style/script block or replace the first one's marker.
  if (managerNav) {
    injections.push({ addon: "manager", target: headerTarget(), url: "/addons/" });
    injections.push({ addon: "manager", target: adminHeaderTarget(), url: "/addons/" });
  }

  // The site tab strip only needs its one-row rule once some installed addon is
  // actually adding a tab to it, and it needs it exactly once however many do.
  if (installed.some((name) => ADDONS[name]!.targets.some((target) => target.template === TEMPLATES.siteTabs))) {
    injections.push({ addon: "manager", target: siteLayoutTarget(), url: "/addons/" });
  }

  for (const name of installed) {
    const spec = ADDONS[name]!;
    for (const target of spec.targets) injections.push({
      addon: name,
      target,
      url: mountPath(name),
    });
  }
  return injections;
}

function describeTarget(status: TargetStatus): string {
  switch (status.state) {
    case "ok": return "patched";
    case "missing-anchor": return "missing; repair will re-inject";
    case "stale-content": return "stale; repair will rewrite it";
    case "template-absent": return "template not found";
    case "anchor-not-found-in-markup": return "anchor markup not found";
    case "upstream-changed": return `upstream changed (${status.found.slice(0, 12)})`;
  }
}

export function reconcileAnchors(quiet: boolean, exclude?: string, managerNav = true): boolean {
  const injections = installedInjections(exclude, managerNav);
  const wanted = new Map(injections.map((injection) => [`${injection.addon}:${injection.target.slug}`, injection]));
  const result = reconcile(injections);
  let blocked = false;
  for (const status of result.statuses) {
    const injection = wanted.get(`${status.addon}:${status.slug}`);
    if (!injection) continue;
    if (status.state === "ok") {
      if (!quiet) log.ok(`${status.addon}/${status.slug} patched`);
      continue;
    }
    if (status.state === "template-absent") {
      if (!quiet) log.warn(`${status.addon}/${status.slug}: ${describeTarget(status)}`);
      // Left non-fatal for repair/update, which run unattended and may catch
      // the panel mid-upgrade while cloudpanel.postinst has the app directory
      // moved aside; the next periodic reconcile heals it. install/enable
      // check this return value and abort, so a target whose template is
      // simply absent on this panel build (wrong path, unsupported version)
      // still surfaces as a failure there instead of a silent no-op.
      if (injection.target.required) blocked = true;
      continue;
    }
    log.err(`${status.addon}/${status.slug}: ${describeTarget(status)}`);
    if (status.state === "upstream-changed" || status.state === "anchor-not-found-in-markup") {
      log.err(`CloudPanel ${panelVersion()} changed the target markup; known good: ${KNOWN_GOOD_PANEL_VERSIONS.join(", ")}`);
    }
    if (injection.target.required) blocked = true;
  }
  if (result.changed) {
    purgeInjectCache();
    if (!quiet) log.ok("Twig cache purged");
  }
  return !blocked;
}

export function reconcileNginx(quiet: boolean, enabled = true): boolean {
  const result = reconcileNginxProxy({ enabled });
  if (result.state === "ok" || (!enabled && result.state === "missing")) {
    if (result.changed && !quiet) log.ok(enabled ? "Nginx proxy injected and verified" : "Nginx proxy removed and verified");
    return true;
  }
  log.err(`Nginx proxy: ${result.detail ?? result.state}`);
  return false;
}

export function reconcileMaintenanceNginx(quiet: boolean, enabled = existsSync(ADDONS.maintenance!.configFile)): boolean {
  if (enabled) ensureMaintenanceData(ADDONS.maintenance!.stateDir);
  const result = reconcileNginxMaintenance({ enabled });
  if (result.state === "ok" || (!enabled && result.state === "missing")) {
    if (result.changed && !quiet) log.ok(enabled ? "Nginx maintenance check injected and verified" : "Nginx maintenance check removed and verified");
    return true;
  }
  log.err(`Nginx maintenance check: ${result.detail ?? result.state}`);
  return false;
}

/** System Tweaks' phpMyAdmin rules, for the fast repair that runs when CloudPanel rewrites its vhost. */
export function reconcilePhpMyAdminRules(quiet: boolean): void {
  if (!existsSync(ADDONS["system-tweaks"]!.configFile)) return;
  try {
    const line = systemTweaksPhpMyAdmin();
    if (line && !quiet) log.ok(line);
  } catch (error) {
    log.err(`phpMyAdmin rules: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** A CloudPanel update replaces the whole app tree, so System Tweaks' backup command edit goes back with the templates. */
export function reconcileBackupCommand(quiet: boolean): void {
  if (!existsSync(ADDONS["system-tweaks"]!.configFile)) return;
  try {
    const line = systemTweaksBackupCompression();
    if (line && !quiet) log.ok(line);
  } catch (error) {
    log.err(`remote backup compression: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** A CloudPanel upgrade empties /etc/update-motd.d and puts its banner back. */
export function reconcileMotd(quiet: boolean): void {
  if (!existsSync(ADDONS["system-tweaks"]!.configFile)) return;
  try {
    const line = systemTweaksMotd();
    if (line && !quiet) log.ok(line);
  } catch (error) {
    log.err(`SSH login message: ${error instanceof Error ? error.message : String(error)}`);
  }
}

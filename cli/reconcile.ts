import {
  purgeTwigCache as purgeInjectCache, type Injection, KNOWN_GOOD_PANEL_VERSIONS, type TargetStatus, panelVersion,
  reconcile, reconcileNginxProxy,
} from "./inject";
import { TEMPLATES } from "../lib/panel-anchors";
import { adminHeaderTarget, headerTarget, siteLayoutTarget } from "../lib/panel-nav";
import { ADDONS, ADDON_NAMES, addonEnabled, enabledAddons } from "../addons/catalog";
import type { AddonSpec } from "../lib/addon-definition";
import { errorMessage } from "../lib/errors";
import { mountPath } from "../lib/mount";
import { log } from "../lib/log";
/**
 * `managerNav` is whether the panel keeps its "Addons" entry. It stays with
 * every addon disabled, since the page it leads to is where they are enabled
 * again, and goes only with `self-uninstall`.
 */
export function installedInjections(exclude?: string, managerNav = true): Injection[] {
  const injections: Injection[] = [];
  const installed = ADDON_NAMES.filter((name) => name !== exclude && addonEnabled(ADDONS[name]!));

  if (managerNav) {
    injections.push({ addon: "manager", target: headerTarget(), url: "/addons/" });
    injections.push({ addon: "manager", target: adminHeaderTarget(), url: "/addons/" });
  }

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
      // Not logged as an error: repair and update run unattended and may catch
      // the panel mid-upgrade while cloudpanel.postinst has the app directory
      // moved aside, and the next periodic reconcile heals it. install and
      // enable abort on the return value, so a template absent on this panel
      // build still fails there.
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

export function reconcilePanelBlocks(quiet: boolean, enabled: (spec: AddonSpec) => boolean = addonEnabled): boolean {
  let ok = true;
  for (const spec of Object.values(ADDONS)) {
    if (spec.panelBlock && !spec.panelBlock.reconcile(enabled(spec), quiet)) ok = false;
  }
  return ok;
}

/** What the enabled addons redo when CloudPanel rewrites a file the anchor watcher sees. */
export async function runAnchorWork(quiet: boolean): Promise<void> {
  for (const spec of enabledAddons()) {
    for (const hook of spec.anchors ?? []) {
      try {
        const line = await hook.run();
        if (line && !quiet) log.ok(line);
      } catch (error) {
        log.err(`${hook.label}: ${errorMessage(error)}`);
      }
    }
  }
}

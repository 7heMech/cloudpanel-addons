import {
  purgeTwigCache as purgeInjectCache, type Injection, type Rebaselined, type TargetStatus, inspectNginxProxy,
  inspectTemplates, reconcile, reconcileNginxProxy,
} from "./inject";
import { TEMPLATES } from "../lib/panel-anchors";
import { adminHeaderTarget, headerTarget, siteLayoutTarget } from "../lib/panel-nav";
import { ADDONS, ADDON_NAMES, addonEnabled, enabledAddons } from "../addons/catalog";
import type { AddonSpec } from "../lib/addon-definition";
import { errorMessage } from "../lib/errors";
import { mountPath } from "../lib/mount";
import { log } from "../lib/log";
import { type PanelHold, holdAdvice, holdSummary, rebaselineNote } from "../lib/panel-holds";
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
    case "panel-updated": return `CloudPanel ${status.installed} replaced it; repair will patch it again`;
    case "upstream-changed": {
      const hold = { file: status.template, addons: [], reason: status.reason, package: "CloudPanel", recorded: status.recorded, installed: status.installed };
      return `left alone: ${holdSummary(hold)} ${holdAdvice(hold)}`;
    }
  }
}

function logRebaselined(rebaselined: Rebaselined[]): void {
  for (const { file, from, to } of rebaselined) log.ok(rebaselineNote(file, "CloudPanel", from, to));
}

/** `accept` is `repair --rebaseline`: a changed template that still fits is taken although CloudPanel was not upgraded. */
export function reconcileAnchors(quiet: boolean, exclude?: string, managerNav = true, accept = false): boolean {
  const injections = installedInjections(exclude, managerNav);
  const wanted = new Map(injections.map((injection) => [`${injection.addon}:${injection.target.slug}`, injection]));
  const result = reconcile(injections, { accept });
  logRebaselined(result.rebaselined);
  let blocked = false;
  // One line per template, not per addon block in it.
  const reported = new Set<string>();
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
    if (injection.target.required) blocked = true;
    if (status.state === "upstream-changed") {
      if (reported.has(status.template)) continue;
      reported.add(status.template);
      // dpkg is still replacing CloudPanel's files; the run after it finishes decides.
      if (status.reason === "busy") {
        if (!quiet) log.warn(`${status.template}: ${describeTarget(status)}`);
      } else log.err(`${status.template}: ${describeTarget(status)}`);
      continue;
    }
    log.err(`${status.addon}/${status.slug}: ${describeTarget(status)}`);
  }
  if (result.changed) {
    purgeInjectCache();
    if (!quiet) log.ok("Twig cache purged");
  }
  return !blocked;
}

export function reconcileNginx(quiet: boolean, enabled = true, accept = false): boolean {
  const result = reconcileNginxProxy({ enabled, accept });
  if (result.rebaselined) {
    log.ok(rebaselineNote(result.vhostPath ?? "the master vhost", "CloudPanel", result.rebaselined.from, result.rebaselined.to));
  }
  if (result.state === "ok" || (!enabled && result.state === "missing")) {
    if (result.changed && !quiet) log.ok(enabled ? "Nginx proxy injected and verified" : "Nginx proxy removed and verified");
    return true;
  }
  log.err(`Nginx proxy: ${result.detail ?? result.state}`);
  return false;
}

export function reconcilePanelBlocks(quiet: boolean, enabled: (spec: AddonSpec) => boolean = addonEnabled, accept = false): boolean {
  let ok = true;
  for (const spec of Object.values(ADDONS)) {
    if (spec.panelBlock && !spec.panelBlock.reconcile(enabled(spec), quiet, accept)) ok = false;
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

const MANAGER_LABEL = "Addons tab";

/** What `clp-addons status` and the Addons page list as left alone after a CloudPanel or Nginx change. */
export function panelHolds(): PanelHold[] {
  const holds: PanelHold[] = [];
  const injections = installedInjections();
  const byTemplate = new Map<string, PanelHold>();
  for (const status of inspectTemplates(injections)) {
    if (status.state !== "upstream-changed") continue;
    const label = status.addon === "manager" ? MANAGER_LABEL : ADDONS[status.addon]?.title ?? status.addon;
    const hold = byTemplate.get(status.template);
    if (hold) {
      if (!hold.addons.includes(label)) hold.addons.push(label);
      continue;
    }
    byTemplate.set(status.template, {
      file: status.template, addons: [label], reason: status.reason, package: "CloudPanel",
      recorded: status.recorded, installed: status.installed,
    });
  }
  holds.push(...byTemplate.values());
  const proxy = inspectNginxProxy();
  if (proxy.refusal) {
    holds.push({ file: proxy.vhostPath ?? "CloudPanel's master vhost", addons: ["Addons page"], package: "CloudPanel", ...proxy.refusal });
  }
  for (const spec of enabledAddons()) {
    const hold = spec.panelBlock?.inspect().hold;
    if (hold) holds.push(hold);
  }
  return holds;
}

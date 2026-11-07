// The entrypoint: argv in, exit code out. Each verb lives in its own module
// and this one only decides which. `auth` and `manager` are dispatched before
// the catalog is consulted, because neither is an addon.
import { dashboardUrl, installedAddons, resolveAddon } from "./addons";
import { reconcileAnchors } from "./reconcile";
import { cmdMenu } from "./menu";
import { cmdStatus } from "./status";
import { cmdInstall } from "./install";
import { cmdAptHook } from "./apt-hook";
import { cmdRepair } from "./repair";
import { applyDisable, applyEnable } from "./toggle";
import { cmdSelfUninstall } from "./uninstall";
import { cmdUpdate } from "./update";
import { ADDONS, ADDON_NAMES } from "../addons/catalog";
import { CLI_VERSION } from "../lib/version";
import { installedConfig } from "./provision";
import { reconcile } from "./inject";
import { fatal, Fatal, log, requireRoot } from "../lib/log";
import {
  LOCKABLE_ADDONS, ROOT_LOCKS_FILE, ROOT_LOCKS_LOCK, UntrustedLockFile, isLockable, lockedAddons, writeLockedAddons,
} from "../lib/root-locks";
import { withOperationLockSync } from "./operation-lock";
import { withFileLockSync } from "../lib/file-lock";
import { runRecon } from "./recon";
import { cmdServe } from "../manager/server";
import { executeMaintenanceAction, type MaintenanceStatus } from "../addons/maintenance/action";
import { runAuthActionStdin } from "./auth-action";
import { runManagerAction, type ManagerOps } from "../manager/action";
import { runSmtpSubmit } from "../addons/smtp/submit";
import { runTerminalPty } from "../addons/terminal/pty";
import { runTerminalRootCommand } from "../addons/terminal/root-access";
import { runCertificateWork, runFirewallWork } from "./addon-hooks";
import { runSyncSites } from "./new-sites";
import { syncVarnishBackends } from "../addons/system-tweaks/varnish-backend";
import { resourceLimitsMemory } from "../addons/resource-limits/memory-settings";
import { systemTweaksPhpPools } from "../addons/system-tweaks/action";

/**
 * The privileged half of the three manager verbs.
 *
 * `update` is `clp-addons update` with no arguments -- the same resolver, the
 * same checksum and provenance verification, the same installer. There is no
 * second download path, which is the point: a button that fetched releases its
 * own way would be a second thing to get right.
 */
export const MANAGER_OPS: ManagerOps = {
  enable: applyEnable,
  disable: applyDisable,
  update: (beforeManagerRestart, onStep, onProgress) => cmdUpdate([], { beforeManagerRestart, onStep, onProgress }),
  // Short: this one answers a live request from the panel, so it refuses and
  // names the operation in the way rather than making the page wait it out.
  reconcile: () => withOperationLockSync("reconcile", () => {
    if (!reconcileAnchors(true)) fatal("could not safely patch the CloudPanel templates");
  }, { timeoutSeconds: 15 }),
};

function usage(): void {
  log.plain(`clp-addons ${CLI_VERSION} — CloudPanel Addons

  clp-addons
  clp-addons enable <addon>...
  clp-addons disable <addon>...
  clp-addons update [--version=vX.Y.Z] [--allow-prerelease] [--skip-attestation]
  clp-addons repair [<addon>] [--quiet] [--anchors-only]
  clp-addons status
  clp-addons maintenance <domain> [on|off|status]
  clp-addons terminal root [allow|deny <user>]
  clp-addons lock [<addon>]
  clp-addons unlock <addon>
  clp-addons self-uninstall --yes
  clp-addons --version

Addons: ${ADDON_NAMES.join(", ")}`);
}

async function cmdAction(argv: string[]): Promise<number> {
  const [addon, ...rest] = argv;
  // Platform verbs, not addon verbs: the auth gateway and the manager are not
  // things an operator can enable, so they are dispatched before the catalog.
  if (addon === "auth") return runAuthActionStdin(rest);
  if (addon === "manager") return runManagerAction(rest, MANAGER_OPS);

  const spec = addon ? ADDONS[addon] : undefined;
  if (!spec?.action) fatal(`unknown action addon '${addon ?? ""}'`);
  if (!installedConfig(spec)) fatal(`the ${spec.name} addon is not installed`);
  return spec.action(rest);
}

/** With no addon, lists the locks; `lock` alone needs no root, as it only reads. */
function cmdLock(argv: string[], lock: boolean): void {
  const [addon, ...extra] = argv;
  if (extra.length || (!lock && !addon)) fatal(`usage: clp-addons ${lock ? "lock [<addon>]" : "unlock <addon>"}`);
  const read = (): string[] => {
    try {
      return lockedAddons();
    } catch (error) {
      if (!(error instanceof UntrustedLockFile)) {
        fatal(`cannot read ${ROOT_LOCKS_FILE}: ${error instanceof Error ? error.message : String(error)}; every lockable addon counts as locked until it can be`);
      }
      fatal(`${error.message}, so every lockable addon counts as locked. ` + (error.directory
        ? "Make it owned by root and not writable by group or others, then run this again"
        : `Note what it locked, remove it with rm ${ROOT_LOCKS_FILE}, then lock those addons again`));
    }
  };
  const locked = read();
  if (!addon) {
    log.plain(locked.length ? `Locked: ${locked.join(", ")}` : "Nothing is locked.");
    log.plain(`Lockable: ${LOCKABLE_ADDONS.join(", ")}`);
    return;
  }
  requireRoot(lock ? "lock" : "unlock");
  // An entry for an addon that no longer declares anything can still be unlocked.
  if (lock && !isLockable(addon)) fatal(`${addon} has nothing to lock; lockable: ${LOCKABLE_ADDONS.join(", ")}`);
  const changed = withFileLockSync(ROOT_LOCKS_LOCK, 15, "another lock or unlock is still running", () => {
    const current = read();
    if (lock === current.includes(addon)) return false;
    writeLockedAddons(lock ? [...current, addon] : current.filter((name) => name !== addon));
    return true;
  });
  if (!changed) {
    log.plain(`${addon} is already ${lock ? "locked" : "unlocked"}`);
    return;
  }
  log.ok(lock
    ? `${addon} is locked: the panel shows its protections but cannot change them or disable the addon`
    : `${addon} is unlocked: administrators can change it from the panel again`);
}

async function cmdMaintenance(argv: string[]): Promise<void> {
  requireRoot("maintenance");
  if (!installedConfig(ADDONS.maintenance!)) fatal("the maintenance addon is not installed");
  const [rawDomain, operation = "status", ...extra] = argv;
  if (!rawDomain || extra.length > 0 || !["on", "off", "status"].includes(operation)) {
    fatal("usage: clp-addons maintenance <domain> [on|off|status]");
  }
  const verb = operation === "on" ? "enable" : operation === "off" ? "disable" : "status";
  try {
    const result = await executeMaintenanceAction([verb, `--domain=${rawDomain}`]) as MaintenanceStatus;
    const global = await executeMaintenanceAction(["global-status"]) as { global: boolean; bypasses: string[] };
    if (operation === "status") {
      const state = result.uncovered ? "live, not covered" : result.enabled ? "maintenance (503)" : global.global ? "maintenance (503, global)" : "live";
      log.plain(`${result.domain}: ${state}`);
      log.plain(`Template: ${result.customTemplate ? "custom" : "default"}`);
      log.plain(`IP bypasses: ${result.bypasses.length ? result.bypasses.join(", ") : "none"}`);
      if (global.bypasses.length) log.plain(`Global IP bypasses: ${global.bypasses.join(", ")}`);
    } else {
      log.ok(`${result.domain}: maintenance mode ${result.enabled ? "enabled" : "disabled"}`);
      if (!result.enabled && global.global && !result.uncovered) log.warn("global maintenance is on, so the site still serves 503");
    }
    if (result.uncovered) log.warn(`Nginx does not run the maintenance check for ${result.domain} (${result.uncovered}), so visitors get the site whatever is set`);
  } catch (error) {
    fatal(error instanceof Error ? error.message : String(error));
  }
}

async function cmdOverview(): Promise<void> {
  log.plain(`CloudPanel Addons v${CLI_VERSION.replace(/^v/, "")}`);
  log.plain(`Dashboard: ${dashboardUrl()}`);
  const specs = installedAddons();
  log.plain(specs.length ? `Enabled: ${specs.map((spec) => spec.name).join(", ")}` : "No addons enabled");
  log.plain("Run 'clp-addons status' for service and integration details.");
}

function addonArgs(verb: string, argv: string[]) {
  if (argv.length === 0 || argv.some((arg) => arg.startsWith("-"))) fatal(`usage: clp-addons ${verb} <addon>...`);
  return [...new Set(argv)].map(resolveAddon);
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    if (process.stdin.isTTY && process.stdout.isTTY && process.getuid?.() === 0) await cmdMenu();
    else await cmdOverview();
    return 0;
  }
  const [verb = "help", ...rest] = args;
  switch (verb) {
    case "overview": await cmdOverview(); return 0;
    case "--version":
    case "-v": log.plain(CLI_VERSION); return 0;
    case "install": await cmdInstall(rest); return 0;
    case "enable":
      for (const spec of addonArgs("enable", rest)) {
        if (installedConfig(spec)) log.ok(`${spec.name} is already enabled`);
        else await applyEnable(spec.name);
      }
      return 0;
    case "disable":
      for (const spec of addonArgs("disable", rest)) applyDisable(spec.name);
      return 0;
    case "update": await cmdUpdate(rest); return 0;
    case "recon": await runRecon(); return 0;
    case "repair": await cmdRepair(rest); return 0;
    case "apt-hook": await cmdAptHook(rest); return 0;
    case "sync-sites":
      requireRoot("sync-sites");
      if (rest.length) fatal("sync-sites takes no arguments");
      await runSyncSites(installedAddons());
      return 0;
    case "sync-certificates":
      requireRoot("sync-certificates");
      if (rest.length) fatal("sync-certificates takes no arguments");
      await runCertificateWork(installedAddons());
      return 0;
    case "sync-firewall":
      requireRoot("sync-firewall");
      if (rest.length) fatal("sync-firewall takes no arguments");
      await runFirewallWork(installedAddons());
      return 0;
    case "sync-varnish": {
      // nginx's unit runs this before it loads the vhosts; its failure does not stop the reload.
      requireRoot("sync-varnish");
      if (rest.length) fatal("sync-varnish takes no arguments");
      const refused = syncVarnishBackends();
      if (refused.length) log.warn(`Varnish server refused, so these sites skip Varnish: ${refused.join(", ")}`);
      return 0;
    }
    case "sync-php-pools": {
      // Every PHP-FPM unit runs this before it starts, and before and after it reloads; its failure does not stop PHP-FPM.
      requireRoot("sync-php-pools");
      if (rest.length > 1 || (rest.length === 1 && rest[0] !== "--before-reload")) fatal("sync-php-pools takes only --before-reload");
      systemTweaksPhpPools({}, rest[0] === "--before-reload");
      return 0;
    }
    case "sync-memory": {
      // MySQL's unit runs this before it starts and Redis's after; its failure does not stop either.
      requireRoot("sync-memory");
      if (rest.length !== 1 || (rest[0] !== "mysql" && rest[0] !== "redis")) fatal("sync-memory takes mysql or redis");
      resourceLimitsMemory(rest[0]);
      return 0;
    }
    case "status": await cmdStatus(); return 0;
    case "maintenance": await cmdMaintenance(rest); return 0;
    case "self-uninstall": cmdSelfUninstall(rest); return 0;
    case "lock": cmdLock(rest, true); return 0;
    case "unlock": cmdLock(rest, false); return 0;
    case "action": return await cmdAction(rest);
    case "smtp-submit": return await runSmtpSubmit(rest);
    case "terminal-pty": return await runTerminalPty(rest);
    case "terminal": runTerminalRootCommand(rest); return 0;
    case "serve": return await cmdServe();
    case "help":
    case "--help":
    case "-h": usage(); return 0;
    default: log.err(`unknown command '${verb}'`); usage(); return 2;
  }
}

if (import.meta.main) {
  try {
    process.exit(await main());
  } catch (error) {
    if (error instanceof Fatal) {
      log.err(error.message);
      process.exit(1);
    }
    throw error;
  }
}

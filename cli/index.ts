import { dashboardUrl, resolveAddon } from "./addons";
import { enabledAddons, ADDONS, ADDON_NAMES, addonEnabled } from "../addons/catalog";
import { panelHolds, reconcileAnchors } from "./reconcile";
import { cmdMenu } from "./menu";
import { cmdStatus } from "./status";
import { cmdInstall } from "./install";
import { cmdAptHook } from "./apt-hook";
import { cmdRepair } from "./repair";
import { applyDisable, applyEnable } from "./toggle";
import { cmdSelfUninstall } from "./uninstall";
import { cmdUpdate } from "./update";
import { CLI_VERSION } from "../lib/version";
import { reconcile } from "./inject";
import { fatal, Fatal, log, requireRoot } from "../lib/log";
import type { AddonSpec } from "../lib/addon-definition";
import { LOCKABLE_ADDONS, isLockable, lockedAddons } from "../lib/root-locks";
import { changeLock, lockFailure, lockFileProblem } from "../lib/lock-addon";
import { withOperationLockSync } from "./operation-lock";
import { runRecon } from "./recon";
import { cmdServe } from "../manager/server";
import { runAuthActionStdin } from "./auth-action";
import { runManagerAction, type ManagerOps } from "../manager/action";
import { runCertificateWork, runFirewallWork } from "./addon-hooks";
import { runSyncSites } from "./new-sites";

/**
 * `update` is `clp-addons update` with no arguments: the same resolver,
 * checksum and provenance verification and installer, so the panel's button
 * has no download path of its own to get right.
 */
const MANAGER_OPS: ManagerOps = {
  enable: applyEnable,
  disable: applyDisable,
  update: (beforeManagerRestart, onStep, onProgress) => cmdUpdate([], { beforeManagerRestart, onStep, onProgress }),
  // Short: this one answers a live request from the panel, so it refuses and
  // names the operation in the way rather than making the page wait it out.
  reconcile: () => withOperationLockSync("reconcile", () => {
    if (!reconcileAnchors(true)) fatal("could not safely patch the CloudPanel templates");
  }, { timeoutSeconds: 15 }),
  holds: panelHolds,
};

function addonUsage(): string {
  return Object.values(ADDONS)
    .flatMap((spec) => Object.values(spec.commands ?? {}).flatMap((command) => command.usage ? [`  clp-addons ${command.usage}`] : []))
    .join("\n");
}

async function runAddonCommand(spec: AddonSpec, name: string, argv: string[]): Promise<number> {
  const command = spec.commands![name]!;
  if (command.root) requireRoot(name);
  if (command.enabledOnly && !addonEnabled(spec)) fatal(`the ${spec.name} addon is not installed`);
  return (await command.run(argv)) ?? 0;
}

function usage(): void {
  log.plain(`clp-addons ${CLI_VERSION} — CloudPanel Addons

  clp-addons
  clp-addons enable <addon>...
  clp-addons disable <addon>...
  clp-addons update [--version=vX.Y.Z] [--allow-prerelease] [--skip-attestation]
  clp-addons repair [<addon>] [--quiet] [--anchors-only] [--rebaseline]
  clp-addons status
${addonUsage()}
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
  if (!addonEnabled(spec)) fatal(`the ${spec.name} addon is not installed`);
  return spec.action(rest);
}

function cmdLock(argv: string[], lock: boolean): void {
  const [addon, ...extra] = argv;
  if (extra.length || (!lock && !addon)) fatal(`usage: clp-addons ${lock ? "lock [<addon>]" : "unlock <addon>"}`);
  let locked: string[];
  try {
    locked = lockedAddons();
  } catch (error) {
    fatal(lockFileProblem(error));
  }
  if (!addon) {
    log.plain(locked.length ? `Locked: ${locked.join(", ")}` : "Nothing is locked.");
    log.plain(`Lockable: ${LOCKABLE_ADDONS.join(", ")}`);
    return;
  }
  requireRoot(lock ? "lock" : "unlock");
  // An entry for an addon that no longer declares anything can still be unlocked.
  if (lock && !isLockable(addon)) fatal(`${addon} has nothing to lock; lockable: ${LOCKABLE_ADDONS.join(", ")}`);
  let changed: boolean;
  try {
    changed = changeLock(addon, lock);
  } catch (error) {
    fatal(lockFailure(error));
  }
  if (!changed) {
    log.plain(`${addon} is already ${lock ? "locked" : "unlocked"}`);
    return;
  }
  log.ok(lock
    ? `${addon} is locked: the panel can switch its protections on, but not off, and cannot disable the addon`
    : `${addon} is unlocked: administrators can change it from the panel again`);
}

async function cmdOverview(): Promise<void> {
  log.plain(`CloudPanel Addons v${CLI_VERSION.replace(/^v/, "")}`);
  log.plain(`Dashboard: ${dashboardUrl()}`);
  const specs = enabledAddons();
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
        if (addonEnabled(spec)) log.ok(`${spec.name} is already enabled`);
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
      await runSyncSites(enabledAddons());
      return 0;
    case "sync-certificates":
      requireRoot("sync-certificates");
      if (rest.length) fatal("sync-certificates takes no arguments");
      await runCertificateWork(enabledAddons());
      return 0;
    case "sync-firewall":
      requireRoot("sync-firewall");
      if (rest.length) fatal("sync-firewall takes no arguments");
      await runFirewallWork(enabledAddons());
      return 0;
    case "status": await cmdStatus(); return 0;
    case "self-uninstall": cmdSelfUninstall(rest); return 0;
    case "lock": cmdLock(rest, true); return 0;
    case "unlock": cmdLock(rest, false); return 0;
    case "action": return await cmdAction(rest);
    case "serve": return await cmdServe();
    case "help":
    case "--help":
    case "-h": usage(); return 0;
    default: {
      const owner = Object.values(ADDONS).find((spec) => spec.commands?.[verb]);
      if (owner) return await runAddonCommand(owner, verb, rest);
      log.err(`unknown command '${verb}'`);
      usage();
      return 2;
    }
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

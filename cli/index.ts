// The entrypoint: argv in, exit code out. Each verb lives in its own module
// and this one only decides which. `auth` and `manager` are dispatched before
// the catalog is consulted, because neither is an addon.
import { dashboardUrl, installedAddons } from "./addons";
import { reconcileAnchors } from "./reconcile";
import { cmdStatus } from "./status";
import { cmdInstall } from "./install";
import { cmdRepair } from "./repair";
import { applyDisable, applyEnable } from "./toggle";
import { cmdUninstall } from "./uninstall";
import { cmdUpdate } from "./update";
import { mountPath } from "./paths";
import { ADDONS, ADDON_NAMES } from "./addon-catalog";
import { CLI_VERSION } from "./release";
import { installedConfig } from "./provision";
import { reconcile } from "./inject";
import { fatal, Fatal, log, requireRoot } from "./util";
import { withOperationLockSync } from "./operation-lock";
import { runRecon } from "./recon";
import { cmdServe } from "../manager/server";
import { executeMaintenanceAction } from "../addons/maintenance/action";
import { runAuthActionStdin } from "./auth-action";
import { runManagerAction, type ManagerOps } from "./manager-action";

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
  update: (beforeManagerRestart) => cmdUpdate([], { beforeManagerRestart }),
  // Short: this one answers a live request from the panel, so it refuses and
  // names the operation in the way rather than making the page wait it out.
  reconcile: () => withOperationLockSync("reconcile", () => {
    if (!reconcileAnchors(true)) fatal("could not safely patch the CloudPanel templates");
  }, { timeoutSeconds: 15 }),
};

function usage(): void {
  log.plain(`clp-addons ${CLI_VERSION} — CloudPanel Addons

  clp-addons install <addon> [--version=vX.Y.Z] [--skip-attestation] [--local=DIR]
  clp-addons update [--version=vX.Y.Z] [--skip-attestation]   (alias: upgrade)
  clp-addons repair [<addon>] [--quiet] [--anchors-only]
  clp-addons status
  clp-addons uninstall <addon> --yes [--purge]
  clp-addons maintenance <domain> [on|off|status]
  clp-addons action cloudflare-ips <list|set|policy|reconcile> [options]
  clp-addons action instatic <verb> [options]
  clp-addons action stager <verb> [options]
  clp-addons action maintenance <verb> --domain=<domain>
  clp-addons action git <verb> [--domain=<domain>] [--job=<job>]
  clp-addons action manager <enable|disable|update|job|watch-job> [--addon=<addon>] [--id=<job>]
  clp-addons action auth (session id on bounded stdin)
  clp-addons serve
  clp-addons --version

Addons: ${ADDON_NAMES.join(", ")}

Install enables bundled addon code without downloading a release. Use update
to upgrade the binary, or install --version to explicitly select a release.

The manager is served at ${mountPath("instatic").replace("/instatic", "")} through
the CloudPanel master vhost and authenticates with the CloudPanel cloudpanel session.`);
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

async function cmdMaintenance(argv: string[]): Promise<void> {
  requireRoot("maintenance");
  if (!installedConfig(ADDONS.maintenance!)) fatal("the maintenance addon is not installed");
  const [rawDomain, operation = "status", ...extra] = argv;
  if (!rawDomain || extra.length > 0 || !["on", "off", "status"].includes(operation)) {
    fatal("usage: clp-addons maintenance <domain> [on|off|status]");
  }
  const verb = operation === "on" ? "enable" : operation === "off" ? "disable" : "status";
  try {
    const result = await executeMaintenanceAction([verb, `--domain=${rawDomain}`]) as {
      domain: string; enabled: boolean; customTemplate: boolean; bypasses: string[];
    };
    if (operation === "status") {
      log.plain(`${result.domain}: ${result.enabled ? "maintenance (503)" : "live"}`);
      log.plain(`Template: ${result.customTemplate ? "custom" : "default"}`);
      log.plain(`IP bypasses: ${result.bypasses.length ? result.bypasses.join(", ") : "none"}`);
    } else {
      log.ok(`${result.domain}: maintenance mode ${result.enabled ? "enabled" : "disabled"}`);
    }
  } catch (error) {
    fatal(error instanceof Error ? error.message : String(error));
  }
}

async function cmdOverview(): Promise<void> {
  log.plain(`CloudPanel Addons v${CLI_VERSION.replace(/^v/, "")}`);
  log.plain(`Dashboard: ${dashboardUrl()}`);
  const specs = installedAddons();
  log.plain(specs.length ? `Installed: ${specs.map((spec) => spec.name).join(", ")}` : "No addons installed");
  log.plain("Run 'clp-addons status' for service and integration details.");
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    await cmdOverview();
    return 0;
  }
  const [verb = "help", ...rest] = args;
  switch (verb) {
    case "overview": await cmdOverview(); return 0;
    case "--version":
    case "-v": log.plain(CLI_VERSION); return 0;
    case "install": await cmdInstall(rest); return 0;
    case "update":
    case "upgrade": await cmdUpdate(rest); return 0;
    case "self-update": fatal("self-update is deprecated; use clp-addons update");
    case "recon": await runRecon(); return 0;
    case "repair": await cmdRepair(rest); return 0;
    case "status": await cmdStatus(); return 0;
    case "maintenance": await cmdMaintenance(rest); return 0;
    case "uninstall": cmdUninstall(rest); return 0;
    case "action": return await cmdAction(rest);
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

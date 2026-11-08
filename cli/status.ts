import { dashboardUrl } from "./addons";
import { enabledAddons, ADDONS, addonEnabled, addonHandler, phpGuardOptedOut } from "../addons/catalog";
import type { AddonSpec } from "../lib/addon-definition";
import { secureRegularFile } from "./artifacts";
import { type NginxProxyStatus, inspect, inspectNginxProxy } from "./inject";
import { CLI_BIN, MANAGER_UNIT, SOCKET_PATH } from "../lib/paths";
import { mountPath } from "../lib/mount";
import { inspectPhpGuard } from "../lib/php-guard";
import { managerSocketProblem, unitPid } from "./provision";
import { unitActive } from "../lib/systemd";
import { installedInjections } from "./reconcile";
import { CLI_VERSION } from "../lib/version";
import { log, paint } from "../lib/log";
function statusValue(value: string, ok: boolean): string {
  return paint(ok ? "32" : "31", value);
}

function nginxStatus(status: NginxProxyStatus): string {
  if (status.state === "ok") return statusValue("VHost Injected & Verified ✓", true);
  return statusValue(status.detail ?? "Needs repair", false);
}

function panelBlockStatus(spec: AddonSpec): string {
  if (!addonEnabled(spec)) return "Not enabled";
  const { ok, text } = spec.panelBlock!.inspect();
  return statusValue(text, ok);
}

function phpGuardStatus(): string {
  const { guarded, unguarded, optedOut } = inspectPhpGuard({ optedOut: phpGuardOptedOut() });
  if (guarded.length === 0 && unguarded.length === 0) return "No PHP-FPM found";
  if (optedOut) return statusValue("off in System Tweaks", false);
  if (unguarded.length === 0) return statusValue(`upload_progress Off on ${guarded.join(", ")} ✓`, true);
  return statusValue(`missing on ${unguarded.join(", ")}; run repair`, false);
}

function anchorStatus(): string {
  const statuses = installedInjections().map((injection) => inspect(injection));
  if (statuses.length === 0) return "Not configured";
  const required = statuses.filter((status) => {
    if (status.addon === "manager") return true;
    const spec = ADDONS[status.addon];
    return spec?.targets.find((target) => target.slug === status.slug)?.required;
  });
  return required.every((status) => status.state === "ok")
    ? statusValue("Twig Templates Patched ✓", true)
    : statusValue("Needs repair", false);
}

function socketStatus(): string {
  const problem = managerSocketProblem();
  return statusValue(`UNIX Socket (${SOCKET_PATH}) — ${problem ?? "ready"}`, problem === null);
}

export async function cmdStatus(): Promise<void> {
  const specs = enabledAddons();
  const managerState = unitActive(MANAGER_UNIT);
  const active = managerState === "active";
  const pid = unitPid(MANAGER_UNIT);
  const line = "─".repeat(64);

  log.plain(` CloudPanel Addons  v${CLI_VERSION.replace(/^v/, "")}`);
  log.plain(line);
  log.plain(" Status");
  log.plain(`   • Manager unit ${statusValue(managerState, active)}`);
  log.plain(`   • Manager PID  ${statusValue(pid ?? "not available", active && pid !== null)}`);
  log.plain(`   • Socket       ${socketStatus()}`);
  log.plain(`   • Nginx       ${nginxStatus(inspectNginxProxy())}`);
  for (const spec of Object.values(ADDONS).filter((item) => item.panelBlock)) {
    log.plain(`   • ${spec.panelBlock!.label.padEnd(11)} ${panelBlockStatus(spec)}`);
  }
  log.plain(`   • Anchors     ${anchorStatus()}`);
  log.plain(`   • PHP guard   ${phpGuardStatus()}`);
  log.plain();
  log.plain(" Installed Addons");
  log.plain("   NAME       ROUTE              ACTION        STATE");
  if (specs.length === 0) log.plain("   (none)");
  for (const spec of specs) {
    const action = secureRegularFile(CLI_BIN, true) ? "Verified ✓" : "Missing";
    const mounted = addonHandler(spec.name) !== undefined;
    const ready = active && mounted && action !== "Missing";
    const state = !mounted ? "not mounted" : action === "Missing" ? "action missing" : ready ? "ready" : "manager inactive";
    log.plain(`   ${spec.name.padEnd(10)} ${mountPath(spec.name).padEnd(18)} ${action.padEnd(13)} ${statusValue(state, ready)}`);
  }
  log.plain();
  log.plain(` Dashboard URL: ${dashboardUrl()}`);
  log.plain(line);
}

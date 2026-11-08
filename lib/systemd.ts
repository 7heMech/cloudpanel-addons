import { requireSuccess, tryRun, type CommandResult } from "./command";

/** What `systemctl is-active` says of a unit, or "unknown". */
export function unitActive(unit: string): string {
  return tryRun("systemctl", ["is-active", unit]).out || "unknown";
}

/** Have systemd read its unit files again; a failure fails the action with what systemctl said. */
export function daemonReload(run: (command: string, args: string[]) => CommandResult): void {
  requireSuccess(run("systemctl", ["daemon-reload"]), "systemctl daemon-reload failed");
}

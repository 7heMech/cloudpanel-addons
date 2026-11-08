import { requireSuccess, tryRun, type CommandResult } from "./command";

export function unitActive(unit: string): string {
  return tryRun("systemctl", ["is-active", unit]).out || "unknown";
}

export function daemonReload(run: (command: string, args: string[]) => CommandResult): void {
  requireSuccess(run("systemctl", ["daemon-reload"]), "systemctl daemon-reload failed");
}

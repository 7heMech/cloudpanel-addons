import { tryRun } from "./command";

/** What `systemctl is-active` says of a unit, or "unknown". */
export function unitActive(unit: string): string {
  return tryRun("systemctl", ["is-active", unit]).out || "unknown";
}

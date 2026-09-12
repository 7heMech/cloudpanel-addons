// App side of decision 2.7.
// Consumers query the root gateway daemon over UNIX socket for real-time
// panel state (CloudPanel sites, allocated ports, and active listeners)
// without periodic snapshot staleness or unnecessary disk writes.

import { callGatewayPanelInfo, type GatewayClientOptions } from "./gateway-client";
import {
  type SanitizedSite,
  type PanelSnapshot,
  type PanelInfo,
} from "./gateway-protocol";

// Decision 2.11: a reserved block well clear of where CloudPanel hands out
// app ports, so a collision needs someone to deliberately type one of these
// into the panel.
export const PORT_RANGE = { min: 39000, max: 39999 } as const;

export type { SanitizedSite, PanelSnapshot, PanelInfo };

/**
 * Fetch current panel sites and occupied ports through the gateway client.
 *
 * Throws when the gateway or its local root fallback reports a failure.
 */
export async function fetchPanelInfo(
  options?: GatewayClientOptions,
): Promise<PanelSnapshot> {
  const result = await callGatewayPanelInfo(options);
  if (result.ok && result.data) {
    return result.data;
  }
  throw new Error(result.error ?? "failed to fetch real-time panel info from gateway");
}

// Age of the panel data in seconds. For real-time gateway data this is 0.
export function snapshotAgeSeconds(snap: PanelSnapshot): number {
  return Math.max(0, Math.round((Date.now() - new Date(snap.updatedAt).getTime()) / 1000));
}

/**
 * Return the lowest port in the snapshot's range that is not already occupied.
 *
 * `alsoTaken` supplies additional reservations that the caller must exclude.
 * Throws when every port in the range is occupied.
 */
export function getNextAvailablePort(
  snap: PanelSnapshot,
  alsoTaken: Iterable<number> = []
): number {
  const taken = new Set([...snap.allocatedPorts, ...alsoTaken]);
  const { min, max } = snap.portRange ?? PORT_RANGE;
  for (let p = min; p <= max; p++) {
    if (!taken.has(p)) return p;
  }
  throw new Error(`no free port in the reserved range ${min}-${max}`);
}

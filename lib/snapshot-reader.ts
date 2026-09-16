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
 * Returns current panel data from the gateway client.
 *
 * @throws If the gateway request fails or returns no panel data.
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
  const taken = new Date(snap.updatedAt).getTime();
  // An unreadable timestamp is not a fresh one. Math.round(NaN) is NaN and
  // `NaN > threshold` is false, so every caller comparing against a staleness
  // threshold would have read an unparseable snapshot as current.
  if (Number.isNaN(taken)) return Infinity;
  // A snapshot from the future is a clock disagreement, not stale data.
  return Math.max(0, Math.round((Date.now() - taken) / 1000));
}

/**
 * Read current panel information and say how old it was when it arrived.
 *
 * Stager and Instatic each had this as a `snapshot()` method on their service,
 * byte for byte. What the age *means* is not shared -- how stale is too stale,
 * and what a missing site implies, are each addon's question -- so only the
 * read and the arithmetic moved.
 */
export async function readPanelSnapshot(): Promise<{ snap: PanelSnapshot; ageSeconds: number }> {
  const snap = await fetchPanelInfo();
  return { snap, ageSeconds: snapshotAgeSeconds(snap) };
}

/**
 * Returns the lowest port in the snapshot's reserved range that is absent from
 * both its allocations and `alsoTaken`.
 *
 * @throws If every port in the reserved range is taken.
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

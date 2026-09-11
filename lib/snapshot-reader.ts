// App side of decision 2.7.
// Consumers query the root gateway daemon over UNIX socket for real-time
// panel state (CloudPanel sites, allocated ports, and active listeners)
// without 15-minute snapshot staleness.

import { existsSync, readFileSync } from "node:fs";
import { callGatewayPanelInfo, type GatewayClientOptions } from "./gateway-client";
import {
  type SanitizedSite,
  type PanelSnapshot,
  type PanelInfo,
} from "./gateway-protocol";

export const SNAPSHOT_FILE = "/var/lib/clp-addons/snapshot.json";

// Decision 2.11: a reserved block well clear of where CloudPanel hands out
// app ports, so a collision needs someone to deliberately type one of these
// into the panel.
export const PORT_RANGE = { min: 39000, max: 39999 } as const;

export type { SanitizedSite, PanelSnapshot, PanelInfo };

/**
 * Fetch live panel data directly from the root gateway over UNIX domain socket.
 * If the gateway is not reachable, falls back to a snapshot file if present on disk.
 */
export async function fetchPanelInfo(
  options?: GatewayClientOptions,
): Promise<PanelSnapshot> {
  const result = await callGatewayPanelInfo(options);
  if (result.ok && result.data) {
    return result.data;
  }
  if (existsSync(SNAPSHOT_FILE)) {
    try {
      return JSON.parse(readFileSync(SNAPSHOT_FILE, "utf-8")) as PanelSnapshot;
    } catch {}
  }
  if (!result.ok) {
    throw new Error(result.error ?? "failed to fetch real-time panel info from gateway");
  }
  return {
    updatedAt: new Date().toISOString(),
    portRange: PORT_RANGE,
    allocatedPorts: [],
    sites: [],
  };
}

/**
 * Legacy synchronous reader for backwards compatibility where SNAPSHOT_FILE exists.
 */
export function readSnapshot(): PanelSnapshot {
  if (!existsSync(SNAPSHOT_FILE)) {
    throw new Error(
      `panel snapshot missing at ${SNAPSHOT_FILE}; run 'clp-addons repair' as root to regenerate it`
    );
  }
  return JSON.parse(readFileSync(SNAPSHOT_FILE, "utf-8")) as PanelSnapshot;
}

// Age of the panel data in seconds. For real-time gateway data this is 0.
export function snapshotAgeSeconds(snap: PanelSnapshot): number {
  return Math.max(0, Math.round((Date.now() - new Date(snap.updatedAt).getTime()) / 1000));
}

/**
 * The lowest free port in the reserved range.
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

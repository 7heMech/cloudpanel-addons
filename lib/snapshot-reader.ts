import { callGatewayPanelInfo, type GatewayClientOptions } from "./gateway-client";
import {
  type SanitizedSite,
  type PanelSnapshot,
  type PanelInfo,
} from "./gateway-protocol";

// A reserved block well clear of where CloudPanel hands out app ports, so a
// collision needs someone to deliberately type one of these into the panel.
export const PORT_RANGE = { min: 39000, max: 39999 } as const;

export type { SanitizedSite, PanelSnapshot, PanelInfo };

export async function fetchPanelInfo(
  options?: GatewayClientOptions,
): Promise<PanelSnapshot> {
  const result = await callGatewayPanelInfo(options);
  if (result.ok && result.data) {
    return result.data;
  }
  throw new Error(result.error ?? "failed to fetch real-time panel info from gateway");
}

export function snapshotAgeSeconds(snap: PanelSnapshot): number {
  const taken = new Date(snap.updatedAt).getTime();
  // NaN would compare as fresh against every staleness threshold.
  if (Number.isNaN(taken)) return Infinity;
  // A snapshot from the future is a clock disagreement, not stale data.
  return Math.max(0, Math.round((Date.now() - taken) / 1000));
}

export async function readPanelSnapshot(): Promise<{ snap: PanelSnapshot; ageSeconds: number }> {
  const snap = await fetchPanelInfo();
  return { snap, ageSeconds: snapshotAgeSeconds(snap) };
}

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

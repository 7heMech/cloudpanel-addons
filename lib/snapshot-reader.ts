// App side of decision 2.7. Reads the sanitized snapshot and nothing else:
// no panel database, no /home/clp, no shelling out. Kept in its own file so
// that "the app cannot read the panel database" is visible in the imports
// rather than being a convention someone has to remember.

import { existsSync, readFileSync } from "node:fs";

export const SNAPSHOT_FILE = "/var/lib/clp-addons/snapshot.json";

// Decision 2.11: a reserved block well clear of where CloudPanel hands out
// app ports, so a collision needs someone to deliberately type one of these
// into the panel.
export const PORT_RANGE = { min: 39000, max: 39999 } as const;

export interface SanitizedSite {
  domain: string;
  user: string;
  type: string;
}

export interface PanelSnapshot {
  updatedAt: string;
  portRange: { min: number; max: number };
  allocatedPorts: number[];
  sites: SanitizedSite[];
}

export function readSnapshot(): PanelSnapshot {
  if (!existsSync(SNAPSHOT_FILE)) {
    throw new Error(
      `panel snapshot missing at ${SNAPSHOT_FILE}; run 'clp-addons repair' as root to regenerate it`
    );
  }
  return JSON.parse(readFileSync(SNAPSHOT_FILE, "utf-8")) as PanelSnapshot;
}

// Age of the snapshot, for surfacing staleness in the UI instead of silently
// allocating against a stale port list.
export function snapshotAgeSeconds(snap: PanelSnapshot): number {
  return Math.max(0, Math.round((Date.now() - new Date(snap.updatedAt).getTime()) / 1000));
}

export function getNextAvailablePort(snap: PanelSnapshot = readSnapshot()): number {
  const taken = new Set(snap.allocatedPorts);
  const { min, max } = snap.portRange ?? PORT_RANGE;
  for (let p = min; p <= max; p++) {
    if (!taken.has(p)) return p;
  }
  throw new Error(`no free port in the reserved range ${min}-${max}`);
}

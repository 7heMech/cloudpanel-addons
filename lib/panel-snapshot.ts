// Privileged side of decision 2.7.
//
// The port-collision check needs the panel's site list, but the panel database
// also holds password hashes and site credentials, and the app's site user
// cannot read /home/clp at all. So this runs as root, reads non-secret columns
// only, and writes a sanitized JSON snapshot that the app consumes. The app
// must never import this file.

import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADDONS, PANEL_DB } from "../cli/paths";
import { writeAtomic } from "../cli/util";
import { PORT_RANGE, SNAPSHOT_FILE, type PanelSnapshot, type SanitizedSite } from "./snapshot-reader";

type SiteRow = {
  domain_name: string | number | null;
  user: string | number | null;
  type: string | number | null;
};

type ValueRow = { value: string | number | null };

export interface PanelDatabaseSnapshot {
  allocatedPorts: number[];
  sites: SanitizedSite[];
}

function emptyPanelDatabaseSnapshot(): PanelDatabaseSnapshot {
  return { allocatedPorts: [], sites: [] };
}

function queryRows<ReturnType>(db: Database, sql: string): ReturnType[] {
  try {
    return db.query<ReturnType, []>(sql).all();
  } catch {
    // A table that does not exist on this CloudPanel version contributes no data.
    return [];
  }
}

function asText(value: string | number | null): string {
  return value === null ? "" : String(value);
}

function addPort(ports: Set<number>, raw: string | number | null): void {
  const n = Number.parseInt(asText(raw).trim(), 10);
  if (Number.isInteger(n) && n > 0 && n < 65536) ports.add(n);
}

interface IsolatedDatabase {
  db: Database;
  directory: string;
}

function openIsolatedDatabase(databasePath: string): IsolatedDatabase | null {
  let directory: string | undefined;
  try {
    directory = mkdtempSync(join(tmpdir(), "clp-panel-db-"));
    const isolatedPath = join(directory, "panel.sqlite");
    copyFileSync(databasePath, isolatedPath);

    // A WAL database's committed state can be split across all three files.
    // Open only the copy so Bun cannot create sidecars beside the panel DB.
    for (const suffix of ["-wal", "-shm"] as const) {
      const sidecar = `${databasePath}${suffix}`;
      if (existsSync(sidecar)) copyFileSync(sidecar, `${isolatedPath}${suffix}`);
    }

    return { db: new Database(isolatedPath, { readonly: true }), directory };
  } catch {
    if (directory) rmSync(directory, { recursive: true, force: true });
    return null;
  }
}

export function readPanelDatabase(databasePath = PANEL_DB): PanelDatabaseSnapshot {
  if (!existsSync(databasePath)) return emptyPanelDatabaseSnapshot();

  const isolated = openIsolatedDatabase(databasePath);
  if (!isolated) return emptyPanelDatabaseSnapshot();

  const ports = new Set<number>();
  const sites: SanitizedSite[] = [];
  try {
    for (const row of queryRows<SiteRow>(isolated.db, "SELECT domain_name, user, type FROM site;")) {
      const domain = asText(row.domain_name);
      if (domain) sites.push({ domain, user: asText(row.user), type: asText(row.type) });
    }

    for (const row of queryRows<ValueRow>(
      isolated.db,
      "SELECT pool_port AS value FROM php_settings WHERE pool_port IS NOT NULL;",
    )) addPort(ports, row.value);
    for (const row of queryRows<ValueRow>(
      isolated.db,
      "SELECT port AS value FROM nodejs_settings WHERE port IS NOT NULL;",
    )) addPort(ports, row.value);
    for (const row of queryRows<ValueRow>(
      isolated.db,
      "SELECT port AS value FROM python_settings WHERE port IS NOT NULL;",
    )) addPort(ports, row.value);

    for (const row of queryRows<ValueRow>(
      isolated.db,
      "SELECT reverse_proxy_url AS value FROM site WHERE reverse_proxy_url IS NOT NULL AND reverse_proxy_url != '';",
    )) {
      const m = asText(row.value).match(/:(\d{2,5})(?:\/|$)/);
      if (m) addPort(ports, m[1] ?? null);
    }
  } finally {
    isolated.db.close();
    rmSync(isolated.directory, { recursive: true, force: true });
  }

  return { allocatedPorts: [...ports].sort((a, b) => a - b), sites };
}

export function generateSnapshot(): PanelSnapshot {
  if (process.getuid && process.getuid() !== 0) {
    throw new Error("generateSnapshot must run as root; the app reads the snapshot file instead");
  }

  const panel = readPanelDatabase();
  const ports = new Set<number>(panel.allocatedPorts);
  const sites = panel.sites;

  // Ports the addons have already handed out, which the panel does not know
  // about. Every installed addon, not one hardcoded directory: the `ss` scan
  // below catches another addon's *running* instances, so a hardcoded path left
  // exactly the case this loop exists for -- a stopped instance, whose port is
  // still spoken for but is not listening -- invisible to the allocator.
  for (const spec of Object.values(ADDONS)) {
    if (!existsSync(spec.stateDir)) continue;
    for (const entry of readdirSync(spec.stateDir)) {
      const meta = `${spec.stateDir}/${entry}/meta.json`;
      if (!existsSync(meta)) continue;
      try {
        addPort(ports, String(JSON.parse(readFileSync(meta, "utf-8")).port));
      } catch {
        // A half-written meta file should not abort the whole snapshot.
      }
    }
  }

  // Anything currently listening, whoever owns it.
  try {
    const ss = execFileSync("ss", ["-tlnH"], { encoding: "utf-8" });
    for (const m of ss.matchAll(/:(\d{2,5})\s/g)) addPort(ports, m[1] ?? null);
  } catch {
    // ss absent is survivable; the database and disk scans still apply.
  }

  const snapshot: PanelSnapshot = {
    updatedAt: new Date().toISOString(),
    portRange: PORT_RANGE,
    allocatedPorts: [...ports].sort((a, b) => a - b),
    sites,
  };

  // 0640 because the site list is customer data: the app's group may read it,
  // nobody else. writeAtomic's temp name carries the pid, which matters here --
  // a manual repair and the timer can run at the same moment, and a shared
  // fixed name lets one publish the other's half-written file.
  writeAtomic(SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2), 0o640);

  return snapshot;
}

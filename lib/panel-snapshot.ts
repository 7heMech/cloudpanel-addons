// Privileged side of decision 2.7.
//
// The port-collision check needs the panel's site list, but the panel database
// also holds password hashes and site credentials, and the app's site user
// cannot read /home/clp at all. So the root gateway daemon queries the panel
// database directly in real time, reads non-secret columns only, and returns
// sanitized data over the UNIX domain socket without writing disk snapshots.
// The app must never import this file.

import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADDONS, PANEL_CACHE_POOL_DIR, PANEL_DB } from "../cli/paths";
import { PORT_RANGE, type PanelSnapshot, type SanitizedSite } from "./snapshot-reader";

const SQLITE_BUSY_TIMEOUT_MS = 5_000;

type SiteRow = {
  domain_name: string | number | null;
  user: string | number | null;
  type: string | number | null;
  varnish_cache: string | number | null;
};

type ValueRow = { value: string | number | null };

export interface PanelDatabaseSnapshot {
  allocatedPorts: number[];
  sites: SanitizedSite[];
}

function emptyPanelDatabaseSnapshot(): PanelDatabaseSnapshot {
  return { allocatedPorts: [], sites: [] };
}

const CACHE_SCAN_MAX_FILES = 512;
const CACHE_ITEM_MAX_BYTES = 8 * 1024;

/**
 * The address CloudPanel prints in its own site information, read from the
 * panel's cache rather than resolved here.
 *
 * CloudPanel asks an external service for the instance's public IPv4 and caches
 * the answer for an hour; there is no column for it. A site-scoped addon page
 * reproduces the panel's site information, and the only honest value to print
 * there is the one the panel is currently serving from that cache. Anything
 * this function cannot read or that has expired returns "", and the caller
 * leaves the field out rather than showing an address the panel would not.
 */
export function readPanelPublicIp(poolDir = PANEL_CACHE_POOL_DIR): string {
  let budget = CACHE_SCAN_MAX_FILES;
  const walk = (directory: string): string => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return "";
    }
    for (const entry of entries) {
      if (budget <= 0) return "";
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        const nested = walk(full);
        if (nested) return nested;
        continue;
      }
      if (!entry.isFile()) continue;
      budget--;
      let raw: string;
      try {
        if (statSync(full).size > CACHE_ITEM_MAX_BYTES) continue;
        raw = readFileSync(full, "latin1");
      } catch {
        continue;
      }
      // Symfony's filesystem pool writes the expiry, then the item key, then
      // the serialized value, one per line.
      const [expiry, key, ...rest] = raw.split("\n");
      if (key !== "ipv4_public_ip") continue;
      const expiresAt = Number.parseInt(expiry ?? "", 10);
      if (!Number.isInteger(expiresAt) || (expiresAt !== 0 && expiresAt * 1000 < Date.now())) return "";
      for (const [, value] of rest.join("\n").matchAll(/s:\d+:"([^"]*)"/g)) {
        if (value && isIP(value)) return value;
      }
      return "";
    }
    return "";
  };
  return walk(poolDir);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

function databaseExists(databasePath: string): boolean {
  try {
    statSync(databasePath);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw new Error(`cannot inspect panel database ${databasePath}: ${errorMessage(error)}`, { cause: error });
  }
}

/**
 * Runs a panel query, treating an absent optional table as empty while wrapping
 * every other query failure with table context.
 */
function queryRows<ReturnType>(db: Database, sql: string, table: string, optional = false): ReturnType[] {
  try {
    return db.query<ReturnType, []>(sql).all();
  } catch (error) {
    const message = errorMessage(error);
    if (optional && (message === `no such table: ${table}` || message === `no such table: main.${table}`)) {
      // These tables vary between CloudPanel versions; an absent optional table contributes no data.
      return [];
    }
    const requiredness = optional ? "optional" : "required";
    throw new Error(`cannot read ${requiredness} panel table ${table}: ${message}`, { cause: error });
  }
}

/**
 * The site list, with Varnish capability when this CloudPanel version records
 * it. The column arrived with Varnish support, so a panel without it reports no
 * Varnish sites rather than failing the whole snapshot the port allocator needs.
 */
function siteRowsWithVarnish(db: Database): SiteRow[] {
  try {
    return queryRows<SiteRow>(db, "SELECT domain_name, user, type, varnish_cache FROM site;", "site");
  } catch (error) {
    if (!/no such column: varnish_cache/.test(errorMessage(error))) throw error;
    return queryRows<SiteRow>(db, "SELECT domain_name, user, type, 0 AS varnish_cache FROM site;", "site");
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

function removeTemporaryDirectory(directory: string | undefined): void {
  if (directory) rmSync(directory, { recursive: true, force: true });
}

function closeDatabase(db: Database | undefined): void {
  if (!db) return;
  try {
    db.close();
  } catch {
    // The useful failure is the snapshot/open error; cleanup remains best effort.
  }
}

function openConsistentSnapshot(databasePath: string): IsolatedDatabase {
  let directory: string | undefined;
  let source: Database | undefined;
  let snapshot: Database | undefined;
  try {
    directory = mkdtempSync(join(tmpdir(), "clp-panel-db-"));
    const snapshotPath = join(directory, "panel.sqlite");

    // VACUUM INTO asks SQLite for one consistent view of the live database and
    // folds any committed WAL pages into the new file. The source connection is
    // read-only, so this cannot create or modify the panel database's sidecars.
    source = new Database(databasePath, { readonly: true });
    source.query(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`).run();
    source.query("VACUUM INTO ?").run(snapshotPath);
    source.close();
    source = undefined;

    snapshot = new Database(snapshotPath, { readonly: true });
    const integrity = snapshot.query<{ integrity_check: string }, []>("PRAGMA integrity_check;").get();
    if (integrity?.integrity_check !== "ok") {
      throw new Error(`SQLite integrity check failed: ${integrity?.integrity_check ?? "no result"}`);
    }

    const result = snapshot;
    snapshot = undefined;
    return { db: result, directory };
  } catch (error) {
    closeDatabase(snapshot);
    closeDatabase(source);
    removeTemporaryDirectory(directory);
    throw new Error(`unable to create panel database snapshot ${databasePath}: ${errorMessage(error)}`, {
      cause: error,
    });
  }
}

export function readPanelDatabase(databasePath = PANEL_DB): PanelDatabaseSnapshot {
  if (!databaseExists(databasePath)) return emptyPanelDatabaseSnapshot();

  const isolated = openConsistentSnapshot(databasePath);

  const ports = new Set<number>();
  const sites: SanitizedSite[] = [];
  try {
    for (const row of siteRowsWithVarnish(isolated.db)) {
      const domain = asText(row.domain_name);
      if (domain) {
        sites.push({
          domain,
          user: asText(row.user),
          type: asText(row.type),
          varnishCache: Boolean(Number(row.varnish_cache)),
        });
      }
    }

    for (const row of queryRows<ValueRow>(
      isolated.db,
      "SELECT pool_port AS value FROM php_settings WHERE pool_port IS NOT NULL;",
      "php_settings",
      true,
    )) addPort(ports, row.value);
    for (const row of queryRows<ValueRow>(
      isolated.db,
      "SELECT port AS value FROM nodejs_settings WHERE port IS NOT NULL;",
      "nodejs_settings",
      true,
    )) addPort(ports, row.value);
    for (const row of queryRows<ValueRow>(
      isolated.db,
      "SELECT port AS value FROM python_settings WHERE port IS NOT NULL;",
      "python_settings",
      true,
    )) addPort(ports, row.value);

    for (const row of queryRows<ValueRow>(
      isolated.db,
      "SELECT reverse_proxy_url AS value FROM site WHERE reverse_proxy_url IS NOT NULL AND reverse_proxy_url != '';",
      "site",
    )) {
      const m = asText(row.value).match(/:(\d{2,5})(?:\/|$)/);
      if (m) addPort(ports, m[1] ?? null);
    }
  } finally {
    closeDatabase(isolated.db);
    removeTemporaryDirectory(isolated.directory);
  }

  return { allocatedPorts: [...ports].sort((a, b) => a - b), sites };
}

/**
 * Returns sanitized panel state from a consistent database copy, addon metadata,
 * and active TCP listeners.
 *
 * Unreadable addon metadata and unavailable listener inspection contribute no
 * ports. Reading the default panel database requires root privileges.
 *
 * @throws If the caller is not root when using the default database, or the
 * panel database cannot be inspected, copied, or queried.
 */
export function getLivePanelInfo(databasePath = PANEL_DB): PanelSnapshot {
  if (process.getuid && process.getuid() !== 0 && databasePath === PANEL_DB) {
    throw new Error("getLivePanelInfo must run as root; consumers query the root gateway daemon instead");
  }

  const panel = readPanelDatabase(databasePath);
  const ports = new Set<number>(panel.allocatedPorts);
  const sites = panel.sites;

  // Ports the addons have already handed out, which the panel does not know
  // about. Every installed addon, not one hardcoded directory: the `ss` scan
  // below catches another addon's *running* instances, so a hardcoded path left
  // exactly the case this loop exists for -- a stopped instance, whose port is
  // still spoken for but is not listening -- invisible to the allocator.
  for (const spec of Object.values(ADDONS)) {
    if (!existsSync(spec.stateDir)) continue;
    try {
      for (const entry of readdirSync(spec.stateDir)) {
        const meta = `${spec.stateDir}/${entry}/meta.json`;
        if (!existsSync(meta)) continue;
        try {
          addPort(ports, String(JSON.parse(readFileSync(meta, "utf-8")).port));
        } catch {
          // A half-written meta file should not abort the whole snapshot.
        }
      }
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue;
      throw new Error(`cannot read addon state directory ${spec.stateDir}: ${errorMessage(error)}`, { cause: error });
    }
  }

  // Anything currently listening, whoever owns it.
  try {
    const ss = execFileSync("ss", ["-tlnH"], { encoding: "utf-8" });
    for (const m of ss.matchAll(/:(\d{2,5})\s/g)) addPort(ports, m[1] ?? null);
  } catch {
    // ss absent is survivable; the database and disk scans still apply.
  }

  const publicIp = readPanelPublicIp();
  return {
    updatedAt: new Date().toISOString(),
    portRange: PORT_RANGE,
    allocatedPorts: [...ports].sort((a, b) => a - b),
    sites,
    ...(publicIp ? { publicIp } : {}),
  };
}

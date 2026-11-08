import { errorMessage } from "./errors";
import { Database } from "bun:sqlite";
import { failAction } from "./action";
import { readable } from "./files";
import { standInDomains } from "./stand-ins";

export function withPanelDb<T>(path: string, read: (db: Database) => T): T {
  if (!readable(path)) throw new Error("panel database is not readable");
  const db = new Database(path, { readonly: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000;");
    return read(db);
  } finally {
    db.close();
  }
}

export function openPanelDatabase(path: string, readOnly = false, busyTimeoutMs = 5000): Database {
  try {
    const db = new Database(path, { create: false, ...(readOnly ? { readonly: true } : { readwrite: true }) });
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs};`);
    return db;
  } catch (error) {
    failAction(`CloudPanel database could not be opened: ${errorMessage(error)}`);
  }
}

export function hasSite(db: Database, domain: string): boolean {
  return db.query("SELECT 1 FROM site WHERE domain_name = ? LIMIT 1;").get(domain) != null;
}

/** Site rows less DNS's stand-ins, which hold a domain for a site that is not there yet. */
export function withoutStandIns<T extends { domain_name?: unknown }>(rows: T[], standIns = standInDomains()): T[] {
  return rows.filter((row) => !standIns.has(String(row.domain_name)));
}
/**
 * Which of `domains` CloudPanel no longer has, for upkeep that removes what a
 * deleted site left behind. None when the panel database cannot be read or
 * lists no site at all: an outage or a half-restored panel must never read as
 * every site having been deleted.
 */
export function deletedSites(panelDb: string, domains: string[]): string[] {
  let present: Set<string>;
  try {
    const db = new Database(panelDb, { readonly: true });
    try {
      db.exec("PRAGMA busy_timeout = 5000;");
      present = new Set(db.query<{ domain_name: unknown }, []>("SELECT domain_name FROM site").all()
        .flatMap((row) => typeof row.domain_name === "string" ? [row.domain_name.toLowerCase()] : []));
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
  if (present.size === 0) return [];
  return domains.filter((domain) => !present.has(domain.toLowerCase()));
}

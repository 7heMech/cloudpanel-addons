// Reading CloudPanel's own SQLite database. Every caller asks its own question
// of it; what is shared is how it is opened and that DNS's stand-ins, rows
// CloudPanel lists but no operator made, are not taken for sites.
import { Database } from "bun:sqlite";
import { failAction, readable } from "./action-common";
import { standInDomains } from "./stand-ins";

/**
 * Read the panel database: opened read-only, waiting out the panel's own
 * writes, and closed afterwards. Throws when it cannot be read; what that
 * means is the caller's to decide.
 */
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

/**
 * The panel database held open, for a caller that reads it across several
 * steps or writes to it, and closes it itself. Failing to open it fails the action.
 */
export function openPanelDatabase(path: string, readOnly = false, busyTimeoutMs = 5000): Database {
  try {
    const db = new Database(path, { create: false, ...(readOnly ? { readonly: true } : { readwrite: true }) });
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs};`);
    return db;
  } catch (error) {
    failAction(`CloudPanel database could not be opened: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Whether CloudPanel has a site of exactly this domain name. */
export function hasSite(db: Database, domain: string): boolean {
  return db.query("SELECT 1 FROM site WHERE domain_name = ? LIMIT 1;").get(domain) != null;
}

/** Site rows less DNS's stand-ins, which hold a domain for a site that is not there yet. */
export function withoutStandIns<T extends { domain_name?: unknown }>(rows: T[], standIns = standInDomains()): T[] {
  return rows.filter((row) => !standIns.has(String(row.domain_name)));
}

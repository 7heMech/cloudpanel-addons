/**
 * Which CloudPanel sites are DNS's stand-ins: static sites that only serve a
 * redirect while DNS has no Cloudflare connection. They are redirects, not
 * sites, so every addon's site list leaves them out.
 */
import { Database } from "bun:sqlite";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { PANEL_DB, STATE_DIR } from "./paths";

export const STAND_INS_FILE = `${STATE_DIR}/dns/standins.json`;

/** How DNS's record of a stand-in names its site: the user it chose, and CloudPanel's id once the site exists. */
export interface StandInMark {
  siteUser?: string;
  siteId?: number;
}

/**
 * Whether the panel site is the one DNS made. A site added later at the same
 * domain, after the stand-in was deleted in CloudPanel, has another id.
 */
export function isStandInSite(mark: StandInMark | undefined, site: { id: number; user?: string }): boolean {
  return mark?.siteUser !== undefined && mark.siteUser === site.user && (mark.siteId === undefined || mark.siteId === site.id);
}

function readMarks(file: string, rootUid: number): Record<string, StandInMark> {
  try {
    if (!existsSync(file)) return {};
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.uid !== rootUid || (stat.mode & 0o022) !== 0) return {};
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, StandInMark>;
  } catch {
    return {};
  }
}

/** The stand-ins' domains; none when DNS has made none, or the record is not root's own. */
export function standInDomains(file = STAND_INS_FILE, rootUid = 0, panelDb = PANEL_DB): Set<string> {
  const marks = readMarks(file, rootUid);
  if (Object.keys(marks).length === 0) return new Set();
  try {
    const db = new Database(panelDb, { readonly: true });
    try {
      const rows = db.query<{ id: number; domain_name: string; user: string }, []>("SELECT id, domain_name, user FROM site").all();
      return new Set(rows.filter((row) => isStandInSite(marks[row.domain_name], { id: Number(row.id), user: row.user })).map((row) => row.domain_name));
    } finally {
      db.close();
    }
  } catch {
    return new Set(Object.keys(marks));
  }
}

import type { Database } from "bun:sqlite";

/**
 * Which of CloudPanel's own sites a panel user may be shown.
 *
 * Two addons need this: the WordPress sign-in, to refuse a site that is not the
 * caller's, and Panel Tweaks, to answer its injected script with the same list
 * the panel's own page drew. Both ask CloudPanel rather than deciding for
 * themselves, so a change to who owns what is made in one place -- the panel --
 * and neither addon can be more generous than the page the operator is looking
 * at.
 *
 * `null` means the account may be shown nothing: it does not exist, it is
 * deactivated, or its role is one this does not know. Status is part of the
 * answer because a session outlives the status change that should have ended
 * it.
 */
export type PanelUserSites = "all" | Set<string> | null;

/** CloudPanel's own user names, as its Add User form limits them. */
export const PANEL_USER_NAME_RE = /^[A-Za-z0-9._@-]{1,64}$/;

export function panelUserSites(db: Database, userName: string): PanelUserSites {
  const account = db.query<{ role: string | null; status: number | null }, [string]>(
    "SELECT role, status FROM user WHERE user_name = ?",
  ).get(userName);
  if (!account || Number(account.status) !== 1) return null;
  // The two roles CloudPanel's own SiteManager::getUserSites does not narrow.
  if (account.role === "ROLE_ADMIN" || account.role === "ROLE_SITE_MANAGER") return "all";
  if (account.role !== "ROLE_USER") return null;
  const rows = db.query<{ domain_name: string }, [string]>(
    `SELECT site.domain_name FROM user_sites
       JOIN user ON user.id = user_sites.user_id
       JOIN site ON site.id = user_sites.site_id
      WHERE user.user_name = ?;`,
  ).all(userName);
  return new Set(rows.map((row) => row.domain_name));
}

/** Whether that user may act on one named site. */
export function panelUserOwnsSite(db: Database, userName: string, domain: string): boolean {
  const sites = panelUserSites(db, userName);
  return sites === "all" || (sites !== null && sites.has(domain));
}

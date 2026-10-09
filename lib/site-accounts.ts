import { readFileSync } from "node:fs";

/**
 * Which Unix accounts behind CloudPanel's sites an addon may act as.
 *
 * SMTP binds mail to a site's uid and Terminal starts a shell as its user, and
 * both refuse the same accounts: one the box itself logs in as, one whose
 * entry is malformed, and one whose uid another site shares, since acting as
 * that uid would be acting as both sites.
 */

/** Logins that belong to the box rather than to a site, whatever the panel's database says. */
export const TRUSTED_LOGINS = ["root", "postfix", "clp"];

/** The user names CloudPanel gives a site. */
export const SITE_USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;

export interface UnixAccount {
  uid: number;
  gid: number;
  home: string;
  shell: string;
}

/** Every account in a passwd file, by name. Lines that do not parse are left out. */
export function readUnixAccounts(passwd = "/etc/passwd"): Map<string, UnixAccount> {
  const accounts = new Map<string, UnixAccount>();
  for (const line of readFileSync(passwd, "utf8").split("\n")) {
    const [name, , uid, gid, , home, shell] = line.split(":");
    if (!name || uid === undefined || gid === undefined || !/^\d+$/.test(uid) || !/^\d+$/.test(gid)) continue;
    accounts.set(name, { uid: Number(uid), gid: Number(gid), home: home ?? "", shell: shell ?? "" });
  }
  return accounts;
}

/** Why a site's account cannot be acted as, or null when it can. */
export function siteAccountProblem(site: { user: string; uid: number; gid: number }): string | null {
  if (!SITE_USER_RE.test(site.user) || TRUSTED_LOGINS.includes(site.user)) return `its Unix user ${site.user} cannot be used`;
  if (!Number.isInteger(site.uid) || site.uid < 1 || !Number.isInteger(site.gid) || site.gid < 0) return "its Unix account is invalid";
  return null;
}

/** Splits sites by whether their uid is theirs alone. */
export function splitSharedUids<T extends { uid: number }>(sites: T[]): { unique: T[]; shared: T[] } {
  const counts = new Map<number, number>();
  for (const site of sites) counts.set(site.uid, (counts.get(site.uid) ?? 0) + 1);
  return {
    unique: sites.filter((site) => counts.get(site.uid) === 1),
    shared: sites.filter((site) => counts.get(site.uid)! > 1),
  };
}

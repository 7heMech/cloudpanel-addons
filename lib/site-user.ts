import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { parse as parseDomain } from "tldts";
import { failAction } from "./action";
import { runCommand } from "./command";
import { readable } from "./files";

function domainStem(domain: string): string {
  return domain.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8);
}

function domainHash(domain: string): string {
  return createHash("sha256").update(domain.toLowerCase()).digest("hex").slice(0, 6);
}

export function siteUserFor(domain: string): string {
  return `addon-${domainStem(domain)}-${domainHash(domain)}`;
}

/**
 * The site user CloudPanel's own New Site page would suggest: the registrable
 * label, then any subdomain labels in the order they appear, hyphen-joined.
 * `the.staging.renaissancechurch.com` becomes `renaissancechurch-the-staging`,
 * which is what the panel wrote for that site on this project's staging box.
 *
 * Matching the panel keeps names recognizable beside sites it named itself.
 *
 * The name is not unique on its own -- two domains differing only in their TLD
 * produce the same one, and CloudPanel refuses a duplicate with "siteUser: This
 * value already exists" -- so a caller creating a site picks through
 * `availableSiteUser`.
 */
export function panelSiteUserFor(domain: string): string {
  const labels = domain.toLowerCase().replace(/\.+$/, "").split(".")
    .map((label) => label.replace(/[^a-z0-9-]/g, ""))
    .filter((label) => label.length > 0);
  const parsed = parseDomain(labels.join("."), { allowPrivateDomains: true });
  const suffix = parsed.publicSuffix ? parsed.publicSuffix.split(".").length : 1;
  // Slice the original labels so unlisted suffixes also keep every subdomain.
  // A hostname without a resolvable suffix uses its last label as the suffix;
  // a bare hostname is itself.
  const named = labels.length > suffix ? labels.slice(0, -suffix) : labels;
  const registrable = named[named.length - 1] ?? "";
  // The panel treats a bare www as noise rather than as a subdomain worth naming.
  const subdomains = named.slice(0, -1);
  const parts = subdomains.length === 1 && subdomains[0] === "www" ? [] : subdomains;
  return clampSiteUser([registrable, ...parts].join("-"));
}

/** A Linux account name: starts with a letter, at most 32 characters. */
function clampSiteUser(name: string): string {
  const prefixed = /^[a-z]/.test(name) ? name : `s${name}`;
  return prefixed.slice(0, 32).replace(/-+$/, "");
}

/**
 * Whether a site user is spoken for, asked of both things that can refuse it.
 *
 * `createUser` fails if the account exists, and CloudPanel validates the site
 * row separately -- it answers "siteUser: This value already exists" for a name
 * another site holds. The two sets are not the same: an account can exist
 * without a site (a system account, or one left by a half-finished delete), and
 * a row can name an account someone removed by hand.
 */
export function siteUserTaken(user: string, panelDb: string): boolean {
  if (runCommand("getent", ["passwd", user]).ok) return true;
  if (!readable(panelDb)) return false;
  try {
    const db = new Database(panelDb, { readonly: true });
    try {
      return db.query("SELECT 1 FROM site WHERE user = ? LIMIT 1;").get(user) != null;
    } finally {
      db.close();
    }
  } catch {
    // Unreadable here means the create is about to fail for a better reason.
    return false;
  }
}

/**
 * The panel-style name, or the first free variation of it. CloudPanel enforces
 * one site per site user, so the caller supplies the question "is this account
 * taken" and this answers with one that is not.
 */
export function availableSiteUser(domain: string, taken: (user: string) => boolean): string {
  const base = panelSiteUserFor(domain);
  if (!taken(base)) return base;
  // The digits a person would add in the panel, with room kept for them.
  for (let n = 2; n <= 99; n++) {
    const suffix = `-${n}`;
    const candidate = clampSiteUser(base.slice(0, 32 - suffix.length)) + suffix;
    if (!taken(candidate)) return candidate;
  }
  failAction(`could not find a free site user for ${domain}; ${base} and 98 variations of it are taken`);
}

export function dbNameFor(domain: string): string {
  return `stg${domainStem(domain)}${domainHash(domain)}`;
}

export function dbUserFor(domain: string): string {
  return `u${domainStem(domain)}${domainHash(domain)}`;
}

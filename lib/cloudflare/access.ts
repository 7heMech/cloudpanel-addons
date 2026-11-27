/**
 * What a Cloudflare token holds, from its own policies, decided without
 * calling Cloudflare again.
 * https://developers.cloudflare.com/fundamentals/api/how-to/create-via-api/
 */
import {
  listedPermissions, PERMISSIONS, type PermissionDef, type PermissionName, type PermissionScopeOptions, type ZoneProfileShape,
} from "./tokens";

/** `"*"` for any. A user resource has neither an account nor a zone. */
export interface Resource {
  account: string;
  zone: string;
  user?: true;
}

export interface Grant {
  allow: boolean;
  /** Permission group names. */
  permissions: string[];
  resources: Resource[];
  /** Some of its resources are in a form not understood, so what it grants or takes away there is not known. */
  unknown?: true;
}

export type Held = "yes" | "no" | "some";

export interface Coverage {
  held: Held;
  /** Up to a few of the zones or accounts it lacks, by name. */
  lacking?: string[];
  lackingCount?: number;
}

export type TokenOwner = { owner: "user" | "account"; accountId: string | null };

export type TokenAccess = TokenOwner & (
  | { readable: true; grants: Grant[]; coverage: Partial<Record<PermissionName, Coverage>>; reach: string }
  /** `transient` when Cloudflare could not be asked, rather than refused or misunderstood; the last read stands. */
  | { readable: false; reason: string; transient?: true }
);

const ACCOUNT = "com.cloudflare.api.account.";
const ZONE = "com.cloudflare.api.account.zone.";
const USER = "com.cloudflare.api.user.";
const LACKING_SHOWN = 3;

/**
 * Cloudflare's resource map, flat or one level nested under an account. An
 * account resource also covers its zones: zones sit under their account.
 * `unknown` is set when a key or value is not one of these forms.
 */
export function parseResources(value: unknown): { resources: Resource[]; unknown: boolean } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { resources: [], unknown: true };
  const resources: Resource[] = [];
  let unknown = false;
  for (const [key, inner] of Object.entries(value)) {
    if (key.startsWith(ZONE) && inner === "*") {
      resources.push({ account: "*", zone: key.slice(ZONE.length) });
    } else if (key.startsWith(ACCOUNT) && !key.startsWith(ZONE) && inner === "*") {
      resources.push({ account: key.slice(ACCOUNT.length), zone: "*" });
    } else if (key.startsWith(ACCOUNT) && !key.startsWith(ZONE) && inner && typeof inner === "object" && !Array.isArray(inner)) {
      for (const [zoneKey, zoneValue] of Object.entries(inner)) {
        if (zoneKey.startsWith(ZONE) && zoneValue === "*") resources.push({ account: key.slice(ACCOUNT.length), zone: zoneKey.slice(ZONE.length) });
        else unknown = true;
      }
    } else if (key.startsWith(USER) && inner === "*") {
      resources.push({ account: "", zone: "", user: true });
    } else {
      unknown = true;
    }
  }
  return { resources, unknown };
}

const namesPermission = (grant: Grant, permission: PermissionDef) => grant.permissions.some((name) => permission.grantedBy.includes(name));
const matches = (pattern: string, value: string) => pattern === "*" || pattern === value;

type Target = { accountId: string; zoneId?: string } | "user";

function covers(resource: Resource, target: Target): boolean {
  if (target === "user") return Boolean(resource.user);
  if (resource.user || !matches(resource.account, target.accountId)) return false;
  return target.zoneId ? matches(resource.zone, target.zoneId) : resource.zone === "*";
}

/** A deny policy wins over an allow, as Cloudflare evaluates them. */
export function grants(list: Grant[], permission: PermissionDef, target: Target): boolean {
  const relevant = list.filter((grant) => namesPermission(grant, permission) && grant.resources.some((resource) => covers(resource, target)));
  return relevant.some((grant) => grant.allow) && !relevant.some((grant) => !grant.allow);
}

/**
 * Whether a policy on resources not understood could change `held`: an allow
 * could add what reads as missing, a deny take away what reads as held.
 */
export function uncertain(list: Grant[], permission: PermissionDef, held: Held): boolean {
  const odd = list.filter((grant) => grant.unknown && namesPermission(grant, permission));
  return odd.some((grant) => grant.allow ? held !== "yes" : held !== "no");
}

/** What a permission is checked against for a zone: the zone, its account, or the token's owner (an account-owned token's account). */
export function targetFor(permission: PermissionDef, zone: { id: string; accountId: string }, owner: TokenOwner): Target {
  if (permission.scope === "user") return owner.owner === "account" && owner.accountId ? { accountId: owner.accountId } : "user";
  return permission.scope === "account" ? { accountId: zone.accountId } : { accountId: zone.accountId, zoneId: zone.id };
}

/** No Cloudflare ID, so only a wildcard grant covers it: a zone or account the token may reach later. */
const ANY = "-";

export interface Reached {
  zones: { id: string; name: string; accountId: string }[];
  accounts: { id: string; name: string }[];
}

function coverageOf(list: Grant[], permission: PermissionDef, reached: Reached): Coverage {
  const targets = permission.scope === "zone"
    ? reached.zones.map((zone) => ({ name: zone.name, target: { accountId: zone.accountId, zoneId: zone.id } }))
    : permission.scope === "account"
      ? reached.accounts.map((account) => ({ name: account.name || account.id, target: { accountId: account.id } }))
      : [];
  // Nothing reached to check against: only a grant on every zone or account, with no deny anywhere, holds it.
  if (!targets.length) {
    const every = grants(list, permission, permission.scope === "zone" ? { accountId: ANY, zoneId: ANY } : { accountId: ANY });
    return { held: every && !list.some((grant) => !grant.allow && namesPermission(grant, permission)) ? "yes" : "no" };
  }
  const lacking = targets.filter(({ target }) => !grants(list, permission, target)).map(({ name }) => name).sort();
  if (!lacking.length) return { held: "yes" };
  if (lacking.length === targets.length) return { held: "no" };
  return { held: "some", lacking: lacking.slice(0, LACKING_SHOWN), lackingCount: lacking.length };
}

const ZONE_REACH_GROUPS = ["DNS Write", "DNS Read", "Zone Read", "SSL and Certificates Write"];

/** "All zones", "All zones in Agency", "3 chosen zones", from where DNS Write (or a zone read for Firewall-only tokens) is allowed, less where that same permission is denied. */
function reachOf(list: Grant[], reached: Reached): string {
  const names = new Map(reached.accounts.map((account) => [account.id, account.name || account.id]));
  const describe = (resources: Resource[], all: string): string[] => {
    if (resources.some((resource) => resource.account === "*" && resource.zone === "*")) return [all];
    const accounts = [...new Set(resources.filter((resource) => resource.zone === "*").map((resource) => resource.account))];
    const zones = new Set(resources.filter((resource) => resource.zone !== "*" && !accounts.includes(resource.account)).map((resource) => resource.zone));
    return [
      accounts.length ? `${all} in ${accounts.map((id) => names.get(id) ?? "another account").join(", ")}` : "",
      zones.size ? `${zones.size} ${all === "All zones" ? "chosen " : ""}zone${zones.size === 1 ? "" : "s"}` : "",
    ].filter(Boolean);
  };
  // One permission, the first allowed of these, so a deny of another permission does not narrow it.
  const reach = ZONE_REACH_GROUPS.find((name) => list.some((grant) => grant.allow && grant.permissions.includes(name)));
  if (!reach) return "No zones";
  const resources = (allow: boolean) => list
    .filter((grant) => grant.allow === allow && grant.permissions.includes(reach))
    .flatMap((grant) => grant.resources).filter((resource) => !resource.user);
  const allows = resources(true);
  const allowed = describe(allows, "All zones").join(" and ");
  if (!allowed) return "No zones";
  // A deny on a zone whose account is not known is assumed to overlap.
  const accountOf = new Map(reached.zones.map((zone) => [zone.id, zone.accountId]));
  const account = (resource: Resource) => resource.account === "*" && resource.zone !== "*" ? accountOf.get(resource.zone) ?? "*" : resource.account;
  const overlaps = (a: Resource, b: Resource) => matches(account(a), account(b)) || matches(account(b), account(a))
    ? matches(a.zone, b.zone) || matches(b.zone, a.zone) : false;
  const denied = describe(resources(false).filter((deny) => allows.some((allow) => overlaps(allow, deny))), "the zones").join(" and ");
  return denied ? `${allowed}, except ${denied === "the zones" ? "all" : denied}` : allowed;
}

/** A permission a policy on resources not understood could change is left out: the page shows it as not known. */
export function readAccess(owner: TokenOwner, list: Grant[], reached: Reached): TokenAccess {
  const coverage: Partial<Record<PermissionName, Coverage>> = {};
  for (const [name, permission] of Object.entries(PERMISSIONS) as [PermissionName, PermissionDef][]) {
    const found = permission.scope === "user" ? { held: "yes" as const } : coverageOf(list, permission, reached);
    if (!uncertain(list, permission, found.held)) coverage[name] = found;
  }
  return { ...owner, readable: true, grants: list, coverage, reach: reachOf(list, reached) };
}

/** The permission a token needs to read itself: account-owned tokens read at their account. */
export function selfReadPermission(owner: TokenOwner["owner"]): string {
  return owner === "account" ? "Account API Tokens: Read" : PERMISSIONS.tokens.label;
}

/** Where the token is edited: Cloudflare has no address for one token, so its owner's token list. */
export function tokenListUrl(owner: TokenOwner): string {
  return owner.owner === "account" && owner.accountId
    ? `https://dash.cloudflare.com/${owner.accountId}/api-tokens`
    : "https://dash.cloudflare.com/profile/api-tokens";
}

/** What a connection's token holds against what the caller uses, as the page shows it. */
export interface AccessView {
  /** The zones its permissions reach; null when the token could not read them, with why in `note`. */
  reach: string | null;
  note: string | null;
  editUrl: string;
  rows: { label: string; usedFor: string; held: Held | "unknown"; detail?: string; optional?: true }[];
}

/** A connection's last check as status.json keeps it: its own read, and what Cloudflare refused it. */
export interface StoredAccess {
  token?: TokenAccess;
  refused?: string[];
}

const REFUSED = "Refused by Cloudflare";

export function accessView(
  stored: StoredAccess,
  profiles: ZoneProfileShape[] = [],
  options: PermissionScopeOptions = {},
): AccessView | null {
  const { token } = stored;
  if (!token) return null;
  const refused = new Set(stored.refused ?? []);
  const rows = listedPermissions(profiles, options).map(({ name, permission, usedFor, optional }): AccessView["rows"][number] => {
    // An account-owned token reads itself with the account's own permission.
    const base = { label: name === "tokens" ? selfReadPermission(token.owner) : permission.label, usedFor, ...(optional ? { optional: true as const } : {}) };
    const coverage = token.readable ? token.coverage[name] : undefined;
    // What Cloudflare refused wins over what the policies say, and is all that is known without them.
    if (refused.has(permission.label) && coverage?.held !== "no" && coverage?.held !== "some") return { ...base, held: "no", detail: REFUSED };
    if (!coverage) return { ...base, held: "unknown" };
    const more = (coverage.lackingCount ?? 0) - (coverage.lacking?.length ?? 0);
    const detail = coverage.held === "some" && coverage.lacking
      ? `Not on ${coverage.lacking.join(", ")}${more > 0 ? ` and ${more} more` : ""}` : undefined;
    return { ...base, held: coverage.held, ...(detail ? { detail } : {}) };
  });
  return { reach: token.readable ? token.reach : null, note: token.readable ? null : token.reason, editUrl: tokenListUrl(token), rows };
}

/**
 * For the Setup checklist: whether the token could read its own permissions,
 * and the required ones it is missing on any zone, by name. Without its own
 * read, the missing ones are those Cloudflare refused it.
 */
export function connectionPermissions(
  stored: StoredAccess,
  profiles: ZoneProfileShape[] = [],
  options: PermissionScopeOptions = {},
): { readable: boolean; missing: string[] } {
  const view = accessView(stored, profiles, options);
  if (!view) return { readable: false, missing: [] };
  return {
    readable: view.reach !== null,
    missing: view.rows.filter((row) => !row.optional && (row.held === "no" || row.held === "some")).map((row) => row.label),
  };
}

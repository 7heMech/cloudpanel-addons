/**
 * What a Cloudflare token holds, from its own policies, decided without
 * calling Cloudflare again.
 * https://developers.cloudflare.com/fundamentals/api/how-to/create-via-api/
 */
import { PERMISSIONS, type PermissionDef, type PermissionName } from "./token";

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
  | { readable: false; reason: string }
);

const ACCOUNT = "com.cloudflare.api.account.";
const ZONE = "com.cloudflare.api.account.zone.";
const USER = "com.cloudflare.api.user.";
const LACKING_SHOWN = 3;

/**
 * Cloudflare's resource map, flat or one level nested under an account. An
 * account resource also covers its zones: zones sit under their account.
 */
export function parseResources(value: unknown): Resource[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const resources: Resource[] = [];
  for (const [key, inner] of Object.entries(value)) {
    if (key.startsWith(ZONE)) {
      if (inner === "*") resources.push({ account: "*", zone: key.slice(ZONE.length) });
    } else if (key.startsWith(ACCOUNT)) {
      const account = key.slice(ACCOUNT.length);
      if (inner === "*") resources.push({ account, zone: "*" });
      else if (inner && typeof inner === "object" && !Array.isArray(inner)) {
        for (const [zoneKey, zoneValue] of Object.entries(inner)) {
          if (zoneKey.startsWith(ZONE) && zoneValue === "*") resources.push({ account, zone: zoneKey.slice(ZONE.length) });
        }
      }
    } else if (key.startsWith(USER) && inner === "*") {
      resources.push({ account: "", zone: "", user: true });
    }
  }
  return resources;
}

const namesPermission = (grant: Grant, permission: PermissionDef) => grant.permissions.some((name) => permission.grantedBy.includes(name));
const matches = (pattern: string, value: string) => pattern === "*" || pattern === value;

function covers(resource: Resource, target: { accountId: string; zoneId?: string } | "user"): boolean {
  if (target === "user") return Boolean(resource.user);
  if (resource.user || !matches(resource.account, target.accountId)) return false;
  return target.zoneId ? matches(resource.zone, target.zoneId) : resource.zone === "*";
}

/** A deny policy wins over an allow, as Cloudflare evaluates them. */
export function grants(list: Grant[], permission: PermissionDef, target: { accountId: string; zoneId?: string } | "user"): boolean {
  const relevant = list.filter((grant) => namesPermission(grant, permission) && grant.resources.some((resource) => covers(resource, target)));
  return relevant.some((grant) => grant.allow) && !relevant.some((grant) => !grant.allow);
}

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
  // Nothing reached to check against: whether any policy names it at all.
  if (!targets.length) return { held: list.some((grant) => grant.allow && namesPermission(grant, permission)) ? "yes" : "no" };
  const lacking = targets.filter(({ target }) => !grants(list, permission, target)).map(({ name }) => name).sort();
  if (!lacking.length) return { held: "yes" };
  if (lacking.length === targets.length) return { held: "no" };
  return { held: "some", lacking: lacking.slice(0, LACKING_SHOWN), lackingCount: lacking.length };
}

/** "All zones", "All zones in Agency", "3 chosen zones", from what DNS: Edit was given on. */
function reachOf(list: Grant[], reached: Reached): string {
  const dns = list.filter((grant) => grant.allow && namesPermission(grant, PERMISSIONS.dns));
  const resources = (dns.length ? dns : list.filter((grant) => grant.allow)).flatMap((grant) => grant.resources).filter((resource) => !resource.user);
  if (resources.some((resource) => resource.account === "*" && resource.zone === "*")) return "All zones";
  const names = new Map(reached.accounts.map((account) => [account.id, account.name || account.id]));
  const accounts = [...new Set(resources.filter((resource) => resource.zone === "*").map((resource) => resource.account))];
  const zones = new Set(resources.filter((resource) => resource.zone !== "*" && !accounts.includes(resource.account)).map((resource) => resource.zone));
  const parts = [
    accounts.length ? `All zones in ${accounts.map((id) => names.get(id) ?? "another account").join(", ")}` : "",
    zones.size ? `${zones.size} chosen zone${zones.size === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  return parts.join(" and ") || "No zones";
}

export function readAccess(owner: TokenOwner, list: Grant[], reached: Reached): TokenAccess {
  const coverage: Partial<Record<PermissionName, Coverage>> = {};
  for (const [name, permission] of Object.entries(PERMISSIONS) as [PermissionName, PermissionDef][]) {
    coverage[name] = permission.scope === "user" ? { held: "yes" } : coverageOf(list, permission, reached);
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

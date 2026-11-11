/**
 * The Cloudflare permissions DNS knows: the dashboard's name, the API's names
 * that grant it, and what DNS uses it for. Cloudflare's token-template URL
 * takes `key`/`type`; `config_settings`, `zone_waf`, `dynamic_redirect` and
 * `firewall_services` are missing from the documented keys but are the
 * dashboard's own. The form drops a key it does not know, so the page lists
 * every permission as well.
 * https://developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/
 * https://developers.cloudflare.com/fundamentals/api/reference/permissions/
 */
import type { Profile } from "./model";

export interface TokenTemplate {
  url: string;
  permissions: string[];
}

export interface PermissionDef {
  key: string;
  type: "read" | "edit";
  label: string;
  /** Permission group names, as a token's own policies name them, that grant it. */
  grantedBy: string[];
  /** What it is checked against: each zone the token reaches, each account, or the token's owner. */
  scope: "zone" | "account" | "user";
  /** What uses it, given the profiles; null when nothing does. */
  usedFor: (profiles: Profile[]) => string | null;
}

/** Quoted, since a profile's own name may hold "and". */
const named = (profiles: Profile[], uses: (profile: Profile) => boolean): string | null => {
  const names = profiles.filter(uses).map((profile) => `“${profile.name}”`);
  return names.length ? names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : null;
};

const always = (text: string) => () => text;

/**
 * In the order the page lists them. Zone: Edit and Single Redirect are asked
 * for before a profile creates zones or a redirect domain exists, so either
 * works later with the token already pasted.
 */
export const PERMISSIONS = {
  dns: { key: "dns", type: "edit", label: "DNS: Edit", grantedBy: ["DNS Write"], scope: "zone", usedFor: always("Every profile's records") },
  zone: { key: "zone", type: "edit", label: "Zone: Edit", grantedBy: ["Zone Write"], scope: "account", usedFor: always("Creating zones for new sites") },
  accounts: {
    key: "account_settings", type: "read", label: "Account Settings: Read", grantedBy: ["Account Settings Read", "Account Settings Write"],
    scope: "account", usedFor: always("Listing the accounts new zones go in"),
  },
  redirects: {
    key: "dynamic_redirect", type: "edit", label: "Single Redirect: Edit", grantedBy: ["Dynamic URL Redirects Write", "Single Redirect Write"],
    scope: "zone", usedFor: always("Redirect domains"),
  },
  zoneSettings: {
    key: "zone_settings", type: "edit", label: "Zone Settings: Edit", grantedBy: ["Zone Settings Write"], scope: "zone",
    usedFor: (profiles) => {
      const names = named(profiles, (profile) => profile.zone.ssl !== null || profile.zone.alwaysHttps !== null);
      return names && `SSL mode and Always HTTPS in ${names}`;
    },
  },
  configRules: {
    key: "config_settings", type: "edit", label: "Config Rules: Edit", grantedBy: ["Config Settings Write"], scope: "zone",
    usedFor: (profiles) => {
      const names = named(profiles, (profile) => profile.zone.acmeFullSsl || profile.zone.webmailFullSsl);
      return names && `Full SSL rules in ${names}`;
    },
  },
  waf: {
    key: "zone_waf", type: "edit", label: "Zone WAF: Edit", grantedBy: ["Zone WAF Write"], scope: "zone",
    usedFor: (profiles) => {
      const names = named(profiles, (profile) => profile.zone.skipFirewallIps.length > 0);
      return names && `Firewall skip in ${names}`;
    },
  },
  /** Zone-scoped IP Access rules (`/zones/{id}/firewall/access_rules/rules`); nothing in DNS uses it yet. */
  ipAccessRules: {
    key: "firewall_services", type: "edit", label: "Firewall Services: Edit", grantedBy: ["Firewall Services Write"], scope: "zone", usedFor: () => null,
  },
  tokens: {
    key: "api_tokens", type: "read", label: "API Tokens: Read",
    grantedBy: ["API Tokens Read", "API Tokens Write", "Account API Tokens Read", "Account API Tokens Write"],
    scope: "user", usedFor: always("Showing these permissions"),
  },
} satisfies Record<string, PermissionDef>;

export type PermissionName = keyof typeof PERMISSIONS;

/** What the profiles use, in the page's order. */
export function neededPermissions(profiles: Profile[]): { name: PermissionName; permission: PermissionDef; usedFor: string }[] {
  return (Object.entries(PERMISSIONS) as [PermissionName, PermissionDef][]).flatMap(([name, permission]) => {
    const usedFor = permission.usedFor(profiles);
    return usedFor ? [{ name, permission, usedFor }] : [];
  });
}

export function tokenTemplate(profiles: Profile[]): TokenTemplate {
  const permissions = neededPermissions(profiles).map(({ permission }) => permission);
  const keys = encodeURIComponent(JSON.stringify(permissions.map(({ key, type }) => ({ key, type }))));
  return {
    url: `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=${keys}&accountId=%2A&zoneId=all&name=${encodeURIComponent("CloudPanel DNS")}`,
    permissions: permissions.map((permission) => permission.label),
  };
}

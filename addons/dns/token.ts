/**
 * The Cloudflare permissions DNS knows: the dashboard's name, the API's names
 * that grant it, and what DNS uses it for. Cloudflare's token-template URL
 * takes `key`/`type`; `config_settings`, `zone_waf` and `dynamic_redirect`
 * are missing from the documented keys but are the dashboard's own. The form
 * drops a key it does not know, so the page lists every permission as well.
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
  /** What it would enable when nothing requires it; listed as optional, never as missing, and left out of the template. */
  enables?: (profiles: Profile[]) => string | null;
}

/** Quoted, since a profile's own name may hold "and". */
const named = (profiles: Profile[], uses: (profile: Profile) => boolean): string | null => {
  const names = profiles.filter(uses).map((profile) => `“${profile.name}”`);
  return names.length ? names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : null;
};

const always = (text: string) => () => text;
const PANEL_GATE = "Firewall's Panel gate";

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
  // Optional for DNS; Firewall's Panel gate requires them before it turns on.
  originPulls: {
    key: "ssl_and_certificates", type: "edit", label: "SSL and Certificates: Edit", grantedBy: ["SSL and Certificates Write"],
    scope: "zone", usedFor: () => null, enables: always(PANEL_GATE),
  },
  accessApps: {
    key: "access", type: "edit", label: "Access: Apps and Policies: Edit", grantedBy: ["Access: Apps and Policies Write"],
    scope: "account", usedFor: () => null, enables: always(PANEL_GATE),
  },
  accessIdentity: {
    key: "access_acct", type: "edit", label: "Access: Organizations, Identity Providers, and Groups: Edit",
    grantedBy: ["Access: Organizations, Identity Providers, and Groups Write"],
    scope: "account", usedFor: () => null, enables: always(PANEL_GATE),
  },
  tokens: {
    key: "api_tokens", type: "read", label: "API Tokens: Read",
    grantedBy: ["API Tokens Read", "API Tokens Write", "Account API Tokens Read", "Account API Tokens Write"],
    scope: "user", usedFor: always("Showing these permissions"),
  },
} satisfies Record<string, PermissionDef>;

export type PermissionName = keyof typeof PERMISSIONS;

export interface ListedPermission {
  name: PermissionName;
  permission: PermissionDef;
  /** What uses it, or what it would enable when optional. */
  usedFor: string;
  optional: boolean;
}

/** What the profiles use, then what they could, in the page's order. */
export function listedPermissions(profiles: Profile[]): ListedPermission[] {
  const all = Object.entries(PERMISSIONS) as [PermissionName, PermissionDef][];
  const listed = (optional: boolean) => all.flatMap(([name, permission]): ListedPermission[] => {
    const usedFor = optional ? permission.usedFor(profiles) ? null : permission.enables?.(profiles) ?? null : permission.usedFor(profiles);
    return usedFor ? [{ name, permission, usedFor, optional }] : [];
  });
  return [...listed(false), ...listed(true)];
}

export function tokenTemplate(profiles: Profile[]): TokenTemplate {
  const permissions = listedPermissions(profiles).filter(({ optional }) => !optional).map(({ permission }) => permission);
  const keys = encodeURIComponent(JSON.stringify(permissions.map(({ key, type }) => ({ key, type }))));
  return {
    url: `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=${keys}&accountId=%2A&zoneId=all&name=${encodeURIComponent("CloudPanel DNS")}`,
    permissions: permissions.map((permission) => permission.label),
  };
}

/**
 * The Cloudflare permissions DNS and Firewall know: the dashboard's name, the
 * API's names that grant it, and what uses it. Cloudflare's token-template URL
 * takes `key`/`type`; `config_settings`, `zone_waf` and `dynamic_redirect`
 * are missing from the documented keys but are the dashboard's own. The form
 * drops a key it does not know, so the page lists every permission as well.
 * https://developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/
 * https://developers.cloudflare.com/fundamentals/api/reference/permissions/
 */

/** Structural subset of a DNS profile needed to determine zone-level Cloudflare permissions. */
export interface ZoneProfileShape {
  name: string;
  zone: {
    ssl: unknown;
    alwaysHttps: unknown;
    acmeFullSsl: boolean;
    webmailFullSsl: boolean;
    skipFirewallIps: string[];
  };
}

export type PermissionConsumer = "dns" | "firewall" | "shared";

export interface TokenTemplate {
  url: string;
  permissions: string[];
}

export interface TokenTemplates {
  dns: TokenTemplate;
  panelGate: TokenTemplate;
  both: TokenTemplate;
}

export interface PermissionDef {
  key: string;
  type: "read" | "edit";
  label: string;
  consumer: PermissionConsumer;
  /** Permission group names, as a token's own policies name them, that grant it. */
  grantedBy: string[];
  /** What it is checked against: each zone the token reaches, each account, or the token's owner. */
  scope: "zone" | "account" | "user";
  /** What uses it, given the profiles; null when nothing does. */
  usedFor: (profiles: ZoneProfileShape[]) => string | null;
  /** What it would enable when nothing requires it; listed as optional, never as missing. */
  enables?: (profiles: ZoneProfileShape[]) => string | null;
}

/** Quoted, since a profile's own name may hold "and". */
const named = (profiles: ZoneProfileShape[], uses: (profile: ZoneProfileShape) => boolean): string | null => {
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
  dns: {
    key: "dns", type: "edit", label: "DNS: Edit", consumer: "dns",
    grantedBy: ["DNS Write"], scope: "zone", usedFor: always("Every profile's records"),
  },
  zone: {
    key: "zone", type: "edit", label: "Zone: Edit", consumer: "dns",
    grantedBy: ["Zone Write"], scope: "account", usedFor: always("Creating zones for new sites"),
  },
  accounts: {
    key: "account_settings", type: "read", label: "Account Settings: Read", consumer: "dns",
    grantedBy: ["Account Settings Read", "Account Settings Write"],
    scope: "account", usedFor: always("Listing the accounts new zones go in"),
  },
  redirects: {
    key: "dynamic_redirect", type: "edit", label: "Single Redirect: Edit", consumer: "dns",
    grantedBy: ["Dynamic URL Redirects Write", "Single Redirect Write"],
    scope: "zone", usedFor: always("Redirect domains"),
  },
  zoneSettings: {
    key: "zone_settings", type: "edit", label: "Zone Settings: Edit", consumer: "dns",
    grantedBy: ["Zone Settings Write"], scope: "zone",
    usedFor: (profiles) => {
      const names = named(profiles, (profile) => profile.zone.ssl !== null || profile.zone.alwaysHttps !== null);
      return names && `SSL mode and Always HTTPS in ${names}`;
    },
  },
  configRules: {
    key: "config_settings", type: "edit", label: "Config Rules: Edit", consumer: "dns",
    grantedBy: ["Config Settings Write"], scope: "zone",
    usedFor: (profiles) => {
      const names = named(profiles, (profile) => profile.zone.acmeFullSsl || profile.zone.webmailFullSsl);
      return names && `Full SSL rules in ${names}`;
    },
  },
  waf: {
    key: "zone_waf", type: "edit", label: "Zone WAF: Edit", consumer: "dns",
    grantedBy: ["Zone WAF Write"], scope: "zone",
    usedFor: (profiles) => {
      const names = named(profiles, (profile) => profile.zone.skipFirewallIps.length > 0);
      return names && `Firewall skip in ${names}`;
    },
  },
  // Required by Firewall's Panel gate; optional for DNS alone.
  originPulls: {
    key: "ssl_and_certificates", type: "edit", label: "SSL and Certificates: Edit", consumer: "firewall",
    grantedBy: ["SSL and Certificates Write"],
    scope: "zone", usedFor: () => null, enables: always(PANEL_GATE),
  },
  accessApps: {
    key: "access", type: "edit", label: "Access: Apps and Policies: Edit", consumer: "firewall",
    grantedBy: ["Access: Apps and Policies Write"],
    scope: "account", usedFor: () => null, enables: always(PANEL_GATE),
  },
  accessIdentity: {
    key: "access_acct", type: "edit", label: "Access: Organizations, Identity Providers, and Groups: Edit", consumer: "firewall",
    grantedBy: ["Access: Organizations, Identity Providers, and Groups Write"],
    scope: "account", usedFor: () => null, enables: always(PANEL_GATE),
  },
  tokens: {
    key: "api_tokens", type: "read", label: "API Tokens: Read", consumer: "shared",
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

export interface PermissionScopeOptions {
  /** Include DNS permissions as required (default true). */
  includeDns?: boolean;
  /** Require Panel gate permissions instead of marking them optional (default false). */
  requirePanelGate?: boolean;
}

/**
 * Permissions for a connection, required first then optional, in the page's
 * order. On the DNS page (`includeDns: true, requirePanelGate: false`) DNS
 * permissions are required and Panel gate permissions are optional. On the
 * Firewall page (`includeDns: false, requirePanelGate: true`) Panel gate
 * permissions and zone-read essentials are required and DNS permissions are
 * optional.
 */
export function listedPermissions(profiles: ZoneProfileShape[], options: PermissionScopeOptions = {}): ListedPermission[] {
  const includeDns = options.includeDns !== false;
  const requirePanelGate = options.requirePanelGate === true;
  const all = Object.entries(PERMISSIONS) as [PermissionName, PermissionDef][];
  const required: ListedPermission[] = [];
  const optional: ListedPermission[] = [];

  for (const [name, permission] of all) {
    if (permission.consumer === "shared") {
      const usedFor = permission.usedFor(profiles);
      if (usedFor) required.push({ name, permission, usedFor, optional: false });
      continue;
    }
    if (permission.consumer === "firewall") {
      const usedFor = permission.enables?.(profiles) ?? PANEL_GATE;
      if (requirePanelGate) required.push({ name, permission, usedFor, optional: false });
      else optional.push({ name, permission, usedFor, optional: true });
      continue;
    }
    // DNS consumer
    const usedFor = permission.usedFor(profiles);
    if (includeDns) {
      if (usedFor) required.push({ name, permission, usedFor, optional: false });
      else {
        const enables = permission.enables?.(profiles);
        if (enables) optional.push({ name, permission, usedFor: enables, optional: true });
      }
    } else if (name === "dns") {
      // Panel gate reads DNS records to verify the custom domain is proxied; DNS Read or Write satisfies it,
      // and DNS: Edit also unlocks DNS management later.
      optional.push({ name, permission, usedFor: "DNS records and zones", optional: true });
    }
  }
  return [...required, ...optional];
}

/**
 * Extra read permissions Panel gate needs when a token is created without DNS's
 * broader write permissions: reading zones, records and zone SSL mode.
 */
const PANEL_GATE_READ_EXTRAS: { key: string; type: "read" | "edit"; label: string }[] = [
  { key: "zone", type: "read", label: "Zone: Read" },
  { key: "dns", type: "read", label: "DNS: Read" },
  { key: "zone_settings", type: "read", label: "Zone Settings: Read" },
];

export function tokenTemplate(
  profiles: ZoneProfileShape[],
  scopes: { dns?: boolean; panelGate?: boolean } = {},
): TokenTemplate {
  const dns = scopes.dns !== false;
  const panelGate = scopes.panelGate === true;
  const items: { key: string; type: "read" | "edit"; label: string }[] = [];
  if (!dns && panelGate) {
    items.push(...PANEL_GATE_READ_EXTRAS);
  }
  const listed = listedPermissions(profiles, { includeDns: dns, requirePanelGate: panelGate })
    .filter(({ optional }) => !optional)
    .map(({ permission }) => ({ key: permission.key, type: permission.type, label: permission.label }));
  for (const item of listed) {
    if (!items.some((existing) => existing.key === item.key && existing.type === item.type)) items.push(item);
  }
  const keys = encodeURIComponent(JSON.stringify(items.map(({ key, type }) => ({ key, type }))));
  const title = dns && panelGate ? "CloudPanel Addons" : panelGate ? "CloudPanel Firewall" : "CloudPanel DNS";
  return {
    url: `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=${keys}&accountId=%2A&zoneId=all&name=${encodeURIComponent(title)}`,
    permissions: items.map((permission) => permission.label),
  };
}

/** Templates for the Connect Cloudflare dialog's scope checkboxes. */
export function tokenTemplates(profiles: ZoneProfileShape[] = []): TokenTemplates {
  return {
    dns: tokenTemplate(profiles, { dns: true, panelGate: false }),
    panelGate: tokenTemplate(profiles, { dns: false, panelGate: true }),
    both: tokenTemplate(profiles, { dns: true, panelGate: true }),
  };
}

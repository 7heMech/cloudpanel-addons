/**
 * The Cloudflare permissions DNS and Firewall know: the dashboard's name, the
 * API's names that grant it, and what uses it. Cloudflare's token-template URL
 * takes `key`/`type`; `config_settings`, `zone_waf` and `dynamic_redirect`
 * are missing from the documented keys but are the dashboard's own. The form
 * drops a key it does not know, so the page lists every permission as well.
 * https://developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/
 * https://developers.cloudflare.com/fundamentals/api/reference/permissions/
 */
import { DEFAULT_EDGE_DEFAULTS, type EdgeDefaults } from "./edge";

/** Structural subset of Firewall's Cloudflare edge defaults needed for permission checks. */
export type EdgePermissionNeeds = Pick<EdgeDefaults, "ssl" | "alwaysHttps" | "acmeFullSsl" | "webmailFullSsl" | "skipFirewallIps">;

export type PermissionConsumer = "dns" | "edge" | "panelGate" | "shared";

export interface TokenTemplate {
  url: string;
  permissions: string[];
}

export type TokenTemplateKey =
  | "dns"
  | "edge"
  | "panelGate"
  | "dns+edge"
  | "dns+panelGate"
  | "edge+panelGate"
  | "dns+edge+panelGate";

export type TokenTemplates = Record<TokenTemplateKey, TokenTemplate>;

export interface PermissionDef {
  key: string;
  type: "read" | "edit";
  label: string;
  consumer: PermissionConsumer;
  /** Permission group names, as a token's own policies name them, that grant it. */
  grantedBy: string[];
  /** What it is checked against: each zone the token reaches, each account, or the token's owner. */
  scope: "zone" | "account" | "user";
  /** What uses it, given Firewall's edge defaults; null when nothing requires it. */
  usedFor: (edge: EdgePermissionNeeds) => string | null;
  /** What it would enable when nothing requires it; listed as optional, never as missing. */
  enables?: (edge: EdgePermissionNeeds) => string | null;
}

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
  // Managed by Firewall's Cloudflare edge section; optional for DNS alone.
  zoneSettings: {
    key: "zone_settings", type: "edit", label: "Zone Settings: Edit", consumer: "edge",
    grantedBy: ["Zone Settings Write"], scope: "zone",
    usedFor: (edge) => {
      const items = [edge.ssl !== null && "SSL/TLS mode", edge.alwaysHttps !== null && "Always Use HTTPS"].filter(Boolean);
      return items.length ? `Cloudflare edge: ${items.join(" and ")}` : null;
    },
    enables: always("Firewall's Cloudflare edge SSL/TLS and Always Use HTTPS defaults"),
  },
  configRules: {
    key: "config_settings", type: "edit", label: "Config Rules: Edit", consumer: "edge",
    grantedBy: ["Config Settings Write"], scope: "zone",
    usedFor: (edge) => {
      const items = [edge.acmeFullSsl && "Let's Encrypt", edge.webmailFullSsl && "webmail"].filter(Boolean);
      return items.length ? `Cloudflare edge: Full SSL for ${items.join(" and ")}` : null;
    },
    enables: always("Firewall's Cloudflare edge Full SSL rules"),
  },
  waf: {
    key: "zone_waf", type: "edit", label: "Zone WAF: Edit", consumer: "edge",
    grantedBy: ["Zone WAF Write"], scope: "zone",
    usedFor: (edge) => edge.skipFirewallIps.length > 0 ? "Cloudflare edge: WAF skip list" : null,
    enables: always("Firewall's Cloudflare edge WAF skip list"),
  },
  // Required by Firewall's Panel gate; optional for DNS and edge defaults alone.
  originPulls: {
    key: "ssl_and_certificates", type: "edit", label: "SSL and Certificates: Edit", consumer: "panelGate",
    grantedBy: ["SSL and Certificates Write"],
    scope: "zone", usedFor: () => null, enables: always(PANEL_GATE),
  },
  accessApps: {
    key: "access", type: "edit", label: "Access: Apps and Policies: Edit", consumer: "panelGate",
    grantedBy: ["Access: Apps and Policies Write"],
    scope: "account", usedFor: () => null, enables: always(PANEL_GATE),
  },
  accessIdentity: {
    key: "access_acct", type: "edit", label: "Access: Organizations, Identity Providers, and Groups: Edit", consumer: "panelGate",
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
  /** Include Firewall's Cloudflare edge permissions as required when active in edge defaults (default false). */
  includeEdge?: boolean;
  /** Require Panel gate permissions instead of marking them optional (default false). */
  requirePanelGate?: boolean;
}

/**
 * Permissions for a connection, required first then optional, in the page's
 * order. On the DNS page (`includeDns: true, includeEdge: false,
 * requirePanelGate: false`) DNS permissions are required and Firewall's edge
 * and Panel gate permissions are optional. On the Firewall page
 * (`includeDns: false, includeEdge: true, requirePanelGate: true`) active edge
 * permissions and Panel gate permissions are required while DNS is optional.
 */
export function listedPermissions(
  edge: EdgePermissionNeeds = DEFAULT_EDGE_DEFAULTS,
  options: PermissionScopeOptions = {},
): ListedPermission[] {
  const includeDns = options.includeDns !== false;
  const includeEdge = options.includeEdge === true;
  const requirePanelGate = options.requirePanelGate === true;
  const all = Object.entries(PERMISSIONS) as [PermissionName, PermissionDef][];
  const required: ListedPermission[] = [];
  const optional: ListedPermission[] = [];

  for (const [name, permission] of all) {
    if (permission.consumer === "shared") {
      const usedFor = permission.usedFor(edge);
      if (usedFor) required.push({ name, permission, usedFor, optional: false });
      continue;
    }
    if (permission.consumer === "panelGate") {
      const usedFor = permission.enables?.(edge) ?? PANEL_GATE;
      if (requirePanelGate) required.push({ name, permission, usedFor, optional: false });
      else optional.push({ name, permission, usedFor, optional: true });
      continue;
    }
    if (permission.consumer === "edge") {
      const usedFor = permission.usedFor(edge);
      const enables = permission.enables?.(edge) ?? usedFor;
      if (includeEdge) {
        if (usedFor) required.push({ name, permission, usedFor, optional: false });
        else if (enables) optional.push({ name, permission, usedFor: enables, optional: true });
      } else if (enables) {
        optional.push({ name, permission, usedFor: enables, optional: true });
      }
      continue;
    }
    // DNS consumer
    const usedFor = permission.usedFor(edge);
    if (includeDns) {
      if (usedFor) required.push({ name, permission, usedFor, optional: false });
      else {
        const enables = permission.enables?.(edge);
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

const EDGE_READ_EXTRAS: { key: string; type: "read" | "edit"; label: string }[] = [
  { key: "zone", type: "read", label: "Zone: Read" },
];

const PANEL_GATE_READ_EXTRAS: { key: string; type: "read" | "edit"; label: string }[] = [
  { key: "zone", type: "read", label: "Zone: Read" },
  { key: "dns", type: "read", label: "DNS: Read" },
  { key: "zone_settings", type: "read", label: "Zone Settings: Read" },
];

export function tokenTemplate(
  edge: EdgePermissionNeeds = DEFAULT_EDGE_DEFAULTS,
  scopes: { dns?: boolean; edge?: boolean; panelGate?: boolean } = {},
): TokenTemplate {
  const dns = scopes.dns !== false;
  const includeEdge = scopes.edge === true;
  const panelGate = scopes.panelGate === true;
  const items: { key: string; type: "read" | "edit"; label: string }[] = [];
  const listed = listedPermissions(edge, { includeDns: dns, includeEdge, requirePanelGate: panelGate })
    .filter(({ optional }) => !optional)
    .map(({ permission }) => ({ key: permission.key, type: permission.type, label: permission.label }));
  const extras = [
    ...(includeEdge ? EDGE_READ_EXTRAS : []),
    ...(panelGate ? PANEL_GATE_READ_EXTRAS : []),
  ];
  for (const extra of extras) {
    if (!listed.some((item) => item.key === extra.key) && !items.some((item) => item.key === extra.key)) {
      items.push(extra);
    }
  }
  for (const item of listed) {
    if (!items.some((existing) => existing.key === item.key && existing.type === item.type)) items.push(item);
  }
  const keys = encodeURIComponent(JSON.stringify(items.map(({ key, type }) => ({ key, type }))));
  const title = dns && (includeEdge || panelGate)
    ? "CloudPanel Addons"
    : (includeEdge || panelGate)
      ? "CloudPanel Firewall"
      : "CloudPanel DNS";
  return {
    url: `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=${keys}&accountId=%2A&zoneId=all&name=${encodeURIComponent(title)}`,
    permissions: items.map((permission) => permission.label),
  };
}

/** Templates for the Connect Cloudflare dialog's scope checkboxes. */
export function tokenTemplates(edge: EdgePermissionNeeds = DEFAULT_EDGE_DEFAULTS): TokenTemplates {
  return {
    dns: tokenTemplate(edge, { dns: true, edge: false, panelGate: false }),
    edge: tokenTemplate(edge, { dns: false, edge: true, panelGate: false }),
    panelGate: tokenTemplate(edge, { dns: false, edge: false, panelGate: true }),
    "dns+edge": tokenTemplate(edge, { dns: true, edge: true, panelGate: false }),
    "dns+panelGate": tokenTemplate(edge, { dns: true, edge: false, panelGate: true }),
    "edge+panelGate": tokenTemplate(edge, { dns: false, edge: true, panelGate: true }),
    "dns+edge+panelGate": tokenTemplate(edge, { dns: true, edge: true, panelGate: true }),
  };
}

/**
 * Cloudflare's token-template URL. `config_settings` and `zone_waf` are missing
 * from the documented keys but fill Config Rules and Zone WAF in the form.
 * https://developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/
 */
import type { Profile } from "./model";

export interface TokenTemplate {
  url: string;
  permissions: string[];
}

interface Permission {
  key: string;
  type: "read" | "edit";
  label: string;
}

export function tokenTemplate(profiles: Profile[]): TokenTemplate {
  const createsZones = profiles.some((profile) => profile.zone.createIn !== null);
  const permissions: Permission[] = [
    { key: "account_settings", type: "read", label: "Account Settings: Read" },
    createsZones ? { key: "zone", type: "edit", label: "Zone: Edit" } : { key: "zone", type: "read", label: "Zone: Read" },
    { key: "dns", type: "edit", label: "DNS: Edit" },
  ];
  if (profiles.some((profile) => profile.zone.ssl !== null || profile.zone.alwaysHttps !== null)) {
    permissions.push({ key: "zone_settings", type: "edit", label: "Zone Settings: Edit" });
  }
  if (profiles.some((profile) => profile.zone.acmeFullSsl || profile.zone.webmailFullSsl)) {
    permissions.push({ key: "config_settings", type: "edit", label: "Config Rules: Edit" });
  }
  if (profiles.some((profile) => profile.zone.skipFirewallIps.length)) {
    permissions.push({ key: "zone_waf", type: "edit", label: "Zone WAF: Edit" });
  }
  const keys = encodeURIComponent(JSON.stringify(permissions.map(({ key, type }) => ({ key, type }))));
  return {
    url: `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=${keys}&accountId=%2A&zoneId=all&name=${encodeURIComponent("CloudPanel DNS")}`,
    permissions: permissions.map((permission) => permission.label),
  };
}

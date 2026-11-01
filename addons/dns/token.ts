/**
 * Cloudflare's token-template URL. `config_settings`, `zone_waf` and
 * `dynamic_redirect` are missing from the documented keys but are the
 * dashboard's own names for Config Rules, Zone WAF and Single Redirect. The
 * form drops a key it does not know, so the page lists every permission as well.
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
  // Zone: Edit even before a profile creates zones, and Single Redirect before
  // any redirect domain, so either works later with the token already pasted.
  const permissions: Permission[] = [
    { key: "account_settings", type: "read", label: "Account Settings: Read" },
    { key: "zone", type: "edit", label: "Zone: Edit" },
    { key: "dns", type: "edit", label: "DNS: Edit" },
    { key: "dynamic_redirect", type: "edit", label: "Single Redirect: Edit" },
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

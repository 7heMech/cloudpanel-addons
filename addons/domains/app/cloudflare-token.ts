import type { Profile } from "../model";

export function cloudflareTokenTemplate(profiles: Profile[]): { url: string; permissions: string[] } {
  const createsZones = profiles.some((p) => p.createZones);
  const permissions = [
    { key: "zone", type: createsZones ? "edit" : "read", label: createsZones ? "Zone Edit" : "Zone Read" },
    { key: "dns", type: "edit", label: "DNS Edit" },
    ...(profiles.some((p) => p.zoneSettings) ? [{ key: "zone_settings", type: "edit", label: "Zone Settings Edit" }] : []),
    ...(profiles.some((p) => p.acmeRule || p.webmailRule) ? [{ key: "config_settings", type: "edit", label: "Config Rules Edit" }] : []),
    ...(profiles.some((p) => p.mainwpIps.length) ? [{ key: "zone_waf", type: "edit", label: "Zone WAF Edit" }] : []),
  ];
  const url = new URL("https://dash.cloudflare.com/profile/api-tokens");
  url.searchParams.set("permissionGroupKeys", JSON.stringify(permissions.map(({ key, type }) => ({ key, type }))));
  url.searchParams.set("zoneId", "all");
  url.searchParams.set("name", "CloudPanel DNS & Mail");
  return { url: url.href, permissions: permissions.map((p) => p.label) };
}

import { expect, test } from "bun:test";
import { cloudflareTokenTemplate } from "../addons/domains/app/cloudflare-token";
import { PRESET_PROFILE, type Profile } from "../addons/domains/model";

const dnsProfile = (): Profile => ({ ...structuredClone(PRESET_PROFILE), zoneSettings: false, acmeRule: false, webmailRule: false });
const groups = (profiles: Profile[]) => JSON.parse(new URL(cloudflareTokenTemplate(profiles).url).searchParams.get("permissionGroupKeys")!) as { key: string; type: string }[];

test("DNS token setup requests only zone read and DNS edit without preselecting every account", () => {
  expect(groups([dnsProfile()])).toEqual([{ key: "zone", type: "read" }, { key: "dns", type: "edit" }]);
  const template = cloudflareTokenTemplate([dnsProfile()]), url = new URL(template.url);
  expect(url.origin).toBe("https://dash.cloudflare.com");
  expect(url.pathname).toBe("/profile/api-tokens");
  expect(url.searchParams.has("accountId")).toBe(false);
  expect(url.searchParams.get("zoneId")).toBe("all");
  expect(url.searchParams.get("name")).toBe("CloudPanel DNS & Mail");
  expect(template.permissions).toEqual(["Zone Read", "DNS Edit"]);
});

test("the shipped Report only profile includes settings and config rule permissions", () => {
  expect(groups([PRESET_PROFILE])).toEqual([
    { key: "zone", type: "read" }, { key: "dns", type: "edit" },
    { key: "zone_settings", type: "edit" }, { key: "config_settings", type: "edit" },
  ]);
});

test.each(["acmeRule", "webmailRule"] as const)("%s alone requests configuration rule access", (feature) => {
  const profile = dnsProfile(); profile[feature] = true;
  expect(groups([profile])).toEqual([{ key: "zone", type: "read" }, { key: "dns", type: "edit" }, { key: "config_settings", type: "edit" }]);
});

test("all saved profiles contribute optional permissions once and zone editing replaces zone read", () => {
  const profile = { ...dnsProfile(), createZones: true, mainwpIps: ["192.0.2.10"], mode: "enforce" as const };
  expect(groups([PRESET_PROFILE, profile, profile])).toEqual([
    { key: "zone", type: "edit" }, { key: "dns", type: "edit" },
    { key: "zone_settings", type: "edit" }, { key: "config_settings", type: "edit" }, { key: "zone_waf", type: "edit" },
  ]);
  expect(cloudflareTokenTemplate([profile]).permissions).toContain("Zone WAF Edit");
});

test("removing features or profiles reduces the next token template without retaining stale permission grants", () => {
  const profile = { ...dnsProfile(), createZones: true, mainwpIps: ["192.0.2.10"] };
  expect(groups([profile])).toContainEqual({ key: "zone_waf", type: "edit" });
  profile.createZones = false; profile.mainwpIps = [];
  expect(groups([profile])).toEqual(groups([]));
  expect(groups([])).toEqual([{ key: "zone", type: "read" }, { key: "dns", type: "edit" }]);
});

test("the outbound token template contains only permission requirements, not profile domains or settings", () => {
  const profile = { ...PRESET_PROFILE, name: "Private profile", mailHost: "private.example.org", sharedMailbox: "private@example.org", mainwpIps: ["192.0.2.99"], spfIncludes: ["private-spf.example.org"] };
  const template = JSON.stringify(cloudflareTokenTemplate([profile]));
  for (const value of [profile.name, profile.mailHost, profile.sharedMailbox, profile.mainwpIps[0]!, profile.spfIncludes[0]!]) expect(template).not.toContain(value);
});

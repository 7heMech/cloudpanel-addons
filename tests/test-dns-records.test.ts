import { describe, expect, test } from "bun:test";
import type { CfRecord } from "../lib/cloudflare/api";
import { parseProfile, type Profile } from "../addons/dns/model";
import { PRESETS, seededPolicy } from "../addons/dns/presets";
import { diffRecords, renderProfile, renderRedirect, wildcardSource, type SiteVars } from "../addons/dns/records";
import { tokenTemplate } from "../lib/cloudflare/tokens";

const vars = (domain: string, zone = "example.com", extra: Partial<SiteVars> = {}): SiteVars => ({
  domain, zone, ipv4: "203.0.113.10", ipv6: "2001:db8::10", mailcowHost: "mail.example.net",
  mailcowSelector: "dkim", mailcowDkim: "v=DKIM1;k=rsa;t=s;s=email;p=QUJD", ...extra,
});

function profile(records: Partial<Profile["records"][number]>[], extra: Record<string, unknown> = {}): Profile {
  return parseProfile({ id: "p", name: "P", mode: "report", mailcow: true, zone: {}, records, ...extra });
}

let n = 0;
function published(type: string, name: string, content: string, extra: Partial<CfRecord> = {}): CfRecord {
  return { id: (++n).toString(16).padStart(32, "0"), type, name, content, proxied: false, ttl: 1, priority: null, comment: null, ...extra };
}

const webAndMailcow = seededPolicy().profiles.find((candidate) => candidate.id === "web-mailcow")!;

describe("rendering a profile for a site", () => {
  test("the Web and Mailcow preset gives an apex site every record, wildcard and webmail included", () => {
    const rendered = renderProfile(webAndMailcow, vars("example.com"));
    expect(rendered.problems).toEqual([]);
    expect(rendered.records.map((record) => `${record.type} ${record.name}`)).toEqual([
      "A example.com", "AAAA example.com", "A *.example.com", "AAAA *.example.com",
      "MX example.com", "TXT example.com", "TXT dkim._domainkey.example.com", "CNAME autoconfig.example.com",
      "CNAME autodiscover.example.com", "SRV _autodiscover._tcp.example.com", "CNAME webmail.example.com",
    ]);
    expect(rendered.records.find((record) => record.type === "SRV")).toMatchObject({ content: "0 443 mail.example.net", priority: 0 });
  });

  test("a subdomain site gets its own names and no apex-only rows", () => {
    const rendered = renderProfile(webAndMailcow, vars("join.example.com"));
    const names = rendered.records.map((record) => record.name);
    expect(names).toContain("join.example.com");
    expect(names).toContain("dkim._domainkey.join.example.com");
    expect(names).not.toContain("*.join.example.com");
    expect(names).not.toContain("autoconfig.join.example.com");
    expect(names).not.toContain("autodiscover.join.example.com");
    expect(names).not.toContain("_autodiscover._tcp.join.example.com");
    expect(names).not.toContain("webmail.join.example.com");
    const dmarc = profile(PRESETS.find((preset) => preset.id === "dmarc")!.records);
    expect(renderProfile(dmarc, vars("example.com")).records.map((record) => record.name)).toEqual(["_dmarc.example.com"]);
    expect(renderProfile(dmarc, vars("join.example.com")).records).toEqual([]);
  });

  test("{zone} and {sub} reach the bare domain of a www site, and an empty {sub} leaves no stray dot", () => {
    const rows = profile([
      { type: "A", name: "{zone}", content: "{ipv4}" },
      { type: "TXT", name: "_verify.{sub}.{zone}", content: "token" },
    ]);
    const www = renderProfile(rows, vars("www.example.com"));
    expect(www.records.map((record) => record.name)).toEqual(["example.com", "_verify.www.example.com"]);
    expect(renderProfile(rows, vars("example.com")).records.map((record) => record.name)).toEqual(["example.com", "_verify.example.com"]);
  });

  test("a name outside the site's zone is refused", () => {
    const rendered = renderProfile(profile([{ type: "A", name: "example.org", content: "{ipv4}" }]), vars("example.com"));
    expect(rendered.problems[0]).toContain("is not a name in the example.com zone");
  });

  test("an AAAA row without an IPv6 address writes nothing but still owns the name", () => {
    const rendered = renderProfile(profile([{ type: "AAAA", name: "{domain}", content: "{ipv6}", proxied: true }]), vars("example.com", "example.com", { ipv6: "" }));
    expect(rendered.records).toEqual([]);
    const diff = diffRecords(rendered, [published("AAAA", "example.com", "2001:db8::99")]);
    expect(diff.ops.map((op) => op.action)).toEqual(["delete"]);
  });

  test("an address that could not be detected stops its row rather than removing what is published", () => {
    const web = profile(PRESETS.find((preset) => preset.id === "web")!.records);
    const rendered = renderProfile(web, vars("example.com", "example.com", { ipv4: null }));
    expect(rendered.problems).toEqual([
      "Record 1 (A {domain}): this server's IPv4 address could not be detected; set it under Server addresses",
      "Record 3 (A *.{domain}): this server's IPv4 address could not be detected; set it under Server addresses",
    ]);
    expect(diffRecords(rendered, [published("A", "example.com", "203.0.113.10")]).ops.filter((op) => op.action === "delete")).toEqual([]);
  });

  test("a DKIM row waits for Mailcow's key and leaves the published key alone meanwhile", () => {
    const rendered = renderProfile(webAndMailcow, vars("example.com", "example.com", { mailcowDkim: null }));
    expect(rendered.waitingDkim).toEqual(["dkim._domainkey.example.com"]);
    const diff = diffRecords(rendered, [published("TXT", "dkim._domainkey.example.com", "v=DKIM1;p=OLD")]);
    expect(diff.ops.filter((op) => op.record.name === "dkim._domainkey.example.com")).toEqual([]);
  });

  test("bad content is reported against its row", () => {
    const rendered = renderProfile(profile([{ type: "MX", name: "{domain}", content: "not a host", priority: 10 }]), vars("example.com"));
    expect(rendered.problems[0]).toMatch(/^Record 1 \(MX \{domain\}\): its content must be a hostname/);
  });
});

describe("what has to change", () => {
  const web = profile(PRESETS.find((preset) => preset.id === "web")!.records);

  test("matching records are left alone and missing ones created", () => {
    const rendered = renderProfile(web, vars("example.com"));
    const diff = diffRecords(rendered, [published("A", "example.com", "203.0.113.10", { proxied: true })]);
    expect(diff.matched.map((record) => record.type)).toEqual(["A"]);
    expect(diff.ops.map((op) => `${op.action} ${op.record.type} ${op.record.name}`)).toEqual([
      "create AAAA example.com", "create A *.example.com", "create AAAA *.example.com",
    ]);
  });

  test("a wrong address is updated in place, a conflicting CNAME deleted, and other names untouched", () => {
    const rendered = renderProfile(web, vars("example.com"));
    const diff = diffRecords(rendered, [
      published("A", "example.com", "198.51.100.4"),
      published("CNAME", "*.example.com", "example.com"),
      published("A", "shop.example.com", "198.51.100.4"),
      published("TXT", "example.com", "google-site-verification=abc"),
    ]);
    expect(diff.ops.map((op) => `${op.action} ${op.record.type} ${op.record.name}`)).toEqual([
      "update A example.com", "delete CNAME *.example.com",
      "create AAAA example.com", "create A *.example.com", "create AAAA *.example.com",
    ]);
  });

  test("a record that already has the wanted address is updated, never another rewritten to the same address", () => {
    const rendered = renderProfile(profile([{ type: "A", name: "{domain}", content: "{ipv4}", proxied: true }]), vars("example.com"));
    const old = published("A", "example.com", "198.51.100.4");
    const current = published("A", "example.com", "203.0.113.10");
    expect(diffRecords(rendered, [old, current]).ops.map((op) => `${op.action} ${op.current!.content}`)).toEqual([
      "update 203.0.113.10", "delete 198.51.100.4",
    ]);
    const mx = profile([{ type: "MX", name: "{domain}", content: "mx1.example.net", priority: 10 }, { type: "MX", name: "{domain}", content: "mx2.example.net", priority: 20 }]);
    const swapped = diffRecords(renderProfile(mx, vars("example.com")), [
      published("MX", "example.com", "mx2.example.net", { priority: 10 }), published("MX", "example.com", "mx1.example.net", { priority: 20 }),
    ]);
    expect(swapped.ops.map((op) => `${op.action} ${op.current!.content} ${op.current!.priority} to ${op.record.priority}`)).toEqual([
      "update mx1.example.net 20 to 10", "update mx2.example.net 10 to 20",
    ]);
  });

  test("SPF is merged into the published record, and only SPF TXT is owned", () => {
    const rendered = renderProfile(profile([{ type: "TXT", name: "{domain}", content: "v=spf1 mx ~all" }]), vars("example.com"));
    const spf = published("TXT", "example.com", "v=spf1 include:_spf.mlsend.com -all");
    const diff = diffRecords(rendered, [spf, published("TXT", "example.com", "verification=1")]);
    expect(diff.ops).toEqual([{ action: "update", current: spf, record: expect.objectContaining({ content: "v=spf1 include:_spf.mlsend.com mx -all" }) }]);
  });

  test("duplicate SPF records are merged into one before the other goes", () => {
    const rendered = renderProfile(profile([{ type: "TXT", name: "{domain}", content: "v=spf1 mx ~all" }]), vars("example.com"));
    const diff = diffRecords(rendered, [published("TXT", "example.com", "v=spf1 include:a.example ~all"), published("TXT", "example.com", "v=spf1 include:b.example ~all")]);
    expect(diff.ops.map((op) => op.action)).toEqual(["update", "delete"]);
    expect(diff.ops[0]!.record.content).toBe("v=spf1 include:a.example include:b.example mx ~all");
  });

  test("a TXT value of no known kind is created once and then found", () => {
    const rendered = renderProfile(profile([{ type: "TXT", name: "{domain}", content: "verification=1" }]), vars("example.com"));
    expect(diffRecords(rendered, [published("TXT", "example.com", "other=2")]).ops.map((op) => op.action)).toEqual(["create"]);
    expect(diffRecords(rendered, [published("TXT", "example.com", "verification=1")]).ops).toEqual([]);
  });

  test("a name delegated by NS records stops the site rather than being written", () => {
    const rendered = renderProfile(web, vars("shop.example.com"));
    const diff = diffRecords(rendered, [published("NS", "shop.example.com", "ns1.elsewhere.example")]);
    expect(diff.problems).toEqual(["shop.example.com is delegated to other nameservers by NS records"]);
    expect(diffRecords(rendered, [published("NS", "example.com", "ada.ns.cloudflare.com")]).problems).toEqual([]);
  });
});

describe("profiles", () => {
  test("a proxied row is Auto TTL whatever was sent, and only address and CNAME rows proxy", () => {
    const parsed = profile([{ type: "A", name: "{domain}", content: "{ipv4}", proxied: true, ttl: 300 }, { type: "TXT", name: "{domain}", content: "x", proxied: true }]);
    expect(parsed.records[0]).toMatchObject({ proxied: true, ttl: 1 });
    expect(parsed.records[1]!.proxied).toBe(false);
  });

  test("unknown placeholders and missing priorities are refused when saved", () => {
    expect(() => profile([{ type: "A", name: "{domain}", content: "{server.ip}" }])).toThrow("not a placeholder");
    expect(() => profile([{ type: "MX", name: "{domain}", content: "mx.example.net" }])).toThrow("priority");
  });
});

describe("the Cloudflare token template", () => {
  test("is a user token for any account and every zone, with the permissions the profiles and redirect domains use", () => {
    const template = tokenTemplate(seededPolicy().profiles);
    const url = new URL(template.url);
    expect(url.origin + url.pathname).toBe("https://dash.cloudflare.com/profile/api-tokens");
    expect(url.searchParams.get("accountId")).toBe("*");
    expect(url.searchParams.get("zoneId")).toBe("all");
    expect(JSON.parse(url.searchParams.get("permissionGroupKeys")!)).toEqual([
      { key: "dns", type: "edit" }, { key: "zone", type: "edit" }, { key: "account_settings", type: "read" },
      { key: "dynamic_redirect", type: "edit" }, { key: "zone_settings", type: "edit" }, { key: "config_settings", type: "edit" },
      { key: "api_tokens", type: "read" },
    ]);
    expect(template.permissions).toContain("Config Rules: Edit");
    expect(template.permissions).toContain("Single Redirect: Edit");
  });

  test("asks for WAF only for a firewall skip", () => {
    const [web] = seededPolicy().profiles;
    const creating = { ...web!, zone: { ...web!.zone, createIn: { connectionId: "cf-1", accountId: "a".repeat(32) }, skipFirewallIps: ["203.0.113.7"] } };
    const template = tokenTemplate([creating]);
    const keys = JSON.parse(new URL(template.url).searchParams.get("permissionGroupKeys")!);
    expect(keys).toContainEqual({ key: "zone", type: "edit" });
    expect(keys).toContainEqual({ key: "zone_waf", type: "edit" });
    expect(template.permissions).toContain("Zone WAF: Edit");
    expect(keys).not.toContainEqual({ key: "firewall_services", type: "edit" });
  });
});

test("duplicate records and multiple CNAME targets are refused before they reach Cloudflare", () => {
  const duplicate = profile([
    { type: "A", name: "{domain}", content: "{ipv4}" },
    { type: "A", name: "{sub}.{zone}", content: "{ipv4}", ttl: 300 },
  ]);
  expect(renderProfile(duplicate, vars("example.com")).problems).toContain("A example.com: remove the duplicate record row");
  const aliases = profile([
    { type: "CNAME", name: "www.{domain}", content: "one.example.net" },
    { type: "CNAME", name: "www.{domain}", content: "two.example.net" },
  ]);
  expect(renderProfile(aliases, vars("example.com")).problems).toContain("www.example.com: only one CNAME row may write to a name");
});

describe("wildcard coverage (RFC 4592)", () => {
  const web = profile(PRESETS.find((preset) => preset.id === "web")!.records, { mailcow: false });
  const wild = () => [
    published("A", "*.example.com", "203.0.113.10", { proxied: true }),
    published("AAAA", "*.example.com", "2001:db8::10", { proxied: true }),
  ];

  test("an unobstructed matching wildcard satisfies a subdomain and deletes redundant explicit records", () => {
    const rendered = renderProfile(web, vars("shop.example.com"));
    const clean = diffRecords(rendered, wild());
    expect(clean.ops).toEqual([]);
    expect(clean.covered).toEqual({ "shop.example.com": "*.example.com" });
    expect(clean.blockedWildcard).toEqual({});
    expect(clean.names).toContain("*.example.com");

    const withExplicit = diffRecords(rendered, [
      ...wild(),
      published("A", "shop.example.com", "203.0.113.10", { proxied: true }),
      published("AAAA", "shop.example.com", "2001:db8::10", { proxied: true }),
    ]);
    expect(withExplicit.covered).toEqual({ "shop.example.com": "*.example.com" });
    expect(withExplicit.ops.map((op) => `${op.action} ${op.record.type} ${op.record.name}`)).toEqual([
      "delete A shop.example.com", "delete AAAA shop.example.com",
    ]);

    const withCname = diffRecords(rendered, [...wild(), published("CNAME", "shop.example.com", "old.example.net")]);
    expect(withCname.covered).toEqual({ "shop.example.com": "*.example.com" });
    expect(withCname.ops.map((op) => `${op.action} ${op.record.type} ${op.record.name}`)).toEqual(["delete CNAME shop.example.com"]);
  });

  test("a closer wildcard wins over a broader one", () => {
    const rendered = renderProfile(web, vars("a.b.example.com"));
    const diff = diffRecords(rendered, [
      published("A", "*.example.com", "198.51.100.1", { proxied: true }),
      published("A", "*.b.example.com", "203.0.113.10", { proxied: true }),
      published("AAAA", "*.b.example.com", "2001:db8::10", { proxied: true }),
    ]);
    expect(diff.covered).toEqual({ "a.b.example.com": "*.b.example.com" });
    expect(diff.ops).toEqual([]);
  });

  test("records at, below, or on an intermediate ancestor block the wildcard and fall back to explicit records", () => {
    const rendered = renderProfile(web, vars("shop.example.com"));
    const byTxt = diffRecords(rendered, [...wild(), published("TXT", "shop.example.com", "verify=1")]);
    expect(byTxt.covered).toEqual({});
    expect(byTxt.blockedWildcard).toEqual({ "shop.example.com": { wildcard: "*.example.com", by: "TXT shop.example.com" } });
    expect(byTxt.ops.map((op) => `${op.action} ${op.record.type} ${op.record.name}`)).toEqual([
      "create A shop.example.com", "create AAAA shop.example.com",
    ]);

    // Empty non-terminal: a record beneath the subdomain blocks the wildcard.
    const byEnt = diffRecords(rendered, [...wild(), published("TXT", "dkim._domainkey.shop.example.com", "v=DKIM1;p=abc")]);
    expect(byEnt.covered).toEqual({});
    expect(byEnt.blockedWildcard["shop.example.com"]).toEqual({ wildcard: "*.example.com", by: "TXT dkim._domainkey.shop.example.com" });

    // A nested wildcard below the subdomain also creates an ENT at the subdomain itself.
    const bySubWild = diffRecords(rendered, [...wild(), published("A", "*.shop.example.com", "203.0.113.10", { proxied: true })]);
    expect(bySubWild.covered).toEqual({});
    expect(bySubWild.blockedWildcard["shop.example.com"]).toEqual({ wildcard: "*.example.com", by: "A *.shop.example.com" });

    // Intermediate ancestor: other.b.example.com makes b.example.com exist without *.b.example.com.
    const nested = renderProfile(web, vars("a.b.example.com"));
    const byAncestor = diffRecords(nested, [...wild(), published("TXT", "other.b.example.com", "x")]);
    expect(byAncestor.covered).toEqual({});
    expect(byAncestor.blockedWildcard["a.b.example.com"]).toEqual({ wildcard: "*.example.com", by: "TXT other.b.example.com" });

    // A profile that itself writes MX/TXT (such as Web and Mailcow) also reports why the wildcard cannot cover it.
    const mailRendered = renderProfile(webAndMailcow, vars("mainwp.example.com"));
    const byOwnMail = diffRecords(mailRendered, wild());
    expect(byOwnMail.covered).toEqual({});
    expect(byOwnMail.blockedWildcard["mainwp.example.com"]).toEqual({ wildcard: "*.example.com", by: "MX mainwp.example.com" });
    expect(byOwnMail.ops.map((op) => `${op.action} ${op.record.type} ${op.record.name}`)).toContain("create A mainwp.example.com");
  });

  test("mismatched IP, proxy, address family or CNAME wildcard is never used", () => {
    const rendered = renderProfile(web, vars("shop.example.com"));
    const wrongIp = diffRecords(rendered, [
      published("A", "*.example.com", "198.51.100.9", { proxied: true }),
      published("AAAA", "*.example.com", "2001:db8::10", { proxied: true }),
    ]);
    expect(wrongIp.covered).toEqual({});
    expect(wrongIp.blockedWildcard).toEqual({});
    expect(wrongIp.ops.map((op) => op.record.type)).toEqual(["A", "AAAA"]);

    const wrongProxy = diffRecords(rendered, [
      published("A", "*.example.com", "203.0.113.10", { proxied: false }),
      published("AAAA", "*.example.com", "2001:db8::10", { proxied: false }),
    ]);
    expect(wrongProxy.covered).toEqual({});
    expect(wrongProxy.ops.map((op) => op.record.type)).toEqual(["A", "AAAA"]);

    // Missing AAAA on wildcard: must write BOTH A and AAAA, never AAAA alone.
    const missingV6 = diffRecords(rendered, [published("A", "*.example.com", "203.0.113.10", { proxied: true })]);
    expect(missingV6.covered).toEqual({});
    expect(missingV6.ops.map((op) => op.record.type)).toEqual(["A", "AAAA"]);

    // Server has no IPv6, but wildcard still carries a stale AAAA: must write explicit A.
    const ipv4Only = renderProfile(web, vars("shop.example.com", "example.com", { ipv6: "" }));
    const extraV6 = diffRecords(ipv4Only, wild());
    expect(extraV6.covered).toEqual({});
    expect(extraV6.ops.map((op) => `${op.action} ${op.record.type}`)).toEqual(["create A"]);

    // CNAME wildcard does not match wanted A/AAAA.
    const cnameWild = diffRecords(rendered, [published("CNAME", "*.example.com", "target.example.net", { proxied: true })]);
    expect(cnameWild.covered).toEqual({});
    expect(cnameWild.ops.map((op) => op.record.type)).toEqual(["A", "AAAA"]);
  });

  test("planned sibling wildcard overrides stale published wildcard, and redirects skip *.{domain} and wildcard coverage", () => {
    const rendered = renderProfile(web, vars("shop.example.com"));
    const stale = [
      published("A", "*.example.com", "198.51.100.1", { proxied: true }),
      published("AAAA", "*.example.com", "2001:db8::99", { proxied: true }),
    ];
    const apex = renderProfile(web, vars("example.com"));
    const diff = diffRecords(rendered, stale, {
      zoneRecords: apex.records.filter((record) => record.name.startsWith("*.")),
      zoneClaims: apex.claims.filter((claim) => claim.name.startsWith("*.")),
    });
    expect(diff.covered).toEqual({ "shop.example.com": "*.example.com" });
    expect(diff.ops).toEqual([]);

    const redirect = renderRedirect(webAndMailcow, ["example.com", "www.example.com"], vars("example.com"), "100::");
    expect(redirect.records.some((record) => record.name === "*.example.com")).toBe(false);
    const subRedirect = renderRedirect(web, ["shop.example.com"], vars("shop.example.com"), "100::");
    expect(diffRecords(subRedirect, wild(), { allowWildcard: false }).ops.map((op) => `${op.action} ${op.record.type} ${op.record.name}`))
      .toEqual(["create AAAA shop.example.com"]);
    expect(wildcardSource("example.com", "example.com", wild())).toBeNull();

    // An NS delegation cut at an ancestor occludes any wildcard at or below the cut.
    expect(wildcardSource("a.b.example.com", "example.com", [
      published("NS", "b.example.com", "ns1.elsewhere.example"),
      published("A", "*.b.example.com", "203.0.113.10", { proxied: true }),
    ])).toBeNull();

    // A single profile with both *.{domain} and www.{domain} creates the wildcard before deleting redundant www records.
    const both = profile([
      { type: "A", name: "{domain}", content: "{ipv4}", proxied: true },
      { type: "A", name: "www.{domain}", content: "{ipv4}", proxied: true },
      { type: "A", name: "*.{domain}", content: "{ipv4}", proxied: true },
    ], { mailcow: false });
    const handoff = diffRecords(renderProfile(both, vars("example.com")), [
      published("A", "example.com", "203.0.113.10", { proxied: true }),
      published("A", "www.example.com", "203.0.113.10", { proxied: true }),
    ]);
    expect(handoff.ops.map((op) => `${op.action} ${op.record.type} ${op.record.name}`)).toEqual([
      "create A *.example.com", "delete A www.example.com",
    ]);
  });
});

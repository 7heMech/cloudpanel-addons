import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeDnsAction, type DnsReply } from "../addons/dns/action";
import { DNS_ADDON } from "../addons/dns/addon";
import { dashboardContent } from "../addons/dns/app/views";
import type { PanelSite, StandIn, StandIns } from "../addons/dns/engine";
import { seededPolicy } from "../addons/dns/presets";
import {
  formatPowerDnsContent, parsePowerDnsServerId, parsePowerDnsUrl, powerDnsRecordId, PowerDnsProvider, quotePowerDnsTxt,
} from "../addons/dns/powerdns";
import { connectionCheck, permissionActions } from "../addons/dns/setup";
import { standInBody } from "../addons/dns/stand-in";
import { unquoteTxt } from "../lib/dns-name";
import type { ApiFetch } from "../lib/provider-http";
import { FakeCloudflare, FakeMailcow, hexId, routed } from "./fixtures/dns-api";
import { removeCloudflareConnection } from "../lib/cloudflare/store";

const PDNS_KEY = "pdns-secret-key-0123456789";
const PDNS_URL = "http://127.0.0.1:8081";
const CF_TOKEN = "cf-agency-token-0123456789abcdef";
const START = Date.parse("2026-10-18T10:00:00Z");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface FakeRrset {
  name: string;
  type: string;
  ttl: number;
  records: { content: string; disabled: boolean }[];
}

interface FakePdnsZone {
  id: string;
  name: string;
  kind: string;
  rrsets: FakeRrset[];
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: body === null ? {} : { "Content-Type": "application/json" },
  });

class FakePowerDns {
  readonly zones = new Map<string, FakePdnsZone>();
  readonly calls: { method: string; path: string; body?: unknown }[] = [];
  daemonType = "authoritative";
  errorMessage: string | null = null;

  constructor(readonly apiKey = PDNS_KEY, readonly serverId = "localhost") {}

  addZone(name: string, rrsets: FakeRrset[] = []): FakePdnsZone {
    const fqdn = name.endsWith(".") ? name : `${name}.`;
    const zone: FakePdnsZone = {
      id: fqdn,
      name: fqdn,
      kind: "Native",
      rrsets: [
        { name: fqdn, type: "SOA", ttl: 3600, records: [{ content: `ns1.example.net. hostmaster.${fqdn} 1 10800 3600 604800 3600`, disabled: false }] },
        { name: fqdn, type: "NS", ttl: 3600, records: [{ content: "ns1.example.net.", disabled: false }, { content: "ns2.example.net.", disabled: false }] },
        ...rrsets,
      ],
    };
    this.zones.set(fqdn, zone);
    return zone;
  }

  rrsetsOf(zoneName: string): FakeRrset[] {
    const fqdn = zoneName.endsWith(".") ? zoneName : `${zoneName}.`;
    return this.zones.get(fqdn)?.rrsets ?? [];
  }

  recordsSummary(zoneName: string): string[] {
    return this.rrsetsOf(zoneName)
      .filter((rrset) => rrset.type !== "SOA" && rrset.type !== "NS")
      .flatMap((rrset) => rrset.records.filter((r) => !r.disabled).map((r) => `${rrset.type} ${rrset.name} ${rrset.ttl} ${r.content}`))
      .sort();
  }

  patches(): { method: string; path: string; body?: unknown }[] {
    return this.calls.filter((call) => call.method === "PATCH");
  }

  handle(urlString: string, init: RequestInit): Response {
    const url = new URL(urlString);
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    const key = headers.get("x-api-key") ?? "";
    const body = typeof init.body === "string" && init.body ? JSON.parse(init.body) : undefined;
    this.calls.push({ method, path: url.pathname, body });

    if (this.errorMessage) return jsonResponse({ error: this.errorMessage }, 500);
    if (key !== this.apiKey) return jsonResponse({ error: `Unauthorized for key ${key}` }, 401);

    const serverPrefix = `/api/v1/servers/${encodeURIComponent(this.serverId)}`;
    if (method === "GET" && url.pathname === serverPrefix) {
      return jsonResponse({ id: this.serverId, type: "Server", daemon_type: this.daemonType, version: "4.9.1" });
    }
    if (method === "GET" && url.pathname === `${serverPrefix}/zones`) {
      return jsonResponse([...this.zones.values()].map((z) => ({ id: z.id, name: z.name, kind: z.kind })));
    }
    if (method === "POST" && url.pathname === `${serverPrefix}/zones`) {
      const payload = body as { name: string; kind: string; nameservers: string[] };
      if (!payload.name.endsWith(".")) return jsonResponse({ error: "Zone name must end with a dot" }, 422);
      if (payload.kind !== "Native") return jsonResponse({ error: "Expected Native zone" }, 422);
      if (!Array.isArray(payload.nameservers) || !payload.nameservers.length || !payload.nameservers.every((ns) => ns.endsWith("."))) {
        return jsonResponse({ error: "Nameservers must be canonical FQDNs" }, 422);
      }
      const created = this.addZone(payload.name, []);
      created.rrsets = created.rrsets.map((rrset) => rrset.type === "NS"
        ? { ...rrset, records: payload.nameservers.map((ns) => ({ content: ns, disabled: false })) }
        : rrset);
      return jsonResponse({ id: created.id, name: created.name, kind: created.kind }, 201);
    }
    const zoneMatch = new RegExp(`^${serverPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/zones/([^/]+)$`).exec(url.pathname);
    if (zoneMatch) {
      const zoneId = decodeURIComponent(zoneMatch[1]!);
      const zone = this.zones.get(zoneId);
      if (!zone) return jsonResponse({ error: "Not Found" }, 404);
      if (method === "GET") return jsonResponse(zone);
      if (method === "PATCH") {
        const patch = body as { rrsets: { name: string; type: string; ttl?: number; changetype: string; records?: { content: string; disabled: boolean }[] }[] };
        for (const item of patch.rrsets) {
          if (!item.name.endsWith(".")) return jsonResponse({ error: `RRset name ${item.name} must end with a dot` }, 422);
          zone.rrsets = zone.rrsets.filter((existing) => !(existing.name === item.name && existing.type === item.type));
          if (item.changetype === "REPLACE") {
            if (item.ttl === undefined || item.ttl < 0) return jsonResponse({ error: "REPLACE requires non-negative TTL" }, 422);
            zone.rrsets.push({ name: item.name, type: item.type, ttl: item.ttl, records: item.records ?? [] });
          } else if (item.changetype !== "DELETE") {
            return jsonResponse({ error: `Unknown changetype ${item.changetype}` }, 422);
          }
        }
        return jsonResponse(null, 204);
      }
    }
    return jsonResponse({ error: `Unhandled ${method} ${url.pathname}` }, 404);
  }
}

function makeSite(id: number, domain: string): PanelSite {
  return { id, domain, type: "php", createdAt: START - 86_400_000, selfSigned: false, cloudflareOnly: false };
}

function makeStandIns(): StandIns & { log: string[]; hosts: Record<string, string[] | undefined> } {
  const current: Record<string, StandIn> = {};
  const log: string[] = [];
  const hosts: Record<string, string[] | undefined> = {};
  return {
    current,
    log,
    hosts,
    async create(redirect, siteHosts) {
      log.push(`create:${redirect.source}`);
      hosts[redirect.source] = siteHosts;
      current[redirect.source] = { target: redirect.target, status: redirect.status, keepPath: redirect.keepPath, keepQuery: redirect.keepQuery, ...(siteHosts ? { hosts: siteHosts } : {}) };
    },
    async update(redirect, siteHosts) {
      log.push(`update:${redirect.source}`);
      hosts[redirect.source] = siteHosts;
      current[redirect.source] = { target: redirect.target, status: redirect.status, keepPath: redirect.keepPath, keepQuery: redirect.keepQuery, ...(siteHosts ? { hosts: siteHosts } : {}) };
    },
    async remove(source) {
      log.push(`remove:${source}`);
      delete hosts[source];
      delete current[source];
    },
  };
}

function setupEnv(options: { pdns?: FakePowerDns; pdns2?: FakePowerDns; cf?: FakeCloudflare; ipv4?: string; ipv6?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dns-powerdns-"));
  dirs.push(dir);
  writeFileSync(join(dir, "dns.conf"), "enabled");
  const pdns = options.pdns ?? new FakePowerDns();
  const pdns2 = options.pdns2;
  const cf = options.cf ?? new FakeCloudflare();
  const mailcow = new FakeMailcow();
  const sites: PanelSite[] = [];
  const standIns = makeStandIns();
  const custom: { current: { name: string; issued: boolean } | undefined } = { current: undefined };

  const cfAndMailcow = routed(cf, mailcow);
  const fetcher: ApiFetch = async (url, init) => {
    if (url.startsWith("https://api.cloudflare.com") || url.startsWith("https://mail.example.net")) return cfAndMailcow(url, init);
    if (url.startsWith("http://127.0.0.1:8082") && pdns2) return pdns2.handle(url, init);
    if (url.startsWith(PDNS_URL) || url.startsWith("https://ns1.example.com")) return pdns.handle(url, init);
    throw new Error(`Unexpected fetch to ${url}`);
  };

  const actionOptions = {
    paths: {
      configFile: join(dir, "dns.conf"),
      stateDir: join(dir, "state"),
      smtpConfig: join(dir, "smtp.json"),
      lockFile: join(dir, "dns.lock"),
      panelDb: join(dir, "db.sq3"),
      rootUid: process.getuid!(),
      clpctl: "/bin/false",
    },
    processUid: 0,
    fetch: fetcher,
    sites: () => sites,
    addresses: () => ({ ipv4: options.ipv4 ?? "203.0.113.10", ipv6: options.ipv6 ?? "2001:db8::10" }),
    standIns: () => standIns,
    customDomain: () => custom.current,
    now: () => START,
  };

  const act = async <T = DnsReply>(verb: string, body?: unknown): Promise<T> =>
    await executeDnsAction([verb], { ...actionOptions, input: body === undefined ? undefined : JSON.stringify(body) }) as T;

  const apply = async (verb: string, body: unknown): Promise<DnsReply> => {
    const reply = await act(verb, body);
    return reply.review ? act("confirm", { token: reply.review.token }) : reply;
  };

  return { dir, pdns, cf, mailcow, sites, standIns, custom, actionOptions, act, apply };
}

describe("PowerDNS URL validation", () => {
  test("accepts https for public hosts and http only for loopback, RFC 1918, Tailscale and IPv6 ULA", () => {
    expect(parsePowerDnsUrl("https://ns1.example.com")).toBe("https://ns1.example.com");
    expect(parsePowerDnsUrl("https://ns1.example.com:8443/pdns/api/v1/")).toBe("https://ns1.example.com:8443/pdns");
    expect(parsePowerDnsUrl("http://localhost:8081/")).toBe("http://localhost:8081");
    expect(parsePowerDnsUrl("http://127.0.0.1:8081/api/v1")).toBe("http://127.0.0.1:8081");
    expect(parsePowerDnsUrl("http://[::1]:8081")).toBe("http://[::1]:8081");
    expect(parsePowerDnsUrl("http://10.0.0.5:8081")).toBe("http://10.0.0.5:8081");
    expect(parsePowerDnsUrl("http://172.16.0.1:8081")).toBe("http://172.16.0.1:8081");
    expect(parsePowerDnsUrl("http://172.31.255.254:8081")).toBe("http://172.31.255.254:8081");
    expect(parsePowerDnsUrl("http://192.168.1.10:8081")).toBe("http://192.168.1.10:8081");
    expect(parsePowerDnsUrl("http://100.64.0.1:8081")).toBe("http://100.64.0.1:8081");
    expect(parsePowerDnsUrl("http://100.127.255.254:8081")).toBe("http://100.127.255.254:8081");
    expect(parsePowerDnsUrl("http://[fc00::1]:8081")).toBe("http://[fc00::1]:8081");
    expect(parsePowerDnsUrl("http://[fd12:3456:789a::1]:8081")).toBe("http://[fd12:3456:789a::1]:8081");
  });

  test("rejects public plain HTTP, link-local HTTP, credentials, query strings and fragments", () => {
    for (const bad of [
      "http://ns1.example.com:8081",
      "http://203.0.113.10:8081",
      "http://172.32.0.1:8081",
      "http://172.15.0.1:8081",
      "http://100.63.255.255:8081",
      "http://100.128.0.1:8081",
      "http://[2001:db8::1]:8081",
      "http://[fe80::1]:8081",
      "https://user:pass@ns1.example.com",
      "https://ns1.example.com/?key=1",
      "https://ns1.example.com/#frag",
      "ftp://127.0.0.1:8081",
    ]) {
      expect(() => parsePowerDnsUrl(bad)).toThrow();
    }
  });
});

describe("PowerDNS wire formatting and TXT chunking", () => {
  test("splits TXT into UTF-8 byte-safe 255-octet chunks without splitting code points", () => {
    const longAscii = `v=DKIM1; k=rsa; p=${"A".repeat(400)}`;
    const quotedAscii = quotePowerDnsTxt(longAscii);
    const chunks = [...quotedAscii.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!);
    expect(chunks.length).toBe(2);
    for (const chunk of chunks) expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(255);
    expect(unquoteTxt(quotedAscii)).toBe(longAscii);

    // 254 ASCII bytes + 2-byte character + 4-byte emoji forces clean boundary splits.
    const multiByte = `${"a".repeat(254)}é🔒"quote\\slash`;
    const quotedMulti = quotePowerDnsTxt(multiByte);
    const multiChunks = [...quotedMulti.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!.replace(/\\(["\\])/g, "$1"));
    expect(multiChunks.length).toBe(2);
    expect(multiChunks[0]).toBe("a".repeat(254));
    expect(multiChunks[1]).toBe('é🔒"quote\\slash');
    for (const chunk of multiChunks) expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(255);
    expect(unquoteTxt(quotedMulti)).toBe(multiByte);
  });

  test("formats CNAME, MX, SRV and CAA with canonical trailing dots and produces deterministic synthetic IDs", () => {
    expect(formatPowerDnsContent({ type: "CNAME", name: "www.example.com", content: "example.com", proxied: false, ttl: 300, priority: null })).toBe("example.com.");
    expect(formatPowerDnsContent({ type: "MX", name: "example.com", content: "mail.example.net", proxied: false, ttl: 300, priority: 10 })).toBe("10 mail.example.net.");
    expect(formatPowerDnsContent({ type: "SRV", name: "_autodiscover._tcp.example.com", content: "0 443 mail.example.net", proxied: false, ttl: 300, priority: 0 })).toBe("0 0 443 mail.example.net.");
    expect(formatPowerDnsContent({ type: "CAA", name: "example.com", content: '0 issue "letsencrypt.org"', proxied: false, ttl: 300, priority: null })).toBe('0 issue "letsencrypt.org"');
    const id1 = powerDnsRecordId("A", "example.com", "203.0.113.10", null);
    const id2 = powerDnsRecordId("A", "EXAMPLE.COM", "203.0.113.10", null);
    expect(id1).toMatch(/^pdns:[a-f0-9]{32}$/);
    expect(id1).toBe(id2);
  });
});

describe("PowerDNS end-to-end DNS reconciliation", () => {
  test("writes records atomically via RRset PATCH, preserves unmanaged TXT siblings, resolves Auto TTL and skips Cloudflare settings", async () => {
    const env = setupEnv();
    env.pdns.addZone("example.com", [
      { name: "example.com.", type: "TXT", ttl: 300, records: [{ content: '"google-site-verification=keep-me"', disabled: false }] },
    ]);
    env.sites.push(makeSite(1, "example.com"));

    const savedConn = await env.act("save-connection", {
      provider: "powerdns",
      label: "Primary NS",
      url: PDNS_URL,
      apiKey: PDNS_KEY,
      serverId: "localhost",
      defaultTtl: 600,
      createZones: false,
      nameservers: [],
    });
    expect(savedConn.connections).toHaveLength(1);
    expect(savedConn.connections[0]).toMatchObject({ provider: "powerdns", label: "Primary NS", active: true, zones: 1, defaultTtl: 600, createZones: false });
    expect("apiKey" in savedConn.connections[0]!).toBe(false);
    expect(statSync(join(env.dir, "state", "secrets.json")).mode & 0o777).toBe(0o600);

    await env.act("save-profile", {
      name: "Full",
      mailcow: false,
      zone: { ssl: "strict", alwaysHttps: true, acmeFullSsl: true, webmailFullSsl: false, skipFirewallIps: [] },
      records: [
        { type: "A", name: "{domain}", content: "{ipv4}", proxied: true, ttl: 1, priority: null, apexOnly: false },
        { type: "AAAA", name: "{domain}", content: "{ipv6}", proxied: true, ttl: 1, priority: null, apexOnly: false },
        { type: "CNAME", name: "www.{domain}", content: "{domain}", proxied: false, ttl: 1800, priority: null, apexOnly: true },
        { type: "MX", name: "{domain}", content: "mail.example.net", proxied: false, ttl: 1, priority: 10, apexOnly: false },
        { type: "SRV", name: "_autodiscover._tcp.{domain}", content: "0 443 mail.example.net", proxied: false, ttl: 1, priority: 5, apexOnly: true },
        { type: "CAA", name: "{domain}", content: '0 issue "letsencrypt.org"', proxied: false, ttl: 1, priority: null, apexOnly: false },
        { type: "TXT", name: "{domain}", content: "v=spf1 mx ~all", proxied: false, ttl: 1, priority: null, apexOnly: false },
      ],
    });
    await env.act("assign", { domains: ["example.com"], profileId: "full" });
    const after = await env.apply("set-automatic", { automatic: true });

    // Single atomic RRset PATCH for the site, zero Cloudflare calls.
    expect(env.pdns.patches()).toHaveLength(1);
    expect(env.cf.calls).toHaveLength(0);
    expect(env.pdns.recordsSummary("example.com")).toEqual([
      "A example.com. 600 203.0.113.10",
      "AAAA example.com. 600 2001:db8::10",
      'CAA example.com. 600 0 issue "letsencrypt.org"',
      "CNAME www.example.com. 1800 example.com.",
      "MX example.com. 600 10 mail.example.net.",
      "SRV _autodiscover._tcp.example.com. 600 5 0 443 mail.example.net.",
      'TXT example.com. 600 "google-site-verification=keep-me"',
      'TXT example.com. 600 "v=spf1 mx ~all"',
    ]);
    expect(after.sites[0]!.plan!.changes).toEqual([]);
    expect(after.sites[0]!.plan!.problems).toEqual([]);

    // Deleting the site tracks orphans; removing them sends DELETE on emptied RRsets and REPLACE preserving unmanaged TXT.
    env.sites.length = 0;
    const listed = await env.act("list");
    expect(listed.orphans).toEqual([{ domain: "example.com", zone: "example.com", records: 7 }]);
    const removed = await env.apply("remove-records", { domain: "example.com" });
    expect(removed.orphans).toEqual([]);
    expect(env.pdns.recordsSummary("example.com")).toEqual([
      'TXT example.com. 600 "google-site-verification=keep-me"',
    ]);
    const lastPatch = env.pdns.patches().at(-1)!.body as { rrsets: { name: string; type: string; changetype: string }[] };
    expect(lastPatch.rrsets.find((r) => r.type === "A")?.changetype).toBe("DELETE");
    expect(lastPatch.rrsets.find((r) => r.type === "TXT")?.changetype).toBe("REPLACE");
  });

  test("creates missing Native zones only when createZones is enabled", async () => {
    const env = setupEnv();
    env.sites.push(makeSite(1, "newsite.example"));

    const conn = await env.act("save-connection", {
      provider: "powerdns",
      label: "Primary NS",
      url: PDNS_URL,
      apiKey: PDNS_KEY,
      createZones: false,
      nameservers: [],
    });
    const connId = conn.connections[0]!.id;
    await env.act("assign", { domains: ["newsite.example"], profileId: "web" });
    const blockedReview = await env.act("set-automatic", { automatic: true });
    expect(blockedReview.review!.blocked).toBe(true);
    expect(blockedReview.review!.sites[0]!.problems[0]).toContain("no connection reaches an account to create it in");

    // Enable zone creation with configured nameservers, then confirm creation.
    await env.act("save-connection", {
      id: connId,
      provider: "powerdns",
      label: "Primary NS",
      url: PDNS_URL,
      createZones: true,
      nameservers: ["ns1.example.net", "ns2.example.net"],
    });
    const applied = await env.apply("set-automatic", { automatic: true });
    expect(env.pdns.zones.has("newsite.example.")).toBe(true);
    expect(env.pdns.recordsSummary("newsite.example")).toEqual([
      "A *.newsite.example. 300 203.0.113.10",
      "A newsite.example. 300 203.0.113.10",
      "AAAA *.newsite.example. 300 2001:db8::10",
      "AAAA newsite.example. 300 2001:db8::10",
    ]);
    expect(applied.log.some((entry) => entry.subject === "PowerDNS zone" && entry.action === "create")).toBe(true);
  });

  test("redirects on PowerDNS keep local stand-in sites active and publish unproxied server A/AAAA plus non-web profile rows", async () => {
    const env = setupEnv();
    env.pdns.addZone("old.example");
    await env.act("save-connection", { provider: "powerdns", label: "Primary NS", url: PDNS_URL, apiKey: PDNS_KEY });
    await env.act("save-profile", {
      name: "Mail",
      mailcow: false,
      zone: { ssl: null, alwaysHttps: null, acmeFullSsl: false, webmailFullSsl: false, skipFirewallIps: [] },
      records: [
        { type: "A", name: "{domain}", content: "198.51.100.9", proxied: false, ttl: 300, priority: null, apexOnly: false },
        { type: "MX", name: "{domain}", content: "mail.example.net", proxied: false, ttl: 300, priority: 10, apexOnly: false },
        { type: "TXT", name: "{domain}", content: "v=spf1 -all", proxied: false, ttl: 300, priority: null, apexOnly: false },
      ],
    });
    await env.act("save-redirect", { source: "old.example", target: "https://new.example", status: 301, keepPath: true, keepQuery: true, profileId: "mail" });
    await env.apply("set-automatic", { automatic: true });

    // Local stand-in stays active and PowerDNS holds server A/AAAA (never 100::) plus MX/SPF.
    expect(env.standIns.current["old.example"]).toBeDefined();
    expect(env.standIns.log).toEqual(["create:old.example"]);
    expect(env.pdns.recordsSummary("old.example")).toEqual([
      "A old.example. 300 203.0.113.10",
      "A www.old.example. 300 203.0.113.10",
      "AAAA old.example. 300 2001:db8::10",
      "AAAA www.old.example. 300 2001:db8::10",
      "MX old.example. 300 10 mail.example.net.",
      'TXT old.example. 300 "v=spf1 -all"',
    ]);

    // Deleting the redirect removes the stand-in directly without touching Cloudflare rulesets.
    await env.act("delete-redirect", { source: "old.example" });
    expect(env.standIns.current["old.example"]).toBeUndefined();
    expect(env.standIns.log).toEqual(["create:old.example", "remove:old.example"]);
  });

  test("panel hostname on PowerDNS stays unproxied, hands off to unproxied wildcards, and makes no proxy change on cert issuance", async () => {
    const env = setupEnv();
    env.pdns.addZone("example.com");
    await env.act("save-connection", { provider: "powerdns", label: "Primary NS", url: PDNS_URL, apiKey: PDNS_KEY });
    await env.apply("set-automatic", { automatic: true });

    const saved = await env.apply("set-panel-host", { name: "panel.example.com" });
    expect(saved.panelHost).toMatchObject({ name: "panel.example.com", proxied: false, problem: null });
    expect(env.pdns.recordsSummary("example.com")).toEqual([
      "A panel.example.com. 300 203.0.113.10",
      "AAAA panel.example.com. 300 2001:db8::10",
    ]);

    // Certificate issuance leaves PowerDNS records unproxied and emits no Cloudflare proxy message.
    const patchesBefore = env.pdns.patches().length;
    env.custom.current = { name: "panel.example.com", issued: true };
    expect(await DNS_ADDON.certificates!.run(env.actionOptions)).toBeNull();
    expect(env.pdns.patches().length).toBe(patchesBefore);
    const afterState = await env.act("list");
    expect(afterState.panelHost!.proxied).toBe(false);
    expect(dashboardContent(afterState)).not.toContain("proxied through Cloudflare");
    expect(dashboardContent(afterState)).toContain("pointed directly at this server");

    // Adding an apex site with an unproxied wildcard hands the panel hostname off to *.example.com.
    env.sites.push(makeSite(1, "example.com"));
    await env.apply("assign", { domains: ["example.com"], profileId: "web" });
    expect(env.pdns.recordsSummary("example.com")).toEqual([
      "A *.example.com. 300 203.0.113.10",
      "A example.com. 300 203.0.113.10",
      "AAAA *.example.com. 300 2001:db8::10",
      "AAAA example.com. 300 2001:db8::10",
    ]);
  });

  test("manages a mixed Cloudflare and PowerDNS fleet in one run and flags duplicate PowerDNS zones as a choice", async () => {
    const pdns2 = new FakePowerDns("pdns-second-key-9876543210");
    pdns2.addZone("shared.example");
    const env = setupEnv({ pdns2 });
    const agency = env.cf.account("Agency");
    env.cf.token(CF_TOKEN, { owner: "user", accounts: [agency], zoneEdit: true });
    env.cf.zone("cf-site.example", agency);
    env.pdns.addZone("pdns-site.example");
    env.pdns.addZone("shared.example");
    env.sites.push(makeSite(1, "cf-site.example"), makeSite(2, "pdns-site.example"), makeSite(3, "shared.example"));

    await env.act("save-connection", { provider: "cloudflare", token: CF_TOKEN });
    await env.act("save-connection", { provider: "powerdns", label: "NS1", url: PDNS_URL, apiKey: PDNS_KEY });
    await env.act("assign", { domains: ["cf-site.example", "pdns-site.example"], profileId: "web" });
    await env.apply("set-automatic", { automatic: true });

    expect(env.cf.recordsOf("cf-site.example").some((r) => r.type === "A" && r.name === "cf-site.example" && r.proxied === true)).toBe(true);
    expect(env.pdns.recordsSummary("pdns-site.example")).toEqual([
      "A *.pdns-site.example. 300 203.0.113.10",
      "A pdns-site.example. 300 203.0.113.10",
      "AAAA *.pdns-site.example. 300 2001:db8::10",
      "AAAA pdns-site.example. 300 2001:db8::10",
    ]);

    // Adding a second PowerDNS server with the same zone name forces an explicit zone choice rather than colliding.
    await env.act("save-connection", { provider: "powerdns", label: "NS2", url: "http://127.0.0.1:8082", apiKey: "pdns-second-key-9876543210" });
    const choiceReview = await env.act("assign", { domains: ["shared.example"], profileId: "web" });
    expect(choiceReview.review!.blocked).toBe(true);
    expect(choiceReview.review!.sites[0]!.zoneChoices).toHaveLength(2);
  });

  test("redacts PowerDNS API keys on failure, refuses key reuse across URL change, satisfies Setup, and hides Cloudflare controls in PowerDNS-only UI", async () => {
    const env = setupEnv();
    env.pdns.addZone("example.com");

    // Failed auth redacts the API key from the error returned to the caller.
    const badKey = "wrong-secret-key-99999999";
    await expect(env.act("save-connection", {
      provider: "powerdns", label: "Primary NS", url: PDNS_URL, apiKey: badKey,
    })).rejects.toThrow(/\[redacted\]|Unauthorized/);
    try {
      await env.act("save-connection", { provider: "powerdns", label: "Primary NS", url: PDNS_URL, apiKey: badKey });
    } catch (error) {
      expect((error as Error).message).not.toContain(badKey);
    }

    // Non-authoritative PowerDNS daemon (e.g. recursor) is refused cleanly.
    env.pdns.daemonType = "recursor";
    await expect(env.act("save-connection", {
      provider: "powerdns", label: "Primary NS", url: PDNS_URL, apiKey: PDNS_KEY,
    })).rejects.toThrow("not an authoritative server");
    env.pdns.daemonType = "authoritative";

    const state = await env.act("save-connection", {
      provider: "powerdns", label: "Primary NS", url: PDNS_URL, apiKey: PDNS_KEY,
    });
    const id = state.connections[0]!.id;

    // Changing URL without providing a new API key refuses to send the old key to the new host.
    await expect(env.act("save-connection", {
      id, provider: "powerdns", label: "Primary NS", url: "https://ns1.example.com",
    })).rejects.toThrow("Enter the PowerDNS API key");

    // Setup step dns-connection is satisfied by PowerDNS alone, with zero Cloudflare permission warnings.
    const policy = { ...seededPolicy(), powerdns: [{ id, label: "Primary NS", url: PDNS_URL, serverId: "localhost", defaultTtl: 300, createZones: false, nameservers: [] }] };
    const setupState = { policy, tokens: new Set([id]), reports: [{ id, active: true, error: null }] };
    expect(connectionCheck(setupState)).toEqual({ state: "done", reason: "PowerDNS: Primary NS" });
    expect(permissionActions(setupState)).toEqual([]);

    // PowerDNS-only HTML omits Cloudflare redirect discovery and Cloudflare zone table column, and shows PowerDNS badge.
    const html = dashboardContent(state);
    expect(html).not.toContain("Find redirects in Cloudflare");
    expect(html).toContain("PowerDNS");
    expect(html).toContain("<th>Options</th>");
    expect(readFileSync(join(env.dir, "state", "secrets.json"), "utf8")).toContain(PDNS_KEY);

    // Direct provider class check confirms capabilities flags.
    const provider = new PowerDnsProvider(policy.powerdns[0]!, PDNS_KEY);
    expect(provider.capabilities).toEqual({
      proxy: false,
      zoneSettings: false,
      zoneRules: false,
      edgeRedirects: false,
      createZone: false,
      autoTtl: false,
      comments: false,
    });
  });

  test("preserves disabled RRset siblings and explicit TTL 0 when removing managed TXT records", async () => {
    const pdns = new FakePowerDns();
    const zone = pdns.addZone("example.com", [
      // Case 1: enabled SPF + enabled verification TXT + disabled verification TXT.
      {
        name: "both.example.com.",
        type: "TXT",
        ttl: 300,
        records: [
          { content: "\"v=spf1 a -all\"", disabled: false },
          { content: "\"google-site-verification=active\"", disabled: false },
          { content: "\"v=verify-disabled-with-active\"", disabled: true },
        ],
      },
      // Case 2: enabled SPF + ONLY disabled verification TXT (no other enabled sibling) with explicit TTL 0.
      {
        name: "only-disabled.example.com.",
        type: "TXT",
        ttl: 0,
        records: [
          { content: "\"v=spf1 a -all\"", disabled: false },
          { content: "\"v=verify-disabled-alone\"", disabled: true },
        ],
      },
      // Case 3: enabled SPF + enabled unmanaged TXT sibling at TTL 0.
      {
        name: "zero-ttl.example.com.",
        type: "TXT",
        ttl: 0,
        records: [
          { content: "\"v=spf1 a -all\"", disabled: false },
          { content: "\"unmanaged-zero-ttl\"", disabled: false },
        ],
      },
    ]);

    const provider = new PowerDnsProvider(
      { label: "Primary NS", url: PDNS_URL, serverId: "localhost", defaultTtl: 300, createZones: false, nameservers: [] },
      PDNS_KEY,
      async (url, init) => pdns.handle(url, init),
    );
    const dnsZone = { id: zone.id, name: "example.com", status: "active", nameServers: [], account: { id: "localhost", name: "Primary NS" } };
    const listed = await provider.listRecords(dnsZone);

    // Disabled records are excluded from the matching view, while explicit TTL 0 is preserved on enabled records.
    expect(listed.some((r) => r.content.includes("verify-disabled"))).toBe(false);
    expect(listed.find((r) => r.name === "zero-ttl.example.com" && r.content === "unmanaged-zero-ttl")?.ttl).toBe(0);

    const spfBoth = listed.find((r) => r.name === "both.example.com" && r.content === "v=spf1 a -all")!;
    const spfOnlyDisabled = listed.find((r) => r.name === "only-disabled.example.com" && r.content === "v=spf1 a -all")!;
    const spfZeroTtl = listed.find((r) => r.name === "zero-ttl.example.com" && r.content === "v=spf1 a -all")!;

    await provider.applyRecords(dnsZone, [
      { action: "delete", record: spfBoth, current: spfBoth },
      { action: "delete", record: spfOnlyDisabled, current: spfOnlyDisabled },
      { action: "delete", record: spfZeroTtl, current: spfZeroTtl },
    ], listed);

    const lastPatch = pdns.patches().at(-1)!.body as { rrsets: { name: string; type: string; ttl?: number; changetype: string; records?: { content: string; disabled: boolean }[] }[] };
    const bothPatch = lastPatch.rrsets.find((r) => r.name === "both.example.com.");
    expect(bothPatch).toEqual({
      name: "both.example.com.",
      type: "TXT",
      ttl: 300,
      changetype: "REPLACE",
      records: [
        { content: "\"google-site-verification=active\"", disabled: false },
        { content: "\"v=verify-disabled-with-active\"", disabled: true },
      ],
    });

    // No DELETE is sent when a disabled sibling remains; explicit TTL 0 is preserved too.
    const onlyDisabledPatch = lastPatch.rrsets.find((r) => r.name === "only-disabled.example.com.");
    expect(onlyDisabledPatch).toEqual({
      name: "only-disabled.example.com.",
      type: "TXT",
      ttl: 0,
      changetype: "REPLACE",
      records: [
        { content: "\"v=verify-disabled-alone\"", disabled: true },
      ],
    });

    const zeroTtlPatch = lastPatch.rrsets.find((r) => r.name === "zero-ttl.example.com.");
    expect(zeroTtlPatch).toEqual({
      name: "zero-ttl.example.com.",
      type: "TXT",
      ttl: 0,
      changetype: "REPLACE",
      records: [
        { content: "\"unmanaged-zero-ttl\"", disabled: false },
      ],
    });
  });

  test("rejects conflicting TTLs in one PowerDNS RRset, matches stand-in hosts to zone apex, holds redirects on removal, and isolates endpoint edits", async () => {
    const pdns2 = new FakePowerDns("pdns-second-key-9876543210");
    pdns2.addZone("example.com", [
      { name: "orphan.example.com.", type: "A", ttl: 300, records: [{ content: "203.0.113.10", disabled: false }] },
    ]);
    const env = setupEnv({ pdns2 });
    const agency = env.cf.account("Agency");
    env.cf.token(CF_TOKEN, { owner: "user", accounts: [agency], zoneEdit: true });
    env.cf.zone("shared.example", agency);
    env.pdns.addZone("example.com");
    env.pdns.addZone("shop.example.com");
    env.pdns.addZone("shared.example");
    env.sites.push(makeSite(1, "orphan.example.com"), makeSite(2, "conflict.example.com"));

    const saved = await env.act("save-connection", { provider: "powerdns", label: "NS1", url: PDNS_URL, apiKey: PDNS_KEY });
    const pdnsId = saved.connections[0]!.id;

    // 1. Conflicting TTLs in one PowerDNS RRset fail planning instead of oscillating.
    const badProfile = await env.act("save-profile", {
      name: "Mixed TTL",
      records: [
        { type: "A", name: "{domain}", content: "203.0.113.10", proxied: false, ttl: 300 },
        { type: "A", name: "{domain}", content: "203.0.113.11", proxied: false, ttl: 600 },
      ],
    });
    const badId = badProfile.profiles.find((p) => p.name === "Mixed TTL")!.id;
    await env.act("assign", { domains: ["conflict.example.com"], profileId: badId });
    const badReview = await env.act("set-automatic", { automatic: true });
    expect(badReview.review!.blocked).toBe(true);
    expect(badReview.review!.sites.find((s) => s.domain === "conflict.example.com")!.problems.join("\n")).toContain("different TTLs");

    // Clean up conflict site, manage orphan.example.com on NS1, then delete site so it becomes an orphan.
    await env.act("assign", { domains: ["conflict.example.com"], profileId: null });
    await env.act("assign", { domains: ["orphan.example.com"], profileId: "web" });
    await env.apply("set-automatic", { automatic: true });

    // 2. Stand-in site for a redirect at the apex of a sub-zone gets both source and www.source.
    await env.apply("save-redirect", {
      source: "shop.example.com", target: "https://dest.example/", status: 301, keepPath: true, keepQuery: true, profileId: null,
    });
    expect(env.standIns.hosts["shop.example.com"]).toEqual(["shop.example.com", "www.shop.example.com"]);
    expect(standInBody("shop.example.com", env.standIns.current["shop.example.com"]!)).toContain("server_name shop.example.com www.shop.example.com;");

    // 3. sync-panel-host returns null when no provider resolves for panelHost; pending PowerDNS copy avoids Cloudflare fallback.
    await env.act("set-panel-host", { name: "panel.unmanaged.test" });
    env.custom.current = { name: "panel.unmanaged.test", issued: true };
    const noProviderSync = await env.act("sync-panel-host") as unknown as { line: string | null };
    expect(noProviderSync.line).toBeNull();

    // Pending PowerDNS panel host with issued custom domain stays out of Cloudflare fallback.
    await env.apply("set-panel-host", { name: "panel.example.com" });
    env.custom.current = { name: "panel.example.com", issued: true };
    env.pdns.rrsetsOf("example.com").find((r) => r.name === "panel.example.com." && r.type === "A")!.records[0]!.content = "198.51.100.1";
    const pendingPanelState = await env.act("set-automatic", { automatic: false });
    const pendingHtml = dashboardContent(pendingPanelState);
    expect(pendingHtml).not.toContain("proxies it through Cloudflare once issued");
    expect(pendingHtml).toContain("DNS asks first");
    await env.act("set-panel-host", { name: null });
    await env.apply("set-automatic", { automatic: true });

    // 4. Removing a PowerDNS connection holds redirects whose zone choice pointed to it so Cloudflare does not silently take over.
    await env.act("save-connection", { provider: "cloudflare", token: CF_TOKEN });
    await env.act("choose-zone", { zone: "shared.example", connectionId: pdnsId, zoneId: "shared.example." });
    await env.apply("save-redirect", {
      source: "shared.example", target: "https://target.example/", status: 301, keepPath: true, keepQuery: true, profileId: null,
    });
    expect(env.standIns.current["shared.example"]).toBeDefined();

    // Remove the site orphan.example.com before editing NS1 to a different server (NS2).
    env.sites.splice(0, 1);
    const edited = await env.act("save-connection", {
      id: pdnsId, provider: "powerdns", label: "NS2", url: "http://127.0.0.1:8082", apiKey: "pdns-second-key-9876543210",
    });
    const newPdnsId = edited.connections.find((c) => c.provider === "powerdns")!.id;
    expect(newPdnsId).not.toBe(pdnsId);
    // Old orphan from NS1 cannot touch NS2's identical record because the connection identity changed.
    await expect(env.act("remove-records", { domain: "orphan.example.com" })).rejects.toThrow("connection these records were tracked through has been removed");
    // Redirect on shared.example is held rather than silently moved to Cloudflare.
    const afterCheck = await env.act("check");
    const sharedSite = afterCheck.sites.find((s) => s.domain === "shared.example");
    expect(sharedSite?.plan?.held).toBe(true);
    expect(env.standIns.current["shared.example"]).toBeDefined();
    expect(env.cf.rulesets.size).toBe(0);

    // Explicitly removing a PowerDNS connection holding a chosen redirect also holds that redirect for review.
    env.cf.zone("remove-hold.example", agency);
    pdns2.addZone("remove-hold.example");
    await env.act("check");
    await env.act("choose-zone", { zone: "remove-hold.example", connectionId: newPdnsId, zoneId: "remove-hold.example." });
    await env.apply("save-redirect", {
      source: "remove-hold.example", target: "https://target.example/", status: 301, keepPath: true, keepQuery: true, profileId: null,
    });
    await env.act("remove-connection", { id: newPdnsId });
    const afterRemove = await env.act("check");
    expect(afterRemove.sites.find((s) => s.domain === "remove-hold.example")?.plan?.held).toBe(true);
    expect(env.standIns.current["remove-hold.example"]).toBeDefined();
    expect(env.cf.rulesets.size).toBe(0);
  });

  test("rejects dot path-traversal server IDs and keeps disabled RRset state consistent on failed or shadowing PATCH", async () => {
    expect(() => parsePowerDnsServerId(".")).toThrow("PowerDNS server ID");
    expect(() => parsePowerDnsServerId("..")).toThrow("PowerDNS server ID");
    expect(parsePowerDnsServerId("ns.1-a_b")).toBe("ns.1-a_b");

    const pdns = new FakePowerDns(PDNS_KEY);
    pdns.addZone("example.com", [
      {
        name: "example.com.",
        type: "A",
        ttl: 300,
        records: [
          { content: "198.51.100.1", disabled: false },
          { content: "203.0.113.10", disabled: true },
          { content: "203.0.113.99", disabled: true },
        ],
      },
    ]);
    let failPatch = true;
    const provider = new PowerDnsProvider(
      { label: "NS1", url: PDNS_URL, serverId: "localhost", defaultTtl: 600, createZones: false, nameservers: [] },
      PDNS_KEY,
      async (input, init) => {
        if (failPatch && init?.method === "PATCH") return new Response("boom", { status: 500 });
        return pdns.handle(input, init ?? {});
      },
    );
    const zone = (await provider.discover()).zones[0]!;
    const current = await provider.listRecords(zone);
    // Failed PATCH must not mutate cached disabled TTLs.
    await expect(provider.applyRecords(zone, [{
      action: "create",
      record: { type: "A", name: "example.com", content: "203.0.113.10", proxied: false, ttl: 600, priority: null },
    }], current)).rejects.toThrow();

    // Retry succeeds: enabled 203.0.113.10 shadows the disabled duplicate 203.0.113.10 while preserving 203.0.113.99.
    failPatch = false;
    const afterCreate = await provider.applyRecords(zone, [{
      action: "create",
      record: { type: "A", name: "example.com", content: "203.0.113.10", proxied: false, ttl: 600, priority: null },
    }], current);
    const added = afterCreate.find((r) => r.content === "203.0.113.10")!;
    expect(pdns.rrsetsOf("example.com").find((r) => r.type === "A" && r.name === "example.com.")!.records)
      .toEqual([
        { content: "198.51.100.1", disabled: false },
        { content: "203.0.113.10", disabled: false },
        { content: "203.0.113.99", disabled: true },
      ]);
    // Deleting the enabled 203.0.113.10 in the same provider session must NOT re-introduce the shadowed disabled duplicate.
    await provider.applyRecords(zone, [{ action: "delete", record: added, current: added }], afterCreate);
    expect(pdns.rrsetsOf("example.com").find((r) => r.type === "A" && r.name === "example.com.")!.records)
      .toEqual([
        { content: "198.51.100.1", disabled: false },
        { content: "203.0.113.99", disabled: true },
      ]);
  });

  test("holds redirects on partial Cloudflare removal with PowerDNS remaining and on PowerDNS sub-zone apex stand-in shrink", async () => {
    // 1. Mixed fleet: cf-1 (example.com), cf-2 (other.example), pdns-1 (example.com) -> removing cf-1 holds example.com.
    const env = setupEnv();
    env.pdns.addZone("example.com");
    const SECOND_CF_TOKEN = "cf-second-token-0123456789abcdef";
    const agency1 = env.cf.account("Agency One");
    const agency2 = env.cf.account("Agency Two");
    env.cf.zone("example.com", agency1);
    env.cf.zone("other.example", agency2);
    env.cf.token(CF_TOKEN, { owner: "user", accounts: [agency1] });
    env.cf.token(SECOND_CF_TOKEN, { owner: "user", accounts: [agency2] });
    const cf1 = (await env.act("save-connection", { provider: "cloudflare", token: CF_TOKEN, label: "CF1" }))
      .connections.find((c) => c.label === "CF1")!;
    await env.act("save-connection", { provider: "cloudflare", token: SECOND_CF_TOKEN, label: "CF2" });
    await env.act("save-connection", { provider: "powerdns", label: "NS1", url: PDNS_URL, apiKey: PDNS_KEY });
    await env.act("choose-zone", { zone: "example.com", connectionId: cf1.id, zoneId: env.cf.zones.find((z) => z.name === "example.com")!.id });
    await env.apply("set-automatic", { automatic: true });
    await env.apply("save-redirect", {
      source: "example.com", target: "https://target.example/", status: 301, keepPath: true, keepQuery: true, profileId: null,
    });
    expect(env.standIns.current["example.com"]).toBeUndefined();

    await env.act("remove-connection", { id: cf1.id });
    const afterPartial = await env.act("check");
    expect(afterPartial.sites.find((s) => s.domain === "example.com")?.plan?.held).toBe(true);
    expect(env.standIns.current["example.com"]).toBeUndefined();

    // 2. PowerDNS-only fleet with delegated sub-zone apex redirect: removing PowerDNS holds it rather than shrinking stand-in hosts.
    const pdnsOnly = setupEnv();
    pdnsOnly.pdns.addZone("shop.example.com");
    const connected = await pdnsOnly.act("save-connection", { provider: "powerdns", label: "NS1", url: PDNS_URL, apiKey: PDNS_KEY });
    const pdnsOnlyId = connected.connections.find((c) => c.provider === "powerdns")!.id;
    await pdnsOnly.apply("set-automatic", { automatic: true });
    await pdnsOnly.apply("save-redirect", {
      source: "shop.example.com", target: "https://target.example/", status: 301, keepPath: true, keepQuery: true, profileId: null,
    });
    expect(pdnsOnly.standIns.current["shop.example.com"]?.hosts).toEqual(["shop.example.com", "www.shop.example.com"]);
    await pdnsOnly.act("remove-connection", { id: pdnsOnlyId });
    const afterPdnsRemove = await pdnsOnly.act("check");
    expect(afterPdnsRemove.sites.find((s) => s.domain === "shop.example.com")?.plan?.held).toBe(true);
    expect(pdnsOnly.standIns.current["shop.example.com"]?.hosts).toEqual(["shop.example.com", "www.shop.example.com"]);

    // 3. PowerDNS-only user-facing notices do not claim Cloudflare.
    const pdnsCopy = setupEnv();
    pdnsCopy.pdns.addZone("example.com");
    await pdnsCopy.act("save-connection", { provider: "powerdns", label: "NS1", url: PDNS_URL, apiKey: PDNS_KEY });
    await pdnsCopy.apply("set-automatic", { automatic: true });
    await pdnsCopy.apply("set-panel-host", { name: "panel.example.com" });
    const removedPanel = await pdnsCopy.act("set-panel-host", { name: null });
    expect(removedPanel.notice).toContain("PowerDNS");
    expect(removedPanel.notice).not.toContain("Cloudflare");
    const askFirst = await pdnsCopy.act("set-automatic", { automatic: false });
    expect(askFirst.notice).toContain("PowerDNS");
    expect(askFirst.notice).not.toContain("Cloudflare");
    const forgotten = await pdnsCopy.act("forget-records", { domain: "panel.example.com" });
    expect(forgotten.notice).toContain("PowerDNS");
    expect(forgotten.notice).not.toContain("Cloudflare");
  });

  test("Admin Settings Custom Domain helper works on PowerDNS-only servers, flags newly created zones, and enforces wildcard guard", async () => {
    const env = setupEnv();
    // Wildcard covers IPv4 only; panelHost wants A + AAAA so writing AAAA at sub.example.com breaks app.sub.example.com's IPv4 wildcard coverage.
    env.pdns.addZone("example.com", [
      { name: "*.example.com.", type: "A", ttl: 300, records: [{ content: "203.0.113.10", disabled: false }] },
    ]);
    env.sites.push(
      { id: 1, domain: "example.com", type: "php", createdAt: START, selfSigned: false, cloudflareOnly: false },
      { id: 2, domain: "app.sub.example.com", type: "php", createdAt: START, selfSigned: false, cloudflareOnly: false },
    );
    await env.act("save-connection", {
      provider: "powerdns",
      label: "NS1",
      url: PDNS_URL,
      apiKey: PDNS_KEY,
      createZones: true,
      nameservers: ["ns1.example.net", "ns2.example.net"],
    });
    const helper = await env.act<{
      connected: boolean; automatic: boolean; hasCloudflare: boolean; hasPowerDns: boolean;
      zones: string[]; zoneProviders: Record<string, string>;
    }>("panel-host-helper");
    expect(helper.connected).toBe(true);
    expect(helper.hasCloudflare).toBe(false);
    expect(helper.hasPowerDns).toBe(true);
    expect(helper.zones).toEqual(["example.com"]);
    expect(helper.zoneProviders).toEqual({ "example.com": "powerdns" });

    const ipv4Only = await env.act("save-profile", {
      name: "IPv4 only",
      records: [
        { type: "A", name: "{domain}", content: "{ipv4}", proxied: false, ttl: 300, priority: null, apexOnly: false },
        { type: "A", name: "*.{domain}", content: "{ipv4}", proxied: false, ttl: 300, priority: null, apexOnly: true },
      ],
      mailcow: false,
      zone: { ssl: null, alwaysHttps: null, acmeFullSsl: false, webmailFullSsl: false, skipFirewallIps: [] },
    });
    const ipv4ProfileId = ipv4Only.profiles.find((p) => p.name === "IPv4 only")!.id;
    await env.act("assign", { domains: ["example.com", "app.sub.example.com"], profileId: ipv4ProfileId });
    await env.apply("set-automatic", { automatic: true });
    // Wildcard guard blocks writing AAAA at sub.example.com because it breaks app.sub.example.com's wildcard coverage.
    const blocked = await env.act("set-panel-host", { name: "sub.example.com", prepareOnly: true });
    expect(blocked.review!.blocked).toBe(true);
    expect(blocked.review!.sites[0]!.problems.join("\n")).toContain("app.sub.example.com");

    // PowerDNS prepareOnly wording avoids Cloudflare proxy copy.
    const prepared = await env.act("set-panel-host", { name: "panel.newzone.test", prepareOnly: true });
    expect(prepared.review!.blocked).toBe(false);
    expect(prepared.review!.text).not.toContain("Cloudflare");
    expect(prepared.review!.text).not.toContain("DNS only");

    // Confirming a brand-new PowerDNS zone sets zoneCreated: true so the helper pauses to show nameservers.
    const confirmed = await env.act("confirm", { token: prepared.review!.token });
    expect(confirmed.zoneCreated).toBe(true);
    expect(confirmed.panelHost?.plan?.zone?.provider).toBe("powerdns");
    expect(confirmed.panelHost?.plan?.zone?.name).toBe("newzone.test");
  });

  test("binds confirmation digest to zone connection, reports failed panel writes with fresh review, and preserves unmanaged TXT wire form", async () => {
    // 1. Confirmation digest detects when a zone shifts from PowerDNS NS1 to NS2 between preview and confirm.
    const pdns2 = new FakePowerDns("pdns-second-key-9876543210");
    const env = setupEnv({ pdns2 });
    env.pdns.addZone("shift.example");
    env.sites.push(makeSite(1, "shift.example"));
    await env.act("save-connection", { provider: "powerdns", label: "NS1", url: PDNS_URL, apiKey: PDNS_KEY });
    await env.act("save-connection", { provider: "powerdns", label: "NS2", url: "http://127.0.0.1:8082", apiKey: "pdns-second-key-9876543210" });
    await env.act("assign", { domains: ["shift.example"], profileId: "web" });
    const preview = await env.act("set-automatic", { automatic: true });
    expect(preview.review!.blocked).toBe(false);
    expect(preview.review!.sites[0]!.zone!.connection).toBe("NS1");

    // Zone moves from NS1 to NS2 with identical planned record changes before confirmation.
    env.pdns.zones.delete("shift.example.");
    pdns2.addZone("shift.example");
    const shifted = await env.act("confirm", { token: preview.review!.token });
    expect(shifted.review).toBeDefined();
    expect(shifted.review!.sites[0]!.zone!.connection).toBe("NS2");
    expect(pdns2.patches()).toHaveLength(0);

    // 2. Panel preparation reports provider PATCH failure and returns a fresh review instead of "DNS prepared".
    const failEnv = setupEnv();
    failEnv.pdns.addZone("panel-fail.example");
    await failEnv.act("save-connection", { provider: "powerdns", label: "NS1", url: PDNS_URL, apiKey: PDNS_KEY });
    const panelPreview = await failEnv.act("set-panel-host", { name: "cp.panel-fail.example", prepareOnly: true });
    let rejectPatch = true;
    const origHandle = failEnv.pdns.handle.bind(failEnv.pdns);
    failEnv.pdns.handle = (url, init) => {
      if (rejectPatch && (init.method ?? "GET").toUpperCase() === "PATCH") {
        return jsonResponse({ error: "Backend write refused" }, 500);
      }
      return origHandle(url, init);
    };
    const failedConfirm = await failEnv.act("confirm", { token: panelPreview.review!.token });
    expect(failedConfirm.notice).not.toContain("DNS prepared");
    expect(failedConfirm.error).toContain("Backend write refused");
    expect(failedConfirm.review).toBeDefined();
    expect(failedConfirm.review!.blocked).toBe(false);
    expect(failedConfirm.review!.token).not.toBe("");

    // Retrying with the fresh review token succeeds once the PowerDNS server accepts writes again.
    rejectPatch = false;
    const retried = await failEnv.act("confirm", { token: failedConfirm.review!.token });
    expect(retried.error).toBeUndefined();
    expect(retried.notice).toContain("DNS prepared cp.panel-fail.example");
    expect(failEnv.pdns.recordsSummary("panel-fail.example")).toEqual([
      "A cp.panel-fail.example. 300 203.0.113.10",
      "AAAA cp.panel-fail.example. 300 2001:db8::10",
    ]);

    // 3. Unmanaged TXT siblings with distinct wire forms (`"a" "b"` and `"ab"`) both survive RRset PATCH verbatim.
    const txtPdns = new FakePowerDns();
    const txtZone = txtPdns.addZone("txt.example", [
      {
        name: "txt.example.",
        type: "TXT",
        ttl: 300,
        records: [
          { content: '"a" "b"', disabled: false },
          { content: '"ab"', disabled: false },
        ],
      },
    ]);
    const provider = new PowerDnsProvider(
      { label: "NS1", url: PDNS_URL, serverId: "localhost", defaultTtl: 300, createZones: false, nameservers: [] },
      PDNS_KEY,
      async (url, init) => txtPdns.handle(url, init),
    );
    const dnsZone = { id: txtZone.id, name: "txt.example", status: "active", nameServers: [], account: { id: "localhost", name: "NS1" } };
    const listed = await provider.listRecords(dnsZone);
    expect(listed.filter((r) => r.type === "TXT")).toHaveLength(2);
    expect(new Set(listed.filter((r) => r.type === "TXT").map((r) => r.id)).size).toBe(2);
    await provider.applyRecords(dnsZone, [{
      action: "create",
      record: { type: "TXT", name: "txt.example", content: "v=spf1 mx ~all", proxied: false, ttl: 300, priority: null },
    }], listed);
    const txtRrset = txtPdns.rrsetsOf("txt.example").find((r) => r.type === "TXT" && r.name === "txt.example.")!;
    expect(txtRrset.records).toEqual([
      { content: '"a" "b"', disabled: false },
      { content: '"ab"', disabled: false },
      { content: '"v=spf1 mx ~all"', disabled: false },
    ]);
  });

  test("checks unread Cloudflare zones across tokens, preserves redirect holds after failed lookups, checks leftover Cloudflare rules on PowerDNS redirect deletion, and keeps PowerDNS keys after policy commit", async () => {
    // 1. Orphan tracked via CF token A is protected when current site's read of the same physical zone fails through CF token B.
    const orphanEnv = setupEnv();
    const tokenA = "cf-token-a-0123456789abcdef01234";
    const tokenB = "cf-token-b-0123456789abcdef01234";
    const acc = orphanEnv.cf.account("Shared");
    const sharedZone = orphanEnv.cf.zone("example.com", acc);
    orphanEnv.cf.token(tokenA, { owner: "user", accounts: [acc], zoneEdit: true });
    orphanEnv.cf.token(tokenB, { owner: "user", accounts: [acc], zoneEdit: true });
    orphanEnv.sites.push(makeSite(1, "old.example.com"), makeSite(2, "keep.example.com"));
    const cfA = (await orphanEnv.act("save-connection", { provider: "cloudflare", token: tokenA, label: "CFA" })).connections[0]!;
    await orphanEnv.act("assign", { domains: ["old.example.com", "keep.example.com"], profileId: "web" });
    await orphanEnv.apply("set-automatic", { automatic: true });

    // Remove old.example.com (leaving orphan tracked via cfA), add tokenB and point zoneChoice to tokenB whose DNS record read fails.
    orphanEnv.sites.splice(0, 1);
    const withB = await orphanEnv.act("save-connection", { provider: "cloudflare", token: tokenB, label: "CFB" });
    const cfB = withB.connections.find((c) => c.label === "CFB")!;
    await orphanEnv.apply("choose-zone", { zone: "example.com", connectionId: cfB.id, zoneId: sharedZone.id });
    const origFetch = orphanEnv.actionOptions.fetch;
    orphanEnv.actionOptions.fetch = async (url, init) => {
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      if (auth.includes(tokenB) && url.includes(`/zones/${sharedZone.id}/dns_records`)) {
        return jsonResponse({ success: false, errors: [{ code: 9109, message: "Forbidden on token B" }] }, 403);
      }
      return origFetch(url, init);
    };
    await expect(orphanEnv.act("remove-records", { domain: "old.example.com" })).rejects.toThrow("could not be read");
    expect(cfA.id).not.toBe(cfB.id);

    // 2. Removing CF1 via shared store after a failed zone lookup (zone: null on last plan) still holds redirect instead of moving to PowerDNS.
    const holdEnv = setupEnv();
    holdEnv.pdns.addZone("pdns-only.example");
    const cfTok1 = "cf-hold-1-0123456789abcdef01234";
    const cfTok2 = "cf-hold-2-0123456789abcdef01234";
    const acc1 = holdEnv.cf.account("Acc1");
    const acc2 = holdEnv.cf.account("Acc2");
    holdEnv.cf.zone("holdme.example", acc1);
    holdEnv.cf.zone("other.example", acc2);
    holdEnv.cf.token(cfTok1, { owner: "user", accounts: [acc1] });
    holdEnv.cf.token(cfTok2, { owner: "user", accounts: [acc2] });
    const cf1 = (await holdEnv.act("save-connection", { provider: "cloudflare", token: cfTok1, label: "CF1" })).connections[0]!;
    await holdEnv.act("save-connection", { provider: "cloudflare", token: cfTok2, label: "CF2" });
    await holdEnv.act("save-connection", { provider: "powerdns", label: "NS1", url: PDNS_URL, apiKey: PDNS_KEY });
    await holdEnv.apply("set-automatic", { automatic: true });
    await holdEnv.apply("save-redirect", {
      source: "holdme.example", target: "https://dest.example/", status: 301, keepPath: true, keepQuery: true, profileId: null,
    });
    // Fail CF1 so check records zone: null on holdme.example's last plan, then add the zone in PowerDNS and remove CF1 via shared store directly.
    holdEnv.cf.tokens.get(cfTok1)!.status = "disabled";
    await holdEnv.act("check");
    holdEnv.pdns.addZone("holdme.example");
    const cfPaths = { stateDir: join(holdEnv.dir, "state", "cloudflare"), lockFile: join(holdEnv.dir, "dns.lock.cloudflare"), rootUid: process.getuid!() };
    await removeCloudflareConnection(cf1.id, { paths: cfPaths });
    const afterCheck = await holdEnv.act("check");
    expect(afterCheck.sites.find((s) => s.domain === "holdme.example")?.plan?.held).toBe(true);
    expect(holdEnv.standIns.current["holdme.example"]).toBeUndefined();

    // 3. Deleting a PowerDNS-backed redirect still finds and deletes a leftover Cloudflare Single Redirect rule.
    const ruleEnv = setupEnv();
    ruleEnv.pdns.addZone("dual.example");
    const dualAcc = ruleEnv.cf.account("Dual");
    const dualCfZone = ruleEnv.cf.zone("dual.example", dualAcc);
    ruleEnv.cf.token(CF_TOKEN, { owner: "user", accounts: [dualAcc], zoneEdit: true });
    const cfConn = (await ruleEnv.act("save-connection", { provider: "cloudflare", token: CF_TOKEN, label: "CF" })).connections[0]!;
    const pdnsConn = (await ruleEnv.act("save-connection", { provider: "powerdns", label: "NS1", url: PDNS_URL, apiKey: PDNS_KEY }))
      .connections.find((c) => c.provider === "powerdns")!;
    await ruleEnv.act("choose-zone", { zone: "dual.example", connectionId: cfConn.id, zoneId: dualCfZone.id });
    await ruleEnv.apply("set-automatic", { automatic: true });
    await ruleEnv.apply("save-redirect", {
      source: "dual.example", target: "https://dest.example/", status: 301, keepPath: true, keepQuery: true, profileId: null,
    });
    expect(ruleEnv.cf.rulesets.get(`${dualCfZone.id}:http_request_dynamic_redirect`)?.rules).toHaveLength(1);
    // Switch zone choice to PowerDNS so the redirect now resolves to PowerDNS while the Cloudflare rule still exists.
    await ruleEnv.apply("choose-zone", { zone: "dual.example", connectionId: pdnsConn.id, zoneId: "dual.example." });
    expect(ruleEnv.standIns.current["dual.example"]).toBeDefined();

    // While Cloudflare is unreachable, deletion is blocked instead of orphaning the Cloudflare rule.
    ruleEnv.cf.tokens.get(CF_TOKEN)!.status = "disabled";
    const blockedDelete = await ruleEnv.act("delete-redirect", { source: "dual.example" });
    expect(blockedDelete.review!.blocked).toBe(true);
    expect(blockedDelete.review!.sites[0]!.problems.join(" ")).toContain("Cloudflare could not be read");
    expect(ruleEnv.standIns.current["dual.example"]).toBeDefined();

    // Once Cloudflare is reachable again, deletion reviews and removes BOTH the Cloudflare rule and the PowerDNS stand-in.
    ruleEnv.cf.tokens.get(CF_TOKEN)!.status = "active";
    const deleteReview = await ruleEnv.act("delete-redirect", { source: "dual.example" });
    expect(deleteReview.review!.blocked).toBe(false);
    expect(deleteReview.review!.sites[0]!.changes).toContainEqual(expect.objectContaining({
      action: "delete", subject: "Cloudflare redirect rule",
    }));
    const deleted = await ruleEnv.act("confirm", { token: deleteReview.review!.token });
    expect(ruleEnv.cf.rulesets.get(`${dualCfZone.id}:http_request_dynamic_redirect`)?.rules).toEqual([]);
    expect(ruleEnv.standIns.current["dual.example"]).toBeUndefined();
    expect(deleted.sites).toEqual([]);

    // 4. Changing a PowerDNS server keeps the committed new key even if managed-record cleanup fails afterward.
    const keyPdns2 = new FakePowerDns("pdns-second-key-9876543210");
    keyPdns2.addZone("example.com");
    const keyEnv = setupEnv({ pdns2: keyPdns2 });
    keyEnv.pdns.addZone("example.com");
    const first = (await keyEnv.act("save-connection", { provider: "powerdns", label: "NS1", url: PDNS_URL, apiKey: PDNS_KEY })).connections[0]!;
    // Corrupt managed.json so cleanupManagedForPolicy throws AFTER policy.json is committed.
    writeFileSync(join(keyEnv.dir, "state", "managed.json"), "{invalid-json", { mode: 0o600 });
    await expect(keyEnv.act("save-connection", {
      id: first.id, provider: "powerdns", label: "NS2", url: "http://127.0.0.1:8082", apiKey: "pdns-second-key-9876543210",
    })).rejects.toThrow();
    const savedPolicy = JSON.parse(readFileSync(join(keyEnv.dir, "state", "policy.json"), "utf8"));
    const savedSecrets = JSON.parse(readFileSync(join(keyEnv.dir, "state", "secrets.json"), "utf8"));
    const committedId = savedPolicy.powerdns[0].id as string;
    expect(committedId).not.toBe(first.id);
    expect(savedSecrets.powerdns[committedId]).toBe("pdns-second-key-9876543210");
    expect(savedSecrets.powerdns[first.id]).toBeUndefined();
    expect(hexId()).toHaveLength(32);
  });
});

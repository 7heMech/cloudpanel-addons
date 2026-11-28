import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeDnsAction, type DnsReply, type ProvisionReply } from "../addons/dns/action";
import { DNS_ADDON } from "../addons/dns/addon";
import { dashboardContent } from "../addons/dns/app/views";
import type { PanelSite } from "../addons/dns/engine";
import { seededPolicy } from "../addons/dns/presets";
import {
  formatPowerDnsContent, parsePowerDnsServerId, parsePowerDnsUrl, powerDnsRecordId, PowerDnsProvider, quotePowerDnsTxt,
} from "../addons/dns/powerdns";
import { connectionCheck, permissionActions } from "../addons/dns/setup";
import { NEW_SITE_WINDOW } from "../addons/dns/ssl";
import { SCRIPT as sslCompletionScript } from "../addons/panel-tweaks/inject/ssl";
import { unquoteTxt } from "../lib/dns-name";
import type { ApiFetch } from "../lib/provider-http";
import { FakeCloudflare, FakeMailcow, hexId, routed } from "./fixtures/dns-api";

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

function setupEnv(options: { pdns?: FakePowerDns; pdns2?: FakePowerDns; cf?: FakeCloudflare; ipv4?: string; ipv6?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dns-powerdns-"));
  dirs.push(dir);
  writeFileSync(join(dir, "dns.conf"), "enabled");
  const pdns = options.pdns ?? new FakePowerDns();
  const pdns2 = options.pdns2;
  const cf = options.cf ?? new FakeCloudflare();
  const mailcow = new FakeMailcow();
  const sites: PanelSite[] = [];
  const custom: { current: { name: string; issued: boolean } | undefined } = { current: undefined };
  const clock = { now: START, issue: false };
  const issued: { domain: string; alternatives: string[] }[] = [];

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
      redirectsPolicyFile: join(dir, "redirects", "policy.json"),
      standInsFile: join(dir, "redirects", "standins.json"),
      rootUid: process.getuid!(),
      clpctl: "/bin/false",
    },
    processUid: 0,
    fetch: fetcher,
    sites: () => sites,
    addresses: () => ({ ipv4: options.ipv4 ?? "203.0.113.10", ipv6: options.ipv6 ?? "2001:db8::10" }),
    customDomain: () => custom.current,
    issue: async (domain: string, alternatives: string[]) => {
      issued.push({ domain, alternatives });
      return clock.issue;
    },
    now: () => clock.now,
  };

  const act = async <T = DnsReply>(verb: string, body?: unknown, args: string[] = []): Promise<T> =>
    await executeDnsAction([verb, ...args], { ...actionOptions, input: body === undefined ? undefined : JSON.stringify(body) }) as T;

  const apply = async (verb: string, body: unknown): Promise<DnsReply> => {
    const reply = await act(verb, body);
    return reply.review ? act("confirm", { token: reply.review.token }) : reply;
  };

  const redirectsDir = join(dir, "redirects");
  /** Writes Redirects' saved state as the Redirects addon would. */
  const redirects = (entries: { source: string; target: string; mode?: "auto" | "local"; standIn?: boolean }[]): void => {
    mkdirSync(redirectsDir, { recursive: true });
    const policy = { version: 1, automatic: true, held: [], zoneChoices: {}, redirects: entries.map(({ standIn: _standIn, ...entry }) => ({ status: 301, keepPath: true, keepQuery: true, ...entry })) };
    writeFileSync(actionOptions.paths.redirectsPolicyFile, JSON.stringify(policy), { mode: 0o600 });
    const standIns = Object.fromEntries(entries.filter((entry) => entry.standIn).map((entry) => [entry.source, { target: entry.target, status: 301, keepPath: true, keepQuery: true, siteUser: "stand-in-1a2b3c4d", createdAt: START, certificate: { attempts: 0, nextAt: 0, done: false } }]));
    writeFileSync(actionOptions.paths.standInsFile, JSON.stringify(standIns), { mode: 0o600 });
  };
  return { dir, pdns, cf, mailcow, sites, custom, clock, issued, actionOptions, act, apply, redirects };
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

  test("a redirect domain on PowerDNS gets server A/AAAA for its stand-in plus its Mail role's non-web rows", async () => {
    const env = setupEnv();
    env.pdns.addZone("old.example");
    await env.act("save-connection", { provider: "powerdns", label: "Primary NS", url: PDNS_URL, apiKey: PDNS_KEY });
    await env.act("save-profile", {
      name: "Mail",
      role: "mail",
      mailcow: false,
      records: [
        { type: "A", name: "{domain}", content: "198.51.100.9", proxied: false, ttl: 300, priority: null, apexOnly: false },
        { type: "MX", name: "{domain}", content: "mail.example.net", proxied: false, ttl: 300, priority: 10, apexOnly: false },
        { type: "TXT", name: "{domain}", content: "v=spf1 -all", proxied: false, ttl: 300, priority: null, apexOnly: false },
      ],
    });
    env.redirects([{ source: "old.example", target: "https://new.example", mode: "local", standIn: true }]);
    await env.act("assign", { domains: ["old.example"], mailProfileId: "mail" });
    await env.apply("set-automatic", { automatic: true });

    // PowerDNS holds server A/AAAA (never 100::) at the stand-in's hosts plus MX/SPF; the profile's own A row stays out.
    expect(env.pdns.recordsSummary("old.example")).toEqual([
      "A old.example. 300 203.0.113.10",
      "A www.old.example. 300 203.0.113.10",
      "AAAA old.example. 300 2001:db8::10",
      "AAAA www.old.example. 300 2001:db8::10",
      "MX old.example. 300 10 mail.example.net.",
      'TXT old.example. 300 "v=spf1 -all"',
    ]);
    const row = (await env.act("list")).sites.find((site) => site.domain === "old.example")!;
    expect(row).toMatchObject({ type: "redirect", httpRole: "redirect", mailProfileId: "mail", redirect: { target: "https://new.example", standIn: true } });
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

  test("rejects conflicting TTLs in one PowerDNS RRset, avoids Cloudflare fallback copy, and isolates endpoint edits", async () => {
    const pdns2 = new FakePowerDns("pdns-second-key-9876543210");
    pdns2.addZone("example.com", [
      { name: "orphan.example.com.", type: "A", ttl: 300, records: [{ content: "203.0.113.10", disabled: false }] },
    ]);
    const env = setupEnv({ pdns2 });
    env.pdns.addZone("example.com");
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

    // 2. sync-panel-host returns null when no provider resolves for panelHost; pending PowerDNS copy avoids Cloudflare fallback.
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

    // 3. Remove the site orphan.example.com before editing NS1 to a different server (NS2).
    env.sites.splice(0, 1);
    const edited = await env.act("save-connection", {
      id: pdnsId, provider: "powerdns", label: "NS2", url: "http://127.0.0.1:8082", apiKey: "pdns-second-key-9876543210",
    });
    const newPdnsId = edited.connections.find((c) => c.provider === "powerdns")!.id;
    expect(newPdnsId).not.toBe(pdnsId);
    // Old orphan from NS1 cannot touch NS2's identical record because the connection identity changed.
    await expect(env.act("remove-records", { domain: "orphan.example.com" })).rejects.toThrow("connection these records were tracked through has been removed");
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

  test("PowerDNS-only user-facing notices do not claim Cloudflare", async () => {
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

  test("checks unread Cloudflare zones across tokens and keeps PowerDNS keys after policy commit", async () => {
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

    // 2. Changing a PowerDNS server keeps the committed new key even if managed-record cleanup fails afterward.
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

  test("provision pauses new PowerDNS zones with nameservers across sync-sites, direct creation, completion UI, retries, and non-admin scoping", async () => {
    const env = setupEnv();
    env.pdns.addZone("existing.example");
    await env.act("save-connection", {
      provider: "powerdns",
      label: "Primary NS",
      url: PDNS_URL,
      apiKey: PDNS_KEY,
      createZones: true,
      nameservers: ["ns1.example.net", "ns2.example.net"],
    });
    await env.act("set-default", { profileId: "web" });
    await env.apply("set-automatic", { automatic: true });

    // 1. Existing PowerDNS zone does NOT flag zoneCreated and is ready immediately.
    env.sites.push({ id: 1, domain: "existing.example", type: "php", createdAt: env.clock.now, selfSigned: true, cloudflareOnly: false });
    const existingReply = await env.act<ProvisionReply>("provision", undefined, ["--domain=existing.example", "--ssl"]);
    expect(existingReply).toEqual({
      managed: true,
      ready: true,
      reason: "DNS is in place",
      certificateNames: ["existing.example", "www.existing.example"],
    });
    expect(existingReply.zoneCreated).toBeUndefined();

    // 2. Path A: provision() invokes syncSites() which creates a brand-new PowerDNS Native zone.
    env.sites.push({ id: 2, domain: "brandnew-a.example", type: "php", createdAt: env.clock.now, selfSigned: true, cloudflareOnly: false });
    const pathAReply = await env.act<ProvisionReply>("provision", undefined, ["--domain=brandnew-a.example", "--ssl"]);
    expect(pathAReply).toEqual({
      managed: true,
      ready: false,
      reason: "Zone brandnew-a.example was just created; set its nameservers at the registrar: ns1.example.net, ns2.example.net",
      zone: "brandnew-a.example",
      nameServers: ["ns1.example.net", "ns2.example.net"],
      provider: "powerdns",
      zoneCreated: true,
      certificateNames: [],
    });

    // 3. Path B: separate sync-sites watcher creates the PowerDNS zone BEFORE provision() lands.
    env.sites.push({ id: 3, domain: "brandnew-b.example", type: "php", createdAt: env.clock.now, selfSigned: true, cloudflareOnly: false });
    const synced = await env.act<{ joined: string[] }>("sync-sites");
    expect(synced.joined).toEqual(["brandnew-b.example"]);
    const pathBReply = await env.act<ProvisionReply>("provision", undefined, ["--domain=brandnew-b.example", "--ssl"]);
    expect(pathBReply).toMatchObject({
      managed: true,
      ready: false,
      zone: "brandnew-b.example",
      nameServers: ["ns1.example.net", "ns2.example.net"],
      provider: "powerdns",
      zoneCreated: true,
      certificateNames: [],
    });

    // 3b. Path C: site already known and assigned while PowerDNS was down, then provision() creates the zone directly.
    env.pdns.errorMessage = "Temporary outage";
    env.sites.push({ id: 30, domain: "brandnew-c.example", type: "php", createdAt: env.clock.now, selfSigned: true, cloudflareOnly: false });
    await env.act("sync-sites");
    expect(env.pdns.zones.has("brandnew-c.example.")).toBe(false);
    env.pdns.errorMessage = null;
    const pathCReply = await env.act<ProvisionReply>("provision", undefined, ["--domain=brandnew-c.example", "--ssl"]);
    expect(pathCReply).toEqual({
      managed: true,
      ready: false,
      reason: "Zone brandnew-c.example was just created; set its nameservers at the registrar: ns1.example.net, ns2.example.net",
      zone: "brandnew-c.example",
      nameServers: ["ns1.example.net", "ns2.example.net"],
      provider: "powerdns",
      zoneCreated: true,
      certificateNames: [],
    });

    // 4. End-to-end completion UI handshake: feed real provision() output into Panel Tweaks' completion script.
    const runCompletion = async (domain: string, provisionReply: ProvisionReply) => {
      interface FakeEl { tag: string; href: string; textContent: string; innerHTML: string; children: FakeEl[]; appendChild(c: FakeEl): void; insertBefore(c: FakeEl): void; setAttribute(): void; addEventListener(): void }
      const makeEl = (tag: string): FakeEl => ({
        tag, href: "", textContent: "", innerHTML: "", children: [],
        appendChild(c) { this.children.push(c); },
        insertBefore(c) { this.children.unshift(c); },
        setAttribute() {},
        addEventListener() {},
      });
      const alert = {
        className: "alert alert-info", textContent: "", parts: [] as string[], links: [] as string[],
        append(_: string, a: { href: string }) { this.links.push(a.href); },
        appendChild(c: FakeEl) { this.parts.push(c.tag === "button" ? `[${c.children[0]!.textContent}]` : c.textContent); },
      };
      const panelCalls: string[] = [];
      let cookie = `__Host-clp_addons_ssl=${encodeURIComponent(domain)}`;
      const certUrl = `/site/${domain}/certificates`;
      const issueUrl = `/site/${domain}/certificates/lets-encrypt/new`;
      const box = {
        querySelector: () => alert,
        getAttribute: (name: string) => ({ "data-clp-auto-ssl": domain, "data-certificates-url": certUrl, "data-issue-url": issueUrl })[name],
      };
      const doc = {
        get cookie() { return `${cookie}; clp_addons_csrf=tok`; },
        set cookie(raw: string) { cookie = /Max-Age=0$/.test(raw) ? "" : raw.split(";")[0]!; },
        getElementById: () => null,
        querySelectorAll: () => [box],
        createElement: makeEl,
        createTextNode: (text: string) => ({ ...makeEl("#text"), textContent: text }),
        head: makeEl("head"),
      };
      const mockFetch = async (url: string, init?: RequestInit) => {
        if (url === "/addons/dns/api/session") return { ok: true, status: 200, json: async () => ({ ok: true }) };
        if (url === "/addons/dns/api/provision") return { ok: true, status: 200, json: async () => ({ ok: true, data: provisionReply }) };
        panelCalls.push(`${init?.method ?? "GET"} ${url}`);
        return { url: init?.method === "POST" ? `https://panel.example:8443${certUrl}` : `https://panel.example:8443${issueUrl}`, text: async () => "ok" };
      };
      class FakeParser {
        parseFromString() { return { querySelector: (sel: string) => sel.includes("_token") ? { form: "f" } : null }; }
      }
      class FakeFormData extends FormData {
        constructor() { super(); this.append("site_lets_encrypt_certificate[_token]", "csrf"); }
      }
      new Function("document", "location", "fetch", "DOMParser", "FormData", "window", "CustomEvent", sslCompletionScript)(
        doc, { href: "https://panel.example:8443/" }, mockFetch, FakeParser, FakeFormData,
        { dispatchEvent() {} }, class { constructor() {} },
      );
      await new Promise((r) => setTimeout(r, 20));
      return { alert, panelCalls };
    };

    const pausedUi = await runCompletion("brandnew-a.example", pathAReply);
    expect(pausedUi.panelCalls).toEqual([]);
    expect(pausedUi.alert.className).toBe("alert alert-warning");
    expect(pausedUi.alert.parts.join("")).toContain("brandnew-a.example is waiting for its nameservers.");
    expect(pausedUi.alert.parts.join("")).toContain("[ns1.example.net] and [ns2.example.net]");
    expect(pausedUi.alert.parts.join("")).not.toContain("Cloudflare");

    const immediateUi = await runCompletion("existing.example", existingReply);
    expect(immediateUi.panelCalls).toEqual([
      "GET https://panel.example:8443/site/existing.example/certificates/lets-encrypt/new",
      "POST https://panel.example:8443/site/existing.example/certificates/lets-encrypt/new",
    ]);
    expect(immediateUi.alert.className).toBe("alert alert-success");

    // 5. After FIRST_DELAY, reconcile retries Let's Encrypt automatically for the paused PowerDNS site.
    env.sites.find((s) => s.domain === "existing.example")!.selfSigned = false;
    env.clock.now += 3 * 60_000;
    env.clock.issue = true;
    // Simulate clpctl installing the certificate on brandnew-a.example when invoked.
    const origIssue = env.actionOptions.issue;
    env.actionOptions.issue = async (domain, alternatives) => {
      const ok = await origIssue(domain, alternatives);
      if (ok && domain === "brandnew-a.example") env.sites.find((s) => s.domain === domain)!.selfSigned = false;
      return ok;
    };
    await env.act("reconcile");
    expect(env.issued.some((entry) => entry.domain === "brandnew-a.example" && entry.alternatives.includes("www.brandnew-a.example"))).toBe(true);
    const afterReconcile = await env.act("list");
    expect(afterReconcile.sites.find((s) => s.domain === "brandnew-a.example")!.ssl).toBe("Certificate installed");

    // 6. After NEW_SITE_WINDOW elapses, createdZones expires and provision() no longer flags zoneCreated.
    env.clock.now += NEW_SITE_WINDOW + 1;
    const afterWindow = await env.act<ProvisionReply>("provision", undefined, ["--domain=brandnew-b.example"]);
    expect(afterWindow.ready).toBe(true);
    expect(afterWindow.zoneCreated).toBeUndefined();

    // 7. Non-admin scoping (--as-user): sees own new PowerDNS zone nameservers, cannot touch other tenants, and never leaks provider errors.
    const db = new Database(join(env.dir, "db.sq3"), { create: true });
    db.exec(`CREATE TABLE user (id INTEGER PRIMARY KEY, user_name TEXT, role TEXT, status INTEGER);
      CREATE TABLE site (id INTEGER PRIMARY KEY, domain_name TEXT);
      CREATE TABLE user_sites (user_id INTEGER, site_id INTEGER);
      INSERT INTO user VALUES (1, 'bob', 'ROLE_USER', 1), (2, 'alice', 'ROLE_USER', 1);
      INSERT INTO site VALUES (1, 'existing.example'), (4, 'bob-new.example'), (5, 'bob-err.example'), (6, 'alice-secret.example');
      INSERT INTO user_sites VALUES (1, 1), (1, 4), (1, 5), (2, 6);`);
    db.close();
    env.sites.push(
      { id: 4, domain: "bob-new.example", type: "php", createdAt: env.clock.now, selfSigned: true, cloudflareOnly: false },
      { id: 5, domain: "bob-err.example", type: "php", createdAt: env.clock.now, selfSigned: true, cloudflareOnly: false },
      { id: 6, domain: "alice-secret.example", type: "php", createdAt: env.clock.now, selfSigned: true, cloudflareOnly: false },
    );
    await expect(env.act("provision", undefined, ["--domain=alice-secret.example", "--as-user=bob"])).rejects.toThrow("not one of yours");

    const bobNew = await env.act<ProvisionReply>("provision", undefined, ["--domain=bob-new.example", "--as-user=bob", "--ssl"]);
    expect(bobNew).toEqual({
      managed: true,
      ready: false,
      reason: "Zone bob-new.example was just created; set its nameservers at the registrar: ns1.example.net, ns2.example.net",
      zone: "bob-new.example",
      nameServers: ["ns1.example.net", "ns2.example.net"],
      provider: "powerdns",
      zoneCreated: true,
      certificateNames: [],
    });
    expect(JSON.stringify(bobNew)).not.toContain("alice-secret.example");
    expect(JSON.stringify(bobNew)).not.toContain(PDNS_KEY);

    // Old site owned by bob answers from cached status without calling PowerDNS or setting zoneCreated.
    env.sites.find((s) => s.domain === "existing.example")!.createdAt = env.clock.now - NEW_SITE_WINDOW - 60_000;
    const callsBeforeOld = env.pdns.calls.length;
    const bobOld = await env.act<ProvisionReply>("provision", undefined, ["--domain=existing.example", "--as-user=bob"]);
    expect(bobOld.ready).toBe(true);
    expect(bobOld.zoneCreated).toBeUndefined();
    expect(env.pdns.calls.length).toBe(callsBeforeOld);

    // Provider error on bob's site never leaks raw PowerDNS error text or API key to bob.
    env.pdns.errorMessage = `Internal DB failure touching alice-secret.example with ${PDNS_KEY}`;
    const bobErr = await env.act<ProvisionReply>("provision", undefined, ["--domain=bob-err.example", "--as-user=bob"]);
    expect(bobErr).toEqual({
      managed: true,
      ready: false,
      reason: "an administrator can see why on the DNS page",
      certificateNames: [],
    });
    env.pdns.errorMessage = null;
  });
});

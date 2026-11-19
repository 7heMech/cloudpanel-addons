import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeDnsAction, type DnsReply } from "../addons/dns/action";
import { DNS_ADDON } from "../addons/dns/addon";
import { DnsRun, PANEL_PROFILE_ID, panelProfile, type PanelSite } from "../addons/dns/engine";
import { parsePolicy } from "../addons/dns/model";
import { seededPolicy } from "../addons/dns/presets";
import { dashboardContent } from "../addons/dns/app/views";
import { issuedFor } from "../lib/panel-custom-domain";
import { FakeCloudflare, FakeMailcow, routed } from "./fixtures/dns-api";

const TOKEN = "cf-agency-token-0123456789abcdef";
const START = Date.parse("2026-10-18T10:00:00Z");
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function site(id: number, domain: string): PanelSite {
  return { id, domain, type: "php", createdAt: START - 86_400_000, selfSigned: false, cloudflareOnly: false };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "dns-panel-host-"));
  dirs.push(dir);
  writeFileSync(join(dir, "dns.conf"), "enabled");
  const cf = new FakeCloudflare();
  const agency = cf.account("Agency");
  cf.token(TOKEN, { owner: "user", accounts: [agency], zoneEdit: true });
  cf.zone("example.com", agency);
  const sites: PanelSite[] = [site(1, "shop.example.com")];
  const custom: { current: { name: string; issued: boolean } | undefined } = { current: undefined };
  const options = {
    paths: { configFile: join(dir, "dns.conf"), stateDir: join(dir, "state"), smtpConfig: join(dir, "smtp.json"), lockFile: join(dir, "dns.lock"), panelDb: join(dir, "db.sq3"), rootUid: process.getuid!(), clpctl: "/bin/false" },
    processUid: 0,
    fetch: routed(cf, new FakeMailcow()),
    sites: () => sites,
    addresses: () => ({ ipv4: "203.0.113.10", ipv6: "2001:db8::10" }),
    customDomain: () => custom.current,
    now: () => START,
  };
  const env = {
    dir, cf, sites, custom, options,
    act: async <T = DnsReply>(verb: string, body?: unknown): Promise<T> =>
      await executeDnsAction([verb], { ...options, input: body === undefined ? undefined : JSON.stringify(body) }) as T,
    /** Applies a change, through its review when it asks for one. */
    async apply(verb: string, body: unknown): Promise<DnsReply> {
      const reply = await env.act(verb, body);
      return reply.review ? env.act("confirm", { token: reply.review.token }) : reply;
    },
    async automatic(): Promise<DnsReply> {
      await env.act("save-connection", { token: TOKEN });
      return env.apply("set-automatic", { automatic: true });
    },
    records: () => cf.recordsOf("example.com").map((record) => `${record.type} ${record.name} ${record.content}${record.proxied ? " proxied" : ""}`).sort(),
  };
  return env;
}

describe("the panel hostname", () => {
  test("is kept in the policy, and a bad name is refused", () => {
    expect(seededPolicy().panelHost).toBeNull();
    expect(parsePolicy({ ...seededPolicy(), panelHost: "Panel.Example.com" }).panelHost).toBe("panel.example.com");
    expect(parsePolicy({ ...seededPolicy(), panelHost: undefined }).panelHost).toBeNull();
    expect(() => parsePolicy({ ...seededPolicy(), panelHost: "not a name" })).toThrow();
  });

  test("its profile points the name here and wants the Let's Encrypt rule, proxied only when asked", () => {
    const grey = panelProfile(false);
    expect(grey.id).toBe(PANEL_PROFILE_ID);
    expect(grey.records.map((row) => `${row.type} ${row.name} ${row.content} ${row.proxied}`)).toEqual(["A {domain} {ipv4} false", "AAAA {domain} {ipv6} false"]);
    expect(grey.zone).toMatchObject({ ssl: null, alwaysHttps: null, acmeFullSsl: true });
    expect(panelProfile(true).records.every((row) => row.proxied)).toBe(true);
  });

  test("is planned beside the sites, and waits while a site or redirect domain has its name", () => {
    const base = { secrets: { cloudflare: {}, mailcowKey: "" }, addresses: { ipv4: "203.0.113.10", ipv6: null }, backoff: { cloudflare: 0, mailcow: 0 } };
    const policy = { ...seededPolicy(), panelHost: "panel.example.com" };
    const entries = (sites: PanelSite[], extra = {}) => new DnsRun({ ...base, policy: { ...policy, ...extra }, sites }).entries.map((entry) => `${entry.type} ${entry.domain}`);
    expect(entries([site(1, "shop.example.com")])).toEqual(["php shop.example.com", "panel panel.example.com"]);
    expect(entries([site(1, "panel.example.com")])).toEqual(["php panel.example.com"]);
    const redirect = { source: "panel.example.com", target: "https://example.com", status: 301 as const, keepPath: true, keepQuery: true, profileId: null };
    expect(entries([], { redirects: [redirect] })).toEqual(["redirect panel.example.com"]);
  });

  test("is written unproxied, then proxied once CloudPanel serves an issued certificate for it", async () => {
    const env = setup();
    await env.automatic();
    const saved = await env.apply("set-panel-host", { name: "panel.example.com" });
    expect(saved.panelHost).toMatchObject({ name: "panel.example.com", problem: null, proxied: false, customDomain: null });
    expect(env.records()).toEqual(["A panel.example.com 203.0.113.10", "AAAA panel.example.com 2001:db8::10"]);
    const zone = env.cf.zones[0]!;
    expect(env.cf.rulesets.get(`${zone.id}:http_config_settings`)!.rules.map((rule) => rule.ref)).toEqual(["clp_dns_acme"]);
    expect(saved.panelHost!.plan!.certificateNames).toEqual([]);
    expect(dashboardContent(saved)).toContain("Next: enter panel.example.com under");

    // CloudPanel has the name but is still on its placeholder certificate.
    env.custom.current = { name: "panel.example.com", issued: false };
    expect(await DNS_ADDON.certificates!.run(env.options)).toBeNull();
    expect(env.records()).toEqual(["A panel.example.com 203.0.113.10", "AAAA panel.example.com 2001:db8::10"]);

    env.custom.current = { name: "panel.example.com", issued: true };
    expect(await DNS_ADDON.certificates!.run(env.options)).toBe("panel.example.com is proxied through Cloudflare");
    expect(env.records()).toEqual(["A panel.example.com 203.0.113.10 proxied", "AAAA panel.example.com 2001:db8::10 proxied"]);
    const state = await env.act("list");
    expect(state.panelHost).toMatchObject({ proxied: true, customDomain: { name: "panel.example.com", issued: true } });
    expect(state.log.filter((line) => line.cause === "Panel certificate").map((line) => line.subject).sort()).toEqual(["A panel.example.com", "AAAA panel.example.com"]);

    // A renewal changes nothing, and does not reach Cloudflare.
    const calls = env.cf.calls.length;
    expect(await DNS_ADDON.certificates!.run(env.options)).toBeNull();
    expect(env.cf.calls.length).toBe(calls);
  });

  test("asks first like any other entry, and the certificate watcher leaves it alone then", async () => {
    const env = setup();
    await env.act("save-connection", { token: TOKEN });
    const saved = await env.act("set-panel-host", { name: "panel.example.com" });
    expect(saved.review).toBeUndefined();
    expect(saved.panelHost!.plan!.changes.map((change) => change.subject).sort()).toEqual(["A panel.example.com", "AAAA panel.example.com", "Cloudflare rule, whole zone"]);
    expect(dashboardContent(saved)).toContain("DNS asks first, so the record is written once you turn on Automatic.");
    env.custom.current = { name: "panel.example.com", issued: true };
    expect(await DNS_ADDON.certificates!.run(env.options)).toBeNull();
    expect(env.cf.writes()).toEqual([]);
  });

  test("is refused for a name a site or redirect domain has", async () => {
    const env = setup();
    await expect(env.act("set-panel-host", { name: "shop.example.com" })).rejects.toThrow("shop.example.com is a CloudPanel site");
    await env.act("save-redirect", { source: "old.example.com", target: "https://example.com" });
    await expect(env.act("set-panel-host", { name: "old.example.com" })).rejects.toThrow("old.example.com is a redirect domain");
  });

  test("shows a site that took its name later as a problem", async () => {
    const env = setup();
    await env.act("set-panel-host", { name: "panel.example.com" });
    env.sites.push(site(2, "panel.example.com"));
    const state = await env.act("list");
    expect(state.panelHost!.problem).toContain("CloudPanel has a site panel.example.com");
    expect(state.panelHost!.plan).toBeNull();
  });

  test("removing it leaves its records in Cloudflare, listed with the records of deleted sites", async () => {
    const env = setup();
    await env.automatic();
    await env.apply("set-panel-host", { name: "panel.example.com" });
    const removed = await env.act("set-panel-host", { name: null });
    expect(removed.panelHost).toBeNull();
    expect(removed.orphans).toEqual([{ domain: "panel.example.com", zone: "example.com", records: 2 }]);
    expect(env.records()).toEqual(["A panel.example.com 203.0.113.10", "AAAA panel.example.com 2001:db8::10"]);
    const status = JSON.parse(readFileSync(join(env.dir, "state", "status.json"), "utf8"));
    expect(status.plans["panel.example.com"]).toBeUndefined();
  });

  test("the certificate watcher does nothing while DNS is disabled", async () => {
    const env = setup();
    await env.automatic();
    await env.apply("set-panel-host", { name: "panel.example.com" });
    rmSync(join(env.dir, "dns.conf"));
    env.custom.current = { name: "panel.example.com", issued: true };
    const calls = env.cf.calls.length;
    expect(await DNS_ADDON.certificates!.run(env.options)).toBeNull();
    expect(env.cf.calls.length).toBe(calls);
  });
});

describe("an issued custom-domain certificate", () => {
  const generate = (args: string[]): string => {
    const dir = mkdtempSync(join(tmpdir(), "panel-cert-"));
    dirs.push(dir);
    const result = Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "key"), "-out", join(dir, "cert"), "-days", "30", ...args]);
    if (!result.success) throw new Error(result.stderr.toString());
    return readFileSync(join(dir, "cert"), "utf8");
  };

  test("is not CloudPanel's self-signed placeholder, names the domain and has not expired", () => {
    const selfSigned = generate(["-subj", "/CN=panel.example.com", "-addext", "subjectAltName=DNS:panel.example.com"]);
    expect(issuedFor(selfSigned, "panel.example.com")).toBe(false);
    expect(issuedFor(null, "panel.example.com")).toBe(false);
    expect(issuedFor("not a certificate", "panel.example.com")).toBe(false);
  });

  test("is one a CA signed for that name", () => {
    const dir = mkdtempSync(join(tmpdir(), "panel-ca-"));
    dirs.push(dir);
    const run = (args: string[]) => {
      const result = Bun.spawnSync(["openssl", ...args], { cwd: dir });
      if (!result.success) throw new Error(result.stderr.toString());
    };
    run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.crt", "-days", "30", "-subj", "/CN=Test CA"]);
    run(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", "/CN=panel.example.com"]);
    writeFileSync(join(dir, "ext"), "subjectAltName=DNS:panel.example.com\n");
    run(["x509", "-req", "-in", "leaf.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", "leaf.crt", "-days", "30", "-extfile", "ext"]);
    const pem = readFileSync(join(dir, "leaf.crt"), "utf8");
    expect(issuedFor(pem, "panel.example.com")).toBe(true);
    expect(issuedFor(pem, "other.example.com")).toBe(false);
    expect(issuedFor(pem, "panel.example.com", Date.now() + 60 * 86_400_000)).toBe(false);
  });
});

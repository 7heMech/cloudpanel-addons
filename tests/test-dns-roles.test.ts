import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeDnsAction, type DnsReply, type ProvisionReply, type SiteDnsStatus } from "../addons/dns/action";
import { dashboardContent } from "../addons/dns/app/views";
import type { PanelSite } from "../addons/dns/engine";
import { composeProfiles, MAX_DOMAINS, MAX_PROFILES, parsePolicy, parseProfile } from "../addons/dns/model";
import { mailcowSeededProfile, PRESETS, seededPolicy } from "../addons/dns/presets";
import { renderProfile } from "../addons/dns/records";
import { readEdgeConfig } from "../addons/firewall/edge";
import * as redirectDomains from "../lib/redirect-domains";
import { migrateCloudflareEdgeFromDns } from "../addons/firewall/migration";
import { FakeCloudflare, FakeMailcow, MAILCOW_KEY, routed } from "./fixtures/dns-api";

const TOKEN = "cf-roles-token-0123456789abcdef01";
const START = Date.parse("2026-10-18T10:00:00Z");
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function site(id: number, domain: string, extra: Partial<PanelSite> = {}): PanelSite {
  return { id, domain, type: "php", createdAt: START - 86_400_000, selfSigned: false, cloudflareOnly: false, ...extra };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "dns-roles-test-"));
  dirs.push(dir);
  const configFile = join(dir, "dns.conf");
  writeFileSync(configFile, "enabled");
  const cf = new FakeCloudflare();
  const mc = new FakeMailcow();
  const agency = cf.account("Agency");
  cf.zone("example.com", agency);
  cf.zone("old.example.org", agency);
  cf.token(TOKEN, { owner: "user", accounts: [agency], zoneEdit: true });
  const sites: PanelSite[] = [site(1, "example.com"), site(2, "mail.example.com"), site(3, "blog.example.com")];
  const addresses: { ipv4: string | null; ipv6: string | null } = { ipv4: "203.0.113.10", ipv6: "2001:db8::10" };
  const paths = {
    configFile,
    stateDir: join(dir, "state"),
    smtpConfig: join(dir, "smtp.json"),
    lockFile: join(dir, "dns.lock"),
    panelDb: join(dir, "db.sq3"),
    redirectsPolicyFile: join(dir, "redirects", "policy.json"),
    standInsFile: join(dir, "redirects", "standins.json"),
    redirectsStatusFile: join(dir, "redirects", "status.json"),
    rootUid: process.getuid!(),
    clpctl: "/bin/false",
  };
  const outage = { cloudflare: false };
  const fetch = routed(cf, mc);
  const act = <T = DnsReply>(verb: string, body?: unknown, extra: string[] = []): Promise<T> =>
    executeDnsAction([verb, ...extra], {
      paths,
      processUid: 0,
      input: body === undefined ? undefined : JSON.stringify(body),
      fetch: (address, init) => outage.cloudflare && String(address).includes("cloudflare")
        ? Promise.resolve(new Response(JSON.stringify({ success: false, errors: [{ code: 500, message: "Upstream outage" }] }), { status: 503 }))
        : fetch(address, init),
      sites: () => sites,
      addresses: () => ({ ...addresses }),
      now: () => START,
    }) as Promise<T>;
  const connect = () => act("save-connection", { token: TOKEN });
  const redirectSources: { source: string; target: string }[] = [];
  const standIns: Record<string, unknown> = {};
  const writeRedirects = (): void => {
    mkdirSync(join(dir, "redirects"), { recursive: true });
    writeFileSync(paths.redirectsPolicyFile, JSON.stringify({ version: 1, automatic: true, held: [], zoneChoices: {},
      redirects: redirectSources.map((entry) => ({ ...entry, status: 301, keepPath: true, keepQuery: true })) }), { mode: 0o600 });
    writeFileSync(paths.standInsFile, JSON.stringify(standIns), { mode: 0o600 });
  };
  /** Adds a redirect to Redirects' saved state, as the Redirects addon would, with its stand-in site when given one. */
  const redirect = (source: string, target: string, standIn?: PanelSite): void => {
    redirectSources.push({ source, target });
    if (standIn) {
      standIns[source] = { target, status: 301, keepPath: true, keepQuery: true, siteUser: standIn.user, siteId: standIn.id, createdAt: START };
      sites.push(standIn);
    }
    writeRedirects();
  };
  /** What Redirects' last check saved: the sources it serves at Cloudflare's edge. */
  const redirectStatus = (edge: string[], tracked: string[] = []): void => {
    mkdirSync(join(dir, "redirects"), { recursive: true });
    const view = { id: "z", name: "example.org", status: "active", nameServers: [], account: "Agency", connection: "Agency", connectionId: "cf-1" };
    writeFileSync(paths.redirectsStatusFile, JSON.stringify({
      checkedAt: null,
      plans: Object.fromEntries(redirectSources.map(({ source }) => [source, {
        domain: source, mode: "enforce", zone: edge.includes(source) ? view : null, changes: [], problems: [], zoneChoices: [],
      }])),
      redirectRules: Object.fromEntries(tracked.map((source) => [source, { connectionId: "cf-1", zoneId: "z", zoneName: "example.org" }])),
    }), { mode: 0o600 });
  };
  const addDomain = (domain: string, roles: { httpProfileId?: string | null; mailProfileId?: string | null } = {}) =>
    apply("add-domain", { domain, ...roles });
  const apply = async (verb: string, body?: unknown): Promise<DnsReply> => {
    const reply = await act(verb, body);
    return reply.review ? act("confirm", { token: reply.review.token }) : reply;
  };
  const records = (zone = "example.com") =>
    cf.recordsOf(zone).map((record) => `${record.type} ${record.name} ${record.content}${record.proxied ? " proxied" : ""}`).sort();
  return { dir, paths, cf, mc, agency, sites, act, connect, apply, records, redirect, redirectStatus, addDomain, outage };
}

function mailcowPanelHtml(html: string): string {
  const start = html.indexOf('data-section-panel="mailcow"');
  if (start < 0) return "";
  const end = html.indexOf('data-section-panel="settings"', start);
  return end < 0 ? html.slice(start) : html.slice(start, end);
}

describe("composable HTTP and Mail roles", () => {
  test("composes Site and DNS-only HTTP roles independently with Mail roles, on sites and DNS-only domains", async () => {
    const env = setup();
    env.mc.domains.add("example.net");
    env.mc.key("example.net", "dkim");
    env.mc.mailboxes.set("relay@example.net", { sender_acl: ["@example.net"] });
    await env.connect();
    await env.act("save-mailcow", {
      url: "mail.example.net", key: MAILCOW_KEY, dkimSource: "example.net", dkimSelector: "dkim", dkimBits: 2048, sharedMailbox: "relay@example.net",
    });

    // Site (Web) + Mail (Google Workspace)
    await env.act("assign", { domains: ["example.com"], httpProfileId: "web", mailProfileId: "google" });
    // DNS-only (no HTTP profile) + Mail (Mailcow)
    await env.act("assign", { domains: ["mail.example.com"], httpProfileId: null, mailProfileId: "mailcow" });
    // Site (Web) + Mail (DMARC)
    await env.act("assign", { domains: ["blog.example.com"], httpProfileId: "web", mailProfileId: "dmarc" });
    // A DNS-only domain + Mail (Mailcow)
    await env.addDomain("old.example.org", { mailProfileId: "mailcow" });

    const applied = await env.apply("set-automatic", { automatic: true });
    const siteOf = (domain: string) => applied.sites.find((entry) => entry.domain === domain)!;

    expect(siteOf("example.com")).toMatchObject({ httpRole: "site", httpProfileId: "web", mailProfileId: "google" });
    expect(siteOf("mail.example.com")).toMatchObject({ httpRole: "dns-only", httpProfileId: null, mailProfileId: "mailcow" });
    expect(siteOf("blog.example.com")).toMatchObject({ httpRole: "site", httpProfileId: "web", mailProfileId: "dmarc" });
    expect(siteOf("old.example.org")).toMatchObject({ type: "domain", httpRole: "dns-only", httpProfileId: null, mailProfileId: "mailcow" });

    const exRecords = env.records("example.com");
    // example.com gets Web + Google Workspace MX/SPF
    expect(exRecords).toContain("A example.com 203.0.113.10 proxied");
    expect(exRecords).toContain("MX example.com smtp.google.com");
    expect(exRecords).toContain('TXT example.com "v=spf1 include:_spf.google.com ~all"');
    // mail.example.com is DNS-only + Mailcow: gets MX, SPF, DKIM, and zero A/AAAA records
    expect(exRecords).toContain("MX mail.example.com mail.example.net");
    expect(exRecords).toContain('TXT mail.example.com "v=spf1 mx ~all"');
    expect(exRecords.some((r) => r.startsWith("TXT dkim._domainkey.mail.example.com "))).toBe(true);
    expect(exRecords.some((r) => /^(A|AAAA) mail\.example\.com /.test(r))).toBe(false);
    expect(env.mc.domains.has("mail.example.com")).toBe(true);
    // old.example.org gets Mailcow mail rows and no address records.
    const oldRecords = env.records("old.example.org");
    expect(oldRecords.some((r) => /^(A|AAAA) old\.example\.org /.test(r))).toBe(false);
    expect(oldRecords).toContain("MX old.example.org mail.example.net");
    expect(env.mc.domains.has("old.example.org")).toBe(true);

    // Updating only Mail role preserves HTTP role; updating only HTTP role preserves Mail role.
    const mailOnly = await env.apply("assign", { domains: ["example.com"], mailProfileId: "dmarc" });
    expect(mailOnly.sites.find((s) => s.domain === "example.com")).toMatchObject({ httpRole: "site", httpProfileId: "web", mailProfileId: "dmarc" });
    const httpOnly = await env.apply("assign", { domains: ["example.com"], httpProfileId: null });
    expect(httpOnly.sites.find((s) => s.domain === "example.com")).toMatchObject({ httpRole: "dns-only", httpProfileId: null, mailProfileId: "dmarc" });

    // A DNS-only domain can take an HTTP profile too.
    const served = await env.apply("assign", { domains: ["old.example.org"], httpProfileId: "web" });
    expect(served.sites.find((s) => s.domain === "old.example.org")).toMatchObject({ httpRole: "site", httpProfileId: "web", mailProfileId: "mailcow" });
    expect(env.records("old.example.org")).toContain("A old.example.org 203.0.113.10 proxied");
  });

  test("catches cross-role conflicts, guards role boundaries, and deletes one role without touching the other or live DNS", async () => {
    const env = setup();
    await env.connect();

    // HTTP profiles cannot enable Mailcow or use {mailcow.*} placeholders.
    await expect(env.act("save-profile", {
      name: "Bad HTTP", role: "http", mailcow: true, zone: {}, records: [],
    })).rejects.toThrow("only a Mail profile can set up Mailcow");
    await expect(env.act("save-profile", {
      name: "Bad Placeholder", role: "http", mailcow: false, zone: {},
      records: [{ type: "CNAME", name: "webmail.{domain}", content: "{mailcow.host}", ttl: 1 }],
    })).rejects.toThrow("HTTP profiles cannot use {mailcow");

    // Existing profile role cannot be changed on save.
    const web = (await env.act("list")).profiles.find((profile) => profile.id === "web")!;
    await expect(env.act("save-profile", { ...web, role: "mail" })).rejects.toThrow("cannot be changed");

    // Cross-role CNAME vs TXT conflict at the same name blocks confirmation.
    const clashMail = await env.act("save-profile", {
      name: "Clashing Mail", role: "mail", mailcow: false, zone: {},
      records: [{ type: "CNAME", name: "{domain}", content: "other.example.net", ttl: 1 }],
    });
    const clashId = clashMail.profiles.find((p) => p.name === "Clashing Mail")!.id;
    await env.act("assign", { domains: ["example.com"], httpProfileId: "web", mailProfileId: clashId });
    const blocked = await env.act("set-automatic", { automatic: true });
    expect(blocked.review!.blocked).toBe(true);
    expect(blocked.review!.sites[0]!.problems.join(" ")).toContain("CNAME");

    // Switch to a valid Mail profile, go Automatic, then delete the Mail profile: HTTP stays, live DNS stays untouched.
    await env.act("assign", { domains: ["example.com"], httpProfileId: "web", mailProfileId: "google" });
    await env.apply("set-automatic", { automatic: true });
    const writesBefore = env.cf.writes().length;
    const deleted = await env.act("delete-profile", { id: "google" });
    expect(deleted.review).toBeUndefined();
    expect(env.cf.writes().length).toBe(writesBefore);
    expect(deleted.sites.find((s) => s.domain === "example.com")).toMatchObject({ httpRole: "site", httpProfileId: "web", mailProfileId: null });
  });

  test("DNS-only site with a Mail role returns managed: false for SSL provisioning and applies Mail on admin provision", async () => {
    const env = setup();
    await env.connect();
    await env.act("assign", { domains: ["mail.example.com"], httpProfileId: null, mailProfileId: "google" });
    await env.apply("set-automatic", { automatic: true });

    // SSL completion flow (`--ssl`) does not claim HTTP coverage for a DNS-only site.
    const sslReply = await env.act<ProvisionReply>("provision", undefined, ["--domain=mail.example.com", "--ssl"]);
    expect(sslReply.managed).toBe(false);

    // Admin "Apply now" (no `--ssl`) still reconciles the Mail role when drift appears.
    env.cf.records.set(env.cf.zones[0]!.id, []);
    const adminReply = await env.act<ProvisionReply>("provision", undefined, ["--domain=mail.example.com"]);
    expect(adminReply).toMatchObject({ managed: true, ready: true, certificateNames: [] });
    expect(env.records("example.com")).toContain("MX mail.example.com smtp.google.com");
  });

  test("independent HTTP and Mail defaults apply together to new sites without moving existing sites", async () => {
    const env = setup();
    await env.connect();
    await env.act("set-default", { httpProfileId: "web" });
    await env.act("set-default", { mailProfileId: "dmarc" });
    await env.apply("set-automatic", { automatic: true });

    env.sites.push(site(99, "fresh.example.com", { createdAt: START }));
    const synced = await env.act<{ joined: string[] }>("sync-sites");
    expect(synced.joined).toEqual(["fresh.example.com"]);

    const state = await env.act("list");
    expect(state.defaultHttpProfileId).toBe("web");
    expect(state.defaultMailProfileId).toBe("dmarc");
    expect(state.sites.find((s) => s.domain === "fresh.example.com")).toMatchObject({ httpRole: "site", httpProfileId: "web", mailProfileId: "dmarc" });
    expect(state.sites.find((s) => s.domain === "example.com")).toMatchObject({ httpRole: "dns-only", httpProfileId: null, mailProfileId: null });
    expect(env.records("example.com")).toContain("A fresh.example.com 203.0.113.10 proxied");
  });
});

describe("tracked records follow the roles", () => {
  test("deleting the HTTP profile while Cloudflare is down stops tracking its records but keeps Mail's", async () => {
    const env = setup();
    await env.connect();
    await env.act("assign", { domains: ["example.com"], httpProfileId: "web", mailProfileId: "google" });
    await env.apply("set-automatic", { automatic: true });
    const tracked = () => {
      const managed = JSON.parse(readFileSync(join(env.dir, "state", "managed.json"), "utf8"));
      return (managed["example.com"]?.records ?? []).map((record: { type: string; name: string }) => `${record.type} ${record.name}`).sort();
    };
    expect(tracked()).toContain("A example.com");
    expect(tracked()).toContain("MX example.com");

    env.outage.cloudflare = true;
    await env.act("delete-profile", { id: "web" });
    expect(tracked().filter((record: string) => /^(A|AAAA|CNAME) /.test(record))).toEqual([]);
    expect(tracked()).toContain("MX example.com");
    expect(tracked()).toContain("TXT example.com");
  });
});

describe("DNS-only domains", () => {
  test("an administrator adds and removes a domain with no site; its records stay and are offered with deleted sites", async () => {
    const env = setup();
    await env.connect();
    await env.apply("set-automatic", { automatic: true });

    await expect(env.act("add-domain", { domain: "example.com" })).rejects.toThrow("is a CloudPanel site");
    await expect(env.act("add-domain", { domain: "old.example.org", mailProfileId: "web" })).rejects.toThrow("not a Mail profile");
    const added = await env.addDomain("old.example.org", { mailProfileId: "google" });
    expect(added.sites.find((s) => s.domain === "old.example.org")).toMatchObject({ type: "domain", mailProfileId: "google" });
    expect(env.records("old.example.org")).toContain("MX old.example.org smtp.google.com");
    await expect(env.act("add-domain", { domain: "old.example.org" })).rejects.toThrow("already listed");
    await expect(env.act("set-panel-host", { name: "old.example.org" })).rejects.toThrow("DNS-only domain");
    await expect(env.act("remove-records", { domain: "old.example.org" })).rejects.toThrow("still a DNS-only domain");

    // A scheduled check never prunes it.
    await env.act("check");
    expect((await env.act("list")).sites.some((s) => s.domain === "old.example.org")).toBe(true);

    const writes = env.cf.writes().length;
    const removed = await env.act("remove-domain", { domain: "old.example.org" });
    expect(removed.review).toBeUndefined();
    expect(env.cf.writes().length).toBe(writes);
    expect(removed.sites.some((s) => s.domain === "old.example.org")).toBe(false);
    expect(removed.orphans).toEqual([expect.objectContaining({ domain: "old.example.org" })]);
    expect(env.records("old.example.org")).toContain("MX old.example.org smtp.google.com");
    await expect(env.act("remove-domain", { domain: "old.example.org" })).rejects.toThrow("not a DNS-only domain");
    const listed = JSON.parse(readFileSync(join(env.dir, "state", "policy.json"), "utf8"));
    expect(listed.domains).toEqual([]);
    expect(listed.assignments["old.example.org"]).toBeUndefined();
  });

  test("a site created at a DNS-only domain takes it over, keeping its Mail role and taking the default HTTP role", async () => {
    const env = setup();
    await env.connect();
    await env.act("set-default", { httpProfileId: "web", mailProfileId: "dmarc" });
    await env.apply("set-automatic", { automatic: true });
    await env.addDomain("old.example.org", { mailProfileId: "google" });

    env.sites.push(site(40, "old.example.org", { createdAt: START }));
    // Before DNS adopts the site, removing the domain would drop the Mail role the site inherits.
    await expect(env.act("remove-domain", { domain: "old.example.org" })).rejects.toThrow("is a CloudPanel site now");
    const synced = await env.act<{ joined: string[] }>("sync-sites");
    expect(synced.joined).toEqual([]);
    const state = await env.act("list");
    expect(state.sites.filter((s) => s.domain === "old.example.org")).toEqual([
      expect.objectContaining({ type: "php", httpProfileId: "web", mailProfileId: "google" }),
    ]);
    const policy = JSON.parse(readFileSync(join(env.dir, "state", "policy.json"), "utf8"));
    expect(policy.domains).toEqual([]);
    expect(policy.knownSiteIds).toContain(40);
  });

  test("an administrator applies a DNS-only domain's roles from its Details", async () => {
    const env = setup();
    await env.connect();
    await env.apply("set-automatic", { automatic: true });
    await env.addDomain("old.example.org", { mailProfileId: "google" });
    env.cf.records.set(env.cf.zones.find((zone) => zone.name === "old.example.org")!.id, []);
    const reply = await env.act<ProvisionReply>("provision", undefined, ["--domain=old.example.org"]);
    expect(reply.managed).toBe(true);
    expect(env.records("old.example.org")).toContain("MX old.example.org smtp.google.com");
    await expect(env.act("provision", undefined, ["--domain=old.example.org", "--ssl"])).rejects.toThrow("CloudPanel has no site");
  });
});

describe("Redirects' domains in DNS", () => {
  test("a row whose domain a redirect covers carries a warning and is still planned as usual", async () => {
    const env = setup();
    await env.connect();
    await env.act("assign", { domains: ["example.com"], httpProfileId: "web" });
    await env.addDomain("old.example.org", { mailProfileId: "google" });
    await env.addDomain("www.example.net");
    env.redirect("old.example.org", "https://example.com");
    // A redirect at an apex covers its www too.
    env.redirect("example.net", "https://shop.example.com");
    const state = await env.apply("set-automatic", { automatic: true });
    expect(state.sites.find((s) => s.domain === "old.example.org")!.redirectedBy).toEqual({ source: "old.example.org", target: "https://example.com" });
    expect(state.sites.find((s) => s.domain === "www.example.net")!.redirectedBy).toEqual({ source: "example.net", target: "https://shop.example.com" });
    expect(state.sites.find((s) => s.domain === "mail.example.com")!.redirectedBy).toBeUndefined();
    expect(env.records("old.example.org")).toContain("MX old.example.org smtp.google.com");
    const html = dashboardContent(state);
    expect(html).toContain('href="/addons/redirects/" title="old.example.org redirects to https://example.com">Redirected in Redirects</a>');
  });

  test("a local stand-in is a site with the default HTTP role; one served at the edge is left out, keeping its roles", async () => {
    const env = setup();
    env.cf.record("old.example.org", { type: "AAAA", name: "old.example.org", content: "100::", proxied: true, ttl: 1 });
    await env.connect();
    // The default Mail role is for sites; a redirect's stand-in gets mail only when it is added in DNS.
    await env.act("set-default", { httpProfileId: "web", mailProfileId: "dmarc" });
    await env.apply("set-automatic", { automatic: true });

    const standIn = site(50, "old.example.org", { type: "static", user: "stand-in-1a2b3c4d", createdAt: START });
    env.redirect("old.example.org", "https://example.com", standIn);
    env.redirectStatus([], []);
    expect((await env.act<{ joined: string[] }>("sync-sites")).joined).toEqual(["old.example.org"]);
    let state = await env.act("list");
    expect(state.sites.find((s) => s.domain === "old.example.org")).toMatchObject({ type: "static", httpProfileId: "web", redirectedBy: expect.anything() });
    expect(env.records("old.example.org")).toContain("A old.example.org 203.0.113.10 proxied");

    // Redirects moves it to Cloudflare's edge: DNS leaves it out and writes nothing over its placeholder.
    env.cf.records.set(env.cf.zones.find((zone) => zone.name === "old.example.org")!.id, []);
    env.cf.record("old.example.org", { type: "AAAA", name: "old.example.org", content: "100::", proxied: true, ttl: 1 });
    env.redirectStatus(["old.example.org"]);
    const writes = env.cf.writes().length;
    state = await env.act("check");
    expect(env.cf.writes().length).toBe(writes);
    expect(state.sites.some((s) => s.domain === "old.example.org")).toBe(false);
    expect(state.orphans).toEqual([]);
    let policy = JSON.parse(readFileSync(join(env.dir, "state", "policy.json"), "utf8"));
    expect(policy.assignments["old.example.org"]).toEqual({ http: "web", mail: null });

    // Nor can it come back as a DNS-only domain that writes over the placeholder.
    await expect(env.act("add-domain", { domain: "old.example.org", httpProfileId: "web" })).rejects.toThrow("is a CloudPanel site");

    // A tracked rule alone still counts as the edge.
    env.redirectStatus([], ["old.example.org"]);
    expect((await env.act("list")).sites.some((s) => s.domain === "old.example.org")).toBe(false);

    // Back on this server, it is a site again with the roles it had.
    env.redirectStatus([]);
    state = await env.act("check");
    expect(state.sites.find((s) => s.domain === "old.example.org")).toMatchObject({ httpProfileId: "web" });
    policy = JSON.parse(readFileSync(join(env.dir, "state", "policy.json"), "utf8"));
    expect(policy.knownSiteIds).toContain(50);
  });

  test("one invocation reads Redirects' edge state once, so a stand-in is never both a site and a DNS-only domain", async () => {
    const env = setup();
    await env.connect();
    env.redirect("old.example.org", "https://example.com", site(50, "old.example.org", { type: "static", user: "stand-in-1a2b3c4d", createdAt: START }));
    env.redirectStatus([]);
    const reads = spyOn(redirectDomains, "readEdgeSources");
    try {
      await env.act("list");
      expect(reads).toHaveBeenCalledTimes(1);
    } finally {
      reads.mockRestore();
    }
  });

  test("Redirects' state that cannot be trusted leaves every stand-in out rather than writing over it", async () => {
    const env = setup();
    await env.connect();
    await env.act("set-default", { httpProfileId: "web" });
    await env.apply("set-automatic", { automatic: true });
    const standIn = site(50, "old.example.org", { type: "static", user: "stand-in-1a2b3c4d", createdAt: START });
    env.redirect("old.example.org", "https://example.com", standIn);

    // Untrusted status: the stand-in is left out.
    writeFileSync(env.paths.redirectsStatusFile, "{}", { mode: 0o644 });
    const writes = env.cf.writes().length;
    let state = await env.act("check");
    expect(state.sites.some((s) => s.domain === "old.example.org")).toBe(false);
    expect(env.cf.writes().length).toBe(writes);

    // Malformed status too.
    rmSync(env.paths.redirectsStatusFile);
    writeFileSync(env.paths.redirectsStatusFile, "not json", { mode: 0o600 });
    state = await env.act("list");
    expect(state.sites.some((s) => s.domain === "old.example.org")).toBe(false);

    // A site that is not a stand-in stays, even at a redirect served at the edge.
    env.redirectStatus(["old.example.org"]);
    writeFileSync(env.paths.standInsFile, "{}", { mode: 0o600 });
    state = await env.act("list");
    expect(state.sites.some((s) => s.domain === "old.example.org")).toBe(true);

    // When the stand-ins cannot be read, any site at a source served at the edge is left out.
    writeFileSync(env.paths.standInsFile, "[]", { mode: 0o600 });
    state = await env.act("list");
    expect(state.sites.some((s) => s.domain === "old.example.org")).toBe(false);
    expect(state.sites.some((s) => s.domain === "example.com")).toBe(true);
  });
});

describe("v1 to v2 policy migration", () => {
  const webPreset = PRESETS.find((preset) => preset.id === "web")!;
  const mailcowPreset = PRESETS.find((preset) => preset.id === "mailcow")!;
  const v1Web = {
    id: "web", name: "Web", mailcow: false,
    zone: { ssl: "strict", alwaysHttps: true, acmeFullSsl: true, webmailFullSsl: false, skipFirewallIps: [] },
    records: webPreset.records,
  };
  const v1WebMailcow = {
    id: "web-mailcow", name: "Web and Mailcow", mailcow: true,
    zone: { ssl: "strict", alwaysHttps: true, acmeFullSsl: true, webmailFullSsl: true, skipFirewallIps: [] },
    records: [...webPreset.records, ...mailcowPreset.records],
  };

  test("splits default v1 profiles cleanly, deduplicates Web, preserves live DNS with zero writes, and is idempotent", async () => {
    const env = setup();
    env.mc.domains.add("example.net");
    env.mc.domains.add("blog.example.com");
    env.mc.domains.add("old.example.org");
    env.mc.key("example.net", "dkim");
    env.mc.key("blog.example.com", "dkim");
    env.mc.key("old.example.org", "dkim");
    env.mc.mailboxes.set("relay@example.net", { sender_acl: ["@example.net", "@blog.example.com", "@old.example.org"] });
    await env.connect();

    // First converge live Cloudflare + Mailcow using v2 directly so we have an exact converged baseline.
    await env.act("save-mailcow", {
      url: "mail.example.net", key: MAILCOW_KEY, dkimSource: "example.net", dkimSelector: "dkim", dkimBits: 2048, sharedMailbox: "relay@example.net",
    });
    await env.act("assign", { domains: ["example.com"], httpProfileId: "web" });
    await env.act("assign", { domains: ["blog.example.com"], httpProfileId: "web", mailProfileId: "mailcow" });
    await env.addDomain("old.example.org", { mailProfileId: "mailcow" });
    await env.apply("set-automatic", { automatic: true });

    // Now replace policy.json on disk with an equivalent v1 policy (including reversed profile order test separately).
    const v1Policy = {
      version: 1,
      automatic: true,
      createIn: null,
      profiles: [v1Web, v1WebMailcow],
      defaultProfileId: "web-mailcow",
      assignments: {
        "example.com": "web",
        "blog.example.com": "web-mailcow",
      },
      redirects: [
        { source: "old.example.org", target: "https://example.com", status: 301, keepPath: true, keepQuery: true, profileId: "web-mailcow" },
      ],
      held: [],
      knownSiteIds: [1, 2, 3],
      connections: [],
      powerdns: [],
      zoneChoices: {},
      server: { ipv4: "", ipv6: "" },
      mailcow: { url: "https://mail.example.net", host: "mail.example.net", dkimSource: "example.net", dkimSelector: "dkim", dkimBits: 2048, sharedMailbox: "relay@example.net" },
      panelHost: null,
    };

    const migrated = parsePolicy(v1Policy);
    expect(migrated.version).toBe(2);
    expect(migrated.profiles.map((p) => `${p.id}:${p.role}`)).toEqual(["web:http", "mailcow:mail"]);
    expect(migrated.defaultHttpProfileId).toBe("web");
    expect(migrated.defaultMailProfileId).toBe("mailcow");
    // The redirect's Mail role stays with DNS as a DNS-only domain; the redirect itself moves to Redirects.
    expect(migrated.assignments).toEqual({
      "example.com": { http: "web", mail: null },
      "blog.example.com": { http: "web", mail: "mailcow" },
      "old.example.org": { http: null, mail: "mailcow" },
    });
    expect(migrated.domains).toEqual(["old.example.org"]);
    // Strictly idempotent when parsed again.
    expect(parsePolicy(migrated)).toEqual(migrated);

    // Reversed v1 order still deduplicates HTTP onto "web".
    const reversed = parsePolicy({ ...v1Policy, profiles: [v1WebMailcow, v1Web] });
    expect(reversed.profiles.map((p) => `${p.id}:${p.role}`)).toEqual(["web:http", "mailcow:mail"]);
    expect(reversed.assignments["blog.example.com"]).toEqual({ http: "web", mail: "mailcow" });

    // Running Automatic check against the migrated v1 policy performs ZERO Cloudflare or Mailcow writes!
    writeFileSync(join(env.dir, "state", "policy.json"), JSON.stringify(v1Policy), { mode: 0o600 });
    const cfWritesBefore = env.cf.writes().length;
    const mcWritesBefore = env.mc.writes().length;
    const checked = await env.act("check");
    expect(env.cf.writes().length).toBe(cfWritesBefore);
    expect(env.mc.writes().length).toBe(mcWritesBefore);
    expect(checked.sites.flatMap((s) => s.plan?.changes ?? [])).toEqual([]);
    expect(checked.sites.flatMap((s) => s.plan?.problems ?? [])).toEqual([]);
  });

  test("drops untouched unused default web-mailcow when unlinked, but preserves used or custom Mailcow and custom mixed profiles", () => {
    const baseV1 = {
      version: 1,
      automatic: false,
      createIn: null,
      profiles: [v1Web, v1WebMailcow],
      defaultProfileId: "web",
      assignments: { "example.com": "web" },
      redirects: [],
      held: [],
      knownSiteIds: [],
      connections: [],
      powerdns: [],
      zoneChoices: {},
      server: { ipv4: "", ipv6: "" },
      mailcow: { url: "", host: "", dkimSource: "", dkimSelector: "dkim", dkimBits: 2048, sharedMailbox: "" },
      panelHost: null,
    };

    // Unlinked + unused default web-mailcow -> omitted cleanly.
    const unlinkedUnused = parsePolicy(baseV1);
    expect(unlinkedUnused.profiles.map((p) => p.id)).toEqual(["web"]);

    // Unlinked + USED web-mailcow -> preserved so warnings surface instead of silent drop.
    const unlinkedUsed = parsePolicy({ ...baseV1, assignments: { "example.com": "web-mailcow" } });
    expect(unlinkedUsed.profiles.map((p) => `${p.id}:${p.role}`)).toEqual(["web:http", "mailcow:mail"]);
    expect(unlinkedUsed.assignments["example.com"]).toEqual({ http: "web", mail: "mailcow" });

    // Custom mixed profile (custom HTTP + firewall skip + custom DMARC + Mailcow) + pure Mail profile + redirect custom non-web profile.
    const customMixed = {
      id: "agency-full", name: "Agency Full", mailcow: true,
      zone: { ssl: "full", alwaysHttps: true, acmeFullSsl: true, webmailFullSsl: true, skipFirewallIps: ["203.0.113.7"] },
      records: [
        { type: "A", name: "{domain}", content: "{ipv4}", proxied: true, ttl: 1, priority: null, apexOnly: false },
        ...mailcowPreset.records,
        { type: "TXT", name: "_dmarc.{domain}", content: "v=DMARC1; p=quarantine", proxied: false, ttl: 1, priority: null, apexOnly: true },
      ],
    };
    const pureMail = {
      id: "google-only", name: "Google Only", mailcow: false,
      zone: { ssl: null, alwaysHttps: null, acmeFullSsl: false, webmailFullSsl: false, skipFirewallIps: [] },
      records: [
        { type: "MX", name: "{domain}", content: "smtp.google.com", proxied: false, ttl: 1, priority: 1, apexOnly: false },
        { type: "TXT", name: "{domain}", content: "v=spf1 include:_spf.google.com ~all", proxied: false, ttl: 1, priority: null, apexOnly: false },
      ],
    };
    const customRedirectOnly = {
      id: "verify-tag", name: "Verify Tag", mailcow: false,
      zone: { ssl: null, alwaysHttps: null, acmeFullSsl: false, webmailFullSsl: false, skipFirewallIps: [] },
      records: [{ type: "TXT", name: "_verify.{domain}", content: "token=abc", proxied: false, ttl: 1, priority: null, apexOnly: false }],
    };

    const migrated = parsePolicy({
      ...baseV1,
      profiles: [v1Web, customMixed, pureMail, customRedirectOnly],
      assignments: { "example.com": "agency-full", "mail.example.com": "google-only" },
      redirects: [{ source: "old.example.org", target: "https://example.com", status: 301, keepPath: true, keepQuery: true, profileId: "verify-tag" }],
    });

    const assignedAgency = migrated.assignments["example.com"]!;
    expect(assignedAgency.http).toBeTruthy();
    expect(assignedAgency.mail).toBeTruthy();
    const httpHalf = migrated.profiles.find((p) => p.id === assignedAgency.http)!;
    const mailHalf = migrated.profiles.find((p) => p.id === assignedAgency.mail)!;
    expect(httpHalf.role).toBe("http");
    expect(mailHalf.role).toBe("mail");
    expect(httpHalf.records).toEqual([{ type: "A", name: "{domain}", content: "{ipv4}", proxied: true, ttl: 1, priority: null, apexOnly: false }]);
    expect(mailHalf.mailcow).toBe(true);
    expect(mailHalf.records.length).toBe(customMixed.records.length - 1);
    const composed = composeProfiles(httpHalf, mailHalf)!;
    expect(composed.records.length).toBe(customMixed.records.length);

    expect(migrated.assignments["mail.example.com"]).toEqual({ http: null, mail: "google-only" });
    expect(migrated.profiles.find((p) => p.id === "google-only")!.role).toBe("mail");
    expect(migrated.profiles.find((p) => p.id === "verify-tag")!.role).toBe("mail");
    expect(migrated.assignments["old.example.org"]).toEqual({ http: null, mail: "verify-tag" });
  });

  test("keeps Mailcow-dependent web-name rows in Mail and leaves them off a redirect", () => {
    const row = (type: string, name: string, content: string, priority: number | null = null) =>
      ({ type, name, content, proxied: false, ttl: 1, priority, apexOnly: false });
    const shared = {
      id: "web-mail", name: "Web and Mail", mailcow: true,
      records: [
        row("A", "{domain}", "{ipv4}"),
        row("CNAME", "www.{domain}", "{mailcow.host}"),
        row("MX", "{domain}", "{mailcow.host}", 10),
      ],
    };
    const migrated = parsePolicy({
      version: 1, automatic: false, createIn: null, defaultProfileId: null, knownSiteIds: [], held: [], connections: [], powerdns: [],
      zoneChoices: {}, server: { ipv4: "", ipv6: "" }, panelHost: null,
      mailcow: { url: "https://mail.example.net", host: "mail.example.net", dkimSource: "", dkimSelector: "dkim", dkimBits: 2048, sharedMailbox: "" },
      profiles: [shared],
      assignments: { "example.com": "web-mail" },
      redirects: [{ source: "old.example.org", target: "https://example.com", status: 301, keepPath: true, keepQuery: true, profileId: "web-mail" }],
    });
    expect(parsePolicy(migrated)).toEqual(migrated);
    const byId = (id: string | null) => migrated.profiles.find((p) => p.id === id)!;
    const site = migrated.assignments["example.com"]!;
    expect(byId(site.http).records.map((r) => `${r.type} ${r.name}`)).toEqual(["A {domain}"]);
    expect(byId(site.mail).records.map((r) => `${r.type} ${r.name}`)).toEqual(["CNAME www.{domain}", "MX {domain}"]);
    const redirect = migrated.assignments["old.example.org"]!;
    expect(redirect.http).toBeNull();
    expect(byId(redirect.mail).records.map((r) => `${r.type} ${r.name}`)).toEqual(["MX {domain}"]);
    expect(byId(redirect.mail).mailcow).toBe(true);
  });

  test("treats {sub}.{zone} address rows as web rows when splitting a v1 profile", () => {
    const row = (type: string, name: string, content: string, priority: number | null = null) =>
      ({ type, name, content, proxied: false, ttl: 1, priority, apexOnly: false });
    const base = {
      version: 1, automatic: false, createIn: null, defaultProfileId: null, knownSiteIds: [], held: [], connections: [], powerdns: [],
      zoneChoices: {}, server: { ipv4: "", ipv6: "" }, panelHost: null, redirects: [],
      mailcow: { url: "", host: "", dkimSource: "", dkimSelector: "dkim", dkimBits: 2048, sharedMailbox: "" },
    };
    const migrated = parsePolicy({
      ...base,
      profiles: [
        { id: "shop", name: "Shop", mailcow: false, records: [row("A", "{sub}.{zone}", "{ipv4}"), row("MX", "{domain}", "mx.example.net", 10)] },
        { id: "autodiscover", name: "Autodiscover", mailcow: false, records: [row("CNAME", "autodiscover.{domain}", "mail.example.net")] },
      ],
      assignments: { "shop.example.com": "shop", "example.org": "autodiscover" },
    });
    const shop = migrated.assignments["shop.example.com"]!;
    expect(migrated.profiles.find((p) => p.id === shop.http)!.records.map((r) => `${r.type} ${r.name}`)).toEqual(["A {sub}.{zone}"]);
    expect(migrated.profiles.find((p) => p.id === shop.mail)!.records.map((r) => `${r.type} ${r.name}`)).toEqual(["MX {domain}"]);
    expect(migrated.assignments["example.org"]).toEqual({ http: null, mail: "autodiscover" });
  });
});

describe("Mailcow hide-until-linked tab and removal warning flow", () => {
  test("fresh unlinked install omits Mailcow presets and shows only a focused Connect Mailcow card with zero settings below it", async () => {
    const env = setup();
    await env.connect();
    const state = await env.act("list");

    expect(state.mailcow.linked).toBe(false);
    expect(state.mailcow.affectedSites).toEqual([]);
    expect(state.profiles.some((profile) => profile.mailcow)).toBe(false);
    expect(state.presets.some((preset) => preset.id === "mailcow")).toBe(false);

    const html = dashboardContent(state);
    expect(html).toContain('data-section-tab="mailcow"');
    expect(html).not.toContain("affected</span>");

    const panel = mailcowPanelHtml(html);
    expect(panel).toContain("Connect Mailcow");
    expect(panel).toContain('onclick="dnsEditMailcow()">Connect Mailcow</button>');
    // Zero settings forms, zero disabled inputs, zero Mailcow settings rows below the card.
    expect(panel).not.toContain("Mail host");
    expect(panel).not.toContain("DKIM policy");
    expect(panel).not.toContain("Shared mailbox");
    expect(panel).not.toContain("Domains using Mailcow");
    expect(panel).not.toContain("<input");
    expect(panel).not.toContain("<select");
    expect(panel).not.toContain("disabled");

    // Linking Mailcow reveals the Mailcow preset, seeds the Mailcow Mail profile once, and shows connected settings.
    const linked = await env.act("save-mailcow", { url: "mail.example.net", key: MAILCOW_KEY });
    expect(linked.mailcow.linked).toBe(true);
    expect(linked.presets.some((preset) => preset.id === "mailcow")).toBe(true);
    expect(linked.profiles.find((profile) => profile.id === "mailcow")).toMatchObject({ role: "mail", mailcow: true });

    const linkedPanel = mailcowPanelHtml(dashboardContent(linked));
    expect(linkedPanel).toContain("Connected");
    expect(linkedPanel).toContain("Mail host");
    expect(linkedPanel).toContain("DKIM policy");
    expect(linkedPanel).toContain("Domains using Mailcow");
    // Redirects has no Mail role to choose; a redirect's domain gets mail as a DNS-only domain.
    expect(linkedPanel).toContain("Choose Mailcow under Mail in Sites, adding a domain there first if it has no site.");
    expect(linkedPanel).toContain("Sites and DNS-only domains whose Mail role uses Mailcow.");

    // Deleting the seeded Mailcow profile and later editing Mailcow does not recreate it unexpectedly.
    await env.act("delete-profile", { id: "mailcow" });
    const edited = await env.act("save-mailcow", { url: "mail.example.net", dkimSelector: "selector2", dkimBits: 2048 });
    expect(edited.profiles.some((profile) => profile.mailcow)).toBe(false);
  });

  test("removing linked Mailcow with assigned domains keeps records untouched, badges the tab and affected rows, and clears on reconnect or role switch", async () => {
    const env = setup();
    env.mc.domains.add("example.net");
    env.mc.key("example.net", "dkim");
    await env.connect();
    await env.act("save-mailcow", { url: "mail.example.net", key: MAILCOW_KEY, dkimSource: "example.net" });
    await env.act("assign", { domains: ["example.com"], httpProfileId: "web", mailProfileId: "mailcow" });
    await env.act("assign", { domains: ["mail.example.com"], httpProfileId: null, mailProfileId: "mailcow" });
    await env.addDomain("old.example.org", { mailProfileId: "mailcow" });
    await env.apply("set-automatic", { automatic: true });

    const recordsBefore = env.records("example.com");
    const removed = await env.act("remove-mailcow", {});
    expect(removed.notice).toContain("3 domains still assign Mailcow");
    expect(removed.mailcow).toMatchObject({
      linked: false,
      hasKey: false,
      affectedSites: ["example.com", "mail.example.com", "old.example.org"],
    });
    expect(env.records("example.com")).toEqual(recordsBefore);
    expect(env.mc.writes().some((call) => call.path.startsWith("/delete"))).toBe(false);

    for (const domain of ["example.com", "mail.example.com", "old.example.org"]) {
      const entry = removed.sites.find((site) => site.domain === domain)!;
      expect(entry.mailProfileId).toBe("mailcow");
      expect(entry.mailcowMissing).toBe(true);
      expect(entry.plan!.problems.join(" ")).toContain("Mailcow is not connected");
    }

    const html = dashboardContent(removed);
    // Tab carries warning badge with affected count.
    expect(html).toContain('<span class="badge tone-warn section-badge">3 affected</span>');
    // Mailcow tab still shows ONLY the Connect Mailcow card (no settings forms below), now with the affected-domains warning.
    const panel = mailcowPanelHtml(html);
    expect(panel).toContain("Reconnect Mailcow");
    expect(panel).toContain("3 domains still assign Mailcow");
    expect(panel).toContain("<code>example.com</code>");
    expect(panel).toContain("<code>mail.example.com</code>");
    expect(panel).toContain("<code>old.example.org</code>");
    expect(panel).not.toContain("Domains using Mailcow");
    expect(panel).not.toContain("<input");
    // Affected site and domain rows carry the inline Mailcow unlinked warning badge.
    expect(html).toContain('class="badge tone-warn dns-mailcow-warn">Mailcow unlinked</span>');

    // Switching one domain's Mail role reduces the warning count to 2.
    const switched = await env.apply("assign", { domains: ["mail.example.com"], mailProfileId: null });
    expect(switched.mailcow.affectedSites).toEqual(["example.com", "old.example.org"]);
    expect(switched.sites.find((s) => s.domain === "mail.example.com")!.mailcowMissing).toBeUndefined();
    expect(dashboardContent(switched)).toContain('<span class="badge tone-warn section-badge">2 affected</span>');

    // Reconnecting Mailcow clears every remaining warning and resumes cleanly.
    const reconnected = await env.apply("save-mailcow", { url: "mail.example.net", key: MAILCOW_KEY, dkimSource: "example.net" });
    expect(reconnected.mailcow.linked).toBe(true);
    expect(reconnected.mailcow.affectedSites).toEqual([]);
    expect(reconnected.sites.every((s) => !s.mailcowMissing)).toBe(true);
    expect(dashboardContent(reconnected)).not.toContain("Mailcow unlinked");
    expect(dashboardContent(reconnected)).not.toContain("affected</span>");
  });

  test("seededPolicy and presets helpers match unlinked vs linked defaults", () => {
    const seeded = seededPolicy();
    expect(seeded.version).toBe(2);
    expect(seeded.profiles.map((p) => `${p.id}:${p.role}`)).toEqual(["web:http", "google:mail", "dmarc:mail"]);
    expect(mailcowSeededProfile().role).toBe("mail");
    expect(mailcowSeededProfile().mailcow).toBe(true);
    // parseProfile ignores any legacy zone field without error.
    const parsed = parseProfile({
      id: "custom-web", name: "Custom Web", role: "http", mailcow: false,
      zone: { ssl: "strict", alwaysHttps: true, acmeFullSsl: true, webmailFullSsl: true, skipFirewallIps: [] },
      records: [],
    });
    expect(parsed).not.toHaveProperty("zone");
    // Keep unused mkdirSync/readFileSync unused? No, verify policy file on disk stays v2.
    const dir = mkdtempSync(join(tmpdir(), "dns-roles-disk-"));
    dirs.push(dir);
    mkdirSync(join(dir, "state"), { recursive: true });
    writeFileSync(join(dir, "state", "policy.json"), JSON.stringify(seeded));
    expect(JSON.parse(readFileSync(join(dir, "state", "policy.json"), "utf8")).version).toBe(2);
  });
});

describe("review regressions", () => {
  test("v1 migration preserves custom non-web records for redirects sharing a profile with sites without copying web rows", () => {
    const rowA = { type: "A", name: "{domain}", content: "{ipv4}", proxied: true, ttl: 1, priority: null, apexOnly: false };
    const rowTxt = { type: "TXT", name: "_verify.{domain}", content: "v=custom-verify", proxied: false, ttl: 1, priority: null, apexOnly: false };
    const rowMx = { type: "MX", name: "{domain}", content: "mx.example.net", proxied: false, ttl: 1, priority: 10, apexOnly: false };
    const v1 = {
      version: 1,
      automatic: false,
      createIn: null,
      defaultProfileId: null,
      knownSiteIds: [],
      held: [],
      connections: [],
      powerdns: [],
      zoneChoices: {},
      server: { ipv4: "", ipv6: "" },
      mailcow: { url: "", host: "", dkimSource: "", dkimSelector: "dkim", dkimBits: 2048, sharedMailbox: "" },
      panelHost: null,
      profiles: [
        { id: "shared-verify", name: "Shared Verify", mailcow: false, records: [rowA, rowTxt] },
        { id: "shared-mx-verify", name: "Shared MX Verify", mailcow: false, records: [rowA, rowMx, rowTxt] },
        { id: "site-only-verify", name: "Site Only Verify", mailcow: false, records: [rowA, rowTxt] },
      ],
      assignments: {
        "site-a.example.com": "shared-verify",
        "site-b.example.com": "shared-mx-verify",
        "site-c.example.com": "site-only-verify",
      },
      redirects: [
        { source: "redir-a.example.org", target: "https://site-a.example.com", status: 301, keepPath: true, keepQuery: true, profileId: "shared-verify" },
        { source: "redir-b.example.org", target: "https://site-b.example.com", status: 301, keepPath: true, keepQuery: true, profileId: "shared-mx-verify" },
      ],
    };

    const migrated = parsePolicy(v1);
    const vars = (domain: string, zone: string) => ({
      domain, zone, ipv4: "203.0.113.10", ipv6: "", mailcowHost: "", mailcowSelector: null, mailcowDkim: null,
    });
    const byId = (id: string | null) => (id ? migrated.profiles.find((p) => p.id === id) ?? null : null);

    // Site A gets both A and TXT _verify without duplication; Redirect A gets TXT _verify without site A's A row.
    const siteA = migrated.assignments["site-a.example.com"]!;
    expect(siteA.http).toBeTruthy();
    expect(siteA.mail).toBeTruthy();
    const composedA = composeProfiles(byId(siteA.http), byId(siteA.mail))!;
    expect(renderProfile(composedA, vars("site-a.example.com", "example.com")).records.map((r) => `${r.type} ${r.name}`)).toEqual([
      "A site-a.example.com",
      "TXT _verify.site-a.example.com",
    ]);
    const redirA = migrated.assignments["redir-a.example.org"]!;
    expect(redirA.mail).toBe(siteA.mail);
    const redirAMail = byId(redirA.mail)!;
    expect(redirAMail.records.map((r) => `${r.type} ${r.name}`)).toEqual(["TXT _verify.{domain}"]);
    expect(migrated.domains).toEqual(["redir-a.example.org", "redir-b.example.org"]);
    expect(renderProfile(redirAMail, vars("redir-a.example.org", "example.org")).records.map((r) => `${r.type} ${r.name}`)).toEqual([
      "TXT _verify.redir-a.example.org",
    ]);

    // Site B and Redirect B both preserve MX and TXT _verify.
    const siteB = migrated.assignments["site-b.example.com"]!;
    const redirB = migrated.assignments["redir-b.example.org"]!;
    expect(redirB.mail).toBe(siteB.mail);
    expect(byId(redirB.mail)!.records.map((r) => `${r.type} ${r.name}`)).toEqual([
      "MX {domain}",
      "TXT _verify.{domain}",
    ]);

    // Site-only custom HTTP profile not referenced by any redirect is not split unnecessarily.
    expect(migrated.assignments["site-c.example.com"]).toEqual({ http: "site-only-verify", mail: null });
    expect(byId("site-only-verify")!.records).toHaveLength(2);
  });

  test("saving v2 before Firewall edge migration propagates legacy v1 zone blocks onto split redirect profiles", async () => {
    const env = setup();
    await env.connect();
    const policyPath = join(env.dir, "state", "policy.json");
    const v1Policy = {
      version: 1,
      automatic: true,
      createIn: null,
      defaultProfileId: null,
      knownSiteIds: [],
      held: [],
      connections: [],
      powerdns: [],
      zoneChoices: {},
      server: { ipv4: "", ipv6: "" },
      mailcow: { url: "", host: "", dkimSource: "", dkimSelector: "dkim", dkimBits: 2048, sharedMailbox: "" },
      panelHost: null,
      profiles: [
        {
          id: "web", name: "Web", mailcow: false,
          zone: { ssl: "strict", alwaysHttps: true, acmeFullSsl: true, webmailFullSsl: false, skipFirewallIps: [] },
          records: [{ type: "A", name: "{domain}", content: "{ipv4}", proxied: true, ttl: 1, priority: null, apexOnly: false }],
        },
        {
          id: "redirect-mixed", name: "Redirect Mixed", mailcow: false,
          zone: { ssl: "full", alwaysHttps: false, acmeFullSsl: false, webmailFullSsl: true, skipFirewallIps: ["203.0.113.7"] },
          records: [
            { type: "A", name: "{domain}", content: "{ipv4}", proxied: true, ttl: 1, priority: null, apexOnly: false },
            { type: "MX", name: "{domain}", content: "mx.example.net", proxied: false, ttl: 1, priority: 10, apexOnly: false },
          ],
        },
      ],
      assignments: {},
      redirects: [{ source: "old.example.org", target: "https://example.com", status: 301, keepPath: true, keepQuery: true, profileId: "redirect-mixed" }],
    };
    writeFileSync(policyPath, `${JSON.stringify(v1Policy, null, 2)}\n`, { mode: 0o600 });

    // Trigger a DNS save (set-automatic false saves directly without review), writing v2 before Firewall migrates.
    await env.act("set-automatic", { automatic: false });
    const onDisk = JSON.parse(readFileSync(policyPath, "utf8"));
    expect(onDisk.version).toBe(2);
    const redirectMailId = onDisk.assignments["old.example.org"].mail;
    expect(redirectMailId).toBe("redirect-mixed-mail");
    expect(onDisk.profiles.find((p: Record<string, unknown>) => p.id === redirectMailId).zone).toEqual({
      ssl: "full", alwaysHttps: false, acmeFullSsl: false, webmailFullSsl: true, skipFirewallIps: ["203.0.113.7"],
    });

    // Firewall edge migration reads the v2 redirect's active mailProfileId and migrates its legacy zone options.
    const fwStateDir = join(env.dir, "firewall-state");
    const uid = process.getuid!();
    const undo = migrateCloudflareEdgeFromDns(() => {}, {
      dnsPolicy: policyPath,
      dnsConfig: env.paths.configFile,
      cloudflareStateDir: join(env.dir, "state", "cloudflare"),
      firewallConfig: join(env.dir, "firewall.conf"),
      firewallPolicy: join(fwStateDir, "policy.json"),
      firewallStateDir: fwStateDir,
      edgeConfig: join(fwStateDir, "cloudflare-edge.json"),
      visitorIpState: join(fwStateDir, "visitor-ip.json"),
      firewallWasEnabled: true,
      rootUid: uid,
    });
    expect(undo).not.toBeNull();
    expect(readEdgeConfig({ paths: { stateDir: fwStateDir, rootUid: uid } }).defaults).toEqual({
      ssl: "full", alwaysHttps: false, acmeFullSsl: false, webmailFullSsl: true, skipFirewallIps: ["203.0.113.7"],
    });
  });

  test("saving v2 before Firewall edge migration keeps the zone blocks of the legacy profiles folded into one Mail profile", async () => {
    const mx = { type: "MX", name: "{domain}", content: "mx.example.net", proxied: false, ttl: 1, priority: 10, apexOnly: false };
    const a = { type: "A", name: "{domain}", content: "{ipv4}", proxied: true, ttl: 1, priority: null, apexOnly: false };
    const zone = (ssl: string) => ({ ssl, alwaysHttps: true, acmeFullSsl: false, webmailFullSsl: false, skipFirewallIps: [] });
    const migrate = async (profiles: unknown[], assignments: Record<string, string>) => {
      const env = setup();
      await env.connect();
      const policyPath = join(env.dir, "state", "policy.json");
      writeFileSync(policyPath, `${JSON.stringify({
        version: 1, automatic: true, createIn: null, defaultProfileId: null, knownSiteIds: [], held: [], connections: [], powerdns: [],
        zoneChoices: {}, server: { ipv4: "", ipv6: "" },
        mailcow: { url: "", host: "", dkimSource: "", dkimSelector: "dkim", dkimBits: 2048, sharedMailbox: "" }, panelHost: null,
        profiles, assignments,
        redirects: [{ source: "old.example.org", target: "https://example.com", status: 301, keepPath: true, keepQuery: true, profileId: "redirect-mixed" }],
      }, null, 2)}\n`, { mode: 0o600 });
      await env.act("set-automatic", { automatic: false });
      const onDisk = JSON.parse(readFileSync(policyPath, "utf8"));
      const fwStateDir = join(env.dir, "firewall-state");
      const uid = process.getuid!();
      migrateCloudflareEdgeFromDns(() => {}, {
        dnsPolicy: policyPath, dnsConfig: env.paths.configFile, cloudflareStateDir: join(env.dir, "state", "cloudflare"),
        firewallConfig: join(env.dir, "firewall.conf"), firewallPolicy: join(fwStateDir, "policy.json"), firewallStateDir: fwStateDir,
        edgeConfig: join(fwStateDir, "cloudflare-edge.json"), visitorIpState: join(fwStateDir, "visitor-ip.json"),
        firewallWasEnabled: true, rootUid: uid,
      });
      return { onDisk, edge: readEdgeConfig({ paths: { stateDir: fwStateDir, rootUid: uid } }) };
    };

    // An unused Mail-only profile does not lend its zone options to the redirect whose Mail half folds into it.
    const unused = await migrate([
      { id: "mailonly", name: "Mail only", mailcow: false, zone: zone("strict"), records: [mx] },
      { id: "redirect-mixed", name: "Redirect Mixed", mailcow: false, zone: zone("full"), records: [a, mx] },
    ], {});
    expect(unused.onDisk.assignments["old.example.org"]).toEqual({ http: null, mail: "mailonly" });
    expect(unused.onDisk.profiles.find((p: Record<string, unknown>) => p.id === "mailonly").zone).toEqual(zone("full"));
    expect(unused.edge.defaults.ssl).toBe("full");

    // Two used profiles with different SSL modes folding into one Mail profile stay a disagreement.
    const used = await migrate([
      { id: "mailonly", name: "Mail only", mailcow: false, zone: zone("strict"), records: [mx] },
      { id: "redirect-mixed", name: "Redirect Mixed", mailcow: false, zone: zone("full"), records: [a, mx] },
    ], { "mail.example.com": "mailonly" });
    expect(used.onDisk.profiles.find((p: Record<string, unknown>) => p.id === "mailonly").zone).toEqual([zone("strict"), zone("full")]);
    expect(used.edge.defaults.ssl).toBeNull();
    expect(used.edge.migrationNote).toContain("disagreed on SSL/TLS mode");

    // A web-only redirect has no Mail profile in v2, yet its zone options still weigh against the site's.
    const webOnly = await migrate([
      { id: "web", name: "Web", mailcow: false, zone: zone("strict"), records: [a] },
      { id: "redirect-mixed", name: "Redirect web", mailcow: false, zone: zone("full"), records: [a, { ...a, name: "www.{domain}" }] },
    ], { "site.example.com": "web" });
    expect(webOnly.onDisk.assignments["old.example.org"]).toBeUndefined();
    expect(webOnly.edge.defaults.ssl).toBeNull();
    expect(webOnly.edge.migrationNote).toContain("disagreed on SSL/TLS mode");
  });

  test("siteStatus and state stop reporting automatic SSL once a site loses its HTTP role or Automatic turns off", async () => {
    const env = setup();
    env.cf.zones[0]!.status = "pending";
    env.sites.push(site(9, "fresh.example.com", { createdAt: START - 60_000, selfSigned: true }));
    await env.connect();
    await env.act("assign", { domains: ["fresh.example.com"], httpProfileId: "web", mailProfileId: "google" });
    await env.apply("set-automatic", { automatic: true });

    await env.act<ProvisionReply>("provision", undefined, ["--domain=fresh.example.com", "--ssl"]);
    const before = await env.act<SiteDnsStatus>("site-status", undefined, ["--domain=fresh.example.com"]);
    expect(before.certificate).toBe("automatic");
    expect((await env.act("list")).sites.find((s) => s.domain === "fresh.example.com")!.ssl).toBeTruthy();

    // Switching Automatic off falls back to manual immediately.
    await env.act("set-automatic", { automatic: false });
    expect((await env.act<SiteDnsStatus>("site-status", undefined, ["--domain=fresh.example.com"])).certificate).toBe("manual");
    await env.apply("set-automatic", { automatic: true });
    expect((await env.act<SiteDnsStatus>("site-status", undefined, ["--domain=fresh.example.com"])).certificate).toBe("automatic");

    // Removing the HTTP role (making the site DNS-only with Mail still assigned) switches siteStatus to manual immediately.
    await env.apply("assign", { domains: ["fresh.example.com"], httpProfileId: null });
    const after = await env.act<SiteDnsStatus>("site-status", undefined, ["--domain=fresh.example.com"]);
    expect(after.certificate).toBe("manual");
    expect((await env.act("list")).sites.find((s) => s.domain === "fresh.example.com")!.ssl).toBeNull();
  });

  test("connecting Mailcow succeeds at MAX_PROFILES capacity by skipping default profile seeding with an explanatory notice", async () => {
    const env = setup();
    await env.connect();
    const policyPath = join(env.dir, "state", "policy.json");
    mkdirSync(join(env.dir, "state"), { recursive: true });
    const policy = seededPolicy();
    while (policy.profiles.length < MAX_PROFILES) {
      const idx = policy.profiles.length + 1;
      policy.profiles.push({
        id: `extra-${idx}`,
        name: `Extra ${idx}`,
        role: "mail",
        mailcow: false,
        records: [{ type: "TXT", name: `_tag${idx}.{domain}`, content: `v=${idx}`, proxied: false, ttl: 1, priority: null, apexOnly: false }],
      });
    }
    writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`, { mode: 0o600 });

    const linked = await env.act("save-mailcow", { url: "mail.example.net", key: MAILCOW_KEY });
    expect(linked.mailcow.linked).toBe(true);
    expect(linked.profiles).toHaveLength(MAX_PROFILES);
    expect(linked.profiles.some((profile) => profile.mailcow)).toBe(false);
    expect(linked.notice).toContain(`All ${MAX_PROFILES} profile slots are in use`);
    expect(linked.notice).toContain("delete an unused profile");
  });

  test("v2 leftovers of DNS's redirects with mail become DNS-only domains; those without mail add nothing", () => {
    const policy = parsePolicy({
      ...seededPolicy(),
      assignments: { "example.com": { http: "web", mail: null } },
      redirects: [
        { source: "old.example.org", target: "https://example.com", mailProfileId: "google" },
        { source: "plain.example.org", target: "https://example.com", mailProfileId: null },
        { source: "example.com", target: "https://example.net", mailProfileId: "dmarc" },
      ],
    });
    expect(policy.domains).toEqual(["old.example.org"]);
    expect(policy.assignments).toEqual({ "example.com": { http: "web", mail: null }, "old.example.org": { http: null, mail: "google" } });
  });

  test("a v2 leftover's Mail role is imported once: removing its domain sticks, and the redirect stays for Redirects' migration", async () => {
    const env = setup();
    await env.connect();
    await env.act("set-automatic", { automatic: false });
    const policyPath = join(env.dir, "state", "policy.json");
    const saved = JSON.parse(readFileSync(policyPath, "utf8"));
    const leftover = { source: "old.example.org", target: "https://example.com", status: 301, keepPath: true, keepQuery: true, mailProfileId: "google" };
    rmSync(policyPath);
    writeFileSync(policyPath, JSON.stringify({ ...saved, redirects: [leftover] }), { mode: 0o600 });
    expect((await env.act("list")).sites.find((s) => s.domain === "old.example.org")).toMatchObject({ type: "domain", mailProfileId: "google" });

    const removed = await env.act("remove-domain", { domain: "old.example.org" });
    expect(removed.sites.some((s) => s.domain === "old.example.org")).toBe(false);
    expect((await env.act("list")).sites.some((s) => s.domain === "old.example.org")).toBe(false);
    const onDisk = JSON.parse(readFileSync(policyPath, "utf8"));
    const { mailProfileId: _imported, ...kept } = leftover;
    expect(onDisk.redirects).toEqual([kept]);
    expect(onDisk.domains).toEqual([]);
  });

  test("v2 leftovers' Mail roles that do not fit in the DNS-only domains stop the read rather than being dropped", () => {
    const listed = Array.from({ length: MAX_DOMAINS }, (_, index) => `d${index}.example.net`);
    const leftover = { source: "old.example.org", target: "https://example.com", mailProfileId: "google" };
    expect(() => parsePolicy({ ...seededPolicy(), domains: listed, redirects: [leftover] })).toThrow("do not fit");
    expect(parsePolicy({ ...seededPolicy(), domains: listed.slice(1), redirects: [leftover] }).domains).toContain("old.example.org");
  });
});

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeDnsAction, panelSites, type DnsReply, type ProvisionReply } from "../addons/dns/action";
import type { PanelSite } from "../addons/dns/engine";
import { FakeCloudflare, FakeMailcow, MAILCOW_KEY, routed } from "./fixtures/dns-api";

const TOKEN = "cf-agency-token-0123456789abcdef";
const SECOND_TOKEN = "cf-church-token-0123456789abcdef";
const START = Date.parse("2026-10-18T10:00:00Z");
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function site(id: number, domain: string, extra: Partial<PanelSite> = {}): PanelSite {
  return { id, domain, type: "php", createdAt: START - 86_400_000, selfSigned: false, cloudflareOnly: false, ...extra };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "dns-test-"));
  dirs.push(dir);
  const cf = new FakeCloudflare();
  const mc = new FakeMailcow();
  const agency = cf.account("Agency");
  const church = cf.account("Church");
  cf.token(TOKEN, { owner: "user", accounts: [agency], zoneEdit: true });
  cf.token(SECOND_TOKEN, { owner: "user", accounts: [church, agency] });
  cf.zone("example.com", agency);
  const sites: PanelSite[] = [site(1, "example.com"), site(2, "shop.example.com")];
  const issued: { domain: string; alternatives: string[] }[] = [];
  const clock = { now: START, issue: false };
  const env = {
    dir, cf, mc, agency, church, sites, issued, clock,
    async act<T = DnsReply>(verb: string, body?: unknown, args: string[] = []): Promise<T> {
      return await executeDnsAction([verb, ...args], {
        paths: { stateDir: join(dir, "state"), lockFile: join(dir, "dns.lock"), panelDb: join(dir, "db.sq3"), rootUid: process.getuid!(), clpctl: "/bin/false" },
        processUid: 0,
        input: body === undefined ? undefined : JSON.stringify(body),
        fetch: routed(cf, mc),
        sites: () => sites,
        addresses: () => ({ ipv4: "203.0.113.10", ipv6: "2001:db8::10" }),
        issue: async (domain, alternatives) => {
          issued.push({ domain, alternatives });
          return clock.issue;
        },
        now: () => clock.now,
      }) as T;
    },
    async connect(token = TOKEN): Promise<DnsReply> {
      return env.act("save-connection", { token });
    },
    /** Enforce a profile through its review, as the page does. */
    async enforce(id: string): Promise<DnsReply> {
      const reply = await env.act("set-mode", { id, mode: "enforce" });
      if (!reply.review) return reply;
      expect(reply.review.blocked).toBe(false);
      return env.act("confirm", { token: reply.review.token });
    },
    records(zone = "example.com") {
      return cf.recordsOf(zone).map((record) => `${record.type} ${record.name} ${record.content}${record.proxied ? " proxied" : ""}`).sort();
    },
  };
  return env;
}

describe("connecting Cloudflare", () => {
  test("a first visit offers the seeded profiles in Report only", async () => {
    const env = setup();
    const state = await env.act("list");
    expect(state.profiles.map((profile) => [profile.name, profile.mode])).toEqual([["Web", "report"], ["Web and Mailcow", "report"]]);
    expect(state.connections).toEqual([]);
    expect(env.cf.calls).toEqual([]);
  });

  test("a token is verified, its accounts and zones found, and it never comes back to the page", async () => {
    const env = setup();
    env.cf.zone("example.org", env.church);
    const reply = await env.connect(SECOND_TOKEN);
    expect(reply.connections).toHaveLength(1);
    expect(reply.connections[0]).toMatchObject({ label: "Church, Agency", active: true, zones: 2, hasToken: true });
    expect(reply.accounts.map((account) => account.label)).toEqual(["Church (Church, Agency)", "Agency (Church, Agency)"]);
    expect(JSON.stringify(reply)).not.toContain(SECOND_TOKEN);
    expect(JSON.stringify(await env.act("list"))).not.toContain(SECOND_TOKEN);
    const secrets = join(env.dir, "state", "secrets.json");
    expect(statSync(secrets).mode & 0o777).toBe(0o600);
    expect(readFileSync(secrets, "utf8")).toContain(SECOND_TOKEN);
  });

  test("a token Cloudflare refuses is not saved, and the error does not repeat it", async () => {
    const env = setup();
    const bad = "cf-not-a-real-token-000000000";
    const error = await env.connect(bad).catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(bad);
    expect((await env.act("list")).connections).toEqual([]);
  });
});

describe("Report only and Enforce", () => {
  test("Report only reads and writes nothing", async () => {
    const env = setup();
    await env.connect();
    await env.act("assign", { domains: ["example.com"], profileId: "web" });
    const state = await env.act("check");
    expect(env.cf.writes()).toEqual([]);
    const plan = state.sites.find((entry) => entry.domain === "example.com")!.plan!;
    expect(plan.changes.map((change) => `${change.action} ${change.subject}`)).toContain("create A example.com");
  });

  test("Enforce starts only once its plan is confirmed, then makes it and keeps it", async () => {
    const env = setup();
    await env.connect();
    await env.act("assign", { domains: ["example.com"], profileId: "web" });
    const review = await env.act("set-mode", { id: "web", mode: "enforce" });
    expect(review.review!.sites.map((plan) => plan.domain)).toEqual(["example.com"]);
    expect(review.profiles.find((profile) => profile.id === "web")!.mode).toBe("report");
    expect(env.cf.writes()).toEqual([]);

    await env.act("confirm", { token: review.review!.token });
    expect(env.records()).toEqual([
      "A example.com 203.0.113.10 proxied", "A www.example.com 203.0.113.10 proxied",
      "AAAA example.com 2001:db8::10 proxied", "AAAA www.example.com 2001:db8::10 proxied",
    ]);
    const zone = env.cf.zones[0]!;
    expect(env.cf.settings.get(`${zone.id}:ssl`)).toBe("strict");
    expect(env.cf.settings.get(`${zone.id}:always_use_https`)).toBe("on");
    expect(env.cf.rulesets.get(`${zone.id}:http_config_settings`)!.rules.map((rule) => rule.ref)).toEqual(["clp_dns_acme"]);
    // The rule comes before the proxied records that need it.
    const order = env.cf.writes().map((call) => call.path);
    expect(order.findIndex((path) => path.endsWith("/rulesets"))).toBeLessThan(order.findIndex((path) => path.endsWith("/dns_records")));

    const writes = env.cf.writes().length;
    const state = await env.act("check");
    expect(env.cf.writes().length).toBe(writes);
    expect(state.sites.find((entry) => entry.domain === "example.com")!.plan!.changes).toEqual([]);
  });

  test("Enforce deletes conflicting records at the names it writes, and nothing else", async () => {
    const env = setup();
    env.cf.record("example.com", { type: "A", name: "example.com", content: "198.51.100.4" });
    env.cf.record("example.com", { type: "CNAME", name: "www.example.com", content: "old-host.example.net" });
    env.cf.record("example.com", { type: "TXT", name: "example.com", content: '"google-site-verification=abc"' });
    env.cf.record("example.com", { type: "MX", name: "example.com", content: "mx.elsewhere.example", priority: 5 });
    env.cf.record("example.com", { type: "A", name: "legacy.example.com", content: "198.51.100.4" });
    await env.connect();
    await env.act("assign", { domains: ["example.com"], profileId: "web" });
    const review = await env.act("set-mode", { id: "web", mode: "enforce" });
    expect(review.review!.sites[0]!.changes.filter((change) => change.action === "delete").map((change) => change.subject)).toEqual(["CNAME www.example.com"]);
    await env.act("confirm", { token: review.review!.token });
    expect(env.records()).toEqual([
      "A example.com 203.0.113.10 proxied", "A legacy.example.com 198.51.100.4", "A www.example.com 203.0.113.10 proxied",
      "AAAA example.com 2001:db8::10 proxied", "AAAA www.example.com 2001:db8::10 proxied",
      "MX example.com mx.elsewhere.example", 'TXT example.com "google-site-verification=abc"',
    ]);
  });

  test("a rule that already does the same thing is used rather than duplicated, and other rules stay", async () => {
    const env = setup();
    const zone = env.cf.zones[0]!;
    env.cf.rulesets.set(`${zone.id}:http_config_settings`, { id: "f".repeat(32), rules: [
      { id: "e".repeat(32), ref: "tf", action: "set_config", enabled: true, description: "Allow Let's Encrypt HTTP-01 challenge requests (Full SSL)",
        expression: 'starts_with(http.request.uri.path, "/.well-known/acme-challenge/")', action_parameters: { ssl: "full" } },
      { id: "d".repeat(32), ref: "other", action: "set_config", enabled: true, expression: 'http.host eq "x.example.com"', action_parameters: { ssl: "flexible" } },
    ] });
    await env.connect();
    const state = await env.act("list");
    const web = state.profiles.find((profile) => profile.id === "web")!;
    await env.act("save-profile", { ...web, zone: { ...web.zone, skipFirewallIps: ["203.0.113.7", "2001:db8::7"] } });
    await env.act("assign", { domains: ["example.com"], profileId: "web" });
    await env.enforce("web");
    expect(env.cf.rulesets.get(`${zone.id}:http_config_settings`)!.rules.map((rule) => rule.ref)).toEqual(["tf", "other"]);
    expect(env.cf.rulesets.get(`${zone.id}:http_request_firewall_custom`)!.rules).toEqual([expect.objectContaining({
      ref: "clp_dns_skip", action: "skip", expression: "ip.src in {2001:db8::7 203.0.113.7}",
      action_parameters: { phases: ["http_request_sbfm", "http_request_firewall_managed"] },
    })]);
  });

  test("a Report only profile in the same zone adds nothing to what is written there", async () => {
    const env = setup();
    await env.connect();
    const state = await env.act("list");
    const web = state.profiles.find((profile) => profile.id === "web")!;
    await env.act("save-profile", { ...web, zone: { ...web.zone, ssl: null, alwaysHttps: null, acmeFullSsl: false } });
    await env.act("assign", { domains: ["example.com"], profileId: "web" });
    await env.act("assign", { domains: ["shop.example.com"], profileId: "web-mailcow" });
    await env.enforce("web");
    const zone = env.cf.zones[0]!;
    expect(env.cf.settings.get(`${zone.id}:ssl`)).toBeUndefined();
    expect(env.cf.rulesets.size).toBe(0);
    expect(env.records()).not.toContain("A shop.example.com 203.0.113.10 proxied");
  });

  test("a profile that wants another SSL mode than what its zone enforces is stopped", async () => {
    const env = setup();
    await env.connect();
    const state = await env.act("list");
    const mailcow = state.profiles.find((profile) => profile.id === "web-mailcow")!;
    await env.act("save-profile", { ...mailcow, mailcow: false, records: mailcow.records.filter((row) => !/mailcow/.test(row.name + row.content)), zone: { ...mailcow.zone, ssl: "full" } });
    await env.act("assign", { domains: ["shop.example.com"], profileId: "web-mailcow" });
    await env.enforce("web-mailcow");
    await env.act("assign", { domains: ["example.com"], profileId: "web" });
    // Report only, it may disagree, and is told so; it stops nothing.
    const checked = await env.act("check");
    expect(checked.sites.find((entry) => entry.domain === "example.com")!.plan!.problems).toContain("The profiles in this zone ask for different SSL/TLS modes");
    expect(checked.sites.find((entry) => entry.domain === "shop.example.com")!.plan!.problems).toEqual([]);
    const blocked = await env.act("set-mode", { id: "web", mode: "enforce" });
    expect(blocked.review!.blocked).toBe(true);
    expect(env.cf.settings.get(`${env.cf.zones[0]!.id}:ssl`)).toBe("full");
  });

  test("records another current site writes at are never removed with a deleted site's", async () => {
    const env = setup();
    await env.connect();
    const state = await env.act("list");
    const web = state.profiles.find((profile) => profile.id === "web")!;
    // Both sites publish the same verification value at the zone's own name.
    await env.act("save-profile", { ...web, records: [...web.records, { type: "TXT", name: "_verify.{zone}", content: "token=1", ttl: 1 }] });
    await env.act("assign", { domains: ["example.com", "shop.example.com"], profileId: "web" });
    await env.enforce("web");
    env.sites.splice(env.sites.findIndex((entry) => entry.domain === "shop.example.com"), 1);
    const review = await env.act("remove-records", { domain: "shop.example.com" });
    expect(review.review!.sites[0]!.changes.map((change) => change.subject).sort()).toEqual(["A shop.example.com", "AAAA shop.example.com"]);
  });

  test("a dashboard edit to a managed record is put back by the next check", async () => {
    const env = setup();
    await env.connect();
    await env.act("assign", { domains: ["example.com"], profileId: "web" });
    await env.enforce("web");
    const a = env.cf.recordsOf("example.com").find((record) => record.type === "A" && record.name === "example.com")!;
    a.content = "198.51.100.99";
    a.proxied = false;
    await env.act("check");
    expect(env.records()).toContain("A example.com 203.0.113.10 proxied");
  });

  test("editing an enforcing profile's records is reviewed, renaming it is not", async () => {
    const env = setup();
    await env.connect();
    await env.act("assign", { domains: ["example.com"], profileId: "web" });
    await env.enforce("web");
    const web = (await env.act("list")).profiles.find((profile) => profile.id === "web")!;
    const renamed = await env.act("save-profile", { ...web, name: "Websites" });
    expect(renamed.review).toBeUndefined();
    expect(renamed.profiles.find((profile) => profile.id === "web")!.name).toBe("Websites");
    const changed = await env.act("save-profile", { ...web, records: [...web.records, { type: "TXT", name: "_dmarc.{domain}", content: "v=DMARC1; p=none", ttl: 1 }] });
    expect(changed.review!.sites[0]!.changes.map((change) => `${change.action} ${change.subject}`)).toEqual(["create TXT _dmarc.example.com"]);
    // A row taken out stops being enforced; what it wrote stays.
    const fewer = await env.act("save-profile", { ...web, records: web.records.filter((record) => record.type === "A") });
    expect(fewer.review!.sites[0]!.changes).toEqual([]);
  });

  test("a plan that changed before it was confirmed is shown again instead of applied", async () => {
    const env = setup();
    await env.connect();
    await env.act("assign", { domains: ["example.com"], profileId: "web" });
    const review = await env.act("set-mode", { id: "web", mode: "enforce" });
    env.cf.record("example.com", { type: "CNAME", name: "www.example.com", content: "someone.example.net" });
    const again = await env.act("confirm", { token: review.review!.token });
    expect(again.notice).toContain("changed after the plan was shown");
    expect(again.review!.sites[0]!.changes.some((change) => change.subject === "CNAME www.example.com")).toBe(true);
    expect(env.cf.writes()).toEqual([]);
  });

  test("a review expires after fifteen minutes", async () => {
    const env = setup();
    await env.connect();
    await env.act("assign", { domains: ["example.com"], profileId: "web" });
    const review = await env.act("set-mode", { id: "web", mode: "enforce" });
    env.clock.now += 16 * 60_000;
    await expect(env.act("confirm", { token: review.review!.token })).rejects.toThrow("expired");
  });
});

describe("Mailcow", () => {
  async function mailSetup() {
    const env = setup();
    env.mc.domains.add("example.net");
    env.mc.key("example.net", "dkim");
    env.mc.mailboxes.set("relay@example.net", { sender_acl: ["@example.net", "alerts@other.example"] });
    env.cf.record("example.com", { type: "TXT", name: "example.com", content: '"v=spf1 include:_spf.mlsend.com -all"' });
    await env.connect();
    await env.act("save-mailcow", {
      url: "https://mail.example.net", key: MAILCOW_KEY, host: "mail.example.net",
      dkimSource: "example.net", dkimSelector: "dkim", dkimBits: 2048, sharedMailbox: "relay@example.net",
    });
    await env.act("assign", { domains: ["example.com"], profileId: "web-mailcow" });
    return env;
  }

  test("the domain is added, the shared key duplicated, the mailbox allowed, and DNS gets Mailcow's own key", async () => {
    const env = await mailSetup();
    await env.enforce("web-mailcow");
    expect(env.mc.domains.has("example.com")).toBe(true);
    expect(env.mc.dkim.get("example.com")!.pubkey).toBe(env.mc.dkim.get("example.net")!.pubkey);
    expect(env.mc.mailboxes.get("relay@example.net")!.sender_acl).toEqual(["@example.net", "alerts@other.example", "@example.com"]);
    const dkim = env.cf.recordsOf("example.com").find((record) => record.name === "dkim._domainkey.example.com")!;
    expect(String(dkim.content).replace(/" "/g, "").replace(/"/g, "")).toBe(env.mc.dkim.get("example.com")!.dkim_txt);
    const records = env.records();
    expect(records).toContain('TXT example.com "v=spf1 include:_spf.mlsend.com mx -all"');
    expect(records).toContain("MX example.com mail.example.net");
    expect(records).toContain("SRV _autodiscover._tcp.example.com 0 443 mail.example.net");
    expect(records).toContain("CNAME webmail.example.com mail.example.net proxied");
    expect(env.mc.writes().some((call) => call.path.startsWith("/delete"))).toBe(false);
  });

  test("Report only reads Mailcow and shows what it would do without doing it", async () => {
    const env = await mailSetup();
    const state = await env.act("check");
    const changes = state.sites.find((entry) => entry.domain === "example.com")!.plan!.changes.map((change) => change.subject);
    expect(changes).toEqual(expect.arrayContaining(["Mailcow domain", "Mailcow DKIM key", "Mailcow sender permission"]));
    expect(env.mc.writes()).toEqual([]);
  });

  test("a sender list this Mailcow does not report is left for a person, and nothing else waits for it", async () => {
    const env = await mailSetup();
    env.mc.reportsAcl = false;
    await env.enforce("web-mailcow");
    expect(env.mc.writes().some((call) => call.path === "/edit/mailbox")).toBe(false);
    expect(env.records()).toContain("MX example.com mail.example.net");
  });
});

describe("several connections", () => {
  test("a site is managed in the longest zone any connection reaches", async () => {
    const env = setup();
    env.cf.zone("shop.example.com", env.church);
    await env.connect();
    await env.act("save-connection", { token: SECOND_TOKEN, label: "Church" });
    await env.act("assign", { domains: ["shop.example.com"], profileId: "web" });
    await env.enforce("web");
    expect(env.records("shop.example.com")).toContain("A shop.example.com 203.0.113.10 proxied");
    expect(env.records("example.com")).toEqual([]);
  });

  test("a zone two connections reach is used through the first until another is chosen", async () => {
    const env = setup();
    await env.connect();
    await env.act("save-connection", { token: SECOND_TOKEN, label: "Church" });
    await env.act("assign", { domains: ["example.com"], profileId: "web" });
    await env.enforce("web");
    expect(env.cf.writes().every((call) => env.cf.calls.find((entry) => entry === call)!.token === TOKEN)).toBe(true);
  });

  test("two zones with one name must be chosen between, and the choice is where records go", async () => {
    const env = setup();
    const theirs = env.cf.zone("example.net", env.agency);
    const ours = env.cf.zone("example.net", env.church);
    env.sites.push(site(3, "example.net"));
    await env.connect();
    const second = await env.act("save-connection", { token: SECOND_TOKEN, label: "Church" });
    await env.act("assign", { domains: ["example.net"], profileId: "web" });
    const blocked = await env.act("set-mode", { id: "web", mode: "enforce" });
    expect(blocked.review!.blocked).toBe(true);
    const plan = blocked.review!.sites[0]!;
    // The agency's zone is reachable through both tokens, so it is offered twice: once per connection.
    expect(plan.zoneChoices).toHaveLength(3);
    expect([...new Set(plan.zoneChoices.map((choice) => choice.zoneId))].sort()).toEqual([theirs.id, ours.id].sort());
    const church = second.connections.find((connection) => connection.label === "Church")!;
    await env.act("choose-zone", { zone: "example.net", connectionId: church.id, zoneId: ours.id });
    await env.enforce("web");
    expect(env.cf.records.get(ours.id)!.length).toBeGreaterThan(0);
    expect(env.cf.records.get(theirs.id)).toEqual([]);
  });
});

describe("zones and new sites", () => {
  test("a missing zone is created in the chosen account, and DNS is not ready until it is active", async () => {
    const env = setup();
    env.sites.push(site(3, "new-client.example.org"));
    await env.connect();
    const state = await env.act("list");
    const web = state.profiles.find((profile) => profile.id === "web")!;
    await env.act("save-profile", { ...web, zone: { ...web.zone, createIn: { connectionId: state.connections[0]!.id, accountId: env.agency } } });
    await env.act("assign", { domains: ["new-client.example.org"], profileId: "web" });
    await env.enforce("web");
    const zone = env.cf.zones.find((candidate) => candidate.name === "example.org")!;
    expect(zone.status).toBe("pending");
    expect(env.records("example.org")).toContain("A new-client.example.org 203.0.113.10 proxied");
    const provision = await env.act<ProvisionReply>("provision", undefined, ["--domain=new-client.example.org"]);
    expect(provision.ready).toBe(false);
    expect(provision.reason).toContain("ada.ns.cloudflare.com");
  });

  test("a new site joins the default profile and is written at once; existing sites stay where they are", async () => {
    const env = setup();
    await env.connect();
    await env.act("assign", { domains: ["example.com"], profileId: "web" });
    await env.enforce("web");
    await env.act("set-default", { profileId: "web" });
    env.sites.push(site(7, "fresh.example.com", { createdAt: START }));
    const synced = await env.act<{ joined: string[] }>("sync-sites");
    expect(synced.joined).toEqual(["fresh.example.com"]);
    expect(env.records()).toContain("A fresh.example.com 203.0.113.10 proxied");
    const state = await env.act("list");
    expect(state.sites.find((entry) => entry.domain === "shop.example.com")!.profileId).toBeNull();
    // Nothing new: the watcher's second pass makes no calls at all.
    const calls = env.cf.calls.length;
    await env.act("sync-sites");
    expect(env.cf.calls.length).toBe(calls);
  });

  test("provisioning names www for a certificate only at the apex", async () => {
    const env = setup();
    await env.connect();
    await env.act("assign", { domains: ["example.com", "shop.example.com"], profileId: "web" });
    await env.enforce("web");
    expect(await env.act<ProvisionReply>("provision", undefined, ["--domain=example.com"]))
      .toEqual({ managed: true, ready: true, reason: "DNS is in place", certificateNames: ["example.com", "www.example.com"] });
    expect((await env.act<ProvisionReply>("provision", undefined, ["--domain=shop.example.com"])).certificateNames).toEqual(["shop.example.com"]);
  });

  test("a site with no profile, or a Report only one, is not DNS's to hold up", async () => {
    const env = setup();
    await env.connect();
    expect(await env.act<ProvisionReply>("provision", undefined, ["--domain=example.com"])).toMatchObject({ managed: false });
    await env.act("assign", { domains: ["example.com"], profileId: "web" });
    expect(await env.act<ProvisionReply>("provision", undefined, ["--domain=example.com"])).toMatchObject({ managed: false });
    expect(env.cf.writes()).toEqual([]);
  });

  test("a site manager may provision only their own sites", async () => {
    const env = setup();
    const db = new Database(join(env.dir, "db.sq3"));
    db.exec(`CREATE TABLE user (id INTEGER PRIMARY KEY, user_name TEXT, role TEXT, status INTEGER);
      CREATE TABLE site (id INTEGER PRIMARY KEY, domain_name TEXT);
      CREATE TABLE user_sites (user_id INTEGER, site_id INTEGER);
      INSERT INTO user VALUES (1, 'bob', 'ROLE_USER', 1);
      INSERT INTO site VALUES (1, 'example.com'), (2, 'shop.example.com');
      INSERT INTO user_sites VALUES (1, 2);`);
    db.close();
    await env.connect();
    await expect(env.act("provision", undefined, ["--domain=example.com", "--as-user=bob"])).rejects.toThrow("not one of yours");
    expect(await env.act<ProvisionReply>("provision", undefined, ["--domain=shop.example.com", "--as-user=bob"])).toMatchObject({ managed: false });
  });
});

describe("automatic SSL", () => {
  async function pending() {
    const env = setup();
    env.cf.zones[0]!.status = "pending";
    env.sites.push(site(9, "brand-new.example.com", { createdAt: START - 60_000, selfSigned: true }));
    await env.connect();
    await env.act("assign", { domains: ["brand-new.example.com"], profileId: "web" });
    await env.enforce("web");
    const provision = await env.act<ProvisionReply>("provision", undefined, ["--domain=brand-new.example.com", "--ssl"]);
    expect(provision.ready).toBe(false);
    return env;
  }

  test("is retried as root only once DNS is ready, and only a few times", async () => {
    const env = await pending();
    await env.act("reconcile");
    expect(env.issued).toEqual([]);
    env.cf.zones[0]!.status = "active";
    env.clock.now += 3 * 60_000;
    await env.act("reconcile");
    expect(env.issued).toEqual([{ domain: "brand-new.example.com", alternatives: [] }]);
    await env.act("reconcile");
    expect(env.issued).toHaveLength(1);
    for (const wait of [5, 15, 60, 360, 360, 360]) {
      env.clock.now += wait * 60_000 + 1;
      await env.act("reconcile");
    }
    expect(env.issued).toHaveLength(5);
    const state = await env.act("list");
    expect(state.sites.find((entry) => entry.domain === "brand-new.example.com")!.ssl).toContain("No certificate after 5 attempts");
  });

  test("ends without trying once a real certificate is installed", async () => {
    const env = await pending();
    env.cf.zones[0]!.status = "active";
    env.sites.find((entry) => entry.domain === "brand-new.example.com")!.selfSigned = false;
    env.clock.now += 3 * 60_000;
    await env.act("reconcile");
    expect(env.issued).toEqual([]);
  });

  test("is dropped once DNS no longer enforces the site", async () => {
    const env = await pending();
    await env.act("set-mode", { id: "web", mode: "report" });
    await env.act("reconcile");
    expect((await env.act("list")).sites.find((entry) => entry.domain === "brand-new.example.com")!.ssl).toBeNull();
  });

  test("is not recorded for a site that was not just created", async () => {
    const env = setup();
    env.sites.push(site(9, "old.example.com", { createdAt: START - 3_600_000, selfSigned: true }));
    await env.connect();
    await env.act("assign", { domains: ["old.example.com"], profileId: "web" });
    await env.enforce("web");
    await env.act("provision", undefined, ["--domain=old.example.com", "--ssl"]);
    expect((await env.act("list")).sites.find((entry) => entry.domain === "old.example.com")!.ssl).toBeNull();
  });
});

describe("sites CloudPanel no longer has", () => {
  test("their records are removed only after review, and only the unchanged ones", async () => {
    const env = setup();
    await env.connect();
    await env.act("assign", { domains: ["example.com", "shop.example.com"], profileId: "web" });
    await env.enforce("web");
    env.sites.splice(env.sites.findIndex((entry) => entry.domain === "shop.example.com"), 1);
    expect((await env.act("list")).orphans).toEqual([{ domain: "shop.example.com", zone: "example.com", records: 2 }]);
    env.cf.recordsOf("example.com").find((record) => record.type === "AAAA" && record.name === "shop.example.com")!.content = "2001:db8::99";

    const review = await env.act("remove-records", { domain: "shop.example.com" });
    expect(review.review!.sites[0]!.changes.map((change) => change.subject)).toEqual(["A shop.example.com"]);
    expect(env.cf.writes().filter((call) => call.method === "DELETE")).toEqual([]);
    const done = await env.act("confirm", { token: review.review!.token });
    expect(done.orphans).toEqual([]);
    expect(env.records().filter((record) => record.includes("shop.example.com"))).toEqual(["AAAA shop.example.com 2001:db8::99 proxied"]);
    expect(env.records()).toContain("A example.com 203.0.113.10 proxied");
  });

  test("Keep forgets them and changes nothing in Cloudflare", async () => {
    const env = setup();
    await env.connect();
    await env.act("assign", { domains: ["shop.example.com"], profileId: "web" });
    await env.enforce("web");
    env.sites.splice(env.sites.findIndex((entry) => entry.domain === "shop.example.com"), 1);
    const writes = env.cf.writes().length;
    expect((await env.act("forget-records", { domain: "shop.example.com" })).orphans).toEqual([]);
    expect(env.cf.writes().length).toBe(writes);
  });
});

describe("limits and failures", () => {
  test("a 429 is remembered between runs and no call is made until it passes", async () => {
    const env = setup();
    await env.connect();
    await env.act("assign", { domains: ["example.com"], profileId: "web" });
    env.cf.limit = { after: 0, retryAfter: "600" };
    const state = await env.act("check");
    expect(state.waitUntil).toBeGreaterThan(Date.now());
    const calls = env.cf.calls.length;
    await env.act("check");
    expect(env.cf.calls.length).toBe(calls);
  });

  test("one zone that fails to read does not stop another", async () => {
    const env = setup();
    env.cf.zone("example.org", env.agency);
    env.sites.push(site(4, "example.org"));
    await env.connect();
    await env.act("assign", { domains: ["example.com", "example.org"], profileId: "web" });
    await env.enforce("web");
    const broken = env.cf.zones.find((zone) => zone.name === "example.org")!;
    const inner = env.cf.fetch;
    env.cf.fetch = async (url, init) => new URL(url).pathname.includes(`/zones/${broken.id}/dns_records`)
      ? new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: "Internal error" }] }), { status: 500 })
      : inner(url, init);
    env.cf.recordsOf("example.com").find((record) => record.type === "A" && record.name === "example.com")!.content = "198.51.100.1";
    const state = await env.act("check");
    expect(state.sites.find((entry) => entry.domain === "example.org")!.plan!.problems[0]).toContain("Internal error");
    expect(env.records()).toContain("A example.com 203.0.113.10 proxied");
  });
});

test("CloudPanel's sites are read with their certificate and creation time", () => {
  const dir = mkdtempSync(join(tmpdir(), "dns-panel-"));
  dirs.push(dir);
  const db = new Database(join(dir, "db.sq3"));
  db.exec(`CREATE TABLE certificate (id INTEGER PRIMARY KEY, type VARCHAR(64));
    CREATE TABLE site (id INTEGER PRIMARY KEY, certificate_id INTEGER, created_at DATETIME, type VARCHAR(64), domain_name VARCHAR(128),
      allow_traffic_from_cloudflare_only BOOLEAN);
    INSERT INTO certificate VALUES (1, '1'), (2, '2');
    INSERT INTO site VALUES (1, 1, '2026-10-18 09:59:00', 'wordpress', 'Example.com', 1), (2, 2, '2026-01-01 00:00:00', 'php', 'shop.example.com', 0),
      (3, NULL, '2026-01-01 00:00:00', 'php', 'not a domain', 0);`);
  db.close();
  expect(panelSites(join(dir, "db.sq3"))).toEqual([
    { id: 1, domain: "example.com", type: "wordpress", createdAt: Date.parse("2026-10-18T09:59:00Z"), selfSigned: true, cloudflareOnly: true },
    { id: 2, domain: "shop.example.com", type: "php", createdAt: Date.parse("2026-01-01T00:00:00Z"), selfSigned: false, cloudflareOnly: false },
  ]);
});

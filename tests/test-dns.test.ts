import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeDnsAction, panelSites, type DnsReply, type ProvisionReply, type SiteDnsStatus } from "../addons/dns/action";
import { detectAddresses, type Addresses } from "../addons/dns/addresses";
import { DNS_ADDON } from "../addons/dns/addon";
import type { PanelSite, SitePlan } from "../addons/dns/engine";
import { MAX_ATTEMPTS, retryCertificates, type SslRequest } from "../addons/dns/ssl";
import { dashboardContent } from "../addons/dns/app/views";
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
  writeFileSync(join(dir, "dns.conf"), "enabled");
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
  /** Milliseconds each token's Cloudflare calls take, to reorder concurrent reads. */
  const latency = new Map<string, number>();
  const fetch = routed(cf, mc);
  const addresses: Addresses = { ipv4: "203.0.113.10", ipv6: "2001:db8::10" };
  const env = {
    dir, cf, mc, agency, church, sites, issued, clock, addresses, latency,
    async act<T = DnsReply>(verb: string, body?: unknown, args: string[] = []): Promise<T> {
      return await executeDnsAction([verb, ...args], {
        paths: { configFile: join(dir, "dns.conf"), stateDir: join(dir, "state"), smtpConfig: join(dir, "smtp.json"), lockFile: join(dir, "dns.lock"), panelDb: join(dir, "db.sq3"), rootUid: process.getuid!(), clpctl: "/bin/false" },
        processUid: 0,
        input: body === undefined ? undefined : JSON.stringify(body),
        fetch: async (address, init) => {
          const token = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
          const delay = latency.get(token);
          if (delay) await Bun.sleep(delay);
          return fetch(address, init);
        },
        sites: () => sites,
        addresses: () => ({ ...addresses }),
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
    /** Turn on Automatic through its review, as the page does. */
    async automatic(): Promise<DnsReply> {
      const reply = await env.act("set-automatic", { automatic: true });
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

test("repair queues DNS with a runtime bound and leaves a running pass alone", () => {
  const original = Bun.spawnSync;
  const calls: string[][] = [];
  let active = false;
  try {
    // @ts-expect-error test mock
    Bun.spawnSync = (args: string[]) => {
      calls.push(args);
      const ok = args[0] !== "systemctl" || active;
      return { success: ok, stdout: "", stderr: "", exitCode: ok ? 0 : 3 };
    };
    DNS_ADDON.maintenance!.run();
    expect(calls[1]).toContain("--unit=clp-addon-dns-reconcile");
    expect(calls[1]).toContain("--property=RuntimeMaxSec=1800");
    expect(calls[1]!.slice(-4)).toEqual(["/usr/local/bin/clp-addons", "action", "dns", "reconcile"]);
    active = true;
    calls.length = 0;
    DNS_ADDON.maintenance!.run();
    expect(calls).toEqual([["systemctl", "is-active", "--quiet", "clp-addon-dns-reconcile"]]);
  } finally {
    Bun.spawnSync = original;
  }
});

test("queued DNS work does nothing after DNS has been disabled", async () => {
  const env = setup();
  await env.connect();
  await env.act("assign", { domains: ["example.com"], profileId: "web" });
  await env.automatic();
  const before = readFileSync(join(env.dir, "state", "status.json"), "utf8");
  const calls = env.cf.calls.length;
  rmSync(join(env.dir, "dns.conf"));
  env.sites.push(site(3, "new.example.com"));
  await env.act("reconcile");
  await env.act("sync-sites");
  expect(env.cf.calls.length).toBe(calls);
  expect(readFileSync(join(env.dir, "state", "status.json"), "utf8")).toBe(before);
});

describe("connecting Cloudflare", () => {
  test("a first visit offers the seeded profiles and asks first", async () => {
    const env = setup();
    const state = await env.act("list");
    expect(state.profiles.map((profile) => profile.name)).toEqual(["Web", "Web and Mailcow"]);
    expect(state.automatic).toBe(false);
    expect(state.connections).toEqual([]);
    expect(env.cf.calls).toEqual([]);
  });

  // A missing card read as a log that was never added. Empty, it says why.
  test("the change log shows before DNS has written anything, and says why it is empty", async () => {
    const state = await setup().act("list");
    expect(state.log).toEqual([]);
    const asking = dashboardContent(state);
    expect(asking).toContain("<h2>Change log</h2>");
    expect(asking).toContain("DNS asks first, so it writes nothing until you turn on Automatic.");
    expect(asking).not.toContain("dns-log-table");
    const automatic = dashboardContent({ ...state, automatic: true });
    expect(automatic).toContain('<div class="empty">No changes yet.</div>');
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

describe("Ask first and Automatic", () => {
  test("Ask first reads and writes nothing", async () => {
    const env = setup();
    await env.connect();
    await env.act("assign", { domains: ["example.com"], profileId: "web" });
    const state = await env.act("check");
    expect(env.cf.writes()).toEqual([]);
    const plan = state.sites.find((entry) => entry.domain === "example.com")!.plan!;
    expect(plan.changes.map((change) => `${change.action} ${change.subject}`)).toContain("create A example.com");
  });

  test("Automatic starts only once its plan is confirmed, then makes it, keeps it and logs it", async () => {
    const env = setup();
    await env.connect();
    await env.act("assign", { domains: ["example.com"], profileId: "web" });
    const review = await env.act("set-automatic", { automatic: true });
    expect(review.review!.sites.map((plan) => plan.domain)).toEqual(["example.com"]);
    expect(review.review!.confirmLabel).toBe("Apply and turn on Automatic");
    expect(review.automatic).toBe(false);
    expect(env.cf.writes()).toEqual([]);

    const confirmed = await env.act("confirm", { token: review.review!.token });
    expect(confirmed.automatic).toBe(true);
    expect(confirmed.log.map((line) => `${line.cause}: ${line.action} ${line.subject}`)).toContain("Confirmed review: create A example.com");
    expect(confirmed.log.find((line) => line.subject === "Zone setting, whole zone")).toMatchObject({ sites: [], zone: "example.com" });
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
    expect(state.log).toHaveLength(confirmed.log.length);

    // Asking first again is saved at once and writes nothing.
    const off = await env.act("set-automatic", { automatic: false });
    expect(off.review).toBeUndefined();
    expect(off.automatic).toBe(false);
    expect(env.cf.writes().length).toBe(writes);
  });

  test("Automatic deletes conflicting records at the names it writes, and nothing else", async () => {
    const env = setup();
    env.cf.record("example.com", { type: "A", name: "example.com", content: "198.51.100.4" });
    env.cf.record("example.com", { type: "CNAME", name: "www.example.com", content: "old-host.example.net" });
    env.cf.record("example.com", { type: "TXT", name: "example.com", content: '"google-site-verification=abc"' });
    env.cf.record("example.com", { type: "MX", name: "example.com", content: "mx.elsewhere.example", priority: 5 });
    env.cf.record("example.com", { type: "A", name: "legacy.example.com", content: "198.51.100.4" });
    await env.connect();
    await env.act("assign", { domains: ["example.com"], profileId: "web" });
    const review = await env.act("set-automatic", { automatic: true });
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
    await env.automatic();
    expect(env.cf.rulesets.get(`${zone.id}:http_config_settings`)!.rules.map((rule) => rule.ref)).toEqual(["tf", "other"]);
    expect(env.cf.rulesets.get(`${zone.id}:http_request_firewall_custom`)!.rules).toEqual([expect.objectContaining({
      ref: "clp_dns_skip", action: "skip", expression: "ip.src in {2001:db8::7 203.0.113.7}",
      action_parameters: { phases: ["http_request_sbfm", "http_request_firewall_managed"] },
    })]);
  });

  test("profiles in one zone that want different SSL modes stop each other", async () => {
    const env = setup();
    await env.connect();
    const state = await env.act("list");
    const mailcow = state.profiles.find((profile) => profile.id === "web-mailcow")!;
    await env.act("save-profile", { ...mailcow, mailcow: false, records: mailcow.records.filter((row) => !/mailcow/.test(row.name + row.content)), zone: { ...mailcow.zone, ssl: "full" } });
    await env.act("assign", { domains: ["shop.example.com"], profileId: "web-mailcow" });
    await env.automatic();
    // Putting a site that wants Full (strict) in the same zone is refused at its review.
    const blocked = await env.act("assign", { domains: ["example.com"], profileId: "web" });
    expect(blocked.review!.blocked).toBe(true);
    expect(blocked.review!.sites.find((plan) => plan.domain === "example.com")!.problems).toContain("The profiles in this zone ask for different SSL/TLS modes");
    // The zone stays at the Full it already had: Full (strict) is never written.
    expect(env.cf.settings.get(`${env.cf.zones[0]!.id}:ssl`)).toBeUndefined();
  });

  test("records another current site writes at are never removed with a deleted site's", async () => {
    const env = setup();
    await env.connect();
    const state = await env.act("list");
    const web = state.profiles.find((profile) => profile.id === "web")!;
    // Both sites publish the same verification value at the zone's own name.
    await env.act("save-profile", { ...web, records: [...web.records, { type: "TXT", name: "_verify.{zone}", content: "token=1", ttl: 1 }] });
    await env.act("assign", { domains: ["example.com", "shop.example.com"], profileId: "web" });
    const enforced = await env.automatic();
    // The second site finds the record the first one wrote, rather than creating it again.
    expect(enforced.sites.flatMap((entry) => entry.plan!.problems)).toEqual([]);
    expect(env.records().filter((record) => record.startsWith("TXT _verify."))).toEqual(['TXT _verify.example.com "token=1"']);
    env.sites.splice(env.sites.findIndex((entry) => entry.domain === "shop.example.com"), 1);
    const review = await env.act("remove-records", { domain: "shop.example.com" });
    expect(review.review!.sites[0]!.changes.map((change) => change.subject).sort()).toEqual(["A shop.example.com", "AAAA shop.example.com"]);
  });

  test("a dashboard edit to a managed record is put back by the next check", async () => {
    const env = setup();
    await env.connect();
    await env.act("assign", { domains: ["example.com"], profileId: "web" });
    await env.automatic();
    const a = env.cf.recordsOf("example.com").find((record) => record.type === "A" && record.name === "example.com")!;
    a.content = "198.51.100.99";
    a.proxied = false;
    await env.act("check");
    expect(env.records()).toContain("A example.com 203.0.113.10 proxied");
  });

  test("an address that can no longer be detected stops its sites rather than removing their records", async () => {
    const env = setup();
    await env.connect();
    await env.act("assign", { domains: ["example.com"], profileId: "web" });
    await env.automatic();
    const before = env.records();
    // CloudPanel's cached public IPv4 expired on a server behind NAT, and a second IPv6 appeared.
    env.addresses.ipv4 = null;
    env.addresses.ipv6 = null;
    const state = await env.act("check");
    expect(env.records()).toEqual(before);
    expect(state.sites.find((entry) => entry.domain === "example.com")!.plan!.problems[0]).toContain("IPv4 address could not be detected");
    // A server with no IPv6 at all is different: its AAAA records go.
    env.addresses.ipv4 = "203.0.113.10";
    env.addresses.ipv6 = "";
    await env.act("check");
    expect(env.records().filter((record) => record.startsWith("AAAA"))).toEqual([]);
  });

  test("editing a profile's records once Automatic is reviewed, renaming it is not", async () => {
    const env = setup();
    await env.connect();
    await env.act("assign", { domains: ["example.com"], profileId: "web" });
    await env.automatic();
    const web = (await env.act("list")).profiles.find((profile) => profile.id === "web")!;
    const renamed = await env.act("save-profile", { ...web, name: "Websites" });
    expect(renamed.review).toBeUndefined();
    expect(renamed.profiles.find((profile) => profile.id === "web")!.name).toBe("Websites");
    const changed = await env.act("save-profile", { ...web, records: [...web.records, { type: "TXT", name: "_dmarc.{domain}", content: "v=DMARC1; p=none", ttl: 1 }] });
    expect(changed.review!.sites[0]!.changes.map((change) => `${change.action} ${change.subject}`)).toEqual(["create TXT _dmarc.example.com"]);
    // A row taken out stops being kept; what it wrote stays.
    const fewer = await env.act("save-profile", { ...web, records: web.records.filter((record) => record.type === "A") });
    expect(fewer.review!.sites[0]!.changes).toEqual([]);
  });

  test("a plan that changed before it was confirmed is shown again instead of applied", async () => {
    const env = setup();
    await env.connect();
    await env.act("assign", { domains: ["example.com"], profileId: "web" });
    const review = await env.act("set-automatic", { automatic: true });
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
    const review = await env.act("set-automatic", { automatic: true });
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
    await env.automatic();
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

  test("Ask first reads Mailcow and shows what it would do without doing it", async () => {
    const env = await mailSetup();
    const state = await env.act("check");
    const changes = state.sites.find((entry) => entry.domain === "example.com")!.plan!.changes.map((change) => change.subject);
    expect(changes).toEqual(expect.arrayContaining(["Mailcow domain", "Mailcow DKIM key", "Mailcow sender permission"]));
    expect(env.mc.writes()).toEqual([]);
  });

  test("a sender list this Mailcow does not report is left for a person, and nothing else waits for it", async () => {
    const env = await mailSetup();
    env.mc.reportsAcl = false;
    await env.automatic();
    expect(env.mc.writes().some((call) => call.path === "/edit/mailbox")).toBe(false);
    expect(env.records()).toContain("MX example.com mail.example.net");
  });

  test("a new Mailcow address and key are saved together, once their review is confirmed", async () => {
    const env = await mailSetup();
    await env.automatic();
    const secrets = () => readFileSync(join(env.dir, "state", "secrets.json"), "utf8");
    env.mc.apiKey = "MC-NEW-KEY-0123456789ABCDEF";
    const review = await env.act("save-mailcow", {
      url: "https://mail2.example.net", key: env.mc.apiKey, host: "mail.example.net",
      dkimSource: "example.net", dkimSelector: "dkim", dkimBits: 2048, sharedMailbox: "relay@example.net",
    });
    expect(review.mailcow.url).toBe("https://mail.example.net");
    expect(secrets()).toContain(MAILCOW_KEY);
    expect(secrets()).not.toContain(env.mc.apiKey);
    const confirmed = await env.act("confirm", { token: review.review!.token });
    expect(confirmed.mailcow.url).toBe("https://mail2.example.net");
    expect(secrets()).toContain(env.mc.apiKey);
  });

  test("a bare hostname is Mailcow's address and what {mailcow.host} is", async () => {
    const env = setup();
    env.mc.mailboxes.set("relay@example.net", { sender_acl: [] });
    const reply = await env.act("save-mailcow", { url: "mail.example.net", key: MAILCOW_KEY, sharedMailbox: "relay@example.net" });
    expect([reply.mailcow.url, reply.mailcow.host]).toEqual(["https://mail.example.net", "mail.example.net"]);
  });

  test("Mailcow is removed with its key, and its sites wait for it without anything being deleted", async () => {
    const env = await mailSetup();
    await env.automatic();
    const records = env.records();
    const reply = await env.act("remove-mailcow", {});
    expect(reply.mailcow).toMatchObject({ url: "", host: "", sharedMailbox: "", hasKey: false });
    expect(readFileSync(join(env.dir, "state", "secrets.json"), "utf8")).not.toContain(MAILCOW_KEY);
    expect(reply.sites.find((entry) => entry.domain === "example.com")!.plan!.problems.join(" ")).toContain("set up Mailcow's");
    expect(env.records()).toEqual(records);
    expect(env.mc.writes().some((call) => call.path.startsWith("/delete"))).toBe(false);
    await expect(env.act("remove-mailcow", {})).rejects.toThrow("Mailcow is not set up");
  });

  test("SMTP Relay's accounts are offered to fill Mailcow from, without their passwords", async () => {
    const env = setup();
    const relay = { host: "mail.example.net", port: 587, username: "relay@example.net", password: "relay-password-0123" };
    writeFileSync(join(env.dir, "smtp.json"), JSON.stringify({
      version: 2, defaultProfileId: null, assignments: {}, grants: {}, knownSiteIds: [],
      profiles: [{ id: "dont-send", name: "Don't send", relay: null, sender: "noreply@{site}" }, { id: "mailcow", name: "Mailcow", relay, sender: "noreply@{site}" }],
    }));
    chmodSync(join(env.dir, "smtp.json"), 0o600);
    const state = await env.act("list");
    expect(state.smtpRelays).toEqual([{ profile: "Mailcow", host: "mail.example.net", username: "relay@example.net" }]);
    expect(JSON.stringify(state)).not.toContain(relay.password);
    chmodSync(join(env.dir, "smtp.json"), 0o666);
    expect((await env.act("list")).smtpRelays).toEqual([]);
  });
});

describe("several connections", () => {
  test("a site is managed in the longest zone any connection reaches", async () => {
    const env = setup();
    env.cf.zone("shop.example.com", env.church);
    await env.connect();
    await env.act("save-connection", { token: SECOND_TOKEN, label: "Church" });
    await env.act("assign", { domains: ["shop.example.com"], profileId: "web" });
    await env.automatic();
    expect(env.records("shop.example.com")).toContain("A shop.example.com 203.0.113.10 proxied");
    expect(env.records("example.com")).toEqual([]);
  });

  test("a zone two connections reach is used through the first until another is chosen", async () => {
    const env = setup();
    await env.connect();
    await env.act("save-connection", { token: SECOND_TOKEN, label: "Church" });
    await env.act("assign", { domains: ["example.com"], profileId: "web" });
    await env.automatic();
    expect(env.cf.writes().every((call) => env.cf.calls.find((entry) => entry === call)!.token === TOKEN)).toBe(true);
  });

  test("the first connection writes a shared zone even when another answers sooner", async () => {
    const env = setup();
    await env.connect();
    await env.act("save-connection", { token: SECOND_TOKEN, label: "Church" });
    await env.act("assign", { domains: ["example.com"], profileId: "web" });
    env.latency.set(TOKEN, 25);
    await env.automatic();
    expect(env.cf.writes().length).toBeGreaterThan(0);
    expect(env.cf.writes().every((call) => env.cf.calls.find((entry) => entry === call)!.token === TOKEN)).toBe(true);
  });

  test("a zone only a failing connection reaches is not created again in another account", async () => {
    const env = setup();
    env.cf.zone("example.net", env.church);
    env.sites.push(site(3, "example.net"));
    await env.connect();
    await env.act("save-connection", { token: SECOND_TOKEN, label: "Church" });
    const state = await env.act("list");
    await env.act("zone-account", { createIn: { connectionId: state.connections[0]!.id, accountId: env.agency } });
    await env.act("assign", { domains: ["example.net"], profileId: "web" });
    env.cf.tokens.delete(SECOND_TOKEN);
    const reply = await env.act("set-automatic", { automatic: true });
    if (reply.review && !reply.review.blocked) await env.act("confirm", { token: reply.review.token });
    expect(env.cf.zones.filter((zone) => zone.name === "example.net")).toHaveLength(1);
  });

  test("two zones with one name must be chosen between, and the choice is where records go", async () => {
    const env = setup();
    const theirs = env.cf.zone("example.net", env.agency);
    const ours = env.cf.zone("example.net", env.church);
    env.sites.push(site(3, "example.net"));
    await env.connect();
    const second = await env.act("save-connection", { token: SECOND_TOKEN, label: "Church" });
    await env.act("assign", { domains: ["example.net"], profileId: "web" });
    const blocked = await env.act("set-automatic", { automatic: true });
    expect(blocked.review!.blocked).toBe(true);
    const plan = blocked.review!.sites[0]!;
    // The agency's zone is reachable through both tokens, so it is offered twice: once per connection.
    expect(plan.zoneChoices).toHaveLength(3);
    expect([...new Set(plan.zoneChoices.map((choice) => choice.zoneId))].sort()).toEqual([theirs.id, ours.id].sort());
    const church = second.connections.find((connection) => connection.label === "Church")!;
    await env.act("choose-zone", { zone: "example.net", connectionId: church.id, zoneId: ours.id });
    await env.automatic();
    expect(env.cf.records.get(ours.id)!.length).toBeGreaterThan(0);
    expect(env.cf.records.get(theirs.id)).toEqual([]);

    // With the chosen connection gone, the zone left over is not the one chosen.
    env.cf.tokens.delete(SECOND_TOKEN);
    await env.act("reconcile");
    expect(env.cf.records.get(theirs.id)).toEqual([]);
    const lost = (await env.act("list")).sites.find((entry) => entry.domain === "example.net")!.plan!;
    expect(lost.problems.join()).toContain("cannot be reached");
  });
});

describe("zones and new sites", () => {
  test("a missing zone is created in the only account there is, and DNS is not ready until it is active", async () => {
    const env = setup();
    env.sites.push(site(3, "new-client.example.org"));
    await env.connect();
    await env.act("assign", { domains: ["new-client.example.org"], profileId: "web" });
    const review = await env.act("set-automatic", { automatic: true });
    expect(review.review!.sites[0]!.changes[0]).toMatchObject({ action: "create", subject: "Cloudflare zone" });
    const reply = await env.act("confirm", { token: review.review!.token });
    const zone = env.cf.zones.find((candidate) => candidate.name === "example.org")!;
    expect(zone.status).toBe("pending");
    expect(env.records("example.org")).toContain("A new-client.example.org 203.0.113.10 proxied");
    expect(reply.log.find((line) => line.subject === "Cloudflare zone")).toMatchObject({
      sites: ["new-client.example.org"], zone: "example.org", cause: "Confirmed review", detail: expect.stringContaining("ada.ns.cloudflare.com"),
    });
    const provision = await env.act<ProvisionReply>("provision", undefined, ["--domain=new-client.example.org"]);
    expect(provision.ready).toBe(false);
    expect(provision.reason).toContain("ada.ns.cloudflare.com");
  });

  test("with several accounts, a missing zone waits until one is chosen for new zones", async () => {
    const env = setup();
    env.sites.push(site(3, "new-client.example.org"));
    await env.connect();
    const second = await env.act("save-connection", { token: SECOND_TOKEN, label: "Church" });
    await env.act("assign", { domains: ["new-client.example.org"], profileId: "web" });
    const blocked = await env.act("set-automatic", { automatic: true });
    expect(blocked.review!.blocked).toBe(true);
    expect(blocked.review!.sites[0]!.problems).toEqual(["example.org is not in Cloudflare; choose the account for new zones under Settings"]);
    const first = second.connections.find((connection) => connection.label !== "Church")!;
    await env.act("zone-account", { createIn: { connectionId: first.id, accountId: env.agency } });
    await env.automatic();
    expect(env.cf.zones.find((candidate) => candidate.name === "example.org")!.account.id).toBe(env.agency);
    // A removed connection takes the choice with it.
    const after = await env.act("remove-connection", { id: first.id });
    expect(after.createIn).toBeNull();
  });

  test("a policy saved with a mode on each profile is Automatic only if every profile with sites enforced", async () => {
    const env = setup();
    const connected = await env.connect();
    const id = connected.connections[0]!.id;
    const policyFile = join(env.dir, "state", "policy.json");
    const saved = JSON.parse(readFileSync(policyFile, "utf8"));
    delete saved.automatic;
    delete saved.createIn;
    const legacy = (modes: string[]) => ({
      ...saved,
      profiles: saved.profiles.map((profile: object, index: number) => ({ ...profile, mode: modes[index], zone: { createIn: index ? { connectionId: id, accountId: env.agency } : null } })),
    });
    const read = async (policy: unknown) => {
      writeFileSync(policyFile, JSON.stringify(policy));
      return env.act("list");
    };
    expect((await read({ ...legacy(["enforce", "report"]), assignments: { "example.com": "web" } })).automatic).toBe(true);
    const mixed = await read({ ...legacy(["enforce", "report"]), assignments: { "example.com": "web", "shop.example.com": "web-mailcow" } });
    expect(mixed.automatic).toBe(false);
    expect(mixed.createIn).toEqual({ connectionId: id, accountId: env.agency });
    expect((await read({ ...legacy(["enforce", "enforce"]), assignments: {} })).automatic).toBe(false);
  });

  test("a new site joins the default profile and is written at once; existing sites stay where they are", async () => {
    const env = setup();
    await env.connect();
    await env.act("assign", { domains: ["example.com"], profileId: "web" });
    await env.automatic();
    await env.act("set-default", { profileId: "web" });
    env.sites.push(site(7, "fresh.example.com", { createdAt: START }));
    const synced = await env.act<{ joined: string[] }>("sync-sites");
    expect(synced.joined).toEqual(["fresh.example.com"]);
    expect(env.records()).toContain("A fresh.example.com 203.0.113.10 proxied");
    const state = await env.act("list");
    expect(state.sites.find((entry) => entry.domain === "shop.example.com")!.profileId).toBeNull();
    // A vhost rewrite can wake this repeatedly without adding a site.
    const calls = [env.cf.calls.length, env.mc.calls.length];
    const policyFile = join(env.dir, "state", "policy.json");
    const inode = statSync(policyFile).ino;
    for (let pass = 0; pass < 3; pass++) await env.act("sync-sites");
    expect([env.cf.calls.length, env.mc.calls.length]).toEqual(calls);
    expect(statSync(policyFile).ino).toBe(inode);
  });

  test("a new site points its own names here at once; the rest of its profile waits for an administrator", async () => {
    const env = setup();
    const zone = env.cf.zone("client.org", env.agency);
    env.cf.record("client.org", { type: "CNAME", name: "mail.client.org", content: "mx.mailhost.example" });
    await env.connect();
    await env.act("set-default", { profileId: "web" });
    await env.automatic();
    env.sites.push(site(8, "mail.client.org", { createdAt: START }));
    await env.act("sync-sites");
    expect(env.records("client.org")).toContain("A mail.client.org 203.0.113.10 proxied");
    expect(env.records("client.org").some((record) => record.startsWith("CNAME mail.client.org"))).toBe(false);
    // Strict SSL and Always Use HTTPS would change every name in the zone.
    expect(env.cf.settings.get(`${zone.id}:ssl`)).toBeUndefined();
    let plan = (await env.act("list")).sites.find((entry) => entry.domain === "mail.client.org")!.plan!;
    expect(plan.held).toBe(true);
    expect(plan.changes.filter((change) => change.waits).map((change) => change.subject)).toEqual(["Zone setting, whole zone", "Zone setting, whole zone"]);
    expect((await env.act<ProvisionReply>("provision", undefined, ["--domain=mail.client.org"])).ready).toBe(true);
    // The repair pass keeps holding it.
    await env.act("reconcile");
    expect(env.cf.settings.get(`${zone.id}:ssl`)).toBeUndefined();

    const review = await env.act("assign", { domains: ["mail.client.org"], profileId: "web" });
    expect(review.review!.blocked).toBe(false);
    await env.act("confirm", { token: review.review!.token });
    expect(env.cf.settings.get(`${zone.id}:ssl`)).toBe("strict");
    plan = (await env.act("list")).sites.find((entry) => entry.domain === "mail.client.org")!.plan!;
    expect(plan.held).toBeUndefined();
  });

  test("a new site whose zone cannot be read yet stays held until a check can plan it", async () => {
    const env = setup();
    const zone = env.cf.zone("client.org", env.agency);
    await env.connect();
    await env.act("set-default", { profileId: "web" });
    await env.automatic();
    const token = env.cf.tokens.get(TOKEN)!;
    env.cf.tokens.delete(TOKEN);
    env.sites.push(site(8, "mail.client.org", { createdAt: START }));
    await env.act("sync-sites");
    env.cf.tokens.set(TOKEN, token);
    await env.act("reconcile");
    expect(env.records("client.org")).toContain("A mail.client.org 203.0.113.10 proxied");
    expect(env.cf.settings.get(`${zone.id}:ssl`)).toBeUndefined();
    expect((await env.act("list")).sites.find((entry) => entry.domain === "mail.client.org")!.plan!.held).toBe(true);
  });

  test("a new site that only adds records and points its own names is not held", async () => {
    const env = setup();
    await env.connect();
    await env.act("assign", { domains: ["example.com"], profileId: "web" });
    await env.automatic();
    await env.act("set-default", { profileId: "web" });
    env.sites.push(site(7, "fresh.example.com", { createdAt: START }));
    await env.act("sync-sites");
    expect((await env.act("list")).sites.find((entry) => entry.domain === "fresh.example.com")!.plan!.held).toBeUndefined();
  });

  test("one empty read of the panel's sites leaves every assignment alone", async () => {
    const env = setup();
    await env.connect();
    await env.act("assign", { domains: ["example.com"], profileId: "web" });
    await env.automatic();
    await env.act("set-default", { profileId: "web" });
    const sites = env.sites.splice(0);
    await env.act("sync-sites");
    env.sites.push(...sites);
    await env.act("sync-sites");
    const state = await env.act("list");
    expect(state.sites.map((entry) => [entry.domain, entry.profileId])).toEqual([["example.com", "web"], ["shop.example.com", null]]);
  });

  test("provisioning names www for a certificate only at the apex", async () => {
    const env = setup();
    await env.connect();
    await env.act("assign", { domains: ["example.com", "shop.example.com"], profileId: "web" });
    await env.automatic();
    expect(await env.act<ProvisionReply>("provision", undefined, ["--domain=example.com"]))
      .toEqual({ managed: true, ready: true, reason: "DNS is in place", certificateNames: ["example.com", "www.example.com"] });
    expect((await env.act<ProvisionReply>("provision", undefined, ["--domain=shop.example.com"])).certificateNames).toEqual(["shop.example.com"]);
  });

  test("a site with no profile, or any site while DNS asks first, is not DNS's to hold up", async () => {
    const env = setup();
    await env.connect();
    expect(await env.act<ProvisionReply>("provision", undefined, ["--domain=example.com"])).toMatchObject({ managed: false });
    await env.act("assign", { domains: ["example.com"], profileId: "web" });
    expect(await env.act<ProvisionReply>("provision", undefined, ["--domain=example.com"])).toMatchObject({ managed: false });
    expect(env.cf.writes()).toEqual([]);
  });

  test("an ordinary panel user may provision only their own sites", async () => {
    const env = setup();
    const db = new Database(join(env.dir, "db.sq3"));
    db.exec(`CREATE TABLE user (id INTEGER PRIMARY KEY, user_name TEXT, role TEXT, status INTEGER);
      CREATE TABLE site (id INTEGER PRIMARY KEY, domain_name TEXT);
      CREATE TABLE user_sites (user_id INTEGER, site_id INTEGER);
      INSERT INTO user VALUES (1, 'bob', 'ROLE_USER', 1);
      INSERT INTO site VALUES (1, 'example.com'), (2, 'shop.example.com');
      INSERT INTO user_sites VALUES (1, 2);`);
    db.close();
    env.sites[1]!.createdAt = env.clock.now - 60_000;
    await env.connect();
    await expect(env.act("provision", undefined, ["--domain=example.com", "--as-user=bob"])).rejects.toThrow("not one of yours");
    expect(await env.act<ProvisionReply>("provision", undefined, ["--domain=shop.example.com", "--as-user=bob"])).toMatchObject({ managed: false });

    // Why DNS is not ready can quote Cloudflare's errors; only an administrator reads it.
    await env.act("assign", { domains: ["shop.example.com"], profileId: "web" });
    await env.automatic();
    env.cf.tokens.delete(TOKEN);
    const admin = await env.act<ProvisionReply>("provision", undefined, ["--domain=shop.example.com"]);
    expect(admin).toMatchObject({ managed: true, ready: false });
    expect(admin.reason).toContain("Cloudflare could not be read");
    expect(await env.act<ProvisionReply>("provision", undefined, ["--domain=shop.example.com", "--as-user=bob"]))
      .toEqual({ managed: true, ready: false, reason: "an administrator can see why on the DNS page", certificateNames: [] });

    // What the owner can act on, such as a pending zone's nameservers, they still see.
    env.cf.token(TOKEN, { owner: "user", accounts: [env.agency], zoneEdit: true });
    env.cf.zones[0]!.status = "pending";
    const pending = await env.act<ProvisionReply>("provision", undefined, ["--domain=shop.example.com", "--as-user=bob"]);
    expect(pending.reason).toContain("set its nameservers at the registrar");
    expect(pending).toMatchObject({ zone: "example.com", nameServers: ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"] });
  });

  test("a site's own pages see its zone's nameservers from the last check, and only the owner's", async () => {
    const env = setup();
    const db = new Database(join(env.dir, "db.sq3"));
    db.exec(`CREATE TABLE user (id INTEGER PRIMARY KEY, user_name TEXT, role TEXT, status INTEGER);
      CREATE TABLE site (id INTEGER PRIMARY KEY, domain_name TEXT);
      CREATE TABLE user_sites (user_id INTEGER, site_id INTEGER);
      INSERT INTO user VALUES (1, 'bob', 'ROLE_USER', 1);
      INSERT INTO site VALUES (1, 'example.com'), (2, 'shop.example.com');
      INSERT INTO user_sites VALUES (1, 2);`);
    db.close();
    env.cf.zones[0]!.status = "pending";
    await env.connect();
    const status = (args: string[]) => env.act<SiteDnsStatus>("site-status", undefined, args);
    expect(await status(["--domain=shop.example.com", "--as-user=bob"])).toEqual({ zone: null, status: null, nameServers: [], certificate: "installed" });
    await env.act("assign", { domains: ["shop.example.com"], profileId: "web" });
    await env.automatic();
    const calls = env.cf.calls.length;
    expect(await status(["--domain=shop.example.com", "--as-user=bob"]))
      .toEqual({ zone: "example.com", status: "pending", nameServers: ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"], certificate: "installed" });
    expect(env.cf.calls.length).toBe(calls);
    await expect(status(["--domain=example.com", "--as-user=bob"])).rejects.toThrow("not one of yours");
    // Once active there is nothing to set.
    env.cf.zones[0]!.status = "active";
    await env.act("check");
    expect(await status(["--domain=shop.example.com"])).toEqual({ zone: "example.com", status: "active", nameServers: [], certificate: "installed" });
  });

  test("the nameserver notice promises a certificate only where DNS will request one", async () => {
    const env = setup();
    env.cf.zones[0]!.status = "pending";
    env.sites.push(site(9, "fresh.example.com", { createdAt: START - 60_000, selfSigned: true }));
    env.sites.push(site(10, "old.example.com", { selfSigned: true }));
    await env.connect();
    await env.act("assign", { domains: ["fresh.example.com", "old.example.com"], profileId: "web" });
    await env.automatic();
    // A site created with automatic SSL asked for has its request recorded; an older one has none.
    await env.act("provision", undefined, ["--domain=fresh.example.com", "--ssl"]);
    const certificate = async (domain: string) => (await env.act<SiteDnsStatus>("site-status", undefined, [`--domain=${domain}`])).certificate;
    expect(await certificate("fresh.example.com")).toBe("automatic");
    expect(await certificate("old.example.com")).toBe("manual");
  });
});

describe("automatic SSL", () => {
  async function pending() {
    const env = setup();
    env.cf.zones[0]!.status = "pending";
    env.sites.push(site(9, "brand-new.example.com", { createdAt: START - 60_000, selfSigned: true }));
    await env.connect();
    await env.act("assign", { domains: ["brand-new.example.com"], profileId: "web" });
    await env.automatic();
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
    await env.act("set-automatic", { automatic: false });
    await env.act("reconcile");
    expect((await env.act("list")).sites.find((entry) => entry.domain === "brand-new.example.com")!.ssl).toBeNull();
  });

  test("is not recorded for a site that was not just created", async () => {
    const env = setup();
    env.sites.push(site(9, "old.example.com", { createdAt: START - 3_600_000, selfSigned: true }));
    await env.connect();
    await env.act("assign", { domains: ["old.example.com"], profileId: "web" });
    await env.automatic();
    await env.act("provision", undefined, ["--domain=old.example.com", "--ssl"]);
    expect((await env.act("list")).sites.find((entry) => entry.domain === "old.example.com")!.ssl).toBeNull();
  });
});

describe("sites CloudPanel no longer has", () => {
  test("cleanup preserves records whose proxy, TTL, priority or comment was edited", async () => {
    const env = setup();
    await env.connect();
    const { profiles } = await env.act("list");
    const web = profiles.find((profile) => profile.id === "web")!;
    await env.act("save-profile", { ...web, records: [
      ...web.records,
      { type: "MX", name: "{domain}", content: "mail.example.net", priority: 10, ttl: 300 },
      { type: "TXT", name: "{domain}", content: "verify-me", ttl: 300 },
    ] });
    await env.act("assign", { domains: ["example.com"], profileId: "web" });
    await env.automatic();
    const records = env.cf.recordsOf("example.com");
    records.find((record) => record.type === "A" && record.name === "example.com")!.proxied = false;
    records.find((record) => record.type === "TXT")!.ttl = 600;
    records.find((record) => record.type === "MX")!.priority = 20;
    records.find((record) => record.type === "AAAA" && record.name === "example.com")!.comment = "Keep this record";
    env.sites.splice(0, 1);
    const review = await env.act("remove-records", { domain: "example.com" });
    expect(review.review!.sites[0]!.changes.map((change) => change.subject)).toEqual(["A www.example.com", "AAAA www.example.com"]);
  });

  test("cleanup refuses while a current site's record names cannot be planned safely", async () => {
    const env = setup();
    await env.connect();
    await env.act("assign", { domains: ["example.com"], profileId: "web" });
    await env.automatic();
    env.sites.push(site(3, "www.example.com"));
    const assignment = await env.act("assign", { domains: ["www.example.com"], profileId: "web" });
    await env.act("confirm", { token: assignment.review!.token });
    env.sites.splice(0, 1);
    env.addresses.ipv4 = null;
    env.addresses.ipv6 = null;
    const writes = env.cf.writes().length;
    await expect(env.act("remove-records", { domain: "example.com" })).rejects.toThrow("could not be planned");
    expect(env.cf.writes().length).toBe(writes);
  });

  test("their records are removed only after review, and only the unchanged ones", async () => {
    const env = setup();
    await env.connect();
    await env.act("assign", { domains: ["example.com", "shop.example.com"], profileId: "web" });
    await env.automatic();
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

  test("a site owner's provision reaches Cloudflare only for a new site", async () => {
    const env = setup();
    await env.connect();
    await env.act("assign", { domains: ["shop.example.com"], profileId: "web" });
    await env.automatic();
    const db = new Database(join(env.dir, "db.sq3"), { create: true });
    db.exec("CREATE TABLE user (id INTEGER PRIMARY KEY, user_name TEXT, role TEXT, status INTEGER)");
    db.exec("INSERT INTO user VALUES (1, 'bob', 'ROLE_ADMIN', 1)");
    db.close();
    const calls = env.cf.calls.length;
    const old = await env.act<{ managed: boolean; ready: boolean }>("provision", undefined, ["--domain=shop.example.com", "--as-user=bob"]);
    expect(old.managed).toBe(true);
    expect(env.cf.calls.length).toBe(calls);
    env.sites.find((entry) => entry.domain === "shop.example.com")!.createdAt = env.clock.now - 60_000;
    await env.act("provision", undefined, ["--domain=shop.example.com", "--as-user=bob"]);
    expect(env.cf.calls.length).toBeGreaterThan(calls);
  });

  test("a site taken out of enforcing leaves no records to remove once it is deleted", async () => {
    const env = setup();
    await env.connect();
    await env.act("assign", { domains: ["shop.example.com"], profileId: "web" });
    await env.automatic();
    await env.act("assign", { domains: ["shop.example.com"], profileId: null });
    env.sites.splice(env.sites.findIndex((entry) => entry.domain === "shop.example.com"), 1);
    expect((await env.act("list")).orphans).toEqual([]);
  });

  test("Keep forgets them and changes nothing in Cloudflare", async () => {
    const env = setup();
    await env.connect();
    await env.act("assign", { domains: ["shop.example.com"], profileId: "web" });
    await env.automatic();
    env.sites.splice(env.sites.findIndex((entry) => entry.domain === "shop.example.com"), 1);
    const writes = env.cf.writes().length;
    expect((await env.act("forget-records", { domain: "shop.example.com" })).orphans).toEqual([]);
    expect(env.cf.writes().length).toBe(writes);
  });
});

describe("limits and failures", () => {
  test("a token check that is rate limited remembers the wait even though nothing is saved", async () => {
    const env = setup();
    env.cf.limit = { after: 0, retryAfter: "600" };
    await expect(env.connect()).rejects.toThrow("asked to wait");
    const calls = env.cf.calls.length;
    await expect(env.connect()).rejects.toThrow("asked to wait");
    expect(env.cf.calls.length).toBe(calls);
    expect((await env.act("list")).waitUntil).toBeGreaterThan(Date.now());
  });

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
    await env.automatic();
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

test("an address is detected only when it can be told, and an IPv4 is never taken to be missing", () => {
  const nic = (...addresses: string[]) => ({
    eth0: addresses.map((address) => ({ address, family: address.includes(":") ? "IPv6" : "IPv4", internal: false })),
    lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
  });
  expect(detectAddresses(nic("46.225.93.37", "2a01:4f8:c2c:7b9::1", "fe80::1"), "")).toEqual({ ipv4: "46.225.93.37", ipv6: "2a01:4f8:c2c:7b9::1" });
  // Behind NAT, once CloudPanel's cached address has expired.
  expect(detectAddresses(nic("10.0.0.5"), "")).toEqual({ ipv4: null, ipv6: "" });
  expect(detectAddresses(nic("10.0.0.5"), "203.0.113.10")).toEqual({ ipv4: "203.0.113.10", ipv6: "" });
  expect(detectAddresses(nic("203.0.113.10", "203.0.113.11", "2001:4860::1", "2001:4860::2"), "")).toEqual({ ipv4: null, ipv6: null });
});

test("an attempt cut short still counts toward the certificate limit", async () => {
  const domain = "brand-new.example.com";
  const requests: Record<string, SslRequest> = {
    [domain]: { siteId: 7, requestedAt: START, attempts: MAX_ATTEMPTS, nextAttemptAt: 0, state: "Requesting a certificate", done: false },
  };
  const plan = {
    domain, profileId: "web", mode: "enforce", problems: [], changes: [], certificateNames: [domain],
    zone: { name: "example.com", status: "active", nameServers: [] },
  } as unknown as SitePlan;
  let issued = 0;
  await retryCertificates(requests, [plan], () => [site(7, domain, { selfSigned: true })], async () => { issued++; return false; }, START, () => {});
  expect(issued).toBe(0);
  expect(requests[domain]).toMatchObject({ done: true, attempts: MAX_ATTEMPTS });
});

test("state that cannot be read while redacting does not hide the failure", async () => {
  const env = setup();
  await env.connect();
  chmodSync(join(env.dir, "state", "secrets.json"), 0o666);
  await expect(env.act("set-automatic", { automatic: "sometimes" })).rejects.toThrow("Say whether DNS is Automatic");
});

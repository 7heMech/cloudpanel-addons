import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeDnsAction, type DnsReply } from "../addons/dns/action";
import type { PanelSite, StandIn, StandIns } from "../addons/dns/engine";
import { seededPolicy } from "../addons/dns/presets";
import { renderRedirect, type SiteVars } from "../addons/dns/records";
import { foundRedirect, redirectRef, redirectRuleState, wholeHostHosts } from "../addons/dns/redirects";
import { clpctlStandIns, readStandIns, standInBody, type StandInPaths } from "../addons/dns/stand-in";
import type { CfRule } from "../addons/dns/cloudflare";
import type { Redirect } from "../addons/dns/model";
import { FakeCloudflare, FakeMailcow, hexId, MAILCOW_KEY, routed } from "./fixtures/dns-api";

const TOKEN = "cf-church-token-0123456789abcdef";
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ACME = ' and not starts_with(http.request.uri.path, "/.well-known/acme-challenge/")';
const AMAZON = "https://www.amazon.com/Courage-Crisis-Ultimate-Guide-Success/dp/B0BVDW3HLB";

/** A rule exactly as the archived OpenTofu repo left it: no ref of its own, so Cloudflare reports its id. */
function terraformRule(hosts: string, target: string): Record<string, unknown> {
  const id = hexId();
  return {
    id, ref: id, action: "redirect", enabled: true, description: "", version: "1",
    expression: `${hosts}${ACME}`,
    action_parameters: { from_value: { status_code: 301, target_url: { expression: `concat("${target}", http.request.uri.path)` }, preserve_query_string: true } },
  };
}

const apexHosts = (domain: string) => `(http.host eq "${domain}" or http.host eq "www.${domain}")`;

/** What Terraform left at a Mailcow client's apex: proxied web records at CloudPanel, and the mail records. */
function terraformZone(cf: FakeCloudflare, account: string, domain: string, target: string): string[] {
  const zone = cf.zone(domain, account);
  for (const name of [domain, `www.${domain}`]) {
    cf.record(domain, { type: "A", name, content: "46.225.220.253", proxied: true });
    cf.record(domain, { type: "AAAA", name, content: "2a01:4f8:c2c:ec6::1", proxied: true });
  }
  const mail = [
    cf.record(domain, { type: "MX", name: domain, content: "mail.hzn.bg", priority: 10 }),
    cf.record(domain, { type: "TXT", name: domain, content: "v=spf1 mx ~all" }),
    cf.record(domain, { type: "TXT", name: `dkim._domainkey.${domain}`, content: "v=DKIM1;k=rsa;t=s;s=email;p=MIIBIjANBgkqh" }),
    cf.record(domain, { type: "CNAME", name: `autoconfig.${domain}`, content: "mail.hzn.bg" }),
    cf.record(domain, { type: "CNAME", name: `autodiscover.${domain}`, content: "mail.hzn.bg" }),
    cf.record(domain, { type: "CNAME", name: `webmail.${domain}`, content: "mail.hzn.bg", proxied: true }),
    cf.record(domain, { type: "SRV", name: `_autodiscover._tcp.${domain}`, content: "0 443 mail.hzn.bg", priority: 0 }),
  ];
  cf.rulesets.set(`${zone.id}:http_request_dynamic_redirect`, { id: hexId(), rules: [terraformRule(apexHosts(domain), target)] });
  return mail.map((record) => JSON.stringify(record));
}

class FakeStandIns implements StandIns {
  current: Record<string, StandIn> = {};
  calls: string[] = [];
  constructor(private readonly sites: PanelSite[]) {}
  async create(redirect: Redirect) {
    this.calls.push(`create ${redirect.source}`);
    this.sites.push({ id: 900 + this.sites.length, domain: redirect.source, type: "static", createdAt: 0, selfSigned: true, cloudflareOnly: false });
  }
  async update(redirect: Redirect) {
    this.calls.push(`update ${redirect.source} ${redirect.target}`);
  }
  async remove(source: string) {
    this.calls.push(`remove ${source}`);
    this.sites.splice(this.sites.findIndex((site) => site.domain === source), 1);
  }
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "dns-redirects-"));
  dirs.push(dir);
  writeFileSync(join(dir, "dns.conf"), "enabled");
  const cf = new FakeCloudflare();
  const mc = new FakeMailcow();
  const account = cf.account("HAZON LTD");
  cf.token(TOKEN, { owner: "user", accounts: [account], zoneEdit: true });
  const sites: PanelSite[] = [];
  const standIns = new FakeStandIns(sites);
  const fetch = routed(cf, mc);
  const env = {
    dir, cf, mc, account, sites, standIns,
    async act<T = DnsReply>(verb: string, body?: unknown): Promise<T> {
      return await executeDnsAction([verb], {
        paths: { configFile: join(dir, "dns.conf"), stateDir: join(dir, "state"), smtpConfig: join(dir, "smtp.json"), lockFile: join(dir, "dns.lock"), panelDb: join(dir, "db.sq3"), rootUid: process.getuid!(), clpctl: "/bin/false" },
        processUid: 0,
        input: body === undefined ? undefined : JSON.stringify(body),
        fetch,
        sites: () => sites,
        addresses: () => ({ ipv4: "46.225.220.253", ipv6: "2a01:4f8:c2c:ec6::1" }),
        issue: async () => false,
        standIns: () => standIns,
      }) as T;
    },
    /** Confirms a review if the reply carries one, as the page does. */
    async confirmed(reply: DnsReply): Promise<DnsReply> {
      if (!reply.review) return reply;
      expect(reply.review.blocked).toBe(false);
      return env.act("confirm", { token: reply.review.token });
    },
    async automatic(): Promise<DnsReply> {
      return env.confirmed(await env.act("set-automatic", { automatic: true }));
    },
    redirectRules(domain: string): Record<string, unknown>[] {
      const zone = cf.zones.find((candidate) => candidate.name === domain)!;
      return cf.rulesets.get(`${zone.id}:http_request_dynamic_redirect`)?.rules ?? [];
    },
  };
  return env;
}

const found = (domain: string, target: string, keepPath = true) => ({ source: domain, target, status: 301, keepPath, keepQuery: true });

describe("taking over the redirects Terraform left", () => {
  test("the rule is updated in place, the web records become the placeholder, and the mail records stay", async () => {
    const env = setup();
    const mail = terraformZone(env.cf, env.account, "renaissancecentre.bg", "https://renaissance.bg");
    const rule = env.redirectRules("renaissancecentre.bg")[0]!;
    await env.act("save-connection", { token: TOKEN });
    await env.automatic();

    const review = (await env.act("take-over", { redirects: [found("renaissancecentre.bg", "https://renaissance.bg")] })).review!;
    expect(review.blocked).toBe(false);
    const changes = review.sites[0]!.changes;
    expect(changes).toContainEqual(expect.objectContaining({
      action: "update", subject: "Cloudflare redirect rule",
      before: expect.stringContaining("another tool's rule, taken over in place"),
    }));
    expect(changes.some((change) => change.action === "create" && change.subject === "Cloudflare redirect rule")).toBe(false);
    expect(changes.filter((change) => /^(MX|TXT|SRV|CNAME) /.test(change.subject))).toEqual([]);
    await env.act("confirm", { token: review.token });

    const rules = env.redirectRules("renaissancecentre.bg");
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      id: rule.id, ref: redirectRef("renaissancecentre.bg"), enabled: true,
      expression: '(http.host eq "renaissancecentre.bg" or http.host eq "www.renaissancecentre.bg")',
      action_parameters: { from_value: { status_code: 301, target_url: { expression: 'concat("https://renaissance.bg", http.request.uri.path)' }, preserve_query_string: true } },
    });
    const records = env.cf.recordsOf("renaissancecentre.bg");
    const web = records.filter((record) => ["renaissancecentre.bg", "www.renaissancecentre.bg"].includes(String(record.name)) && ["A", "AAAA", "CNAME"].includes(String(record.type)));
    expect(web.map((record) => `${record.type} ${record.name} ${record.content} ${record.proxied}`).sort()).toEqual([
      "AAAA renaissancecentre.bg 100:: true", "AAAA www.renaissancecentre.bg 100:: true",
    ]);
    for (const record of mail) expect(records.map((current) => JSON.stringify(current))).toContain(record);

    const writes = env.cf.writes().length;
    await env.act("check");
    expect(env.cf.writes().length).toBe(writes);
  });

  test("courage.bg's Amazon target stops getting the path once Keep path is off", async () => {
    const env = setup();
    terraformZone(env.cf, env.account, "courage.bg", AMAZON);
    await env.act("save-connection", { token: TOKEN });
    await env.automatic();
    const listed = (await env.act("find-redirects")).found!;
    expect(listed.redirects).toEqual([{ source: "courage.bg", zone: "courage.bg", target: AMAZON, status: 301, keepPath: true, keepQuery: true }]);
    await env.confirmed(await env.act("take-over", { redirects: listed.redirects }));

    const edited = await env.act("save-redirect", { ...found("courage.bg", AMAZON, false) });
    expect(edited.review!.sites[0]!.changes).toContainEqual(expect.objectContaining({
      action: "update", subject: "Cloudflare redirect rule", detail: `courage.bg and www.courage.bg: 301 to ${AMAZON} · keeps the query string`,
    }));
    await env.act("confirm", { token: edited.review!.token });
    const rules = env.redirectRules("courage.bg");
    expect(rules).toHaveLength(1);
    expect(rules[0]!.action_parameters).toEqual({ from_value: { status_code: 301, target_url: { value: AMAZON }, preserve_query_string: true } });
  });

  test("tv.ren.ss is one host in a zone with other things, and nothing else in ren.ss changes", async () => {
    const env = setup();
    const zone = env.cf.zone("ren.ss", env.account);
    const others = [
      env.cf.record("ren.ss", { type: "AAAA", name: "ren.ss", content: "100::", proxied: true }),
      env.cf.record("ren.ss", { type: "AAAA", name: "api.ren.ss", content: "100::", proxied: true }),
      env.cf.record("ren.ss", { type: "A", name: "www.tv.ren.ss", content: "192.0.2.4" }),
    ].map((record) => JSON.stringify(record));
    env.cf.record("ren.ss", { type: "A", name: "tv.ren.ss", content: "46.225.220.253", proxied: true });
    const workerRule = { id: hexId(), ref: "worker", action: "redirect", enabled: true, description: "Old app", expression: 'http.host eq "app.ren.ss"',
      action_parameters: { from_value: { status_code: 302, target_url: { value: "https://api.ren.ss/" } } } };
    env.cf.rulesets.set(`${zone.id}:http_request_dynamic_redirect`, { id: hexId(), rules: [
      workerRule, terraformRule('http.host eq "tv.ren.ss"', "https://tv.renaissancechurch.com"),
    ] });
    await env.act("save-connection", { token: TOKEN });
    await env.automatic();

    const listed = (await env.act("find-redirects")).found!.redirects;
    expect(listed.map((entry) => `${entry.source} ${entry.target} ${entry.keepPath}`)).toEqual([
      "app.ren.ss https://api.ren.ss/ false", "tv.ren.ss https://tv.renaissancechurch.com true",
    ]);
    await env.confirmed(await env.act("take-over", { redirects: [listed[1]] }));

    const rules = env.redirectRules("ren.ss");
    expect(rules).toHaveLength(2);
    expect(rules[0]).toEqual(workerRule);
    expect(rules[1]!.expression).toBe('http.host eq "tv.ren.ss"');
    const records = env.cf.recordsOf("ren.ss");
    expect(records.filter((record) => record.name === "tv.ren.ss").map((record) => `${record.type} ${record.content}`)).toEqual(["AAAA 100::"]);
    for (const record of others) expect(records.map((current) => JSON.stringify(current))).toContain(record);
  });

  test("a rule that already redirects a host some other way stops the domain rather than getting a second rule beside it", async () => {
    const env = setup();
    const zone = env.cf.zone("windfire.uk", env.account);
    env.cf.rulesets.set(`${zone.id}:http_request_dynamic_redirect`, { id: hexId(), rules: [{
      id: hexId(), ref: "manual", action: "redirect", enabled: true, description: "By hand",
      expression: 'http.request.full_uri wildcard "https://windfire.uk/*"',
      action_parameters: { from_value: { status_code: 301, target_url: { value: "https://windandfireconf.com" } } },
    }] });
    await env.act("save-connection", { token: TOKEN });
    await env.automatic();
    const review = (await env.act("take-over", { redirects: [found("windfire.uk", "https://windandfireconf.com")] })).review!;
    expect(review.blocked).toBe(true);
    expect(review.sites[0]!.problems.join(" ")).toContain('A rule in Cloudflare already redirects windfire.uk in a way DNS cannot take over ("By hand")');
    await env.act("check");
    expect(env.redirectRules("windfire.uk")).toHaveLength(1);
  });

  test("two rules for one domain are reported, and neither is changed", () => {
    const redirect: Redirect = { source: "windnfire.uk", target: "https://windandfireconf.com", status: 301, keepPath: true, keepQuery: true, profileId: null };
    const rules = [terraformRule(apexHosts("windnfire.uk"), redirect.target), terraformRule('http.host eq "www.windnfire.uk"', redirect.target)] as unknown as CfRule[];
    const state = redirectRuleState({ id: hexId(), rules }, redirect, ["windnfire.uk", "www.windnfire.uk"]);
    expect(state).toEqual({ state: "problem", problem: expect.stringContaining("2 redirect rules in Cloudflare already match windnfire.uk or www.windnfire.uk") });
  });

  test("an update Cloudflare refuses for its ref is made with the rule's own ref, and the rule is still found by its hosts", async () => {
    const env = setup();
    env.cf.keepsRefs = true;
    terraformZone(env.cf, env.account, "rtv.bg", "https://tv.renaissancechurch.com");
    const id = env.redirectRules("rtv.bg")[0]!.id;
    await env.act("save-connection", { token: TOKEN });
    await env.automatic();
    await env.confirmed(await env.act("take-over", { redirects: [found("rtv.bg", "https://tv.renaissancechurch.com")] }));
    const rules = env.redirectRules("rtv.bg");
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ id, ref: id, expression: '(http.host eq "rtv.bg" or http.host eq "www.rtv.bg")' });
    const writes = env.cf.writes().length;
    await env.act("check");
    expect(env.cf.writes().length).toBe(writes);
  });

  test("deleting a redirect deletes its rule through a review once Automatic, and only stops managing it before", async () => {
    const env = setup();
    terraformZone(env.cf, env.account, "renaissancechurch.uk", "https://renaissancechurch.com");
    terraformZone(env.cf, env.account, "rnschurch.com", "https://renaissancechurch.com");
    await env.act("save-connection", { token: TOKEN });
    await env.act("take-over", { redirects: [found("rnschurch.com", "https://renaissancechurch.com")] });
    expect((await env.act("delete-redirect", { source: "rnschurch.com" })).notice).toBe("rnschurch.com is no longer managed.");
    expect(env.redirectRules("rnschurch.com")).toHaveLength(1);

    await env.automatic();
    await env.confirmed(await env.act("take-over", { redirects: [found("renaissancechurch.uk", "https://renaissancechurch.com")] }));
    const review = (await env.act("delete-redirect", { source: "renaissancechurch.uk" })).review!;
    expect(review.sites[0]!.changes).toEqual([expect.objectContaining({ action: "delete", subject: "Cloudflare redirect rule" })]);
    expect(env.redirectRules("renaissancechurch.uk")).toHaveLength(1);
    const reply = await env.act("confirm", { token: review.token });
    expect(reply.sites).toEqual([]);
    expect(env.redirectRules("renaissancechurch.uk")).toEqual([]);
    expect(env.cf.recordsOf("renaissancechurch.uk").filter((record) => record.content === "100::")).toHaveLength(2);
    expect(reply.log[0]).toMatchObject({ action: "delete", subject: "Cloudflare redirect rule", cause: "Redirect deleted" });
  });

  test("a redirect domain cannot be a CloudPanel site, and a site deleted into a redirect leaves no records to remove", async () => {
    const env = setup();
    env.sites.push({ id: 1, domain: "hazon.uk", type: "php", createdAt: 0, selfSigned: false, cloudflareOnly: false });
    await expect(env.act("save-redirect", found("hazon.uk", "https://hazon.bg"))).rejects.toThrow("hazon.uk is a CloudPanel site");
  });
});

describe("a site Archive Sites deleted", () => {
  test("becomes a redirect at once with the profile it had, and its records are not offered for removal", async () => {
    const env = setup();
    terraformZone(env.cf, env.account, "awakeningcentre.bg", "https://renaissance.bg");
    env.cf.rulesets.clear();
    env.sites.push({ id: 7, domain: "awakeningcentre.bg", type: "php", createdAt: 0, selfSigned: false, cloudflareOnly: false });
    await env.act("save-connection", { token: TOKEN });
    await env.act("assign", { domains: ["awakeningcentre.bg"], profileId: "web" });
    await env.automatic();
    expect((await env.act("list")).orphans).toEqual([]);

    env.sites.splice(0);
    expect((await env.act("list")).orphans).toEqual([expect.objectContaining({ domain: "awakeningcentre.bg" })]);
    const result = await env.act<{ redirect: string; applied: boolean; reason: string }>("archive-redirect", found("awakeningcentre.bg", "https://renaissance.bg"));
    expect(result).toEqual({ redirect: "awakeningcentre.bg", applied: true, reason: "" });
    const state = await env.act("list");
    expect(state.orphans).toEqual([]);
    expect(state.sites).toEqual([expect.objectContaining({ domain: "awakeningcentre.bg", profileId: "web", plan: expect.objectContaining({ changes: [] }) })]);
    expect(env.redirectRules("awakeningcentre.bg")).toHaveLength(1);
    expect(state.log[0]).toMatchObject({ cause: "Archived site" });
  });
});

describe("reading rules", () => {
  test("whole-host expressions are read with or without Let's Encrypt's path, and nothing else is", () => {
    expect(wholeHostHosts(`${apexHosts("newyou.bg")}${ACME}`)).toEqual(["newyou.bg", "www.newyou.bg"]);
    expect(wholeHostHosts('http.host eq "tv.ren.ss"')).toEqual(["tv.ren.ss"]);
    expect(wholeHostHosts('http.host in {"a.example" "www.a.example"}')).toEqual(["a.example", "www.a.example"]);
    expect(wholeHostHosts('http.host eq "a.example" and http.request.uri.path eq "/x"')).toBeNull();
    expect(wholeHostHosts('http.request.full_uri wildcard "https://a.example/*"')).toBeNull();
  });

  test("a found rule is a redirect domain only when it covers one host, or an apex and its www", () => {
    const rule = (expression: string) => terraformRule(expression, "https://renaissancechurch.com") as unknown as CfRule;
    expect(foundRedirect(rule(apexHosts("rnschurch.com")), "rnschurch.com")).toMatchObject({ source: "rnschurch.com", keepPath: true });
    expect(foundRedirect(rule('(http.host eq "a.rnschurch.com" or http.host eq "b.rnschurch.com")'), "rnschurch.com")).toBeNull();
  });
});

describe("a redirect domain's profile", () => {
  const vars = (domain: string, zone = domain): SiteVars => ({
    domain, zone, ipv4: "46.225.220.253", ipv6: "2a01:4f8:c2c:ec6::1", mailcowHost: "mail.hzn.bg", mailcowSelector: "dkim", mailcowDkim: "v=DKIM1;k=rsa;p=KEY",
  });

  test("keeps every row but the web rows, which the placeholder replaces at the apex and www", () => {
    const profile = seededPolicy().profiles.find((candidate) => candidate.id === "web-mailcow")!;
    const rendered = renderRedirect(profile, ["purezoraya.com", "www.purezoraya.com"], vars("purezoraya.com"), "100::");
    expect(rendered.problems).toEqual([]);
    expect(rendered.records.map((record) => `${record.type} ${record.name} ${record.content}`).sort()).toEqual([
      "AAAA purezoraya.com 100::",
      "AAAA www.purezoraya.com 100::",
      "CNAME autoconfig.purezoraya.com mail.hzn.bg",
      "CNAME autodiscover.purezoraya.com mail.hzn.bg",
      "CNAME webmail.purezoraya.com mail.hzn.bg",
      "MX purezoraya.com mail.hzn.bg",
      "SRV _autodiscover._tcp.purezoraya.com 0 443 mail.hzn.bg",
      "TXT dkim._domainkey.purezoraya.com v=DKIM1;k=rsa;p=KEY",
      "TXT purezoraya.com v=spf1 mx ~all",
    ]);
  });

  test("a web row that could not render, such as a missing address, does not stop a redirect", () => {
    const profile = seededPolicy().profiles.find((candidate) => candidate.id === "web")!;
    const rendered = renderRedirect(profile, ["tv.ren.ss"], { ...vars("tv.ren.ss", "ren.ss"), ipv6: null }, "100::");
    expect(rendered.problems).toEqual([]);
    expect(rendered.records.map((record) => `${record.type} ${record.name}`)).toEqual(["AAAA tv.ren.ss"]);
  });

  test("follows the DKIM key Mailcow holds, like a site", async () => {
    const env = setup();
    terraformZone(env.cf, env.account, "zorayawater.com", "https://zoraya.gold");
    env.mc.domains.add("zorayawater.com");
    env.mc.key("zorayawater.com", "dkim", "MIIBIjANBgkqh");
    await env.act("save-connection", { token: TOKEN });
    await env.act("save-mailcow", { url: "mail.hzn.bg", key: MAILCOW_KEY });
    await env.automatic();
    await env.confirmed(await env.act("take-over", { redirects: [found("zorayawater.com", "https://zoraya.gold")], profileId: "web-mailcow" }));
    const state = await env.act("list");
    const row = state.sites.find((site) => site.domain === "zorayawater.com")!;
    expect(row).toMatchObject({ type: "redirect", profileId: "web-mailcow", redirect: { standIn: false } });
    expect(row.plan!.changes).toEqual([]);
    expect(state.profiles.find((profile) => profile.id === "web-mailcow")!.sites).toBe(1);

    env.mc.key("zorayawater.com", "dkim", "MIIBRotatedKey");
    await env.act("check");
    const dkim = env.cf.recordsOf("zorayawater.com").filter((record) => record.name === "dkim._domainkey.zorayawater.com");
    expect(dkim.map((record) => record.content)).toEqual(['"v=DKIM1;k=rsa;t=s;s=email;p=MIIBRotatedKey"']);
  });
});

describe("stand-in sites on this server", () => {
  test("serve a redirect while there is no Cloudflare connection, and move to Cloudflare through a review", async () => {
    const env = setup();
    await env.automatic();
    const added = await env.act("save-redirect", found("misiodei.com", "https://misiodei.bg"));
    expect(added.review!.sites[0]!.changes).toEqual([expect.objectContaining({ action: "create", subject: "Stand-in site" })]);
    await env.act("confirm", { token: added.review!.token });
    expect(env.standIns.calls).toEqual(["create misiodei.com"]);
    expect(env.sites.map((site) => site.domain)).toEqual(["misiodei.com"]);

    const state = await env.act("list");
    expect(state.sites).toHaveLength(1);
    expect(state.sites[0]).toMatchObject({ domain: "misiodei.com", type: "redirect", redirect: { standIn: true } });
    expect(state.log[0]).toMatchObject({ action: "create", subject: "Stand-in site", cause: "Confirmed review" });

    await env.confirmed(await env.act("save-redirect", found("misiodei.com", "https://misiodei.bg/en")));
    expect(env.standIns.calls.at(-1)).toBe("update misiodei.com https://misiodei.bg/en");

    terraformZone(env.cf, env.account, "misiodei.com", "https://misiodei.bg/en");
    await env.act("save-connection", { token: TOKEN });
    const held = (await env.act("list")).sites[0]!.plan!;
    expect(held.held).toBe(true);
    expect(held.changes.every((change) => change.waits)).toBe(true);
    expect(held.changes).toContainEqual(expect.objectContaining({ action: "delete", subject: "Stand-in site" }));
    await env.act("check");
    expect(env.standIns.calls).not.toContain("remove misiodei.com");

    await env.confirmed(await env.act("assign", { domains: ["misiodei.com"], profileId: null }));
    expect(env.standIns.calls.at(-1)).toBe("remove misiodei.com");
    expect(env.redirectRules("misiodei.com")).toHaveLength(1);
    expect(env.sites).toEqual([]);
  });

  test("removing the last connection moves redirects onto stand-ins only through a review", async () => {
    const env = setup();
    terraformZone(env.cf, env.account, "newyou.bg", "https://bg.maksimasenov.com/nyny");
    const connected = await env.act("save-connection", { token: TOKEN });
    await env.automatic();
    await env.confirmed(await env.act("take-over", { redirects: [found("newyou.bg", "https://bg.maksimasenov.com/nyny")] }));
    await env.act("remove-connection", { id: connected.connections[0]!.id });
    await env.act("check");
    expect(env.standIns.calls).toEqual([]);
    expect((await env.act("list")).sites[0]!.plan!.changes).toEqual([expect.objectContaining({ subject: "Stand-in site", waits: true })]);
    await env.confirmed(await env.act("assign", { domains: ["newyou.bg"], profileId: null }));
    expect(env.standIns.calls).toEqual(["create newyou.bg"]);
  });

  test("a deleted redirect takes its stand-in site with it", async () => {
    const env = setup();
    await env.automatic();
    await env.confirmed(await env.act("save-redirect", found("hazon.uk", "https://hazon.bg")));
    const reply = await env.act("delete-redirect", { source: "hazon.uk" });
    expect(reply.notice).toBe("Deleted hazon.uk and its stand-in site.");
    expect(env.standIns.calls).toEqual(["create hazon.uk", "remove hazon.uk"]);
    expect(reply.sites).toEqual([]);
  });

  test("answer the redirect and Let's Encrypt, for the source and its www", () => {
    const body = (keepPath: boolean, keepQuery: boolean) =>
      standInBody("thepastormax.com", { target: "https://maksimasenov.com", status: 301, keepPath, keepQuery });
    expect(body(true, true)).toContain('return 301 "https://maksimasenov.com$request_uri";');
    expect(body(true, false)).toContain('if ($request_uri ~ "^([^?]*)") {\n      return 301 "https://maksimasenov.com$1";');
    expect(body(true, false)).not.toContain("$uri\"");
    expect(body(false, true)).toContain('return 301 "https://maksimasenov.com$is_args$args";');
    expect(body(false, false)).toContain('return 301 "https://maksimasenov.com";');
    expect(standInBody("old.example", { target: "https://shop.example/?ref=old", status: 301, keepPath: false, keepQuery: true }))
      .toContain('return 301 "https://shop.example/?ref=old&$args";');
    expect(body(true, true)).toContain("server_name thepastormax.com www.thepastormax.com;");
    expect(body(true, true)).toContain("location ^~ /.well-known/acme-challenge/ {");
    expect(standInBody("tv.ren.ss", { target: "https://tv.renaissancechurch.com", status: 302, keepPath: true, keepQuery: true }))
      .toContain("server_name tv.ren.ss;");
  });
});

describe("stand-in sites in CloudPanel", () => {
  function setup(sites: Record<string, { id: number; user: string }>) {
    const dir = mkdtempSync(join(tmpdir(), "dns-stand-ins-"));
    dirs.push(dir);
    const clpctl = join(dir, "clpctl");
    writeFileSync(clpctl, `#!/bin/sh\necho "$@" >> ${join(dir, "calls")}\n`);
    chmodSync(clpctl, 0o755);
    const paths: StandInPaths = {
      file: join(dir, "standins.json"), clpctl, rootUid: process.getuid!(),
      vhost: { panelDb: join(dir, "db.sq3"), sqlite3: "sqlite3", nginxVhostDir: dir, tempDir: dir },
    };
    const record = (siteUser: string, siteId: number) => ({
      target: "https://hazon.bg", status: 301, keepPath: true, keepQuery: true, siteUser, siteId, createdAt: 0,
      certificate: { attempts: 0, nextAt: 0, done: false },
    });
    writeFileSync(paths.file, JSON.stringify({ "hazon.uk": record("hazon", 7), "old.example": record("old", 8) }), { mode: 0o600 });
    const standIns = clpctlStandIns(paths, (domain) => sites[domain], () => 0);
    const calls = () => { try { return readFileSync(join(dir, "calls"), "utf8"); } catch { return ""; } };
    return { paths, standIns, calls };
  }
  const redirect = (source: string): Redirect => ({ source, target: "https://hazon.bg", status: 301, keepPath: true, keepQuery: true, profileId: null });

  test("a site later added at a stand-in's domain is not the stand-in, and is never deleted or overwritten", async () => {
    const { paths, standIns, calls } = setup({ "hazon.uk": { id: 7, user: "hazon" }, "old.example": { id: 12, user: "old" } });
    expect(Object.keys(standIns.current)).toEqual(["hazon.uk"]);
    await expect(standIns.create(redirect("old.example"))).rejects.toThrow("CloudPanel already has a site old.example");
    await expect(standIns.update(redirect("old.example"))).rejects.toThrow("no longer DNS's stand-in site");
    await standIns.remove("old.example");
    expect(calls()).toBe("");
    expect(Object.keys(readStandIns(paths))).toEqual(["hazon.uk"]);
  });
});


import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeDnsAction, type DnsReply } from "../addons/dns/action";
import {
  executeRedirectsAction, type CreateSiteHelper, type PanelSiteInfo, type RedirectsReply,
} from "../addons/redirects/action";
import { REDIRECTS_ADDON } from "../addons/redirects/addon";
import { dashboardContent } from "../addons/redirects/app/views";
import {
  CREATE_SITE_TARGETS, NATIVE_SITE_TYPES, createSiteRedirectSnippet,
} from "../addons/redirects/inject/create-site";
import { migrateRedirectsFromDns, redirectsMigrationPending } from "../addons/redirects/migration";
import { parsePolicy, parseRedirect, type Redirect } from "../addons/redirects/model";
import {
  foundRedirect, isOurRedirectRef, legacyDnsRedirectRef, redirectRef, redirectRuleState, wholeHostHosts,
} from "../addons/redirects/rules";
import { permissionActions } from "../addons/redirects/setup";
import {
  clpctlStandIns, readStandIns, retryStandInCertificates, standInBody, type StandIn, type StandInPaths, type StandIns,
} from "../addons/redirects/stand-in";
import { REDIRECTS_VERBS } from "../addons/redirects/verbs";
import type { CfRule } from "../lib/cloudflare/api";
import { removeCloudflareConnection, saveCloudflareConnection } from "../lib/cloudflare/store";
import { issuedForAll } from "../lib/panel-custom-domain";
import { isStandInSite, ownsStandInSite, standInDomains } from "../lib/stand-ins";
import { FakeCloudflare, hexId } from "./fixtures/dns-api";

const REPO = join(import.meta.dir, "..");
const TOKEN = "cf-redirects-token-0123456789abcdef";
const TOKEN_TWO = "cf-redirects-second-0123456789abcdef";
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ACME = ' and not starts_with(http.request.uri.path, "/.well-known/acme-challenge/")';
const AMAZON = "https://www.amazon.com/Courage-Crisis-Ultimate-Guide-Success/dp/B0BVDW3HLB";

function externalRule(hosts: string, target: string, ref?: string): Record<string, unknown> {
  const id = hexId();
  return {
    id, ref: ref ?? id, action: "redirect", enabled: true, description: "", version: "1",
    expression: `${hosts}${ACME}`,
    action_parameters: {
      from_value: {
        status_code: 301,
        target_url: { expression: `concat("${target}", http.request.uri.path)` },
        preserve_query_string: true,
      },
    },
  };
}

const apexHosts = (domain: string) => `(http.host eq "${domain}" or http.host eq "www.${domain}")`;

function seededZone(cf: FakeCloudflare, account: string, domain: string, target: string, ref?: string): string[] {
  const zone = cf.zone(domain, account);
  for (const name of [domain, `www.${domain}`]) {
    cf.record(domain, { type: "A", name, content: "46.225.220.253", proxied: true });
    cf.record(domain, { type: "AAAA", name, content: "2a01:4f8:c2c:ec6::1", proxied: true });
  }
  const nonWeb = [
    cf.record(domain, { type: "MX", name: domain, content: "mail.hzn.bg", priority: 10 }),
    cf.record(domain, { type: "TXT", name: domain, content: "v=spf1 mx ~all" }),
    cf.record(domain, { type: "TXT", name: domain, content: "google-site-verification=keep-me" }),
    cf.record(domain, { type: "TXT", name: `dkim._domainkey.${domain}`, content: "v=DKIM1;k=rsa;t=s;s=email;p=MIIBIjANBgkqh" }),
    cf.record(domain, { type: "CNAME", name: `autoconfig.${domain}`, content: "mail.hzn.bg" }),
    cf.record(domain, { type: "CNAME", name: `autodiscover.${domain}`, content: "mail.hzn.bg" }),
    cf.record(domain, { type: "CNAME", name: `webmail.${domain}`, content: "mail.hzn.bg", proxied: true }),
    cf.record(domain, { type: "SRV", name: `_autodiscover._tcp.${domain}`, content: "0 443 mail.hzn.bg", priority: 0 }),
    cf.record(domain, { type: "CAA", name: domain, content: '0 issue "letsencrypt.org"' }),
  ];
  cf.rulesets.set(`${zone.id}:http_request_dynamic_redirect`, {
    id: hexId(),
    rules: [externalRule(apexHosts(domain), target, ref)],
  });
  return nonWeb.map((record) => JSON.stringify(record));
}

class FakeStandIns implements StandIns {
  current: Record<string, StandIn> = {};
  calls: string[] = [];
  constructor(private readonly sites: PanelSiteInfo[]) {}

  async create(redirect: Redirect, hosts?: string[]) {
    this.calls.push(`create ${redirect.source}`);
    const siteUser = `${redirect.source.split(".")[0]}-1a2b3c4d`;
    const siteId = 900 + this.sites.length;
    this.sites.push({ id: siteId, domain: redirect.source, user: siteUser, selfSigned: true });
    this.current[redirect.source] = {
      target: redirect.target,
      status: redirect.status,
      keepPath: redirect.keepPath,
      keepQuery: redirect.keepQuery,
      ...(hosts ? { hosts } : {}),
    };
  }

  async update(redirect: Redirect, hosts?: string[]) {
    this.calls.push(`update ${redirect.source} ${redirect.target}`);
    this.current[redirect.source] = {
      target: redirect.target,
      status: redirect.status,
      keepPath: redirect.keepPath,
      keepQuery: redirect.keepQuery,
      ...(hosts ? { hosts } : {}),
    };
  }

  async remove(source: string) {
    this.calls.push(`remove ${source}`);
    delete this.current[source];
    const index = this.sites.findIndex((site) => site.domain === source);
    if (index >= 0) this.sites.splice(index, 1);
  }
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "redirects-addon-"));
  dirs.push(dir);
  writeFileSync(join(dir, "redirects.conf"), "enabled");
  const cf = new FakeCloudflare();
  const account = cf.account("HAZON LTD");
  cf.token(TOKEN, { owner: "user", accounts: [account], zoneEdit: true });
  const sites: PanelSiteInfo[] = [];
  const standIns = new FakeStandIns(sites);
  const paths = {
    configFile: join(dir, "redirects.conf"),
    stateDir: join(dir, "state", "redirects"),
    cloudflareDir: join(dir, "state", "cloudflare"),
    cloudflareLockFile: join(dir, "cloudflare.lock"),
    dnsStateDir: join(dir, "state", "dns"),
    lockFile: join(dir, "redirects.lock"),
    panelDb: join(dir, "db.sq3"),
    rootUid: process.getuid!(),
    clpctl: "/bin/false",
  };
  const env = {
    dir, cf, account, sites, standIns, paths,
    async act<T = RedirectsReply>(verb: string, body?: unknown): Promise<T> {
      return await executeRedirectsAction([verb], {
        paths,
        processUid: 0,
        input: body === undefined ? undefined : JSON.stringify(body),
        fetch: cf.fetch,
        sites: () => sites,
        addresses: () => ({ ipv4: "46.225.220.253", ipv6: "2a01:4f8:c2c:ec6::1" }),
        issue: async () => false,
        standIns: () => standIns,
      }) as T;
    },
    async confirmed(reply: RedirectsReply): Promise<RedirectsReply> {
      if (!reply.review) return reply;
      expect(reply.review.blocked).toBe(false);
      return env.act("confirm", { token: reply.review.token });
    },
    async automatic(): Promise<RedirectsReply> {
      return env.confirmed(await env.act("set-automatic", { automatic: true }));
    },
    redirectRules(domain: string): Record<string, unknown>[] {
      const zone = cf.zones.find((candidate) => candidate.name === domain)!;
      return cf.rulesets.get(`${zone.id}:http_request_dynamic_redirect`)?.rules ?? [];
    },
  };
  return env;
}

const found = (source: string, target: string, keepPath = true) => ({
  source, target, status: 301 as const, keepPath, keepQuery: true,
});

describe("addon boundaries, model validation, and admin enforcement", () => {
  test("addons/redirects has zero imports from addons/dns and keeps all web verbs admin-only", () => {
    const files = [...new Bun.Glob("addons/redirects/**/*.ts").scanSync(REPO)];
    expect(files.length).toBeGreaterThan(5);
    const badImports: string[] = [];
    for (const file of files) {
      const text = readFileSync(join(REPO, file), "utf8");
      if (/from ["'][^"']*\/dns(?:\/|["'])/.test(text)) badImports.push(file);
    }
    expect(badImports).toEqual([]);
    expect(REDIRECTS_ADDON.name).toBe("redirects");
    expect(REDIRECTS_ADDON.changed?.length).toBeGreaterThan(0);

    for (const [verb, spec] of Object.entries(REDIRECTS_VERBS)) {
      if (verb === "reconcile") expect(spec.web).toBe(false);
      else expect(spec.web).toBe("admin");
    }
  });

  test("parseRedirect and parsePolicy validate hosts, status, and mode", () => {
    const parsed = parseRedirect({
      source: "Old.Example.COM", target: "https://example.com/path", status: 308, keepPath: false, keepQuery: false,
      mode: "local", hosts: ["www.old.example.com", "old.example.com"],
    });
    expect(parsed).toEqual({
      source: "old.example.com",
      target: "https://example.com/path",
      status: 308,
      keepPath: false,
      keepQuery: false,
      mode: "local",
      hosts: ["old.example.com", "www.old.example.com"],
    });
    expect(() => parseRedirect({ source: "old.example.com", target: "https://example.com", hosts: ["other.example.net"] }))
      .toThrow("may only include old.example.com and www.old.example.com");
    expect(() => parseRedirect({ source: "old.example.com", target: "ftp://example.com" }))
      .toThrow("http or https URL");
    expect(() => parseRedirect({ source: "old.example.com", target: "https://example.com", status: 303 }))
      .toThrow("301, 302, 307 or 308");
    expect(() => parseRedirect({ source: "old.example.com", target: "https://example.com", mode: "dns" }))
      .toThrow("auto or local");
    expect(parsePolicy({ version: 1, automatic: true, redirects: [parsed], zoneChoices: {}, held: [] }).redirects).toHaveLength(1);
  });
});

describe("Cloudflare Single Redirects and placeholder records", () => {
  test("takes over an external rule in place, writes rule before placeholder, and leaves all non-web DNS records untouched", async () => {
    const env = setup();
    const nonWeb = seededZone(env.cf, env.account, "renaissancecentre.bg", "https://renaissance.bg");
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
    expect(changes.filter((change) => /^(MX|TXT|SRV|CNAME|CAA) /.test(change.subject))).toEqual([]);

    const writesBefore = env.cf.writes().length;
    await env.act("confirm", { token: review.token });
    const newWrites = env.cf.writes().slice(writesBefore);
    const ruleWriteIdx = newWrites.findIndex((call) => call.path.includes("/rulesets/"));
    const recordWriteIdx = newWrites.findIndex((call) => call.path.includes("/dns_records"));
    expect(ruleWriteIdx).toBeGreaterThanOrEqual(0);
    expect(recordWriteIdx).toBeGreaterThan(ruleWriteIdx);

    const rules = env.redirectRules("renaissancecentre.bg");
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      id: rule.id, ref: redirectRef("renaissancecentre.bg"), enabled: true,
      expression: '(http.host eq "renaissancecentre.bg" or http.host eq "www.renaissancecentre.bg")',
      action_parameters: {
        from_value: {
          status_code: 301,
          target_url: { expression: 'concat("https://renaissance.bg", http.request.uri.path)' },
          preserve_query_string: true,
        },
      },
    });

    const records = env.cf.recordsOf("renaissancecentre.bg");
    const web = records.filter((record) => ["renaissancecentre.bg", "www.renaissancecentre.bg"].includes(String(record.name)) && ["A", "AAAA", "CNAME"].includes(String(record.type)));
    expect(web.map((record) => `${record.type} ${record.name} ${record.content} ${record.proxied}`).sort()).toEqual([
      "AAAA renaissancecentre.bg 100:: true",
      "AAAA www.renaissancecentre.bg 100:: true",
    ]);
    for (const record of nonWeb) expect(records.map((current) => JSON.stringify(current))).toContain(record);

    const writesAfter = env.cf.writes().length;
    await env.act("check");
    expect(env.cf.writes().length).toBe(writesAfter);
  });

  test("recognizes legacy clp_dns_redirect_ refs without churn or conflict", async () => {
    const env = setup();
    const zone = env.cf.zone("legacy-ref.example", env.account);
    env.cf.record("legacy-ref.example", { type: "AAAA", name: "legacy-ref.example", content: "100::", proxied: true });
    env.cf.record("legacy-ref.example", { type: "AAAA", name: "www.legacy-ref.example", content: "100::", proxied: true });
    const legacyRef = legacyDnsRedirectRef("legacy-ref.example");
    expect(isOurRedirectRef(legacyRef, "legacy-ref.example")).toBe(true);
    expect(isOurRedirectRef(redirectRef("legacy-ref.example"), "legacy-ref.example")).toBe(true);
    env.cf.rulesets.set(`${zone.id}:http_request_dynamic_redirect`, {
      id: hexId(),
      rules: [{
        id: hexId(), ref: legacyRef, action: "redirect", enabled: true, description: "Managed by CloudPanel DNS",
        expression: '(http.host eq "legacy-ref.example" or http.host eq "www.legacy-ref.example")',
        action_parameters: {
          from_value: {
            status_code: 301,
            target_url: { expression: 'concat("https://example.com", http.request.uri.path)' },
            preserve_query_string: true,
          },
        },
      }],
    });
    await env.act("save-connection", { token: TOKEN });
    await env.automatic();

    const saved = await env.act("save-redirect", found("legacy-ref.example", "https://example.com"));
    expect(saved.review!.sites[0]!.changes).toEqual([]);
    expect(saved.review!.sites[0]!.problems).toEqual([]);
    const applied = await env.confirmed(saved);
    expect(applied.redirects[0]!.plan!.changes).toEqual([]);
    expect(applied.redirects[0]!.plan!.problems).toEqual([]);
    expect(env.cf.writes()).toEqual([]);
  });

  test("supports keepPath toggle, subdomain isolation, ref fallback, NS delegation block, and conflict detection", async () => {
    const env = setup();
    seededZone(env.cf, env.account, "courage.bg", AMAZON);
    const renZone = env.cf.zone("ren.ss", env.account);
    const others = [
      env.cf.record("ren.ss", { type: "AAAA", name: "ren.ss", content: "100::", proxied: true }),
      env.cf.record("ren.ss", { type: "A", name: "www.tv.ren.ss", content: "192.0.2.4" }),
      env.cf.record("ren.ss", { type: "NS", name: "sub.ren.ss", content: "ns1.elsewhere.example" }),
    ].map((record) => JSON.stringify(record));
    env.cf.record("ren.ss", { type: "A", name: "tv.ren.ss", content: "46.225.220.253", proxied: true });
    const workerRule = {
      id: hexId(), ref: "worker", action: "redirect", enabled: true, description: "Old app",
      expression: 'http.host eq "app.ren.ss"',
      action_parameters: { from_value: { status_code: 302, target_url: { value: "https://api.ren.ss/" } } },
    };
    env.cf.rulesets.set(`${renZone.id}:http_request_dynamic_redirect`, {
      id: hexId(),
      rules: [workerRule, externalRule('http.host eq "tv.ren.ss"', "https://tv.renaissancechurch.com")],
    });
    const conflictZone = env.cf.zone("windfire.uk", env.account);
    env.cf.rulesets.set(`${conflictZone.id}:http_request_dynamic_redirect`, {
      id: hexId(),
      rules: [{
        id: hexId(), ref: "manual", action: "redirect", enabled: true, description: "By hand",
        expression: 'http.request.full_uri wildcard "https://windfire.uk/*"',
        action_parameters: { from_value: { status_code: 301, target_url: { value: "https://windandfireconf.com" } } },
      }],
    });

    await env.act("save-connection", { token: TOKEN });
    await env.automatic();

    const listed = (await env.act("find-redirects")).found!;
    expect(listed.redirects.map((entry) => entry.source)).toEqual(["app.ren.ss", "courage.bg", "tv.ren.ss"]);
    await env.confirmed(await env.act("take-over", {
      redirects: listed.redirects.filter((entry) => entry.source !== "app.ren.ss"),
    }));

    // Toggle keepPath off on courage.bg.
    const edited = await env.act("save-redirect", found("courage.bg", AMAZON, false));
    await env.confirmed(edited);
    expect(env.redirectRules("courage.bg")[0]!.action_parameters).toEqual({
      from_value: { status_code: 301, target_url: { value: AMAZON }, preserve_query_string: true },
    });

    // Sibling records and rules in ren.ss stayed untouched.
    expect(env.redirectRules("ren.ss")).toHaveLength(2);
    expect(env.redirectRules("ren.ss")[0]).toEqual(workerRule);
    for (const record of others) expect(env.cf.recordsOf("ren.ss").map((r) => JSON.stringify(r))).toContain(record);

    // Below-apex NS delegation blocks placeholder creation.
    const delegated = await env.act("save-redirect", found("sub.ren.ss", "https://example.com"));
    expect(delegated.review!.blocked).toBe(true);
    expect(delegated.review!.sites[0]!.problems.join(" ")).toContain("delegated to other nameservers");

    // Non-takeoverable wildcard rule blocks cleanly.
    const blocked = await env.act("take-over", { redirects: [found("windfire.uk", "https://windandfireconf.com")] });
    expect(blocked.review!.blocked).toBe(true);
    expect(blocked.review!.sites[0]!.problems.join(" ")).toContain("already redirects windfire.uk");

    // Cloudflare ref preservation fallback.
    env.cf.keepsRefs = true;
    seededZone(env.cf, env.account, "rtv.bg", "https://tv.renaissancechurch.com");
    const origId = env.redirectRules("rtv.bg")[0]!.id;
    await env.confirmed(await env.act("take-over", { redirects: [found("rtv.bg", "https://tv.renaissancechurch.com")] }));
    expect(env.redirectRules("rtv.bg")[0]).toMatchObject({ id: origId, ref: origId });
    const writes = env.cf.writes().length;
    await env.act("check");
    expect(env.cf.writes().length).toBe(writes);
  });

  test("wholeHostHosts, foundRedirect, and two-rule conflict detection", () => {
    expect(wholeHostHosts(`${apexHosts("newyou.bg")}${ACME}`)).toEqual(["newyou.bg", "www.newyou.bg"]);
    expect(wholeHostHosts('http.host eq "tv.ren.ss"')).toEqual(["tv.ren.ss"]);
    expect(wholeHostHosts('http.host in {"a.example" "www.a.example"}')).toEqual(["a.example", "www.a.example"]);
    expect(wholeHostHosts('http.host eq "a.example" and http.request.uri.path eq "/x"')).toBeNull();
    expect(wholeHostHosts('http.request.full_uri wildcard "https://a.example/*"')).toBeNull();

    const makeRule = (expression: string) => externalRule(expression, "https://renaissancechurch.com") as unknown as CfRule;
    expect(foundRedirect(makeRule(apexHosts("rnschurch.com")), "rnschurch.com")).toMatchObject({ source: "rnschurch.com", keepPath: true });
    expect(foundRedirect(makeRule('(http.host eq "a.rnschurch.com" or http.host eq "b.rnschurch.com")'), "rnschurch.com")).toBeNull();

    const redirect: Redirect = { source: "windnfire.uk", target: "https://windandfireconf.com", status: 301, keepPath: true, keepQuery: true, mode: "auto" };
    const rules = [
      externalRule(apexHosts("windnfire.uk"), redirect.target),
      externalRule('http.host eq "www.windnfire.uk"', redirect.target),
    ] as unknown as CfRule[];
    expect(redirectRuleState({ id: hexId(), rules }, redirect, ["windnfire.uk", "www.windnfire.uk"]))
      .toEqual({ state: "problem", problem: expect.stringContaining("2 redirect rules in Cloudflare already match") });
  });
});

describe("local stand-in sites, provider transitions, and leftover rule cleanup", () => {
  test("serves locally without Cloudflare or when mode is local, and transitions through review holds", async () => {
    const env = setup();
    await env.automatic();
    const added = await env.act("save-redirect", found("misiodei.com", "https://misiodei.bg"));
    expect(added.review!.sites[0]!.changes).toEqual([expect.objectContaining({ action: "create", subject: "Stand-in site" })]);
    await env.confirmed(added);
    expect(env.standIns.calls).toEqual(["create misiodei.com"]);
    expect(env.sites.map((site) => site.domain)).toEqual(["misiodei.com"]);

    await env.confirmed(await env.act("save-redirect", found("misiodei.com", "https://misiodei.bg/en")));
    expect(env.standIns.calls.at(-1)).toBe("update misiodei.com https://misiodei.bg/en");

    // Adding Cloudflare through the shared store holds the stand-in redirect instead of moving silently.
    const cfPaths = { stateDir: env.paths.cloudflareDir, lockFile: env.paths.cloudflareLockFile, rootUid: process.getuid!() };
    seededZone(env.cf, env.account, "misiodei.com", "https://misiodei.bg/en");
    const savedConn = await saveCloudflareConnection({ token: TOKEN }, { paths: cfPaths, fetch: env.cf.fetch });
    await env.act("check");
    expect(env.standIns.calls).not.toContain("remove misiodei.com");
    expect((await env.act("list")).redirects[0]!.plan!.held).toBe(true);

    // Explicit review moves it to Cloudflare and retires the stand-in.
    await env.confirmed(await env.act("review-redirect", { source: "misiodei.com" }));
    expect(env.standIns.calls.at(-1)).toBe("remove misiodei.com");
    expect(env.redirectRules("misiodei.com")).toHaveLength(1);
    expect(env.sites).toEqual([]);

    // Forced local mode stays on a stand-in even while Cloudflare has the zone.
    await env.confirmed(await env.act("save-redirect", {
      source: "local-only.example", target: "https://example.com", status: 301, keepPath: true, keepQuery: true, mode: "local",
    }));
    expect(env.standIns.current["local-only.example"]).toBeDefined();

    // Removing the last Cloudflare connection holds Cloudflare redirects for review instead of creating stand-ins silently.
    await removeCloudflareConnection(savedConn.id, { paths: cfPaths });
    const callsBefore = env.standIns.calls.length;
    await env.act("check");
    expect(env.standIns.calls.length).toBe(callsBefore);
    expect((await env.act("list")).redirects.find((r) => r.source === "misiodei.com")!.plan!.held).toBe(true);
    await env.confirmed(await env.act("review-redirect", { source: "misiodei.com" }));
    expect(env.standIns.calls.at(-1)).toBe("create misiodei.com");
  });

  test("newly appearing Cloudflare zone holds existing stand-in redirect and partial connection removal holds affected redirects", async () => {
    const env = setup();
    const account2 = env.cf.account("Second Account");
    env.cf.token(TOKEN_TWO, { owner: "user", accounts: [account2], zoneEdit: true });
    env.cf.zone("other.example", account2);
    const conn1 = (await env.act("save-connection", { token: TOKEN, label: "Primary" })).connections[0]!;
    await env.act("save-connection", { token: TOKEN_TWO, label: "Secondary" });
    await env.automatic();

    // Create a redirect whose zone does not exist in Cloudflare yet -> starts as local stand-in.
    await env.confirmed(await env.act("save-redirect", found("later.example", "https://example.com")));
    expect(env.standIns.current["later.example"]).toBeDefined();

    // Later the zone appears in Cloudflare -> check holds the transition for review.
    env.cf.zone("later.example", env.account);
    await env.act("check");
    expect(env.standIns.current["later.example"]).toBeDefined();
    expect((await env.act("list")).redirects[0]!.plan!.held).toBe(true);

    // Confirm move to Cloudflare, then remove conn1 while conn2 remains -> redirect is held rather than moved to stand-in.
    await env.confirmed(await env.act("review-redirect", { source: "later.example" }));
    expect(env.standIns.current["later.example"]).toBeUndefined();
    await env.act("remove-connection", { id: conn1.id });
    await env.act("check");
    expect(env.standIns.current["later.example"]).toBeUndefined();
    expect((await env.act("list")).redirects[0]!.plan!.held).toBe(true);
  });

  test("fails closed when Cloudflare cannot be read and cleans up leftover Cloudflare rules when deleting local or held redirects", async () => {
    const env = setup();
    await env.automatic();
    await env.confirmed(await env.act("save-redirect", found("hazon.uk", "https://hazon.bg")));
    const nonWeb = seededZone(env.cf, env.account, "hazon.uk", "https://hazon.bg");
    await env.act("save-connection", { token: TOKEN });

    // Unreachable Cloudflare blocks deleting the held stand-in so the Cloudflare rule cannot be orphaned.
    env.cf.tokens.get(TOKEN)!.status = "disabled";
    const blocked = await env.act("delete-redirect", { source: "hazon.uk" });
    expect(blocked.review).toMatchObject({ blocked: true, token: "" });
    expect(blocked.review!.sites[0]!.problems.join(" ")).toContain("Cloudflare could not be read");
    expect(env.standIns.current["hazon.uk"]).toBeDefined();

    // Re-enable Cloudflare, add a conflicting second rule -> also blocks deletion cleanly.
    env.cf.tokens.get(TOKEN)!.status = "active";
    env.redirectRules("hazon.uk").push(externalRule(apexHosts("hazon.uk"), "https://other.example"));
    const conflicted = await env.act("delete-redirect", { source: "hazon.uk" });
    expect(conflicted.review).toMatchObject({ blocked: true, token: "" });
    expect(conflicted.review!.sites[0]!.problems.join(" ")).toContain("2 redirect rules");

    // Resolve conflict -> delete reviews and removes BOTH the Cloudflare rule and the stand-in while keeping non-web DNS intact.
    env.redirectRules("hazon.uk").pop();
    const review = await env.act("delete-redirect", { source: "hazon.uk" });
    expect(review.review!.blocked).toBe(false);
    expect(review.review!.sites[0]!.changes).toContainEqual(expect.objectContaining({ action: "delete", subject: "Cloudflare redirect rule" }));
    const deleted = await env.act("confirm", { token: review.review!.token });
    expect(deleted.redirects).toEqual([]);
    expect(env.redirectRules("hazon.uk")).toEqual([]);
    expect(env.standIns.current["hazon.uk"]).toBeUndefined();
    for (const record of nonWeb) expect(env.cf.recordsOf("hazon.uk").map((r) => JSON.stringify(r))).toContain(record);
  });

  test("standInBody renders all redirect combinations and custom hosts", () => {
    const body = (keepPath: boolean, keepQuery: boolean) =>
      standInBody("thepastormax.com", { target: "https://maksimasenov.com", status: 301, keepPath, keepQuery });
    expect(body(true, true)).toContain('return 301 "https://maksimasenov.com$request_uri";');
    expect(body(true, false)).toContain('if ($request_uri ~ "^([^?]*)") {\n      return 301 "https://maksimasenov.com$1";');
    expect(body(false, true)).toContain('return 301 "https://maksimasenov.com$is_args$args";');
    expect(body(false, false)).toContain('return 301 "https://maksimasenov.com";');
    expect(standInBody("old.example", { target: "https://shop.example/?ref=old", status: 301, keepPath: false, keepQuery: true }))
      .toContain('return 301 "https://shop.example/?ref=old&$args";');
    expect(body(true, true)).toContain("server_name thepastormax.com www.thepastormax.com;");
    expect(standInBody("shop.example.com", {
      target: "https://dest.example", status: 301, keepPath: true, keepQuery: true, hosts: ["shop.example.com", "www.shop.example.com"],
    })).toContain("server_name shop.example.com www.shop.example.com;");
  });
});

describe("stand-in sites in CloudPanel, safe ownership, and certificate coverage", () => {
  function setupStandIns(sites: Record<string, { id: number; user: string }>, clpctlExit = 0) {
    const dir = mkdtempSync(join(tmpdir(), "redirects-stand-ins-"));
    dirs.push(dir);
    const clpctl = join(dir, "clpctl");
    writeFileSync(clpctl, `#!/bin/sh\necho "$1" >> ${join(dir, "calls")}\nexit ${clpctlExit}\n`);
    chmodSync(clpctl, 0o755);
    const paths: StandInPaths = {
      file: join(dir, "standins.json"), clpctl, rootUid: process.getuid!(),
      vhost: { panelDb: join(dir, "db.sq3"), sqlite3: "sqlite3", nginxVhostDir: dir, tempDir: dir },
    };
    const db = new Database(paths.vhost.panelDb);
    db.run("CREATE TABLE site (user TEXT, domain_name TEXT, vhost_template TEXT)");
    db.close();
    const record = (siteUser: string, siteId: number) => ({
      target: "https://hazon.bg", status: 301, keepPath: true, keepQuery: true, siteUser, siteId, createdAt: 0,
      certificate: { attempts: 0, nextAt: 0, done: false },
    });
    writeFileSync(paths.file, JSON.stringify({ "hazon.uk": record("hazon", 7), "old.example": record("old", 8) }), { mode: 0o600 });
    const standIns = clpctlStandIns(paths, (domain) => sites[domain], () => 0);
    const calls = () => { try { return readFileSync(join(dir, "calls"), "utf8"); } catch { return ""; } };
    return { paths, standIns, calls };
  }
  const makeRedirect = (source: string): Redirect => ({ source, target: "https://hazon.bg", status: 301, keepPath: true, keepQuery: true, mode: "auto" });

  test("never deletes or overwrites a real site added later at a stand-in domain, and enforces ownsStandInSite", async () => {
    const { paths, standIns, calls } = setupStandIns({ "hazon.uk": { id: 7, user: "hazon" }, "old.example": { id: 12, user: "old" } });
    expect(Object.keys(standIns.current)).toEqual(["hazon.uk"]);
    await expect(standIns.create(makeRedirect("old.example"))).rejects.toThrow("CloudPanel already has a site old.example");
    await expect(standIns.update(makeRedirect("old.example"))).rejects.toThrow("no longer Redirects' stand-in site");
    await standIns.remove("old.example");
    expect(calls()).toBe("");
    expect(Object.keys(readStandIns(paths))).toEqual(["hazon.uk"]);

    const mark = { siteUser: "hazon", createdAt: 1_000_000 };
    const site = { id: 7, user: "hazon" };
    expect(isStandInSite(mark, site, 1_000_000 + 60_000)).toBe(true);
    expect(isStandInSite(mark, site, 1_000_000 + 60 * 60_000)).toBe(false);
    expect(ownsStandInSite(mark, site)).toBe(false);
    expect(ownsStandInSite({ ...mark, siteId: 7 }, site)).toBe(true);
    expect(ownsStandInSite({ ...mark, siteId: 7 }, { id: 8, user: "hazon" })).toBe(false);
  });

  test("retains incomplete ownership on failed cleanup and adopts siteId after interrupted creation", async () => {
    const { paths, calls } = setupStandIns({});
    const created = join(paths.vhost.tempDir, "created-user");
    const refuseDelete = join(paths.vhost.tempDir, "refuse-delete");
    writeFileSync(refuseDelete, "");
    writeFileSync(paths.clpctl, `#!/bin/sh
echo "$1" >> ${join(paths.vhost.tempDir, "calls")}
case "$1" in
  site:add:static)
    for arg in "$@"; do
      case "$arg" in --siteUser=*) printf '%s' "\${arg#--siteUser=}" > ${created} ;; esac
    done ;;
  site:delete)
    if [ -e ${refuseDelete} ]; then echo 'fixture deletion failure' >&2; exit 1; fi
    rm -f ${created} ;;
esac
`);
    const panelSite = (domain: string) => domain === "new.example" && existsSync(created)
      ? { id: 9, user: readFileSync(created, "utf8") } : undefined;
    const standIns = clpctlStandIns(paths, panelSite, () => 0);
    await expect(standIns.create(makeRedirect("new.example"))).rejects.toThrow(/CloudPanel has no vhost stored for new.example;.*fixture deletion failure/);
    expect(calls()).toBe("site:add:static\nsite:delete\n");
    expect(readStandIns(paths)["new.example"]?.incomplete).toBe(true);
    rmSync(refuseDelete);
    await clpctlStandIns(paths, panelSite, () => 0).remove("new.example");
    expect(readStandIns(paths)["new.example"]).toBeUndefined();
  });

  test("retryStandInCertificates verifies coverage across every effective host before marking done", async () => {
    const { paths } = setupStandIns({ "shop.example.com": { id: 21, user: "shop" } });
    const dir = mkdtempSync(join(tmpdir(), "redirects-cert-"));
    dirs.push(dir);
    const runSsl = (args: string[]) => {
      const result = Bun.spawnSync(["openssl", ...args], { cwd: dir });
      if (!result.success) throw new Error(result.stderr.toString());
    };
    runSsl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.crt", "-days", "30", "-subj", "/CN=Test CA"]);
    const makeCert = (name: string, sans: string[]) => {
      runSsl(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", `/CN=${sans[0]}`]);
      writeFileSync(join(dir, `${name}.ext`), `subjectAltName=${sans.map((h) => `DNS:${h}`).join(",")}\n`);
      runSsl(["x509", "-req", "-in", `${name}.csr`, "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", `${name}.crt`, "-days", "30", "-extfile", `${name}.ext`]);
      return readFileSync(join(dir, `${name}.crt`), "utf8");
    };
    const primaryOnlyPem = makeCert("primary", ["shop.example.com"]);
    const bothHostsPem = makeCert("both", ["shop.example.com", "www.shop.example.com"]);

    writeFileSync(paths.file, JSON.stringify({
      "shop.example.com": {
        target: "https://dest.example", status: 301, keepPath: true, keepQuery: true,
        hosts: ["shop.example.com", "www.shop.example.com"], siteUser: "shop", siteId: 21, createdAt: 0,
        certificate: { attempts: 0, nextAt: 0, done: false },
      },
    }), { mode: 0o600 });

    let currentPem = primaryOnlyPem;
    const issued: { domain: string; aliases: string[] }[] = [];
    await retryStandInCertificates(
      paths,
      (domain, hosts) => domain === "shop.example.com" ? issuedForAll(currentPem, hosts) : null,
      async (domain, aliases) => { issued.push({ domain, aliases }); return true; },
      1_000,
    );
    expect(issued).toEqual([{ domain: "shop.example.com", aliases: ["www.shop.example.com"] }]);
    expect(readStandIns(paths)["shop.example.com"]!.certificate.done).toBe(false);

    const nextAt = readStandIns(paths)["shop.example.com"]!.certificate.nextAt;
    await retryStandInCertificates(
      paths,
      (domain, hosts) => domain === "shop.example.com" ? issuedForAll(currentPem, hosts) : null,
      async (domain, aliases) => { issued.push({ domain, aliases }); currentPem = bothHostsPem; return true; },
      nextAt,
    );
    expect(readStandIns(paths)["shop.example.com"]!.certificate.done).toBe(true);
  });
});

describe("Create Site replacement flow and silent-deletion protection", () => {
  test("never silently deletes a redirect when a real CloudPanel site is created at its domain", async () => {
    const env = setup();
    seededZone(env.cf, env.account, "clash.example", "https://example.com");
    await env.act("save-connection", { token: TOKEN });
    await env.automatic();
    await env.confirmed(await env.act("take-over", { redirects: [found("clash.example", "https://example.com")] }));

    // A CloudPanel site is created directly without replacing the redirect.
    env.sites.push({ id: 42, domain: "clash.example", user: "clash", selfSigned: false });
    const checked = await env.act("check");
    expect(env.redirectRules("clash.example")).toHaveLength(1);
    expect(checked.redirects[0]!.plan!.problems.join(" ")).toContain("CloudPanel has a site clash.example");
    await expect(env.act("save-redirect", found("clash.example", "https://other.example"))).rejects.toThrow("clash.example is a CloudPanel site");
  });

  test("create-site-helper reads local state without calling Cloudflare, and prepare-replace + confirm removes CF rule and/or stand-in while keeping non-web DNS", async () => {
    const env = setup();
    const nonWeb = seededZone(env.cf, env.account, "replace-cf.example", "https://example.com");
    await env.act("save-connection", { token: TOKEN });
    await env.automatic();
    await env.confirmed(await env.act("take-over", { redirects: [found("replace-cf.example", "https://example.com")] }));
    await env.confirmed(await env.act("save-redirect", {
      source: "replace-local.example", target: "https://example.com", status: 301, keepPath: true, keepQuery: true, mode: "local",
    }));

    // create-site-helper makes zero Cloudflare calls.
    const cfCallsBefore = env.cf.calls.length;
    const helper = await env.act<CreateSiteHelper>("create-site-helper");
    expect(env.cf.calls.length).toBe(cfCallsBefore);
    expect(helper.redirects.map((r) => `${r.source}:${r.servedBy}:${r.standIn}`)).toEqual([
      "replace-cf.example:cloudflare:false",
      "replace-local.example:stand-in:true",
    ]);
    expect(helper.redirects[0]!.hosts).toEqual(["replace-cf.example", "www.replace-cf.example"]);

    // Replace the Cloudflare-backed redirect via prepare-replace -> confirm.
    const cfPlan = await env.act("prepare-replace", { source: "replace-cf.example" });
    expect(cfPlan.review).toMatchObject({ blocked: false, confirmLabel: "Replace redirect", danger: true });
    expect(cfPlan.review!.sites[0]!.changes).toContainEqual(expect.objectContaining({
      action: "delete", subject: "Cloudflare redirect rule",
    }));
    expect(env.redirectRules("replace-cf.example")).toHaveLength(1);
    await env.act("confirm", { token: cfPlan.review!.token });
    expect(env.redirectRules("replace-cf.example")).toEqual([]);
    for (const record of nonWeb) expect(env.cf.recordsOf("replace-cf.example").map((r) => JSON.stringify(r))).toContain(record);

    // Replace the local stand-in redirect via prepare-replace -> confirm (even in Ask-first mode).
    await env.act("set-automatic", { automatic: false });
    const localPlan = await env.act("prepare-replace", { source: "replace-local.example" });
    expect(localPlan.review!.blocked).toBe(false);
    expect(localPlan.review!.sites[0]!.changes).toContainEqual(expect.objectContaining({
      action: "delete", subject: "Stand-in site",
    }));
    expect(env.standIns.current["replace-local.example"]).toBeDefined();
    await env.act("confirm", { token: localPlan.review!.token });
    expect(env.standIns.current["replace-local.example"]).toBeUndefined();
    expect((await env.act("list")).redirects).toEqual([]);
  });

  test("prepare-replace removes BOTH leftover Cloudflare rule and local stand-in and catches drift before confirm", async () => {
    const env = setup();
    await env.automatic();
    await env.confirmed(await env.act("save-redirect", found("dual.example", "https://example.com")));
    const nonWeb = seededZone(env.cf, env.account, "dual.example", "https://example.com");
    await env.act("save-connection", { token: TOKEN });

    const prepared = await env.act("prepare-replace", { source: "dual.example" });
    expect(prepared.review!.blocked).toBe(false);
    expect(prepared.review!.sites[0]!.changes.map((c) => c.subject).sort()).toEqual([
      "Cloudflare redirect rule", "Stand-in site",
    ]);

    // Mutate the Cloudflare rule before confirming -> confirm catches digest drift and returns a fresh review.
    env.redirectRules("dual.example")[0]!.action_parameters = {
      from_value: { status_code: 302, target_url: { value: "https://changed.example" }, preserve_query_string: false },
    };
    const drifted = await env.act("confirm", { token: prepared.review!.token });
    expect(drifted.review).toBeDefined();
    expect(env.redirectRules("dual.example")).toHaveLength(1);
    expect(env.standIns.current["dual.example"]).toBeDefined();

    // Confirming the fresh review deletes both and preserves non-web DNS records.
    await env.act("confirm", { token: drifted.review!.token });
    expect(env.redirectRules("dual.example")).toEqual([]);
    expect(env.standIns.current["dual.example"]).toBeUndefined();
    for (const record of nonWeb) expect(env.cf.recordsOf("dual.example").map((r) => JSON.stringify(r))).toContain(record);
  });

  test("Create Site injection targets all six native templates, gates on ROLE_ADMIN, adds no named fields, and never intercepts submit", () => {
    expect(CREATE_SITE_TARGETS.map((t) => t.template)).toEqual(
      NATIVE_SITE_TYPES.map((type) => `Frontend/Site/New/${type}.html.twig`),
    );
    for (const target of CREATE_SITE_TARGETS) {
      expect(target.required).toBe(false);
      expect(target.anchorBefore).toBeTruthy();
    }
    const html = createSiteRedirectSnippet("/addons/redirects");
    expect(html).toContain("{% if is_granted('ROLE_ADMIN') %}");
    expect(html).toContain("{% endif %}");
    expect(html).not.toMatch(/\bname=/i);
    const script = readFileSync(join(REPO, "addons/redirects/inject/create-site.client.js"), "utf8");
    expect(script).not.toContain("addEventListener('submit'");
    expect(script).not.toContain('addEventListener("submit"');
    expect(script).not.toMatch(/\.setAttribute\(['"]name['"]/);
  });
});

describe("migration from addons/dns and DNS stand-in exclusion", () => {
  test("migrates redirects, stand-ins, PowerDNS local mode, holds, and CF zone choices, and rolls back verbatim", () => {
    const dir = mkdtempSync(join(tmpdir(), "redirects-mig-"));
    dirs.push(dir);
    const dnsDir = join(dir, "dns");
    const redirectsDir = join(dir, "redirects");
    const dnsConfig = join(dir, "dns.conf");
    const redirectsConfig = join(dir, "redirects.conf");
    mkdirSync(dnsDir, { recursive: true });
    writeFileSync(dnsConfig, "enabled\n");

    const dnsPolicyText = `${JSON.stringify({
      version: 1,
      automatic: true,
      connections: [],
      powerdns: [{ id: "pdns-1", label: "NS1", url: "http://127.0.0.1:8081", serverId: "localhost", defaultTtl: 300, createZones: false, nameservers: [] }],
      profiles: [{ id: "web", name: "Web", mailcow: false, zone: {}, records: [] }],
      defaultProfileId: "web",
      assignments: { "site.example.com": "web" },
      redirects: [
        { source: "cf-old.example", target: "https://example.com", status: 301, keepPath: true, keepQuery: true, profileId: "web" },
        { source: "pdns.sub.example", target: "https://example.com/sub", status: 302, keepPath: false, keepQuery: true, profileId: null },
      ],
      zoneChoices: {
        "cf-old.example": { connectionId: "cf-1", zoneId: "1".repeat(32) },
        "pdns.sub.example": { connectionId: "pdns-1", zoneId: "pdns.sub.example." },
      },
      held: ["site.example.com", "cf-old.example"],
      panelHost: null,
      knownSiteIds: [1],
    }, null, 2)}\n`;
    const dnsStatusText = `${JSON.stringify({
      checkedAt: "2026-11-01T00:00:00Z",
      connections: [],
      connectionIds: ["cf-1", "pdns-1"],
      redirectRules: { "cf-old.example": { connectionId: "cf-1", zoneId: "1".repeat(32), zoneName: "cf-old.example" } },
      plans: {},
    }, null, 2)}\n`;
    const standInsText = `${JSON.stringify({
      "pdns.sub.example": {
        target: "https://example.com/sub", status: 302, keepPath: false, keepQuery: true,
        hosts: ["pdns.sub.example", "www.pdns.sub.example"], siteUser: "pdns-11223344", siteId: 77, createdAt: 1000,
        certificate: { attempts: 0, nextAt: 0, done: true },
      },
    }, null, 2)}\n`;

    writeFileSync(join(dnsDir, "policy.json"), dnsPolicyText, { mode: 0o600 });
    writeFileSync(join(dnsDir, "status.json"), dnsStatusText, { mode: 0o600 });
    writeFileSync(join(dnsDir, "standins.json"), standInsText, { mode: 0o600 });

    const options = { dnsDir, redirectsDir, dnsConfigFile: dnsConfig, redirectsConfigFile: redirectsConfig, rootUid: process.getuid!() };
    let enabledCalls = 0;
    const enableRedirects = () => { enabledCalls++; writeFileSync(redirectsConfig, "enabled\n"); };
    expect(redirectsMigrationPending(dnsDir)).toBe(true);
    const undo = migrateRedirectsFromDns(enableRedirects, options);
    expect(undo).not.toBeNull();
    expect(enabledCalls).toBe(1);
    expect(redirectsMigrationPending(dnsDir)).toBe(false);
    expect(existsSync(redirectsConfig)).toBe(true);

    const migratedPolicy = JSON.parse(readFileSync(join(redirectsDir, "policy.json"), "utf8"));
    expect(migratedPolicy.automatic).toBe(true);
    expect(migratedPolicy.redirects).toEqual([
      { source: "cf-old.example", target: "https://example.com", status: 301, keepPath: true, keepQuery: true },
      { source: "pdns.sub.example", target: "https://example.com/sub", status: 302, keepPath: false, keepQuery: true, mode: "local", hosts: ["pdns.sub.example", "www.pdns.sub.example"] },
    ]);
    expect(parsePolicy(migratedPolicy).redirects[0]!.mode).toBeUndefined();
    expect(parsePolicy(migratedPolicy).redirects[1]!.mode).toBe("local");
    expect(migratedPolicy.zoneChoices).toEqual({ "cf-old.example": { connectionId: "cf-1", zoneId: "1".repeat(32) } });
    expect(migratedPolicy.held).toEqual(["cf-old.example"]);

    const migratedStatus = JSON.parse(readFileSync(join(redirectsDir, "status.json"), "utf8"));
    expect(migratedStatus.connectionIds).toEqual(["cf-1"]);
    expect(migratedStatus.redirectRules).toEqual({ "cf-old.example": { connectionId: "cf-1", zoneId: "1".repeat(32), zoneName: "cf-old.example" } });
    expect(readFileSync(join(redirectsDir, "standins.json"), "utf8")).toBe(standInsText);

    // DNS state cleaned while keeping sites, profiles, and PowerDNS intact.
    const cleanedDnsPolicy = JSON.parse(readFileSync(join(dnsDir, "policy.json"), "utf8"));
    expect(cleanedDnsPolicy.redirects).toBeUndefined();
    expect(cleanedDnsPolicy.assignments).toEqual({ "site.example.com": "web" });
    expect(cleanedDnsPolicy.held).toEqual(["site.example.com"]);
    expect(cleanedDnsPolicy.powerdns).toHaveLength(1);
    expect(existsSync(join(dnsDir, "standins.json"))).toBe(false);

    // Second run is a no-op.
    expect(migrateRedirectsFromDns(enableRedirects, options)).toBeNull();

    // Rollback restores every file verbatim.
    undo!();
    expect(readFileSync(join(dnsDir, "policy.json"), "utf8")).toBe(dnsPolicyText);
    expect(readFileSync(join(dnsDir, "status.json"), "utf8")).toBe(dnsStatusText);
    expect(readFileSync(join(dnsDir, "standins.json"), "utf8")).toBe(standInsText);
    expect(existsSync(redirectsConfig)).toBe(false);
    expect(existsSync(join(redirectsDir, "policy.json"))).toBe(false);
  });

  test("migration keeps Redirects disabled with automatic: false when DNS is disabled, and refuses symlinks", () => {
    const dir = mkdtempSync(join(tmpdir(), "redirects-mig-off-"));
    dirs.push(dir);
    const dnsDir = join(dir, "dns");
    const redirectsDir = join(dir, "redirects");
    mkdirSync(dnsDir, { recursive: true });
    writeFileSync(join(dnsDir, "policy.json"), JSON.stringify({
      version: 1, automatic: true, redirects: [{ source: "old.example", target: "https://example.com", status: 301, keepPath: true, keepQuery: true, profileId: null }],
    }), { mode: 0o600 });

    const redirectsConfigFile = join(dir, "redirects.conf");
    const options = { dnsDir, redirectsDir, dnsConfigFile: join(dir, "dns.conf"), redirectsConfigFile, rootUid: process.getuid!() };
    let enabledCalls = 0;
    const enableRedirects = () => { enabledCalls++; writeFileSync(redirectsConfigFile, "enabled\n"); };
    const undo = migrateRedirectsFromDns(enableRedirects, options);
    expect(undo).not.toBeNull();
    expect(enabledCalls).toBe(0);
    expect(existsSync(redirectsConfigFile)).toBe(false);
    expect(JSON.parse(readFileSync(join(redirectsDir, "policy.json"), "utf8")).automatic).toBe(false);
    undo!();

    // Untrusted symlink at dns/standins.json is refused.
    writeFileSync(join(dir, "elsewhere.json"), "{}");
    symlinkSync(join(dir, "elsewhere.json"), join(dnsDir, "standins.json"));
    expect(() => migrateRedirectsFromDns(enableRedirects, options)).toThrow();
  });

  test("DNS list excludes stand-in sites tracked in Redirects' standins.json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dns-standin-exclude-"));
    dirs.push(dir);
    writeFileSync(join(dir, "dns.conf"), "enabled");
    const standInsFile = join(dir, "redirects", "standins.json");
    mkdirSync(join(dir, "redirects"), { recursive: true });
    writeFileSync(standInsFile, JSON.stringify({
      "old.example": { siteUser: "old-1a2b3c4d", siteId: 99, createdAt: 0 },
    }), { mode: 0o600 });

    const reply = await executeDnsAction(["list"], {
      paths: {
        configFile: join(dir, "dns.conf"),
        stateDir: join(dir, "dns"),
        standInsFile,
        smtpConfig: join(dir, "smtp.json"),
        lockFile: join(dir, "dns.lock"),
        panelDb: join(dir, "db.sq3"),
        rootUid: process.getuid!(),
        clpctl: "/bin/false",
      },
      processUid: 0,
      sites: () => [
        { id: 1, domain: "real.example", type: "php", createdAt: 0, selfSigned: false, cloudflareOnly: false },
        { id: 99, domain: "old.example", type: "static", createdAt: 0, selfSigned: true, cloudflareOnly: false },
      ],
    }) as DnsReply;
    expect(reply.sites.map((site) => site.domain)).toEqual(["real.example"]);
    expect(standInDomains(standInsFile, process.getuid!()).has("old.example")).toBe(true);
  });
});

describe("UI layout and setup actions", () => {
  test("shows first-run card when unconfigured, section-shell when configured, phone cut past 10 rows, and permission actions only when needed", async () => {
    const env = setup();
    const unconfigured = await env.act("list");
    const firstRunHtml = dashboardContent(unconfigured);
    expect(firstRunHtml).toContain("Set up Redirects");
    expect(firstRunHtml).not.toContain("section-shell");

    await env.act("save-redirect", { source: "a.example", target: "https://example.com", status: 301, keepPath: true, keepQuery: true, mode: "local" });
    const configured = await env.act("list");
    const askHtml = dashboardContent(configured);
    expect(askHtml).toContain("section-shell");
    expect(askHtml).toContain("Redirects asks first");
    expect(askHtml).not.toContain("Find in Cloudflare");

    // Phone cut past 10 redirects.
    const many = Array.from({ length: 11 }, (_, i) => ({
      source: `old-${i}.example`, target: "https://example.com/new", status: 301 as const,
      keepPath: true, keepQuery: true, mode: "local" as const, standIn: true, plan: null,
    }));
    const manyHtml = dashboardContent({ ...configured, redirects: many });
    expect(manyHtml).toContain('data-phone-cut="redir-list"');
    expect(manyHtml).toContain("Show all 11 redirects");
    expect(dashboardContent({ ...configured, redirects: many.slice(0, 10) })).not.toContain("data-phone-more");

    // Setup permissionActions: quiet for local-only redirects, flags missing permissions when auto-mode redirects exist with active CF.
    const missingToken = {
      owner: "user" as const, accountId: null, readable: true as const, reach: "All zones", grants: [],
      coverage: { dns: { held: "no" as const }, redirects: { held: "no" as const } },
    };
    const localPolicy = parsePolicy({
      version: 1, automatic: true,
      redirects: [{ source: "a.example", target: "https://example.com", status: 301, keepPath: true, keepQuery: true, mode: "local" }],
    });
    expect(permissionActions({
      policy: localPolicy,
      connections: [{ id: "cf-1", label: "Agency" }],
      tokens: new Set(["cf-1"]),
      reports: [{ id: "cf-1", active: true, zoneNames: ["a.example"], error: null, token: missingToken }],
    })).toEqual([]);

    const autoPolicy = parsePolicy({
      version: 1, automatic: true,
      redirects: [{ source: "a.example", target: "https://example.com", status: 301, keepPath: true, keepQuery: true, mode: "auto" }],
    });
    const actions = permissionActions({
      policy: autoPolicy,
      connections: [{ id: "cf-1", label: "Agency" }],
      tokens: new Set(["cf-1"]),
      reports: [{ id: "cf-1", active: true, zoneNames: ["a.example"], error: null, token: missingToken }],
    });
    expect(actions).toHaveLength(1);
    expect(actions[0]!.reason).toContain("Single Redirect: Edit");
    expect(actions[0]!.reason).toContain("DNS: Edit");
  });
});

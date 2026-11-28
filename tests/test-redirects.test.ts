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
import { upgradeSavedPolicy } from "../addons/dns/model";
import { parsePolicy, parseRedirect, type Redirect } from "../addons/redirects/model";
import {
  foundRedirect, isOurRedirectRef, legacyDnsRedirectRef, patternMatchesHost, redirectRef, redirectRuleState, wholeHostHosts,
} from "../addons/redirects/rules";
import { permissionActions } from "../addons/redirects/setup";
import {
  clpctlStandIns, readStandIns, retryStandInCertificates, standInBody, type StandIn, type StandInPaths, type StandIns,
} from "../addons/redirects/stand-in";
import { REDIRECTS_VERBS } from "../addons/redirects/verbs";
import type { CfRule } from "../lib/cloudflare/api";
import { removeCloudflareConnection, saveCloudflareConnection } from "../lib/cloudflare/store";
import { mountPath } from "../lib/mount";
import { issuedForAll } from "../lib/panel-custom-domain";
import { isStandInSite, ownsStandInSite, standInDomains } from "../lib/stand-ins";
import { FakeCloudflare, hexId, policy } from "./fixtures/dns-api";

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

class FakeNode {
  children: FakeNode[] = [];
  parent: FakeNode | null = null;
  attrs: Record<string, string> = {};
  listeners: Record<string, ((event: unknown) => void)[]> = {};
  className = "";
  id = "";
  type = "";
  hidden = false;
  disabled = false;
  open = false;
  value = "";
  text = "";
  constructor(readonly tag: string) {}
  get textContent(): string { return this.text + this.children.map((child) => child.textContent).join(""); }
  set textContent(value: string) { this.text = String(value); this.children = []; }
  get parentNode(): FakeNode | null { return this.parent; }
  get nextSibling(): FakeNode | null { return this.parent?.children[this.parent.children.indexOf(this) + 1] ?? null; }
  appendChild(node: FakeNode): FakeNode {
    node.remove();
    node.parent = this;
    this.children.push(node);
    return node;
  }
  insertBefore(node: FakeNode, before: FakeNode | null): FakeNode {
    node.remove();
    node.parent = this;
    const at = before ? this.children.indexOf(before) : -1;
    if (at < 0) this.children.push(node); else this.children.splice(at, 0, node);
    return node;
  }
  remove(): void {
    if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = null;
  }
  setAttribute(name: string, value: string): void { this.attrs[name] = String(value); }
  getAttribute(name: string): string | null { return this.attrs[name] ?? null; }
  addEventListener(type: string, listener: (event: unknown) => void): void { (this.listeners[type] ??= []).push(listener); }
  fire(type: string): void { for (const listener of this.listeners[type] ?? []) listener({ target: this, preventDefault() {} }); }
  matches(selector: string): boolean {
    return selector.split(",").map((part) => part.trim()).some((part) => {
      if (part.startsWith(".")) return this.className.split(" ").includes(part.slice(1));
      if (part.startsWith("[")) return part.slice(1, -1) in this.attrs;
      return part.startsWith(this.tag) && this.tag !== "#text";
    });
  }
  descendants(): FakeNode[] { return this.children.flatMap((child) => [child, ...child.descendants()]); }
  querySelector(selector: string): FakeNode | null { return this.descendants().find((node) => node.matches(selector)) ?? null; }
  closest(selector: string): FakeNode | null {
    for (let node: FakeNode | null = this; node; node = node.parent) if (node.matches(selector)) return node;
    return null;
  }
  showModal(): void { this.open = true; }
  close(): void { this.open = false; this.fire("close"); }
  getBoundingClientRect() { return { left: 0, right: 100, top: 0, bottom: 100 }; }
}

function createSitePage(redirects: Partial<CreateSiteHelper["redirects"][number]>[], dataUrl = mountPath("redirects")) {
  const body = new FakeNode("body");
  const form = body.appendChild(new FakeNode("form"));
  const input = form.appendChild(new FakeNode("input"));
  input.id = "site_domainName";
  const box = form.appendChild(new FakeNode("div"));
  box.setAttribute("data-clp-redirects-create-site", "");
  box.setAttribute("data-url", dataUrl);
  box.hidden = true;
  const calls: { url: string; body: unknown; resolve: (data: unknown) => void }[] = [];
  const document = {
    body,
    cookie: "clp_addons_csrf=csrf",
    querySelector: (selector: string) => body.querySelector(selector),
    createElement: (tag: string) => new FakeNode(tag),
    createTextNode: (text: string) => Object.assign(new FakeNode("#text"), { text }),
  };
  const fetch = (url: string, init?: { body?: string }) => {
    if (url.endsWith("/api/session")) return Promise.resolve({ ok: true, json: async () => ({ ok: true, data: {} }) });
    if (url.endsWith("/api/create-site-helper")) {
      return Promise.resolve({ ok: true, json: async () => ({ ok: true, data: { redirects, automatic: true, hasCloudflare: true } }) });
    }
    return new Promise((resolve) => calls.push({
      url, body: init?.body ? JSON.parse(init.body) : undefined,
      resolve: (data) => resolve({ ok: true, status: 200, json: async () => ({ ok: true, data }) }),
    }));
  };
  const script = readFileSync(join(REPO, "addons/redirects/inject/create-site.client.js"), "utf8");
  new Function("document", "fetch", script)(document, fetch);
  const dialogs = () => body.children.filter((node) => node.tag === "dialog");
  return {
    box, input, calls, dialogs,
    settle: () => new Promise((resolve) => setTimeout(resolve, 0)),
    type(value: string) { input.value = value; input.fire("input"); },
  };
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
  const options = () => ({
    paths,
    processUid: 0,
    fetch: cf.fetch,
    sites: () => sites,
    addresses: () => ({ ipv4: "46.225.220.253", ipv6: "2a01:4f8:c2c:ec6::1" }),
    issue: async () => false,
    standIns: () => standIns,
  });
  const env = {
    dir, cf, account, sites, standIns, paths, options,
    async act<T = RedirectsReply>(verb: string, body?: unknown): Promise<T> {
      return await executeRedirectsAction([verb], {
        ...options(),
        input: body === undefined ? undefined : JSON.stringify(body),
      }) as T;
    },
    placeholders(domain: string): string[] {
      return cf.recordsOf(domain).filter((record) => record.type === "AAAA" && record.content === "100::").map((record) => String(record.name));
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
      if (verb === "reconcile" || verb === "sync-sites") expect(spec.web).toBe(false);
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

  test("picks the connection that can write both the rule and its placeholders when two reach the same zone", async () => {
    const env = setup();
    const allZones = { "com.cloudflare.api.account.zone.*": "*" };
    env.cf.token(TOKEN, {
      owner: "user", accounts: [env.account], zoneEdit: true, id: hexId(),
      policies: [policy(["DNS Write", "API Tokens Read"], allZones)],
    });
    env.cf.token(TOKEN_TWO, {
      owner: "user", accounts: [env.account], zoneEdit: true, id: hexId(),
      policies: [policy(["DNS Write", "Single Redirect Write", "API Tokens Read"], allZones)],
    });
    env.cf.zone("both.example", env.account);
    await env.act("save-connection", { token: TOKEN, label: "DNS only" });
    const full = (await env.act("save-connection", { token: TOKEN_TWO, label: "Redirects" })).connections.find((c) => c.label === "Redirects")!;
    await env.automatic();
    const review = await env.act("save-redirect", found("both.example", "https://example.com"));
    expect(review.review!.sites[0]!.zone!.connectionId).toBe(full.id);
  });

  test("blocks a redirect whose hosts include an existing CloudPanel site or another redirect's hosts", async () => {
    const env = setup();
    env.cf.zone("example.com", env.account);
    await env.act("save-connection", { token: TOKEN });
    await env.automatic();

    env.sites.push({ id: 7, domain: "www.example.com", user: "www", selfSigned: false });
    await expect(env.act("save-redirect", found("example.com", "https://example.net"))).rejects.toThrow("www.example.com is a CloudPanel site");
    await expect(env.act("take-over", { redirects: [found("example.com", "https://example.net")] })).rejects.toThrow("www.example.com is a CloudPanel site");
    const local = await env.act("save-redirect", { ...found("local.example", "https://example.net"), mode: "local" });
    expect(local.review!.blocked).toBe(false);
    env.sites.splice(0);

    const overlapping = await env.act("take-over", { redirects: [found("example.com", "https://a.example"), found("www.example.com", "https://b.example")] });
    expect(overlapping.review!.blocked).toBe(true);
    expect(overlapping.review!.sites.map((plan) => plan.problems)).toEqual([
      ["example.com and www.example.com both answer for www.example.com; keep only one of these redirects"],
      ["www.example.com and example.com both answer for www.example.com; keep only one of these redirects"],
    ]);
    expect(env.cf.writes()).toEqual([]);

    const disjoint = await env.act("take-over", { redirects: [found("example.com", "https://a.example"), found("shop.example.com", "https://b.example")] });
    expect(disjoint.review!.blocked).toBe(false);
    await env.act("confirm", { token: disjoint.review!.token });
    expect(env.redirectRules("example.com")).toHaveLength(2);

    const later = await env.act("save-redirect", found("www.example.com", "https://b.example"));
    expect(later.review!.blocked).toBe(true);
    expect(later.review!.sites[0]!.problems).toContain("www.example.com and example.com both answer for www.example.com; keep only one of these redirects");
  });

  test("blocks deletion while another enabled rule's pattern still matches the host", async () => {
    expect(patternMatchesHost('http.request.full_uri wildcard "https://*.example.com/*"', "old.example.com")).toBe(true);
    expect(patternMatchesHost('http.request.full_uri wildcard "https://*.other.com/*"', "old.example.com")).toBe(true);
    expect(patternMatchesHost('http.request.full_uri wildcard "*/https://*.other.com/*"', "old.example.com")).toBe(true);
    expect(patternMatchesHost('http.request.full_uri wildcard "https://old.example.com:8443/*"', "old.example.com")).toBe(true);
    expect(patternMatchesHost('http.request.full_uri wildcard "https://shop.other.com/*"', "old.example.com")).toBe(false);
    expect(patternMatchesHost('http.request.full_uri wildcard "https://old.example.com.other.com/*"', "old.example.com")).toBe(false);
    expect(patternMatchesHost('http.host wildcard "*.example.com"', "example.com")).toBe(false);
    expect(patternMatchesHost('http.host matches "^ol[d]\\.example"', "old.example.com")).toBe(true);
    expect(patternMatchesHost('http.request.full_uri matches "^https://new"', "old.example.com")).toBe(false);
    expect(patternMatchesHost('http.request.full_uri matches r"^https://shop[.]example[.]com/"', "old.example.com")).toBe(false);
    expect(patternMatchesHost('http.request.full_uri matches r"^https?://old\\.example\\.com/"', "old.example.com")).toBe(true);
    expect(patternMatchesHost('http.request.full_uri matches r"^https://old\\.example\\.com\\.other/"', "old.example.com")).toBe(false);
    expect(patternMatchesHost('http.request.full_uri matches r"^https://ol"', "old.example.com")).toBe(true);
    expect(patternMatchesHost('http.request.full_uri matches r"^https://oldx?"', "old.example.com")).toBe(true);
    expect(patternMatchesHost('http.request.full_uri matches r"^https://(www\\.)?old"', "old.example.com")).toBe(true);
    expect(patternMatchesHost('http.request.full_uri matches r"^https://new/|old"', "old.example.com")).toBe(true);
    expect(patternMatchesHost('http.request.full_uri matches r"/old"', "old.example.com")).toBe(true);
    expect(patternMatchesHost('ends_with(http.host, ".example.com")', "old.example.com")).toBe(true);
    expect(patternMatchesHost('http.request.uri.path wildcard "/old/*"', "old.example.com")).toBe(false);

    const env = setup();
    const zone = env.cf.zone("example.com", env.account);
    await env.act("save-connection", { token: TOKEN });
    await env.automatic();
    await env.confirmed(await env.act("save-redirect", found("old.example.com", "https://example.net")));
    const rules = env.cf.rulesets.get(`${zone.id}:http_request_dynamic_redirect`)!.rules;
    const wildcard = externalRule('http.request.full_uri wildcard "https://*.example.com/*"', "https://example.org");
    rules.push(
      { ...wildcard, enabled: false },
      externalRule('http.request.full_uri wildcard "https://shop.other.com/*"', "https://example.org"),
      externalRule('http.request.full_uri matches r"^https://shop[.]example[.]com/"', "https://example.org"),
    );
    expect((await env.act("delete-redirect", { source: "old.example.com" })).review!.blocked).toBe(false);

    rules.push(wildcard);
    const blocked = await env.act("delete-redirect", { source: "old.example.com" });
    expect(blocked.review!.blocked).toBe(true);
    expect(blocked.review!.sites[0]!.problems.join(" ")).toContain("A rule in Cloudflare also matches old.example.com by pattern");
    expect((await env.act("save-redirect", found("old.example.com", "https://example.com"))).review!.blocked).toBe(true);
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

  test("a connection that fails discovery blocks zone selection and rule lookups even when another connection matches", async () => {
    const env = setup();
    const account2 = env.cf.account("Second Account");
    env.cf.token(TOKEN_TWO, { owner: "user", accounts: [account2], zoneEdit: true });
    env.cf.zone("example.com", env.account);
    const child = env.cf.zone("sub.example.com", account2);
    env.cf.rulesets.set(`${child.id}:http_request_dynamic_redirect`, {
      id: hexId(), rules: [externalRule('http.host eq "loc.sub.example.com"', "https://elsewhere.example")],
    });
    await env.act("save-connection", { token: TOKEN, label: "Parent" });
    await env.act("save-connection", { token: TOKEN_TWO, label: "Child" });
    await env.automatic();
    await env.confirmed(await env.act("save-redirect", {
      ...found("loc.sub.example.com", "https://elsewhere.example"), mode: "local",
    }));

    env.cf.tokens.get(TOKEN_TWO)!.status = "disabled";
    const auto = await env.act("save-redirect", found("go.sub.example.com", "https://example.net"));
    expect(auto.review!.blocked).toBe(true);
    expect(auto.review!.sites[0]!.zone).toBeNull();
    expect(auto.review!.sites[0]!.problems.join(" ")).toContain("Cloudflare could not be read");

    const replace = await env.act("delete-redirect", { source: "loc.sub.example.com" });
    expect(replace.review!.blocked).toBe(true);
    expect(replace.review!.sites[0]!.problems.join(" ")).toContain("Cloudflare could not be read");
  });

  test("deletion inspects the tracked zone beside the selected one and blocks when the tracked zone is out of reach", async () => {
    const env = setup();
    env.cf.zone("example.com", env.account);
    env.cf.zone("other.example", env.account);
    await env.act("save-connection", { token: TOKEN });
    await env.automatic();
    await env.confirmed(await env.act("save-redirect", found("go.sub.example.com", "https://example.net")));
    await env.confirmed(await env.act("save-redirect", found("go.other.example", "https://example.net")));
    expect(env.redirectRules("example.com")).toHaveLength(1);

    // A child zone appears holding its own rule for the host: the parent rule must not be left behind.
    const child = env.cf.zone("sub.example.com", env.account);
    env.cf.rulesets.set(`${child.id}:http_request_dynamic_redirect`, {
      id: hexId(), rules: [externalRule('http.host eq "go.sub.example.com"', "https://example.net")],
    });
    const both = await env.act("delete-redirect", { source: "go.sub.example.com" });
    expect(both.review!.blocked).toBe(true);
    expect(both.review!.sites[0]!.problems.join(" ")).toContain("exist in more than one zone (sub.example.com, example.com)");

    // The token stops listing the tracked zone: no match is not the same as no rule.
    env.cf.zones = env.cf.zones.filter((zone) => zone.name !== "other.example");
    const gone = await env.act("delete-redirect", { source: "go.other.example" });
    expect(gone.review!.blocked).toBe(true);
    expect(gone.review!.sites[0]!.problems.join(" ")).toContain("other.example, where the Cloudflare rule for go.other.example was last seen, is not reachable");
  });

  test("keeps tracking the zone that holds a redirect's rule when a read-only check selects a new child zone", async () => {
    const env = setup();
    env.cf.zone("example.com", env.account);
    await env.act("save-connection", { token: TOKEN });
    await env.automatic();
    await env.confirmed(await env.act("save-redirect", found("go.sub.example.com", "https://example.net")));
    await env.act("set-automatic", { automatic: false });
    const tracked = () => JSON.parse(readFileSync(join(env.paths.stateDir, "status.json"), "utf8")).redirectRules?.["go.sub.example.com"];
    expect(tracked()?.map((zone: { zoneName: string }) => zone.zoneName)).toEqual(["example.com"]);

    env.cf.zone("sub.example.com", env.account);
    const checked = await env.act("check");
    expect(checked.redirects[0]!.plan!.zone!.name).toBe("sub.example.com");
    expect(tracked()?.map((zone: { zoneName: string }) => zone.zoneName)).toEqual(["example.com"]);

    const replace = await env.act("delete-redirect", { source: "go.sub.example.com" });
    expect(replace.review!.blocked).toBe(false);
    expect(replace.review!.sites[0]!.zone!.name).toBe("example.com");
    expect(replace.review!.sites[0]!.changes).toContainEqual(expect.objectContaining({ action: "delete", subject: "Cloudflare redirect rule" }));

    // Once a read shows the parent's rule is gone, tracking lets go of it.
    env.redirectRules("example.com").pop();
    await env.act("check");
    expect(tracked()).toBeUndefined();
  });

  test("keeps tracking an intermediate zone's rule when the selected zone moves on twice", async () => {
    const env = setup();
    env.cf.zone("example.com", env.account);
    await env.act("save-connection", { token: TOKEN });
    await env.automatic();
    await env.confirmed(await env.act("save-redirect", found("go.sub.example.com", "https://example.net")));
    const tracked = () => (JSON.parse(readFileSync(join(env.paths.stateDir, "status.json"), "utf8"))
      .redirectRules?.["go.sub.example.com"] ?? []).map((zone: { zoneName: string }) => zone.zoneName);

    env.cf.zone("sub.example.com", env.account);
    await env.act("check");
    await env.act("check");
    expect(env.redirectRules("sub.example.com")).toHaveLength(1);
    expect(tracked()).toEqual(["sub.example.com", "example.com"]);

    env.redirectRules("example.com").pop();
    env.cf.zone("go.sub.example.com", env.account);
    await env.act("check");
    await env.act("check");
    expect(env.redirectRules("go.sub.example.com")).toHaveLength(1);
    expect(tracked()).toEqual(["go.sub.example.com", "sub.example.com"]);

    const both = await env.act("delete-redirect", { source: "go.sub.example.com" });
    expect(both.review!.blocked).toBe(true);
    expect(both.review!.sites[0]!.problems.join(" ")).toContain("exist in more than one zone (go.sub.example.com, sub.example.com)");
  });

  test("still reads a single tracked zone saved before zones were listed", async () => {
    const env = setup();
    env.cf.zone("example.com", env.account);
    await env.act("save-connection", { token: TOKEN });
    await env.automatic();
    await env.confirmed(await env.act("save-redirect", found("go.example.com", "https://example.net")));
    const statusFile = join(env.paths.stateDir, "status.json");
    const status = JSON.parse(readFileSync(statusFile, "utf8"));
    status.redirectRules["go.example.com"] = { connectionId: "cf-gone", zoneId: "9".repeat(32), zoneName: "ghost.example.com" };
    writeFileSync(statusFile, JSON.stringify(status), { mode: 0o600 });

    const blocked = await env.act("delete-redirect", { source: "go.example.com" });
    expect(blocked.review!.blocked).toBe(true);
    expect(blocked.review!.sites[0]!.problems.join(" ")).toContain("ghost.example.com, where the Cloudflare rule for go.example.com was last seen, is not reachable");
  });

  test("holds a stand-in that gains a zone even when a refresh records the zoned plan first", async () => {
    const env = setup();
    env.cf.zone("other.example", env.account);
    await env.act("save-connection", { token: TOKEN });
    await env.automatic();
    await env.confirmed(await env.act("save-redirect", found("later.example", "https://example.com")));
    expect(env.standIns.current["later.example"]).toBeDefined();

    env.cf.zone("later.example", env.account);
    const resaved = await env.act("save-redirect", found("later.example", "https://example.com"));
    expect(resaved.review).toBeUndefined();
    expect(resaved.redirects[0]!.plan!.held).toBe(true);
    await env.act("check");
    expect(env.standIns.current["later.example"]).toBeDefined();
    expect(env.redirectRules("later.example")).toEqual([]);
    expect((await env.act("list")).redirects[0]!.plan!.held).toBe(true);
  });

  test("turning on Automatic counts only the changes it applies, not those held for their own review", async () => {
    const env = setup();
    env.cf.zone("other.example", env.account);
    await env.act("save-connection", { token: TOKEN });
    await env.automatic();
    await env.confirmed(await env.act("save-redirect", found("later.example", "https://example.com")));
    await env.act("set-automatic", { automatic: false });

    env.cf.zone("later.example", env.account);
    await env.act("check");
    const review = (await env.act("set-automatic", { automatic: true })).review!;
    const held = review.sites.find((plan) => plan.domain === "later.example")!;
    expect(held.changes.length).toBeGreaterThan(0);
    expect(held.changes.every((change) => change.waits)).toBe(true);
    expect(review.text).toStartWith("0 changes will be made now");
  });

  test("holds a Cloudflare redirect for review before it falls back to a new stand-in", async () => {
    const env = setup();
    env.cf.zone("other.example", env.account);
    env.cf.zone("narrowed.example", env.account);
    await env.act("save-connection", { token: TOKEN });
    await env.automatic();
    await env.confirmed(await env.act("save-redirect", found("narrowed.example", "https://example.com")));
    expect(env.redirectRules("narrowed.example")).toHaveLength(1);

    // The token stops listing the zone while the connection stays the same.
    env.cf.zones = env.cf.zones.filter((zone) => zone.name !== "narrowed.example");
    await env.act("check");
    expect(env.standIns.calls).toEqual([]);
    expect((await env.act("list")).redirects[0]!.plan!.held).toBe(true);

    // A reviewed fallback creates the stand-in, and later checks leave it be.
    await env.confirmed(await env.act("review-redirect", { source: "narrowed.example" }));
    expect(env.standIns.calls).toEqual(["create narrowed.example"]);
    await env.act("check");
    expect((await env.act("list")).redirects[0]!.plan!.held).toBeUndefined();
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

describe("a CloudPanel site replaces a redirect", () => {
  test("in Automatic, the new-sites hook removes the redirect's rule, placeholders and stand-in at once, and nothing else", async () => {
    const env = setup();
    const nonWeb = seededZone(env.cf, env.account, "clash.example", "https://example.com");
    await env.act("save-connection", { token: TOKEN });
    await env.automatic();
    await env.confirmed(await env.act("take-over", { redirects: [found("clash.example", "https://example.com")] }));
    await env.confirmed(await env.act("save-redirect", { ...found("old.example", "https://example.com"), mode: "local" }));
    expect(env.placeholders("clash.example").sort()).toEqual(["clash.example", "www.clash.example"]);
    expect(env.standIns.current["old.example"]).toBeDefined();

    env.sites.push({ id: 42, domain: "www.clash.example", user: "clash", selfSigned: false });
    env.sites.push({ id: 43, domain: "www.old.example", user: "old", selfSigned: false });
    const line = await REDIRECTS_ADDON.newSites!.run(env.options() as Record<string, unknown>);
    expect(line).toBe("removed clash.example, old.example, replaced by new sites");

    expect(env.redirectRules("clash.example")).toEqual([]);
    expect(env.placeholders("clash.example")).toEqual([]);
    for (const record of nonWeb) expect(env.cf.recordsOf("clash.example").map((r) => JSON.stringify(r))).toContain(record);
    expect(env.standIns.calls).toContain("remove old.example");
    expect(env.sites.map((site) => site.domain).sort()).toEqual(["www.clash.example", "www.old.example"]);
    const listed = await env.act("list");
    expect(listed.redirects).toEqual([]);
    expect(listed.log).toContainEqual(expect.objectContaining({
      sites: ["clash.example"], subject: "Redirect", detail: "Replaced by the site www.clash.example", cause: "New site",
    }));
    expect(listed.log).toContainEqual(expect.objectContaining({
      sites: ["clash.example"], subject: "Cloudflare redirect rule", detail: "Replaced by the site www.clash.example",
    }));
  });

  test("the new-sites hook makes no Cloudflare call when no new site touches a redirect", async () => {
    const env = setup();
    seededZone(env.cf, env.account, "quiet.example", "https://example.com");
    await env.act("save-connection", { token: TOKEN });
    await env.automatic();
    await env.confirmed(await env.act("take-over", { redirects: [found("quiet.example", "https://example.com")] }));
    env.sites.push({ id: 50, domain: "unrelated.example", user: "unrelated", selfSigned: false });
    env.sites.push({ id: 51, domain: "shop.quiet.example", user: "shop", selfSigned: false });
    const calls = env.cf.calls.length;
    expect(await env.act<unknown>("sync-sites")).toEqual({ replaced: [], waiting: [], blocked: [] });
    expect(env.cf.calls.length).toBe(calls);
    expect(env.redirectRules("quiet.example")).toHaveLength(1);
  });

  test("deleting a redirect with no Cloudflare connection is still a server review, so the page never deletes on a stale view", async () => {
    const env = setup();
    await env.automatic();
    await env.confirmed(await env.act("save-redirect", { ...found("plain.example", "https://example.com"), mode: "local" }));
    expect(env.standIns.current["plain.example"]).toBeDefined();
    const review = await env.act("delete-redirect", { source: "plain.example" });
    expect(review.review!.text).toBe("Its stand-in site is deleted, so plain.example stops redirecting. Other DNS records stay untouched.");
    expect(env.standIns.calls).not.toContain("remove plain.example");
    const deleted = await env.confirmed(review);
    expect(env.standIns.calls).toContain("remove plain.example");
    expect(deleted.redirects).toEqual([]);
  });

  test("the new-sites hook reads stand-ins again once it holds the lock, so a stand-in retired meanwhile does not hide its site", async () => {
    const env = setup();
    await env.automatic();
    await env.confirmed(await env.act("save-redirect", { ...found("first.example", "https://example.com"), mode: "local" }));
    await env.confirmed(await env.act("save-redirect", { ...found("second.example", "https://example.com"), mode: "local" }));
    // What the scan before the lock saw: second.example still a stand-in.
    const before = new FakeStandIns(env.sites);
    before.current = { ...env.standIns.current };
    await env.standIns.remove("second.example");
    env.sites.push({ id: 60, domain: "www.first.example", user: "first", selfSigned: false });
    env.sites.push({ id: 61, domain: "second.example", user: "second", selfSigned: false });
    const adapters = [before, env.standIns];
    const synced = await executeRedirectsAction(["sync-sites"], { ...env.options(), standIns: () => adapters.shift() ?? env.standIns });
    expect(synced).toEqual({ replaced: ["first.example", "second.example"], waiting: [], blocked: [] });
  });

  test("in Ask first, the removal waits as a pending change until Automatic is turned on", async () => {
    const env = setup();
    seededZone(env.cf, env.account, "ask.example", "https://example.com");
    await env.act("save-connection", { token: TOKEN });
    await env.automatic();
    await env.confirmed(await env.act("take-over", { redirects: [found("ask.example", "https://example.com")] }));
    await env.act("set-automatic", { automatic: false });

    env.sites.push({ id: 44, domain: "ask.example", user: "ask", selfSigned: false });
    expect(await env.act<unknown>("sync-sites")).toEqual({ replaced: [], waiting: ["ask.example"], blocked: [] });
    await env.act("check");
    expect(env.redirectRules("ask.example")).toHaveLength(1);
    const plan = (await env.act("list")).redirects[0]!.plan!;
    expect(plan.replacedBy).toBe("ask.example");
    expect(plan.problems).toEqual([]);
    expect(plan.changes.map((change) => `${change.action} ${change.subject}`)).toEqual([
      "delete Cloudflare redirect rule", "delete AAAA ask.example", "delete AAAA www.ask.example",
    ]);

    const review = await env.act("set-automatic", { automatic: true });
    expect(review.review!.sites[0]!.replacedBy).toBe("ask.example");
    const applied = await env.confirmed(review);
    expect(applied.automatic).toBe(true);
    expect(applied.redirects).toEqual([]);
    expect(env.redirectRules("ask.example")).toEqual([]);
    expect(env.placeholders("ask.example")).toEqual([]);
    expect(env.sites.map((site) => site.domain)).toEqual(["ask.example"]);
  });

  test("a reviewed replacement shows a fresh review when its rule was recreated, rather than deleting the new one", async () => {
    const env = setup();
    seededZone(env.cf, env.account, "swap.example", "https://example.com");
    await env.act("save-connection", { token: TOKEN });
    await env.automatic();
    await env.confirmed(await env.act("take-over", { redirects: [found("swap.example", "https://example.com")] }));
    await env.act("set-automatic", { automatic: false });
    env.sites.push({ id: 46, domain: "swap.example", user: "swap", selfSigned: false });

    const review = await env.act("set-automatic", { automatic: true });
    expect(review.review!.sites[0]!.replacedBy).toBe("swap.example");
    const rule = env.redirectRules("swap.example")[0]!;
    rule.id = "0123456789abcdef0123456789abcdef";
    const again = await env.act("confirm", { token: review.review!.token });
    expect(again.notice).toContain("Cloudflare changed after the plan was shown");
    expect(again.review!.sites[0]!.replacedBy).toBe("swap.example");
    expect(env.redirectRules("swap.example")).toHaveLength(1);
    expect(env.placeholders("swap.example")).toHaveLength(2);

    await env.confirmed(again);
    expect(env.redirectRules("swap.example")).toEqual([]);
  });

  test("keeps the redirect and reports a problem while its rule cannot be read or conflicts", async () => {
    const env = setup();
    seededZone(env.cf, env.account, "keep.example", "https://example.com");
    await env.act("save-connection", { token: TOKEN });
    await env.automatic();
    await env.confirmed(await env.act("take-over", { redirects: [found("keep.example", "https://example.com")] }));
    env.sites.push({ id: 45, domain: "keep.example", user: "keep", selfSigned: false });

    env.cf.tokens.get(TOKEN)!.status = "disabled";
    // Automatic is on, so the hook names the problem instead of waiting for Automatic.
    expect(await REDIRECTS_ADDON.newSites!.run(env.options() as Record<string, unknown>)).toBe("keep.example kept for now; see the problem in Redirects");
    const unreadable = await env.act("check");
    expect(unreadable.redirects[0]!.plan!.problems.join(" ")).toContain("Cloudflare could not be read");
    expect(env.redirectRules("keep.example")).toHaveLength(1);

    env.cf.tokens.get(TOKEN)!.status = "active";
    env.redirectRules("keep.example").push(externalRule(apexHosts("keep.example"), "https://other.example"));
    const conflicted = await env.act("check");
    expect(conflicted.redirects[0]!.plan!.problems.join(" ")).toContain("2 redirect rules");
    expect(env.redirectRules("keep.example")).toHaveLength(2);
    expect(env.placeholders("keep.example")).toHaveLength(2);

    env.redirectRules("keep.example").pop();
    const replaced = await env.act("check");
    expect(replaced.redirects).toEqual([]);
    expect(env.redirectRules("keep.example")).toEqual([]);
    expect(env.sites).toEqual([{ id: 45, domain: "keep.example", user: "keep", selfSigned: false }]);
  });

  test("deleting a redirect in Ask first reviews and removes its Cloudflare rule, and blocks while Cloudflare cannot be read", async () => {
    const env = setup();
    const nonWeb = seededZone(env.cf, env.account, "gone.example", "https://example.com");
    seededZone(env.cf, env.account, "stuck.example", "https://example.com");
    await env.act("save-connection", { token: TOKEN });
    await env.automatic();
    await env.confirmed(await env.act("take-over", {
      redirects: [found("gone.example", "https://example.com"), found("stuck.example", "https://example.com")],
    }));
    await env.act("set-automatic", { automatic: false });

    const review = await env.act("delete-redirect", { source: "gone.example" });
    expect(review.review).toMatchObject({ blocked: false, confirmLabel: "Delete redirect", danger: true });
    expect(review.review!.sites[0]!.changes).toEqual([expect.objectContaining({ action: "delete", subject: "Cloudflare redirect rule" })]);
    expect(env.redirectRules("gone.example")).toHaveLength(1);
    const deleted = await env.act("confirm", { token: review.review!.token });
    expect(deleted.redirects.map((redirect) => redirect.source)).toEqual(["stuck.example"]);
    expect(env.redirectRules("gone.example")).toEqual([]);
    for (const record of nonWeb) expect(env.cf.recordsOf("gone.example").map((r) => JSON.stringify(r))).toContain(record);

    env.cf.tokens.get(TOKEN)!.status = "disabled";
    const blocked = await env.act("delete-redirect", { source: "stuck.example" });
    expect(blocked.review).toMatchObject({ blocked: true, token: "" });
    expect((await env.act("list")).redirects.map((redirect) => redirect.source)).toEqual(["stuck.example"]);
    expect(env.redirectRules("stuck.example")).toHaveLength(1);
  });

  test("create-site-helper reads local state without calling Cloudflare", async () => {
    const env = setup();
    seededZone(env.cf, env.account, "replace-cf.example", "https://example.com");
    await env.act("save-connection", { token: TOKEN });
    await env.automatic();
    await env.confirmed(await env.act("take-over", { redirects: [found("replace-cf.example", "https://example.com")] }));
    await env.confirmed(await env.act("save-redirect", { ...found("replace-local.example", "https://example.com"), mode: "local" }));

    const calls = env.cf.calls.length;
    const helper = await env.act<CreateSiteHelper>("create-site-helper");
    expect(env.cf.calls.length).toBe(calls);
    expect(helper.automatic).toBe(true);
    expect(helper.redirects.map((r) => `${r.source}:${r.standIn}`)).toEqual([
      "replace-cf.example:false",
      "replace-local.example:true",
    ]);
    expect(helper.redirects.every((r) => !("servedBy" in r) && !("zone" in r))).toBe(true);
    expect(helper.redirects[0]!.hosts).toEqual(["replace-cf.example", "www.replace-cf.example"]);
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

  test("Create Site helper only informs: it says the site replaces the redirect and offers no action", async () => {
    const page = createSitePage([
      { source: "a.example", target: "https://x.example", hosts: ["a.example", "www.a.example"], standIn: false },
      { source: "b.example", target: "https://y.example", hosts: ["b.example", "www.b.example"], standIn: true },
    ]);
    await page.settle();
    page.type("www.a.example");
    expect(page.box.hidden).toBe(false);
    expect(page.box.textContent).toContain("www.a.example is covered by the redirect on a.example to https://x.example.");
    expect(page.box.textContent).toContain("Creating this site replaces the redirect: its Cloudflare rule and any stand-in site are removed.");
    page.type("www.b.example");
    expect(page.box.textContent).toContain("Creating this site replaces the redirect");
    page.type("b.example");
    expect(page.box.textContent).toContain("Its stand-in site already uses this domain on this server, so delete the redirect in Redirects before creating the site.");
    expect(page.box.descendants().some((node) => node.tag === "button" || node.tag === "dialog")).toBe(false);
    expect(page.dialogs()).toEqual([]);
    page.type("c.example");
    expect(page.box.hidden).toBe(true);
    expect(page.calls).toEqual([]);
    const script = readFileSync(join(REPO, "addons/redirects/inject/create-site.client.js"), "utf8");
    expect(script).not.toContain("prepare-replace");
    expect(script).not.toContain("method: 'POST'");
  });

  test("Create Site helper builds every URL from its fixed mount path, never from the page's markup", async () => {
    const hostile = createSitePage([{ source: "a.example", hosts: ["a.example"] }], "javascript:alert(1)//");
    await hostile.settle();
    hostile.type("a.example");
    expect(hostile.box.hidden).toBe(true);

    expect(createSiteRedirectSnippet(mountPath("redirects"))).toContain(`data-url="${mountPath("redirects")}"`);
    const script = readFileSync(join(REPO, "addons/redirects/inject/create-site.client.js"), "utf8");
    expect(script).toContain(`var MOUNT = '${mountPath("redirects")}';`);
    expect(script).not.toMatch(/(?:href|fetch\()\s*=?\s*[^'M\s]*url/);
    expect(script.match(/getAttribute\('data-url'\)/g)).toHaveLength(1);
    expect(script).toContain("if (box.getAttribute('data-url') !== MOUNT) return;");
  });
});

describe("migration from addons/dns and DNS stand-in exclusion", () => {
  test("hands each redirect's mail profile to DNS as the domain's Mail role through DNS's own upgrade", () => {
    const dir = mkdtempSync(join(tmpdir(), "redirects-mig-mail-"));
    dirs.push(dir);
    const dnsDir = join(dir, "dns");
    const redirectsDir = join(dir, "redirects");
    mkdirSync(dnsDir, { recursive: true });
    writeFileSync(join(dir, "dns.conf"), "enabled\n");
    const mx = { type: "MX", name: "{domain}", content: "mail.example.net", proxied: false, ttl: 1, priority: 10, apexOnly: false };
    const a = { type: "A", name: "{domain}", content: "{ipv4}", proxied: true, ttl: 1, priority: null, apexOnly: false };
    writeFileSync(join(dnsDir, "policy.json"), JSON.stringify({
      version: 1, automatic: true, createIn: null, connections: [], defaultProfileId: null, knownSiteIds: [1], held: [],
      zoneChoices: {}, server: { ipv4: "", ipv6: "" }, panelHost: null,
      mailcow: { url: "", host: "", dkimSource: "", dkimSelector: "dkim", dkimBits: 2048, sharedMailbox: "" },
      profiles: [
        { id: "web", name: "Web", mailcow: false, records: [a] },
        { id: "web-mail", name: "Web and mail", mailcow: false, records: [a, mx] },
      ],
      assignments: { "site.example.com": "web" },
      redirects: [{ source: "old.example.org", target: "https://example.com", status: 301, keepPath: true, keepQuery: true, profileId: "web-mail" }],
    }), { mode: 0o600 });

    const undo = migrateRedirectsFromDns(() => {}, {
      dnsDir, redirectsDir, dnsConfigFile: join(dir, "dns.conf"), redirectsConfigFile: join(dir, "redirects.conf"), rootUid: process.getuid!(),
      upgradeDnsPolicy: upgradeSavedPolicy,
    });
    expect(undo).not.toBeNull();
    const dnsPolicy = JSON.parse(readFileSync(join(dnsDir, "policy.json"), "utf8"));
    expect(dnsPolicy.version).toBe(2);
    expect(dnsPolicy.redirects).toBeUndefined();
    expect(dnsPolicy.assignments).toEqual({ "site.example.com": { http: "web", mail: null }, "old.example.org": { http: null, mail: "web-mail-mail" } });
    expect(dnsPolicy.profiles.find((profile: { id: string }) => profile.id === "web-mail-mail").records).toEqual([mx]);
    expect(JSON.parse(readFileSync(join(redirectsDir, "policy.json"), "utf8")).redirects.map((redirect: { source: string }) => redirect.source)).toEqual(["old.example.org"]);
    undo!();
    expect(JSON.parse(readFileSync(join(dnsDir, "policy.json"), "utf8")).version).toBe(1);
  });

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

  test("migration takes a redirect's mode from the zone its legacy plan resolved before any ancestor zone choice", () => {
    const dir = mkdtempSync(join(tmpdir(), "redirects-mig-provider-"));
    dirs.push(dir);
    const dnsDir = join(dir, "dns");
    const redirectsDir = join(dir, "redirects");
    mkdirSync(dnsDir, { recursive: true });
    const legacy = (source: string) => ({ source, target: "https://example.net", status: 301, keepPath: true, keepQuery: true, profileId: null });
    writeFileSync(join(dnsDir, "policy.json"), JSON.stringify({
      version: 1, automatic: false,
      redirects: [legacy("go.shop.example.com"), legacy("pd.example.com"), legacy("unplanned.example.com")],
      zoneChoices: { "example.com": { connectionId: "pdns-1", zoneId: "example.com." } },
    }), { mode: 0o600 });
    writeFileSync(join(dnsDir, "status.json"), JSON.stringify({
      plans: {
        "go.shop.example.com": { zone: { provider: "cloudflare", name: "shop.example.com" } },
        "pd.example.com": { zone: { provider: "powerdns", name: "example.com" } },
      },
    }), { mode: 0o600 });
    const redirectsConfigFile = join(dir, "redirects.conf");
    migrateRedirectsFromDns(() => {}, { dnsDir, redirectsDir, dnsConfigFile: join(dir, "dns.conf"), redirectsConfigFile, rootUid: process.getuid!() });
    const modes = Object.fromEntries(JSON.parse(readFileSync(join(redirectsDir, "policy.json"), "utf8")).redirects
      .map((redirect: Redirect) => [redirect.source, redirect.mode ?? "auto"]));
    expect(modes).toEqual({ "go.shop.example.com": "auto", "pd.example.com": "local", "unplanned.example.com": "local" });
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

  test("DNS list excludes stand-in sites whose redirect Redirects serves at Cloudflare's edge", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dns-standin-exclude-"));
    dirs.push(dir);
    writeFileSync(join(dir, "dns.conf"), "enabled");
    const standInsFile = join(dir, "redirects", "standins.json");
    mkdirSync(join(dir, "redirects"), { recursive: true });
    writeFileSync(standInsFile, JSON.stringify({
      "old.example": { siteUser: "old-1a2b3c4d", siteId: 99, createdAt: 0 },
    }), { mode: 0o600 });
    const redirectsStatusFile = join(dir, "redirects", "status.json");
    writeFileSync(redirectsStatusFile, JSON.stringify({
      checkedAt: null, plans: {}, redirectRules: { "old.example": { connectionId: "cf-1", zoneId: "z", zoneName: "old.example" } },
    }), { mode: 0o600 });

    const reply = await executeDnsAction(["list"], {
      paths: {
        configFile: join(dir, "dns.conf"),
        stateDir: join(dir, "dns"),
        standInsFile,
        redirectsStatusFile,
        smtpConfig: join(dir, "smtp.json"),
        lockFile: join(dir, "dns.lock"),
        panelDb: join(dir, "db.sq3"),
        rootUid: process.getuid!(),
        clpctl: "/bin/false",
      },
      processUid: 0,
      sites: () => [
        { id: 1, domain: "real.example", type: "php", createdAt: 0, selfSigned: false, cloudflareOnly: false },
        { id: 99, domain: "old.example", type: "static", user: "old-1a2b3c4d", createdAt: 0, selfSigned: true, cloudflareOnly: false },
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

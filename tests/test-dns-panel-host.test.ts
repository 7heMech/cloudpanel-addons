import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeDnsAction, type DnsReply, type PanelHostHelper } from "../addons/dns/action";
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
  const mailcow = new FakeMailcow();
  const options = {
    paths: { configFile: join(dir, "dns.conf"), stateDir: join(dir, "state"), smtpConfig: join(dir, "smtp.json"), lockFile: join(dir, "dns.lock"), panelDb: join(dir, "db.sq3"), rootUid: process.getuid!(), clpctl: "/bin/false" },
    processUid: 0,
    fetch: routed(cf, mailcow),
    sites: () => sites,
    addresses: () => ({ ipv4: "203.0.113.10", ipv6: "2001:db8::10" }),
    customDomain: () => custom.current,
    now: () => START,
  };
  const env = {
    dir, cf, mailcow, sites, custom, options,
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

  test("its profile points the name here, proxied only when asked", () => {
    const grey = panelProfile(false);
    expect(grey.id).toBe(PANEL_PROFILE_ID);
    expect(grey.records.map((row) => `${row.type} ${row.name} ${row.content} ${row.proxied}`)).toEqual(["A {domain} {ipv4} false", "AAAA {domain} {ipv6} false"]);
    expect(panelProfile(true).records.every((row) => row.proxied)).toBe(true);
  });

  test("is planned beside the sites, and waits while a site has its name", () => {
    const base = { secrets: { cloudflare: {}, mailcowKey: "" }, addresses: { ipv4: "203.0.113.10", ipv6: null }, backoff: { cloudflare: 0, mailcow: 0 } };
    const policy = { ...seededPolicy(), panelHost: "panel.example.com" };
    const entries = (sites: PanelSite[], extra = {}) => new DnsRun({ ...base, policy: { ...policy, ...extra }, sites }).entries.map((entry) => `${entry.type} ${entry.domain}`);
    expect(entries([site(1, "shop.example.com")])).toEqual(["php shop.example.com", "panel panel.example.com"]);
    expect(entries([site(1, "panel.example.com")])).toEqual(["php panel.example.com"]);
  });

  test("is written unproxied, then proxied once CloudPanel serves an issued certificate for it", async () => {
    const env = setup();
    await env.automatic();
    const saved = await env.apply("set-panel-host", { name: "panel.example.com" });
    expect(saved.panelHost).toMatchObject({ name: "panel.example.com", problem: null, proxied: false, customDomain: null });
    expect(env.records()).toEqual(["A panel.example.com 203.0.113.10", "AAAA panel.example.com 2001:db8::10"]);
    const zone = env.cf.zones[0]!;
    expect(env.cf.rulesets.get(`${zone.id}:http_config_settings`)).toBeUndefined();
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
    expect(saved.panelHost!.plan!.changes.map((change) => change.subject).sort()).toEqual(["A panel.example.com", "AAAA panel.example.com"]);
    expect(dashboardContent(saved)).toContain("DNS asks first, so the record is written once you turn on Automatic.");
    env.custom.current = { name: "panel.example.com", issued: true };
    expect(await DNS_ADDON.certificates!.run(env.options)).toBeNull();
    expect(env.cf.writes()).toEqual([]);
  });

  test("is refused before any DNS provider is connected", async () => {
    const env = setup();
    await expect(env.act("set-panel-host", { name: "panel.example.com" })).rejects.toThrow("Add a DNS connection first");
  });

  test("is refused for a name a site has", async () => {
    const env = setup();
    await env.act("save-connection", { token: TOKEN });
    await expect(env.act("set-panel-host", { name: "shop.example.com" })).rejects.toThrow("shop.example.com is a CloudPanel site");
  });

  test("shows a site that took its name later as a problem without repeating it or showing Next", async () => {
    const env = setup();
    await env.act("save-connection", { token: TOKEN });
    await env.act("set-panel-host", { name: "panel.example.com" });
    env.sites.push(site(2, "panel.example.com"));
    const state = await env.act("list");
    expect(state.panelHost!.problem).toContain("CloudPanel has a site panel.example.com");
    expect(state.panelHost!.plan).toBeNull();
    const html = dashboardContent(state).replace(/<script[\s\S]*?<\/script>/, "");
    expect(html.split("CloudPanel has a site panel.example.com").length - 1).toBe(1);
    expect(html).not.toContain("Next: enter panel.example.com");
  });

  test("exposes an existing CloudPanel custom domain for one-click adoption and keeps Ask-first notices accurate", async () => {
    const env = setup();
    await env.act("save-connection", { token: TOKEN });
    env.custom.current = { name: "cp.example.com", issued: true };
    const state = await env.act("list");
    expect(state.panelHost).toBeNull();
    expect(state.customDomain).toEqual({ name: "cp.example.com", issued: true });
    const html = dashboardContent(state);
    expect(html).toContain("cp.example.com");
    expect(html).toContain("Manage in Cloudflare");
    expect(html).toContain("dnsAdoptPanelHost");

    const saved = await env.act("set-panel-host", { name: "panel.example.com" });
    expect(saved.notice).toContain("Turn on Automatic");
    expect(saved.notice).not.toContain("point to this server");
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

  test("hands off to an unobstructed proxied zone wildcard once CloudPanel's certificate is issued", async () => {
    const env = setup();
    env.cf.record("example.com", { type: "A", name: "*.example.com", content: "203.0.113.10", proxied: true });
    env.cf.record("example.com", { type: "AAAA", name: "*.example.com", content: "2001:db8::10", proxied: true });
    await env.automatic();
    const saved = await env.apply("set-panel-host", { name: "k7m2p9x4.example.com" });
    expect(saved.panelHost!.plan!.wildcard).toBeUndefined();
    // Unproxied records are created temporarily so Let's Encrypt reaches CloudPanel directly.
    expect(env.records()).toEqual([
      "A *.example.com 203.0.113.10 proxied", "A k7m2p9x4.example.com 203.0.113.10",
      "AAAA *.example.com 2001:db8::10 proxied", "AAAA k7m2p9x4.example.com 2001:db8::10",
    ]);

    env.custom.current = { name: "k7m2p9x4.example.com", issued: true };
    expect(await DNS_ADDON.certificates!.run(env.options)).toBe("k7m2p9x4.example.com is proxied through Cloudflare");
    expect(env.records()).toEqual([
      "A *.example.com 203.0.113.10 proxied", "AAAA *.example.com 2001:db8::10 proxied",
    ]);
    const state = await env.act("list");
    expect(state.panelHost!.plan!.wildcard).toBe("*.example.com");
    expect(dashboardContent(state)).toContain("via *.example.com");
    expect(state.log.filter((line) => line.cause === "Panel certificate" && line.action === "delete").map((line) => line.detail)).toEqual(
      expect.arrayContaining([expect.stringContaining("covered by *.example.com")]),
    );

    // Removing panelHost after wildcard handoff leaves no phantom orphans.
    const removed = await env.act("set-panel-host", { name: null });
    expect(removed.orphans).toEqual([]);
  });

  test("the page offers a Random button, zone suggestions, safe base detection and accurate pending copy", async () => {
    const env = setup();
    await env.automatic();
    const state = await env.act("list");
    expect(state.zones).toEqual(["example.com"]);
    expect("zoneNames" in state.connections[0]!).toBe(false);
    const html = dashboardContent(state);
    expect(html).toContain('placeholder="k7m2p9x4.example.com"');
    expect(html).toContain('<datalist id="dns-zone-list"><option value="example.com"></option></datalist>');
    expect(html).toContain('onclick="dnsRandomPanelHost()"');

    // While pending changes remain in Ask first, do not claim the custom domain is already proxied via the wildcard.
    const pendingHtml = dashboardContent({
      ...state,
      automatic: false,
      panelHost: {
        name: "k7m2p9x4.example.com", problem: null, customDomain: { name: "k7m2p9x4.example.com", issued: true }, proxied: true,
        plan: {
          domain: "k7m2p9x4.example.com", httpProfileId: PANEL_PROFILE_ID, mailProfileId: null, mode: "report",
          zone: { id: "0".repeat(32), name: "example.com", status: "active", nameServers: [], account: "Agency", connection: "Agency" },
          changes: [{ action: "delete", subject: "A k7m2p9x4.example.com", detail: "203.0.113.10 · DNS only · covered by *.example.com" }],
          problems: [], zoneChoices: [], certificateNames: [], panel: true, wildcard: "*.example.com",
        },
      },
    });
    expect(pendingHtml).not.toContain("proxied through Cloudflare via *.example.com");
    expect(pendingHtml).toContain("DNS asks first");

    // Verify client-side random label and base domain helpers directly.
    const clientSource = readFileSync(join(import.meta.dir, "../addons/dns/app/views.client.js"), "utf8");
    const helperBlock = clientSource.slice(clientSource.indexOf("function dnsRandomLabel()"), clientSource.indexOf("function dnsRandomPanelHost()"));
    const makeHelpers = (dnsState: Record<string, unknown>) =>
      new Function("dnsState", "crypto", `${helperBlock}\nreturn { dnsRandomLabel, dnsPanelBase };`)(dnsState, crypto) as {
        dnsRandomLabel: () => string;
        dnsPanelBase: (value: string, savedBase: string) => string;
      };
    const { dnsRandomLabel, dnsPanelBase } = makeHelpers({ zones: ["example.com", "sub.example.org"], panelHost: null });
    for (let i = 0; i < 20; i++) expect(dnsRandomLabel()).toMatch(/^[a-hjkmnp-z][a-hjkmnp-z2-9]{7}$/);
    expect(dnsPanelBase("old.example.com", "")).toBe("example.com");
    expect(dnsPanelBase("a.sub.example.org", "")).toBe("sub.example.org");
    // Multi-part TLD without a matching connected zone keeps the full domain instead of dropping to co.uk.
    expect(dnsPanelBase("example.co.uk", "")).toBe("example.co.uk");
    expect(dnsPanelBase("k7m2p9x4.example.co.uk", "example.co.uk")).toBe("example.co.uk");
    expect(dnsPanelBase("https://example.com", "")).toBe("");
    expect(dnsPanelBase("a..b", "")).toBe("");
    expect(makeHelpers({ zones: ["only.example"], panelHost: null }).dnsPanelBase("", "")).toBe("only.example");
    expect(makeHelpers({ zones: ["a.example", "b.example"], panelHost: null }).dnsPanelBase("", "")).toBe("");
  });

  test("panel-host-helper answers from local state alone without calling Cloudflare", async () => {
    const env = setup();
    const before = await env.act<PanelHostHelper>("panel-host-helper");
    expect(before).toEqual({
      connected: false,
      automatic: false,
      hasCloudflare: false,
      hasPowerDns: false,
      zones: [],
      zoneProviders: {},
      panelHost: null,
      serverIps: { ipv4: "203.0.113.10", ipv6: "2001:db8::10" },
    });
    expect(env.cf.calls.length).toBe(0);

    await env.act("save-connection", { token: TOKEN });
    await env.act("save-server", { ipv4: "198.51.100.7", ipv6: "" });
    await env.act("set-panel-host", { name: "panel.example.com" });
    const callsBeforeHelper = env.cf.calls.length;
    const after = await env.act<PanelHostHelper>("panel-host-helper");
    expect(after).toEqual({
      connected: true,
      automatic: false,
      hasCloudflare: true,
      hasPowerDns: false,
      zones: ["example.com"],
      zoneProviders: { "example.com": "cloudflare" },
      panelHost: "panel.example.com",
      serverIps: { ipv4: "198.51.100.7", ipv6: "2001:db8::10" },
    });
    expect(env.cf.calls.length).toBe(callsBeforeHelper);
  });

  test("prepareOnly confirms and writes only the panel hostname unproxied in Ask first mode without touching other sites", async () => {
    const env = setup();
    await env.act("save-connection", { token: TOKEN });
    // Assign another site in the same zone to the Web profile (which wants ssl: strict, alwaysHttps: true, and its own A/AAAA records).
    const initial = await env.act("list");
    const webId = initial.profiles.find((p) => p.name === "Web")!.id;
    await env.act("assign", { domains: ["shop.example.com"], profileId: webId });
    expect(env.cf.writes()).toEqual([]);

    const prepared = await env.act("set-panel-host", { name: "panel.example.com", prepareOnly: true });
    expect(prepared.automatic).toBe(false);
    expect(prepared.review).toBeDefined();
    expect(prepared.review!.blocked).toBe(false);
    expect(prepared.review!.sites).toHaveLength(1);
    const plan = prepared.review!.sites[0]!;
    expect(plan.domain).toBe("panel.example.com");
    expect(plan.zone).toMatchObject({ name: "example.com", status: "active", nameServers: ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"] });
    expect(plan.changes.map((c) => c.subject).sort()).toEqual(["A panel.example.com", "AAAA panel.example.com"]);
    expect(env.cf.writes()).toEqual([]);

    const confirmed = await env.act("confirm", { token: prepared.review!.token });
    expect(confirmed.automatic).toBe(false);
    expect(confirmed.panelHost).toMatchObject({ name: "panel.example.com", problem: null, proxied: false });
    expect(confirmed.panelHost!.plan!.zone).toMatchObject({ name: "example.com", status: "active", nameServers: ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"] });
    expect(confirmed.panelHost!.plan!.problems).toEqual([]);
    expect(confirmed.panelHost!.plan!.changes).toEqual([]);
    // Only panel.example.com records (unproxied) were written; shop.example.com and whole-zone ssl/alwaysHttps were untouched.
    expect(env.records()).toEqual(["A panel.example.com 203.0.113.10", "AAAA panel.example.com 2001:db8::10"]);
    const zone = env.cf.zones[0]!;
    expect(env.cf.settings.has(`${zone.id}:ssl`)).toBe(false);
    expect(env.cf.settings.has(`${zone.id}:always_use_https`)).toBe(false);
    expect(confirmed.sites.find((s) => s.domain === "shop.example.com")!.plan).not.toBeNull();
  });

  test("prepareOnly works in Automatic mode, forces unproxied records, and handles unobstructed unproxied wildcards", async () => {
    const env = setup();
    await env.automatic();
    // Even if CloudPanel already reports an issued certificate for the same name, prepareOnly plans unproxied records.
    env.custom.current = { name: "panel.example.com", issued: true };
    const prepared = await env.act("set-panel-host", { name: "panel.example.com", prepareOnly: true });
    expect(prepared.review).toBeDefined();
    expect(prepared.review!.sites).toHaveLength(1);
    const confirmed = await env.act("confirm", { token: prepared.review!.token });
    expect(confirmed.automatic).toBe(true);
    expect(env.records()).toEqual(["A panel.example.com 203.0.113.10", "AAAA panel.example.com 2001:db8::10"]);

    // An unobstructed unproxied wildcard covers a new panel hostname with no A/AAAA creates.
    env.cf.record("example.com", { type: "A", name: "*.example.com", content: "203.0.113.10", proxied: false });
    env.cf.record("example.com", { type: "AAAA", name: "*.example.com", content: "2001:db8::10", proxied: false });
    const wildPrepared = await env.act("set-panel-host", { name: "k7m2p9x4.example.com", prepareOnly: true });
    expect(wildPrepared.review!.blocked).toBe(false);
    expect(wildPrepared.review!.sites[0]!.wildcard).toBe("*.example.com");
    expect(wildPrepared.review!.sites[0]!.changes).toEqual([]);
    const wildConfirmed = await env.act("confirm", { token: wildPrepared.review!.token });
    expect(wildConfirmed.panelHost!.plan!.wildcard).toBe("*.example.com");
    expect(wildConfirmed.panelHost!.plan!.zone!.status).toBe("active");
    expect(env.records().filter((r) => r.includes("k7m2p9x4.example.com"))).toEqual([]);
  });

  test("prepareOnly returns pending zone status and nameservers when the zone is not active", async () => {
    const env = setup();
    env.cf.zones[0]!.status = "pending";
    await env.act("save-connection", { token: TOKEN });

    const prepared = await env.act("set-panel-host", { name: "panel.example.com", prepareOnly: true });
    expect(prepared.review!.sites[0]!.zone).toMatchObject({
      name: "example.com",
      status: "pending",
      nameServers: ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"],
    });
    const confirmed = await env.act("confirm", { token: prepared.review!.token });
    expect(confirmed.panelHost!.plan!.zone).toMatchObject({
      name: "example.com",
      status: "pending",
      nameServers: ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"],
    });
    expect(env.records()).toEqual(["A panel.example.com 203.0.113.10", "AAAA panel.example.com 2001:db8::10"]);
  });

  test("prepareOnly refuses an empty name and re-reviews when Cloudflare changes before confirmation", async () => {
    const env = setup();
    await env.act("save-connection", { token: TOKEN });
    await expect(env.act("set-panel-host", { name: "", prepareOnly: true })).rejects.toThrow("Enter the panel hostname");

    const prepared = await env.act("set-panel-host", { name: "panel.example.com", prepareOnly: true });
    // Drift in Cloudflare between preview and confirm triggers a fresh single-host review.
    env.cf.record("example.com", { type: "A", name: "panel.example.com", content: "198.51.100.9", proxied: false });
    const drift = await env.act("confirm", { token: prepared.review!.token });
    expect(drift.review).toBeDefined();
    expect(drift.notice).toContain("Cloudflare changed");
    expect(drift.review!.sites).toHaveLength(1);
    expect(drift.review!.sites[0]!.changes.some((c) => c.action === "update" && c.subject === "A panel.example.com")).toBe(true);
  });

  test("prepareOnly blocks when writing the panel hostname would remove another site's wildcard coverage", async () => {
    const env = setup();
    env.sites.push(
      { id: 10, domain: "shop.branch.example.com", type: "php", createdAt: START - 86_400_000, selfSigned: false, cloudflareOnly: false },
      { id: 11, domain: "ancestor.example.com", type: "php", createdAt: START - 86_400_000, selfSigned: false, cloudflareOnly: false },
    );
    await env.act("save-connection", { token: TOKEN });
    const list = await env.act("list");
    const webId = list.profiles.find((p) => p.name === "Web")!.id;
    // Publish a proxied wildcard that covers shop.branch.example.com and ancestor.example.com.
    env.cf.record("example.com", { type: "A", name: "*.example.com", content: "203.0.113.10", proxied: true });
    env.cf.record("example.com", { type: "AAAA", name: "*.example.com", content: "2001:db8::10", proxied: true });
    await env.act("assign", { domains: ["shop.branch.example.com", "ancestor.example.com"], profileId: webId });

    // 1. Ancestor blocking: preparing unproxied branch.example.com would shadow *.example.com for shop.branch.example.com.
    const blockedDesc = await env.act("set-panel-host", { name: "branch.example.com", prepareOnly: true });
    expect(blockedDesc.review!.blocked).toBe(true);
    expect(blockedDesc.review!.token).toBe("");
    expect(blockedDesc.review!.sites[0]!.problems.join("\n")).toContain("shop.branch.example.com");

    // 2. ENT blocking: preparing unproxied deep.ancestor.example.com would turn ancestor.example.com into an ENT.
    const blockedAnc = await env.act("set-panel-host", { name: "deep.ancestor.example.com", prepareOnly: true });
    expect(blockedAnc.review!.blocked).toBe(true);
    expect(blockedAnc.review!.token).toBe("");
    expect(blockedAnc.review!.sites[0]!.problems.join("\n")).toContain("ancestor.example.com");

    // 3. An unrelated hostname does not affect any site's wildcard coverage and succeeds.
    const ok = await env.act("set-panel-host", { name: "k7m2p9x4.example.com", prepareOnly: true });
    expect(ok.review!.blocked).toBe(false);
    expect(ok.review!.token).not.toBe("");
  });

  test("prepareOnly panel-host planning never calls Mailcow for dependent wildcard sites", async () => {
    const env = setup();
    env.sites.splice(0, env.sites.length, site(1, "example.com"), site(2, "mail-sub.a.example.com"));
    const zone = env.cf.zones[0]!;
    await env.act("save-connection", { token: TOKEN });
    await env.act("save-mailcow", { url: "https://mail.example.net", key: env.mailcow.apiKey });
    await env.act("assign", { domains: ["example.com"], httpProfileId: "web" });
    await env.act("assign", { domains: ["mail-sub.a.example.com"], httpProfileId: "web", mailProfileId: "mailcow" });
    await env.act("check");
    const mailCallsBefore = env.mailcow.calls.length;

    const prepared = await env.act("set-panel-host", { name: "a.example.com", prepareOnly: true });
    expect(prepared.review).toBeDefined();
    expect(env.mailcow.calls.length).toBe(mailCallsBefore);
    expect(zone.name).toBe("example.com");
  });

  test("blocks panel preparation when neither IPv4 nor IPv6 address will remain (existing and missing zones)", async () => {
    const env = setup();
    env.options.addresses = () => ({ ipv4: "", ipv6: "" });
    env.cf.record("example.com", { type: "A", name: "panel.example.com", content: "198.51.100.4", proxied: false });
    await env.act("save-connection", { token: TOKEN });

    // Existing zone with an existing address must block instead of offering to delete it or Continue empty.
    const existingBlocked = await env.act("set-panel-host", { name: "panel.example.com", prepareOnly: true });
    expect(existingBlocked.review!.blocked).toBe(true);
    expect(existingBlocked.review!.token).toBe("");
    expect(existingBlocked.review!.sites[0]!.problems.join(" ")).toContain("no IPv4 or IPv6 address");

    // Missing zone with zone creation enabled must also block when neither address is available.
    const missingBlocked = await env.act("set-panel-host", { name: "panel.brandnew.example", prepareOnly: true });
    expect(missingBlocked.review!.blocked).toBe(true);
    expect(missingBlocked.review!.token).toBe("");
    expect(missingBlocked.review!.sites[0]!.problems.join(" ")).toContain("no IPv4 or IPv6 address");
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

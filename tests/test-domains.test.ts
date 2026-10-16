import { afterEach, expect, setSystemTime, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeDomainsAction, type DomainsActionOptions, type DomainsPaths } from "../addons/domains/action";
import { PRESET_PROFILE, type PanelSite, type Policy, type Profile, type Reply, type Zone } from "../addons/domains/model";
import { Cloudflare, Mailcow, unquoteTxt } from "../addons/domains/providers";
import { desiredRecords, diffRecords } from "../addons/domains/records";
import { DomainsEngine, matchingZone } from "../addons/domains/reconcile";
import { FakeDomainsApis } from "./fixtures/domains-api";
import { ProviderHttp } from "../lib/provider-http";
import { readRootJson, writeRootJson } from "../lib/root-json";
import { autoSslRequests } from "../lib/auto-ssl";
import { retryCertificates } from "../addons/domains/ssl";
import { runNewSiteReconciliation } from "../cli/new-sites";
import { ADDONS, type AddonSpec } from "../cli/addon-catalog";
import { DOMAINS_ALLOWED_VERBS } from "../lib/gateway-protocol";
import { acquireFileLock } from "../cli/action-common";
import { handle } from "../addons/domains/app/index";
import { domainsService } from "../addons/domains/app/service";
import { CLIENT_JS, dashboardView, layout } from "../addons/domains/app/views";
import { BASE_CLIENT_JS } from "../lib/app-ui";
import { provisioningSites } from "../lib/panel-site-provisioning";
import { SELF_SIGNED, ZEROSSL } from "./fixtures/certificates";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const connection = { accountId: "a".repeat(32), cloudflareToken: "cf-test-token", mailcowUrl: "https://mail.example.net", mailcowKey: "mc-test-key" };
const site = (domain = "example.net", id = 1): PanelSite => ({ id, domain, type: "php", certificateReady: false, certificateNames: [], placeholder: true, cloudflareOnly: false });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "domains-test-")); dirs.push(dir);
  const paths: DomainsPaths = { stateDir: dir, panelDb: join(dir, "panel.db"), lockFile: join(dir, "action.lock"), configFile: join(dir, "enabled.conf"), autoSslFile: join(dir, "ssl.json"), autoSslLock: join(dir, "ssl.lock"), panelTweaksConfig: join(dir, "panel-tweaks.conf"), panelTweaksFile: join(dir, "tweaks.json"), clpctl: "clpctl", rootUid: process.getuid!() };
  writeFileSync(paths.configFile, "enabled");
  const apis = new FakeDomainsApis(); const zone = apis.zone();
  apis.mailboxes.set("relay@example.net", ["sender@other.example.org", "@legacy.example.org"]);
  let sites = [site()];
  const options: DomainsActionOptions = { paths, processUid: 0, fetch: apis.fetch, sites: () => sites, ips: () => ({ ipv4: "192.0.2.80", ipv6: "2001:db8::80" }), domainValidator: (v) => v };
  const profile: Profile = { ...structuredClone(PRESET_PROFILE), mailHost: "mail.example.net", webmailHost: "webmail.example.org", sharedMailbox: "relay@example.net" };
  const act = (verb: string, body?: unknown) => executeDomainsAction([verb], { ...options, input: JSON.stringify(body ?? {}) }) as Promise<Reply>;
  const setup = async () => { await act("save-connections", connection); await act("save-profile", profile); await act("assign", { domains: ["example.net"], profileId: profile.id }); };
  const enforce = async () => { const review = await act("save-profile", { ...profile, mode: "enforce" }); expect(review.review).toBeDefined(); return act("apply", { token: review.review!.token }); };
  return { dir, paths, options, apis, zone, profile, act, setup, enforce, setSites: (v: PanelSite[]) => { sites = v; } };
}

test("the preset uses proxied DNS, ACME and webmail Full rules, strict SSL, Report only and generic placeholders", () => {
  expect(PRESET_PROFILE).toMatchObject({ mode: "report", webProxied: true, proxyAfterCertificate: false, acmeRule: true, webmailRule: true, zoneSettings: true, createZones: false });
  expect(PRESET_PROFILE.templates.filter((t) => t.name.startsWith("www.")).every((t) => t.apexOnly)).toBe(true);
  expect(PRESET_PROFILE.mailHost).toBe("mail.example.com");
});

test("Report only plans without provider writes; Enforce requires a current confirmed plan and converges", async () => {
  const f = fixture(); await f.setup();
  const planned = await f.act("plan");
  expect(planned.sites[0]!.changes.some((c) => c.service === "mailcow")).toBe(true);
  expect(planned.sites[0]!.changes.filter((c) => c.service === "dns")).toHaveLength(11);
  expect(f.apis.writes()).toEqual([]);
  await f.act("reconcile"); expect(f.apis.writes()).toEqual([]);
  const review = await f.act("save-profile", { ...f.profile, mode: "enforce" });
  expect(f.apis.writes()).toEqual([]);
  await expect(f.act("apply", { token: "invented" })).rejects.toThrow("expired");
  const applied = await f.act("apply", { token: review.review!.token });
  expect(applied.sites[0]!.errors).toEqual([]);
  expect(applied.sites[0]!.changes).toEqual([]);
  expect(f.apis.records.get(f.zone.id)).toHaveLength(11);
  const firstProxy = f.apis.calls.findIndex((c) => c.path.endsWith("dns_records") && c.body?.proxied);
  expect(f.apis.calls.findIndex((c) => c.path.endsWith("rulesets") && c.body?.phase === "http_config_settings")).toBeLessThan(firstProxy);
  const writes = f.apis.writes().length; await f.act("reconcile"); expect(f.apis.writes().length).toBe(writes);
});

test("managed names adopt records, delete conflicting A/CNAME, merge duplicate SPF and preserve other TXT and names", async () => {
  const f = fixture(); await f.setup(); f.apis.mailDomains.add("example.net"); f.apis.key("example.net");
  const old = f.apis.record(f.zone, { name: "example.net", type: "A", content: "192.0.2.99", proxied: true, comment: "Operator note", tags: ["operator:keep"] });
  f.apis.record(f.zone, { name: "example.net", type: "A", content: "192.0.2.98" });
  f.apis.record(f.zone, { name: "www.example.net", type: "CNAME", content: "elsewhere.example.org" });
  f.apis.record(f.zone, { name: "example.net", type: "TXT", content: "v=spf1 include:old.example.org ~all" });
  const duplicate = f.apis.record(f.zone, { name: "example.net", type: "TXT", content: '"v=spf1 include:transactional.example.org " "~all"' });
  const verification = f.apis.record(f.zone, { name: "example.net", type: "TXT", content: "google-site-verification=keep" });
  const custom = f.apis.record(f.zone, { name: "dashboard.example.net", type: "A", content: "192.0.2.7", comment: "clp-addons:domains somebody else" });
  const applied = await f.enforce(); expect(applied.sites[0]!.errors).toEqual([]);
  const after = f.apis.records.get(f.zone.id)!;
  expect(after.find((r) => r.id === old.id)?.content).toBe("192.0.2.80");
  expect(after.find((r) => r.id === old.id)).toMatchObject({ comment: "Operator note", tags: ["operator:keep", "clp-addons:domains"] });
  const spf = after.filter((r) => r.type === "TXT" && unquoteTxt(r.content).startsWith("v=spf1"));
  expect(spf).toHaveLength(1);
  expect(unquoteTxt(spf[0]!.content)).toBe("v=spf1 include:old.example.org include:transactional.example.org ip4:192.0.2.25 ip6:2001:db8::25 ~all");
  const mergeWrite = f.apis.calls.findIndex((c) => c.method === "PATCH" && c.body?.type === "TXT" && c.body?.content.includes("include:transactional.example.org"));
  expect(mergeWrite).toBeGreaterThan(-1);
  expect(f.apis.calls.findIndex((c) => c.method === "DELETE" && c.path.endsWith(duplicate.id!))).toBeGreaterThan(mergeWrite);
  expect(after).toContainEqual(verification); expect(after).toContainEqual(custom);
  expect(after.filter((r) => r.name !== custom.name && r.id !== verification.id).every((r) => r.comment?.startsWith("clp-addons:domains") || r.tags?.includes("clp-addons:domains"))).toBe(true);
});

test("SPF planning and later drift repair retain dashboard senders and hardfail while ensuring required terms", async () => {
  const f = fixture(); f.profile.spfIncludes = ["_spf.profile.example.org"]; await f.setup();
  const original = f.apis.record(f.zone, { name: "example.net", type: "TXT", content: "v=spf1 include:existing.example.org -all" });
  const planned = await f.act("plan");
  expect(planned.sites[0]!.changes.find((c) => c.before?.id === original.id)?.after?.content).toBe("v=spf1 include:existing.example.org include:_spf.profile.example.org ip4:192.0.2.25 ip6:2001:db8::25 -all");
  expect(f.apis.writes()).toEqual([]);
  await f.enforce();
  const record = f.apis.records.get(f.zone.id)!.find((r) => r.id === original.id)!;
  record.content = "v=spf1 include:existing.example.org include:dashboard.example.org -all";
  const repaired = await f.act("reconcile");
  expect(repaired.sites[0]!.changes).toEqual([]);
  const after = unquoteTxt(f.apis.records.get(f.zone.id)!.find((r) => r.id === original.id)!.content);
  expect(after).toBe("v=spf1 include:existing.example.org include:dashboard.example.org include:_spf.profile.example.org ip4:192.0.2.25 ip6:2001:db8::25 -all");
  const writes = f.apis.writes().length; await f.act("reconcile"); expect(f.apis.writes()).toHaveLength(writes);
});

test("ambiguous SPF blocks enforcement and preserves every record without provider writes", async () => {
  const f = fixture(); await f.setup();
  f.apis.record(f.zone, { name: "example.net", type: "TXT", content: "v=spf1 include:first.example.org -all" });
  f.apis.record(f.zone, { name: "example.net", type: "TXT", content: "v=spf1 include:second.example.org ~all" });
  const before = structuredClone(f.apis.records.get(f.zone.id));
  const planned = await f.act("plan");
  expect(planned.sites[0]!.errors.join()).toContain("conflicting ending policies");
  const review = await f.act("save-profile", { ...f.profile, mode: "enforce" });
  expect(review.review?.blocked).toBe(true);
  expect(f.apis.records.get(f.zone.id)).toEqual(before); expect(f.apis.writes()).toEqual([]);
});

test("enforcement merges SPF from its fresh DNS read, including senders added after planning", async () => {
  const f = fixture(); await f.setup();
  const policy: Policy = { version: 1, profiles: [{ ...f.profile, mode: "enforce" }], defaultProfileId: null, assignments: { "example.net": f.profile.id }, knownSiteIds: [1] };
  const engine = new DomainsEngine({ connections: connection, ips: f.options.ips!(), fetch: f.apis.fetch });
  const plan = await engine.scan(policy, [site()]);
  f.apis.record(f.zone, { name: "example.net", type: "TXT", content: "v=spf1 include:concurrent.example.org -all" });
  const result = await engine.enforce(policy, [site()], plan);
  expect(result.sites[0]!.errors).toEqual([]); expect(result.sites[0]!.changes).toEqual([]);
  const spf = f.apis.records.get(f.zone.id)!.filter((r) => r.type === "TXT" && unquoteTxt(r.content).startsWith("v=spf1"));
  expect(spf).toHaveLength(1);
  expect(unquoteTxt(spf[0]!.content)).toBe("v=spf1 include:concurrent.example.org ip4:192.0.2.25 ip6:2001:db8::25 -all");
});

test("SPF merges are isolated to each template name and leave other TXT alone", () => {
  const p = { ...structuredClone(PRESET_PROFILE), templates: [{ type: "TXT" as const, name: "{domain}", content: "{spf}" }, { type: "TXT" as const, name: "bounce.{domain}", content: "{spf}" }] };
  const s = site(), z: Zone = { id: "f".repeat(32), name: s.domain, status: "active", nameServers: [] };
  const current = [{ type: "TXT", name: s.domain, content: "v=spf1 include:apex.example.org -all", ttl: 1 },
    { type: "TXT", name: `bounce.${s.domain}`, content: "v=spf1 redirect=bounce-policy.example.org", ttl: 1 },
    { type: "TXT", name: s.domain, content: "google-site-verification=keep", ttl: 1 }];
  const desired = desiredRecords(p, s, z, { ipv4: "192.0.2.80", ipv6: "" }, null, current);
  expect(desired.records[0]!.content).toBe("v=spf1 include:apex.example.org ip4:192.0.2.25 ip6:2001:db8::25 -all");
  expect(desired.records[1]!.content).toBe("v=spf1 ip4:192.0.2.25 ip6:2001:db8::25 redirect=bounce-policy.example.org");
  expect(diffRecords(current, desired).some((c) => c.before?.content === "google-site-verification=keep")).toBe(false);
});

test("an explicit advanced SPF template preserves macros and verification TXT while enforcing its reviewed value", () => {
  const p = { ...structuredClone(PRESET_PROFILE), templates: [{ type: "TXT" as const, name: "{domain}", content: "v=spf1 -exists:%{i}.blocked.example.org ip4:{mail.ipv4} -all" }] };
  const s = site(), z: Zone = { id: "f".repeat(32), name: s.domain, status: "active", nameServers: [] };
  const current = [{ type: "TXT", name: s.domain, content: "v=spf1 include:obsolete.example.org ~all", ttl: 1 },
    { type: "TXT", name: s.domain, content: "google-site-verification=keep", ttl: 1 }];
  const desired = desiredRecords(p, s, z, { ipv4: "192.0.2.80", ipv6: "" }, null, current);
  expect(desired.records[0]!.content).toBe("v=spf1 -exists:%{i}.blocked.example.org ip4:192.0.2.25 -all");
  const changes = diffRecords(current, desired);
  expect(changes).toHaveLength(1);
  expect(changes[0]!.detail).toBe("Correct TXT drift");
  expect(changes[0]!.before?.content).toBe("v=spf1 include:obsolete.example.org ~all");
});

test("failed SPF consolidation never deletes a duplicate's senders", async () => {
  const f = fixture(); await f.setup();
  const first = f.apis.record(f.zone, { name: "example.net", type: "TXT", content: "v=spf1 include:first.example.org ~all" });
  const second = f.apis.record(f.zone, { name: "example.net", type: "TXT", content: "v=spf1 include:second.example.org ~all" });
  f.apis.intercept = (url, init) => init.method === "PATCH" && url.pathname.endsWith(`/dns_records/${first.id}`) ? Response.json({ success: false, errors: [{ code: 1000, message: "Update failed" }], result: null }) : undefined;
  const result = await f.enforce();
  expect(result.sites[0]!.errors.length).toBeGreaterThan(0);
  expect(f.apis.records.get(f.zone.id)).toContainEqual(first);
  expect(f.apis.records.get(f.zone.id)).toContainEqual(second);
  expect(f.apis.calls.some((c) => c.method === "DELETE" && c.path.endsWith(`/dns_records/${second.id}`))).toBe(false);
});

test("longest account zone wins and subdomain sites get neither www nor apex-only webmail", async () => {
  const f = fixture(); const nested = f.apis.zone("sub.example.net"), other = f.apis.zone("example.org");
  f.setSites([site("join.sub.example.net"), site("example.org", 2)]);
  await f.act("save-connections", connection); await f.act("save-profile", { ...f.profile, spfByDomain: { "join.sub.example.net": ["_spf.provider.example.org"] } });
  await f.act("assign", { domains: ["join.sub.example.net", "example.org"], profileId: f.profile.id });
  const p = await f.act("plan");
  expect(p.sites[0]!.zone!.id).toBe(nested.id); expect(p.sites[1]!.zone!.id).toBe(other.id);
  expect(p.sites[0]!.changes.some((c) => c.after?.name === "www.join.sub.example.net")).toBe(false);
  expect(p.sites[0]!.changes.some((c) => c.after?.content.includes("include:_spf.provider.example.org"))).toBe(true);
  expect(matchingZone("notexample.net", [f.zone])).toBeNull();
});

test("DKIM comes from Mailcow's actual key and selector; ACL additions preserve all existing and concurrent grants", async () => {
  const f = fixture(); await f.setup(); f.apis.mailDomains.add("example.net"); f.apis.key("example.net", "mail-selector");
  f.apis.record(f.zone, { name: "mail-selector._domainkey.example.net", type: "TXT", content: "v=DKIM1;p=stale" });
  const r = await f.act("save-profile", { ...f.profile, mode: "enforce" });
  f.apis.mailboxes.get("relay@example.net")!.push("@concurrent.example.org");
  await f.act("apply", { token: r.review!.token });
  const published = f.apis.records.get(f.zone.id)!.find((r) => r.name === "mail-selector._domainkey.example.net")!.content;
  expect(published).toContain('" "');
  expect(unquoteTxt(published)).toBe(f.apis.dkim.get("example.net")!.dkim_txt);
  expect(f.apis.mailboxes.get("relay@example.net")).toEqual(["sender@other.example.org", "@legacy.example.org", "@concurrent.example.org", "@example.net"]);
  expect(f.apis.calls.some((c) => c.path.endsWith("/add/dkim"))).toBe(false);
  const returned = JSON.stringify(await f.act("list"));
  expect(returned).not.toContain("PRIVATE-DKIM"); expect(returned).not.toContain(connection.cloudflareToken); expect(returned).not.toContain(connection.mailcowKey);
});

test("missing DKIM duplicates a selected source and reads the key back before publishing", async () => {
  const f = fixture(); f.profile.dkimSource = "source.example.org"; f.apis.key(f.profile.dkimSource, "shared"); await f.setup();
  const preview = await f.act("plan");
  expect(preview.sites[0]!.changes.some((c) => c.after?.name === "shared._domainkey.example.net")).toBe(true);
  const result = await f.enforce(); expect(result.sites[0]!.errors).toEqual([]);
  expect(f.apis.dkim.get("example.net")!.pubkey).toBe(f.apis.dkim.get(f.profile.dkimSource)!.pubkey);
  expect(f.apis.records.get(f.zone.id)!.some((r) => r.name === "shared._domainkey.example.net")).toBe(true);
});

test("proxy-after-certificate remains an alternative and refuses to proxy an uncovered www; DNS-only warns for Cloudflare-only", async () => {
  const f = fixture(); f.profile.proxyAfterCertificate = true; f.profile.acmeRule = false; f.profile.mailEnabled = false; await f.setup();
  await f.enforce();
  expect(f.apis.records.get(f.zone.id)!.every((r) => !r.proxied)).toBe(true);
  f.setSites([{ ...site(), certificateReady: true, certificateNames: ["example.net"], placeholder: false }]);
  await f.act("reconcile");
  expect(f.apis.records.get(f.zone.id)!.filter((r) => r.name === "example.net").every((r) => r.proxied)).toBe(true);
  expect(f.apis.records.get(f.zone.id)!.filter((r) => r.name.startsWith("www")).every((r) => !r.proxied)).toBe(true);
  f.setSites([{ ...site(), cloudflareOnly: true }]); f.profile.webProxied = false;
  const result = await f.act("save-profile", f.profile); expect(result.review).toBeUndefined();
  const planned = await f.act("plan"); expect(planned.sites[0]!.unproxiedWeb && planned.sites[0]!.cloudflareOnly).toBe(true);
});

test("new-site defaults never assign an existing fleet; provision uses the default and reports pending nameservers", async () => {
  const f = fixture(); await f.setup(); await f.enforce();
  await f.act("set-default", { profileId: f.profile.id });
  const existing = site("existing.example.net", 2); f.setSites([site(), existing]);
  await f.act("set-default", { profileId: f.profile.id });
  const created = site("new.example.net", 3); f.setSites([site(), existing, created]);
  const r = await executeDomainsAction(["provision", "--domain=new.example.net"], f.options);
  expect(r).toMatchObject({ ready: true });
  expect((await f.act("list")).sites.find((s) => s.domain === existing.domain)!.profileId).toBeNull();
  f.zone.status = "pending";
  expect(await executeDomainsAction(["provision", "--domain=new.example.net"], f.options)).toMatchObject({ ready: false, reason: expect.stringContaining("nameservers") });
});

test("zone creation is opt-in, returns nameservers and never touches an account's other zones", async () => {
  const f = fixture(); f.apis.zones = []; f.profile.createZones = true; await f.setup();
  const result = await f.enforce();
  expect(result.sites[0]!.zone).toMatchObject({ name: "example.net", status: "pending", nameServers: f.zone.nameServers });
  expect(result.sites[0]!.changes).toEqual([]);
  expect(f.apis.zones).toHaveLength(1);
});

test("dashboard drift invalidates a reviewed plan, while Report only, switches, disable and deletion never remove records", async () => {
  const f = fixture(); await f.setup();
  const r = await f.act("save-profile", { ...f.profile, mode: "enforce" });
  f.apis.record(f.zone, { name: "example.net", type: "A", content: "192.0.2.9" });
  await expect(f.act("apply", { token: r.review!.token })).rejects.toThrow("Provider state changed");
  expect(f.apis.writes()).toEqual([]);
  await f.enforce(); const records = structuredClone(f.apis.records.get(f.zone.id));
  await f.act("save-profile", f.profile); await f.act("delete-profile", { id: f.profile.id });
  expect(f.apis.records.get(f.zone.id)).toEqual(records);
  rmSync(f.paths.configFile); await expect(f.act("reconcile")).rejects.toThrow("disabled");
  expect(f.apis.records.get(f.zone.id)).toEqual(records);
});

test("deleted sites become orphans, with confirmed removal limited to tracked, unchanged DNS and never Mailcow", async () => {
  const f = fixture(); await f.setup(); await f.enforce(); f.setSites([]); await f.act("reconcile");
  const orphan = (await f.act("list")).orphans[0]!; expect(orphan.records).toHaveLength(11);
  const custom = f.apis.record(f.zone, { type: "TXT", name: "custom.example.net", content: "keep" });
  const review = await f.act("remove-records", { domain: orphan.domain, zoneId: orphan.zoneId });
  expect(f.apis.records.get(f.zone.id)!.length).toBe(12);
  await f.act("apply", { token: review.review!.token });
  expect(f.apis.records.get(f.zone.id)).toEqual([custom]); expect(f.apis.mailDomains.has("example.net")).toBe(true);
});

test("pagination uses all zones and records; duplicates and incomplete inventories fail closed", async () => {
  const f = fixture(); for (let n = 0; n < 50; n++) f.apis.zone(`zone${n}.example.org`);
  for (let n = 0; n < 101; n++) f.apis.record(f.zone, { name: `custom${n}.example.net`, type: "TXT", content: "keep" });
  const cf = new Cloudflare(connection, f.apis.fetch);
  expect(await cf.zones()).toHaveLength(51); expect(await cf.records(f.zone.id)).toHaveLength(101);
  f.apis.records.get(f.zone.id)![100]!.id = f.apis.records.get(f.zone.id)![0]!.id;
  await expect(cf.records(f.zone.id)).rejects.toThrow("duplicate");
});

test("rate limits, API error envelopes, oversized streams, invalid JSON and redirects never leak secret-bearing responses", async () => {
  let count = 0;
  const http = new ProviderHttp("Test", "https://example.net", { authorization: "secret" }, async () => { count++; return new Response("secret", { status: 429, headers: { "Retry-After": "120" } }); });
  await expect(http.request("/x")).rejects.toThrow("rate limited"); await expect(http.request("/x")).rejects.toThrow("rate limited"); expect(count).toBe(1);
  const responses = [new Response("not json"), new Response("secret", { status: 401 }), new Response('"' + "x".repeat(2 * 1024 * 1024) + '"')];
  for (const response of responses) await expect(new ProviderHttp("Test", "https://example.net", {}, async () => response).request("/x")).rejects.toThrow(/Test:/);
  const bad = new Cloudflare(connection, async () => Response.json({ success: false, errors: [{ code: 9109, message: connection.cloudflareToken }] }));
  await expect(bad.zones()).rejects.toThrow("codes: 9109");
  const f = fixture(); await f.setup(); f.apis.intercept = (url) => url.host === "mail.example.net" ? Response.json([{ type: "danger", msg: [connection.mailcowKey], log: [connection.mailcowKey] }]) : undefined;
  const state = await f.act("plan"); expect(state.sites[0]!.errors.join()).not.toContain(connection.mailcowKey); expect(f.apis.writes()).toEqual([]);
});

test("secrets are root-only, blank saves preserve them only for the same endpoint, and unsafe state files are refused", async () => {
  const f = fixture(); await f.setup(); const file = join(f.dir, "credentials.json");
  expect(statSync(file).mode & 0o777).toBe(0o600);
  await f.act("save-connections", { ...connection, cloudflareToken: "", mailcowKey: "" });
  expect(JSON.parse(readFileSync(file, "utf8")).cloudflareToken).toBe(connection.cloudflareToken);
  await f.act("save-connections", { ...connection, accountId: "b".repeat(32), cloudflareToken: "", mailcowKey: "" });
  expect(JSON.parse(readFileSync(file, "utf8")).cloudflareToken).toBe("");
  chmodSync(file, 0o644); await expect(f.act("list")).rejects.toThrow("0600");
  chmodSync(file, 0o600); const saved = readFileSync(file); rmSync(file); writeFileSync(join(f.dir, "target"), saved, { mode: 0o600 }); symlinkSync(join(f.dir, "target"), file);
  await expect(f.act("list")).rejects.toThrow("regular file");
});

test("provision checks panel ownership root-side and accepts no profile or secret overrides", async () => {
  const f = fixture(); await f.setup(); await f.enforce();
  const db = new Database(f.paths.panelDb); db.exec("CREATE TABLE user (id INTEGER,user_name TEXT,role TEXT,status INTEGER); CREATE TABLE site (id INTEGER,domain_name TEXT); CREATE TABLE user_sites (user_id INTEGER,site_id INTEGER); INSERT INTO user VALUES (1,'alice','ROLE_USER',1),(2,'bob','ROLE_USER',1); INSERT INTO site VALUES (1,'example.net'); INSERT INTO user_sites VALUES (1,1)");
  await expect(executeDomainsAction(["provision", "--domain=example.net", "--as-user=bob"], f.options)).rejects.toThrow("not yours");
  expect(await executeDomainsAction(["provision", "--domain=example.net", "--as-user=alice"], f.options)).toEqual({ ready: true, reason: "DNS and mail are ready", certificateDomains: ["example.net", "www.example.net"] });
  await expect(executeDomainsAction(["provision", "--domain=example.net", "--profile=other"], f.options)).rejects.toThrow("Unexpected"); db.close();
});

test("SSL retries are bound to creation intent and site id, wait for active DNS, stop at five, and skip real certificates", async () => {
  const f = fixture(); await f.setup(); await f.enforce();
  const policy = readRootJson<any>(join(f.dir, "policy.json"), () => null, f.paths.rootUid);
  const engine = new DomainsEngine({ connections: connection, ips: f.options.ips!(), fetch: f.apis.fetch });
  let plan = await engine.scan(policy, [site()]);
  writeRootJson(f.paths.autoSslFile, { "example.net": { siteId: 1, requestedAt: 0, attempts: 0, state: "waiting", nextAttemptAt: 0 } }, f.paths.rootUid);
  const commands: string[][] = [];
  let current = [site()];
  const options = { file: f.paths.autoSslFile, lock: f.paths.autoSslLock, uid: f.paths.rootUid, clpctl: "clpctl", enabled: () => true, sites: () => current, now: () => 1_800_000_000_000, run: async (_: string, args: string[]) => { commands.push(args); return false; } };
  f.zone.status = "pending"; plan = await engine.scan(policy, [site()]); await retryCertificates(plan, options); expect(commands).toEqual([]);
  f.zone.status = "active"; plan = await engine.scan(policy, [site()]);
  for (let n = 0; n < 7; n++) await retryCertificates(plan, { ...options, now: () => 1_800_000_000_000 + n * 3 * 86_400_000 });
  expect(commands).toHaveLength(5); expect(commands[0]).toEqual(["lets-encrypt:install:certificate", "--domainName=example.net", "--subjectAlternativeName="]);
  expect(autoSslRequests(f.paths.autoSslFile, f.paths.rootUid)["example.net"]!.state).toContain("limit");
  current = [{ ...site(), placeholder: false, certificateReady: true }]; await retryCertificates(plan, options); expect(commands).toHaveLength(5);
});

test("the shared new-site trigger runs Domains first, isolates failures and keeps internal reconcilers off the gateway", async () => {
  expect([ADDONS.domains, ADDONS["cloudflare-ips"], ADDONS.smtp].every((s) => s?.newSites)).toBe(true);
  const order: string[] = [];
  const specs = ["domains", "smtp"].map((name) => ({ name, newSites: { label: name, run: async () => { order.push(name); if (name === "domains") throw new Error("test failure"); return null; } } }) as AddonSpec);
  await runNewSiteReconciliation(specs); expect(order).toEqual(["domains", "smtp"]);
  expect(DOMAINS_ALLOWED_VERBS.has("reconcile")).toBe(false); expect(DOMAINS_ALLOWED_VERBS.has("sync-sites")).toBe(false);
});

test("the pure diff preserves non-SPF TXT and handles quoted TXT chunks and an absent IPv6 without stale AAAA", () => {
  const p = { ...structuredClone(PRESET_PROFILE), mailEnabled: false };
  const s = site(), z: Zone = { id: "f".repeat(32), name: s.domain, status: "active", nameServers: [] };
  const desired = desiredRecords(p, s, z, { ipv4: "192.0.2.80", ipv6: "" }, null);
  const diff = diffRecords([{ id: "1".repeat(32), name: s.domain, type: "AAAA", content: "2001:db8::9", ttl: 1 }], desired);
  expect(diff.some((c) => c.action === "delete" && c.before!.type === "AAAA")).toBe(true);
});

test("an enforcing profile corrects later drift while Report only leaves the same drift untouched", async () => {
  const f = fixture(); await f.setup(); await f.enforce();
  const r = f.apis.records.get(f.zone.id)!.find((r) => r.type === "A" && r.name === "example.net")!;
  r.content = "192.0.2.9";
  const before = f.apis.writes().length;
  const repaired = await f.act("reconcile"); expect(repaired.sites[0]!.changes).toEqual([]);
  expect(f.apis.writes().length).toBeGreaterThan(before);
  await f.act("save-profile", f.profile);
  f.apis.records.get(f.zone.id)!.find((r) => r.type === "A" && r.name === "example.net")!.content = "192.0.2.9";
  const writes = f.apis.writes().length; const report = await f.act("reconcile");
  expect(report.sites[0]!.changes.some((c) => c.conflict)).toBe(true); expect(f.apis.writes().length).toBe(writes);
});

test("Cloudflare rules preserve unrelated entries and MainWP IPs are profile values in a scoped skip", async () => {
  const f = fixture(); f.profile.mainwpIps = ["192.0.2.30", "2001:db8::30"]; await f.setup();
  const unrelated = { id: f.apis.id(), ref: "operator_rule", action: "set_config", expression: 'http.host eq "custom.example.net"', enabled: true, action_parameters: { ssl: "strict" } };
  f.apis.rules.set(`${f.zone.id}:http_config_settings`, { id: f.apis.id(), rules: [unrelated] });
  await f.enforce();
  expect(f.apis.rules.get(`${f.zone.id}:http_config_settings`)!.rules).toContainEqual(unrelated);
  const skip = f.apis.rules.get(`${f.zone.id}:http_request_firewall_custom`)!.rules[0]!;
  expect(skip.action_parameters).toEqual({ phases: ["http_request_sbfm", "http_request_firewall_managed"] });
  expect(skip.expression).toContain("192.0.2.30 2001:db8::30"); expect(skip.expression).toContain("example.net");
});

test("failed security rules stop proxy writes, and unknown ACL or DKIM shapes fail closed", async () => {
  const f = fixture(); await f.setup();
  const review = await f.act("save-profile", { ...f.profile, mode: "enforce" });
  f.apis.intercept = (url, init) => init.method === "POST" && url.pathname.endsWith("/rulesets") ? Response.json({ success: false, errors: [{ code: 10000, message: connection.cloudflareToken }] }) : undefined;
  const applied = await f.act("apply", { token: review.review!.token });
  expect(applied.sites[0]!.errors.length).toBeGreaterThan(0);
  expect(f.apis.records.get(f.zone.id)).toEqual([]);
  const mc = new Mailcow(connection, async () => Response.json({ username: "relay@example.net", sender_acl: null }));
  await expect(mc.mailbox("relay@example.net")).rejects.toThrow("ACL");
  const badKey = new Mailcow(connection, async () => Response.json({ dkim_selector: "dkim", pubkey: "AAAA", dkim_txt: "v=DKIM1;p=BBBB", privkey: "secret" }));
  await expect(badKey.dkim("example.net")).rejects.toThrow("disagree");
});

test("shared-name profile conflicts and NS conflicts block adoption, and orphan drift blocks removal", async () => {
  const f = fixture(); await f.setup();
  f.apis.record(f.zone, { type: "NS", name: "autoconfig.example.net", content: "ns.example.org" });
  expect((await f.act("save-profile", { ...f.profile, mode: "enforce" })).review?.blocked).toBe(true); expect(f.apis.writes()).toEqual([]);
  f.apis.records.set(f.zone.id, []); await f.enforce();
  f.setSites([]); await f.act("reconcile");
  f.apis.records.get(f.zone.id)![0]!.content = "192.0.2.10";
  await expect(f.act("remove-records", { domain: "example.net", zoneId: f.zone.id })).rejects.toThrow("changed in the dashboard");
  const g = fixture(); g.setSites([site(), site("www.example.net", 2)]);
  await g.act("save-connections", connection); await g.act("save-profile", { ...g.profile, id: "other", serverIpv4: "192.0.2.11" });
  await g.act("save-profile", g.profile); await g.act("assign", { domains: ["example.net"], profileId: g.profile.id }); await g.act("assign", { domains: ["www.example.net"], profileId: "other" });
  expect((await g.act("plan")).sites.every((s) => s.errors.some((e) => e.includes("shared DNS name")))).toBe(true);
});

test("HTTP deadlines include body reads and 429 retry deadlines survive action restarts", async () => {
  const transport = new ProviderHttp("Test", "https://example.net", {}, async (_, init) => new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(new Error("secret")))), 0, 5);
  await expect(transport.request("/x")).rejects.toThrow("timed out");
  const f = fixture(); await f.setup();
  f.apis.intercept = (url) => url.pathname === "/client/v4/zones" ? new Response("secret", { status: 429, headers: { "Retry-After": "120" } }) : undefined;
  const r = await f.act("plan"); expect(r.retryAt).toBeGreaterThan(Date.now());
  const calls = f.apis.calls.length; await f.act("plan"); expect(f.apis.calls.length).toBe(calls);
  await f.act("save-connections", { ...connection, mailcowUrl: connection.mailcowUrl + "/", cloudflareToken: "", mailcowKey: "" });
  const saved = readRootJson<any>(join(f.dir, "credentials.json"), () => null, f.paths.rootUid);
  expect(saved.mailcowKey).toBe(connection.mailcowKey); expect((await f.act("list")).retryAt).toBe(0);
});

test("every browser change checks CSRF, provisioning ignores body identity, and mutations return freshly rendered state", async () => {
  const paths = ["connections", "profiles", "profiles/delete", "assign", "default", "plan", "apply", "remove", "provision", "ssl/retry"];
  for (const path of paths) {
    const response = await handle(new Request(`https://panel.example:8443/addons/domains/api/${path}`, { method: "POST", body: "{}", headers: { host: "panel.example:8443", origin: "https://panel.example:8443" } }), `/api/${path}`);
    expect(response.status).toBe(403);
  }
  const original = domainsService.provision;
  let asUser: string | undefined;
  domainsService.provision = async (_domain, user) => { asUser = user; return { ok: true, data: { ready: false, reason: "pending nameservers" } }; };
  try {
    const request = new Request("https://panel.example:8443/addons/domains/api/provision", { method: "POST", body: JSON.stringify({ domain: "example.net", asUser: "admin", profileId: "override" }), headers: { host: "panel.example:8443", origin: "https://panel.example:8443", cookie: "clp_addons_csrf=token", "x-clp-addons-csrf": "token" } });
    expect(await (await handle(request, "/api/provision", null, null, { user: "alice", roles: ["ROLE_USER"] })).json()).toEqual({ ok: true, data: { ready: false, reason: "pending nameservers" } });
    expect(asUser).toBe("alice");
  } finally { domainsService.provision = original; }
  const f = fixture(); await f.setup(); const state = await f.act("plan");
  state.profiles[0]!.name = '<script>alert("x")</script>';
  const html = layout("DNS", dashboardView(state));
  expect(html).toContain("&lt;script&gt;alert"); expect(html).not.toContain(state.profiles[0]!.name);
  expect(() => new Function(BASE_CLIENT_JS + CLIENT_JS)).not.toThrow();
  const old = domainsService.change;
  domainsService.change = async () => ({ ok: true, data: state });
  try {
    const req = new Request("https://panel.example:8443/addons/domains/api/assign", { method: "POST", body: "{}", headers: { host: "panel.example:8443", origin: "https://panel.example:8443", cookie: "clp_addons_csrf=t", "x-clp-addons-csrf": "t" } });
    const reply = await (await handle(req, "/api/assign")).json() as { html: string };
    expect(reply.html).toContain("&lt;script&gt;alert");
  } finally { domainsService.change = old; }
});

test("cached fleet reads stay available while provider work holds the action lock", async () => {
  const f = fixture(); await f.setup();
  const lock = await acquireFileLock(f.paths.lockFile, 1, "busy");
  try { expect((await f.act("list")).profiles).toHaveLength(1); } finally { lock.release(); }
});

test("certificate gating reads the installed PEM and type, rejecting placeholders, invalid PEM and wrong hostnames", () => {
  const f = fixture(), db = new Database(f.paths.panelDb);
  db.exec("CREATE TABLE site (id INTEGER, domain_name TEXT, type TEXT, certificate_id INTEGER); CREATE TABLE certificate (id INTEGER, type INTEGER, certificate TEXT, expires_at TEXT)");
  db.query("INSERT INTO certificate VALUES (?, ?, ?, ?)").run(1,1,SELF_SIGNED,"2036-01-01");
  db.query("INSERT INTO certificate VALUES (?, ?, ?, ?)").run(2,2,ZEROSSL,"2027-01-01");
  db.query("INSERT INTO certificate VALUES (?, ?, ?, ?)").run(3,3,"invalid PEM","2040-01-01");
  db.exec("INSERT INTO site VALUES (1,'placeholder.example.com','php',1),(2,'wrong.example.com','php',2),(3,'shop.example.com','php',2),(4,'legacy.example.com','php',3)"); db.close();
  setSystemTime(new Date("2026-10-16T12:00:00Z"));
  try {
    const sites = provisioningSites(f.paths.panelDb);
    expect(sites.find((s) => s.domain === "placeholder.example.com")).toMatchObject({ placeholder: true, certificateReady: false });
    expect(sites.find((s) => s.domain === "wrong.example.com")!.certificateReady).toBe(false);
    expect(sites.find((s) => s.domain === "legacy.example.com")).toMatchObject({ placeholder: false, certificateReady: false });
    expect(sites.find((s) => s.domain === "shop.example.com")).toMatchObject({ placeholder: false, certificateReady: true, certificateNames: ["shop.example.com"] });
  } finally { setSystemTime(); }
});

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAccess } from "../lib/cloudflare/access";
import { cloudflareAccessDetailsHtml } from "../lib/cloudflare/connect-dialog";
import {
  checkCloudflareConnections, cloudflareConnectionViews, cloudflareTokenHolds, hasSharedCloudflareStore,
  legacyDnsCloudflarePending, listCloudflareSecrets, MAX_CLOUDFLARE_CONNECTIONS, migrateCloudflareFromDns,
  readCloudflareStore, readFirewallEdgeDefaults, recordCloudflareReports, removeCloudflareConnection,
  saveCloudflareConnection, type CloudflareStorePaths,
} from "../lib/cloudflare/store";
import { DEFAULT_EDGE_DEFAULTS, EMPTY_EDGE_DEFAULTS } from "../lib/cloudflare/edge";
import { tokenTemplate, tokenTemplates } from "../lib/cloudflare/tokens";
import { FakeCloudflare, policy } from "./fixtures/dns-api";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const uid = process.getuid!();
const USER_TOKEN = "cf-user-token-0123456789abcdef";
const SECOND_TOKEN = "cf-second-token-0123456789abcd";

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "clp-cf-store-"));
  dirs.push(dir);
  const paths: CloudflareStorePaths = {
    stateDir: join(dir, "cloudflare"),
    lockFile: join(dir, "cloudflare.lock"),
    rootUid: uid,
  };
  const cf = new FakeCloudflare();
  const agency = cf.account("Agency");
  cf.zone("example.com", agency);
  cf.token(USER_TOKEN, { owner: "user", accounts: [agency] });
  cf.token(SECOND_TOKEN, { owner: "user", accounts: [agency] });
  return { dir, paths, cf, agency };
}

test("Firewall has zero imports from addons/dns", () => {
  const root = join(import.meta.dir, "..", "addons", "firewall");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|js)$/.test(entry.name)) files.push(full);
    }
  };
  walk(root);
  expect(files.length).toBeGreaterThan(0);
  const offenders = files.filter((file) => /from\s+["'][^"']*\/dns(?:\/|["'])|import\s+["'][^"']*\/dns(?:\/|["'])/.test(readFileSync(file, "utf8")));
  expect(offenders).toEqual([]);
});

test("shared Cloudflare store saves, verifies, lists without leaking tokens, renames, checks and removes", async () => {
  const { paths, cf } = makeStore();
  const saved = await saveCloudflareConnection({ token: USER_TOKEN, label: "Primary" }, { paths, fetch: cf.fetch });
  expect(saved.isNew).toBe(true);
  expect(saved.label).toBe("Primary");
  expect(saved.report.active).toBe(true);
  expect(saved.report.zones).toBe(1);

  const secretsFile = join(paths.stateDir, "secrets.json");
  expect(statSync(secretsFile).mode & 0o777).toBe(0o600);
  expect(listCloudflareSecrets(paths)).toEqual([{ id: saved.id, label: "Primary", token: USER_TOKEN }]);

  const view = cloudflareConnectionViews(DEFAULT_EDGE_DEFAULTS, { includeDns: false, includeEdge: true, requirePanelGate: true }, paths);
  expect(view.connections).toHaveLength(1);
  expect(view.connections[0]).toMatchObject({ id: saved.id, label: "Primary", active: true, hasToken: true, zones: 1 });
  expect(JSON.stringify(view)).not.toContain(USER_TOKEN);

  // Duplicate token is refused without overwriting.
  await expect(saveCloudflareConnection({ token: USER_TOKEN, label: "Copy" }, { paths, fetch: cf.fetch }))
    .rejects.toThrow("already saved as another connection");

  // Rename without passing token again keeps the saved token.
  const renamed = await saveCloudflareConnection({ id: saved.id, label: "Renamed" }, { paths, fetch: cf.fetch });
  expect(renamed.isNew).toBe(false);
  expect(renamed.label).toBe("Renamed");
  expect(listCloudflareSecrets(paths)[0]!.label).toBe("Renamed");

  // Check refreshes reports without losing labels.
  const reports = await checkCloudflareConnections({ paths, fetch: cf.fetch });
  expect(reports).toHaveLength(1);
  expect(reports[0]!.label).toBe("Renamed");

  // Remove deletes the token and metadata.
  const removed = await removeCloudflareConnection(saved.id, { paths });
  expect(removed.remaining).toBe(0);
  expect(listCloudflareSecrets(paths)).toEqual([]);
  expect(cloudflareConnectionViews(DEFAULT_EDGE_DEFAULTS, {}, paths).connections).toEqual([]);
});

test("rejected and rate-limited token saves redact the token and persist Cloudflare backoff", async () => {
  const { paths, cf } = makeStore();
  const badToken = "cf-secret-bad-token-1234567890";
  const err = await saveCloudflareConnection({ token: badToken }, { paths, fetch: cf.fetch }).catch((e: Error) => e);
  expect(err).toBeInstanceOf(Error);
  expect((err as Error).message).not.toContain(badToken);

  cf.limit = { after: 0, retryAfter: "600" };
  await expect(saveCloudflareConnection({ token: USER_TOKEN }, { paths, fetch: cf.fetch })).rejects.toThrow("asked to wait");
  const callsAfterFirst = cf.calls.length;
  await expect(saveCloudflareConnection({ token: USER_TOKEN }, { paths, fetch: cf.fetch })).rejects.toThrow("asked to wait");
  expect(cf.calls.length).toBe(callsAfterFirst);
  expect(readCloudflareStore(paths).backoffUntil).toBeGreaterThan(Date.now());
});

test("tokenTemplates separates DNS, Cloudflare edge, Panel gate, and combined scopes", () => {
  const templates = tokenTemplates(DEFAULT_EDGE_DEFAULTS);
  expect(templates.dns.permissions).toContain("DNS: Edit");
  expect(templates.dns.permissions).not.toContain("Zone Settings: Edit");
  expect(templates.dns.permissions).not.toContain("SSL and Certificates: Edit");
  expect(templates.dns.url).not.toContain("ssl_and_certificates");

  expect(templates.edge.permissions).toContain("Zone: Read");
  expect(templates.edge.permissions).toContain("Zone Settings: Edit");
  expect(templates.edge.permissions).toContain("Config Rules: Edit");
  expect(templates.edge.permissions).toContain("API Tokens: Read");
  expect(templates.edge.permissions).not.toContain("DNS: Edit");
  expect(templates.edge.permissions).not.toContain("SSL and Certificates: Edit");

  expect(templates.panelGate.permissions).toContain("SSL and Certificates: Edit");
  expect(templates.panelGate.permissions).toContain("Access: Apps and Policies: Edit");
  expect(templates.panelGate.permissions).toContain("API Tokens: Read");
  expect(templates.panelGate.permissions).not.toContain("DNS: Edit");
  expect(templates.panelGate.permissions).not.toContain("Zone: Edit");
  expect(templates.panelGate.url).toContain("ssl_and_certificates");
  expect(templates.panelGate.url).not.toContain("dns_records");

  expect(templates["dns+edge+panelGate"].permissions).toContain("DNS: Edit");
  expect(templates["dns+edge+panelGate"].permissions).toContain("Zone Settings: Edit");
  expect(templates["dns+edge+panelGate"].permissions).toContain("SSL and Certificates: Edit");
  expect(templates["dns+edge+panelGate"].permissions).toContain("API Tokens: Read");

  // Direct tokenTemplate with Panel gate required matches templates.panelGate.
  expect(tokenTemplate(DEFAULT_EDGE_DEFAULTS, { dns: false, edge: false, panelGate: true })).toEqual(templates.panelGate);
});

test("cloudflareTokenHolds answers from the stored read without network calls", async () => {
  const { paths, cf, agency } = makeStore();
  const zone = cf.zones.find((z) => z.name === "example.com")!;
  cf.token(USER_TOKEN, {
    owner: "user",
    accounts: [agency],
    policies: [policy(["DNS Write", "API Tokens Read"], { "com.cloudflare.api.account.zone.*": "*" })],
  });
  const saved = await saveCloudflareConnection({ token: USER_TOKEN }, { paths, fetch: cf.fetch });
  expect(cloudflareTokenHolds(saved.id, "dns", { id: zone.id, accountId: agency }, paths)).toBe(true);
  expect(cloudflareTokenHolds(saved.id, "originPulls", { id: zone.id, accountId: agency }, paths)).toBe(false);
  expect(cloudflareTokenHolds("cf-missing0", "dns", { id: zone.id, accountId: agency }, paths)).toBeNull();
});

test("migrateCloudflareFromDns moves connections, tokens and status while keeping Mailcow key, and rolls back cleanly", () => {
  const dir = mkdtempSync(join(tmpdir(), "clp-cf-mig-"));
  dirs.push(dir);
  const dnsDir = join(dir, "dns");
  const cfDir = join(dir, "cloudflare");
  mkdirSync(dnsDir, { recursive: true });
  const policyText = `${JSON.stringify({ version: 1, connections: [{ id: "cf-1111aaaa", label: "Agency" }], profiles: [] }, null, 2)}\n`;
  const secretsText = `${JSON.stringify({ cloudflare: { "cf-1111aaaa": USER_TOKEN }, mailcowKey: "mc-key-123" }, null, 2)}\n`;
  const statusText = `${JSON.stringify({
    connections: [{ id: "cf-1111aaaa", label: "Agency", active: true, status: "active", accounts: [], zones: 2, error: null }],
    backoff: { cloudflare: 12345, mailcow: 0 },
  }, null, 2)}\n`;
  writeFileSync(join(dnsDir, "policy.json"), policyText, { mode: 0o600 });
  writeFileSync(join(dnsDir, "secrets.json"), secretsText, { mode: 0o600 });
  writeFileSync(join(dnsDir, "status.json"), statusText, { mode: 0o600 });

  expect(legacyDnsCloudflarePending(dnsDir)).toBe(true);
  const undo = migrateCloudflareFromDns(dnsDir, { stateDir: cfDir, rootUid: uid });
  expect(undo).not.toBeNull();
  expect(legacyDnsCloudflarePending(dnsDir)).toBe(false);

  const migrated = readCloudflareStore({ stateDir: cfDir, rootUid: uid });
  expect(migrated.connections).toEqual([{ id: "cf-1111aaaa", label: "Agency" }]);
  expect(migrated.tokens).toEqual({ "cf-1111aaaa": USER_TOKEN });
  expect(migrated.reports).toHaveLength(1);
  expect(migrated.backoffUntil).toBe(12345);

  // DNS files keep Mailcow key and drop legacy Cloudflare copies and cached reports.
  expect(JSON.parse(readFileSync(join(dnsDir, "secrets.json"), "utf8"))).toEqual({ cloudflare: {}, mailcowKey: "mc-key-123" });
  expect(JSON.parse(readFileSync(join(dnsDir, "policy.json"), "utf8")).connections).toEqual([]);
  expect(JSON.parse(readFileSync(join(dnsDir, "status.json"), "utf8")).connections).toEqual([]);
  // Second run is a no-op.
  expect(migrateCloudflareFromDns(dnsDir, { stateDir: cfDir, rootUid: uid })).toBeNull();

  // Rollback restores exact prior files and cleans up new directory.
  undo!();
  expect(readFileSync(join(dnsDir, "policy.json"), "utf8")).toBe(policyText);
  expect(readFileSync(join(dnsDir, "secrets.json"), "utf8")).toBe(secretsText);
  expect(readFileSync(join(dnsDir, "status.json"), "utf8")).toBe(statusText);
  expect(existsSync(cfDir)).toBe(false);
});

test("combined tokenTemplate includes Zone Settings: Read when edge settings do not need zone_settings edit", () => {
  const withoutSettings = tokenTemplate(EMPTY_EDGE_DEFAULTS, { dns: true, edge: true, panelGate: true });
  expect(withoutSettings.permissions).toContain("Zone Settings: Read");
  expect(withoutSettings.url).toContain("zone_settings");

  const withSettingsEdit = tokenTemplate({ ...EMPTY_EDGE_DEFAULTS, ssl: "strict" }, { dns: true, edge: true, panelGate: true });
  expect(withSettingsEdit.permissions).toContain("Zone Settings: Edit");
  expect(withSettingsEdit.permissions).not.toContain("Zone Settings: Read");
});

test("reachOf ignores deny grants on unrelated permissions when computing fallback reach", () => {
  const reached = { zones: [{ id: "z1", name: "a.example", accountId: "a1" }, { id: "z2", name: "b.example", accountId: "a1" }], accounts: [{ id: "a1", name: "Agency" }] };
  const unrelatedDeny = readAccess({ owner: "user", accountId: null }, [
    { allow: true, permissions: ["Zone Read"], resources: [{ account: "*", zone: "*" }] },
    { allow: false, permissions: ["SSL and Certificates Write"], resources: [{ account: "*", zone: "z1" }] },
  ], reached);
  expect(unrelatedDeny.readable && unrelatedDeny.reach).toBe("All zones");

  const matchingDeny = readAccess({ owner: "user", accountId: null }, [
    { allow: true, permissions: ["Zone Read"], resources: [{ account: "*", zone: "*" }] },
    { allow: false, permissions: ["Zone Read"], resources: [{ account: "*", zone: "z1" }] },
  ], reached);
  expect(matchingDeny.readable && matchingDeny.reach).toBe("All zones, except 1 zone");
});

test("recordCloudflareReports drops a report checked with a superseded token and never leaks tokens", async () => {
  const { paths, cf, agency } = makeStore();
  const zone = cf.zones.find((z) => z.name === "example.com")!;
  cf.token(USER_TOKEN, {
    owner: "user",
    accounts: [agency],
    policies: [policy(["DNS Read", "API Tokens Read"], { "com.cloudflare.api.account.zone.*": "*" })],
  });
  cf.token(SECOND_TOKEN, {
    owner: "user",
    accounts: [agency],
    policies: [policy(["DNS Write", "API Tokens Read"], { "com.cloudflare.api.account.zone.*": "*" })],
  });
  const saved = await saveCloudflareConnection({ token: USER_TOKEN, label: "Primary" }, { paths, fetch: cf.fetch });
  const staleReport = { ...saved.report, status: "disabled", active: false, error: "Old token report" };
  // Replace token under the same id before the stale DNS report arrives.
  await saveCloudflareConnection({ id: saved.id, token: SECOND_TOKEN, label: "Primary" }, { paths, fetch: cf.fetch });
  await recordCloudflareReports([staleReport], 0, true, { [saved.id]: USER_TOKEN }, paths);

  expect(cloudflareTokenHolds(saved.id, "dns", { id: zone.id, accountId: agency }, paths)).toBe(true);
  const view = cloudflareConnectionViews(DEFAULT_EDGE_DEFAULTS, {}, paths);
  expect(view.connections[0]!.active).toBe(true);
  expect(JSON.stringify(view)).not.toContain(USER_TOKEN);
  expect(JSON.stringify(view)).not.toContain(SECOND_TOKEN);
});

test("saveCloudflareConnection rolls back secrets.json if writing connections.json fails so retries work", async () => {
  const { paths, cf } = makeStore();
  mkdirSync(paths.stateDir, { recursive: true });
  // Place a directory where connections.json should be so atomic rename over it fails with EISDIR.
  mkdirSync(join(paths.stateDir, "connections.json"));
  await expect(saveCloudflareConnection({ token: USER_TOKEN, label: "Primary" }, { paths, fetch: cf.fetch })).rejects.toThrow();
  expect(existsSync(join(paths.stateDir, "secrets.json"))).toBe(false);

  // Clean up the obstacle and confirm retrying the same token succeeds cleanly.
  rmSync(join(paths.stateDir, "connections.json"), { recursive: true, force: true });
  const saved = await saveCloudflareConnection({ token: USER_TOKEN, label: "Primary" }, { paths, fetch: cf.fetch });
  expect(saved.isNew).toBe(true);
  expect(listCloudflareSecrets(paths)).toHaveLength(1);
});

test("migrateCloudflareFromDns throws on unreadable/untrusted files and when merged connections exceed capacity", () => {
  const dir = mkdtempSync(join(tmpdir(), "clp-cf-mig-err-"));
  dirs.push(dir);
  const dnsDir = join(dir, "dns");
  const cfDir = join(dir, "cloudflare");
  mkdirSync(dnsDir, { recursive: true });
  const realFile = join(dir, "real.json");
  writeFileSync(realFile, JSON.stringify({ connections: [{ id: "cf-1111aaaa", label: "Link" }] }), { mode: 0o600 });
  symlinkSync(realFile, join(dnsDir, "policy.json"));
  expect(() => migrateCloudflareFromDns(dnsDir, { stateDir: cfDir, rootUid: uid })).toThrow("were not moved to shared state");

  // Exceeding MAX_CLOUDFLARE_CONNECTIONS fails before writing shared state or clearing legacy files.
  const dir2 = mkdtempSync(join(tmpdir(), "clp-cf-mig-cap-"));
  dirs.push(dir2);
  const dnsDir2 = join(dir2, "dns");
  const cfDir2 = join(dir2, "cloudflare");
  mkdirSync(dnsDir2, { recursive: true });
  mkdirSync(cfDir2, { recursive: true });
  const fullConns = Array.from({ length: MAX_CLOUDFLARE_CONNECTIONS }, (_, i) => ({ id: `cf-${String(i).padStart(8, "0")}`, label: `C${i}` }));
  const fullTokens = Object.fromEntries(fullConns.map((c) => [c.id, `tok-${c.id}`]));
  writeFileSync(join(cfDir2, "connections.json"), JSON.stringify({ version: 1, connections: fullConns }), { mode: 0o600 });
  writeFileSync(join(cfDir2, "secrets.json"), JSON.stringify({ version: 1, tokens: fullTokens }), { mode: 0o600 });
  const legacyPolicy = JSON.stringify({ version: 1, connections: [{ id: "cf-overflow", label: "Overflow" }] });
  const legacySecrets = JSON.stringify({ cloudflare: { "cf-overflow": "tok-overflow" }, mailcowKey: "" });
  writeFileSync(join(dnsDir2, "policy.json"), legacyPolicy, { mode: 0o600 });
  writeFileSync(join(dnsDir2, "secrets.json"), legacySecrets, { mode: 0o600 });

  expect(() => migrateCloudflareFromDns(dnsDir2, { stateDir: cfDir2, rootUid: uid })).toThrow(`more than ${MAX_CLOUDFLARE_CONNECTIONS}`);
  expect(readFileSync(join(dnsDir2, "policy.json"), "utf8")).toBe(legacyPolicy);
  expect(readFileSync(join(dnsDir2, "secrets.json"), "utf8")).toBe(legacySecrets);
  expect(readCloudflareStore({ stateDir: cfDir2, rootUid: uid }).tokens["cf-overflow"]).toBeUndefined();
});

test("saveCloudflareConnection and checkCloudflareConnections bound stalled verification within verifyMs", async () => {
  const { paths, cf } = makeStore();
  const hang = () => new Promise<Response>(() => {});
  await expect(saveCloudflareConnection({ token: USER_TOKEN }, { paths, fetch: hang, verifyMs: 40 })).rejects.toThrow("did not answer in time");

  const saved = await saveCloudflareConnection({ token: USER_TOKEN }, { paths, fetch: cf.fetch });
  const reports = await checkCloudflareConnections({ paths, fetch: hang, verifyMs: 40 });
  expect(reports).toHaveLength(1);
  expect(reports[0]).toMatchObject({ id: saved.id, active: false, status: "error", error: "Cloudflare did not answer in time" });
});

test("cloudflareAccessDetailsHtml puts dns-access-cols on headers only so narrow CSS keeps permission rows visible", () => {
  const html = cloudflareAccessDetailsHtml("cf-1", {
    reach: "All zones",
    note: null,
    editUrl: "https://dash.cloudflare.com/profile/api-tokens",
    rows: [
      { label: "SSL and Certificates: Edit", usedFor: "Panel gate", held: "yes" },
      { label: "DNS: Edit", usedFor: "Records", held: "no", optional: true },
    ],
  }, "Active", "fw-cf");
  const rows = html.match(/<div class="[^"]*dns-access-row[^"]*"/g) ?? [];
  // Header row and Optional section header have dns-access-cols; data rows do not.
  expect(rows.filter((tag) => tag.includes("dns-access-cols"))).toHaveLength(2);
  expect(rows.filter((tag) => !tag.includes("dns-access-cols"))).toHaveLength(2);
  const fwCss = readFileSync(join(import.meta.dir, "..", "addons", "firewall", "app", "views.css"), "utf8");
  expect(fwCss).toContain(".dns-access-cols:not(.dns-access-section) { display: none; }");
});

test("migrateCloudflareFromDns imports a legacy report only when its token wins the merge", () => {
  const dir = mkdtempSync(join(tmpdir(), "clp-cf-mig-rep-"));
  dirs.push(dir);
  const dnsDir = join(dir, "dns");
  const cfDir = join(dir, "cloudflare");
  mkdirSync(dnsDir, { recursive: true });
  mkdirSync(cfDir, { recursive: true });

  // Shared store already has cf-a with token Y and no cached report.
  writeFileSync(join(cfDir, "connections.json"), JSON.stringify({ version: 1, connections: [{ id: "cf-a", label: "Shared" }] }), { mode: 0o600 });
  writeFileSync(join(cfDir, "secrets.json"), JSON.stringify({ version: 1, tokens: { "cf-a": "token-Y" } }), { mode: 0o600 });

  // Legacy store has cf-a with token X (conflicts) and cf-b with token Z (new), both with cached reports.
  writeFileSync(join(dnsDir, "policy.json"), JSON.stringify({
    version: 1,
    connections: [{ id: "cf-a", label: "Legacy A" }, { id: "cf-b", label: "Legacy B" }],
  }), { mode: 0o600 });
  writeFileSync(join(dnsDir, "secrets.json"), JSON.stringify({
    cloudflare: { "cf-a": "token-X", "cf-b": "token-Z" },
    mailcowKey: "",
  }), { mode: 0o600 });
  writeFileSync(join(dnsDir, "status.json"), JSON.stringify({
    connections: [
      { id: "cf-a", label: "Legacy A", active: true, status: "active", accounts: [], zones: 2, error: null },
      { id: "cf-b", label: "Legacy B", active: true, status: "active", accounts: [], zones: 1, error: null },
    ],
    backoff: { cloudflare: 0, mailcow: 0 },
  }), { mode: 0o600 });

  const undo = migrateCloudflareFromDns(dnsDir, { stateDir: cfDir, rootUid: uid });
  expect(undo).not.toBeNull();
  const after = readCloudflareStore({ stateDir: cfDir, rootUid: uid });
  expect(after.tokens["cf-a"]).toBe("token-Y");
  expect(after.tokens["cf-b"]).toBe("token-Z");
  expect(after.reports.map((r) => r.id)).toEqual(["cf-b"]);
});

test("removing the last shared Cloudflare connection keeps shared store authoritative and never resurrects dns/status.json", async () => {
  const { executeDnsAction } = await import("../addons/dns/action");
  const { dir, paths, cf } = makeStore();
  const dnsDir = join(dir, "dns");
  mkdirSync(dnsDir, { recursive: true });
  const saved = await saveCloudflareConnection({ token: USER_TOKEN, label: "Primary" }, { paths, fetch: cf.fetch });
  // Simulate a stale dns/status.json report left over from an earlier version.
  writeFileSync(join(dnsDir, "status.json"), JSON.stringify({
    checkedAt: new Date().toISOString(),
    connections: [{
      id: saved.id, label: "Primary", active: true, status: "active",
      accounts: [{ id: "acc-1", name: "Agency" }], zones: 1, zoneNames: ["example.com"], error: null,
    }],
    plans: {},
    backoff: { cloudflare: 0, mailcow: 0 },
  }), { mode: 0o600 });

  await removeCloudflareConnection(saved.id, { paths });
  expect(hasSharedCloudflareStore(paths)).toBe(true);

  const opts = {
    processUid: 0,
    paths: {
      stateDir: dnsDir,
      lockFile: join(dir, "dns.lock"),
      cloudflareDir: paths.stateDir,
      cloudflareLockFile: paths.lockFile,
      rootUid: uid,
    },
    sites: () => [],
    addresses: () => ({ ipv4: "203.0.113.10", ipv6: null }),
    fetch: cf.fetch,
  };
  const listed = await executeDnsAction(["list"], opts) as { connections: unknown[]; accounts: unknown[]; zones: unknown[] };
  expect(listed.connections).toEqual([]);
  expect(listed.accounts).toEqual([]);
  expect(listed.zones).toEqual([]);
  await executeDnsAction(["check"], opts);
  expect(JSON.parse(readFileSync(join(dnsDir, "status.json"), "utf8")).connections).toEqual([]);
});

test("readFirewallEdgeDefaults includes default edge permissions when cloudflare-edge.json is absent and honors saved defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "clp-fw-edge-defaults-"));
  dirs.push(dir);
  const fallbackTemplates = tokenTemplates(readFirewallEdgeDefaults({ firewallDir: dir, rootUid: uid }));
  expect(fallbackTemplates["dns+edge+panelGate"].permissions).toContain("Zone Settings: Edit");
  expect(fallbackTemplates["dns+edge+panelGate"].permissions).toContain("Config Rules: Edit");
  expect(fallbackTemplates["dns+edge+panelGate"].permissions).not.toContain("Zone Settings: Read");
  expect(fallbackTemplates.dns.permissions).not.toContain("Zone Settings: Edit");

  writeFileSync(join(dir, "cloudflare-edge.json"), JSON.stringify({
    version: 1,
    defaults: { ssl: "strict", alwaysHttps: true, acmeFullSsl: true, webmailFullSsl: false, skipFirewallIps: ["198.51.100.1"] },
    approved: true,
    approvedAt: new Date().toISOString(),
    approvedDigest: "abc",
    knownZones: [],
    zoneChoices: {},
    migrationNote: null,
  }), { mode: 0o600 });
  const savedTemplates = tokenTemplates(readFirewallEdgeDefaults({ firewallDir: dir, rootUid: uid }));
  expect(savedTemplates.edge.permissions).toContain("Zone WAF: Edit");
  expect(savedTemplates["dns+edge+panelGate"].permissions).toContain("Zone WAF: Edit");
  expect(savedTemplates.panelGate.permissions).not.toContain("Zone WAF: Edit");
  expect(savedTemplates.dns.permissions).not.toContain("Zone WAF: Edit");
});

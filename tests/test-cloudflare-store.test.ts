import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkCloudflareConnections, cloudflareConnectionViews, cloudflareTokenHolds, legacyDnsCloudflarePending,
  listCloudflareSecrets, migrateCloudflareFromDns, readCloudflareStore, removeCloudflareConnection,
  saveCloudflareConnection, type CloudflareStorePaths,
} from "../lib/cloudflare/store";
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

  const view = cloudflareConnectionViews([], { includeDns: false, requirePanelGate: true }, paths);
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
  expect(cloudflareConnectionViews([], {}, paths).connections).toEqual([]);
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

test("tokenTemplates separates DNS-only, Panel-gate-only, and combined scopes", () => {
  const templates = tokenTemplates([]);
  expect(templates.dns.permissions).toContain("DNS: Edit");
  expect(templates.dns.permissions).not.toContain("SSL and Certificates: Edit");
  expect(templates.dns.url).not.toContain("ssl_and_certificates");

  expect(templates.panelGate.permissions).toContain("SSL and Certificates: Edit");
  expect(templates.panelGate.permissions).toContain("Access: Apps and Policies: Edit");
  expect(templates.panelGate.permissions).toContain("API Tokens: Read");
  expect(templates.panelGate.permissions).not.toContain("DNS: Edit");
  expect(templates.panelGate.permissions).not.toContain("Zone: Edit");
  expect(templates.panelGate.url).toContain("ssl_and_certificates");
  expect(templates.panelGate.url).not.toContain("dns_records");

  expect(templates.both.permissions).toContain("DNS: Edit");
  expect(templates.both.permissions).toContain("SSL and Certificates: Edit");
  expect(templates.both.permissions).toContain("API Tokens: Read");

  // Direct tokenTemplate with Panel gate required matches templates.panelGate.
  expect(tokenTemplate([], { dns: false, panelGate: true })).toEqual(templates.panelGate);
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

  // DNS files keep Mailcow key and drop legacy Cloudflare copies.
  expect(JSON.parse(readFileSync(join(dnsDir, "secrets.json"), "utf8"))).toEqual({ cloudflare: {}, mailcowKey: "mc-key-123" });
  expect(JSON.parse(readFileSync(join(dnsDir, "policy.json"), "utf8")).connections).toEqual([]);
  // Second run is a no-op.
  expect(migrateCloudflareFromDns(dnsDir, { stateDir: cfDir, rootUid: uid })).toBeNull();

  // Rollback restores exact prior files and cleans up new directory.
  undo!();
  expect(readFileSync(join(dnsDir, "policy.json"), "utf8")).toBe(policyText);
  expect(readFileSync(join(dnsDir, "secrets.json"), "utf8")).toBe(secretsText);
  expect(readFileSync(join(dnsDir, "status.json"), "utf8")).toBe(statusText);
  expect(existsSync(cfDir)).toBe(false);
});

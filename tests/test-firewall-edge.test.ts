import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_EDGE_DEFAULTS, EMPTY_EDGE_DEFAULTS, parseEdgeDefaults, planZoneEdge, type EdgeDefaults,
} from "../lib/cloudflare/edge";
import { cloudflareConnectionViews, saveCloudflareConnection, type CloudflareStorePaths } from "../lib/cloudflare/store";
import {
  checkCloudflareEdge, chooseCloudflareEdgeZone, confirmCloudflareEdge, edgeActionNeeded, edgePageView,
  edgeSetupCheck, readEdgeConfig, reconcileCloudflareEdge, reviewCloudflareEdgeZone, saveCloudflareEdge,
  type EdgeOptions,
} from "../addons/firewall/edge";
import { cloudflareEdgeMigrationPending, migrateCloudflareEdgeFromDns } from "../addons/firewall/migration";
import { CLIENT_JS, dashboardView } from "../addons/firewall/app/views";
import { tokenTemplates } from "../lib/cloudflare/tokens";
import { FakeCloudflare, hexId, policy } from "./fixtures/dns-api";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const uid = process.getuid!();
const TOKEN = "cf-edge-token-0123456789abcdef";
const TOKEN_2 = "cf-edge-token-fedcba9876543210";
const ALL_ZONES = { "com.cloudflare.api.account.zone.*": "*" };

function makeEnv() {
  const dir = mkdtempSync(join(tmpdir(), "clp-fw-edge-"));
  dirs.push(dir);
  const cf = new FakeCloudflare();
  const agency = cf.account("Agency");
  cf.token(TOKEN, {
    owner: "user",
    accounts: [agency],
    policies: [policy([
      "Zone Read", "Zone Settings Write", "Config Settings Write", "Zone WAF Write", "API Tokens Read",
    ], ALL_ZONES)],
  });
  const cfPaths: CloudflareStorePaths = {
    stateDir: join(dir, "cloudflare"),
    lockFile: join(dir, "cloudflare.lock"),
    rootUid: uid,
  };
  let now = Date.parse("2026-11-27T12:00:00Z");
  const options: EdgeOptions = {
    paths: {
      stateDir: join(dir, "firewall"),
      lockFile: join(dir, "firewall-edge.lock"),
      cloudflareDir: cfPaths.stateDir,
      cloudflareLockFile: cfPaths.lockFile,
      rootUid: uid,
    },
    fetch: cf.fetch,
    now: () => now,
  };
  const connect = (token = TOKEN, label = "Agency") =>
    saveCloudflareConnection({ token, label }, { paths: cfPaths, fetch: cf.fetch });
  return {
    dir,
    cf,
    agency,
    cfPaths,
    options,
    connect,
    advance: (ms: number) => { now += ms; },
  };
}

describe("Cloudflare edge planner (lib/cloudflare/edge.ts)", () => {
  test("parses, normalizes, and validates edge defaults", () => {
    expect(parseEdgeDefaults({
      ssl: "strict",
      alwaysHttps: true,
      acmeFullSsl: true,
      webmailFullSsl: false,
      skipFirewallIps: ["203.0.113.7", "2001:DB8::1", "203.0.113.7"],
    })).toEqual({
      ssl: "strict",
      alwaysHttps: true,
      acmeFullSsl: true,
      webmailFullSsl: false,
      skipFirewallIps: ["2001:db8::1", "203.0.113.7"],
    });
    expect(() => parseEdgeDefaults({ ssl: "invalid" })).toThrow("SSL/TLS mode");
    expect(() => parseEdgeDefaults({ skipFirewallIps: ["not-an-ip"] })).toThrow("not an IP address");
    const tooMany = Array.from({ length: 21 }, (_, i) => `198.51.100.${i + 1}`);
    expect(() => parseEdgeDefaults({ skipFirewallIps: tooMany })).toThrow("at most 20");
  });

  test("marks SSL upgrades, enabling Always HTTPS, and missing rules as safe; adopts legacy clp_dns_* and equivalent rules", () => {
    const safe = planZoneEdge(DEFAULT_EDGE_DEFAULTS, {
      settings: { ssl: "full", always_use_https: "off" },
      rulesets: { http_config_settings: null },
    });
    expect(safe.conflicts).toEqual([]);
    expect(safe.changes.map((c) => `${c.action} ${c.target}`)).toEqual(["update ssl", "update always_use_https", "create acme"]);
    expect(safe.changes.some((c) => c.destructive || c.conflict)).toBe(false);

    // Legacy clp_dns_acme and equivalent third-party webmail rule produce zero writes.
    const adopted = planZoneEdge({ ...DEFAULT_EDGE_DEFAULTS, webmailFullSsl: true, skipFirewallIps: ["203.0.113.7"] }, {
      settings: { ssl: "strict", always_use_https: "on" },
      rulesets: {
        http_config_settings: {
          id: hexId(),
          rules: [
            {
              id: hexId(), ref: "clp_dns_acme", action: "set_config", enabled: true,
              expression: 'starts_with(http.request.uri.path, "/.well-known/acme-challenge/")',
              description: "Legacy DNS ACME", action_parameters: { ssl: "full" },
            },
            {
              id: hexId(), ref: "tf_webmail", action: "set_config", enabled: true,
              expression: 'starts_with(http.host, "webmail.")',
              description: "Terraform webmail", action_parameters: { ssl: "full" },
            },
          ],
        },
        http_request_firewall_custom: {
          id: hexId(),
          rules: [{
            id: hexId(), ref: "clp_dns_skip", action: "skip", enabled: true,
            expression: "ip.src in {203.0.113.7}",
            description: "Legacy skip",
            action_parameters: { phases: ["http_request_firewall_managed", "http_request_sbfm"] },
          }],
        },
      },
    });
    expect(adopted.changes).toEqual([]);
    expect(adopted.conflicts).toEqual([]);
    expect(adopted.managedRules).toEqual(["acme", "skip"]);
  });

  test("flags SSL downgrades, disabling Always HTTPS, removing skip IPs, deleting managed rules, and rule conflicts", () => {
    const destructive = planZoneEdge(
      { ssl: "full", alwaysHttps: false, acmeFullSsl: false, webmailFullSsl: false, skipFirewallIps: ["203.0.113.7"] },
      {
        settings: { ssl: "strict", always_use_https: "on" },
        rulesets: {
          http_config_settings: {
            id: hexId(),
            rules: [{
              id: hexId(), ref: "clp_fw_acme", action: "set_config", enabled: true,
              expression: 'starts_with(http.request.uri.path, "/.well-known/acme-challenge/")',
              description: "Managed ACME", action_parameters: { ssl: "full" },
            }],
          },
          http_request_firewall_custom: {
            id: hexId(),
            rules: [{
              id: hexId(), ref: "clp_fw_skip", action: "skip", enabled: true,
              expression: "ip.src in {198.51.100.4 203.0.113.7}",
              description: "Managed skip",
              action_parameters: { phases: ["http_request_sbfm", "http_request_firewall_managed"] },
            }],
          },
        },
      },
    );
    expect(destructive.changes.map((c) => [c.target, c.action, Boolean(c.destructive)])).toEqual([
      ["ssl", "update", true],
      ["always_use_https", "update", true],
      ["acme", "delete", true],
      ["skip", "update", true],
    ]);

    // Single exact-expression foreign rule is a confirmable conflict; compound foreign rule is a blocking conflict.
    const conflictSingle = planZoneEdge(DEFAULT_EDGE_DEFAULTS, {
      settings: { ssl: "strict", always_use_https: "on" },
      rulesets: {
        http_config_settings: {
          id: hexId(),
          rules: [{
            id: hexId(), ref: "custom_acme", action: "set_config", enabled: false,
            expression: 'starts_with(http.request.uri.path, "/.well-known/acme-challenge/")',
            description: "Disabled ACME", action_parameters: { ssl: "flexible" },
          }],
        },
      },
    });
    expect(conflictSingle.conflicts).toEqual([]);
    expect(conflictSingle.changes).toEqual([expect.objectContaining({ target: "acme", action: "update", conflict: true })]);

    const conflictCompound = planZoneEdge(DEFAULT_EDGE_DEFAULTS, {
      settings: { ssl: "strict", always_use_https: "on" },
      rulesets: {
        http_config_settings: {
          id: hexId(),
          rules: [{
            id: hexId(), ref: "custom_mix", action: "set_config", enabled: true,
            expression: 'starts_with(http.request.uri.path, "/.well-known/acme-challenge/") and http.host eq "a.example.com"',
            description: "Custom host ACME", action_parameters: { ssl: "flexible" },
          }],
        },
      },
    });
    expect(conflictCompound.changes).toEqual([]);
    expect(conflictCompound.conflicts[0]).toContain("Custom host ACME");
  });

  test("detects competing foreign rules beside a matching managed or equivalent rule while keeping zero-write adoption alone", () => {
    // Managed clp_fw_acme (Full SSL) plus a competing foreign ACME rule (Flexible SSL).
    const managedWithCompetitor = planZoneEdge(DEFAULT_EDGE_DEFAULTS, {
      settings: { ssl: "strict", always_use_https: "on" },
      rulesets: {
        http_config_settings: {
          id: hexId(),
          rules: [
            {
              id: hexId(), ref: "clp_fw_acme", action: "set_config", enabled: true,
              expression: 'starts_with(http.request.uri.path, "/.well-known/acme-challenge/")',
              description: "Managed ACME", action_parameters: { ssl: "full" },
            },
            {
              id: hexId(), ref: "foreign_flex", action: "set_config", enabled: true,
              expression: 'starts_with(http.request.uri.path, "/.well-known/acme-challenge/")',
              description: "Foreign ACME Flexible", action_parameters: { ssl: "flexible" },
            },
          ],
        },
      },
    });
    expect(managedWithCompetitor.changes).toEqual([]);
    expect(managedWithCompetitor.conflicts).toHaveLength(1);
    expect(managedWithCompetitor.conflicts[0]).toContain("Foreign ACME Flexible");

    // Equivalent foreign ACME rule (Full SSL) plus a competing foreign ACME rule (Flexible SSL).
    const equivalentWithCompetitor = planZoneEdge(DEFAULT_EDGE_DEFAULTS, {
      settings: { ssl: "strict", always_use_https: "on" },
      rulesets: {
        http_config_settings: {
          id: hexId(),
          rules: [
            {
              id: hexId(), ref: "tf_acme", action: "set_config", enabled: true,
              expression: 'starts_with(http.request.uri.path, "/.well-known/acme-challenge/")',
              description: "Terraform ACME", action_parameters: { ssl: "full" },
            },
            {
              id: hexId(), ref: "foreign_flex", action: "set_config", enabled: true,
              expression: 'starts_with(http.request.uri.path, "/.well-known/acme-challenge/")',
              description: "Dashboard ACME Flexible", action_parameters: { ssl: "flexible" },
            },
          ],
        },
      },
    });
    expect(equivalentWithCompetitor.changes).toEqual([]);
    expect(equivalentWithCompetitor.conflicts).toHaveLength(1);
    expect(equivalentWithCompetitor.conflicts[0]).toContain("Dashboard ACME Flexible");

    // Equivalent foreign rule with no competitors still adopts cleanly with zero writes and zero conflicts.
    const equivalentAlone = planZoneEdge(DEFAULT_EDGE_DEFAULTS, {
      settings: { ssl: "strict", always_use_https: "on" },
      rulesets: {
        http_config_settings: {
          id: hexId(),
          rules: [{
            id: hexId(), ref: "tf_acme", action: "set_config", enabled: true,
            expression: 'starts_with(http.request.uri.path, "/.well-known/acme-challenge/")',
            description: "Terraform ACME", action_parameters: { ssl: "full" },
          }],
        },
      },
    });
    expect(equivalentAlone.changes).toEqual([]);
    expect(equivalentAlone.conflicts).toEqual([]);
  });

  test("treats a later hostname-only rule that sets another SSL mode as competing with the ACME rule", () => {
    const acme = (ref: string) => ({
      id: hexId(), ref, action: "set_config", enabled: true,
      expression: 'starts_with(http.request.uri.path, "/.well-known/acme-challenge/")',
      description: "ACME", action_parameters: { ssl: "full" },
    });
    const host = (ssl: string) => ({
      id: hexId(), ref: "blog_ssl", action: "set_config", enabled: true,
      expression: 'http.host eq "blog.example.com"', description: "Blog SSL", action_parameters: { ssl },
    });
    const plan = (rules: Record<string, unknown>[]) => planZoneEdge(DEFAULT_EDGE_DEFAULTS, {
      settings: { ssl: "strict", always_use_https: "on" },
      rulesets: { http_config_settings: { id: hexId(), rules: rules as never } },
    });
    for (const ref of ["clp_fw_acme", "tf_acme"]) {
      const after = plan([acme(ref), host("strict")]);
      expect(after.changes).toEqual([]);
      expect(after.conflicts).toHaveLength(1);
      expect(after.conflicts[0]).toContain("Blog SSL");
      expect(plan([host("strict"), acme(ref)]).conflicts).toEqual([]);
      expect(plan([acme(ref), host("full")]).conflicts).toEqual([]);
    }
  });
});

describe("Firewall approve-once Cloudflare edge defaults", () => {
  test("stays read-only before approval, approves once, and applies to new zones automatically with no review hold", async () => {
    const env = makeEnv();
    const zone1 = env.cf.zone("example.com", env.agency);
    await env.connect();

    // Unapproved: check previews changes, writes nothing, reconcile is a zero-API-call no-op.
    const checked = await checkCloudflareEdge(env.options);
    expect(checked.applied).toBe(0);
    expect(env.cf.writes()).toEqual([]);
    const beforeCalls = env.cf.calls.length;
    expect(await reconcileCloudflareEdge(env.options)).toBeNull();
    expect(env.cf.calls.length).toBe(beforeCalls);

    const unapprovedView = edgePageView(env.options);
    expect(unapprovedView.approved).toBe(false);
    expect(unapprovedView.needsApproval).toBe(true);
    expect(unapprovedView.zones[0]!.status).toBe("pending");
    expect(edgeSetupCheck(env.options).state).toBe("todo");

    // Draft save changes defaults without touching Cloudflare.
    const draft = await saveCloudflareEdge({
      approve: false,
      defaults: { ...DEFAULT_EDGE_DEFAULTS, skipFirewallIps: ["203.0.113.7"] },
    }, env.options);
    expect(draft.review).toBeUndefined();
    expect(env.cf.writes()).toEqual([]);

    // Approve-once flow returns a review, writes nothing until confirmed.
    const reviewed = await saveCloudflareEdge({
      approve: true,
      defaults: { ...DEFAULT_EDGE_DEFAULTS, skipFirewallIps: ["203.0.113.7"] },
    }, env.options);
    expect(reviewed.review).toBeDefined();
    expect(reviewed.review!.kind).toBe("approve");
    expect(reviewed.review!.danger).toBe(false);
    expect(env.cf.writes()).toEqual([]);

    const confirmed = await confirmCloudflareEdge(reviewed.review!.token, env.options);
    expect(confirmed.notice).toContain("approved");
    expect(env.cf.settings.get(`${zone1.id}:ssl`)).toBe("strict");
    expect(env.cf.settings.get(`${zone1.id}:always_use_https`)).toBe("on");
    expect(env.cf.rulesets.get(`${zone1.id}:http_config_settings`)!.rules.map((r) => r.ref)).toEqual(["clp_fw_acme"]);
    expect(env.cf.rulesets.get(`${zone1.id}:http_request_firewall_custom`)!.rules.map((r) => r.ref)).toEqual(["clp_fw_skip"]);

    // Rules are written before zone settings so ACME Full SSL is in place before Full (strict).
    const writePaths = env.cf.writes().map((call) => call.path);
    expect(writePaths.findIndex((p) => p.endsWith("/rulesets"))).toBeLessThan(writePaths.findIndex((p) => p.includes("/settings/")));

    expect(edgeSetupCheck(env.options).state).toBe("done");
    expect(statSync(join(env.dir, "firewall", "cloudflare-edge.json")).mode & 0o777).toBe(0o600);

    // New Cloudflare zone added later inherits approved defaults automatically with zero review hold.
    const zone2 = env.cf.zone("new-site.example", env.agency, "pending");
    const reconciled = await reconcileCloudflareEdge(env.options, "New zone");
    expect(reconciled).toContain("Applied approved defaults to 1 zone");
    expect(env.cf.settings.get(`${zone2.id}:ssl`)).toBe("strict");
    expect(env.cf.settings.get(`${zone2.id}:always_use_https`)).toBe("on");
    expect(env.cf.rulesets.get(`${zone2.id}:http_config_settings`)!.rules.map((r) => r.ref)).toEqual(["clp_fw_acme"]);
    expect(env.cf.rulesets.get(`${zone2.id}:http_request_firewall_custom`)!.rules.map((r) => r.ref)).toEqual(["clp_fw_skip"]);

    // Idempotent: a follow-up reconcile writes nothing.
    const writesAfter = env.cf.writes().length;
    expect(await reconcileCloudflareEdge(env.options)).toBeNull();
    expect(env.cf.writes().length).toBe(writesAfter);

    const view = edgePageView(env.options);
    expect(view.approved).toBe(true);
    expect(view.zones.every((z) => z.status === "synced")).toBe(true);
    expect(view.log.some((entry) => entry.cause === "New zone" && entry.zone === "new-site.example")).toBe(true);
  });

  test("holds destructive changes and conflicts for explicit confirmation even after approval", async () => {
    const env = makeEnv();
    const safeZone = env.cf.zone("fresh.example", env.agency);
    env.cf.settings.set(`${safeZone.id}:ssl`, "flexible");
    await env.connect();

    // Approve defaults with SSL = full (so upgrading flexible -> full is safe, but downgrading strict -> full is destructive).
    const approveReview = await saveCloudflareEdge({
      approve: true,
      defaults: { ssl: "full", alwaysHttps: true, acmeFullSsl: true, webmailFullSsl: false, skipFirewallIps: [] },
    }, env.options);
    await confirmCloudflareEdge(approveReview.review!.token, env.options);
    expect(env.cf.settings.get(`${safeZone.id}:ssl`)).toBe("full");

    // Add a strict zone (downgrade!) and a zone with a disabled managed ACME rule (conflict!).
    const strictZone = env.cf.zone("strict.example", env.agency);
    env.cf.settings.set(`${strictZone.id}:ssl`, "strict");
    env.cf.settings.set(`${strictZone.id}:always_use_https`, "on");
    env.cf.rulesets.set(`${strictZone.id}:http_config_settings`, {
      id: hexId(),
      rules: [{
        id: hexId(), ref: "clp_fw_acme", action: "set_config", enabled: true,
        expression: 'starts_with(http.request.uri.path, "/.well-known/acme-challenge/")',
        description: "Managed ACME", action_parameters: { ssl: "full" },
      }],
    });

    const disabledRuleZone = env.cf.zone("disabled.example", env.agency);
    env.cf.settings.set(`${disabledRuleZone.id}:ssl`, "full");
    env.cf.settings.set(`${disabledRuleZone.id}:always_use_https`, "on");
    env.cf.rulesets.set(`${disabledRuleZone.id}:http_config_settings`, {
      id: hexId(),
      rules: [{
        id: hexId(), ref: "clp_fw_acme", action: "set_config", enabled: false,
        expression: 'starts_with(http.request.uri.path, "/.well-known/acme-challenge/")',
        description: "Managed ACME", action_parameters: { ssl: "full" },
      }],
    });

    const writesBefore = env.cf.writes().length;
    const check = await checkCloudflareEdge(env.options);
    expect(check.applied).toBe(0);
    expect(check.held).toBe(2);
    expect(env.cf.writes().length).toBe(writesBefore);
    // Strict zone stayed strict; disabled rule stayed disabled.
    expect(env.cf.settings.get(`${strictZone.id}:ssl`)).toBe("strict");

    // Setup Action needed flags the held zones.
    const actions = edgeActionNeeded(env.options);
    expect(actions.some((item) => item.title === "Cloudflare edge changes need review" && item.reason.includes("strict.example"))).toBe(true);

    // Explicit per-zone confirmation review applies the destructive change once confirmed.
    const strictKey = edgePageView(env.options).zones.find((z) => z.zoneName === "strict.example")!.zoneKey;
    const zoneReview = await reviewCloudflareEdgeZone(strictKey, env.options);
    expect(zoneReview.review!.danger).toBe(true);
    expect(zoneReview.review!.zones[0]!.changes[0]).toMatchObject({ subject: "SSL/TLS mode", destructive: true });
    await confirmCloudflareEdge(zoneReview.review!.token, env.options);
    expect(env.cf.settings.get(`${strictZone.id}:ssl`)).toBe("full");

    // Editing approved defaults to turn off ACME deletes managed rules only after explicit destructive confirmation.
    const editReview = await saveCloudflareEdge({
      defaults: { ssl: "full", alwaysHttps: true, acmeFullSsl: false, webmailFullSsl: false, skipFirewallIps: [] },
    }, env.options);
    expect(editReview.review!.danger).toBe(true);
    expect(editReview.review!.zones.some((z) => z.changes.some((c) => c.action === "delete" && c.destructive))).toBe(true);
    await confirmCloudflareEdge(editReview.review!.token, env.options);
    expect(env.cf.rulesets.get(`${safeZone.id}:http_config_settings`)!.rules).toEqual([]);
  });

  test("stale review digest re-prompts instead of applying changed state, and pause stops automatic enforcement", async () => {
    const env = makeEnv();
    const zone = env.cf.zone("shift.example", env.agency);
    await env.connect();

    const review = await saveCloudflareEdge({ approve: true, defaults: DEFAULT_EDGE_DEFAULTS }, env.options);
    // Cloudflare changes behind our back before confirm.
    env.cf.settings.set(`${zone.id}:ssl`, "flexible");
    const retried = await confirmCloudflareEdge(review.review!.token, env.options);
    expect(retried.review).toBeDefined();
    expect(env.cf.writes()).toEqual([]);

    // Confirming the refreshed token succeeds.
    await confirmCloudflareEdge(retried.review!.token, env.options);
    expect(env.cf.settings.get(`${zone.id}:ssl`)).toBe("strict");

    // Pause switches off automatic enforcement with no writes.
    await saveCloudflareEdge({ pause: true }, env.options);
    expect(edgePageView(env.options).approved).toBe(false);
    const zoneAfterPause = env.cf.zone("paused.example", env.agency);
    expect(await reconcileCloudflareEdge(env.options)).toBeNull();
    expect(env.cf.settings.get(`${zoneAfterPause.id}:ssl`)).toBeUndefined();
  });

  test("a review to delete a managed rule re-prompts when Cloudflare replaced that rule before confirmation", async () => {
    const env = makeEnv();
    const zone = env.cf.zone("swap.example", env.agency);
    await env.connect();
    const approve = await saveCloudflareEdge({ approve: true, defaults: DEFAULT_EDGE_DEFAULTS }, env.options);
    await confirmCloudflareEdge(approve.review!.token, env.options);
    const key = `${zone.id}:http_config_settings`;
    const original = env.cf.rulesets.get(key)!.rules[0]!;

    const review = await saveCloudflareEdge({ defaults: { ...DEFAULT_EDGE_DEFAULTS, acmeFullSsl: false } }, env.options);
    expect(review.review!.zones[0]!.changes.some((c) => c.action === "delete")).toBe(true);
    const replacement = { ...original, id: hexId(), description: "Replaced elsewhere" };
    env.cf.rulesets.get(key)!.rules = [replacement];

    const writesBefore = env.cf.writes().length;
    const retried = await confirmCloudflareEdge(review.review!.token, env.options);
    expect(retried.review).toBeDefined();
    expect(env.cf.writes().length).toBe(writesBefore);
    expect(env.cf.rulesets.get(key)!.rules.map((rule) => rule.id)).toEqual([replacement.id]);

    await confirmCloudflareEdge(retried.review!.token, env.options);
    expect(env.cf.rulesets.get(key)!.rules).toEqual([]);
  });

  test("never writes a planned WAF skip list over a rule Cloudflare changed after it was read", async () => {
    const env = makeEnv();
    const zoneA = env.cf.zone("alpha.example", env.agency);
    const zoneB = env.cf.zone("beta.example", env.agency);
    await env.connect();
    const approve = await saveCloudflareEdge({ approve: true, defaults: { ...DEFAULT_EDGE_DEFAULTS, skipFirewallIps: ["203.0.113.7"] } }, env.options);
    await confirmCloudflareEdge(approve.review!.token, env.options);

    const skipKey = (id: string) => `${id}:http_request_firewall_custom`;
    let firstWrite: string | null = null;
    const wrapped: EdgeOptions = {
      ...env.options,
      fetch: async (address, init) => {
        const path = new URL(String(address)).pathname;
        const response = await env.cf.fetch(address, init);
        if (!firstWrite && init?.method === "PATCH" && path.includes("/rules/")) {
          firstWrite = path.includes(zoneA.id) ? zoneA.id : zoneB.id;
          const other = env.cf.rulesets.get(skipKey(firstWrite === zoneA.id ? zoneB.id : zoneA.id))!;
          other.rules = other.rules.map((rule) => ({ ...rule, expression: "ip.src in {203.0.113.7 198.51.100.9}" }));
        }
        return response;
      },
    };
    const review = await saveCloudflareEdge({ defaults: { ...DEFAULT_EDGE_DEFAULTS, skipFirewallIps: ["203.0.113.7", "203.0.113.8"] } }, wrapped);
    await confirmCloudflareEdge(review.review!.token, wrapped);

    const otherId = firstWrite === zoneA.id ? zoneB.id : zoneA.id;
    expect(env.cf.rulesets.get(skipKey(firstWrite!))!.rules[0]!.expression).toBe("ip.src in {203.0.113.7 203.0.113.8}");
    expect(env.cf.rulesets.get(skipKey(otherId))!.rules[0]!.expression).toBe("ip.src in {203.0.113.7 198.51.100.9}");
    const other = edgePageView(env.options).zones.find((zone) => zone.zoneId === otherId)!;
    expect(other.status).toBe("error");
    expect(other.error).toContain("WAF skip rule changed in Cloudflare");
  });

  test("confirming an approval while Cloudflare cannot be read neither renews the review nor approves", async () => {
    const env = makeEnv();
    const zone = env.cf.zone("down.example", env.agency);
    await env.connect();
    const review = await saveCloudflareEdge({ approve: true, defaults: DEFAULT_EDGE_DEFAULTS }, env.options);
    expect(review.review!.zones.length).toBe(1);

    let down = true;
    const wrapped: EdgeOptions = {
      ...env.options,
      fetch: async (address, init) => down
        ? new Response(JSON.stringify({ success: false, errors: [{ code: 500, message: "Upstream outage" }] }), { status: 503 })
        : env.cf.fetch(address, init),
    };
    await expect(confirmCloudflareEdge(review.review!.token, wrapped)).rejects.toThrow("Cloudflare could not be read");
    await expect(confirmCloudflareEdge(review.review!.token, wrapped)).rejects.toThrow("Cloudflare could not be read");
    expect(readEdgeConfig(env.options).approved).toBe(false);

    down = false;
    await confirmCloudflareEdge(review.review!.token, wrapped);
    expect(readEdgeConfig(env.options).approved).toBe(true);
    expect(env.cf.settings.get(`${zone.id}:ssl`)).toBe("strict");
  });

  test("disambiguates duplicate zone names across two Cloudflare accounts", async () => {
    const env = makeEnv();
    const account2 = env.cf.account("Secondary");
    env.cf.token(TOKEN_2, { owner: "user", accounts: [account2] });
    const z1 = env.cf.zone("shared.example", env.agency);
    const z2 = env.cf.zone("shared.example", account2);
    const c1 = await env.connect(TOKEN, "Agency");
    await env.connect(TOKEN_2, "Secondary");

    const check1 = await checkCloudflareEdge(env.options);
    expect(check1.conflicts).toBe(1);
    const ambiguous = edgePageView(env.options).zones.find((z) => z.zoneName === "shared.example")!;
    expect(ambiguous.status).toBe("conflict");
    expect(ambiguous.zoneChoices).toHaveLength(2);

    await chooseCloudflareEdgeZone({ zone: "shared.example", connectionId: c1.id, zoneId: z1.id }, env.options);
    const chosen = edgePageView(env.options).zones.find((z) => z.zoneName === "shared.example")!;
    expect(chosen.zoneId).toBe(z1.id);
    expect(chosen.zoneId).not.toBe(z2.id);
    expect(chosen.status).toBe("pending");
  });

  test("holds a zone when its chosen account is temporarily unavailable instead of falling back to another account", async () => {
    const env = makeEnv();
    const account2 = env.cf.account("Secondary");
    env.cf.token(TOKEN_2, { owner: "user", accounts: [account2] });
    const z1 = env.cf.zone("shared.example", env.agency);
    const z2 = env.cf.zone("shared.example", account2);
    env.cf.settings.set(`${z1.id}:ssl`, "flexible");
    env.cf.settings.set(`${z2.id}:ssl`, "flexible");
    await env.connect(TOKEN, "Agency");
    const c2 = await env.connect(TOKEN_2, "Secondary");

    await chooseCloudflareEdgeZone({ zone: "shared.example", connectionId: c2.id, zoneId: z2.id }, env.options);
    const approveReview = await saveCloudflareEdge({ approve: true, defaults: DEFAULT_EDGE_DEFAULTS }, env.options);
    await confirmCloudflareEdge(approveReview.review!.token, env.options);
    expect(env.cf.settings.get(`${z2.id}:ssl`)).toBe("strict");
    expect(env.cf.settings.get(`${z1.id}:ssl`)).toBe("flexible");

    // Simulate Secondary connection temporarily failing while Agency still returns shared.example.
    let secondaryDown = true;
    const baseFetch = env.cf.fetch;
    const wrappedOptions: EdgeOptions = {
      ...env.options,
      fetch: async (address, init) => {
        const auth = new Headers(init?.headers).get("authorization") ?? "";
        if (secondaryDown && auth.includes(TOKEN_2)) {
          return new Response(JSON.stringify({ success: false, errors: [{ code: 500, message: "Upstream error" }] }), { status: 503 });
        }
        return baseFetch(address, init);
      },
    };
    const writesBefore = env.cf.writes().length;
    const checkDown = await checkCloudflareEdge(wrappedOptions);
    expect(checkDown.conflicts).toBe(1);
    expect(checkDown.applied).toBe(0);
    expect(env.cf.writes().length).toBe(writesBefore);
    // Agency's zone was NEVER touched.
    expect(env.cf.settings.get(`${z1.id}:ssl`)).toBe("flexible");
    const held = edgePageView(wrappedOptions).zones.find((z) => z.zoneName === "shared.example")!;
    expect(held.status).toBe("conflict");
    expect(held.conflicts[0]).toContain("selected Cloudflare zone is unavailable");

    // Once Secondary recovers, Firewall resolves back to Secondary automatically.
    secondaryDown = false;
    const checkRecovered = await checkCloudflareEdge(wrappedOptions);
    expect(checkRecovered.conflicts).toBe(0);
    expect(edgePageView(wrappedOptions).zones.find((z) => z.zoneName === "shared.example")!.zoneId).toBe(z2.id);
  });

  test("rejects per-zone review and confirmation before approval and hides the Review button in UI", async () => {
    const env = makeEnv();
    const zone = env.cf.zone("strict.example", env.agency);
    env.cf.settings.set(`${zone.id}:ssl`, "strict");
    env.cf.settings.set(`${zone.id}:always_use_https`, "on");
    await env.connect();

    // Save draft with SSL = full against a strict zone without approving.
    await saveCloudflareEdge({
      approve: false,
      defaults: { ssl: "full", alwaysHttps: true, acmeFullSsl: false, webmailFullSsl: false, skipFirewallIps: [] },
    }, env.options);
    await checkCloudflareEdge(env.options);

    const view = edgePageView(env.options);
    expect(view.approved).toBe(false);
    expect(view.zones[0]!.status).toBe("needs_review");

    // UI hides the per-zone Review button while unapproved.
    const html = dashboardView({
      sites: [],
      autoEnableNewSites: false,
      visitorIp: { enabled: true, applied: true, problem: "" },
      protocols: { available: true, enabled: true, protocols: {}, udpPorts: [] },
      hetzner: { state: "absent" as const },
      netcup: { state: "absent" as const },
      panelGate: { error: "not read" },
      cloudflare: { connections: [{ id: "cf-1", label: "Agency", active: true, status: "active", accounts: [], zones: 1, error: null, hasToken: true, access: null }], templates: tokenTemplates(view.defaults), serverIps: [], dnsEnabled: false },
      cloudflareEdge: view,
    });
    expect(html).not.toContain("fwReviewEdgeZone");

    // Server refuses per-zone review while unapproved and makes zero writes.
    await expect(reviewCloudflareEdgeZone(view.zones[0]!.zoneKey, env.options)).rejects.toThrow("Approve Cloudflare edge defaults first");
    expect(env.cf.settings.get(`${zone.id}:ssl`)).toBe("strict");

    // If a per-zone review was prepared while approved and defaults are then paused, confirm also refuses.
    const approved = await saveCloudflareEdge({
      approve: true,
      defaults: { ssl: "strict", alwaysHttps: true, acmeFullSsl: false, webmailFullSsl: false, skipFirewallIps: [] },
    }, env.options);
    if (approved.review) await confirmCloudflareEdge(approved.review.token, env.options);
    // Simulate zone switching to strict while approved defaults are full (after editing) -> actually prepare a review, then pause.
    const edit = await saveCloudflareEdge({
      defaults: { ssl: "full", alwaysHttps: true, acmeFullSsl: false, webmailFullSsl: false, skipFirewallIps: [] },
    }, env.options);
    await confirmCloudflareEdge(edit.review!.token, env.options);
    // Switch zone back to strict so per-zone review sees a destructive downgrade.
    env.cf.settings.set(`${zone.id}:ssl`, "strict");
    const zoneReview = await reviewCloudflareEdgeZone(view.zones[0]!.zoneKey, env.options);
    expect(zoneReview.review).toBeDefined();
    await saveCloudflareEdge({ pause: true }, env.options);
    await expect(confirmCloudflareEdge(zoneReview.review!.token, env.options)).rejects.toThrow();
    expect(env.cf.settings.get(`${zone.id}:ssl`)).toBe("strict");
  });

  test("skips Zone Settings reads for rule-only defaults when prevDefaults is absent", async () => {
    const env = makeEnv();
    const zone = env.cf.zone("rules-only.example", env.agency);
    const baseFetch = env.cf.fetch;
    const ruleOnlyOptions: EdgeOptions = {
      ...env.options,
      fetch: async (address, init) => {
        if (new URL(address).pathname.includes("/settings/")) {
          return new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }), { status: 403 });
        }
        return baseFetch(address, init);
      },
    };
    await env.connect();

    // Save rule-only draft (both SSL and Always Use HTTPS unset) and check.
    const ruleOnlyDefaults: EdgeDefaults = { ssl: null, alwaysHttps: null, acmeFullSsl: true, webmailFullSsl: false, skipFirewallIps: [] };
    await saveCloudflareEdge({ approve: false, defaults: ruleOnlyDefaults }, ruleOnlyOptions);

    const checked = await checkCloudflareEdge(ruleOnlyOptions);
    expect(checked.errors).toBe(0);
    expect(env.cf.calls.some((call) => call.path.includes("/settings/"))).toBe(false);

    const reviewed = await saveCloudflareEdge({ approve: true, defaults: ruleOnlyDefaults }, ruleOnlyOptions);
    expect(reviewed.review).toBeDefined();
    await confirmCloudflareEdge(reviewed.review!.token, ruleOnlyOptions);
    expect(env.cf.calls.some((call) => call.path.includes("/settings/"))).toBe(false);
    expect(env.cf.rulesets.get(`${zone.id}:http_config_settings`)!.rules.map((r) => r.ref)).toEqual(["clp_fw_acme"]);

    // Subsequent approved check also never queries Zone Settings.
    const recheck = await checkCloudflareEdge(ruleOnlyOptions);
    expect(recheck.errors).toBe(0);
    expect(env.cf.calls.some((call) => call.path.includes("/settings/"))).toBe(false);
  });

  test("retains managed-rule cleanup tracking across temporary connection outages until a ruleset read confirms removal", async () => {
    const env = makeEnv();
    const account2 = env.cf.account("Branch");
    env.cf.token(TOKEN_2, {
      owner: "user",
      accounts: [account2],
      policies: [policy(["Zone Read", "Zone Settings Write", "Config Settings Write", "Zone WAF Write", "API Tokens Read"], ALL_ZONES)],
    });
    const zoneA = env.cf.zone("alpha.example", env.agency);
    const zoneB = env.cf.zone("beta.example", account2);
    await env.connect(TOKEN, "Agency");
    await env.connect(TOKEN_2, "Branch");

    // Approve defaults with a WAF skip IP so both zones get clp_fw_skip.
    const initial = await saveCloudflareEdge({
      approve: true,
      defaults: { ...DEFAULT_EDGE_DEFAULTS, skipFirewallIps: ["203.0.113.7"] },
    }, env.options);
    await confirmCloudflareEdge(initial.review!.token, env.options);
    expect(env.cf.rulesets.get(`${zoneA.id}:http_request_firewall_custom`)!.rules.map((r) => r.ref)).toEqual(["clp_fw_skip"]);
    expect(env.cf.rulesets.get(`${zoneB.id}:http_request_firewall_custom`)!.rules.map((r) => r.ref)).toEqual(["clp_fw_skip"]);

    // Branch connection goes temporarily unavailable while operator clears skipFirewallIps.
    let branchDown = true;
    const baseFetch = env.cf.fetch;
    const wrapped: EdgeOptions = {
      ...env.options,
      fetch: async (address, init) => {
        const auth = new Headers(init?.headers).get("authorization") ?? "";
        if (branchDown && auth.includes(TOKEN_2)) {
          return new Response(JSON.stringify({ success: false, errors: [{ code: 500, message: "Upstream outage" }] }), { status: 503 });
        }
        return baseFetch(address, init);
      },
    };
    const clearReview = await saveCloudflareEdge({
      defaults: { ...DEFAULT_EDGE_DEFAULTS, skipFirewallIps: [] },
    }, wrapped);
    expect(clearReview.review).toBeDefined();
    await confirmCloudflareEdge(clearReview.review!.token, wrapped);

    // Alpha's skip rule is removed; Beta is temporarily absent from reachable zones but tracked for cleanup.
    expect(env.cf.rulesets.get(`${zoneA.id}:http_request_firewall_custom`)!.rules).toEqual([]);
    expect(edgePageView(wrapped).zones.map((z) => z.zoneName)).toEqual(["alpha.example"]);
    const statusRaw = JSON.parse(readFileSync(join(env.dir, "firewall", "cloudflare-edge-status.json"), "utf8"));
    expect(statusRaw.trackedManagedRules[zoneB.id]).toContain("skip");
    expect(statusRaw.trackedManagedRules[zoneA.id] ?? []).not.toContain("skip");

    // Branch recovers: check reads Beta's WAF phase, detects leftover clp_fw_skip, and holds it as needs_review (NOT synced).
    branchDown = false;
    const afterRecovery = await checkCloudflareEdge(wrapped);
    expect(afterRecovery.held).toBe(1);
    const betaView = edgePageView(wrapped).zones.find((z) => z.zoneName === "beta.example")!;
    expect(betaView.status).toBe("needs_review");
    expect(betaView.changes.some((c) => c.action === "delete" && c.subject === "WAF skip rule")).toBe(true);

    // Confirming per-zone review deletes Beta's stale WAF skip rule and clears its cleanup marker.
    const betaReview = await reviewCloudflareEdgeZone(betaView.zoneKey, wrapped);
    await confirmCloudflareEdge(betaReview.review!.token, wrapped);
    expect(env.cf.rulesets.get(`${zoneB.id}:http_request_firewall_custom`)!.rules).toEqual([]);
    const statusAfterCleanup = JSON.parse(readFileSync(join(env.dir, "firewall", "cloudflare-edge-status.json"), "utf8"));
    expect(statusAfterCleanup.trackedManagedRules[zoneB.id] ?? []).not.toContain("skip");

    // Next check skips the WAF phase for both zones.
    const wafCallsBefore = env.cf.calls.filter((c) => c.path.includes("http_request_firewall_custom")).length;
    await checkCloudflareEdge(wrapped);
    expect(env.cf.calls.filter((c) => c.path.includes("http_request_firewall_custom")).length).toBe(wafCallsBefore);
  });

  test("renders focused first-run card when unconfigured and full edge controls once connected, with valid client JS", () => {
    const base = {
      sites: [],
      autoEnableNewSites: false,
      visitorIp: { enabled: true, applied: true, problem: "" },
      protocols: { available: true, enabled: true, protocols: {}, udpPorts: [] },
      hetzner: { state: "absent" as const },
      netcup: { state: "absent" as const },
      panelGate: { error: "not read" },
      cloudflare: { connections: [], templates: tokenTemplates(DEFAULT_EDGE_DEFAULTS), serverIps: [], dnsEnabled: false },
    };
    const unconfigured = dashboardView({
      ...base,
      cloudflareEdge: {
        connected: false, defaults: DEFAULT_EDGE_DEFAULTS, approved: false, approvedAt: null,
        needsApproval: false, migrationNote: null, checkedAt: null, zones: [], log: [],
      },
    });
    expect(unconfigured).toContain("Cloudflare edge defaults");
    expect(unconfigured).not.toContain('id="fw-edge-form"');
    expect(unconfigured).not.toContain('id="fw-edge-zones-card"');

    const midSetup = dashboardView({
      ...base,
      cloudflare: { ...base.cloudflare, connections: [{ id: "cf-1", label: "Agency", active: true, status: "active", accounts: [], zones: 1, error: null, hasToken: true, access: null }] },
      cloudflareEdge: {
        connected: true, defaults: DEFAULT_EDGE_DEFAULTS, approved: false, approvedAt: null,
        needsApproval: true, migrationNote: null, checkedAt: null, zones: [], log: [],
      },
    });
    expect(midSetup).toContain('id="fw-edge-approval-banner"');
    expect(midSetup).toContain('id="fw-edge-form"');
    expect(midSetup).toContain("Review and approve defaults");
    expect(() => new Function(CLIENT_JS)).not.toThrow();
  });

  test("reports partial edge zone reach and flags Zone WAF: Edit as missing once skipFirewallIps is approved", async () => {
    const env = makeEnv();
    const secondAccount = env.cf.account("Client");
    env.cf.zone("example.com", env.agency);
    env.cf.zone("example.org", secondAccount);
    env.cf.token(TOKEN_2, {
      owner: "user",
      accounts: [env.agency, secondAccount],
      policies: [
        policy(["Zone Read", "Config Settings Write", "API Tokens Read"], ALL_ZONES),
        policy(["Zone Settings Write"], { [`com.cloudflare.api.account.${env.agency}`]: ALL_ZONES }),
      ],
    });
    await env.connect(TOKEN_2, "Partial");

    const beforeSkip = cloudflareConnectionViews(
      readEdgeConfig(env.options).defaults,
      { includeDns: false, includeEdge: true, requirePanelGate: false },
      env.cfPaths,
    ).connections;
    const accessBefore = beforeSkip[0]!.access!;
    expect(accessBefore.rows.find((row) => row.label === "Zone Settings: Edit")).toMatchObject({
      held: "some",
      detail: "Not on example.org",
    });
    expect(accessBefore.rows.find((row) => row.label === "Zone WAF: Edit")?.optional).toBe(true);
    // Unapproved defaults do not raise Setup Action needed for token edge permissions yet.
    expect(edgeActionNeeded(env.options)).toEqual([]);

    // Save defaults with skipFirewallIps and approve.
    const review = await saveCloudflareEdge({
      approve: true,
      defaults: { ...DEFAULT_EDGE_DEFAULTS, skipFirewallIps: ["203.0.113.7"] },
    }, env.options);
    await confirmCloudflareEdge(review.review!.token, env.options);

    const afterSkip = cloudflareConnectionViews(
      readEdgeConfig(env.options).defaults,
      { includeDns: false, includeEdge: true, requirePanelGate: false },
      env.cfPaths,
    ).connections;
    expect(afterSkip[0]!.access!.rows.find((row) => row.label === "Zone WAF: Edit")).toMatchObject({
      held: "no",
      usedFor: "Cloudflare edge: WAF skip list",
    });
    expect(afterSkip[0]!.access!.rows.find((row) => row.label === "Zone WAF: Edit")?.optional).toBeUndefined();

    const actions = edgeActionNeeded(env.options);
    expect(actions.some((item) => item.title.includes("Cloudflare token needs") && item.reason.includes("Zone Settings: Edit") && item.reason.includes("Zone WAF: Edit"))).toBe(true);
  });
});

describe("Upgrade migration from DNS profile zone options", () => {
  function setupMigrationDir() {
    const dir = mkdtempSync(join(tmpdir(), "clp-edge-mig-"));
    dirs.push(dir);
    mkdirSync(join(dir, "dns"), { recursive: true });
    mkdirSync(join(dir, "cloudflare"), { recursive: true });
    const paths = {
      dnsPolicy: join(dir, "dns", "policy.json"),
      dnsConfig: join(dir, "dns.conf"),
      cloudflareStateDir: join(dir, "cloudflare"),
      firewallConfig: join(dir, "firewall.conf"),
      firewallPolicy: join(dir, "firewall", "policy.json"),
      firewallStateDir: join(dir, "firewall"),
      edgeConfig: join(dir, "firewall", "cloudflare-edge.json"),
      visitorIpState: join(dir, "firewall", "visitor-ip.json"),
      rootUid: uid,
      now: () => Date.parse("2026-11-27T12:00:00Z"),
    };
    return { dir, paths };
  }

  test("migrates active DNS zone options as approved when DNS was Automatic, enables Firewall safely, and rolls back cleanly", () => {
    const { paths } = setupMigrationDir();
    writeFileSync(paths.dnsConfig, "enabled\n");
    writeFileSync(join(paths.cloudflareStateDir, "connections.json"), JSON.stringify({
      version: 1, connections: [{ id: "cf-1111aaaa", label: "Agency" }],
    }), { mode: 0o600 });
    const legacyPolicy = `${JSON.stringify({
      version: 1,
      automatic: true,
      defaultProfileId: "web",
      assignments: { "example.com": "web-mailcow" },
      panelHost: "panel.example.com",
      profiles: [
        { id: "web", name: "Web", records: [], mailcow: false, zone: { ssl: "strict", alwaysHttps: true, acmeFullSsl: true, webmailFullSsl: false, skipFirewallIps: ["2001:db8::1", "203.0.113.7"] } },
        { id: "web-mailcow", name: "Web and Mailcow", records: [], mailcow: true, zone: { ssl: "strict", alwaysHttps: true, acmeFullSsl: true, webmailFullSsl: true, skipFirewallIps: ["203.0.113.7", "2001:db8::1"] } },
        { id: "unused", name: "Unused", records: [], mailcow: false, zone: { ssl: "flexible", alwaysHttps: false, acmeFullSsl: false, webmailFullSsl: false, skipFirewallIps: [] } },
      ],
    }, null, 2)}\n`;
    writeFileSync(paths.dnsPolicy, legacyPolicy, { mode: 0o600 });

    expect(cloudflareEdgeMigrationPending(paths)).toBe(true);
    let enabled = false;
    const undo = migrateCloudflareEdgeFromDns(() => {
      enabled = true;
      writeFileSync(paths.firewallConfig, "enabled\n", { mode: 0o640 });
    }, paths);
    expect(undo).not.toBeNull();
    expect(enabled).toBe(true);
    expect(cloudflareEdgeMigrationPending(paths)).toBe(false);

    // Unused profile's flexible SSL did not pollute active consensus.
    const migrated = readEdgeConfig({ paths: { stateDir: paths.firewallStateDir, rootUid: uid } });
    expect(migrated.approved).toBe(true);
    expect(migrated.migrationNote).toBeNull();
    expect(migrated.defaults).toEqual({
      ssl: "strict",
      alwaysHttps: true,
      acmeFullSsl: true,
      webmailFullSsl: true,
      skipFirewallIps: ["2001:db8::1", "203.0.113.7"],
    });

    // Newly auto-enabled Firewall writes visitor-ip.json as disabled so Nginx files stay untouched.
    expect(JSON.parse(readFileSync(paths.visitorIpState, "utf8"))).toEqual({ version: 1, enabled: false });

    // Legacy `zone` keys are stripped from dns/policy.json and second run is a no-op.
    const cleanedDns = JSON.parse(readFileSync(paths.dnsPolicy, "utf8"));
    expect(cleanedDns.profiles.every((p: Record<string, unknown>) => !Object.hasOwn(p, "zone"))).toBe(true);
    expect(migrateCloudflareEdgeFromDns(() => {}, paths)).toBeNull();

    // Rollback restores exact prior files and removes newly created state.
    undo!();
    expect(readFileSync(paths.dnsPolicy, "utf8")).toBe(legacyPolicy);
    expect(existsSync(paths.edgeConfig)).toBe(false);
    expect(existsSync(paths.firewallConfig)).toBe(false);
    expect(existsSync(paths.visitorIpState)).toBe(false);
  });

  test("leaves disagreeing SSL/Always-HTTPS unset and unapproved with a migration note so live zones are never changed", () => {
    const { paths } = setupMigrationDir();
    writeFileSync(paths.dnsConfig, "enabled\n");
    writeFileSync(paths.firewallConfig, "enabled\n");
    writeFileSync(join(paths.cloudflareStateDir, "connections.json"), JSON.stringify({
      version: 1, connections: [{ id: "cf-1111aaaa", label: "Agency" }],
    }), { mode: 0o600 });
    writeFileSync(paths.dnsPolicy, JSON.stringify({
      version: 1,
      automatic: true,
      assignments: { "a.example": "strict-prof", "b.example": "full-prof" },
      profiles: [
        { id: "strict-prof", name: "Strict", records: [], mailcow: false, zone: { ssl: "strict", alwaysHttps: true, acmeFullSsl: true, webmailFullSsl: false, skipFirewallIps: [] } },
        { id: "full-prof", name: "Full", records: [], mailcow: false, zone: { ssl: "full", alwaysHttps: false, acmeFullSsl: false, webmailFullSsl: false, skipFirewallIps: [] } },
      ],
    }), { mode: 0o600 });

    const undo = migrateCloudflareEdgeFromDns(() => {}, { ...paths, firewallWasEnabled: true });
    expect(undo).not.toBeNull();
    const migrated = readEdgeConfig({ paths: { stateDir: paths.firewallStateDir, rootUid: uid } });
    expect(migrated.approved).toBe(false);
    expect(migrated.defaults.ssl).toBeNull();
    expect(migrated.defaults.alwaysHttps).toBeNull();
    expect(migrated.defaults.acmeFullSsl).toBe(true);
    expect(migrated.migrationNote).toContain("disagreed on SSL/TLS mode");
    expect(migrated.migrationNote).toContain("Always Use HTTPS");
  });

  test("treats unmanaged (null or omitted) SSL/Always-HTTPS beside a set profile as a disagreement and leaves unapproved", () => {
    const { paths } = setupMigrationDir();
    writeFileSync(paths.dnsConfig, "enabled\n");
    writeFileSync(paths.firewallConfig, "enabled\n");
    writeFileSync(join(paths.cloudflareStateDir, "connections.json"), JSON.stringify({
      version: 1, connections: [{ id: "cf-1111aaaa", label: "Agency" }],
    }), { mode: 0o600 });
    writeFileSync(paths.dnsPolicy, JSON.stringify({
      version: 1,
      automatic: true,
      assignments: { "a.example": "managed", "b.example": "unmanaged" },
      profiles: [
        { id: "managed", name: "Managed", records: [], mailcow: false, zone: { ssl: "strict", alwaysHttps: true, acmeFullSsl: true, webmailFullSsl: false, skipFirewallIps: [] } },
        { id: "unmanaged", name: "Unmanaged", records: [], mailcow: false, zone: { ssl: null, acmeFullSsl: false, webmailFullSsl: false, skipFirewallIps: [] } },
      ],
    }), { mode: 0o600 });

    const undo = migrateCloudflareEdgeFromDns(() => {}, { ...paths, firewallWasEnabled: true });
    expect(undo).not.toBeNull();
    const migrated = readEdgeConfig({ paths: { stateDir: paths.firewallStateDir, rootUid: uid } });
    expect(migrated.approved).toBe(false);
    expect(migrated.defaults.ssl).toBeNull();
    expect(migrated.defaults.alwaysHttps).toBeNull();
    expect(migrated.migrationNote).toContain("Leave as it is");
    expect(migrated.migrationNote).toContain("SSL/TLS mode");
    expect(migrated.migrationNote).toContain("Always Use HTTPS");
  });

  test("refuses skipFirewallIps overflow above 20 without modifying dns/policy.json, while migrating 20", () => {
    const { paths } = setupMigrationDir();
    writeFileSync(paths.dnsConfig, "enabled\n");
    writeFileSync(join(paths.cloudflareStateDir, "connections.json"), JSON.stringify({
      version: 1, connections: [{ id: "cf-1111aaaa", label: "Agency" }],
    }), { mode: 0o600 });
    const ipsA = Array.from({ length: 11 }, (_, i) => `198.51.100.${i + 1}`);
    const ipsB = Array.from({ length: 11 }, (_, i) => `203.0.113.${i + 1}`);
    const overflowPolicy = JSON.stringify({
      version: 1,
      automatic: true,
      assignments: { "a.example": "p1", "b.example": "p2" },
      profiles: [
        { id: "p1", name: "P1", records: [], mailcow: false, zone: { ssl: "strict", alwaysHttps: true, acmeFullSsl: true, webmailFullSsl: false, skipFirewallIps: ipsA } },
        { id: "p2", name: "P2", records: [], mailcow: false, zone: { ssl: "strict", alwaysHttps: true, acmeFullSsl: true, webmailFullSsl: false, skipFirewallIps: ipsB } },
      ],
    });
    writeFileSync(paths.dnsPolicy, overflowPolicy, { mode: 0o600 });

    expect(() => migrateCloudflareEdgeFromDns(() => {}, paths)).toThrow("22 distinct WAF skip IPs");
    expect(readFileSync(paths.dnsPolicy, "utf8")).toBe(overflowPolicy);
    expect(existsSync(paths.edgeConfig)).toBe(false);

    // Trimming to 20 distinct IPs migrates, but the combined list of two different ones waits for approval.
    const exact20Policy = JSON.stringify({
      version: 1,
      automatic: true,
      assignments: { "a.example": "p1", "b.example": "p2" },
      profiles: [
        { id: "p1", name: "P1", records: [], mailcow: false, zone: { ssl: "strict", alwaysHttps: true, acmeFullSsl: true, webmailFullSsl: false, skipFirewallIps: ipsA.slice(0, 10) } },
        { id: "p2", name: "P2", records: [], mailcow: false, zone: { ssl: "strict", alwaysHttps: true, acmeFullSsl: true, webmailFullSsl: false, skipFirewallIps: ipsB.slice(0, 10) } },
      ],
    });
    writeFileSync(paths.dnsPolicy, exact20Policy, { mode: 0o600 });
    const undo = migrateCloudflareEdgeFromDns(() => {}, { ...paths, firewallWasEnabled: true });
    expect(undo).not.toBeNull();
    const migrated = readEdgeConfig({ paths: { stateDir: paths.firewallStateDir, rootUid: uid } });
    expect(migrated.defaults.skipFirewallIps).toHaveLength(20);
    expect(migrated.approved).toBe(false);
    expect(migrated.migrationNote).toContain("different WAF skip lists");
  });

  test("does not approve a combined WAF skip list when legacy profiles listed different IPs, or none beside some", () => {
    const migrate = (lists: string[][]) => {
      const { paths } = setupMigrationDir();
      writeFileSync(paths.dnsConfig, "enabled\n");
      writeFileSync(paths.firewallConfig, "enabled\n");
      writeFileSync(join(paths.cloudflareStateDir, "connections.json"), JSON.stringify({
        version: 1, connections: [{ id: "cf-1111aaaa", label: "Agency" }],
      }), { mode: 0o600 });
      writeFileSync(paths.dnsPolicy, JSON.stringify({
        version: 1,
        automatic: true,
        assignments: Object.fromEntries(lists.map((_, i) => [`s${i}.example`, `p${i}`])),
        profiles: lists.map((skipFirewallIps, i) => ({
          id: `p${i}`, name: `P${i}`, records: [], mailcow: false,
          zone: { ssl: "strict", alwaysHttps: true, acmeFullSsl: true, webmailFullSsl: false, skipFirewallIps },
        })),
      }), { mode: 0o600 });
      migrateCloudflareEdgeFromDns(() => {}, { ...paths, firewallWasEnabled: true });
      return readEdgeConfig({ paths: { stateDir: paths.firewallStateDir, rootUid: uid } });
    };
    const different = migrate([["203.0.113.7"], ["198.51.100.9"]]);
    expect(different.approved).toBe(false);
    expect(different.defaults.skipFirewallIps).toEqual(["198.51.100.9", "203.0.113.7"]);
    expect(different.migrationNote).toContain("different WAF skip lists");
    expect(migrate([["203.0.113.7"], []]).approved).toBe(false);
    const same = migrate([["203.0.113.7"], ["203.0.113.7"]]);
    expect(same.approved).toBe(true);
    expect(same.migrationNote).toBeNull();
    expect(migrate([[], []]).approved).toBe(true);
  });

  test("does not approve migrated defaults when DNS was disabled even if policy.json had automatic: true", () => {
    const { paths } = setupMigrationDir();
    // DNS config intentionally absent (DNS disabled), Firewall already enabled.
    writeFileSync(paths.firewallConfig, "enabled\n");
    writeFileSync(join(paths.cloudflareStateDir, "connections.json"), JSON.stringify({
      version: 1, connections: [{ id: "cf-1111aaaa", label: "Agency" }],
    }), { mode: 0o600 });
    writeFileSync(paths.dnsPolicy, JSON.stringify({
      version: 1,
      automatic: true,
      defaultProfileId: "web",
      assignments: { "example.com": "web" },
      profiles: [
        { id: "web", name: "Web", records: [], mailcow: false, zone: { ssl: "strict", alwaysHttps: true, acmeFullSsl: true, webmailFullSsl: false, skipFirewallIps: ["203.0.113.7"] } },
      ],
    }), { mode: 0o600 });

    const undo = migrateCloudflareEdgeFromDns(() => {}, { ...paths, firewallWasEnabled: true });
    expect(undo).not.toBeNull();
    const migrated = readEdgeConfig({ paths: { stateDir: paths.firewallStateDir, rootUid: uid } });
    expect(migrated.approved).toBe(false);
    expect(migrated.defaults.ssl).toBe("strict");
    expect(migrated.defaults.skipFirewallIps).toEqual(["203.0.113.7"]);
  });

  test("migrates active v2 assignments, redirects, and split v1->v2 redirect zone options without false disagreement", () => {
    const { paths } = setupMigrationDir();
    writeFileSync(paths.dnsConfig, "enabled\n");
    writeFileSync(paths.firewallConfig, "enabled\n");
    writeFileSync(join(paths.cloudflareStateDir, "connections.json"), JSON.stringify({
      version: 1, connections: [{ id: "cf-1111aaaa", label: "Agency" }],
    }), { mode: 0o600 });

    // v2 policy where an active site combines a legacy-zone HTTP profile with a new zone-less Mail profile,
    // and the redirect's domain has a split Mail profile carrying legacy `ssl: "full"`; the v1 redirect DNS's save
    // kept for Redirects still names its v1 profile. DNS's v2 save writes `zone` only from v1 profiles in use,
    // so the unused `web` profile has none.
    writeFileSync(paths.dnsPolicy, JSON.stringify({
      version: 2,
      automatic: true,
      defaultHttpProfileId: null,
      defaultMailProfileId: null,
      assignments: { "site.example.com": { http: "custom-http", mail: "google" }, "old.example.org": { http: null, mail: "redirect-mail" } },
      redirects: [{ source: "old.example.org", target: "https://site.example.com", status: 301, keepPath: true, keepQuery: true, profileId: "redirect" }],
      profiles: [
        { id: "web", name: "Web", role: "http", records: [], mailcow: false },
        { id: "custom-http", name: "Custom HTTP", role: "http", records: [], mailcow: false, zone: { ssl: "full", alwaysHttps: true, acmeFullSsl: true, webmailFullSsl: false, skipFirewallIps: ["203.0.113.7"] } },
        { id: "redirect-mail", name: "Redirect Mail", role: "mail", records: [], mailcow: false, zone: { ssl: "full", alwaysHttps: true, acmeFullSsl: false, webmailFullSsl: true, skipFirewallIps: ["203.0.113.7"] } },
        { id: "google", name: "Google Workspace", role: "mail", records: [], mailcow: false },
      ],
    }), { mode: 0o600 });

    const undo = migrateCloudflareEdgeFromDns(() => {}, { ...paths, firewallWasEnabled: true });
    expect(undo).not.toBeNull();
    const migrated = readEdgeConfig({ paths: { stateDir: paths.firewallStateDir, rootUid: uid } });
    expect(migrated.approved).toBe(true);
    expect(migrated.migrationNote).toBeNull();
    expect(migrated.defaults).toEqual({
      ssl: "full",
      alwaysHttps: true,
      acmeFullSsl: true,
      webmailFullSsl: true,
      skipFirewallIps: ["203.0.113.7"],
    });
  });

  test("refuses untrusted symlinked dns/policy.json without touching Firewall state", () => {
    const { dir, paths } = setupMigrationDir();
    const target = join(dir, "real.json");
    writeFileSync(target, JSON.stringify({ version: 1, profiles: [{ id: "web", zone: { ssl: "strict" } }] }), { mode: 0o600 });
    symlinkSync(target, paths.dnsPolicy);
    expect(() => migrateCloudflareEdgeFromDns(() => {}, paths)).toThrow("were not moved to Firewall");
    expect(existsSync(paths.edgeConfig)).toBe(false);
  });
});

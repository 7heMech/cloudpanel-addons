import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_MAINTENANCE_TEMPLATE, executeMaintenanceAction, MAX_TEMPLATE_BYTES, purgeVarnish,
  type MaintenanceActionPaths, type MaintenanceStatus,
} from "../addons/maintenance/action";
import { handle as handleMaintenance } from "../addons/maintenance/app/index";
import { maintenanceService } from "../addons/maintenance/app/service";
import { fleetView } from "../addons/maintenance/app/views";
import { MAINTENANCE_TARGETS } from "../addons/maintenance/inject/targets";
import {
  inspectNginxMaintenance, NGINX_MAINTENANCE_BLOCK, reconcileNginxMaintenance,
} from "../cli/inject";
import { MAINTENANCE_ALLOWED_VERBS } from "../lib/gateway-protocol";

function fixture(domain = "example.com"): { root: string; paths: MaintenanceActionPaths } {
  const root = mkdtempSync(join(tmpdir(), "clp-maintenance-"));
  const panelDb = join(root, "panel.db");
  const db = new Database(panelDb);
  db.run("CREATE TABLE site (id INTEGER PRIMARY KEY, domain_name TEXT)");
  db.query("INSERT INTO site (domain_name) VALUES (?)").run(domain);
  db.close();
  const identity = join(root, "panel-identity.conf");
  writeFileSync(identity, "PRIMARY=panel.example.test\nALIASES=\n", { mode: 0o600 });
  return {
    root,
    paths: { dataDir: join(root, "data"), lockDir: join(root, "locks"), panelDb, panelIdentityFile: identity },
  };
}

const actionOptions = <T extends Record<string, unknown>>(paths: MaintenanceActionPaths, extra?: T) => ({
  paths,
  rootUid: 0,
  domainValidator: (value: string) => value.toLowerCase().replace(/\.$/, ""),
  ...(extra ?? {}),
});

test("maintenance actions toggle atomically, manage a passive template, and replace IP bypasses", async () => {
  const { root, paths } = fixture();
  try {
    const initial = await executeMaintenanceAction(["status", "--domain=example.com"], actionOptions(paths)) as MaintenanceStatus;
    expect(initial).toEqual({ domain: "example.com", enabled: false, customTemplate: false, bypasses: [] });

    const enabled = await executeMaintenanceAction(["enable", "--domain=EXAMPLE.COM."], actionOptions(paths)) as MaintenanceStatus;
    expect(enabled.enabled).toBe(true);
    expect(lstatSync(join(paths.dataDir, "example.com", "on")).isFile()).toBe(true);
    expect(readFileSync(join(paths.dataDir, "default.html"), "utf8")).toBe(DEFAULT_MAINTENANCE_TEMPLATE);

    const unsafe = '<!doctype html><meta http-equiv="ref&#x72;esh" content="0;url=https://bad.test"><h1 onclick="steal()">Hello</h1><script>steal()</script><form><input></form><svg><a xlink:href="javascript:steal()">link</a></svg>';
    const custom = await executeMaintenanceAction(["set-template", "--domain=example.com"], actionOptions(paths, { input: unsafe })) as { html: string };
    expect(custom.html).toContain("<h1>Hello</h1>");
    expect(custom.html).not.toMatch(/script|onclick|form|input|http-equiv|javascript/i);
    expect(readFileSync(join(paths.dataDir, "example.com", "maintenance.html"), "utf8")).toBe(custom.html);

    const bypassed = await executeMaintenanceAction(["set-bypass", "--domain=example.com"], actionOptions(paths, {
      input: JSON.stringify({ ips: ["203.0.113.8", "2001:0db8:0:0:0:0:0:1", "203.0.113.8"] }),
    })) as MaintenanceStatus;
    expect(bypassed.bypasses).toEqual(["2001:db8::1", "203.0.113.8"]);
    expect(existsSync(join(paths.dataDir, "example.com", "bypass_2001:db8::1"))).toBe(true);

    await expect(executeMaintenanceAction(["set-bypass", "--domain=example.com"], actionOptions(paths, {
      input: JSON.stringify({ ips: ["198.51.100.9"] }),
      writeAtomicFn: () => { throw new Error("simulated staging failure"); },
    }))).rejects.toThrow("simulated staging failure");
    const preserved = await executeMaintenanceAction(["status", "--domain=example.com"], actionOptions(paths)) as MaintenanceStatus;
    expect(preserved.bypasses).toEqual(["2001:db8::1", "203.0.113.8"]);

    const reset = await executeMaintenanceAction(["reset-template", "--domain=example.com"], actionOptions(paths)) as { custom: boolean; html: string };
    expect(reset.custom).toBe(false);
    expect(reset.html).toBe(DEFAULT_MAINTENANCE_TEMPLATE);

    const disabled = await executeMaintenanceAction(["disable", "--domain=example.com"], actionOptions(paths)) as MaintenanceStatus;
    expect(disabled.enabled).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("maintenance actions reject unknown sites and oversized templates", async () => {
  const { root, paths } = fixture();
  try {
    await expect(executeMaintenanceAction(["enable", "--domain=missing.example.com"], actionOptions(paths))).rejects.toThrow("site not found");
    await expect(executeMaintenanceAction(["set-template", "--domain=example.com"], actionOptions(paths, {
      input: "x".repeat(MAX_TEMPLATE_BYTES + 1),
    }))).rejects.toThrow("at most");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("maximum-length domains use bounded bypass lock filenames", async () => {
  const domain = ["a".repeat(63), "b".repeat(63), "c".repeat(63), "d".repeat(61)].join(".");
  expect(domain.length).toBe(253);
  const { root, paths } = fixture(domain);
  try {
    await executeMaintenanceAction(["set-bypass", `--domain=${domain}`], actionOptions(paths, {
      input: JSON.stringify({ ips: ["203.0.113.8"] }),
    }));
    const lockFiles = readdirSync(paths.lockDir);
    expect(lockFiles).toHaveLength(1);
    expect(lockFiles[0]).toMatch(/^maintenance-[0-9a-f]{64}\.lock$/);
    expect(Buffer.byteLength(lockFiles[0]!, "utf8")).toBeLessThanOrEqual(255);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("global-settings reconciliation is idempotent, drift-gated, and reversible", () => {
  const root = mkdtempSync(join(tmpdir(), "clp-maintenance-nginx-"));
  const settingsPath = join(root, "global_settings");
  const stateDir = join(root, "state");
  const original = "client_max_body_size 128m;";
  writeFileSync(settingsPath, original);
  try {
    const installed = reconcileNginxMaintenance({ settingsPath, stateDir, reload: false });
    expect(installed).toMatchObject({ state: "ok", changed: true });
    expect(readFileSync(settingsPath, "utf8")).toContain(NGINX_MAINTENANCE_BLOCK);
    expect(inspectNginxMaintenance({ settingsPath, stateDir }).state).toBe("ok");

    expect(reconcileNginxMaintenance({ settingsPath, stateDir, reload: false }).changed).toBe(false);
    writeFileSync(settingsPath, readFileSync(settingsPath, "utf8").replace(original, `${original}\nserver_tokens off;`));
    const drift = reconcileNginxMaintenance({ settingsPath, stateDir, reload: false });
    expect(drift.state).toBe("upstream-changed");
    expect(drift.changed).toBe(false);

    writeFileSync(settingsPath, `${original}\n${NGINX_MAINTENANCE_BLOCK}\n`);
    const removed = reconcileNginxMaintenance({ settingsPath, stateDir, enabled: false, reload: false });
    expect(removed).toMatchObject({ state: "missing", changed: true });
    expect(readFileSync(settingsPath, "utf8")).toBe(original);
    expect(existsSync(stateDir) ? Bun.file(join(stateDir, "global-settings.sha256")).size : 0).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("global-settings reconciliation never adopts an unverified marked block", () => {
  const root = mkdtempSync(join(tmpdir(), "clp-maintenance-unowned-"));
  const settingsPath = join(root, "global_settings");
  const stateDir = join(root, "state");
  const unowned = "client_max_body_size 128m;\n# clp-addons:maintenance:start\nreturn 503;\n# clp-addons:maintenance:end\n";
  writeFileSync(settingsPath, unowned);
  try {
    expect(reconcileNginxMaintenance({ settingsPath, stateDir, reload: false })).toMatchObject({
      state: "conflict", changed: false,
    });
    expect(reconcileNginxMaintenance({ settingsPath, stateDir, enabled: false, reload: false })).toMatchObject({
      state: "conflict", changed: false,
    });
    expect(inspectNginxMaintenance({ settingsPath, stateDir }).state).toBe("conflict");
    expect(readFileSync(settingsPath, "utf8")).toBe(unowned);
    expect(existsSync(stateDir)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("template API accepts JSON escaping overhead and enforces the decoded UTF-8 limit", async () => {
  const token = "maintenance-test-token";
  const original = maintenanceService.setTemplate;
  let received = "";
  maintenanceService.setTemplate = async (domain, html) => {
    received = html;
    return { ok: true, data: { domain, custom: true, html } };
  };
  const request = (template: string) => new Request("https://panel.example.test:8443/addons/maintenance/api/sites/example.com/template", {
    method: "PUT",
    body: JSON.stringify({ html: template }),
    headers: {
      "content-type": "application/json",
      cookie: `clp_addons_csrf=${token}`,
      host: "panel.example.test:8443",
      origin: "https://panel.example.test:8443",
      "x-clp-addons-csrf": token,
    },
  });
  try {
    const escaped = "\n".repeat(MAX_TEMPLATE_BYTES);
    const accepted = await handleMaintenance(request(escaped), "/api/sites/example.com/template");
    expect(accepted.status).toBe(200);
    expect(received).toBe(escaped);

    received = "";
    const rejected = await handleMaintenance(request("x".repeat(MAX_TEMPLATE_BYTES + 1)), "/api/sites/example.com/template");
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ ok: false, error: `html may be at most ${MAX_TEMPLATE_BYTES} bytes` });
    expect(received).toBe("");
  } finally {
    maintenanceService.setTemplate = original;
  }
});

test("fleet overview separates unavailable sites from the live count", () => {
  const rendered = fleetView([
    { domain: "maintenance.example.com", type: "php", user: "one", enabled: true, customTemplate: false, bypasses: [] },
    { domain: "live.example.com", type: "static", user: "two", enabled: false, customTemplate: false, bypasses: [] },
    { domain: "unknown.example.com", type: "nodejs", user: "three", enabled: false, customTemplate: false, bypasses: [], error: "status unavailable" },
  ]);
  expect(rendered).toContain(">Unavailable</span>");
  expect(rendered).toContain('<div class="label">In maintenance</div><div class="value">1</div>');
  expect(rendered).toContain('<div class="label">Live</div><div class="value">1</div>');
});

test("fleet overview renders global maintenance toggle with aggregate state", () => {
  // All enabled -> bulk toggle is checked and not disabled
  const allEnabled = fleetView([
    { domain: "one.example.com", type: "php", user: "one", enabled: true, customTemplate: false, bypasses: [] },
    { domain: "two.example.com", type: "static", user: "two", enabled: true, customTemplate: false, bypasses: [] },
  ]);
  expect(allEnabled).toContain('<div class="bulk-toggle">');
  expect(allEnabled).toContain('<label for="bulk-toggle">All sites</label>');
  expect(allEnabled).toContain('<input type="checkbox" id="bulk-toggle" checked');
  expect(allEnabled).not.toContain('<input type="checkbox" id="bulk-toggle" checked disabled');

  // None enabled -> bulk toggle is not checked and not disabled
  const noneEnabled = fleetView([
    { domain: "one.example.com", type: "php", user: "one", enabled: false, customTemplate: false, bypasses: [] },
    { domain: "two.example.com", type: "static", user: "two", enabled: false, customTemplate: false, bypasses: [] },
  ]);
  expect(noneEnabled).toContain('<input type="checkbox" id="bulk-toggle"');
  expect(noneEnabled).not.toContain('id="bulk-toggle" checked');
  expect(noneEnabled).not.toContain('id="bulk-toggle" disabled');

  // Mixed state -> bulk toggle is not checked and not disabled
  const mixed = fleetView([
    { domain: "one.example.com", type: "php", user: "one", enabled: true, customTemplate: false, bypasses: [] },
    { domain: "two.example.com", type: "static", user: "two", enabled: false, customTemplate: false, bypasses: [] },
    { domain: "err.example.com", type: "php", user: "three", enabled: false, customTemplate: false, bypasses: [], error: "unavailable" },
  ]);
  expect(mixed).toContain('<input type="checkbox" id="bulk-toggle"');
  expect(mixed).not.toContain('id="bulk-toggle" checked');
  expect(mixed).not.toContain('id="bulk-toggle" disabled');

  // Empty fleet -> bulk toggle is disabled
  const emptyFleet = fleetView([]);
  expect(emptyFleet).toContain('<input type="checkbox" id="bulk-toggle"');
  expect(emptyFleet).toContain('disabled');

  // Only unavailable sites -> bulk toggle is disabled
  const unavailableOnly = fleetView([
    { domain: "err.example.com", type: "php", user: "one", enabled: false, customTemplate: false, bypasses: [], error: "unavailable" },
  ]);
  expect(unavailableOnly).toContain('<input type="checkbox" id="bulk-toggle"');
  expect(unavailableOnly).toContain('disabled');
});

test("bulk toggle API guards mutations and toggles all available sites", async () => {
  const token = "bulk-test-csrf-token";
  const request = (path: string, body: unknown, headers?: Record<string, string>) => new Request(`https://panel.example.test:8443/addons/maintenance${path}`, {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      cookie: `clp_addons_csrf=${token}`,
      host: "panel.example.test:8443",
      origin: "https://panel.example.test:8443",
      "x-clp-addons-csrf": token,
      ...headers,
    },
  });

  // Rejects mutations without CSRF
  const noCsrf = await handleMaintenance(new Request("https://panel.example.test:8443/addons/maintenance/api/sites/toggle", {
    method: "POST",
    body: JSON.stringify({ enabled: true }),
    headers: { "content-type": "application/json" },
  }), "/api/sites/toggle");
  expect(noCsrf.status).toBe(403);

  // Rejects non-boolean enabled
  const badBody = await handleMaintenance(request("/api/sites/toggle", { enabled: "yes" }), "/api/sites/toggle");
  expect(badBody.status).toBe(400);
  expect(await badBody.json()).toMatchObject({ ok: false, error: "enabled must be a boolean" });

  // Rejects invalid JSON
  const badJson = await handleMaintenance(request("/api/sites/toggle", "{invalid"), "/api/sites/toggle");
  expect(badJson.status).toBe(400);

  // Mock setAllEnabled to verify successful bulk toggle
  const origSetAll = maintenanceService.setAllEnabled;
  try {
    let lastEnabled: boolean | undefined;
    maintenanceService.setAllEnabled = async (enabled) => {
      lastEnabled = enabled;
      return {
        ok: true,
        data: {
          enabled,
          updated: ["site-a.example.com", "site-b.example.com"],
          failed: [],
        },
      };
    };

    const res = await handleMaintenance(request("/api/sites/toggle", { enabled: true }), "/api/sites/toggle");
    expect(res.status).toBe(200);
    const data = await res.json() as { ok: boolean; data: { enabled: boolean; updated: string[]; failed: unknown[] } };
    expect(lastEnabled).toBe(true);
    expect(data.ok).toBe(true);
    expect(data.data.enabled).toBe(true);
    expect(data.data.updated).toEqual(["site-a.example.com", "site-b.example.com"]);
    expect(data.data.failed).toEqual([]);

    // Also supports /api/toggle-all
    const resToggleAll = await handleMaintenance(request("/api/toggle-all", { enabled: false }), "/api/toggle-all");
    expect(resToggleAll.status).toBe(200);
    expect(lastEnabled).toBe(false);

    // Partial failure returns 200 with failed domains listed
    maintenanceService.setAllEnabled = async (enabled) => ({
      ok: true,
      data: {
        enabled,
        updated: ["site-a.example.com"],
        failed: [{ domain: "site-b.example.com", error: "permission denied" }],
      },
    });
    const partialRes = await handleMaintenance(request("/api/sites/toggle", { enabled: true }), "/api/sites/toggle");
    expect(partialRes.status).toBe(200);
    const partialData = await partialRes.json() as { ok: boolean; data: { updated: string[]; failed: { domain: string; error: string }[] } };
    expect(partialData.data.updated).toEqual(["site-a.example.com"]);
    expect(partialData.data.failed).toEqual([{ domain: "site-b.example.com", error: "permission denied" }]);
  } finally {
    maintenanceService.setAllEnabled = origSetAll;
  }
});

test("maintenanceService.setAllEnabled toggles domains and captures partial failures", async () => {
  const origSetEnabled = maintenanceService.setEnabled;
  const origPanelSites = maintenanceService.panelSites;
  try {
    maintenanceService.panelSites = async () => [
      { domain: "good.example.com", type: "php", user: "user1" } as any,
      { domain: "bad.example.com", type: "static", user: "user2" } as any,
    ];
    maintenanceService.setEnabled = async (domain, enabled) => {
      if (domain === "bad.example.com") {
        return { ok: false, error: "root action failed" };
      }
      return { ok: true, data: { domain, enabled, customTemplate: false, bypasses: [] } };
    };

    const result = await maintenanceService.setAllEnabled(true);
    expect(result.ok).toBe(true);
    expect(result.data.enabled).toBe(true);
    expect(result.data.updated).toEqual(["good.example.com"]);
    expect(result.data.failed).toEqual([{ domain: "bad.example.com", error: "root action failed" }]);
  } finally {
    maintenanceService.setEnabled = origSetEnabled;
    maintenanceService.panelSites = origPanelSites;
  }
});

test("maintenance integration preserves ACME and normalizes non-GET errors through an internal URI", () => {
  expect(NGINX_MAINTENANCE_BLOCK).toContain("$uri ~ ^/\\.well-known/acme-challenge/");
  expect(NGINX_MAINTENANCE_BLOCK).toContain("$uri = /__clp_addons_maintenance");
  expect(NGINX_MAINTENANCE_BLOCK).toContain("maintenance/$server_name/on");
  expect(NGINX_MAINTENANCE_BLOCK).not.toContain("maintenance/$host/on");
  expect(NGINX_MAINTENANCE_BLOCK).toContain("return 418;");
  expect(NGINX_MAINTENANCE_BLOCK).toContain("error_page 418 =503 /__clp_addons_maintenance;");
  expect(NGINX_MAINTENANCE_BLOCK).toContain("location = /__clp_addons_maintenance");
  expect(NGINX_MAINTENANCE_BLOCK).not.toContain("location @clp_maintenance");
  expect(NGINX_MAINTENANCE_BLOCK).not.toContain("error_page 503");
  expect(MAINTENANCE_TARGETS[0]).toMatchObject({
    slug: "site-tab",
    template: "Frontend/Site/Partial/tab-container.html.twig",
    required: true,
  });
  expect(MAINTENANCE_TARGETS[0]!.snippet("/addons/maintenance")).toContain("site.domainName|url_encode");
  expect(MAINTENANCE_ALLOWED_VERBS).toEqual(new Set([
    "status", "enable", "disable", "get-template", "set-template", "reset-template", "set-bypass",
  ]));
});

test("purgeVarnish sends PURGE requests for domain and www/bare aliases and handles failures safely", async () => {
  const purges: { url: string; method: string; host: string }[] = [];
  const mockFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    purges.push({
      url: String(input),
      method: init?.method ?? "GET",
      host: (init?.headers as Record<string, string>)?.Host ?? "",
    });
    return new Response("Purged", { status: 200 });
  };

  const success = await purgeVarnish("example.com", 6081, mockFetch as any);
  expect(success).toBe(true);
  expect(purges).toEqual([
    { url: "http://127.0.0.1:6081/", method: "PURGE", host: "example.com" },
    { url: "http://127.0.0.1:6081/", method: "PURGE", host: "www.example.com" },
  ]);

  // Strip www if starting with www
  purges.length = 0;
  const wwwSuccess = await purgeVarnish("www.example.com", 6081, mockFetch as any);
  expect(wwwSuccess).toBe(true);
  expect(purges).toEqual([
    { url: "http://127.0.0.1:6081/", method: "PURGE", host: "www.example.com" },
    { url: "http://127.0.0.1:6081/", method: "PURGE", host: "example.com" },
  ]);

  // Network/connection error returns false without throwing
  const throwingFetch = async (): Promise<Response> => {
    throw new Error("connect ECONNREFUSED 127.0.0.1:6081");
  };
  const failResult = await purgeVarnish("example.com", 6081, throwingFetch as any);
  expect(failResult).toBe(false);

  // executeMaintenanceAction enable/disable triggers purgeVarnish
  const { paths } = fixture("wp.example.com");
  purges.length = 0;
  await executeMaintenanceAction(["enable", "--domain=wp.example.com"], actionOptions(paths, { fetchFn: mockFetch as any }));
  expect(purges.some((p) => p.method === "PURGE" && p.host === "wp.example.com")).toBe(true);

  purges.length = 0;
  await executeMaintenanceAction(["disable", "--domain=wp.example.com"], actionOptions(paths, { fetchFn: mockFetch as any }));
  expect(purges.some((p) => p.method === "PURGE" && p.host === "wp.example.com")).toBe(true);
});

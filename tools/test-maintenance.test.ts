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
import { CLIENT_JS, fleetView, layout, siteView } from "../addons/maintenance/app/views";
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

test("global maintenance actions enable, report status, and disable fleet-wide maintenance mode", async () => {
  const { root, paths } = fixture();
  try {
    const initial = await executeMaintenanceAction(["global-status"], actionOptions(paths)) as { global: boolean };
    expect(initial).toEqual({ global: false });

    const enabled = await executeMaintenanceAction(["global-enable"], actionOptions(paths)) as { ok: boolean; global: boolean };
    expect(enabled).toEqual({ ok: true, global: true });
    expect(lstatSync(join(paths.dataDir, "_global", "on")).isFile()).toBe(true);

    const statusAfterEnable = await executeMaintenanceAction(["global-status"], actionOptions(paths)) as { global: boolean };
    expect(statusAfterEnable).toEqual({ global: true });

    const disabled = await executeMaintenanceAction(["global-disable"], actionOptions(paths)) as { ok: boolean; global: boolean };
    expect(disabled).toEqual({ ok: true, global: false });
    expect(existsSync(join(paths.dataDir, "_global", "on"))).toBe(false);

    const finalStatus = await executeMaintenanceAction(["global-status"], actionOptions(paths)) as { global: boolean };
    expect(finalStatus).toEqual({ global: false });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

test("the global override covers a site whose own setting could not be read", () => {
  const sites = [
    { domain: "one.example.com", type: "php", user: "one", enabled: false, customTemplate: false, bypasses: [] },
    { domain: "unknown.example.com", type: "nodejs", user: "two", enabled: false, customTemplate: false, bypasses: [], error: "status unavailable" },
  ];
  // Nginx serves the override from one file for every site, so an unreadable
  // saved setting changes what the page knows, not what visitors are getting.
  const globalOn = fleetView(sites, true);
  expect(globalOn).toContain('<span class="badge state-maintenance" data-status-domain="unknown.example.com">Maintenance (Global)</span>');
  expect(globalOn).toContain('<div class="label">In maintenance</div><div class="value">2</div>');
  expect(globalOn).toContain('<div class="label">Live</div><div class="value">0</div>');
  // What could not be read is still said, beside the site it belongs to.
  expect(globalOn).toContain('<div class="hint">status unavailable</div>');

  const globalOff = fleetView(sites, false);
  expect(globalOff).toContain('<span class="badge state-unavailable" data-status-domain="unknown.example.com">Unavailable</span>');
  expect(globalOff).toContain('<div class="label">In maintenance</div><div class="value">0</div>');
  expect(globalOff).toContain('<div class="label">Live</div><div class="value">1</div>');
});

test("fleet overview renders the global override and badges according to global and individual state", () => {
  // globalEnabled = true: the override reads On, In maintenance = 2, Live = 0.
  const globalOn = fleetView([
    { domain: "one.example.com", type: "php", user: "one", enabled: true, customTemplate: false, bypasses: [] },
    { domain: "two.example.com", type: "static", user: "two", enabled: false, customTemplate: false, bypasses: [] },
  ], true);
  expect(globalOn).toContain("<h2>Global maintenance</h2>");
  expect(globalOn).toContain('<span class="switch-state" id="global-state">On</span>');
  expect(globalOn).toContain('<input type="checkbox" id="global-toggle" checked');
  expect(globalOn).toContain('<div class="label">In maintenance</div><div class="value">2</div>');
  expect(globalOn).toContain('<div class="label">Live</div><div class="value">0</div>');
  expect(globalOn).toContain('<span class="badge state-maintenance" data-status-domain="one.example.com">Maintenance Mode (503)</span>');
  expect(globalOn).toContain('<span class="badge state-maintenance" data-status-domain="two.example.com">Maintenance (Global)</span>');
  expect(globalOn).toContain('data-global-maintenance="true"');
  // The saved per-site setting is named as such, separately from what visitors get.
  expect(globalOn).toContain("<th scope=\"col\">Effective status</th>");
  expect(globalOn).toContain("Site setting</th>");

  // globalEnabled = false: the override reads Off, In maintenance = 1, Live = 1.
  const globalOff = fleetView([
    { domain: "one.example.com", type: "php", user: "one", enabled: true, customTemplate: false, bypasses: [] },
    { domain: "two.example.com", type: "static", user: "two", enabled: false, customTemplate: false, bypasses: [] },
  ], false);
  expect(globalOff).toContain('<span class="switch-state" id="global-state">Off</span>');
  expect(globalOff).not.toContain('id="global-toggle" checked');
  expect(globalOff).toContain('<div class="label">In maintenance</div><div class="value">1</div>');
  expect(globalOff).toContain('<div class="label">Live</div><div class="value">1</div>');
  expect(globalOff).toContain('<span class="badge state-maintenance" data-status-domain="one.example.com">Maintenance Mode (503)</span>');
  expect(globalOff).toContain('<span class="badge state-live" data-status-domain="two.example.com">Live</span>');
  expect(globalOff).toContain('data-global-maintenance="false"');

  // No site at all -> nothing for the override to cover.
  expect(fleetView([])).toContain('id="global-toggle"  disabled');
  // One Nginx flag covers a site whose own status could not be read, so an
  // unreadable status must not take the override away.
  expect(fleetView([
    { domain: "err.example.com", type: "php", user: "one", enabled: false, customTemplate: false, bypasses: [], error: "unavailable" },
  ])).not.toContain('id="global-toggle"  disabled');
});

test("siteView explains that the global override outranks this site's saved setting", () => {
  const site = { domain: "one.example.com", type: "php", user: "one", enabled: false, customTemplate: false, bypasses: [] };
  const template = { domain: "one.example.com", custom: false, html: "<h1>Maintenance</h1>" };

  // Global on, site saved off: the site is in maintenance and the page says why.
  const globalOn = siteView(site, template, "1.2.3.4", true);
  expect(globalOn).toContain('data-global-maintenance="true"');
  expect(globalOn).toContain("Maintenance (Global)");
  expect(globalOn).toContain('<div id="global-notice" class="notice">');
  expect(globalOn).toContain("Turning the setting below off does not take this site out of global maintenance.");

  // Global off, site saved off: the site is live and the explanation is hidden.
  const globalOff = siteView(site, template, "1.2.3.4", false);
  expect(globalOff).toContain('data-global-maintenance="false"');
  expect(globalOff).toContain("Live");
  expect(globalOff).toContain('<div id="global-notice" class="notice" hidden>');

  // Site saved on: its own setting already explains the status.
  const siteEnabled = siteView({ ...site, enabled: true }, template, "1.2.3.4", true);
  expect(siteEnabled).toContain("Maintenance Mode (503)");
  expect(siteEnabled).toContain('<div id="global-notice" class="notice" hidden>');
});

test("siteView renders responsive heading layout with badge after domain title and button in actions", () => {
  const site = { domain: "one.example.com", type: "php", user: "one", enabled: false, customTemplate: false, bypasses: [] };
  const template = { domain: "one.example.com", custom: false, html: "<h1>Maintenance</h1>" };
  const html = siteView(site, template, "1.2.3.4", false);

  expect(html).toContain('class="page-heading site-heading"');
  expect(html).toContain('<div class="site-title"><h1>one.example.com</h1></div>');
  expect(html).toContain('<p class="site-desc">Maintenance mode applies to HTTP and HTTPS traffic for this site.</p>');
  expect(html).toContain('<div class="actions"><a class="btn" href="/addons/maintenance/">All maintenance sites</a></div>');

  // Verify DOM order: title precedes badge, badge precedes description, description precedes actions
  const titleIndex = html.indexOf('<div class="site-title"><h1>one.example.com</h1></div>');
  const badgeIndex = html.indexOf('data-status-domain="one.example.com"');
  const descIndex = html.indexOf('<p class="site-desc">');
  const actionsIndex = html.indexOf('<div class="actions"><a class="btn" href="/addons/maintenance/">All maintenance sites</a></div>');

  expect(titleIndex).toBeGreaterThan(-1);
  expect(badgeIndex).toBeGreaterThan(titleIndex);
  expect(descIndex).toBeGreaterThan(badgeIndex);
  expect(actionsIndex).toBeGreaterThan(descIndex);

  // Verify layout styling includes desktop grid and mobile column order
  const page = layout("Maintenance", html);
  expect(page).toContain(".site-heading {");
  expect(page).toContain("grid-template-areas:");
  expect(page).toContain('"title badge . actions"');
  expect(page).toContain("@media (max-width:760px)");
  expect(page).toContain("flex-direction: column;");
});


test("a site-scoped page keeps CloudPanel's site navigation rather than a back link", () => {
  const site = { domain: "one.example.com", type: "php", user: "one", enabled: false, customTemplate: false, bypasses: [] };
  const content = siteView(site, { domain: site.domain, custom: false, html: "" }, "", false);

  const withContext = layout("Maintenance", content, null, {
    domain: "one.example.com", user: "one", type: "php", varnishCache: true, publicIp: "203.0.113.10",
  });
  expect(withContext).toContain('href="/site/one.example.com/settings"');
  expect(withContext).toContain('href="/site/one.example.com/varnish-cache"');
  expect(withContext).toContain('aria-label="Site navigation"');
  expect(withContext).toContain("203.0.113.10");
  expect(withContext).not.toContain("Back to site");

  // The addon has one page of its own, so it carries no tab strip anywhere:
  // the only tab it could hold is the page already being read.
  expect(withContext).not.toContain('aria-label="Maintenance Mode navigation"');
  const fleet = layout("Maintenance", fleetView([]), null);
  expect(fleet).not.toContain('aria-label="Maintenance Mode navigation"');
  expect(fleet).not.toContain('aria-label="Site navigation"');
});

test("global toggle API guards mutations and toggles fleet-wide maintenance mode", async () => {
  const token = "global-test-csrf-token";
  const request = (body: unknown, headers?: Record<string, string>) => new Request("https://panel.example.test:8443/addons/maintenance/api/global-toggle", {
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
  const noCsrf = await handleMaintenance(new Request("https://panel.example.test:8443/addons/maintenance/api/global-toggle", {
    method: "POST",
    body: JSON.stringify({ enabled: true }),
    headers: { "content-type": "application/json" },
  }), "/api/global-toggle");
  expect(noCsrf.status).toBe(403);

  // Rejects non-boolean enabled
  const badBody = await handleMaintenance(request({ enabled: "yes" }), "/api/global-toggle");
  expect(badBody.status).toBe(400);
  expect(await badBody.json()).toMatchObject({ ok: false, error: "enabled must be a boolean" });

  // Rejects invalid JSON
  const badJson = await handleMaintenance(request("{invalid"), "/api/global-toggle");
  expect(badJson.status).toBe(400);

  // Mock setGlobalEnabled
  const origSetGlobal = maintenanceService.setGlobalEnabled;
  try {
    let lastEnabled: boolean | undefined;
    maintenanceService.setGlobalEnabled = async (enabled) => {
      lastEnabled = enabled;
      return { ok: true, data: { global: enabled } };
    };

    const res = await handleMaintenance(request({ enabled: true }), "/api/global-toggle");
    expect(res.status).toBe(200);
    const data = await res.json() as { ok: boolean; data: { global: boolean } };
    expect(lastEnabled).toBe(true);
    expect(data.ok).toBe(true);
    expect(data.data.global).toBe(true);
  } finally {
    maintenanceService.setGlobalEnabled = origSetGlobal;
  }
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

  // Rejects domains if not an array
  const badDomains = await handleMaintenance(request("/api/sites/toggle", { enabled: true, domains: "not-an-array" }), "/api/sites/toggle");
  expect(badDomains.status).toBe(400);
  expect(await badDomains.json()).toMatchObject({ ok: false, error: "domains must be an array" });

  // Rejects domains if any entry is invalid
  const invalidDomain = await handleMaintenance(request("/api/sites/toggle", { enabled: true, domains: ["good.example.com", "bad..domain/"] }), "/api/sites/toggle");
  expect(invalidDomain.status).toBe(400);
  expect(await invalidDomain.json()).toMatchObject({ ok: false, error: "invalid domain in domains list: bad..domain/" });

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

    // Explicit empty array does not query panelSites
    let panelSitesCalled = false;
    maintenanceService.panelSites = async () => {
      panelSitesCalled = true;
      return [];
    };
    const emptyResult = await maintenanceService.setAllEnabled(true, []);
    expect(emptyResult.ok).toBe(true);
    expect(emptyResult.data.updated).toEqual([]);
    expect(panelSitesCalled).toBe(false);
  } finally {
    maintenanceService.setEnabled = origSetEnabled;
    maintenanceService.panelSites = origPanelSites;
  }
});

test("maintenance integration preserves ACME and normalizes non-GET errors through an internal URI", () => {
  expect(NGINX_MAINTENANCE_BLOCK).toContain("$uri ~ ^/\\.well-known/acme-challenge/");
  expect(NGINX_MAINTENANCE_BLOCK).toContain("$uri = /__clp_addons_maintenance");
  expect(NGINX_MAINTENANCE_BLOCK).toContain("maintenance/_global/on");
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
    "global-status", "global-enable", "global-disable",
  ]));
});

test("purgeVarnish sends PURGE requests for domain and www/bare aliases and handles failures safely", async () => {
  const purges: { url: string; method: string; host: string }[] = [];
  const mockFetch = async (input: unknown, init?: RequestInit): Promise<Response> => {
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

test("the template editor borrows CloudPanel's own Ace and works without it", () => {
  // The panel edits vhosts with the copy it ships at this path; bundling a
  // second editor would add a megabyte to do what the panel already does.
  expect(CLIENT_JS).toContain("'/assets/js/ace.min.js'");
  // That copy carries the core but no modes, so the HTML mode is served from
  // here, pinned to the version the panel serves. Text mode is set first, so a
  // mode that will not load leaves a working editor rather than none.
  expect(CLIENT_JS).toContain("ace/mode/text");
  expect(CLIENT_JS).toContain("ace.config.setModuleUrl('ace/mode/html', CLP_BASE + '/ace/mode-html.js')");
  expect(CLIENT_JS.indexOf("'ace/mode/text'")).toBeLessThan(CLIENT_JS.indexOf("'ace/mode/html'"));
  // The bundled theme is the only one there is; dark mode recolours it here.
  expect(CLIENT_JS).not.toContain("ace/theme/");
  const dark = layout("t", siteView(
    { domain: "a.test", type: "php", user: "a", enabled: false, customTemplate: true, bypasses: [] },
    { domain: "a.test", custom: true, html: "<p>x</p>" }, "203.0.113.8", false));
  expect(dark).toContain("html.dark #template-ace .ace_tag");
  expect(dark).toContain("html.dark #template-ace .ace_string");

  // A panel release that stops shipping it must leave a working textarea.
  expect(CLIENT_JS).toContain("script.onerror = function () { resolve(null); }");
  expect(CLIENT_JS).toContain("if (!ace) return;");

  // Ace writes its stylesheet into the document head, which a shadow root
  // cannot see.
  expect(CLIENT_JS).toContain("style[id^=\"ace\"]");

  // The textarea stays the value every other path reads and writes.
  expect(CLIENT_JS).toContain("area.value = templateAce.getValue();");
  expect(CLIENT_JS).toContain("function templateValue()");
});

test("the editor markup keeps the textarea beside the editor that replaces it", () => {
  const html = siteView(
    { domain: "shop.example.test", type: "php", user: "shop", enabled: false, customTemplate: true, bypasses: [] },
    { domain: "shop.example.test", custom: true, html: "<p>hi</p>" },
    "203.0.113.8",
    false,
  );
  expect(html).toContain('<textarea id="template-editor"');
  expect(html).toContain('<div id="template-ace" hidden></div>');
  expect(html.indexOf("template-editor")).toBeLessThan(html.indexOf("template-ace"));
});

test("editing the template is a local mode that never removes what is saved", () => {
  const html = siteView(
    { domain: "shop.example.test", type: "php", user: "shop", enabled: false, customTemplate: true, bypasses: [] },
    { domain: "shop.example.test", custom: true, html: "<p>hi</p>" },
    "203.0.113.8",
    false,
  );
  // Read-only until asked for, on a site that already has a custom template:
  // the switch opens the editor, it does not choose which page is served.
  expect(html).toContain('<label class="switch-field toolbar-end" for="edit-template">Edit');
  expect(html).toContain('<input id="edit-template" type="checkbox" onchange=');
  // Removing a template is what the reset button does, and only that.
  expect(html).toContain('onclick="resetTemplate(');
  const mode = CLIENT_JS.slice(CLIENT_JS.indexOf("async function changeTemplateMode"));
  const body = mode.slice(0, mode.indexOf("\nasync function"));
  expect(body).not.toContain("resetTemplate");
  // No confirmation for a template nobody touched.
  expect(body).toContain("templateValue() === templateSaved");
  expect(body).toContain("Discard the unsaved changes?");
  // Declining leaves the operator in the editor with the edits still there.
  expect(body).toContain("toggle.checked = true");
});

test("the addon serves the Ace mode the panel does not ship", async () => {
  const res = await handleMaintenance(
    new Request("https://panel.example.test:8443/addons/maintenance/ace/mode-html.js"),
    "/ace/mode-html.js",
  );
  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Type")).toContain("text/javascript");
  const body = await res.text();
  // Pinned to the 1.4.2 core CloudPanel serves, and self-contained: it brings
  // the css and javascript modes the HTML mode needs, so nothing else is
  // fetched from a path the panel does not have.
  expect(body).toContain('ace.define("ace/mode/html"');
  expect(body).toContain('ace.define("ace/mode/css"');
  expect(body).toContain('ace.define("ace/mode/javascript"');
  // Vendored third-party code keeps its licence.
  expect(body).toContain("BEGIN LICENSE BLOCK");
  expect(body).toContain("Copyright (c) 2010, Ajax.org B.V.");
});

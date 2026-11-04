import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_MAINTENANCE_TEMPLATE, MAX_BYPASS_IPS, MAX_TEMPLATE_BYTES, addBypass, executeMaintenanceAction,
  pruneMaintenanceState, purgeVarnish,
  type MaintenanceActionPaths, type MaintenanceSiteStatus, type MaintenanceStatus,
} from "../addons/maintenance/action";
import { handle as handleMaintenance } from "../addons/maintenance/app/index";
import { maintenanceService, type MaintenanceSiteView } from "../addons/maintenance/app/service";
import { CLIENT_JS, fleetView, layout, siteView } from "../addons/maintenance/app/views";
import { MAINTENANCE_TARGETS } from "../addons/maintenance/inject/targets";
import { MAINTENANCE_INCLUDE_PATH } from "../cli/maintenance-vhosts";
import {
  inspectNginxMaintenance, NGINX_MAINTENANCE_BLOCK, reconcileNginxMaintenance, releaseMaintenanceSettings,
} from "../cli/inject";

/** A vhost whose one server runs the standalone maintenance check. */
function coveredVhost(domain: string): string {
  return `server {\n  listen 80;\n  server_name ${domain};\n  include ${MAINTENANCE_INCLUDE_PATH};\n}\n`;
}

/** Each domain is a CloudPanel site with a vhost that runs the check, unless it is listed in `bare`. */
function fixture(domain = "example.com", others: string[] = [], bare: string[] = []): { root: string; paths: MaintenanceActionPaths } {
  const root = mkdtempSync(join(tmpdir(), "clp-maintenance-"));
  const panelDb = join(root, "panel.db");
  const nginxVhostDir = join(root, "sites-enabled");
  mkdirSync(nginxVhostDir);
  const db = new Database(panelDb);
  db.run("CREATE TABLE site (id INTEGER PRIMARY KEY, domain_name TEXT, type TEXT, user TEXT, vhost_template TEXT)");
  for (const name of [domain, ...others]) {
    const vhost = bare.includes(name) ? coveredVhost(name).replace(/  include .*\n/, "") : coveredVhost(name);
    db.query("INSERT INTO site (domain_name, type, user, vhost_template) VALUES (?, 'php', 'site', ?)").run(name, vhost);
    // A name at the hostname limit is longer than a file name may be.
    if (name.length < 250) writeFileSync(join(nginxVhostDir, `${name}.conf`), vhost);
  }
  db.close();
  const identity = join(root, "panel-identity.conf");
  writeFileSync(identity, "PRIMARY=panel.example.test\nALIASES=\n", { mode: 0o600 });
  return {
    root,
    paths: {
      dataDir: join(root, "data"), lockDir: join(root, "locks"), panelDb, panelIdentityFile: identity,
      nginxVhostDir, nginxSettings: join(root, "global_settings"), includePath: MAINTENANCE_INCLUDE_PATH,
    },
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
    const initial = await executeMaintenanceAction(["global-status"], actionOptions(paths)) as { global: boolean; bypasses: string[] };
    expect(initial).toEqual({ global: false, bypasses: [] });

    const bypassed = await executeMaintenanceAction(["global-set-bypass"], actionOptions(paths, {
      input: JSON.stringify({ ips: ["203.0.113.8", "2001:db8::1"] }),
    })) as { global: boolean; bypasses: string[] };
    expect(bypassed).toEqual({ global: false, bypasses: ["2001:db8::1", "203.0.113.8"] });
    expect(existsSync(join(paths.dataDir, "_global", "bypass_203.0.113.8"))).toBe(true);

    const enabled = await executeMaintenanceAction(["global-enable"], actionOptions(paths)) as { ok: boolean; global: boolean };
    expect(enabled).toEqual({ ok: true, global: true });
    expect(lstatSync(join(paths.dataDir, "_global", "on")).isFile()).toBe(true);

    const statusAfterEnable = await executeMaintenanceAction(["global-status"], actionOptions(paths)) as { global: boolean; bypasses: string[] };
    expect(statusAfterEnable).toEqual({ global: true, bypasses: ["2001:db8::1", "203.0.113.8"] });

    const disabled = await executeMaintenanceAction(["global-disable"], actionOptions(paths)) as { ok: boolean; global: boolean };
    expect(disabled).toEqual({ ok: true, global: false });
    expect(existsSync(join(paths.dataDir, "_global", "on"))).toBe(false);

    const finalStatus = await executeMaintenanceAction(["global-status"], actionOptions(paths)) as { global: boolean; bypasses: string[] };
    expect(finalStatus).toEqual({ global: false, bypasses: ["2001:db8::1", "203.0.113.8"] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("many sites are switched in one action, and a site the panel does not have is reported, not fatal", async () => {
  const { root, paths } = fixture("a.example.com", ["b.example.com"]);
  try {
    const on = await executeMaintenanceAction(["enable-many"], actionOptions(paths, {
      input: JSON.stringify({ domains: ["b.example.com", "A.example.com", "gone.example.com"] }),
    })) as { updated: string[]; failed: { domain: string; error: string }[] };
    expect(on.updated).toEqual(["a.example.com", "b.example.com"]);
    expect(on.failed).toEqual([{ domain: "gone.example.com", error: "CloudPanel site not found: 'gone.example.com'" }]);
    expect(lstatSync(join(paths.dataDir, "a.example.com", "on")).isFile()).toBe(true);
    const off = await executeMaintenanceAction(["disable-many"], actionOptions(paths, {
      input: JSON.stringify({ domains: ["a.example.com"] }),
    })) as { updated: string[] };
    expect(off.updated).toEqual(["a.example.com"]);
    expect(existsSync(join(paths.dataDir, "a.example.com", "on"))).toBe(false);
    expect(existsSync(join(paths.dataDir, "b.example.com", "on"))).toBe(true);
    await expect(executeMaintenanceAction(["enable-many"], actionOptions(paths, { input: "{}" }))).rejects.toThrow("at least one site");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("maintenance actions toggle atomically, manage a passive template, and replace IP bypasses", async () => {
  const { root, paths } = fixture();
  try {
    const initial = await executeMaintenanceAction(["status", "--domain=example.com"], actionOptions(paths)) as MaintenanceStatus;
    expect(initial).toEqual({ domain: "example.com", enabled: false, customTemplate: false, bypasses: [], uncovered: null });

    const enabled = await executeMaintenanceAction(["enable", "--domain=EXAMPLE.COM."], actionOptions(paths)) as MaintenanceStatus;
    expect(enabled.enabled).toBe(true);
    expect(lstatSync(join(paths.dataDir, "example.com", "on")).isFile()).toBe(true);
    expect(readFileSync(join(paths.dataDir, "default.html"), "utf8")).toBe(DEFAULT_MAINTENANCE_TEMPLATE);

    const unsafe = '<!doctype html><meta http-equiv="ref&#x72;esh" content="0;url=https://bad.test"><h1 onclick="steal()">Hello</h1><script>steal()</script><form><input></form><svg><a xlink:href="javascript:steal()">link</a></svg>';
    const custom = await executeMaintenanceAction(["set-template", "--domain=example.com"], actionOptions(paths, { input: unsafe })) as { html: string; removed: boolean };
    expect(custom.html).toContain("<h1>Hello</h1>");
    // The page says so when the sanitizer changed what was sent.
    expect(custom.removed).toBe(true);
    expect(custom.html).not.toMatch(/script|onclick|form|input|http-equiv|javascript/i);
    expect(readFileSync(join(paths.dataDir, "example.com", "maintenance.html"), "utf8")).toBe(custom.html);
    const clean = await executeMaintenanceAction(["set-template", "--domain=example.com"], actionOptions(paths, { input: "<h1>Hi</h1>" })) as { removed: boolean };
    expect(clean.removed).toBe(false);

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

test("an upgrade run gets global_settings back as packaged, and the next reconcile adopts what the upgrade installed", () => {
  const root = mkdtempSync(join(tmpdir(), "clp-maintenance-release-"));
  const settingsPath = join(root, "global_settings");
  const geoPath = join(root, "sites-enabled", "00-clp-addons-maintenance-client-ip.conf");
  const includePath = join(root, "maintenance.conf");
  const paths = {
    settingsPath, stateDir: join(root, "state"), geoPath, cloudflareIpsPath: join(root, "cloudflare", "ips"), panelDb: null,
    includePath, vhostUid: process.getuid?.() ?? 0,
  };
  const original = "client_max_body_size 128m;";
  writeFileSync(settingsPath, original, { mode: 0o644 });
  mkdirSync(join(root, "cloudflare"));
  writeFileSync(paths.cloudflareIpsPath, "allow 173.245.48.0/20;\ndeny all;\n");
  try {
    expect(reconcileNginxMaintenance({ ...paths, reload: false }).state).toBe("ok");
    expect(releaseMaintenanceSettings(paths)).toBe(true);
    expect(readFileSync(settingsPath, "utf8")).toBe(original);
    expect(existsSync(geoPath) && existsSync(includePath)).toBe(true);
    expect(releaseMaintenanceSettings(paths)).toBe(false);

    const upgraded = "client_max_body_size 256m;";
    writeFileSync(settingsPath, upgraded);
    expect(reconcileNginxMaintenance({ ...paths, reload: false })).toMatchObject({ state: "ok", changed: true });
    expect(readFileSync(settingsPath, "utf8")).toBe(`${upgraded}\n${NGINX_MAINTENANCE_BLOCK}\n`);

    writeFileSync(settingsPath, readFileSync(settingsPath, "utf8").replace(upgraded, `${upgraded}\nserver_tokens off;`));
    expect(releaseMaintenanceSettings(paths)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("global-settings reconciliation is idempotent, drift-gated, and reversible", () => {
  const root = mkdtempSync(join(tmpdir(), "clp-maintenance-nginx-"));
  const settingsPath = join(root, "global_settings");
  const stateDir = join(root, "state");
  const geoPath = join(root, "sites-enabled", "00-clp-addons-maintenance-client-ip.conf");
  const cloudflareIpsPath = join(root, "cloudflare", "ips");
  const paths = {
    settingsPath, stateDir, geoPath, cloudflareIpsPath, panelDb: null,
    includePath: join(root, "maintenance.conf"), vhostUid: process.getuid?.() ?? 0,
  };
  const original = "client_max_body_size 128m;";
  writeFileSync(settingsPath, original, { mode: 0o644 });
  mkdirSync(join(root, "cloudflare"));
  writeFileSync(cloudflareIpsPath, "allow 173.245.48.0/20;\nallow 2400:cb00::/32;\ndeny all;\n");
  try {
    const installed = reconcileNginxMaintenance({ ...paths, reload: false });
    expect(installed).toMatchObject({ state: "ok", changed: true });
    expect(readFileSync(settingsPath, "utf8")).toContain(NGINX_MAINTENANCE_BLOCK);
    expect(inspectNginxMaintenance(paths).state).toBe("ok");
    const geo = readFileSync(geoPath, "utf8");
    expect(geo).toContain("173.245.48.0/20 1;");
    expect(geo).toContain("2400:cb00::/32 1;");
    expect(geo).toContain("map $realip_remote_addr $clp_maintenance_peer");
    expect(geo).toContain("geo $clp_maintenance_client $clp_cf_peer");
    expect(geo).toContain("default $clp_maintenance_client;");
    expect(geo).toContain("~^1:.+$ $clp_cf_header_ip;");
    writeFileSync(cloudflareIpsPath, "allow 173.245.48.0/20;\nallow 2400:cb00::/32;\nallow 104.16.0.0/13;\ndeny all;\n");
    expect(inspectNginxMaintenance(paths).state).toBe("stale-content");
    expect(reconcileNginxMaintenance({ ...paths, reload: false }).changed).toBe(true);
    expect(readFileSync(geoPath, "utf8")).toContain("104.16.0.0/13 1;");

    expect(reconcileNginxMaintenance({ ...paths, reload: false }).changed).toBe(false);
    writeFileSync(settingsPath, readFileSync(settingsPath, "utf8").replace(original, `${original}\nserver_tokens off;`));
    const drift = reconcileNginxMaintenance({ ...paths, reload: false });
    expect(drift.state).toBe("upstream-changed");
    expect(drift.changed).toBe(false);

    writeFileSync(settingsPath, `${original}\n${NGINX_MAINTENANCE_BLOCK}\n`);
    const removed = reconcileNginxMaintenance({ ...paths, enabled: false, reload: false });
    expect(removed).toMatchObject({ state: "missing", changed: true });
    expect(readFileSync(settingsPath, "utf8")).toBe(original);
    expect(existsSync(geoPath)).toBe(false);
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
    expect(reconcileNginxMaintenance({ settingsPath, stateDir, panelDb: null, reload: false })).toMatchObject({
      state: "conflict", changed: false,
    });
    expect(reconcileNginxMaintenance({ settingsPath, stateDir, panelDb: null, enabled: false, reload: false })).toMatchObject({
      state: "conflict", changed: false,
    });
    expect(inspectNginxMaintenance({ settingsPath, stateDir, panelDb: null }).state).toBe("conflict");
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

const site = (extra: Partial<MaintenanceSiteView> = {}): MaintenanceSiteView => ({
  domain: "one.example.com", type: "php", user: "one", enabled: false, customTemplate: false, bypasses: [], uncovered: null,
  ...extra,
});
const fleetOf = (sites: MaintenanceSiteView[], global = false, bypasses: string[] = []) => ({ global: { global, bypasses }, sites });

test("the fleet counts what visitors get, in the table's header", () => {
  const rendered = fleetView(fleetOf([
    site({ domain: "maintenance.example.com", enabled: true, customTemplate: true, bypasses: ["203.0.113.8"] }),
    site({ domain: "live.example.com" }),
    site({ domain: "unknown.example.com", error: "status unavailable" }),
  ]));
  expect(rendered).toContain("1 of 3 in maintenance");
  expect(rendered).toContain(">Unavailable</span>");
  expect(rendered).not.toContain('class="card stats"');
  // Page and bypasses are a note under the site, not columns.
  expect(rendered).toContain('<div class="hint">Custom page · 1 bypass</div>');
  expect(rendered).not.toContain('data-label="Page"');
  // An unreadable site cannot be selected or switched.
  expect(rendered).toMatch(/aria-label="Select unknown\.example\.com" disabled/);
  // The table comes before the global card.
  expect(rendered.indexOf("maintenance-fleet-table")).toBeLessThan(rendered.indexOf("Global maintenance"));
});

test("the global override covers a site whose own setting could not be read", () => {
  const sites = [site(), site({ domain: "unknown.example.com", error: "status unavailable" })];
  // Nginx serves the override from one file for every site, so an unreadable
  // saved setting changes what the page knows, not what visitors are getting.
  const globalOn = fleetView(fleetOf(sites, true));
  expect(globalOn).toContain('<span class="badge state-maintenance" data-status-domain="unknown.example.com">Maintenance (Global)</span>');
  expect(globalOn).toContain("2 of 2 in maintenance");
  expect(globalOn).toContain('<div class="hint">status unavailable</div>');
  expect(globalOn).toContain("Global maintenance is on: every site serves the maintenance page.");

  const globalOff = fleetView(fleetOf(sites, false));
  expect(globalOff).toContain('<span class="badge state-unavailable" data-status-domain="unknown.example.com">Unavailable</span>');
  expect(globalOff).toContain("0 of 2 in maintenance");
  expect(globalOff).not.toContain("Global maintenance is on");
});

test("a site Nginx does not cover is never drawn as in maintenance", () => {
  const uncovered = site({ domain: "new.example.com", enabled: true, uncovered: "Nginx has no vhost for it yet" });
  const rendered = fleetView(fleetOf([site({ enabled: true }), uncovered], true));
  expect(rendered).toContain('<span class="badge state-uncovered" data-status-domain="new.example.com" title="Nginx has no vhost for it yet">Not covered</span>');
  expect(rendered).toContain("Not covered: Nginx has no vhost for it yet.");
  expect(rendered).toContain("1 of 2 in maintenance");
  expect(rendered).toContain("except the 1 site Nginx does not cover");
  // Off and outside the override, it is live, and the note still says why a switch would do nothing.
  const off = fleetView(fleetOf([{ ...uncovered, enabled: false }]));
  expect(off).toContain(">Live</span>");
  expect(off).toContain("Not covered: Nginx has no vhost for it yet.");

  const page = siteView(uncovered, { domain: uncovered.domain, custom: false, html: "" }, "", true);
  expect(page).toContain(">Not covered</span>");
  expect(page).toContain("Nginx does not run the maintenance check for this site because Nginx has no vhost for it yet");
  expect(page).toContain('<div id="global-notice" class="notice" hidden>');
});

test("the fleet selects rows and switches the selected sites, with search from six sites", () => {
  const few = fleetView(fleetOf([site()]));
  expect(few).toContain('onclick="toggleSiteSelection(event, this)"');
  expect(few).toContain('<button class="btn" type="button" data-needs-selection disabled onclick="toggleSelected(true)">Turn on selected</button>');
  expect(few).toContain('<button class="btn" type="button" data-needs-selection disabled onclick="toggleSelected(false)">Turn off selected</button>');
  expect(few).not.toContain('id="fleet-find"');
  const many = fleetView(fleetOf(Array.from({ length: 6 }, (_, i) => site({ domain: `s${i}.example.com` }))));
  expect(many).toContain('id="fleet-find"');
  expect(many).toContain('<input type="checkbox" value="maintenance" data-group="Status" onchange="pickFleetFilter()"> In maintenance</label>');
  expect(CLIENT_JS).toContain("function paintFleetSelection()");
  expect(CLIENT_JS).toContain("call('/api/bulk-toggle'");
});

test("fleet overview renders the global override in a card of its own", () => {
  const globalOn = fleetView(fleetOf([site({ enabled: true }), site({ domain: "two.example.com" })], true, ["203.0.113.8"]));
  expect(globalOn).toContain("<h2>Global maintenance</h2>");
  expect(globalOn).toContain('<input type="checkbox" id="global-toggle" checked');
  expect(globalOn).toContain('<span class="badge state-maintenance" data-status-domain="one.example.com">Maintenance Mode (503)</span>');
  expect(globalOn).toContain('<span class="badge state-maintenance" data-status-domain="two.example.com">Maintenance (Global)</span>');
  // Global bypasses fold into a summary that counts them.
  expect(globalOn).toContain('<details class="disclosure bypass-disclosure" id="global-bypasses">');
  expect(globalOn).toContain('<span class="hint" id="global-bypass-ips-count">1 address</span>');

  const globalOff = fleetView(fleetOf([site({ enabled: true }), site({ domain: "two.example.com" })]));
  expect(globalOff).not.toContain('id="global-toggle" checked');
  expect(globalOff).toContain('<span class="badge state-live" data-status-domain="two.example.com">Live</span>');

  // No site at all -> nothing for the override to cover.
  expect(fleetView(fleetOf([]))).toContain('id="global-toggle"  disabled');
  expect(fleetView(fleetOf([site({ error: "unavailable" })]))).not.toContain('id="global-toggle"  disabled');
});

test("both bypass lists offer the operator's IP and hold Save until the list changes", () => {
  const fleet = fleetView(fleetOf([], false, ["203.0.113.8"]), "198.51.100.4");
  expect(fleet).toContain(`onclick="addCurrentIp('global-bypass-ips', '198.51.100.4')"`);
  expect(fleet).toContain('data-bypass-save="global-bypass-ips" disabled');
  const page = siteView(site(), { domain: "one.example.com", custom: false, html: "" }, "198.51.100.4");
  expect(page).toContain(`onclick="addCurrentIp('bypass-ips', '198.51.100.4')"`);
  expect(page).toContain('data-bypass-save="bypass-ips" disabled');
  expect(page).toContain('<span class="hint" id="bypass-ips-count">None</span>');
});

test("siteView explains that the global override outranks this site's saved setting", () => {
  const template = { domain: "one.example.com", custom: false, html: "<h1>Maintenance</h1>" };

  const globalOn = siteView(site(), template, "1.2.3.4", true);
  expect(globalOn).toContain('data-global-maintenance="true"');
  expect(globalOn).toContain("Maintenance (Global)");
  expect(globalOn).toContain('<div id="global-notice" class="notice">');

  const globalOff = siteView(site(), template, "1.2.3.4", false);
  expect(globalOff).toContain("Live");
  expect(globalOff).toContain('<div id="global-notice" class="notice" hidden>');

  const siteEnabled = siteView(site({ enabled: true }), template, "1.2.3.4", true);
  expect(siteEnabled).toContain("Maintenance Mode (503)");
  expect(siteEnabled).toContain('<div id="global-notice" class="notice" hidden>');
});

test("the site page puts the switch beside its status and folds bypasses and the page into summaries", () => {
  const html = siteView(site({ bypasses: ["203.0.113.8", "198.51.100.1"] }), { domain: "one.example.com", custom: false, html: "<p>x</p>" }, "", false);
  expect(html).toMatch(/<div class="heading-controls"><span class="badge state-live"[^>]*>Live<\/span>\s*<label class="switch switch-danger"><input type="checkbox" data-toggle-domain="one\.example\.com"/);
  expect(html).toContain('<span class="hint" id="bypass-ips-count">2 bypasses</span>');
  expect(html).toContain('<span class="hint" id="template-kind">Default</span>');
  // Reset only exists to remove a saved template.
  expect(html).toMatch(/id="reset-template"[^>]*hidden>/);
  expect(siteView(site({ customTemplate: true }), { domain: "one.example.com", custom: true, html: "" }, "", false))
    .not.toMatch(/id="reset-template"[^>]*hidden>/);
  // The page opens on its preview; the editor is behind the Edit switch.
  expect(html).toContain('<textarea id="template-editor" aria-label="Maintenance page HTML" spellcheck="false" hidden>');
  expect(html).toContain('<iframe id="template-preview" title="Maintenance page preview" sandbox></iframe>');
  expect(html).toContain('<div class="editor-tabs" role="tablist" hidden>');
  expect(layout("Maintenance", html)).not.toContain("display: contents");
  expect(CLIENT_JS).toContain("'Saved; some tags were removed.'");
});

test("a site-scoped page keeps CloudPanel's site navigation rather than a back link", () => {
  const content = siteView(site(), { domain: "one.example.com", custom: false, html: "" }, "", false);

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
  const fleet = layout("Maintenance", fleetView(fleetOf([])), null);
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
  const origFleet = maintenanceService.fleet;
  try {
    maintenanceService.fleet = async () => ({ global: { global: true, bypasses: [] }, sites: [] });
    let lastEnabled: boolean | undefined;
    maintenanceService.setGlobalEnabled = async (enabled) => {
      lastEnabled = enabled;
      return { ok: true, data: { global: enabled } };
    };

    const res = await handleMaintenance(request({ enabled: true }), "/api/global-toggle");
    expect(res.status).toBe(200);
    const data = await res.json() as { ok: boolean; data: { global: boolean }; html: string };
    expect(lastEnabled).toBe(true);
    expect(data.ok).toBe(true);
    expect(data.data.global).toBe(true);
    // The fleet repaints from the reply, banner and all.
    expect(data.html).toContain("Global maintenance is on");
  } finally {
    maintenanceService.setGlobalEnabled = origSetGlobal;
    maintenanceService.fleet = origFleet;
  }
});

test("global bypass API validates and saves addresses", async () => {
  const token = "global-bypass-test";
  const request = (body: unknown, csrf = true) => new Request("https://panel.example.test:8443/addons/maintenance/api/global-bypasses", {
    method: "PUT",
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      host: "panel.example.test:8443",
      origin: "https://panel.example.test:8443",
      ...(csrf ? { cookie: `clp_addons_csrf=${token}`, "x-clp-addons-csrf": token } : {}),
    },
  });
  expect((await handleMaintenance(request({ ips: [] }, false), "/api/global-bypasses")).status).toBe(403);
  expect((await handleMaintenance(request({ ips: [42] }), "/api/global-bypasses")).status).toBe(400);
  const original = maintenanceService.setGlobalBypasses;
  try {
    let received: string[] = [];
    maintenanceService.setGlobalBypasses = async (ips) => {
      received = ips;
      return { ok: true, data: { global: true, bypasses: ips } };
    };
    const response = await handleMaintenance(request({ ips: ["203.0.113.8"] }), "/api/global-bypasses");
    expect(response.status).toBe(200);
    expect(received).toEqual(["203.0.113.8"]);
  } finally {
    maintenanceService.setGlobalBypasses = original;
  }
});

test("the bulk route switches the listed sites and answers with the repainted fleet", async () => {
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

  const noCsrf = await handleMaintenance(new Request("https://panel.example.test:8443/addons/maintenance/api/bulk-toggle", {
    method: "POST",
    body: JSON.stringify({ enabled: true, domains: ["a.example.com"] }),
    headers: { "content-type": "application/json" },
  }), "/api/bulk-toggle");
  expect(noCsrf.status).toBe(403);

  const badBody = await handleMaintenance(request("/api/bulk-toggle", { enabled: "yes" }), "/api/bulk-toggle");
  expect(await badBody.json()).toMatchObject({ ok: false, error: "enabled must be a boolean" });
  expect((await handleMaintenance(request("/api/bulk-toggle", "{invalid"), "/api/bulk-toggle")).status).toBe(400);
  // Every site at once is what the global switch is for; this takes a list.
  const noDomains = await handleMaintenance(request("/api/bulk-toggle", { enabled: true }), "/api/bulk-toggle");
  expect(await noDomains.json()).toMatchObject({ ok: false, error: "domains must list at least one site" });
  const invalidDomain = await handleMaintenance(request("/api/bulk-toggle", { enabled: true, domains: ["good.example.com", "bad..domain/"] }), "/api/bulk-toggle");
  expect(await invalidDomain.json()).toMatchObject({ ok: false, error: "invalid domain in domains list: bad..domain/" });
  // The aliases that used to answer are gone.
  for (const alias of ["/api/sites/toggle", "/api/toggle-all"]) {
    expect((await handleMaintenance(request(alias, { enabled: true, domains: ["a.example.com"] }), alias)).status).toBe(404);
  }

  const original = { setManyEnabled: maintenanceService.setManyEnabled, fleet: maintenanceService.fleet };
  try {
    const switched: string[] = [];
    maintenanceService.setManyEnabled = async (domains, enabled) => {
      switched.push(...domains.filter((domain) => domain !== "bad.example.com"));
      return { enabled, updated: switched, failed: [{ domain: "bad.example.com", error: "root action failed" }] };
    };
    maintenanceService.fleet = async () => ({ global: { global: false, bypasses: [] }, sites: [] });
    const res = await handleMaintenance(request("/api/bulk-toggle", { enabled: true, domains: ["good.example.com", "bad.example.com"] }), "/api/bulk-toggle");
    expect(res.status).toBe(200);
    const reply = await res.json() as { ok: boolean; html: string; data: { updated: string[]; failed: unknown[] } };
    expect(switched).toEqual(["good.example.com"]);
    expect(reply.data.updated).toEqual(["good.example.com"]);
    expect(reply.data.failed).toEqual([{ domain: "bad.example.com", error: "root action failed" }]);
    expect(reply.html).toContain("Maintenance Mode");
  } finally {
    Object.assign(maintenanceService, original);
  }
});

test("maintenance integration preserves ACME and normalizes non-GET errors through an internal URI", () => {
  expect(NGINX_MAINTENANCE_BLOCK).toContain("$uri ~ ^/\\.well-known/acme-challenge/");
  expect(NGINX_MAINTENANCE_BLOCK).toContain("$uri = /__clp_addons_maintenance");
  expect(NGINX_MAINTENANCE_BLOCK).toContain("maintenance/_global/on");
  expect(NGINX_MAINTENANCE_BLOCK).toContain("maintenance/$server_name/on");
  expect(NGINX_MAINTENANCE_BLOCK).toContain("maintenance/_global/bypass_$clp_maintenance_ip");
  expect(NGINX_MAINTENANCE_BLOCK).toContain("maintenance/$server_name/bypass_$clp_maintenance_ip");
  expect(NGINX_MAINTENANCE_BLOCK).not.toContain("bypass_$remote_addr");
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
    { domain: "a.test", type: "php", user: "a", enabled: false, customTemplate: true, bypasses: [], uncovered: null },
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
    { domain: "shop.example.test", type: "php", user: "shop", enabled: false, customTemplate: true, bypasses: [], uncovered: null },
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
    { domain: "shop.example.test", type: "php", user: "shop", enabled: false, customTemplate: true, bypasses: [], uncovered: null },
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

// /api/tweaks saves the switch and then writes the panel's templates. When only
// the second half fails it answers 500 with the saved state attached, so putting

// WordPress Tools adds one address at a time; it must keep the rest, add an
// address only once, and stop at the same limit a saved list does.
test("adding one bypass keeps the list, deduplicates and respects the limit", async () => {
  const { root, paths } = fixture();
  try {
    expect(await addBypass(paths, "example.com", "203.0.113.8")).toEqual(["203.0.113.8"]);
    expect(await addBypass(paths, "example.com", "2001:0DB8::1")).toEqual(["2001:db8::1", "203.0.113.8"]);
    expect(await addBypass(paths, "example.com", "203.0.113.8")).toEqual(["2001:db8::1", "203.0.113.8"]);

    const full = Array.from({ length: MAX_BYPASS_IPS }, (_, index) => `198.51.100.${index}`);
    await executeMaintenanceAction(["set-bypass", "--domain=example.com"], actionOptions(paths, { input: JSON.stringify({ ips: full }) }));
    await expect(addBypass(paths, "example.com", "203.0.113.200")).rejects.toThrow(`at most ${MAX_BYPASS_IPS}`);
    expect(await addBypass(paths, "example.com", "198.51.100.0")).toHaveLength(MAX_BYPASS_IPS);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("one sites call reads every site's status and coverage, including state 1.5.2 left", async () => {
  const { root, paths } = fixture("example.com", ["bare.example.com", "fresh.example.com"], ["bare.example.com"]);
  rmSync(join(paths.nginxVhostDir, "fresh.example.com.conf"));
  // What 1.5.2 wrote: a 0711 directory per domain with an empty `on` flag,
  // `bypass_<ip>` files and a maintenance.html, and the same under _global.
  for (const [dir, files] of [
    ["example.com", ["on", "bypass_203.0.113.8", "maintenance.html"]],
    ["bare.example.com", ["on"]],
    ["_global", ["bypass_198.51.100.1"]],
  ] as const) {
    mkdirSync(join(paths.dataDir, dir), { recursive: true, mode: 0o711 });
    for (const file of files) writeFileSync(join(paths.dataDir, dir, file), file === "maintenance.html" ? "<h1>Back soon</h1>\n" : "", { mode: 0o600 });
  }
  try {
    const result = await executeMaintenanceAction(["sites"], actionOptions(paths)) as {
      global: { global: boolean; bypasses: string[] }; sites: MaintenanceSiteStatus[];
    };
    expect(result.global).toEqual({ global: false, bypasses: ["198.51.100.1"] });
    expect(result.sites).toEqual([
      { domain: "bare.example.com", enabled: true, customTemplate: false, bypasses: [], uncovered: "its vhost does not include the check", type: "php", user: "site" },
      { domain: "example.com", enabled: true, customTemplate: true, bypasses: ["203.0.113.8"], uncovered: null, type: "php", user: "site" },
      { domain: "fresh.example.com", enabled: false, customTemplate: false, bypasses: [], uncovered: "Nginx has no vhost for it yet", type: "php", user: "site" },
    ]);
    // A single site's status carries the same answer, which the CLI warns with.
    const one = await executeMaintenanceAction(["enable", "--domain=fresh.example.com"], actionOptions(paths)) as MaintenanceStatus;
    expect(one.uncovered).toBe("Nginx has no vhost for it yet");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("upkeep removes the state of sites CloudPanel no longer has, and nothing when the panel cannot answer", async () => {
  const { root, paths } = fixture("example.com", ["kept.example.com"]);
  for (const dir of ["example.com", "kept.example.com", "deleted.example.com", "_global"]) {
    mkdirSync(join(paths.dataDir, dir), { recursive: true });
    writeFileSync(join(paths.dataDir, dir, "on"), "");
  }
  writeFileSync(join(paths.dataDir, "default.html"), "x");
  try {
    // An unreadable panel database and one that lists no site both read as "do nothing".
    expect(pruneMaintenanceState({ paths: { ...paths, panelDb: join(root, "missing.db") } })).toEqual([]);
    const empty = join(root, "empty.db");
    const db = new Database(empty);
    db.run("CREATE TABLE site (id INTEGER PRIMARY KEY, domain_name TEXT)");
    db.close();
    expect(pruneMaintenanceState({ paths: { ...paths, panelDb: empty } })).toEqual([]);
    expect(existsSync(join(paths.dataDir, "deleted.example.com"))).toBe(true);

    expect(pruneMaintenanceState({ paths })).toEqual(["deleted.example.com"]);
    expect(readdirSync(paths.dataDir).sort()).toEqual(["_global", "default.html", "example.com", "kept.example.com"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

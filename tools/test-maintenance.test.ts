import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_MAINTENANCE_TEMPLATE, executeMaintenanceAction, MAX_TEMPLATE_BYTES,
  type MaintenanceActionPaths, type MaintenanceStatus,
} from "../addons/maintenance/action";
import { MAINTENANCE_TARGETS } from "../addons/maintenance/inject/targets";
import {
  inspectNginxMaintenance, NGINX_MAINTENANCE_BLOCK, reconcileNginxMaintenance,
} from "../cli/inject";
import { MAINTENANCE_ALLOWED_VERBS } from "../lib/gateway-protocol";

function fixture(): { root: string; paths: MaintenanceActionPaths } {
  const root = mkdtempSync(join(tmpdir(), "clp-maintenance-"));
  const panelDb = join(root, "panel.db");
  const db = new Database(panelDb);
  db.run("CREATE TABLE site (id INTEGER PRIMARY KEY, domain_name TEXT)");
  db.query("INSERT INTO site (domain_name) VALUES (?)").run("example.com");
  db.close();
  const identity = join(root, "panel-identity.conf");
  writeFileSync(identity, "PRIMARY=panel.example.test\nALIASES=\n", { mode: 0o600 });
  return {
    root,
    paths: { dataDir: join(root, "data"), panelDb, panelIdentityFile: identity },
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

test("maintenance integration preserves ACME and uses the per-site CloudPanel tab", () => {
  expect(NGINX_MAINTENANCE_BLOCK).toContain("$uri ~ ^/\\.well-known/acme-challenge/");
  expect(NGINX_MAINTENANCE_BLOCK).toContain("maintenance/$server_name/on");
  expect(NGINX_MAINTENANCE_BLOCK).not.toContain("maintenance/$host/on");
  expect(NGINX_MAINTENANCE_BLOCK).toContain("return 418;");
  expect(NGINX_MAINTENANCE_BLOCK).toContain("error_page 418 =503 @clp_maintenance;");
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

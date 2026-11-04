import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VHOST_VALUE_RULES, storedVhostValues, type VhostValueRule } from "../addons/system-tweaks/vhost-values";
import CASES from "./fixtures/vhost-guard-values.json";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

// The same table tests/integration/integration-vhost-guard.ts sends to vhost-guard.php.
for (const [rule, cases] of Object.entries(CASES) as [VhostValueRule, [string, boolean][]][]) {
  test(`stored ${rule} values are judged as the guard judges them`, () => {
    for (const [value, accepted] of cases) expect([value, VHOST_VALUE_RULES[rule](value)]).toEqual([value, accepted]);
  });
}

test("stored settings the guard would refuse are named by site and field, the Varnish file included", () => {
  const dir = mkdtempSync(join(tmpdir(), "clp-vhost-values-"));
  dirs.push(dir);
  const panelDb = join(dir, "db.sq3");
  const db = new Database(panelDb, { create: true });
  db.exec(`
CREATE TABLE site (id INTEGER PRIMARY KEY, domain_name TEXT, user TEXT, root_directory TEXT, reverse_proxy_url TEXT, basic_auth_id INTEGER);
CREATE TABLE blocked_bot (id INTEGER PRIMARY KEY, site_id INTEGER, name TEXT);
CREATE TABLE blocked_ip (id INTEGER PRIMARY KEY, site_id INTEGER, ip TEXT);
CREATE TABLE basic_auth (id INTEGER PRIMARY KEY, whitelisted_ips TEXT);
CREATE TABLE php_settings (id INTEGER PRIMARY KEY, site_id INTEGER, additional_configuration TEXT);
CREATE TABLE nodejs_settings (id INTEGER PRIMARY KEY, site_id INTEGER, port INTEGER);
CREATE TABLE python_settings (id INTEGER PRIMARY KEY, site_id INTEGER, port INTEGER);
INSERT INTO basic_auth VALUES (1, '192.0.2.1, 198.51.100.0/24'), (2, '192.0.2.1/x; allow all');
INSERT INTO site VALUES
  (1, 'clean.example.com', 'clean', 'clean.example.com', NULL, 1),
  (2, 'shop.example.com', 'shop', 'x;' || char(10) || 'location /dav/ { dav_methods PUT; }', 'http://127.0.0.1:3000; alias /;', 2),
  (3, 'linked.example.com', 'linked', 'linked.example.com', NULL, NULL),
  (4, 'fifo.example.com', 'clean2', 'fifo.example.com', NULL, NULL);
INSERT INTO blocked_bot VALUES (1, 1, 'AhrefsBot'), (2, 2, '+bot');
INSERT INTO blocked_ip VALUES (1, 1, '192.0.2.0/24'), (2, 2, '192.0.2.1/24/x');
INSERT INTO php_settings VALUES (1, 1, 'date.timezone=UTC;'), (2, 2, 'a=b";');
INSERT INTO nodejs_settings VALUES (1, 2, '8000;');
INSERT INTO python_settings VALUES (1, 1, 8000);
`);
  db.close();
  const home = join(dir, "home");
  for (const [user, server] of [["clean", "127.0.0.1:6081/"], ["shop", "127.0.0.1;\nalias /"]]) {
    mkdirSync(join(home, user!, ".varnish-cache"), { recursive: true });
    writeFileSync(join(home, user!, ".varnish-cache", "settings.json"), JSON.stringify({ enabled: true, server }));
  }
  // A link the site's user left is not followed.
  writeFileSync(join(dir, "elsewhere.json"), JSON.stringify({ server: "a b" }));
  mkdirSync(join(home, "linked", ".varnish-cache"), { recursive: true });
  symlinkSync(join(dir, "elsewhere.json"), join(home, "linked", ".varnish-cache", "settings.json"));

  // Nor is a FIFO, which would otherwise wait for a writer forever.
  mkdirSync(join(home, "clean2", ".varnish-cache"), { recursive: true });
  Bun.spawnSync(["mkfifo", join(home, "clean2", ".varnish-cache", "settings.json")]);

  expect(storedVhostValues({ panelDb, homeRoot: home })).toEqual([
    { domain: "shop.example.com", field: "Root Directory" },
    { domain: "shop.example.com", field: "Reverse proxy URL" },
    { domain: "shop.example.com", field: "Blocked bot" },
    { domain: "shop.example.com", field: "Blocked IP" },
    { domain: "shop.example.com", field: "Basic auth whitelisted IPs" },
    { domain: "shop.example.com", field: "Additional configuration directives" },
    { domain: "shop.example.com", field: "Node.js port" },
    { domain: "shop.example.com", field: "Varnish server" },
  ]);
});

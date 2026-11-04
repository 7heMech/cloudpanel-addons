import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResult } from "../cli/action-common";
import {
  addonLogrotate, cloudpanelLogrotate, sitesWithOwnLogrotate,
  installVarnishBackends, removeVarnishBackends, syncVarnishBackends, varnishBackend, varnishBackendsActive,
  type VarnishBackendOptions,
} from "../addons/system-tweaks/varnish-backend";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const TEMPLATE = `server {
  listen 443 ssl;
  server_name shop.example.com;
  {{root}}

  location / {
    {{varnish_proxy_pass}}
    proxy_set_header Host $host;
  }
}

server {
  listen 8080;
  {{root}}
}`;

const rendered = (proxy: string) => TEMPLATE.replaceAll("{{root}}", "root /home/shop/htdocs/shop.example.com;")
  .replace("{{varnish_proxy_pass}}", proxy) + "\n";

const INCLUDE_LINE = (dir: string, domain: string) => `include ${join(dir, "varnish")}/${domain}.conf;`;

interface Fixture { dir: string; db: string; commands: string[]; options: VarnishBackendOptions; settings: (user: string, value: unknown) => void }

function fixture(nginxTest = true): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "clp-varnish-"));
  dirs.push(dir);
  const db = join(dir, "db.sq3");
  const panel = new Database(db, { create: true });
  panel.exec("CREATE TABLE site (id INTEGER PRIMARY KEY, domain_name TEXT, user TEXT, varnish_cache INTEGER, vhost_template TEXT, updated_at TEXT);");
  panel.query("INSERT INTO site (domain_name, user, varnish_cache, vhost_template) VALUES (?, ?, ?, ?)").run("shop.example.com", "shop", 1, TEMPLATE);
  panel.query("INSERT INTO site (domain_name, user, varnish_cache, vhost_template) VALUES (?, ?, ?, ?)").run("static.example.com", "static", 0, "server { {{root}} }");
  panel.close();
  mkdirSync(join(dir, "sites-enabled"));
  writeFileSync(join(dir, "sites-enabled", "shop.example.com.conf"), rendered("proxy_pass http://127.0.0.1:6081;"));
  chmodSync(join(dir, "sites-enabled", "shop.example.com.conf"), 0o644);
  const unit = join(dir, "nginx.service");
  writeFileSync(unit, "[Service]\nExecStartPre=/usr/sbin/nginx -t -q -g 'daemon on; master_process on;'\nExecStart=/usr/sbin/nginx\nExecReload=/usr/sbin/nginx -g 'daemon on; master_process on;' -s reload\n");
  const commands: string[] = [];
  const run = (command: string, args: string[]): CommandResult => {
    commands.push(`${command} ${args.join(" ")}`);
    if (command === "systemctl" && args[0] === "show") return { ok: true, stdout: `${unit}\n`, stderr: "" };
    if (command === "nginx") return nginxTest ? { ok: true, stdout: "", stderr: "" } : { ok: false, stdout: "", stderr: "emerg" };
    return { ok: true, stdout: "", stderr: "" };
  };
  const settings = (user: string, value: unknown) => {
    mkdirSync(join(dir, "home", user, ".varnish-cache"), { recursive: true });
    writeFileSync(join(dir, "home", user, ".varnish-cache", "settings.json"), JSON.stringify(value));
  };
  settings("shop", { enabled: true, server: "127.0.0.1:6081" });
  return {
    dir, db, commands, settings,
    options: {
      run,
      paths: {
        panelDb: db, homeRoot: join(dir, "home"), passwdFile: join(dir, "passwd"), vhostDir: join(dir, "sites-enabled"),
        includeDir: join(dir, "varnish"), logDir: join(dir, "nginx-logs"), logrotateDir: join(dir, "logrotate.d"),
        dropIn: join(dir, "nginx.service.d", "zz-clp-addons-varnish.conf"), bin: "/usr/local/bin/clp-addons", vhostUid: process.getuid!(),
      },
    },
  };
}

const template = (f: Fixture, domain = "shop.example.com") => {
  const db = new Database(f.db, { readonly: true });
  try { return db.query<{ vhost_template: string }, [string]>("SELECT vhost_template FROM site WHERE domain_name = ?").get(domain)!.vhost_template; }
  finally { db.close(); }
};
const vhost = (f: Fixture) => readFileSync(join(f.dir, "sites-enabled", "shop.example.com.conf"), "utf8");
const include = (f: Fixture, domain = "shop.example.com") => readFileSync(join(f.dir, "varnish", `${domain}.conf`), "utf8").split("\n")[1];

test("the backend line is CloudPanel's, unless the server would add nginx directives", () => {
  expect(varnishBackend(false, { enabled: true, server: "127.0.0.1:6081" })).toEqual({ line: "", refused: false });
  expect(varnishBackend(true, { enabled: true, server: "/127.0.0.1:6081/" })).toEqual({ line: "proxy_pass http://127.0.0.1:6081;", refused: false });
  expect(varnishBackend(true, { enabled: true, server: "[::1]:6081" })).toEqual({ line: "proxy_pass http://[::1]:6081;", refused: false });
  expect(varnishBackend(true, { enabled: false, server: "127.0.0.1:6081" })).toEqual({ line: "proxy_pass http://127.0.0.1:8080;", refused: false });
  expect(varnishBackend(true, { enabled: "true", server: "127.0.0.1:6081" })).toEqual({ line: "proxy_pass http://127.0.0.1:8080;", refused: false });
  expect(varnishBackend(true, null)).toEqual({ line: "proxy_pass http://127.0.0.1:8080;", refused: false });
  expect(varnishBackend(true, { enabled: true, server: "127.0.0.1:6081; } location /dav/ { alias /; dav_methods PUT; } location /x {" }))
    .toEqual({ line: "proxy_pass http://127.0.0.1:8080;", refused: true });
  expect(varnishBackend(true, { enabled: true, server: 6081 })).toEqual({ line: "proxy_pass http://127.0.0.1:8080;", refused: true });
});

test("switching on points each Varnish site's vhost at its include, which the sync writes before every reload", () => {
  const f = fixture();
  expect(installVarnishBackends(f.options)).toBe(true);
  expect(template(f)).not.toContain("{{varnish_proxy_pass}}");
  expect(template(f)).toContain(`    ${INCLUDE_LINE(f.dir, "shop.example.com")}\n    proxy_set_header`);
  expect(template(f, "static.example.com")).toBe("server { {{root}} }");
  expect(vhost(f)).toBe(rendered(INCLUDE_LINE(f.dir, "shop.example.com")));
  expect(include(f)).toBe("proxy_pass http://127.0.0.1:6081;");
  expect(existsSync(join(f.dir, "varnish", "static.example.com.conf"))).toBe(false);
  expect(readFileSync(f.options.paths!.dropIn!, "utf8")).toBe([
    "# Managed by clp-addons System Tweaks: writes each site's checked Varnish backend before nginx loads the vhosts.",
    "[Service]",
    "ExecStartPre=",
    "ExecStartPre=-/usr/local/bin/clp-addons sync-varnish",
    "ExecStartPre=/usr/sbin/nginx -t -q -g 'daemon on; master_process on;'",
    "ExecReload=",
    "ExecReload=-/usr/local/bin/clp-addons sync-varnish",
    "ExecReload=/usr/sbin/nginx -g 'daemon on; master_process on;' -s reload",
    "",
  ].join("\n"));
  expect(f.commands).toEqual(expect.arrayContaining(["systemctl daemon-reload", "nginx -t", "systemctl reload nginx"]));
  expect(varnishBackendsActive(f.options)).toBe(true);

  f.commands.length = 0;
  expect(installVarnishBackends(f.options)).toBe(false);
  expect(f.commands).not.toContain("systemctl reload nginx");

  // What the site's own user writes reaches nginx only as a line this wrote.
  f.settings("shop", { enabled: true, server: "127.0.0.1:6081; } location /dav/ { alias /; dav_methods PUT; } location /x {" });
  expect(syncVarnishBackends(f.options)).toEqual(["shop.example.com"]);
  expect(include(f)).toBe("proxy_pass http://127.0.0.1:8080;");
  f.settings("shop", { enabled: false, server: "127.0.0.1:6081" });
  expect(syncVarnishBackends(f.options)).toEqual([]);
  expect(include(f)).toBe("proxy_pass http://127.0.0.1:8080;");
  rmSync(join(f.dir, "home", "shop", ".varnish-cache", "settings.json"));
  writeFileSync(join(f.dir, "elsewhere.json"), JSON.stringify({ enabled: true, server: "10.0.0.1:6081" }));
  symlinkSync(join(f.dir, "elsewhere.json"), join(f.dir, "home", "shop", ".varnish-cache", "settings.json"));
  syncVarnishBackends(f.options);
  expect(include(f)).toBe("proxy_pass http://127.0.0.1:8080;");
});

test("a site whose stored vhost brings the placeholder back is not in force until it is moved again", () => {
  const f = fixture();
  installVarnishBackends(f.options);
  const db = new Database(f.db);
  db.query("INSERT INTO site (domain_name, user, varnish_cache, vhost_template) VALUES (?, ?, ?, ?)").run("new.example.com", "new", 1, TEMPLATE);
  db.close();
  expect(varnishBackendsActive(f.options)).toBe(false);
  expect(installVarnishBackends(f.options)).toBe(true);
  expect(template(f, "new.example.com")).toContain(INCLUDE_LINE(f.dir, "new.example.com"));
  expect(include(f, "new.example.com")).toBe("proxy_pass http://127.0.0.1:8080;");
  expect(varnishBackendsActive(f.options)).toBe(true);
});

test("a rendered vhost that differs from its stored one keeps its line until CloudPanel renders it", () => {
  const f = fixture();
  const drifted = rendered("proxy_pass http://127.0.0.1:6081;").replace("listen 8080;", "listen 8080;\n  # an edit by hand");
  writeFileSync(join(f.dir, "sites-enabled", "shop.example.com.conf"), drifted);
  installVarnishBackends(f.options);
  expect(template(f)).toContain(INCLUDE_LINE(f.dir, "shop.example.com"));
  expect(vhost(f)).toBe(drifted);
});

test("nginx refusing the vhosts leaves the stored and rendered ones as they were", () => {
  const f = fixture(false);
  expect(() => installVarnishBackends(f.options)).toThrow("Nginx validation failed");
  expect(template(f)).toBe(TEMPLATE);
  expect(vhost(f)).toBe(rendered("proxy_pass http://127.0.0.1:6081;"));
});

test("a unit this addon does not know is left alone", () => {
  const f = fixture();
  writeFileSync(join(f.dir, "nginx.service"), "[Service]\nExecStart=/usr/sbin/nginx\n");
  expect(() => installVarnishBackends(f.options)).toThrow("is not the nginx unit this addon knows");
  expect(existsSync(f.options.paths!.dropIn!)).toBe(false);
  expect(template(f)).toBe(TEMPLATE);
});

test("switching off puts the placeholder and the checked line back, then removes the sync and the includes", () => {
  const f = fixture();
  installVarnishBackends(f.options);
  // A site deleted since leaves only its include behind.
  writeFileSync(join(f.dir, "varnish", "gone.example.com.conf"), "proxy_pass http://127.0.0.1:8080;\n");
  syncVarnishBackends(f.options);
  expect(existsSync(join(f.dir, "varnish", "gone.example.com.conf"))).toBe(false);

  f.commands.length = 0;
  expect(removeVarnishBackends(f.options)).toBe(true);
  expect(template(f)).toBe(TEMPLATE);
  expect(vhost(f)).toBe(rendered("proxy_pass http://127.0.0.1:6081;"));
  expect(existsSync(f.options.paths!.dropIn!)).toBe(false);
  expect(existsSync(join(f.dir, "varnish"))).toBe(false);
  expect(f.commands).toEqual(["systemctl daemon-reload", "nginx -t", "systemctl reload nginx"]);
  expect(removeVarnishBackends(f.options)).toBe(false);
});

test("switching off keeps an include a rendered vhost still names", () => {
  const f = fixture();
  installVarnishBackends(f.options);
  const line = INCLUDE_LINE(f.dir, "shop.example.com");
  // CloudPanel rendering from the old stored vhost just after the revert read the file.
  const run = f.options.run!;
  f.options.run = (command, args) => {
    const result = run(command, args);
    if (command === "systemctl" && args[0] === "reload") writeFileSync(join(f.dir, "sites-enabled", "shop.example.com.conf"), rendered(line));
    return result;
  };
  removeVarnishBackends(f.options);
  expect(include(f)).toBe("proxy_pass http://127.0.0.1:6081;");
});

test("site nginx logs move to a root-owned directory with ~/logs/nginx linked to it, and move back on switch-off", () => {
  const f = fixture();
  const logTemplate = `server {\n  listen 443 ssl;\n  server_name shop.example.com;\n  {{root}}\n\n  {{nginx_access_log}}\n  {{nginx_error_log}}\n\n  location / {\n    {{varnish_proxy_pass}}\n    proxy_set_header Host $host;\n  }\n}`;
  const logRendered = `server {\n  listen 443 ssl;\n  server_name shop.example.com;\n  root /home/shop/htdocs/shop.example.com;\n\n  access_log /home/shop/logs/nginx/access.log cloudflare;\n  include /etc/nginx/cloudflare/ips;\n  error_log /home/shop/logs/nginx/error.log;\n\n  location / {\n    proxy_pass http://127.0.0.1:6081;\n    proxy_set_header Host $host;\n  }\n}\n`;
  const db = new Database(f.db);
  db.exec("ALTER TABLE site ADD COLUMN allow_traffic_from_cloudflare_only INTEGER DEFAULT 0;");
  db.query("UPDATE site SET allow_traffic_from_cloudflare_only = 1, vhost_template = ? WHERE domain_name = 'shop.example.com'").run(logTemplate);
  db.close();
  writeFileSync(join(f.dir, "sites-enabled", "shop.example.com.conf"), logRendered);
  chmodSync(join(f.dir, "sites-enabled", "shop.example.com.conf"), 0o644);

  const userNginxLogs = join(f.dir, "home", "shop", "logs", "nginx");
  mkdirSync(userNginxLogs, { recursive: true });
  writeFileSync(join(userNginxLogs, "access.log"), "existing access line\n");
  writeFileSync(join(userNginxLogs, "notes.txt"), "kept\n");
  writeFileSync(join(f.dir, "canary.txt"), "root secret\n");
  symlinkSync(join(f.dir, "canary.txt"), join(userNginxLogs, "error.log"));

  expect(installVarnishBackends(f.options)).toBe(true);
  const managedDir = join(f.dir, "nginx-logs", "shop");
  expect(readFileSync(join(managedDir, "access.log"), "utf8")).toBe("existing access line\n");
  // The symlink in ~/logs/nginx was not followed when migrating logs.
  expect(readFileSync(join(managedDir, "error.log"), "utf8")).toBe("");
  expect(readFileSync(join(f.dir, "canary.txt"), "utf8")).toBe("root secret\n");
  expect(readFileSync(join(userNginxLogs, "access.log"), "utf8")).toBe("existing access line\n");
  // What is not a log is moved aside with the old directory, not deleted.
  const aside = readdirSync(join(f.dir, "home", "shop", "logs")).filter((name) => name.startsWith("nginx.before-clp-addons-"));
  expect(aside.length).toBe(1);
  expect(readFileSync(join(f.dir, "home", "shop", "logs", aside[0]!, "notes.txt"), "utf8")).toBe("kept\n");
  expect(existsSync(join(f.dir, "home", "shop", "logs", aside[0]!, "access.log"))).toBe(false);

  expect(template(f)).not.toContain("{{nginx_access_log}}");
  expect(template(f)).not.toContain("{{nginx_error_log}}");
  expect(template(f)).toContain(`  access_log ${managedDir}/access.log cloudflare;\n  error_log ${managedDir}/error.log;`);
  expect(vhost(f)).toContain(`  access_log ${managedDir}/access.log cloudflare;\n  include /etc/nginx/cloudflare/ips;\n  error_log ${managedDir}/error.log;`);
  expect(varnishBackendsActive(f.options)).toBe(true);

  // If the site user swaps ~/logs/nginx for another symlink, the next sync points it back at managedDir.
  rmSync(userNginxLogs, { force: true });
  symlinkSync(join(f.dir, "canary.txt"), userNginxLogs);
  syncVarnishBackends(f.options);
  expect(readFileSync(join(userNginxLogs, "access.log"), "utf8")).toBe("existing access line\n");
  expect(readFileSync(join(f.dir, "canary.txt"), "utf8")).toBe("root secret\n");

  expect(removeVarnishBackends(f.options)).toBe(true);
  expect(template(f)).toBe(logTemplate);
  expect(vhost(f)).toBe(logRendered);
  expect(existsSync(join(f.dir, "nginx-logs"))).toBe(false);
  expect(readFileSync(join(userNginxLogs, "access.log"), "utf8")).toBe("existing access line\n");
});

test("a rendered vhost whose placeholders cannot be read back still gets root's log paths, and keeps them on every reload", () => {
  const f = fixture();
  const logTemplate = `server {\n  server_name shop.example.com;\n  {{nginx_access_log}}\n  {{nginx_error_log}}\n  location / {\n    {{varnish_proxy_pass}}\n  }\n}`;
  // Edited by hand after CloudPanel rendered it, so it no longer matches the stored one.
  const logRendered = `server {\n  server_name shop.example.com;\n  access_log /home/shop/logs/nginx/access.log main;\n  error_log /home/shop/logs/nginx/error.log;\n  add_header X-Edited yes;\n  location / {\n    proxy_pass http://127.0.0.1:6081;\n  }\n}\n`;
  const db = new Database(f.db);
  db.query("UPDATE site SET vhost_template = ? WHERE domain_name = 'shop.example.com'").run(logTemplate);
  db.close();
  const conf = join(f.dir, "sites-enabled", "shop.example.com.conf");
  writeFileSync(conf, logRendered);
  chmodSync(conf, 0o644);
  const managedDir = join(f.dir, "nginx-logs", "shop");

  installVarnishBackends(f.options);
  expect(vhost(f)).toContain(`  access_log ${managedDir}/access.log main;\n  error_log ${managedDir}/error.log;\n  add_header X-Edited yes;`);
  expect(vhost(f)).not.toContain("/home/shop/logs");
  expect(varnishBackendsActive(f.options)).toBe(true);

  // CloudPanel renders it again with paths in the home, as for a new site: the sync before the reload moves them.
  writeFileSync(conf, logRendered);
  expect(varnishBackendsActive(f.options)).toBe(false);
  syncVarnishBackends(f.options);
  expect(vhost(f)).not.toContain("/home/shop/logs");
  expect(varnishBackendsActive(f.options)).toBe(true);
});

test("CloudPanel's logrotate file rotates the site's own folders as its user and nginx's as root, and comes back on switch-off", () => {
  const f = fixture();
  const dir = join(f.dir, "logrotate.d");
  mkdirSync(dir, { recursive: true });
  // As CloudPanel writes it: its template, without a final newline.
  writeFileSync(join(dir, "shop"), cloudpanelLogrotate("shop"));
  chmodSync(join(dir, "shop"), 0o644);
  installVarnishBackends(f.options);
  const managed = readFileSync(join(dir, "shop"), "utf8");
  expect(managed).toBe(addonLogrotate("shop", join(f.dir, "nginx-logs")));
  expect(managed).toContain("/home/shop/logs/php/*.log /home/shop/logs/varnish-cache/*.log {\n    su shop shop\n");
  expect(managed).toContain(`${join(f.dir, "nginx-logs")}/shop/*.log {\n    daily`);
  expect(managed).not.toContain("su root root");
  expect(sitesWithOwnLogrotate(f.options)).toEqual([]);

  removeVarnishBackends(f.options);
  expect(readFileSync(join(dir, "shop"), "utf8")).toBe(cloudpanelLogrotate("shop"));
});

test("a logrotate file edited by hand is left as it is and listed", () => {
  const f = fixture();
  const dir = join(f.dir, "logrotate.d");
  mkdirSync(dir, { recursive: true });
  const edited = `${cloudpanelLogrotate("shop").replace("rotate 7", "rotate 30")}\n`;
  writeFileSync(join(dir, "shop"), edited);
  chmodSync(join(dir, "shop"), 0o644);
  installVarnishBackends(f.options);
  expect(readFileSync(join(dir, "shop"), "utf8")).toBe(edited);
  expect(sitesWithOwnLogrotate(f.options)).toEqual(["shop.example.com"]);
});

test("a deleted site's log directory goes with it, unless a site row or a vhost still names it, and removing it follows no link", () => {
  const f = fixture();
  const logDir = join(f.dir, "nginx-logs");
  const db = new Database(f.db);
  db.query("UPDATE site SET vhost_template = ? WHERE domain_name = 'shop.example.com'").run("server {\n  {{nginx_access_log}}\n  {{nginx_error_log}}\n}");
  db.close();
  installVarnishBackends(f.options);
  expect(existsSync(join(logDir, "shop", "access.log"))).toBe(true);
  writeFileSync(join(logDir, "shop", "access.log"), "request\n");
  writeFileSync(join(f.dir, "canary.txt"), "root secret\n");
  symlinkSync(join(f.dir, "canary.txt"), join(logDir, "shop", "access.log-2026-11-03"));
  mkdirSync(join(f.dir, "elsewhere"));
  writeFileSync(join(f.dir, "elsewhere", "kept.log"), "kept\n");
  symlinkSync(join(f.dir, "elsewhere"), join(logDir, "linked"));
  // A row the sync skips, here one with no stored vhost, still keeps its user's directory.
  mkdirSync(join(logDir, "odd"));
  const panel = new Database(f.db);
  panel.query("INSERT INTO site (domain_name, user, varnish_cache, vhost_template) VALUES (?, ?, ?, NULL)").run("odd.example.com", "odd", 0);
  panel.close();
  // A vhost linked in from elsewhere still writing there keeps it too.
  mkdirSync(join(logDir, "gone"));
  mkdirSync(join(f.dir, "sites-available"));
  writeFileSync(join(f.dir, "sites-available", "gone.example.com.conf"), `server {\n  error_log ${logDir}/gone/error.log;\n}\n`);
  symlinkSync(join(f.dir, "sites-available", "gone.example.com.conf"), join(f.dir, "sites-enabled", "gone.example.com.conf"));

  // CloudPanel deletes the site: its vhost, then its row.
  rmSync(join(f.dir, "sites-enabled", "shop.example.com.conf"));
  syncVarnishBackends(f.options);
  expect(existsSync(join(logDir, "shop"))).toBe(true);
  const after = new Database(f.db);
  after.exec("DELETE FROM site WHERE domain_name = 'shop.example.com'");
  after.close();
  syncVarnishBackends(f.options);

  expect(existsSync(join(logDir, "shop"))).toBe(false);
  expect(readFileSync(join(f.dir, "canary.txt"), "utf8")).toBe("root secret\n");
  expect(existsSync(join(logDir, "linked"))).toBe(false);
  expect(readFileSync(join(f.dir, "elsewhere", "kept.log"), "utf8")).toBe("kept\n");
  expect(existsSync(join(logDir, "odd"))).toBe(true);
  expect(existsSync(join(logDir, "gone"))).toBe(true);

  rmSync(join(f.dir, "sites-enabled", "gone.example.com.conf"));
  syncVarnishBackends(f.options);
  expect(existsSync(join(logDir, "gone"))).toBe(false);
});

// As root, fchown to another user succeeds, so nothing here fails.
test.skipIf(process.getuid?.() === 0)("a switch-off that fails while putting ~/logs/nginx back puts the drop-in and the link back", () => {
  const f = fixture();
  const db = new Database(f.db);
  db.query("UPDATE site SET vhost_template = ? WHERE domain_name = 'shop.example.com'").run("server {\n  {{nginx_access_log}}\n  {{nginx_error_log}}\n  location / {\n    {{varnish_proxy_pass}}\n  }\n}");
  db.close();
  mkdirSync(join(f.dir, "home", "shop", "logs", "nginx"), { recursive: true });
  installVarnishBackends(f.options);
  const dropIn = readFileSync(f.options.paths!.dropIn!, "utf8");
  const managedDir = join(f.dir, "nginx-logs", "shop");
  const homeLogs = join(f.dir, "home", "shop", "logs", "nginx");
  expect(readlinkSync(homeLogs)).toBe(managedDir);

  // A user this process cannot give the directory to makes unstaging the logs throw.
  writeFileSync(f.options.paths!.passwdFile!, "shop:x:4242:4242::/home/shop:/bin/bash\n");
  expect(() => removeVarnishBackends(f.options)).toThrow();

  expect(readFileSync(f.options.paths!.dropIn!, "utf8")).toBe(dropIn);
  expect(lstatSync(homeLogs).isSymbolicLink()).toBe(true);
  expect(readlinkSync(homeLogs)).toBe(managedDir);
  expect(template(f)).toContain(`access_log ${managedDir}/access.log main;`);
  expect(existsSync(join(managedDir, "access.log"))).toBe(true);
  expect(f.commands.filter((command) => command === "systemctl daemon-reload").length).toBe(3);
});

test("switching off keeps aside, in a directory only root can read, whatever it could not copy back in full", () => {
  const f = fixture();
  const db = new Database(f.db);
  db.query("UPDATE site SET vhost_template = ? WHERE domain_name = 'shop.example.com'").run("server {\n  {{nginx_access_log}}\n  {{nginx_error_log}}\n}");
  db.close();
  mkdirSync(join(f.dir, "home", "shop", "logs"), { recursive: true });
  installVarnishBackends(f.options);
  const managedDir = join(f.dir, "nginx-logs", "shop");
  const homeLogs = join(f.dir, "home", "shop", "logs", "nginx");
  writeFileSync(join(managedDir, "access.log"), "before\n");
  writeFileSync(join(managedDir, "error.log"), "an error\n");
  writeFileSync(join(managedDir, "notes.txt"), "not a log\n");
  // Over the 64 MiB copy limit; sparse, so it takes no space.
  const big = join(managedDir, "access.log-2026-11-01");
  writeFileSync(big, "");
  truncateSync(big, 64 * 1024 * 1024 + 10);
  // nginx writes to root's log between the copy and the reload.
  const run = f.options.run!;
  f.options.run = (command, args) => {
    if (command === "systemctl" && args.join(" ") === "reload nginx") appendFileSync(join(managedDir, "access.log"), "after\n");
    return run(command, args);
  };

  removeVarnishBackends(f.options);
  expect(existsSync(join(f.dir, "nginx-logs"))).toBe(false);
  expect(readFileSync(join(homeLogs, "access.log"), "utf8")).toBe("before\n");
  expect(readFileSync(join(homeLogs, "error.log"), "utf8")).toBe("an error\n");
  expect(statSync(join(homeLogs, "access.log-2026-11-01")).size).toBe(64 * 1024 * 1024);

  const keptRoot = join(f.dir, "nginx-logs-kept");
  expect(statSync(keptRoot).mode & 0o777).toBe(0o700);
  const kept = readdirSync(keptRoot);
  expect(kept.length).toBe(1);
  expect(kept[0]).toMatch(/^shop-[0-9]+$/);
  const aside = join(keptRoot, kept[0]!);
  expect(readdirSync(aside).sort()).toEqual(["access.log", "access.log-2026-11-01", "notes.txt"]);
  expect(readFileSync(join(aside, "access.log"), "utf8")).toBe("before\nafter\n");
  expect(statSync(join(aside, "access.log-2026-11-01")).size).toBe(64 * 1024 * 1024 + 10);
});

test("switching off leaves nothing aside when every log was copied back in full", () => {
  const f = fixture();
  const db = new Database(f.db);
  db.query("UPDATE site SET vhost_template = ? WHERE domain_name = 'shop.example.com'").run("server {\n  {{nginx_access_log}}\n  {{nginx_error_log}}\n}");
  db.close();
  mkdirSync(join(f.dir, "home", "shop", "logs"), { recursive: true });
  installVarnishBackends(f.options);
  writeFileSync(join(f.dir, "nginx-logs", "shop", "access.log"), "a request\n");
  removeVarnishBackends(f.options);
  expect(existsSync(join(f.dir, "nginx-logs"))).toBe(false);
  expect(existsSync(join(f.dir, "nginx-logs-kept"))).toBe(false);
  expect(readFileSync(join(f.dir, "home", "shop", "logs", "nginx", "access.log"), "utf8")).toBe("a request\n");
});

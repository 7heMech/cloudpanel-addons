import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResult } from "../cli/action-common";
import {
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
        panelDb: db, homeRoot: join(dir, "home"), vhostDir: join(dir, "sites-enabled"), includeDir: join(dir, "varnish"),
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

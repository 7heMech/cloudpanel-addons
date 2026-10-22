import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectNginxMaintenance, NGINX_MAINTENANCE_BLOCK, reconcileNginxMaintenance } from "../cli/inject";
import { MAINTENANCE_INCLUDE_PATH, transformMaintenanceVhost } from "../cli/maintenance-vhosts";
import { trustedVhost } from "../cli/nginx-transaction";
import { reconcileUnits } from "../cli/provision";
import { PANEL_DB } from "../cli/paths";
import type { CommandResult } from "../cli/action-common";

const domain = "example.test";
const include = `include ${MAINTENANCE_INCLUDE_PATH};`;
const redirect = `server {
  listen 443 ssl;
  server_name www.${domain};
  return 301 https://${domain}$request_uri;
}
`;

function upstream(name: string): string {
  return readFileSync(join(import.meta.dir, "fixtures/vhost-templates", `${name}.conf`), "utf8");
}

function rendered(template: string): string {
  return redirect + template.replaceAll("{{server_name}}", `server_name ${domain} alias.test;`)
    .replaceAll("{{root}}", "root /home/example/htdocs/example.test;")
    .replaceAll("{{php_fpm_port}}", "9000").replaceAll("{{reverse_proxy_url}}", "http://127.0.0.1:3000")
    .replace(/\{\{[^}]+\}\}/g, "");
}

for (const name of ["v2-varnish-WordPress-WordPress", "v1-WordPress-WordPress-5"]) {
  test(`${name}: maintenance belongs in the 8080 backend in template and rendered vhost`, () => {
    for (const content of [upstream(name), rendered(upstream(name))]) {
      const changed = transformMaintenanceVhost(content, domain, true);
      const backend = changed.lastIndexOf("server {");
      expect(changed.slice(0, backend)).not.toContain(include);
      expect(changed.slice(backend)).toContain(include);
      expect(changed.match(/maintenance-include:start/g)).toHaveLength(1);
      expect(transformMaintenanceVhost(changed, domain, true)).toBe(changed);
      expect(transformMaintenanceVhost(changed, domain, false)).toBe(content);
    }
  });
}

for (const name of ["v2-Generic-Generic", "v2-Static-Static", "v2-varnish-ReverseProxy-ReverseProxy"]) {
  test(`${name}: maintenance belongs in the canonical main server`, () => {
    for (const content of [upstream(name), rendered(upstream(name))]) {
      const changed = transformMaintenanceVhost(content, domain, true);
      expect(changed).toContain(include);
      if (content.startsWith(redirect)) expect(changed.startsWith(redirect)).toBe(true);
      const fileBreak = changed.lastIndexOf("if (-f $request_filename)");
      if (fileBreak >= 0) expect(changed.indexOf(include)).toBeLessThan(fileBreak);
      expect(transformMaintenanceVhost(changed, domain, true)).toBe(changed);
      expect(transformMaintenanceVhost(changed, domain, false)).toBe(content);
    }
  });
}

for (const name of ["v2-http3-WordPress-WordPress", "v2-http3-Static-Static"]) {
  test(`${name}: sites using global_settings remain byte-for-byte unchanged`, () => {
    for (const content of [upstream(name), rendered(upstream(name))]) {
      expect(transformMaintenanceVhost(content, domain, true)).toBe(content);
      expect(transformMaintenanceVhost(content, domain, false)).toBe(content);
      const migrated = content.replace("include /etc/nginx/global_settings;", `include /etc/nginx/global_settings;\n  # clp-addons:maintenance-include:start\n  ${include}\n  # clp-addons:maintenance-include:end\n`);
      expect(transformMaintenanceVhost(migrated, domain, true)).toBe(content);
    }
  });
}

test("selection ignores comments, quoted braces, nested names, and other sites", () => {
  const content = `${redirect}# server { listen 8080; server_name example.test; }\nserver {
    listen 443 ssl;
    server_name example.test;
    set $quoted "server { # }";
    set $variable \${request_uri};
    location / { proxy_set_header server_name example.test; }
  }\nserver { listen 8080; server_name other.test; }\n`;
  const changed = transformMaintenanceVhost(content, domain, true);
  expect(changed.startsWith(redirect)).toBe(true);
  expect(changed.indexOf(include)).toBeLessThan(changed.indexOf("listen 443 ssl;", redirect.length));
  expect(transformMaintenanceVhost(changed, domain, false)).toBe(content);
});

test("ambiguous and missing serving blocks fail closed; removal requires no serving block", () => {
  const server = `server { listen 443 ssl; server_name ${domain}; }`;
  expect(() => transformMaintenanceVhost(`${server}\n${server}`, domain, true)).toThrow("ambiguous");
  expect(() => transformMaintenanceVhost(redirect, domain, true)).toThrow("missing");
  const removed = transformMaintenanceVhost(server, domain, true).replace(domain, "renamed.test");
  expect(transformMaintenanceVhost(removed, domain, false)).toBe(server.replace(domain, "renamed.test"));
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "maintenance-vhosts-"));
  const panelDb = join(root, "panel.sqlite");
  const db = new Database(panelDb);
  db.exec("CREATE TABLE site (domain_name TEXT PRIMARY KEY, vhost_template TEXT, updated_at TEXT);");
  const paths = {
    panelDb, settingsPath: join(root, "global_settings"), stateDir: join(root, "state"),
    geoPath: join(root, "vhosts", "00-clp-addons-maintenance-client-ip.conf"),
    includePath: join(root, "maintenance.conf"), nginxVhostDir: join(root, "vhosts"),
    vhostUid: process.getuid?.() ?? 0,
  };
  mkdirSync(paths.nginxVhostDir);
  writeFileSync(paths.settingsPath, "client_max_body_size 128m;", { mode: 0o644 });
  function addSite(name = domain, template = upstream("v2-varnish-WordPress-WordPress")) {
    db.query("INSERT INTO site VALUES (?, ?, NULL);").run(name, template);
    writeFileSync(join(paths.nginxVhostDir, `${name}.conf`), rendered(template).replaceAll(domain, name), { mode: 0o644 });
  }
  function template(name = domain): string {
    return db.query<{ vhost_template: string }, [string]>("SELECT vhost_template FROM site WHERE domain_name = ?;").get(name)!.vhost_template;
  }
  const commands: string[] = [];
  const run = (command: string, args: string[]): CommandResult => {
    commands.push([command, ...args].join(" "));
    return { ok: true, exitCode: 0, stdout: "", stderr: "" };
  };
  return { root, db, paths, addSite, template, commands, run, cleanup() { db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("reconciliation covers persisted templates, rendered files and new sites, then removes cleanly", () => {
  const f = fixture();
  try {
    f.addSite();
    f.addSite("http3.test", upstream("v2-http3-WordPress-WordPress"));
    const original = f.template();
    const originalRendered = readFileSync(join(f.paths.nginxVhostDir, `${domain}.conf`), "utf8");
    const http3Template = f.template("http3.test");
    expect(reconcileNginxMaintenance({ ...f.paths, run: f.run })).toMatchObject({ state: "ok", changed: true });
    expect(f.commands).toEqual(["nginx -t", "systemctl reload nginx"]);
    expect(f.template()).toContain(`include ${f.paths.includePath};`);
    expect(f.template("http3.test")).toBe(http3Template);
    expect(readFileSync(f.paths.includePath, "utf8")).toBe(`${NGINX_MAINTENANCE_BLOCK}\n`);
    expect(inspectNginxMaintenance(f.paths).state).toBe("ok");
    expect(reconcileNginxMaintenance({ ...f.paths, run: f.run }).changed).toBe(false);
    expect(f.commands).toHaveLength(2);

    f.addSite("new.test", upstream("v2-Static-Static"));
    expect(inspectNginxMaintenance(f.paths)).toMatchObject({ state: "uncovered-sites", uncoveredSites: ["new.test"] });
    expect(reconcileNginxMaintenance({ ...f.paths, run: f.run }).state).toBe("ok");
    expect(f.template("new.test")).toContain(`include ${f.paths.includePath};`);
    expect(inspectNginxMaintenance(f.paths).state).toBe("ok");

    // CloudPanel re-renders the persisted template without losing the include.
    writeFileSync(join(f.paths.nginxVhostDir, `${domain}.conf`), rendered(f.template()));
    expect(inspectNginxMaintenance(f.paths).state).toBe("ok");
    expect(reconcileNginxMaintenance({ ...f.paths, enabled: false, run: f.run })).toMatchObject({ state: "missing", changed: true });
    expect(f.template()).toBe(original);
    expect(readFileSync(join(f.paths.nginxVhostDir, `${domain}.conf`), "utf8")).toBe(originalRendered);
    expect(existsSync(f.paths.includePath)).toBe(false);
    expect(existsSync(f.paths.geoPath)).toBe(false);
    expect(readFileSync(f.paths.settingsPath, "utf8")).toBe("client_max_body_size 128m;");
    expect(reconcileNginxMaintenance({ ...f.paths, enabled: false, run: f.run }).changed).toBe(false);
  } finally { f.cleanup(); }
});

for (const failedCommand of ["nginx", "systemctl"]) {
  test(`failed ${failedCommand} rolls back all site rows and Nginx files`, () => {
    const f = fixture();
    try {
      f.addSite();
      const original = f.template();
      const originalRendered = readFileSync(join(f.paths.nginxVhostDir, `${domain}.conf`), "utf8");
      let failed = false;
      const run = (command: string, args: string[]): CommandResult => {
        f.run(command, args);
        if (command === failedCommand && !failed) {
          failed = true;
          return { ok: false, exitCode: 1, stdout: "", stderr: "simulated failure" };
        }
        return { ok: true, exitCode: 0, stdout: "", stderr: "" };
      };
      expect(reconcileNginxMaintenance({ ...f.paths, run })).toMatchObject({ state: "validation-failed", changed: false });
      expect(f.template()).toBe(original);
      expect(readFileSync(join(f.paths.nginxVhostDir, `${domain}.conf`), "utf8")).toBe(originalRendered);
      expect(readFileSync(f.paths.settingsPath, "utf8")).toBe("client_max_body_size 128m;");
      expect(existsSync(f.paths.includePath)).toBe(false);
      expect(existsSync(f.paths.geoPath)).toBe(false);
      expect(f.commands).toEqual(failedCommand === "nginx"
        ? ["nginx -t", "nginx -t"]
        : ["nginx -t", "systemctl reload nginx", "nginx -t", "systemctl reload nginx"]);
      expect(reconcileNginxMaintenance({ ...f.paths, run: f.run }).state).toBe("ok");
    } finally { f.cleanup(); }
  });
}

test("status reports drift in either persisted or rendered vhosts, missing files and unreadable inventory", () => {
  const f = fixture();
  try {
    f.addSite();
    const original = f.template();
    reconcileNginxMaintenance({ ...f.paths, run: f.run });
    f.db.query("UPDATE site SET vhost_template = ?;").run(original);
    writeFileSync(join(f.paths.nginxVhostDir, `${domain}.conf`), rendered(original));
    rmSync(f.paths.includePath);
    expect(inspectNginxMaintenance(f.paths)).toMatchObject({ state: "uncovered-sites", uncoveredSites: [domain] });
    reconcileNginxMaintenance({ ...f.paths, run: f.run });
    f.db.query("UPDATE site SET vhost_template = ?;").run(original);
    expect(inspectNginxMaintenance(f.paths)).toMatchObject({ state: "uncovered-sites", uncoveredSites: [domain] });
    reconcileNginxMaintenance({ ...f.paths, run: f.run });
    writeFileSync(join(f.paths.nginxVhostDir, `${domain}.conf`), rendered(original));
    expect(inspectNginxMaintenance(f.paths)).toMatchObject({ state: "uncovered-sites", uncoveredSites: [domain] });
    reconcileNginxMaintenance({ ...f.paths, run: f.run });
    rmSync(join(f.paths.nginxVhostDir, `${domain}.conf`));
    expect(inspectNginxMaintenance(f.paths)).toMatchObject({ state: "uncovered-sites", uncoveredSites: [domain] });
    expect(inspectNginxMaintenance({ ...f.paths, panelDb: join(f.root, "missing.sqlite") }).state).toBe("uncovered-sites");
  } finally { f.cleanup(); }
});

test("an untrusted or unplaceable vhost is skipped and reported without blocking other sites", () => {
  const f = fixture();
  try {
    f.addSite();
    f.addSite("odd.test", `server { listen 443 ssl; server_name odd.test; }\nserver { listen 443 ssl; server_name odd.test; }\n`);
    f.addSite("good.test", upstream("v2-Static-Static"));
    chmodSync(join(f.paths.nginxVhostDir, `${domain}.conf`), 0o666);
    const original = f.template();
    expect(reconcileNginxMaintenance({ ...f.paths, run: f.run }).state).toBe("ok");
    expect(f.template()).toBe(original);
    expect(f.template("good.test")).toContain(`include ${f.paths.includePath};`);
    expect(inspectNginxMaintenance(f.paths)).toMatchObject({ state: "uncovered-sites", uncoveredSites: [domain, "odd.test"] });
  } finally { f.cleanup(); }
});

test("a vhost that says why it leaves out global_settings is not given the check", () => {
  const f = fixture();
  try {
    const optOut = upstream("v2-Static-Static").replace("index index.html;", "# global_settings (box-wide maintenance) is not included on purpose.\n  index index.html;");
    f.addSite(domain, optOut);
    expect(transformMaintenanceVhost(optOut, domain, true)).toBe(optOut);
    expect(reconcileNginxMaintenance({ ...f.paths, run: f.run }).state).toBe("ok");
    expect(f.template()).toBe(optOut);
    expect(inspectNginxMaintenance(f.paths).state).toBe("ok");
  } finally { f.cleanup(); }
});

test("the existing fast repair watcher catches new vhosts without retriggering itself on SQLite access", () => {
  const unit = reconcileUnits();
  expect(unit.path).toContain("PathChanged=/etc/nginx/sites-enabled\n");
  expect(unit.path).not.toContain(`PathChanged=${PANEL_DB}\n`);
  expect(unit.path).not.toContain(`PathChanged=${PANEL_DB}-wal\n`);
  expect(unit.path).toContain(`PathChanged=${MAINTENANCE_INCLUDE_PATH}\n`);
  expect(unit.anchor).toContain("ExecStartPre=/bin/sleep 2");
  expect(unit.anchor).toContain("repair --anchors-only --quiet");
});

test("unchanged http3 vhosts are never rewritten or blocked by write-only trust checks", () => {
  const f = fixture();
  try {
    f.addSite(domain, upstream("v2-http3-WordPress-WordPress"));
    const path = join(f.paths.nginxVhostDir, `${domain}.conf`);
    chmodSync(path, 0o664);
    const original = readFileSync(path, "utf8");
    expect(reconcileNginxMaintenance({ ...f.paths, run: f.run }).state).toBe("ok");
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(inspectNginxMaintenance(f.paths).state).toBe("ok");
    expect(reconcileNginxMaintenance({ ...f.paths, enabled: false, run: f.run }).state).toBe("missing");
    expect(readFileSync(path, "utf8")).toBe(original);
  } finally { f.cleanup(); }
});

test("removal cleans persisted includes even if CloudPanel already removed the rendered vhost", () => {
  const f = fixture();
  try {
    f.addSite();
    const original = f.template();
    expect(reconcileNginxMaintenance({ ...f.paths, run: f.run }).state).toBe("ok");
    rmSync(join(f.paths.nginxVhostDir, `${domain}.conf`));
    expect(reconcileNginxMaintenance({ ...f.paths, enabled: false, run: f.run }).state).toBe("missing");
    expect(f.template()).toBe(original);
    expect(existsSync(f.paths.includePath)).toBe(false);
  } finally { f.cleanup(); }
});

test("compact servers and CRLF vhosts remain valid to parse, idempotent and reversible", () => {
  for (const content of [
    `server { listen 80; server_name ${domain}; location / { return 200; } }`,
    `server {\r\n  listen 80;\r\n  server_name ${domain};\r\n}\r\n`,
  ]) {
    const changed = transformMaintenanceVhost(content, domain, true);
    expect(transformMaintenanceVhost(changed, domain, true)).toBe(changed);
    expect(transformMaintenanceVhost(changed, domain, false)).toBe(content);
  }
});

test("failed removal restores the installed check and both stored and rendered includes", () => {
  const f = fixture();
  try {
    f.addSite();
    expect(reconcileNginxMaintenance({ ...f.paths, run: f.run }).state).toBe("ok");
    const template = f.template();
    const renderedPath = join(f.paths.nginxVhostDir, `${domain}.conf`);
    const vhost = readFileSync(renderedPath, "utf8");
    const geo = readFileSync(f.paths.geoPath, "utf8");
    let failed = false;
    const run = (command: string, args: string[]): CommandResult => {
      if (command === "systemctl" && !failed) {
        failed = true;
        return { ok: false, exitCode: 1, stdout: "", stderr: "removal reload failed" };
      }
      return f.run(command, args);
    };
    expect(reconcileNginxMaintenance({ ...f.paths, enabled: false, run }).state).toBe("validation-failed");
    expect(f.template()).toBe(template);
    expect(readFileSync(renderedPath, "utf8")).toBe(vhost);
    expect(readFileSync(f.paths.geoPath, "utf8")).toBe(geo);
    expect(readFileSync(f.paths.includePath, "utf8")).toBe(`${NGINX_MAINTENANCE_BLOCK}\n`);
    expect(inspectNginxMaintenance(f.paths).state).toBe("ok");
    expect(reconcileNginxMaintenance({ ...f.paths, enabled: false, run: f.run }).state).toBe("missing");
  } finally { f.cleanup(); }
});

test("a missing global_settings does not stop the per-site includes", () => {
  const f = fixture();
  try {
    rmSync(f.paths.settingsPath);
    f.addSite();
    f.addSite("good.test", upstream("v2-Static-Static"));
    expect(reconcileNginxMaintenance({ ...f.paths, run: f.run })).toMatchObject({ state: "ok", changed: true });
    expect(f.template()).toContain(`include ${f.paths.includePath};`);
    expect(f.template("good.test")).toContain(`include ${f.paths.includePath};`);
    expect(readFileSync(f.paths.includePath, "utf8")).toBe(`${NGINX_MAINTENANCE_BLOCK}\n`);
    expect(existsSync(f.paths.geoPath)).toBe(true);
    expect(existsSync(f.paths.settingsPath)).toBe(false);
    expect(existsSync(f.paths.stateDir)).toBe(false);
    expect(inspectNginxMaintenance(f.paths).state).toBe("ok");
    expect(reconcileNginxMaintenance({ ...f.paths, run: f.run }).changed).toBe(false);

    // The file appearing later is adopted as usual, with its baseline recorded.
    writeFileSync(f.paths.settingsPath, "client_max_body_size 128m;", { mode: 0o644 });
    expect(inspectNginxMaintenance(f.paths).state).toBe("missing");
    expect(reconcileNginxMaintenance({ ...f.paths, run: f.run })).toMatchObject({ state: "ok", changed: true });
    expect(readFileSync(f.paths.settingsPath, "utf8")).toContain(NGINX_MAINTENANCE_BLOCK);
    expect(existsSync(join(f.paths.stateDir, "global-settings.sha256"))).toBe(true);

    rmSync(f.paths.settingsPath);
    expect(reconcileNginxMaintenance({ ...f.paths, run: f.run }).state).toBe("ok");
    expect(existsSync(join(f.paths.stateDir, "global-settings.sha256"))).toBe(false);
    expect(reconcileNginxMaintenance({ ...f.paths, enabled: false, run: f.run }).state).toBe("missing");
    expect(existsSync(f.paths.includePath)).toBe(false);
    expect(existsSync(f.paths.geoPath)).toBe(false);
    expect(f.template("good.test")).not.toContain(f.paths.includePath);
    expect(existsSync(f.paths.settingsPath)).toBe(false);
  } finally { f.cleanup(); }
});

test("a vhost that includes the missing global_settings is reported as uncovered", () => {
  const f = fixture();
  try {
    rmSync(f.paths.settingsPath);
    f.addSite();
    f.addSite("http3.test", upstream("v2-http3-WordPress-WordPress"));
    const http3 = f.template("http3.test");
    const result = reconcileNginxMaintenance({ ...f.paths, run: f.run });
    expect(result).toMatchObject({ state: "uncovered-sites", uncoveredSites: ["http3.test"] });
    expect(result.detail).toContain("does not exist");
    expect(f.template()).toContain(`include ${f.paths.includePath};`);
    expect(f.template("http3.test")).toBe(http3);
    expect(inspectNginxMaintenance(f.paths)).toMatchObject({ state: "uncovered-sites", uncoveredSites: ["http3.test"] });
    expect(existsSync(f.paths.settingsPath)).toBe(false);
  } finally { f.cleanup(); }
});

test("a global_settings that cannot be read is not treated as absent", () => {
  const f = fixture();
  try {
    f.addSite();
    const original = f.template();
    rmSync(f.paths.settingsPath);
    mkdirSync(f.paths.settingsPath);
    const result = reconcileNginxMaintenance({ ...f.paths, run: f.run });
    expect(result).toMatchObject({ state: "validation-failed", changed: false });
    expect(result.detail).toContain(`${f.paths.settingsPath} could not be read`);
    expect(inspectNginxMaintenance(f.paths)).toMatchObject({ state: "validation-failed", detail: result.detail });
    expect(f.template()).toBe(original);
    expect(existsSync(f.paths.includePath)).toBe(false);
    expect(f.commands).toEqual([]);
  } finally { f.cleanup(); }
});

test("a vhost that includes the missing global_settings fails Nginx validation and rolls everything back", () => {
  const f = fixture();
  try {
    rmSync(f.paths.settingsPath);
    f.addSite();
    f.addSite("http3.test", upstream("v2-http3-WordPress-WordPress"));
    const original = f.template();
    const invalid = (command: string, args: string[]): CommandResult => (
      args[0] === "-t" ? { ok: false, exitCode: 1, stdout: "", stderr: `open() "${f.paths.settingsPath}" failed` } : f.run(command, args)
    );
    expect(reconcileNginxMaintenance({ ...f.paths, run: invalid })).toMatchObject({ state: "validation-failed", changed: false });
    expect(f.template()).toBe(original);
    expect(existsSync(f.paths.includePath)).toBe(false);
  } finally { f.cleanup(); }
});

test("a group-writable global_settings is refused with the reason and the fix, and nothing is written", () => {
  const f = fixture();
  try {
    f.addSite();
    const original = f.template();
    chmodSync(f.paths.settingsPath, 0o664);
    const result = reconcileNginxMaintenance({ ...f.paths, run: f.run });
    expect(result.state).toBe("validation-failed");
    expect(result.detail).toBe(`refusing ${f.paths.settingsPath}: group-writable (mode 664); run chmod go-w ${f.paths.settingsPath}`);
    expect(inspectNginxMaintenance(f.paths)).toMatchObject({ state: "validation-failed", detail: result.detail });
    expect(f.template()).toBe(original);
    expect(existsSync(f.paths.includePath)).toBe(false);
    expect(existsSync(f.paths.geoPath)).toBe(false);
    expect(readFileSync(f.paths.settingsPath, "utf8")).toBe("client_max_body_size 128m;");
    expect(f.commands).toEqual([]);
    chmodSync(f.paths.settingsPath, 0o644);
    expect(reconcileNginxMaintenance({ ...f.paths, run: f.run }).state).toBe("ok");
  } finally { f.cleanup(); }
});

test("a refused vhost says whether it is a symlink, not a file, owned by someone else or writable", () => {
  const root = mkdtempSync(join(tmpdir(), "trusted-vhost-"));
  const uid = process.getuid?.() ?? 0;
  try {
    const file = join(root, "a.conf");
    writeFileSync(file, "x", { mode: 0o644 });
    expect(trustedVhost(file, uid).content).toBe("x");
    expect(() => trustedVhost(file, uid + 1)).toThrow(`refusing ${file}: owned by uid ${uid}, expected uid ${uid + 1}; run chown ${uid + 1} ${file}`);
    if (uid !== 0) expect(() => trustedVhost(file, 0)).toThrow(`owned by uid ${uid}, expected root (0); run chown root:root ${file}`);
    chmodSync(file, 0o666);
    expect(() => trustedVhost(file, uid)).toThrow("group- and world-writable (mode 666); run chmod go-w");
    chmodSync(file, 0o646);
    expect(() => trustedVhost(file, uid)).toThrow("world-writable (mode 646)");
    const link = join(root, "link.conf");
    symlinkSync(file, link);
    expect(() => trustedVhost(link, uid)).toThrow(`refusing ${link}: it is a symlink`);
    expect(() => trustedVhost(root, uid)).toThrow(`refusing ${root}: it is not a regular file`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

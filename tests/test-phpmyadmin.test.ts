import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResult } from "../cli/action-common";
import { inspectNginxProxy, reconcileNginxProxy } from "../cli/inject";
import {
  applyPhpMyAdmin, phpMyAdminStatus, withPhpMyAdminRules, withoutPhpMyAdminRules, type PhpMyAdminOptions,
} from "../addons/system-tweaks/phpmyadmin";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

// The lines of CloudPanel's panel vhost the block depends on, around a minimal server.
const VHOST = `server {
  listen 8443 ssl;
  root /home/clp/htdocs/app/files/public;

  set $basicAuth "off";
  if (-f /home/clp/services/nginx/basic-auth/credentials) {
    set $basicAuth "on";
  }
  if ($request_uri ~ ^/phpmyadmin) {
    set $basicAuth "off";
  }
  auth_basic $basicAuth;
  auth_basic_user_file /home/clp/services/nginx/basic-auth/credentials;

  location ~ \\.php$ {
    fastcgi_pass unix:/run/clp-php-fpm.sock;
  }
}
`;

function box(content = VHOST) {
  const dir = mkdtempSync(join(tmpdir(), "clp-phpmyadmin-"));
  dirs.push(dir);
  const vhost = join(dir, "cloudpanel.conf");
  writeFileSync(vhost, content);
  chmodSync(vhost, 0o770);
  const panelConf = join(dir, "nginx.conf");
  writeFileSync(panelConf, "");
  const nginx = { fail: false, commands: [] as string[] };
  const run = (command: string, args: string[]): CommandResult => {
    nginx.commands.push(`${command} ${args.join(" ")}`);
    if (command === "nginx" && nginx.fail && readFileSync(vhost, "utf8").includes("clp-addons:phpmyadmin")) {
      return { ok: false, stdout: "", stderr: "emerg" };
    }
    return { ok: true, stdout: "", stderr: "" };
  };
  const uid = process.getuid!();
  const options: PhpMyAdminOptions = { run, paths: { vhost, panelConf, panelUid: uid, rootUid: uid } };
  return { dir, vhost, panelConf, nginx, options };
}

test("the block goes just before auth_basic, after every line CloudPanel sets $basicAuth with", () => {
  const added = withPhpMyAdminRules(VHOST)!;
  const block = added.slice(added.indexOf("  # clp-addons:phpmyadmin:start"), added.indexOf("  auth_basic $basicAuth;"));
  expect(added.indexOf("if ($request_uri ~ ^/phpmyadmin)")).toBeLessThan(added.indexOf("# clp-addons:phpmyadmin:start"));
  expect(block).toContain("  if (-f /home/clp/services/nginx/basic-auth/credentials) {\n");
  expect(block).toContain(`  if ($uri ~ "^/phpmyadmin(?:/|$)") {\n`);
  expect(block).toContain(`    set $basicAuth "on";\n`);
  expect(block).toContain(`location ~ "^/phpmyadmin/(?:examples|setup|sql|vendor|libraries|templates|locale|tmp)(?:/|$)"`);
  expect(block).toEndWith("  # clp-addons:phpmyadmin:end\n");
  expect(withPhpMyAdminRules(added)).toBe(added);
  expect(withoutPhpMyAdminRules(added)).toBe(VHOST);
});

test("the hidden-file rule covers phpMyAdmin's metadata and leaves its pages and assets alone", () => {
  const block = withPhpMyAdminRules(VHOST)!;
  const pattern = /location ~ "(\^\/phpmyadmin\/\(\?:\\\.\|[^"]+)"/.exec(block)![1]!;
  const files = new RegExp(pattern);
  for (const hidden of ["composer.json", "composer.lock", "package.json", "yarn.lock", "ChangeLog", "README", "LICENSE",
    "RELEASE-DATE-5.2.3", "CONTRIBUTING.md", "babel.config.json", "config.sample.inc.php", ".readme", ".rtlcssrc.json"]) {
    expect(files.test(`/phpmyadmin/${hidden}`)).toBe(true);
  }
  for (const served of ["index.php", "login.php", "url.php", "favicon.ico", "js/dist/main.js", "themes/pmahomme/css/theme.css", "doc/html/index.html"]) {
    expect(files.test(`/phpmyadmin/${served}`)).toBe(false);
  }
});

test("a vhost without CloudPanel's basic-auth lines gets nothing", () => {
  expect(withPhpMyAdminRules(VHOST.replace("  auth_basic $basicAuth;\n", ""))).toBeNull();
  expect(withPhpMyAdminRules(VHOST.replace(/  auth_basic_user_file [^\n]+\n/, ""))).toBeNull();
  const b = box(VHOST.replace("  auth_basic $basicAuth;\n", ""));
  expect(phpMyAdminStatus(b.options).problem).toContain("auth_basic $basicAuth;");
  expect(() => applyPhpMyAdmin(true, b.options)).toThrow("auth_basic $basicAuth;");
  expect(b.nginx.commands).toEqual([]);
});

test("switching on tests and reloads the panel's Nginx, and off restores CloudPanel's exact file", () => {
  const b = box();
  expect(phpMyAdminStatus(b.options)).toEqual({ active: false, problem: "" });
  expect(applyPhpMyAdmin(true, b.options)).toBe(true);
  expect(b.nginx.commands).toEqual([`nginx -t -c ${b.panelConf}`, "systemctl reload clp-nginx"]);
  expect(phpMyAdminStatus(b.options)).toEqual({ active: true, problem: "" });
  expect(applyPhpMyAdmin(true, b.options)).toBe(false);
  expect(applyPhpMyAdmin(false, b.options)).toBe(true);
  expect(readFileSync(b.vhost, "utf8")).toBe(VHOST);
});

test("a block Nginx rejects is taken back out and Nginx reloads nothing new", () => {
  const b = box();
  b.nginx.fail = true;
  expect(() => applyPhpMyAdmin(true, b.options)).toThrow("Nginx validation failed");
  expect(readFileSync(b.vhost, "utf8")).toBe(VHOST);
  expect(b.nginx.commands.filter((command) => command.startsWith("systemctl"))).toEqual([]);
});

test("a group-writable vhost not owned by the panel account is refused", () => {
  const b = box();
  expect(() => applyPhpMyAdmin(true, { ...b.options, paths: { ...b.options.paths, panelUid: process.getuid!() + 1 } })).toThrow("refusing");
  expect(readFileSync(b.vhost, "utf8")).toBe(VHOST);
});

test("the /addons/ proxy keeps its baseline whether or not the block is there", () => {
  const b = box();
  const state = join(b.dir, "state");
  expect(reconcileNginxProxy({ vhostPath: b.vhost, stateDir: state, reload: false }).state).toBe("ok");
  applyPhpMyAdmin(true, b.options);
  expect(inspectNginxProxy({ vhostPath: b.vhost, stateDir: state }).state).toBe("ok");
  // CloudPanel writes its vhost back: the proxy and the block both return.
  writeFileSync(b.vhost, VHOST);
  expect(reconcileNginxProxy({ vhostPath: b.vhost, stateDir: state, reload: false }).state).toBe("ok");
  expect(applyPhpMyAdmin(true, b.options)).toBe(true);
  const both = readFileSync(b.vhost, "utf8");
  expect(both).toContain("# clp-addons:proxy:start");
  expect(both).toContain("# clp-addons:phpmyadmin:start");
  expect(reconcileNginxProxy({ vhostPath: b.vhost, stateDir: state, reload: false })).toMatchObject({ state: "ok", changed: false });
  expect(reconcileNginxProxy({ vhostPath: b.vhost, stateDir: state, enabled: false, reload: false }).state).toBe("missing");
  expect(readFileSync(b.vhost, "utf8")).toContain("# clp-addons:phpmyadmin:start");
  applyPhpMyAdmin(false, b.options);
  expect(readFileSync(b.vhost, "utf8")).toBe(VHOST);
});

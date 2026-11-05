import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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
  const gid = process.getgid!();
  const options: PhpMyAdminOptions = { run, paths: { vhost, panelConf, panelUid: uid, panelGid: gid, rootUid: uid, rootGid: gid } };
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

test.each([0o644, 0o770])("a root-owned panel vhost with mode %i keeps its ownership and permissions", (mode) => {
  const b = box();
  // The fixture's owner stands in for root, distinct from the panel account.
  const options = { ...b.options, paths: { ...b.options.paths, panelUid: process.getuid!() + 1 } };
  chmodSync(b.vhost, mode);
  const { uid, gid } = statSync(b.vhost);
  const metadata = () => { const info = statSync(b.vhost); return { uid: info.uid, gid: info.gid, mode: info.mode & 0o777 }; };
  expect(phpMyAdminStatus(options)).toEqual({ active: false, problem: "" });
  expect(applyPhpMyAdmin(true, options)).toBe(true);
  expect(phpMyAdminStatus(options)).toEqual({ active: true, problem: "" });
  expect(metadata()).toEqual({ uid, gid, mode });
  expect(applyPhpMyAdmin(false, options)).toBe(true);
  expect(readFileSync(b.vhost, "utf8")).toBe(VHOST);
  expect(metadata()).toEqual({ uid, gid, mode });
});

test.each([false, true])("a block Nginx rejects is taken back out with its owner kept (root-owned: %s)", (rootOwned) => {
  const b = box();
  const options = rootOwned ? { ...b.options, paths: { ...b.options.paths, panelUid: process.getuid!() + 1 } } : b.options;
  const before = statSync(b.vhost);
  b.nginx.fail = true;
  expect(() => applyPhpMyAdmin(true, options)).toThrow("Nginx validation failed");
  expect(readFileSync(b.vhost, "utf8")).toBe(VHOST);
  expect(statSync(b.vhost)).toMatchObject({ uid: before.uid, gid: before.gid, mode: before.mode });
  expect(b.nginx.commands.filter((command) => command.startsWith("systemctl"))).toEqual([]);
});

test("a vhost owned by neither root nor the panel account is refused", () => {
  const b = box();
  const uid = process.getuid!();
  const options = { ...b.options, paths: { ...b.options.paths, panelUid: uid + 1, rootUid: uid + 2 } };
  expect(phpMyAdminStatus(options).problem).toContain(`owned by uid ${uid}`);
  expect(() => applyPhpMyAdmin(true, options)).toThrow("refusing");
  expect(b.nginx.commands).toEqual([]);
  expect(readFileSync(b.vhost, "utf8")).toBe(VHOST);
});

test.each([false, true])("world-writable and symlinked panel vhosts stay refused (root-owned: %s)", (rootOwned) => {
  const b = box();
  const options = rootOwned ? { ...b.options, paths: { ...b.options.paths, panelUid: process.getuid!() + 1 } } : b.options;
  chmodSync(b.vhost, 0o772);
  expect(phpMyAdminStatus(options).problem).toContain("world-writable");
  expect(() => applyPhpMyAdmin(true, options)).toThrow("world-writable");
  chmodSync(b.vhost, 0o770);
  const link = join(b.dir, "linked.conf");
  symlinkSync(b.vhost, link);
  const linked = { ...options, paths: { ...options.paths, vhost: link } };
  expect(phpMyAdminStatus(linked).problem).toContain("symlink");
  expect(() => applyPhpMyAdmin(true, linked)).toThrow("symlink");
  expect(readFileSync(b.vhost, "utf8")).toBe(VHOST);
  expect(b.nginx.commands).toEqual([]);
});

test("panel files writable by an unrelated group are refused, while read-only group access is allowed", () => {
  const b = box();
  const gid = process.getgid!();
  const options = { ...b.options, paths: { ...b.options.paths, panelUid: process.getuid!() + 1, panelGid: gid + 1, rootGid: gid + 2 } };
  expect(phpMyAdminStatus(options).problem).toContain(`untrusted gid ${gid}`);
  expect(() => applyPhpMyAdmin(true, options)).toThrow(`untrusted gid ${gid}`);
  expect(readFileSync(b.vhost, "utf8")).toBe(VHOST);
  expect(b.nginx.commands).toEqual([]);
  chmodSync(b.vhost, 0o750);
  expect(phpMyAdminStatus(options)).toEqual({ active: false, problem: "" });
  expect(applyPhpMyAdmin(true, options)).toBe(true);
  expect(statSync(b.vhost)).toMatchObject({ gid });
  expect(statSync(b.vhost).mode & 0o777).toBe(0o750);
});

test("the panel's primary group can differ from its UID and from root's group", () => {
  const b = box();
  const gid = process.getgid!();
  const options = { ...b.options, paths: { ...b.options.paths, panelUid: process.getuid!() + 1, panelGid: gid, rootGid: gid + 1 } };
  expect(applyPhpMyAdmin(true, options)).toBe(true);
  expect(phpMyAdminStatus(options)).toEqual({ active: true, problem: "" });
  expect(statSync(b.vhost)).toMatchObject({ uid: process.getuid!(), gid });
  expect(statSync(b.vhost).mode & 0o777).toBe(0o770);
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

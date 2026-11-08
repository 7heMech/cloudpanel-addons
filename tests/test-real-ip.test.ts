import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResult } from "../lib/command";
import { applyRealIp, realIpStatus, type RealIpOptions } from "../addons/system-tweaks/real-ip";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const CONF = "http {\n    set_real_ip_from 0.0.0.0/0;\n    set_real_ip_from 127.0.0.1;\n}\n";

function box() {
  const dir = mkdtempSync(join(tmpdir(), "clp-real-ip-"));
  dirs.push(dir);
  const nginxConf = join(dir, "nginx.conf");
  const panelConf = join(dir, "panel.conf");
  const cloudflareIps = join(dir, "cloudflare-ips");
  writeFileSync(nginxConf, CONF);
  chmodSync(nginxConf, 0o644);
  writeFileSync(panelConf, CONF);
  chmodSync(panelConf, 0o770);
  writeFileSync(cloudflareIps, "");
  const nginx = { failPanel: false, commands: [] as string[] };
  const run = (command: string, args: string[]): CommandResult => {
    nginx.commands.push(`${command} ${args.join(" ")}`);
    if (command === "nginx" && args.includes(panelConf) && nginx.failPanel && readFileSync(panelConf, "utf8").includes("#clp-addons:untrusted")) {
      return { ok: false, stdout: "", stderr: "emerg" };
    }
    return { ok: true, stdout: "", stderr: "" };
  };
  const uid = process.getuid!();
  const gid = process.getgid!();
  const options: RealIpOptions = { run, paths: { nginxConf, panelConf, cloudflareIps, rootUid: uid, rootGid: gid, panelUid: uid + 1, panelGid: gid + 1 } };
  return { dir, nginxConf, panelConf, nginx, options, uid };
}

test("real-IP protection accepts root-owned panel config and preserves both instances' file metadata", () => {
  const b = box();
  const sites = statSync(b.nginxConf);
  const panel = statSync(b.panelConf);
  expect(realIpStatus(b.options)).toEqual({ trustsAnyAddress: true, problem: "" });
  expect(applyRealIp(true, b.options)).toBe(true);
  expect(realIpStatus(b.options)).toEqual({ trustsAnyAddress: false, problem: "" });
  expect(b.nginx.commands).toEqual([
    "nginx -t", "systemctl reload nginx", `nginx -t -c ${b.panelConf}`, "systemctl reload clp-nginx",
  ]);
  expect(statSync(b.nginxConf)).toMatchObject({ uid: sites.uid, gid: sites.gid, mode: sites.mode });
  expect(statSync(b.panelConf)).toMatchObject({ uid: panel.uid, gid: panel.gid, mode: panel.mode });
  expect(applyRealIp(false, b.options)).toBe(true);
  expect(readFileSync(b.nginxConf, "utf8")).toBe(CONF);
  expect(readFileSync(b.panelConf, "utf8")).toBe(CONF);
  expect(statSync(b.panelConf)).toMatchObject({ uid: panel.uid, gid: panel.gid, mode: panel.mode });
});

test("rejecting a root-owned panel config restores both instances and their metadata", () => {
  const b = box();
  const sites = statSync(b.nginxConf);
  const panel = statSync(b.panelConf);
  b.nginx.failPanel = true;
  expect(() => applyRealIp(true, b.options)).toThrow("Nginx validation failed");
  expect(readFileSync(b.nginxConf, "utf8")).toBe(CONF);
  expect(readFileSync(b.panelConf, "utf8")).toBe(CONF);
  expect(statSync(b.nginxConf)).toMatchObject({ uid: sites.uid, gid: sites.gid, mode: sites.mode });
  expect(statSync(b.panelConf)).toMatchObject({ uid: panel.uid, gid: panel.gid, mode: panel.mode });
  expect(b.nginx.commands).not.toContain("systemctl reload clp-nginx");
});

test.each(["owner", "group", "writable", "symlink"] as const)("an unsafe panel config (%s) stays refused and the site change is undone", (reason) => {
  const b = box();
  const paths = { ...b.options.paths };
  if (reason === "owner") {
    paths.panelUid = b.uid + 1;
    paths.rootUid = b.uid + 2;
  }
  if (reason === "group") paths.rootGid = process.getgid!() + 2;
  if (reason === "writable") chmodSync(b.panelConf, 0o772);
  if (reason === "symlink") {
    paths.panelConf = join(b.dir, "linked.conf");
    symlinkSync(b.panelConf, paths.panelConf);
  }
  // For the owner case the sites file is already in the wanted state, so only
  // the panel's owner check decides the action.
  if (reason === "owner") writeFileSync(b.nginxConf, "http {}\n");
  const sitesBefore = readFileSync(b.nginxConf, "utf8");
  const options = { ...b.options, paths };
  expect(realIpStatus(options).problem).toContain("refusing");
  expect(() => applyRealIp(true, options)).toThrow("refusing");
  expect(readFileSync(b.nginxConf, "utf8")).toBe(sitesBefore);
  expect(readFileSync(b.panelConf, "utf8")).toBe(CONF);
  expect(b.nginx.commands).not.toContain("systemctl reload clp-nginx");
});

test("the sites config still requires root ownership and no group write", () => {
  const b = box();
  const options = { ...b.options, paths: { ...b.options.paths, rootUid: b.uid + 1, panelUid: b.uid } };
  expect(() => applyRealIp(true, options)).toThrow("owned by uid");
  chmodSync(b.nginxConf, 0o664);
  expect(() => applyRealIp(true, b.options)).toThrow("group-writable");
  expect(readFileSync(b.nginxConf, "utf8")).toBe(CONF);
  expect(readFileSync(b.panelConf, "utf8")).toBe(CONF);
  expect(b.nginx.commands).toEqual([]);
});

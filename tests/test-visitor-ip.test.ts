import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResult } from "../lib/command";
import { applyVisitorIp, releaseVisitorIp, visitorIpStatus, type VisitorIpOptions } from "../addons/system-tweaks/visitor-ip";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const NGINX = `http {
    set_real_ip_from 127.0.0.1;
    set_real_ip_from 10.0.0.0/8;
    log_format main '$remote_addr - $remote_user [$time_local] "$request" '
                    '$status';
    log_format cloudflare '$http_cf_connecting_ip - $remote_user [$time_local] "$request" '
                          '$status';
}
`;
const FASTCGI = "fastcgi_param\tREMOTE_ADDR\t\t$remote_addr;\nfastcgi_param\tREMOTE_PORT\t\t$remote_port;\n";

function box() {
  const dir = mkdtempSync(join(tmpdir(), "clp-visitor-ip-"));
  dirs.push(dir);
  const paths = {
    nginxConf: join(dir, "nginx.conf"), fastcgiParams: join(dir, "fastcgi_params"), maps: join(dir, "maps.conf"),
    cloudflareIps: join(dir, "ips"), rootUid: process.getuid!(),
  };
  writeFileSync(paths.nginxConf, NGINX, { mode: 0o644 });
  writeFileSync(paths.fastcgiParams, FASTCGI, { mode: 0o644 });
  writeFileSync(paths.cloudflareIps, "allow 173.245.48.0/20;\nallow 2400:cb00::/32;\nallow 999.1.1.1;\ndeny all;\n");
  const nginx = { fail: false, commands: [] as string[] };
  const run = (command: string, args: string[]): CommandResult => {
    nginx.commands.push(`${command} ${args.join(" ")}`);
    return nginx.fail && command === "nginx" ? { ok: false, stdout: "", stderr: "emerg" } : { ok: true, stdout: "", stderr: "" };
  };
  const options: VisitorIpOptions = { paths, run };
  return { paths, nginx, options };
}

test("on points the log formats and PHP at the map, and off gives every file back as it shipped", () => {
  const b = box();
  expect(visitorIpStatus(b.options)).toEqual({ applied: false, problem: "" });
  expect(applyVisitorIp(true, b.options)).toBe(true);
  expect(b.nginx.commands).toEqual(["nginx -t", "systemctl reload nginx"]);
  expect(readFileSync(b.paths.nginxConf, "utf8")).toBe(NGINX
    .replace("    set_real_ip_from 127.0.0.1;", "    #clp-addons:hop set_real_ip_from 127.0.0.1;")
    .replace("main '$remote_addr", "main '$clp_visitor_ip")
    .replace("cloudflare '$http_cf_connecting_ip", "cloudflare '$clp_visitor_ip"));
  expect(readFileSync(b.paths.fastcgiParams, "utf8")).toBe(FASTCGI.replace("\t$remote_addr;", "\t$clp_visitor_ip;"));
  const maps = readFileSync(b.paths.maps, "utf8");
  expect(maps).toContain("    173.245.48.0/20 cloudflare;\n");
  expect(maps).toContain("    2400:cb00::/32 1;\n");
  expect(maps).not.toContain("999.1.1.1");
  expect(maps).toContain("    default $remote_addr;\n");
  expect(visitorIpStatus(b.options)).toEqual({ applied: true, problem: "" });
  expect(applyVisitorIp(true, b.options)).toBe(false);

  writeFileSync(b.paths.cloudflareIps, "allow 104.16.0.0/13;\ndeny all;\n");
  expect(visitorIpStatus(b.options).applied).toBe(false);
  expect(applyVisitorIp(true, b.options)).toBe(true);
  expect(readFileSync(b.paths.maps, "utf8")).toContain("104.16.0.0/13 cloudflare;");

  expect(applyVisitorIp(false, b.options)).toBe(true);
  expect(readFileSync(b.paths.nginxConf, "utf8")).toBe(NGINX);
  expect(readFileSync(b.paths.fastcgiParams, "utf8")).toBe(FASTCGI);
  expect(existsSync(b.paths.maps)).toBe(false);
});

test("a change Nginx rejects leaves every file as it was", () => {
  const b = box();
  b.nginx.fail = true;
  expect(() => applyVisitorIp(true, b.options)).toThrow("Nginx validation failed");
  expect(readFileSync(b.paths.nginxConf, "utf8")).toBe(NGINX);
  expect(readFileSync(b.paths.fastcgiParams, "utf8")).toBe(FASTCGI);
  expect(existsSync(b.paths.maps)).toBe(false);
});

test("an upgrade run gets one conffile back unreloaded, and the map stays for the other", () => {
  const b = box();
  applyVisitorIp(true, b.options);
  b.nginx.commands.length = 0;
  expect(releaseVisitorIp("nginxConf", b.options)).toBe(true);
  expect(readFileSync(b.paths.nginxConf, "utf8")).toBe(NGINX);
  expect(readFileSync(b.paths.fastcgiParams, "utf8")).toContain("$clp_visitor_ip");
  expect(existsSync(b.paths.maps)).toBe(true);
  expect(b.nginx.commands).toEqual([]);
  expect(applyVisitorIp(true, b.options)).toBe(true);
  expect(visitorIpStatus(b.options).applied).toBe(true);
});

test("off keeps the map while a hand edit still names it, and a map clp-addons did not write is refused", () => {
  const b = box();
  applyVisitorIp(true, b.options);
  writeFileSync(b.paths.nginxConf, `${readFileSync(b.paths.nginxConf, "utf8")}# set $x $clp_visitor_ip;\n`);
  applyVisitorIp(false, b.options);
  expect(existsSync(b.paths.maps)).toBe(true);

  writeFileSync(b.paths.maps, "map $a $b {}\n");
  expect(() => applyVisitorIp(true, b.options)).toThrow("clp-addons did not write it");
  // Switching off, as disabling the addon does, still gives the files back and leaves that map alone.
  writeFileSync(b.paths.nginxConf, NGINX.replace("main '$remote_addr", "main '$clp_visitor_ip"));
  applyVisitorIp(false, b.options);
  expect(readFileSync(b.paths.nginxConf, "utf8")).toBe(NGINX);
  expect(readFileSync(b.paths.maps, "utf8")).toBe("map $a $b {}\n");
});

test("a line the setting does not recognise is reported, not shown as on", () => {
  const b = box();
  writeFileSync(b.paths.nginxConf, NGINX.replace("log_format main '$remote_addr", "log_format main\n    '$remote_addr"));
  applyVisitorIp(true, b.options);
  expect(visitorIpStatus(b.options)).toEqual({ applied: false, problem: `${b.paths.nginxConf} has no line with $remote_addr` });
});

import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyCloudflarePeer, cloudflarePeerStatus, CLOUDFLARE_PEER_BLOCK, cloudflarePeerRanges,
  type CloudflarePeerOptions,
} from "../addons/cloudflare-ips/cloudflare-peer";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const STOCK = "# CloudPanel ranges\nallow 173.245.48.0/20;\nallow 2400:cb00::/32;\ndeny all;\n";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "clp-cloudflare-peer-"));
  dirs.push(dir);
  const paths = { ips: join(dir, "ips"), geo: join(dir, "geo.conf"), rootUid: process.getuid!() };
  writeFileSync(paths.ips, STOCK, { mode: 0o644 });
  const commands: string[] = [];
  const options: CloudflarePeerOptions = { paths, run: (command, args) => {
    commands.push([command, ...args].join(" "));
    return { ok: true, stdout: "", stderr: "" };
  } };
  return { paths, commands, options };
}

test("the connection check is independent of forwarded headers and preserves CloudPanel's rules", () => {
  const f = fixture();
  expect(cloudflarePeerStatus(false, f.options)).toEqual({ wanted: false, configured: false, available: true, problem: "" });
  expect(applyCloudflarePeer(true, f.options)).toBe(true);
  expect(readFileSync(f.paths.ips, "utf8")).toBe(CLOUDFLARE_PEER_BLOCK + STOCK);
  const geo = readFileSync(f.paths.geo, "utf8");
  expect(geo).toContain("geo $realip_remote_addr $clp_system_cf_peer");
  expect(geo).toContain("173.245.48.0/20 1;");
  expect(geo).toContain("2400:cb00::/32 1;");
  expect(geo).not.toContain("$http_");
  expect(geo).not.toContain("127.0.0.");
  expect(cloudflarePeerStatus(true, f.options).configured).toBe(true);
  expect(f.commands).toEqual(["nginx -t", "systemctl reload nginx"]);
  f.commands.length = 0;
  expect(applyCloudflarePeer(true, f.options)).toBe(false);
  expect(f.commands).toEqual([]);
  expect(applyCloudflarePeer(false, f.options)).toBe(true);
  expect(readFileSync(f.paths.ips, "utf8")).toBe(STOCK);
  expect(existsSync(f.paths.geo)).toBe(false);
});

test("repair detects replaced ranges and removal keeps the latest upstream file", () => {
  const f = fixture();
  applyCloudflarePeer(true, f.options);
  const updated = STOCK.replace("deny all;", "allow 104.16.0.0/13;\ndeny all;");
  writeFileSync(f.paths.ips, updated);
  expect(cloudflarePeerStatus(true, f.options)).toMatchObject({ configured: false, available: true });
  expect(applyCloudflarePeer(true, f.options)).toBe(true);
  expect(readFileSync(f.paths.geo, "utf8")).toContain("104.16.0.0/13 1;");
  applyCloudflarePeer(false, f.options);
  expect(readFileSync(f.paths.ips, "utf8")).toBe(updated);
});

for (const failing of ["nginx -t", "systemctl reload nginx"]) {
  test(`a failed ${failing} restores both files, including on withdrawal`, () => {
    for (const enabled of [true, false]) {
      const f = fixture();
      if (!enabled) applyCloudflarePeer(true, f.options);
      const ips = readFileSync(f.paths.ips, "utf8");
      const geo = existsSync(f.paths.geo) ? readFileSync(f.paths.geo, "utf8") : null;
      const run = f.options.run!;
      let failed = false;
      f.options.run = (command, args) => {
        const result = run(command, args);
        if (!failed && [command, ...args].join(" ") === failing) {
          failed = true;
          return { ok: false, stdout: "", stderr: "rejected" };
        }
        return result;
      };
      expect(() => applyCloudflarePeer(enabled, f.options)).toThrow("rejected");
      expect(readFileSync(f.paths.ips, "utf8")).toBe(ips);
      expect(existsSync(f.paths.geo) ? readFileSync(f.paths.geo, "utf8") : null).toBe(geo);
      if (failing.startsWith("systemctl")) expect(f.commands.slice(-2)).toEqual(["nginx -t", "systemctl reload nginx"]);
    }
  });
}

test("custom rules, modified markers, and an operator-owned lookup are left untouched", () => {
  for (const content of ["allow all;\ndeny all;\n", "allow 192.0.2.1/99;\ndeny all;\n", "allow 192.0.2.1;\n", "deny all;\nallow 192.0.2.1;\n", CLOUDFLARE_PEER_BLOCK.replace("403", "404") + STOCK]) {
    const f = fixture();
    writeFileSync(f.paths.ips, content);
    expect(() => applyCloudflarePeer(true, f.options)).toThrow();
    expect(cloudflarePeerStatus(true, f.options).available).toBe(false);
    expect(readFileSync(f.paths.ips, "utf8")).toBe(content);
    expect(f.commands).toEqual([]);
  }
  const f = fixture();
  writeFileSync(f.paths.geo, "# operator configuration\n", { mode: 0o644 });
  expect(() => applyCloudflarePeer(true, f.options)).toThrow("another configuration");
  expect(applyCloudflarePeer(false, f.options)).toBe(false);
  expect(readFileSync(f.paths.geo, "utf8")).toBe("# operator configuration\n");
  expect(readFileSync(f.paths.ips, "utf8")).toBe(STOCK);
});

test("untrusted files and symlinks cannot supply the privileged Nginx configuration", () => {
  const f = fixture();
  chmodSync(f.paths.ips, 0o666);
  expect(() => applyCloudflarePeer(true, f.options)).toThrow("writable");
  expect(applyCloudflarePeer(false, f.options)).toBe(false);
  chmodSync(f.paths.ips, 0o644);
  symlinkSync(f.paths.ips, f.paths.geo);
  expect(() => applyCloudflarePeer(true, f.options)).toThrow("symlink");
  expect(f.commands).toEqual([]);
});

test("range parsing accepts IPv4, IPv6, individual addresses and comments", () => {
  expect(cloudflarePeerRanges("allow 173.245.48.1; # Cloudflare\nallow 2400:cb00::/32;\ndeny all;\n"))
    .toEqual(["173.245.48.1", "2400:cb00::/32"]);
});

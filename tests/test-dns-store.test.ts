import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readState, writeState } from "../addons/dns/store";

const dirs: string[] = [];
const uid = process.getuid!();
const secrets = { cloudflare: { agency: "cf-secret-token" }, mailcowKey: "mailcow-secret-key" };

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "dns-secrets-"));
  dirs.push(dir);
  const path = join(dir, "secrets.json");
  writeState(path, secrets, uid);
  return { dir, path };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("DNS secrets remain owner-only through atomic replacement", () => {
  const { dir, path } = fixture();
  writeState(path, secrets, uid);
  expect(statSync(path).uid).toBe(uid);
  expect(statSync(path).mode & 0o7777).toBe(0o600);
  expect(readState(path, uid, () => null)).toEqual(secrets);
  expect(readdirSync(dir)).toEqual(["secrets.json"]);
});

test("DNS refuses loose permissions, another owner and symlinks without reading or overwriting them", () => {
  const { dir, path } = fixture();
  chmodSync(path, 0o644);
  expect(() => readState(path, uid, () => null)).toThrow("untrusted DNS state");
  expect(() => writeState(path, { mailcowKey: "replacement" }, uid)).toThrow("untrusted DNS state");
  expect(readFileSync(path, "utf8")).toContain(secrets.mailcowKey);
  chmodSync(path, 0o600);
  expect(() => readState(path, uid + 1, () => null)).toThrow("untrusted DNS state");
  const link = join(dir, "linked.json");
  symlinkSync(path, link);
  expect(() => readState(link, uid, () => null)).toThrow("untrusted DNS state");
  expect(() => writeState(link, {}, uid)).toThrow("untrusted DNS state");
  expect(readState(path, uid, () => null)).toEqual(secrets);
});

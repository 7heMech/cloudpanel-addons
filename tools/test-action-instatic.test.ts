import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  makeSnapshot, parseInstaticAction, panelIdentityForInstatic, validateInstaticDomain,
} from "../addons/instatic/action";
import { ActionFailure, normalizeIdentityHostname, validateFlag, validatePort, validateTag } from "../cli/action-common";

function failureMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof ActionFailure) return error.message;
    throw error;
  }
  throw new Error("expected an ActionFailure");
}

test("the Instatic action parser preserves the wrapper's ignored TLS option", () => {
  expect(parseInstaticAction(["list", "--tls", "maybe"]).verb).toBe("list");
  expect(failureMessage(() => parseInstaticAction(["list", "--domain", "x.example.com"]))).toBe("list takes no arguments");
  expect(failureMessage(() => parseInstaticAction(["list", "--tls"]))).toBe("--tls needs a value");
  expect(failureMessage(() => parseInstaticAction(["unknown"]))).toBe("unknown verb: 'unknown'");
});

test("the shared action validators retain the reserved-input contract", () => {
  expect(normalizeIdentityHostname("Panel.Example.Test.")).toBe("panel.example.test");
  expect(normalizeIdentityHostname("*.panel.example.test")).toBe("*.panel.example.test");
  expect(normalizeIdentityHostname("bad..example.test")).toBeNull();
  expect(validatePort("39000")).toBe(39000);
  expect(failureMessage(() => validatePort("40000"))).toContain("outside reserved range");
  expect(failureMessage(() => validatePort("39000\n"))).toContain("must be an integer");
  expect(validateTag("0.0.18")).toBe("0.0.18");
  expect(failureMessage(() => validateTag("latest"))).toContain("exact version");
  expect(failureMessage(() => validateTag("0.0.18\n"))).toContain("exact version");
  expect(validateFlag("yes", "tls")).toBe("yes");
  expect(failureMessage(() => validateFlag("true", "tls"))).toContain("takes yes or no");
});

test("domain validation is routed through the shared identity guard", () => {
  expect(failureMessage(() => validateInstaticDomain("not a hostname", "/no/such/identity"))).toBe("invalid domain: 'not a hostname'");
  expect(failureMessage(() => validateInstaticDomain("valid.example.com\n", "/no/such/identity"))).toBe("invalid domain: 'valid.example.com\n'");
  expect(failureMessage(() => validateInstaticDomain("valid.example.com", "/no/such/identity"))).toBe("the CloudPanel panel identity is missing or malformed");
});

test("action stdout is one JSON object and strips control characters from strings", () => {
  const script = [
    'import { emitActionOk } from "./cli/action-common.ts";',
    'emitActionOk({ text: "before\\u001bafter\\u0007\\nnext" });',
  ].join(" ");
  const stdout = execFileSync(process.execPath, ["-e", script], {
    cwd: join(import.meta.dir, ".."),
    encoding: "utf8",
  });
  expect(stdout.endsWith("\n")).toBe(true);
  expect(stdout.trim().split("\n")).toHaveLength(1);
  expect(JSON.parse(stdout)).toEqual({ ok: true, data: { text: "beforeafter\nnext" } });
});

test("the daemon invokes the unified binary action path", () => {
  const service = readFileSync(join(import.meta.dir, "../addons/instatic/app/service.ts"), "utf8");
  expect(service).toContain("const ACTION_BIN = CLI_BIN");
  expect(service).toContain('const argv = ["action", "instatic", verb, ...args]');
});

test("makeSnapshot archives non-SQLite regular data files", () => {
  const root = mkdtempSync(join(tmpdir(), "instatic-snapshot-test-"));
  try {
    const instance = join(root, "instance");
    const data = join(instance, "data");
    const archive = join(root, "snapshot.tar.gz");
    const restored = join(root, "restored");
    const file = join(data, "notes.txt");
    const mtime = new Date("2020-01-02T03:04:05.000Z");
    mkdirSync(data, { recursive: true });
    writeFileSync(file, "plain data\n");
    utimesSync(file, mtime, mtime);

    expect(makeSnapshot(instance, archive, "unused-sqlite3")).toBe(true);

    mkdirSync(restored);
    execFileSync("tar", ["-xzf", archive, "-C", restored]);
    const restoredFile = join(restored, "data", "notes.txt");
    expect(readFileSync(restoredFile, "utf8")).toBe("plain data\n");
    expect(statSync(restoredFile).mtimeMs).toBeCloseTo(mtime.getTime(), -2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

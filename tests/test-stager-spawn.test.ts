// The stager talks to its privileged action over Bun.spawn. A shell probe
// stands in for the real binary so each reply shape -- success, nonzero with
// prose, nonzero with JSON, timeout, oversized output, malformed, early exit --
// can be asserted, along with the rule that no credential reaches argv.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callAction, stagerService } from "../addons/stager/app/service";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function captureErrors<T>(work: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...values: unknown[]) => lines.push(values.map(String).join(" "));
  try {
    return { value: await work(), lines };
  } finally {
    console.error = original;
  }
}

const PASSWORD = "secret password that must stay off argv";
const MFA_CODE = "654321";

let tempDir = "";
let modePath = "";
let argvPath = "";
let stdinPath = "";
let previousActionTestBin: string | undefined;
let originalGetuid: PropertyDescriptor | undefined;

function mode(name: string): void {
  writeFileSync(modePath, `${name}\n`);
}

function clone(overrides: { password?: string } = {}) {
  return stagerService.startClone("source.example.com", "staging.source.example.com", false, {
    port: 39000,
    email: "admin@example.com",
    password: overrides.password ?? PASSWORD,
    mfaCode: MFA_CODE,
  });
}

beforeAll(() => {
  tempDir = mkdtempSync(join("/tmp", "clp-stager-spawn-"));
  modePath = join(tempDir, "mode");
  argvPath = join(tempDir, "argv");
  stdinPath = join(tempDir, "stdin");
  const actionProbePath = join(tempDir, "action-probe");

  previousActionTestBin = process.env.CLP_ADDONS_ACTION_TEST_BIN;
  originalGetuid = Object.getOwnPropertyDescriptor(process, "getuid");
  if (process.getuid?.() !== 0) {
    Object.defineProperty(process, "getuid", { value: () => 0, configurable: true, writable: true });
  }

  writeFileSync(actionProbePath, `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$@" > ${shellQuote(argvPath)}
mode=$(<${shellQuote(modePath)})
case "$mode" in
  success)
    cat > ${shellQuote(stdinPath)}
    printf '%s\\n' '{"ok":true,"data":{"job":"20260909T120000Z-abcdef"}}'
    printf '%s\\n' 'action diagnostic' >&2
    ;;
  nonzero)
    printf '%s\\n' 'not JSON'
    printf '%s\\n' 'action rejected request' >&2
    exit 9
    ;;
  json-nonzero)
    printf '%s\\n' '{"ok":false,"error":"policy rejected"}'
    exit 9
    ;;
  timeout)
    printf '%s' '{"ok":true,"data":{"job":"should-not-be-accepted"}}'
    sleep 1
    ;;
  max-buffer)
    printf '%s' '{"ok":true,"data":{"job":"should-not-be-accepted"}}'
    head -c 4096 /dev/zero | tr '\\0' ' '
    ;;
  malformed)
    printf '%s\\n' 'not JSON'
    ;;
  early-exit)
    exit 0
    ;;
esac
`, { mode: 0o700 });
  chmodSync(actionProbePath, 0o700);
  mode("success");
  process.env.CLP_ADDONS_ACTION_TEST_BIN = actionProbePath;
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
  if (previousActionTestBin === undefined) delete process.env.CLP_ADDONS_ACTION_TEST_BIN;
  else process.env.CLP_ADDONS_ACTION_TEST_BIN = previousActionTestBin;
  if (originalGetuid) Object.defineProperty(process, "getuid", originalGetuid);
});

test("a successful clone returns the job and echoes the action's diagnostics", async () => {
  mode("success");
  const success = await captureErrors(() => stagerService.startClone(
    "source.example.com",
    "staging.source.example.com",
    true,
    { port: 39000, email: "admin@example.com", password: PASSWORD, mfaCode: MFA_CODE },
  ));
  expect(success.value).toEqual({ ok: true, data: { job: "20260909T120000Z-abcdef" } });
  expect(success.lines.some((line) => line.includes("[action:clone] action diagnostic"))).toBe(true);
});

test("credentials travel on stdin and never on argv", async () => {
  mode("success");
  await captureErrors(() => stagerService.startClone(
    "source.example.com",
    "staging.source.example.com",
    true,
    { port: 39000, email: "admin@example.com", password: PASSWORD, mfaCode: MFA_CODE },
  ));
  const argv = readFileSync(argvPath, "utf8");
  expect(argv.startsWith("action\nstager\nclone\n")).toBe(true);
  expect(argv).toInclude("--email\nadmin@example.com\n");
  expect(argv).not.toInclude(PASSWORD);
  expect(argv).not.toInclude(MFA_CODE);
  expect(readFileSync(stdinPath, "utf8")).toBe(`${PASSWORD}\n${MFA_CODE}\n`);
});

test("a nonzero exit reports stderr without leaking credentials", async () => {
  mode("nonzero");
  const failed = await captureErrors(() => clone());
  expect(failed.value).toEqual({ ok: false, error: "action rejected request" });
  expect(failed.lines.join("\n")).not.toInclude(PASSWORD);
  expect(failed.lines.join("\n")).not.toInclude(MFA_CODE);
});

test("a nonzero exit carrying JSON reports the action's own error", async () => {
  mode("json-nonzero");
  expect(await stagerService.getJob("20260909T120000Z-abcdef")).toEqual({ ok: false, error: "policy rejected" });
});

test("an action that overruns its timeout is terminated, not believed", async () => {
  mode("timeout");
  expect(await callAction("job", [], undefined, { timeout: 25 }))
    .toEqual({ ok: false, error: "action process terminated" });
});

test("an action that overruns its output budget is rejected, not truncated", async () => {
  mode("max-buffer");
  expect(await callAction("job", [], undefined, { maxBuffer: 256 }))
    .toEqual({ ok: false, error: "action output exceeded 256 bytes" });
});

test("a non-JSON reply is malformed rather than parsed", async () => {
  mode("malformed");
  expect(await stagerService.getJob("20260909T120000Z-abcdef"))
    .toEqual({ ok: false, error: "action returned a malformed reply" });
});

test("an action that exits before reading a large stdin is malformed, not a hang", async () => {
  mode("early-exit");
  expect(await clone({ password: "x".repeat(1024 * 1024) }))
    .toEqual({ ok: false, error: "action returned a malformed reply" });
});

test("the gateway client spawns through Bun rather than node:child_process", () => {
  const client = readFileSync(join(import.meta.dir, "../lib/gateway-client.ts"), "utf8");
  expect(client).toMatch(/Bun\.spawn/);
  expect(client).toMatch(/timeout: options\.timeout/);
  expect(client).toMatch(/maxBuffer/);
  expect(client).not.toMatch(/from "node:child_process"/);
});

test("Bun.spawn's timeout kills the child with SIGTERM", async () => {
  const probe = Bun.spawn({
    cmd: ["bash", "-c", "sleep 1"],
    stdin: new Uint8Array(),
    stdout: "ignore",
    stderr: "ignore",
    timeout: 25,
  });
  expect(await probe.exited).toBe(143);
});
